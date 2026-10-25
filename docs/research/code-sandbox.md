# Code sandbox (`run_code`)

Built 2026-10-20, isolation and tools reworked 2026-10-25. Models run Python 3.12 and Bash in a separate
container, one workspace per chat. Runs have no network at all.

## Design

- One shared container (`sandbox/`), not one per user or chat. Per-user containers would cost idle memory, cold starts, lifecycle code, and Docker socket access for the app.
- The app container is never used to run code: it holds `OKAYCHAT_SECRET`, `/data`, and the network route to SearXNG.
- `sandbox/runner.py` is a stdlib HTTP service and the only root process. The app calls it with `OKAYCHAT_SANDBOX_TOKEN` (bearer). `src/server/tools/sandbox.ts` holds the tool, the download routes, conversion, and workspace deletion.
- Workspace id = first 32 hex chars of `sha256("sandbox:" + userId + ":" + threadId)`. The sandbox never sees user or thread ids.
- Every run is started as its workspace's uid inside **bubblewrap** (`bwrap`, Debian's 0.8), which gives it new user, network, IPC, UTS, and cgroup namespaces and its own mount namespace. bubblewrap is the sandbox Flatpak uses; the boundary is the kernel's namespaces, not a syscall blacklist.

## Run isolation

| Risk | Control |
| --- | --- |
| Network (internet, DNS, LAN, host, metadata, app, SearXNG, browser worker) | The run's network namespace has only its own loopback: no interface, no route, no DNS server. IPv4 and IPv6 alike fail with `ENETUNREACH` before a packet exists. The container also sits only on the `internal` compose network, which no longer matters for run code |
| The runner's own port, other runs' listeners | Loopback is per run, so `127.0.0.1:8080` and anything another run listens on are unreachable (`ECONNREFUSED`). Abstract Unix sockets are per network namespace, so they are private too |
| Other runs' files, Unix sockets, `/tmp`, `/dev/shm` | The mount namespace shows read-only `/usr`, `/etc`, `/opt/sandbox`, the font cache, this workspace (read-write), and a fresh `/tmp` and `/dev/shm` per run (directories in the workspace's private area, deleted when the run ends). Other workspaces are not mounted. Each workspace is also a `0700` directory owned by its own uid (20000–29999) |
| Processes | After each run the runner kills every process of the uid (found by real uid in `/proc/*/status`), so background, `setsid`, and `nohup` processes end with the call. `/proc` is the container's, bound read-only, because a fresh procfs needs a fully visible `/proc`, which Docker's masked paths rule out: a run can see other runs' pids and command lines, never their environment, memory, descriptors, or signals (different uid). For the same reason there is no pid namespace: its pids would not match this `/proc`, and it would hide nothing |
| Leaving the jail | `sandbox/seccomp/inner.c`, compiled with libseccomp at image build time into `inner.bpf` and installed by `bwrap --seccomp` just before exec: no new namespaces (`clone`/`unshare` with namespace flags, `clone3` → ENOSYS so glibc falls back to `clone`), no `setns`, mounts, `pivot_root`, io_uring (its `IORING_OP_SOCKET` makes sockets without `socket()`), bpf, perf, userfaultfd, keyrings; sockets only for `AF_UNIX`, `AF_INET`, `AF_INET6`, `AF_NETLINK` (`AF_VSOCK`, `AF_PACKET`, and the rest fail with `EAFNOSUPPORT`); syscalls from another ABI (i386 `int 0x80`, x32) kill the process. Descendants inherit the filter |
| Capabilities | Runs are unprivileged in the container and drop all capabilities in their user namespace (`--cap-drop ALL`): `CapEff`, `CapPrm`, `CapBnd`, `CapAmb` are all zero, `NoNewPrivs` is 1. Raw sockets fail with `EPERM` |
| Inherited descriptors | `close_fds`; bubblewrap reads and closes the seccomp and `/etc/passwd` descriptors it is handed, so a run starts with only 0, 1, 2 |
| Fork bombs, memory, CPU, disk | `prlimit` per run: processes 64 (counted per uid), address space 2 GB, CPU time timeout + 5 s, file size and workspace 1 GB, 256 open files, no core dumps. A watchdog stops runs that grow the workspace past 1 GB; the run's `/tmp` and `/dev/shm` count too. A workspace already over the limit still runs, so code can delete files, but may not grow. Container: 2 GB memory, 2 CPUs, 512 pids |
| Poisoned packages or files outside the workspace | Read-only root filesystem. `HOME` (`.okaychat/home`) is in the workspace's private directory |
| Token theft | The runner pops `SANDBOX_TOKEN` from its environment and gives children a fixed environment. Its `/proc/<pid>/environ` is unreadable to workspace uids |
| Symlink tricks against the root runner | Downloads resolve the real path and require it inside the workspace. Writes use `O_NOFOLLOW` and refuse symlinked parents. The runner recreates `.okaychat/` and `.okaychat/run` if code replaced them. All happen under the workspace lock, when no process of that uid is alive |
| Untrusted output files on the app origin | Downloads are served with `Content-Disposition: attachment`, `CSP: default-src 'none'; sandbox`, and `nosniff`. `<img>` previews still work, and a direct SVG cannot run script |

