import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { parseMessageWithImages } from './image-utils.js';

let tempDir: string;

beforeEach(async () => {
  // Use a simple directory name without UUID (regex only supports [\w.\-...] chars)
  tempDir = join(tmpdir(), 'fedi-img-test');
  await fs.mkdir(tempDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('parseMessageWithImages', () => {
  it('returns null for text-only messages', async () => {
    const result = await parseMessageWithImages('hello world');
    assert.strictEqual(result, null);
  });

  it('returns null when no image paths found', async () => {
    const result = await parseMessageWithImages('check the file at src/index.ts');
    assert.strictEqual(result, null);
  });

  it('returns null for non-existent image paths', async () => {
    const result = await parseMessageWithImages(`look at /tmp/nonexistent-${randomUUID()}.png`);
    assert.strictEqual(result, null);
  });

  it('parses real image file paths', async () => {
    // Create a fake PNG file (needs to be > 100 bytes)
    const imgPath = join(tempDir, 'test.png');
    const fakePng = Buffer.alloc(200);
    fakePng[0] = 0x89;
    fakePng[1] = 0x50;
    await fs.writeFile(imgPath, fakePng);

    const result = await parseMessageWithImages(`analyze this image ${imgPath}`);
    assert.ok(result);
    assert.ok(result.length >= 2, 'should have text + image blocks');

    const textBlock = result.find((b) => b.type === 'text');
    assert.ok(textBlock);

    const imageBlock = result.find((b) => b.type === 'image');
    assert.ok(imageBlock);
    if (imageBlock?.type === 'image') {
      assert.strictEqual(imageBlock.source.type, 'base64');
      assert.strictEqual(imageBlock.source.media_type, 'image/png');
      assert.ok(imageBlock.source.data.length > 0);
    }
  });

  it('skips files that are too small', async () => {
    const imgPath = join(tempDir, 'tiny.png');
    await fs.writeFile(imgPath, Buffer.alloc(10));

    const result = await parseMessageWithImages(`image at ${imgPath}`);
    assert.strictEqual(result, null);
  });

  it('handles multiple image paths', async () => {
    const img1 = join(tempDir, 'a.png');
    const img2 = join(tempDir, 'b.jpg');
    await fs.writeFile(img1, Buffer.alloc(200));
    await fs.writeFile(img2, Buffer.alloc(200));

    const result = await parseMessageWithImages(`compare:\n${img1}\n${img2}`);
    assert.ok(result);
    const imageBlocks = result.filter((b) => b.type === 'image');
    assert.strictEqual(imageBlocks.length, 2);
  });
});
