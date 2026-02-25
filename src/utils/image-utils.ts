import { existsSync, readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { logger } from './logger.js';

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);

const MIME_MAP: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};

// Match absolute paths or ~/... paths to image files
const IMAGE_PATH_RE = /(?:\/[\w.\-àâäéèêëïîôùûüÿçœæ' ]+)+\.(?:png|jpe?g|gif|webp|bmp)/gi;

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

/**
 * Parse a message for image file paths. Returns multimodal content blocks
 * if images are found, or null if the message is text-only.
 */
export function parseMessageWithImages(text: string): ContentBlock[] | null {
  const matches = text.match(IMAGE_PATH_RE);
  if (!matches || matches.length === 0) return null;

  const validImages: Array<{ path: string; data: string; mime: string }> = [];

  for (const match of matches) {
    const filePath = match.trim();
    const ext = extname(filePath).toLowerCase();

    if (!IMAGE_EXTENSIONS.has(ext)) continue;
    if (!existsSync(filePath)) {
      logger.debug(`[IMAGE] Path not found: ${filePath}`);
      continue;
    }

    try {
      const buf = readFileSync(filePath);
      // Sanity check: file should be at least a few bytes and not too big (20MB)
      if (buf.length < 100 || buf.length > 20 * 1024 * 1024) {
        logger.warn(`[IMAGE] File size invalid (${buf.length} bytes): ${filePath}`);
        continue;
      }
      const data = buf.toString('base64');
      const mime = MIME_MAP[ext] || 'image/png';
      validImages.push({ path: filePath, data, mime });
      logger.info(`[IMAGE] Encoded ${filePath} (${Math.round(buf.length / 1024)}KB)`);
    } catch (err) {
      logger.error(`[IMAGE] Failed to read ${filePath}: ${err}`);
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