### What one run sees of another

Runs of the same chat never overlap (serialized). Runs of other chats may run at the same time; tested:

| Of a concurrent run | Visible? |
| --- | --- |
| Its pid, and the command lines of its processes | Yes, through the shared `/proc`. The runner's own command lines carry no workspace id or code: bubblewrap reads its options from a descriptor (`bwrap --args N -- bash .okaychat/main.sh`), scripts are started by relative path, and `/convert` uses a fixed file name. Arguments that run code passes to its own subprocesses (`sleep 17.5`, `ffmpeg -i input.mp4 …`) are visible |
| Its environment, open descriptors, memory | No (other uid; `/proc/<pid>/environ`, `fd/`, `mem` refused) |
| Signals to it | No (other uid) |
| Its files, `/tmp`, `/dev/shm` | No (not mounted in this run's view) |
| Its loopback listeners, abstract or filesystem Unix sockets | No (own network namespace, own mounts) |

A fresh `/proc` that would hide other processes needs a fully visible `/proc` in the container, which only
`systempaths=unconfined` gives; that would also unmask `/proc/sysrq-trigger` and similar files for the root runner, so
it is not used. Do not put secrets in command-line arguments inside runs; there are none to begin with (no network,
no credentials).

### Fail closed

At start the runner launches one jailed probe (uid 19999) and checks from inside: only `lo`, `ENETUNREACH` to an
outside address, `ECONNREFUSED` to its own port, `EPERM` for a new user namespace, `EAFNOSUPPORT` for
`AF_PACKET`/`AF_VSOCK`, zero capabilities, `NoNewPrivs` 1, seccomp mode 2, descriptors 0–3 only. If anything
differs or bubblewrap cannot build the namespaces, every run and conversion is refused with 503 and the reason,
`/health` answers 503 (the container shows unhealthy), and Settings → General shows the reason. There is no
fallback that runs code without the jail; bubblewrap itself also exits before the command when a namespace
cannot be created, and the runner reports that as an isolation failure.

### What the container needs

| Setting | Why |
| --- | --- |
| `security_opt: seccomp=./sandbox/seccomp.json` | Docker's default profile (moby, Apache-2.0) plus `clone`, `unshare`, `mount`, `umount2`, `pivot_root` without `CAP_SYS_ADMIN`, so bubblewrap can build user namespaces. Model code never gets these: `inner.bpf` denies them again |
| `security_opt: apparmor=unconfined` | Docker's `docker-default` AppArmor profile denies all mounts, including the ones inside a run's own user namespace |
| `cap_add: CHOWN, DAC_OVERRIDE, FOWNER, SETUID, SETGID, KILL` | Unchanged: workspace creation and switching to the workspace uid. No `SYS_ADMIN`, `NET_ADMIN`, or privileged mode |
| `no-new-privileges`, `read_only`, `cap_drop: ALL`, `pids_limit`, `mem_limit`, `cpus` | Unchanged |

### Host AppArmor profiles and the exec view

With `apparmor=unconfined`, host AppArmor profiles that attach by executable path apply to processes in the
container, including run code. Ubuntu 26.04 confines `/usr/bin/gs` and `/usr/bin/qpdf` to the home directory, which
broke both on workspace files (found by the integration suite: `qpdf: open …: Permission denied`). On this host the
profiles naming paths that exist in the image are bwrap, dash, getent, gs, locale, lsblk, qpdf, and sysctl; only gs
and qpdf restrict files.

A profile attaches to the path of the file being executed (after symlinks are resolved). So the jail, not the
image, changes that path: bubblewrap mounts the real `/usr/bin` and `/usr/sbin` a second time at
`/usr/lib/okaychat-exec/{bin,sbin}` and covers `/usr/bin` and `/usr/sbin` with directories built at image time
(`sandbox/exec-view.py`, `/opt/sandbox/exec-view`): each regular file there is a symlink into the second mount, each
symlink is copied unchanged. Run code that executes `/usr/bin/gs` runs `/usr/lib/okaychat-exec/bin/gs`, which no
profile names; it inherits the run's own label (`bwrap//&unpriv_bwrap` on Ubuntu). Effects:

- The image itself is untouched: `dpkg -V` reports nothing new, the runner and `docker exec` see the normal layout,
  and a later `apt-get install` in a derived image works as usual.
- Inside a run, `/proc/self/exe` and `readlink -f /usr/bin/x` show the `/usr/lib/okaychat-exec` path. Programs that
  find their data from their own location relative to `bin/` would look in `/usr/lib/okaychat-exec/share`; the
  installed tools use compiled-in paths (verified by the full tool suite, including git, perl/ExifTool, Ghostscript,
  Tesseract, LibreOffice, Graphviz plugins, Pandoc, FFmpeg). PATH lookup, `/bin -> usr/bin`, relative symlinks such as
  `soffice -> ../lib/libreoffice/program/soffice`, and subprocesses behave as before.
- The view is a snapshot of `/usr/bin` and `/usr/sbin` when `exec-view.py` ran. It must stay the last step that adds
  executables there; at start the runner compares the two and refuses all runs if they differ.
- Only `/usr/bin` and `/usr/sbin` are covered. A host profile for a path elsewhere (for example under
  `/usr/lib/libreoffice`) would still attach; none exists on the tested host.

Narrower options and why they are not used: relocating only the binaries this host has profiles for depends on each
host's profile set, which grows between releases (Ubuntu 26.04 added gs and qpdf), so it would break silently
elsewhere. Moving the files in the image (the first version of this fix) worked but changed 593 package files, which
`dpkg -V` then reported. Loading an okaychat AppArmor profile, or keeping `docker-default`, would need host changes or
forbids the mounts bubblewrap needs.

`/usr/bin/bwrap` itself is not redirected, and the runner runs it outside the jail. On hosts that restrict
unprivileged user namespaces (`kernel.apparmor_restrict_unprivileged_userns=1`, Ubuntu 23.10+), bwrap works only
because the distribution's `bwrap-userns-restrict` profile attaches to `/usr/bin/bwrap`; verified that a copy at
another path fails. That profile ships with Ubuntu's apparmor package. Without it the probe fails and the runner
refuses runs. Hosts without that restriction need no profile.

Trade-off: the container loses Docker's AppArmor profile, and the runner (trusted code) may create user
namespaces. In return, run code gets real per-run network, mount, and IPC isolation. On Ubuntu 23.10+ hosts
(`kernel.apparmor_restrict_unprivileged_userns=1`) unconfined processes get user namespaces without capabilities,
except through the distribution's `bwrap-userns-restrict` profile for `/usr/bin/bwrap`, which also confines run code
(`unpriv_bwrap`, all capabilities denied). Verified: a copy of bwrap at another path fails there. Hosts that
disable unprivileged user namespaces entirely (`kernel.unprivileged_userns_clone=0`, `user.max_user_namespaces=0`)
cannot run code; the runner says so instead of running unjailed.

### Platforms

Verified on Linux amd64: Docker 29.9, Ubuntu 26.04, kernel 7.0, cgroup v2, AppArmor with the userns restriction.
Not verified: arm64 (no architecture-specific downloads; `inner.bpf` is generated for the build architecture;
libseccomp handles arm64), rootless Docker (needs nested user namespaces), Docker Desktop (LinuxKit kernel, no
AppArmor; should work), Podman (not supported by the compose file as written).

Not covered: kernel exploits and container escapes (user namespaces add kernel attack surface to the runner, not to
run code, which cannot create them), and side channels between concurrent runs such as CPU timing.

## Verification

`test/integration/run.sh` runs the real images in an isolated compose project (own tags, port, subnets, volumes)
and passed on 2026-10-25 (Linux amd64 host above). `test/integration/sandbox_it.py` covers, against the runner API:

- contract (stdout/stderr, exit codes, truncation, listing, upload/download, hidden directories, symlink refusal);
- identity: uid in range, all capability sets zero, `NoNewPrivs` 1, seccomp mode 2 with two filters, the rlimits
  above, descriptors 0–3, no token in the environment; read-only `/usr`, `/etc`, `/opt`, `/`, `/var`;
- network from a direct child, a background grandchild, and a `setsid` process: TCP to a fixture on all three
  compose networks, the runner's port by loopback and by IP, the app, SearXNG, the browser worker, the host
  gateways, 169.254.169.254, UDP, HTTP, DNS by name and a raw query to Docker's DNS, IPv6 public and loopback,
  raw/packet/vsock sockets, new user/network namespaces. The fixture counted zero connections and datagrams,
  while the tester and `docker exec` in the sandbox's own namespace reached it (positive controls);
- concurrent runs of two chats: loopback listener, abstract and filesystem Unix sockets, `/tmp`, `/dev/shm`, the
  other workspace, other uids' `/proc/<pid>/environ` and descriptors, signals;
- cleanup of `/tmp`, `/dev/shm`, background/`setsid`/`nohup`/signal-ignoring processes, kept partial outputs;
  timeouts (2 s, 1 s, the 60 s default, a 65 s run under `timeout_seconds: 70`); queued, pre-sent, and running
  cancellation; the workspace watchdog including `/tmp`; deleting files from an over-limit workspace; fork bomb;
  a 3 GB allocation; file-size limit;
- every CLI and Python import listed above; FFmpeg H.264/AAC → VP9/Opus with `-threads 2` and ffprobe; HEIC
  (generated with pillow-heif) decode, SVG rasterization, Graphviz PNG/SVG, font matching, Matplotlib PNG;
  DOCX/XLSX/PPTX creation and three parallel LibreOffice PDF exports with page counts and text; Pandoc; Tesseract
  eng and ita, OCRmyPDF, pdfplumber, pypdf, qpdf, Ghostscript, pdftoppm; zip, 7z, tar.xz, tar.zst, RAR 4/5 via
  bsdtar; ExifTool read/write; LibreOffice with an autorun-macro document and a macro-enabling profile; process
  visibility between concurrent runs; host AppArmor labels of jailed gs/qpdf and a control without the exec view;
  LibreOffice external references against a recording receiver (table above);
- four heavy runs at once under the 2 GB container limit (OCRmyPDF on four A4 pages at 300 dpi, a 38-page DOCX to
  PDF, a 15 s 720p H.264 encode, a 6000×6000 matrix product): all succeeded, 34 s wall, container peak 1.4 GB.

`run.sh` also checks fail closed (Docker's default seccomp profile: `/health` 503, run 503, no file written) and
runs `src/server/sandbox-flow.itest.ts` against the dev-topology containers: outputs stored and charged once,
`import_document` of DOCX, XLSX, PDF, and PPTX (converted) outputs with `view_artifact` screenshots, a retry that
does not store a second copy, ownership and quota refusals that store nothing, a 60 MB output reported as too
large while the small one is kept, turn pruning, and Stop cancelling a run.

## Retention

The sandbox is scratch space, never the source of truth:

- Every workspace is wiped ~30 minutes after its last run (`SANDBOX_IDLE_MINUTES`, default 30; a completed run touches the workspace's mtime; expiry is rechecked under its lock). The sweep runs in a background thread and kills the workspace's uid processes. The container also wipes every workspace when the runner starts.
- A run's `/tmp`, `/dev/shm`, and LibreOffice profiles are deleted when the run ends (success, error, timeout, or cancel). Files it wrote to the workspace stay, including partial output of a run that timed out.
- Right after each run, the app downloads the files the run produced and stores them in SQLite (`sandbox_files` table), counted against the user's storage quota. Download URLs in the tool result point at `/api/sandbox/:threadId/stored`, which serves the stored copy with the same untrusted-content headers.
- Files over the 50 MiB transfer limit cannot be stored or downloaded. They get no link: the result lists them under `tooLarge` with their size, and `storageWarning` tells the model to make them smaller. The other outputs of the run are stored as usual. A file that could not be stored for another reason keeps the scratch link `/api/sandbox/:threadId/files?path=`, which works while the workspace lives.
- Stored outputs are drafts until the turn's answer ends. Then `SandboxTurn.prune()` deletes the files first stored in that turn that the last file-writing run did not produce. Files from earlier turns are never pruned, and a stopped turn keeps everything. The tool description tells the model to make its final run write every file the user should get.
- Rewriting a file in a later run replaces its stored copy instead of piling up versions, charging only net byte growth. The Library lists, previews, downloads and deletes these copies. Deleting the chat deletes the stored copies (foreign-key cascade).
- `import_document` copies a stored output into an artifact (a separate copy, charged once; a retry in the same request returns the first copy). The artifact does not depend on the sandbox file afterwards.

## Behavior

- Each call is a new process: variables do not persist, files do — until the workspace is wiped (see Retention). Background processes end with the call.
- Output keeps the first 48 KB and last 16 KB of each stream. Timeout default 60 s, max 300 s (`SANDBOX_MAX_TIMEOUT`).
- Up to 4 runs at once (`SANDBOX_CONCURRENCY`). Runs in one workspace are serialized: a run waits up to the maximum timeout + 30 s for the previous one, then up to 30 s for a slot.
- Every run carries a job id from the app. Stop in the chat, and the app giving up on the answer, call `/cancel` with that id: a running job is killed; a queued job leaves the queue; a job whose cancel arrives first never starts ("cancelled before it started"). Markers expire after 15 minutes. A cancel without a job id cancels every job of the workspace.
- Attachments: every non-temporary attachment is stored regardless of sandbox configuration (`/files/store`) and its header carries `file_id`; `input_files` copies it into the workspace. Saved outputs also return a `fileId` accepted by `input_files`, so a later run can restore their durable bytes after scratch expiry (using a safe basename). Images retain their original data URL message parts as well.
- Only results count as outputs. `HOME` is `.okaychat/home`, so caches stay out of the listing. Files inside dot directories, `node_modules`, `__pycache__`, `site-packages`, `dist-packages`, `venv`, or any directory holding a `pyvenv.cfg` are never listed, stored, or shown. `sandbox-paths.ts` applies the same rule on the server (older runner images). Dotfiles themselves are kept. The run card collapses after 12 files.
- Thread limits for numeric libraries and Tesseract are 2 (`OMP_NUM_THREADS`, `OMP_THREAD_LIMIT`, `OPENBLAS_NUM_THREADS`, `MKL_NUM_THREADS`, `NUMEXPR_MAX_THREADS`), and `MALLOC_ARENA_MAX=2` keeps glibc arenas inside the address-space limit. FFmpeg and OCRmyPDF ignore those; the tool description asks for `-threads 2` and `--jobs 2`.
- Not offered to temporary chats or sub-agents. Settings → General toggles it per user; it shows only when the server has `OKAYCHAT_SANDBOX_URL` and a 32+ character token.

## Visual checks of outputs

`import_document` accepts a `fileId` of the caller's own stored output (the same ownership rule as `input_files`:
`sandbox_files.user_id`), next to attachments. PDF, DOCX, and XLSX keep their kind. PPTX, PPT, PPS, PPSX, and ODP
go to the runner's `/convert` endpoint, which runs LibreOffice Impress in the chat's workspace jail with the input
on stdin and the PDF in the run's private `/tmp` (never listed as an output), and are imported as `pdf`.
`view_artifact` then renders pages in the browser worker as for any artifact. Conversion needs the sandbox but not
the per-user code-execution switch, since no model code runs.

## Runner API

All routes except `/health` need `Authorization: Bearer <token>`. `ws` is `[a-f0-9]{16,64}`, `job` is `[A-Za-z0-9_-]{8,64}`.

| Route | Purpose |
| --- | --- |
| `GET /health` | 200 `{ ok, isolation: "bubblewrap" }`, or 503 `{ ok: false, error }` when run isolation is unavailable |
| `POST /workspaces/:ws/run` | `{ language, code, timeout, job? }` → `{ exitCode, stdout, stderr, stopped, durationMs, files, deleted }` |
| `POST /workspaces/:ws/cancel` | `{ job? }`: cancel that job, or all of the workspace's jobs |
| `POST /workspaces/:ws/convert?name=&job=` | Body: a presentation (50 MB max) → `application/pdf` |
| `GET /workspaces/:ws/files` | List files (hidden: `.okaychat`, `.cache`) |
| `GET /workspaces/:ws/files?path=` | Download, 50 MB max |
| `PUT /workspaces/:ws/files?path=` | Upload, 50 MB max |
| `DELETE /workspaces/:ws` | Delete the workspace |

Runner env: `SANDBOX_MAX_TIMEOUT` (300), `SANDBOX_MEMORY_MB` (2048, per-process address space), `SANDBOX_WORKSPACE_MB` (1024), `SANDBOX_MAX_PROCS` (64), `SANDBOX_CONCURRENCY` (4), `SANDBOX_IDLE_MINUTES` (30), `SANDBOX_CONVERT_TIMEOUT` (120).

Limits are per process (address space, CPU time, file size, descriptors) or per workspace (processes, size). The
only aggregate memory and CPU bound is the container's (2 GB, 2 CPUs), shared by all concurrent runs; a run can
make other users' runs fail with "killed (likely out of memory)". cgroup delegation per run would need a writable
cgroup tree, which the container does not get.

## Image

`python:3.12-slim-bookworm` (digest-pinned) with Debian packages only, no third-party downloads, and wheels only for
Python (`pip install --require-hashes --only-binary=:all:`). `/opt/sandbox/TOOLS.md` is the model-facing inventory.

| Area | Installed |
| --- | --- |
| Isolation | bubblewrap 0.8.0, `inner.bpf` (built in a separate stage with gcc + libseccomp-dev, which do not reach the runtime image) |
| Shell and data | util-linux, procps, curl, jq 1.6, sqlite3 3.40, git 2.39, zip/unzip, file, ripgrep 13, tree, bc, fd-find (`fd` shim) |
| Media | FFmpeg 5.1 (Debian build, includes libx264, libvpx, libopus) and ffprobe |
| PDF | poppler-utils 22.12 (pdftotext, pdfinfo, pdftoppm, …), qpdf 11.3, Ghostscript 10.0 |
| Office | LibreOffice 7.4 Writer, Calc, Impress (`-nogui` builds, no Java), Pandoc 2.17 |
| OCR | Tesseract 5.3 with eng, ita, osd; OCRmyPDF 17.13 (Python) |
| Images, diagrams | librsvg 2.54 (`rsvg-convert`), Graphviz 2.43 |
| Archives | xz 5.4, zstd 1.5.4, 7-Zip 26.02 (`7zip` from bookworm-security; `7z` shim for `7zz`), libarchive 3.6.2 (`bsdtar`; reads libarchive's RAR 4 and stored RAR 5 samples, verified; Debian's 7-Zip has no RAR codec) |
| Metadata | ExifTool 12.57 |
| Fonts | DejaVu, Liberation 1 and 2, Noto core (no CJK), Noto Color Emoji; cache built at image build time |
| Python 3.12 | numpy, pandas, scipy, scikit-learn, sympy, matplotlib, pillow, pillow-heif, openpyxl, xlsxwriter, python-docx, python-pptx, reportlab, pypdf, pikepdf, pdfplumber, pdfminer.six, ocrmypdf, csvkit, requests, beautifulsoup4, lxml, PyYAML, tabulate (82 packages locked) |

LibreOffice macros: `services.rdb` registers `BasicProvider` and `ScriptProviderForJava`, and the VBA helper libraries
(`libvbaobjlo`, `libvbaswobjlo`) are installed, but no implementation that could run a macro is: no StarBasic runtime
(`libsblo`, `libbasprovlo`), no Python-UNO or `pythonscript`, no JRE, no JavaScript or BeanShell provider (VBA runs on
the absent StarBasic runtime). An autorun-macro document and a profile that tries to enable macros produced no
execution. This is evidence about the installed components, not a positive control: with no engine there is no way to
show a macro running in this image. `okaychat.xcd` in `share/registry` also sets and finalizes `MacroSecurityLevel` 3,
`DisableMacrosExecution`, `BlockUntrustedRefererLinks`, and link updates on load to "never" (Calc `Link` 1, Writer
`Link` 2; values from the 7.4 `officecfg` schema).

External references (`test/integration/libreoffice_links.sh`, fixtures in `test/integration/fixtures/`): a Writer
document with an http-linked section and an http-linked image, and a Calc document with an external cell reference
and `WEBSERVICE()`, converted in a container that can reach a recording receiver:

| Variant | Fetched |
| --- | --- |
| control: image defaults removed, links and recalculation "always", `BlockUntrustedRefererLinks` off | the linked image only |
| image defaults | nothing |
| image defaults plus a profile asking for "always" and referer links on | nothing (the finalized defaults win) |
| control settings, inside a bubblewrap network namespace like a run | nothing (no network) |

So for linked images the setting is what stops the fetch, and the run's network namespace stops it independently.
The linked section, the external cell reference, and `WEBSERVICE()` were not fetched even in the control, so for
them the test cannot show which layer would stop a fetch; runs have no network either way.

`/usr/local/bin/soffice`
(and `libreoffice`) gives every call its own throwaway profile in the run's `/tmp`; `bootstraprc` points the default
profile there too, for calls to `/usr/bin/soffice`.

Not installed, on purpose: a runtime package installer or wheelhouse (runs are offline), yq, Go/Rust/Java/PHP/Ruby/TeX
toolchains, Node.js, a compiler, and a second browser (visual checks use the browser worker).

Size (2026-10-25, amd64): 2.69 GB unpacked, 668 MB as a gzip'd `docker save`; the previous image was 831 MB / 188 MB.
Cold build 7–8 minutes on a 4-core host; LibreOffice, FFmpeg, and the Python wheels are most of it.

Python lock (generated with `--exclude-newer 2026-10-25`): edit `sandbox/requirements.in`, then regenerate the universal, hashed lock:

```sh
docker run --rm -v "$PWD/sandbox":/s -w /tmp python:3.12-slim-bookworm sh -c 'pip install -q uv==0.13.1 &&
  cp /s/requirements.in . && uv pip compile requirements.in --universal --python-version 3.12 --generate-hashes \
  --exclude-newer <yyyy-mm-dd> --no-header -o /s/requirements.txt'
```

and put the header line back on top of `requirements.txt`.
