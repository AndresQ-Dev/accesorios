import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { SCANNER_NO_MATCH_IMAGES } from '../../app/static/no-repeat-picker.js';

const execFile = promisify(execFileCallback);

describe('scanner no-match image assets', () => {
  it('keeps the displayed manifest unique at 512x512 RGBA with transparent edges and opaque foreground', async () => {
    expect(SCANNER_NO_MATCH_IMAGES).toEqual([
      '/static/images/scanner-no-match/01.webp',
      '/static/images/scanner-no-match/02.webp',
      '/static/images/scanner-no-match/04.webp',
      '/static/images/scanner-no-match/05.webp',
    ]);
    expect(new Set(SCANNER_NO_MATCH_IMAGES)).toHaveLength(4);

    const { stdout } = await execFile('node', ['scripts/verify-scanner-no-match-assets.mjs']);
    expect(stdout).toContain('Verified 4 512x512 RGBA scanner no-match WebP assets.');
  });
});
