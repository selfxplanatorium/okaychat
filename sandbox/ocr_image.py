"""Fixed OCR helper for the runner's /ocr route: one image in, UTF-8 text out. Runs inside the run jail.

Usage: ocr_image.py <input> <output>. The first frame is flattened onto white and handed to Tesseract as a PNG
at a fixed private path, so no client-chosen name reaches a command line.
"""

import os
import re
import subprocess
import sys

from PIL import Image

try:
    import pillow_heif

    pillow_heif.register_heif_opener()
except ImportError:  # HEIC stays unreadable; every other format still works.
    pass

MAX_PIXELS = 40_000_000
Image.MAX_IMAGE_PIXELS = MAX_PIXELS
PNG = "/tmp/ocr-input.png"


def fail(message: str) -> None:
    sys.stderr.write(message[:500] + "\n")
    sys.exit(1)


def main() -> None:
    if len(sys.argv) != 3:
        fail("usage: ocr_image.py <input> <output>")
    source, target = sys.argv[1], sys.argv[2]
    langs = os.environ.get("OCR_LANGS", "eng")
    if not re.fullmatch(r"[a-z]{3}(\+[a-z]{3}){0,3}", langs):
        langs = "eng"
    timeout = int(os.environ.get("OCR_TIMEOUT", "110"))
    try:
        with Image.open(source) as img:
            if img.width * img.height > MAX_PIXELS:
                fail("the image is larger than 40 megapixels")
            img.seek(0)
            frame = img.convert("RGBA")
            flat = Image.new("RGB", frame.size, (255, 255, 255))
            flat.paste(frame, mask=frame.getchannel("A"))
            flat.save(PNG, "PNG")
    except Image.DecompressionBombError:
        fail("the image is larger than 40 megapixels")
    except (OSError, ValueError, SyntaxError) as error:
        fail(f"the image could not be decoded: {type(error).__name__}")
    try:
        done = subprocess.run(["tesseract", PNG, "stdout", "-l", langs, "--psm", "3"], capture_output=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        fail("tesseract timed out")
    if done.returncode != 0:
        fail(done.stderr.decode("utf-8", "replace").strip()[-500:] or "tesseract failed")
    with open(target, "wb") as f:
        f.write(done.stdout.decode("utf-8", "replace").encode("utf-8"))


if __name__ == "__main__":
    main()
