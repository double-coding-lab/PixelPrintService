"""Create a bounded still WebP thumbnail over stdin/stdout; never modify the source."""

import io
import sys
import warnings

from PIL import Image, ImageOps

MAX_INPUT_BYTES = 30_000_000
MAX_OUTPUT_BYTES = 5_000_000
# Match the attachment pixel budget, while allowing very narrow, tall source images.
Image.MAX_IMAGE_PIXELS = 40_000_000
warnings.simplefilter("error", Image.DecompressionBombWarning)


def thumbnail(content):
    """Fit the first frame proportionally, preserving transparency and EXIF orientation."""
    with Image.open(io.BytesIO(content)) as source:
        if source.width * source.height > Image.MAX_IMAGE_PIXELS:
            raise ValueError("IMAGE_PIXEL_LIMIT")
        source.seek(0)
        image = ImageOps.exif_transpose(source)
        image.thumbnail((320, 16383), Image.Resampling.LANCZOS)
        transparent = image.mode in ("RGBA", "LA") or "transparency" in image.info
        image = image.convert("RGBA" if transparent else "RGB")
        output = io.BytesIO()
        image.save(output, format="WEBP", quality=80, method=4)
        result = output.getvalue()
        if not result or len(result) > MAX_OUTPUT_BYTES:
            raise ValueError("THUMBNAIL_OUTPUT_LIMIT")
        return result


if __name__ == "__main__":
    content = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
    if not content or len(content) > MAX_INPUT_BYTES:
        sys.stderr.write("THUMBNAIL_INPUT_LIMIT")
        sys.exit(2)
    try:
        result = thumbnail(content)
    except (Image.DecompressionBombWarning, Image.DecompressionBombError):
        sys.stderr.write("IMAGE_PIXEL_LIMIT")
        sys.exit(2)
    except ValueError as error:
        reason = str(error)
        sys.stderr.write(reason if reason in ("IMAGE_PIXEL_LIMIT", "THUMBNAIL_OUTPUT_LIMIT")
                         else "INVALID_IMAGE")
        sys.exit(2)
    except Exception:
        sys.stderr.write("INVALID_IMAGE")
        sys.exit(2)
    sys.stdout.buffer.write(result)
