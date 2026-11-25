import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createWebpThumbnail } from '../src/functions/d2c/utils/webpThumbnail';

const python = path.resolve('image-compression/.venv/bin/python3');
let ready = false;
if (existsSync(python)) {
  try {
    ready =
      execFileSync(python, ['-I', '-c', 'from PIL import features; print(features.check("webp"))'])
        .toString()
        .trim() === 'True';
  } catch {
    // No installs: real-codec tests explicitly skip when the prepared runtime is missing.
  }
}
const codec = { skip: !ready && 'Prepared Pillow/WebP runtime is unavailable' };

/** Generate actual raster bytes without third-party Node dependencies. */
function picture(width: number, height: number, format = 'PNG', animated = false) {
  return execFileSync(
    python,
    [
      '-I',
      '-c',
      `
import sys
from PIL import Image, ImageDraw
image = Image.new('RGBA', (${width}, ${height}), (190, 30, 60, 160))
draw = ImageDraw.Draw(image)
draw.rectangle((0, 0, ${width - 1}, ${Math.floor(height / 3)}), fill=(20, 80, 220, 255))
if '${format}' in ('JPEG', 'BMP'):
    image = image.convert('RGB')
options = dict(format='${format}')
if '${format}' == 'PNG':
    options['compress_level'] = 0 if ${width} * ${height} <= 4_000_000 else 6
if ${animated ? 'True' : 'False'}:
    options.update(save_all=True, append_images=[Image.new('RGB', image.size, 'green')], duration=100, loop=0)
image.save(sys.stdout.buffer, **options)
`,
    ],
    { maxBuffer: 30_000_000 },
  );
}

/** Decode using the real codec, including pixels, to verify the output independently. */
function inspect(content: Buffer) {
  return JSON.parse(
    execFileSync(
      python,
      [
        '-I',
        '-c',
        `
import hashlib, io, json, sys
from PIL import Image
with Image.open(io.BytesIO(sys.stdin.buffer.read())) as image:
    image.load()
    print(json.dumps(dict(format=image.format, width=image.width, height=image.height,
                         frames=getattr(image, 'n_frames', 1),
                         pixel=list(image.convert('RGBA').getpixel((0, 0))),
                         pixels=hashlib.sha256(image.tobytes()).hexdigest())))
`,
      ],
      { input: content, maxBuffer: 1024 * 1024 },
    ).toString(),
  ) as {
    format: string;
    width: number;
    height: number;
    frames: number;
    pixel: number[];
    pixels: string;
  };
}

test(
  'long raster keeps its full proportions, shrinks bytes, and leaves source pixels untouched',
  codec,
  async () => {
    const original = picture(640, 4000);
    const bytesBefore = createHash('sha256').update(original).digest('hex');
    const pixelsBefore = inspect(original);
    const output = await createWebpThumbnail(original);
    const result = inspect(output);
    assert.equal(result.format, 'WEBP');
    assert.equal(result.width, 320);
    assert.equal(result.height, 2000);
    assert.equal(result.frames, 1);
    assert.ok(output.length < original.length / 10);
    assert.ok(output.length <= 5_000_000);
    assert.notStrictEqual(output, original);
    assert.equal(createHash('sha256').update(original).digest('hex'), bytesBefore);
    assert.deepEqual(inspect(original), pixelsBefore);
  },
);

test(
  'tiny PNG/JPEG/WebP/BMP images are never enlarged; PNG transparency survives',
  codec,
  async () => {
    for (const format of ['PNG', 'JPEG', 'WEBP', 'BMP']) {
      const output = await createWebpThumbnail(picture(17, 11, format));
      const result = inspect(output);
      assert.equal(result.format, 'WEBP');
      assert.equal(result.width, 17);
      assert.equal(result.height, 11);
      if (format === 'PNG') {
        // The bottom of the fixture is translucent, unlike its opaque first pixel.
        const alpha = execFileSync(
          python,
          [
            '-I',
            '-c',
            'import io, sys; from PIL import Image; im=Image.open(io.BytesIO(sys.stdin.buffer.read())); print(im.getpixel((0, 10))[3])',
          ],
          { input: output },
        )
          .toString()
          .trim();
        assert.equal(alpha, '160');
      }
    }
  },
);

test('animated GIF/WebP produce only the first frame', codec, async () => {
  for (const format of ['GIF', 'WEBP']) {
    const source = picture(21, 13, format, true);
    assert.equal(inspect(source).frames, 2);
    const result = inspect(await createWebpThumbnail(source));
    assert.equal(result.frames, 1);
    assert.equal(result.width, 21);
    assert.equal(result.height, 13);
    assert.ok(result.pixel[2] > result.pixel[1], 'first frame is blue, not the green second frame');
  }
});

test('extreme aspect ratio fits the WebP height limit without cropping', codec, async () => {
  const output = await createWebpThumbnail(picture(100, 100_000));
  const result = inspect(output);
  assert.equal(result.height, 16383);
  assert.ok(result.width <= 320);
  assert.ok(Math.abs(result.width - result.height / 1000) < 1);
  assert.ok(output.length <= 5_000_000);
});

test('empty and over-30MB input reject before starting a converter', async () => {
  await assert.rejects(createWebpThumbnail(Buffer.alloc(0)), /THUMBNAIL_INPUT_LIMIT/);
  await assert.rejects(createWebpThumbnail(Buffer.alloc(30_000_001)), /THUMBNAIL_INPUT_LIMIT/);
});

test(
  'unknown or corrupt raster formats reject instead of returning original bytes',
  codec,
  async () => {
    for (const content of [
      Buffer.from('not an image'),
      Buffer.from('<svg/>'),
      Buffer.from('GIF89a'),
    ]) {
      await assert.rejects(createWebpThumbnail(content), /INVALID_IMAGE/);
    }
  },
);

test(
  'more than 40 million declared pixels are rejected before raster allocation',
  codec,
  async () => {
    const oversized = execFileSync(python, [
      '-I',
      '-c',
      String.raw`
import struct, sys, zlib
def chunk(kind, data):
    return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))
sys.stdout.buffer.write(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 4001, 10000, 8, 2, 0, 0, 0)) + chunk(b'IDAT', b'') + chunk(b'IEND', b''))
`,
    ]);
    await assert.rejects(createWebpThumbnail(oversized), /IMAGE_PIXEL_LIMIT/);
  },
);

test('pre-aborted signal propagates its original reason without starting a process', async () => {
  const reason = new Error('cancel thumbnail');
  await assert.rejects(
    createWebpThumbnail(Buffer.from('input'), AbortSignal.abort(reason)),
    (error) => error === reason,
  );
});

test('running conversion yields the event loop and propagates cancellation', codec, async () => {
  const source = picture(640, 4000);
  const controller = new AbortController();
  const reason = new Error('cancel running thumbnail');
  const pending = createWebpThumbnail(source, controller.signal);
  const timer = setTimeout(() => controller.abort(reason), 1);
  try {
    await assert.rejects(pending, (error) => error === reason);
  } finally {
    clearTimeout(timer);
  }
});
