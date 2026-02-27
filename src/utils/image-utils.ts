import { promises as fs } from 'node:fs';
import { extname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { flog } from './log.js';

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);

const MIME_MAP: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};

// Match absolute paths (/...) or ~/... paths to image files
const IMAGE_PATH_RE = /(?:~\/|\/(?!\/))[\w.\-àâäéèêëïîôùûüÿçœæ' /]+\.(?:png|jpe?g|gif|webp|bmp)/gi;

export interface ImageBlock {
  type: 'image';
  source: {
    type: 'base64';
    media_type: string;
    data: string;
  };
}

export interface TextBlock {
  type: 'text';
  text: string;
}

export type ContentBlock = TextBlock | ImageBlock;

/** Resolve ~/... paths to absolute paths */
function resolvePath(p: string): string {
  if (p.startsWith('~/')) return resolve(homedir(), p.slice(2));
  return p;
}

/**
 * Parse a message for image file paths. Returns multimodal content blocks
 * if images are found, or null if the message is text-only.
 * Uses async I/O to avoid blocking the event loop.
 */
export async function parseMessageWithImages(text: string): Promise<ContentBlock[] | null> {
  const matches = text.match(IMAGE_PATH_RE);
  if (!matches || matches.length === 0) return null;

  const validImages: Array<{ path: string; data: string; mime: string }> = [];

  for (const match of matches) {
    const rawPath = match.trim();
    const filePath = resolvePath(rawPath);
    const ext = extname(filePath).toLowerCase();

    if (!IMAGE_EXTENSIONS.has(ext)) continue;
    try {
      await fs.access(filePath);
    } catch {
      flog.debug('SYSTEM', `Image path not found: ${filePath}`);
      continue;
    }

    try {
      const buf = await fs.readFile(filePath);
      // Sanity check: file should be at least a few bytes and not too big (20MB)
      if (buf.length < 100 || buf.length > 20 * 1024 * 1024) {
        flog.warn('SYSTEM', `Image file size invalid (${buf.length} bytes): ${filePath}`);
        continue;
      }
      const data = buf.toString('base64');
      const mime = MIME_MAP[ext] || 'image/png';
      validImages.push({ path: rawPath, data, mime });
      flog.info('SYSTEM', `Image encoded ${filePath} (${Math.round(buf.length / 1024)}KB)`);
    } catch (err) {
      flog.error('SYSTEM', `Image failed to read ${filePath}: ${err}`);
    }
  }

  if (validImages.length === 0) return null;

  // Build content blocks: text first, then images
  // Remove image paths from the text to avoid duplication
  let cleanText = text;
  for (const img of validImages) {
    cleanText = cleanText.replace(img.path, `[image: ${img.path.split('/').pop()}]`);
  }

  const blocks: ContentBlock[] = [];

  if (cleanText.trim()) {
    blocks.push({ type: 'text', text: cleanText.trim() });
  }

  for (const img of validImages) {
    blocks.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: img.mime,
        data: img.data,
      },
    });
  }

  return blocks;
}
