#!/usr/bin/env python3
"""Image build step: the executable view used inside every run's jail. See docs/implementation/code-sandbox.md.

The sandbox container runs without Docker's AppArmor profile (bubblewrap needs mounts), so host AppArmor profiles
that attach by executable path apply inside it: Ubuntu 26.04 confines /usr/bin/gs and /usr/bin/qpdf to the home
directory, which denies them the workspace. A profile attaches to the path of the file being executed, so inside
the jail the runner mounts the real /usr/bin and /usr/sbin a second time at /usr/lib/okaychat-exec/{bin,sbin} and
covers /usr/bin and /usr/sbin with the directories built here: every regular file becomes a symlink into that alias,
every symlink is copied as it is. A run that executes /usr/bin/gs therefore executes
/usr/lib/okaychat-exec/bin/gs, which no host profile names. The image's own /usr/bin is not changed, so dpkg
metadata stays intact and the runner itself sees the normal layout."""
import os

VIEW = "/opt/sandbox/exec-view"
ALIAS = "/usr/lib/okaychat-exec"
counts = {}
for name in ("bin", "sbin"):
    source, view, alias = f"/usr/{name}", f"{VIEW}/{name}", f"{ALIAS}/{name}"
    os.makedirs(view)
    os.makedirs(alias)  # Mount point for the second view of the real directory.
    counts[name] = 0
    for entry in sorted(os.listdir(source)):
        path = os.path.join(source, entry)
        if os.path.islink(path):
            os.symlink(os.readlink(path), os.path.join(view, entry))
        elif os.path.isfile(path):
            os.symlink(os.path.join(alias, entry), os.path.join(view, entry))
            counts[name] += 1
print(f"exec view: {counts['bin']} files in /usr/bin, {counts['sbin']} in /usr/sbin redirected")
