import { execFile as execFileCallback } from 'node:child_process';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { SCANNER_NO_MATCH_IMAGES } from '../app/static/no-repeat-picker.js';

const execFile = promisify(execFileCallback);

async function pixel(path, x, y) {
  const { stdout } = await execFile('magick', [path, '-format', `%[pixel:p{${x},${y}}]`, 'info:']);
  return stdout.trim();
}

async function metadata(path) {
  const { stdout } = await execFile('magick', ['identify', '-format', '%w|%h|%[channels]|%m', path]);
  return stdout.trim().split('|');
}

async function alphaMaximum(path) {
  const { stdout } = await execFile('magick', [path, '-alpha', 'extract', '-format', '%[fx:maxima]', 'info:']);
  return Number(stdout);
}

if (new Set(SCANNER_NO_MATCH_IMAGES).size !== SCANNER_NO_MATCH_IMAGES.length) {
  throw new Error('Scanner no-match assets must be unique.');
}

for (const asset of SCANNER_NO_MATCH_IMAGES) {
  const path = fileURLToPath(new URL(`../app${asset}`, import.meta.url));
  await access(path);
  const [width, height, channels, format] = await metadata(path);
  const corner = await pixel(path, 0, 0);
  const maximumAlpha = await alphaMaximum(path);
  if (width !== '512' || height !== '512' || !channels.includes('rgba') || format !== 'WEBP') {
    throw new Error(`${asset} must be a 512x512 RGBA WebP, received ${width}x${height} ${channels} ${format}.`);
  }
  if (!/,0\)$/.test(corner)) throw new Error(`${asset} must have a transparent corner, received ${corner}.`);
  if (maximumAlpha !== 1) throw new Error(`${asset} must retain an opaque foreground pixel, received alpha maximum ${maximumAlpha}.`);
}

console.log(`Verified ${SCANNER_NO_MATCH_IMAGES.length} 512x512 RGBA scanner no-match WebP assets.`);
