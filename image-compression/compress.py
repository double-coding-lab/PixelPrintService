"""单图无损优化：输入输出均为字节，不访问业务文件或网络。"""

import io
import sys
import warnings
from PIL import Image

Image.MAX_IMAGE_PIXELS = 20_000_000
warnings.simplefilter("error", Image.DecompressionBombWarning)


def compress(content):
    """沿用 pp-image-compress 参数，只采用更小且解码像素一致的结果。"""
    with Image.open(io.BytesIO(content)) as image:
        if image.format not in ("PNG", "JPEG") or getattr(image, "n_frames", 1) != 1:
            return content
        image.load()
        options = {"format": image.format, "optimize": True}
        if image.format == "PNG":
            options["compress_level"] = 9
            if "transparency" in image.info:
                options["transparency"] = image.info["transparency"]
        else:
            options.update(quality="keep", progressive=True)
        for name in ("icc_profile", "exif", "dpi"):
            if name in image.info:
                options[name] = image.info[name]
        output = io.BytesIO()
        image.save(output, **options)
        candidate = output.getvalue()
        if len(candidate) >= len(content):
            return content
        with Image.open(io.BytesIO(candidate)) as result:
            result.load()
            if result.size != image.size or result.mode != image.mode:
                return content
            if result.tobytes() != image.tobytes():
                return content
            if result.convert("RGBA").tobytes() != image.convert("RGBA").tobytes():
                return content
            for name in ("icc_profile", "exif"):
                if result.info.get(name) != image.info.get(name):
                    return content
        return candidate


if __name__ == "__main__":
    original = sys.stdin.buffer.read(30_000_001)
    if len(original) > 30_000_000:
        sys.exit(2)
    try:
        sys.stdout.buffer.write(compress(original))
    except Exception:
        sys.stdout.buffer.write(original)
