# okaychat sandbox tools

Everything here is preinstalled. Runs have **no network**: no internet, no DNS, no package installs
(`pip install`, `apt`, `curl` to a URL all fail). Work with these tools and the files in the working directory.

## Limits

- Wall time: 60 s by default, up to 300 s (`timeout_seconds`). CPU time per process follows it.
- Memory: about 2 GB for the whole sandbox, shared by up to 4 concurrent runs of all users, and 2 GB of
  address space per process. 2 CPUs. 64 processes per run, 256 open files per process.
- Disk: the working directory (including `/tmp`) may hold 1 GB. Files over 50 MB cannot be saved or downloaded.
- `/tmp` and `/dev/shm` are private to each call and emptied when it ends. Background processes end with the call.
- Threads: `OMP_NUM_THREADS`, `OPENBLAS_NUM_THREADS`, `OMP_THREAD_LIMIT` are 2. Pass similar limits to tools that
  ignore them: `ffmpeg -threads 2`, `ocrmypdf --jobs 2`.

## Python 3.12

numpy, pandas, scipy, scikit-learn, sympy, matplotlib (Agg backend, use `plt.savefig`), pillow, pillow-heif
(`pillow_heif.register_heif_opener()` lets Pillow open HEIC/HEIF), openpyxl, xlsxwriter, python-docx (`import docx`),
python-pptx (`import pptx`), reportlab, pypdf, pikepdf, pdfplumber, pdfminer.six, ocrmypdf, csvkit (`csvlook`,
`csvstat`, `in2csv`, `csvsql`, ...), requests (no network), beautifulsoup4 (`import bs4`), lxml, PyYAML (`import yaml`),
tabulate.

## Command line

| Task | Tools |
| --- | --- |
| Audio and video | `ffmpeg`, `ffprobe` (FFmpeg 5.1, Debian build) |
| PDF | `pdftotext`, `pdfinfo`, `pdftoppm`, `pdfimages`, `pdfunite`, `pdfseparate` (poppler), `qpdf`, `gs` (Ghostscript) |
| Office | `soffice --headless --convert-to pdf file.docx` (LibreOffice 7.4 Writer, Calc, Impress; no macros), `pandoc` 2.17 |
| OCR | `tesseract` 5.3 with `eng`, `ita`, `osd`; `ocrmypdf --jobs 2 -l eng+ita in.pdf out.pdf` |
| Images and diagrams | `rsvg-convert` (SVG to PNG/PDF), `dot`/`neato` (Graphviz) |
| Archives | `zip`, `unzip`, `7z`/`7zz` (7-Zip), `bsdtar` (libarchive: tar, zip, 7z, cpio, ISO; also reads RAR 4 and RAR 5 archives, not encrypted ones; 7-Zip here has no RAR support), `xz`, `zstd`, `gzip`, `bzip2` |
| Metadata | `exiftool`, `file` |
| Data and text | `jq`, `sqlite3`, `rg` (ripgrep), `fd`, `tree`, `bc`, `git` |

LibreOffice: each `soffice` call gets its own temporary profile, so several can run at once. Linked content is never
refreshed and document macros never run.

## Fonts

DejaVu, Liberation (metric-compatible with Arial, Times New Roman, Courier New), Noto (Latin, Greek, Cyrillic, and
many other scripts) and Noto Color Emoji. Chinese, Japanese, and Korean are not covered. `fc-list : family` lists them.

## Inputs, outputs, previews

- Attachments and earlier outputs come in through `input_files` (their `file_id` / `fileId`).
- Every file a run creates or changes in the working directory is saved to the chat and gets a download link.
  Files in dot directories, `node_modules`, `__pycache__`, and virtualenvs are not.
- To see how a PDF, DOCX, XLSX, or PPTX output looks, import its `fileId` with `import_document`, then call
  `view_artifact`.
