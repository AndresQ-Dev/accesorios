import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const page = [
  await readFile(new URL('../../app/templates/index.html', import.meta.url), 'utf8'),
  await readFile(new URL('../../app/static/index.css', import.meta.url), 'utf8'),
].join('\n');

describe('scanner guide layout', () => {
  it('keeps the circular trigger while giving its barcode logo a centered balanced inset', () => {
    expect(page).toMatch(/\.scan \{[^}]*width: 6rem;[^}]*min-width: 6rem;[^}]*height: 6rem;[^}]*min-height: 6rem;[^}]*place-items: center;/);
    expect(page).toContain('<img class="scan-logo"');
    expect(page).toMatch(/\.scan-logo \{[^}]*width: 4\.25rem;[^}]*height: 4\.25rem;[^}]*object-fit: contain;/);
  });

  it('centers the instructional guide as an overlay over the video viewport', () => {
    expect(page).toContain('<div class="scan-band"><video id="camera" autoplay muted playsinline></video></div>');
    expect(page).toMatch(/\.scan-band \{[^}]*position: relative;/);
    expect(page).toMatch(/\.scan-band::after \{[^}]*position: absolute;[^}]*top: 50%;[^}]*left: 50%;[^}]*width: 84%;[^}]*transform: translate\(-50%, -50%\);/);
  });
});
