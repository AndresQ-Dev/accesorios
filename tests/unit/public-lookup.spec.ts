import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const pagePath = resolve(process.cwd(), 'src/pages/index.astro');

describe('public manual lookup page', () => {
  it('provides an accessible manual search and recovery states', async () => {
    const page = await readFile(pagePath, 'utf8');

    expect(page).toContain('<form');
    expect(page).toContain('aria-live="polite"');
    expect(page).toContain('name="query"');
    expect(page).toContain('/api/v1/search');
    expect(page).toContain('formatArs');
    expect(page).toContain('item.brand');
    expect(page).toContain('item.article');
    expect(page).toContain('item.category');
    expect(page).toContain('item.code');
    expect(page).toContain('response.status === 400');
    expect(page).toContain('No matching price was found');
    expect(page).toContain('Unable to check the price right now');
    expect(page).toContain('Barcode decoded, but no matching price was found');
    expect(page).toContain('cancel-scan');
    expect(page).toContain('Camera scanning needs HTTPS');
  });
});
