import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const page = [
  await readFile(new URL('../../app/templates/admin.html', import.meta.url), 'utf8'),
  await readFile(new URL('../../app/static/admin.js', import.meta.url), 'utf8'),
].join('\n');

describe('admin XLSX import route', () => {
  it('keeps credentials and the CSRF token out of the rendered surface', () => {
    expect(page).toContain('type="password"');
    expect(page).toContain('csrfMeta?.content || null');
    expect(page).toContain('{% if admin_authenticated %}');
    expect(page).not.toMatch(/localStorage|sessionStorage|console\.(log|info|warn|error)/);
  });

  it('posts the raw XLSX file through the protected preview contract', () => {
    expect(page).toContain("fetch('/api/v1/admin/import/preview'");
    expect(page).toContain("credentials: 'same-origin'");
    expect(page).toContain("'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'");
    expect(page).toContain('body: file');
    expect(page).toContain("'x-csrf-token': csrfToken");
  });

  it('renders only the aggregate preview and requires an explicit confirmation action', () => {
    expect(page).toContain('id="summary-rows"');
    expect(page).toContain('id="summary-creates"');
    expect(page).toContain('id="summary-updates"');
    expect(page).toContain('id="summary-version"');
    expect(page).toContain('id="summary-expiry"');
    expect(page).toContain('id="confirm-import"');
    expect(page).toContain('Confirmar importación irreversible');
    expect(page).toMatch(/confirmButton\?\.addEventListener\('click'/);
    const previewFlow = page.split("previewForm?.addEventListener('submit'")[1].split("confirmButton?.addEventListener('click'")[0];
    expect(previewFlow).not.toContain('/api/v1/admin/import/confirm');
  });

  it('confirms only the server-issued preview fields and recovers expired previews at file selection', () => {
    expect(page).toContain("fetch('/api/v1/admin/import/confirm'");
    expect(page).toContain('JSON.stringify({ previewReference: preview.previewReference, contentHash: preview.contentHash, baseCatalogVersion: preview.baseCatalogVersion })');
    expect(page).toContain('PREVIEW_EXPIRED');
    expect(page).toContain('fileInput.focus();');
    expect(page).toContain('role="status"');
  });
});
