import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const publicSurface = async () => [
  await readFile(resolve(process.cwd(), 'app/templates/index.html'), 'utf8'),
  await readFile(resolve(process.cwd(), 'app/static/index.css'), 'utf8'),
  await readFile(resolve(process.cwd(), 'app/static/index.js'), 'utf8'),
].join('\n');

describe('public manual lookup page', () => {
  it('keeps manual lookup attached with Enter submission plus recovery states', async () => {
    const page = await publicSurface();

    expect(page).toContain('<form');
    expect(page).toContain('aria-live="polite"');
    expect(page).toContain('name="query"');
    expect(page).toContain('enterkeyhint="search"');
    expect(page).toContain("form.addEventListener('submit'");
    expect(page).not.toContain('<header>');
    expect(page).toContain('<button class="search-submit" type="submit" aria-label="Buscar precio">');
    expect(page).toContain('<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m21 19.6-5.1-5.1');
    expect(page).toContain('class="sr-only" for="query">Código o artículo</label>');
    expect(page).toContain('placeholder="Código o artículo"');
    expect(page).toContain('form { display: flex; padding: 0; }');
    expect(page).toContain('.search-submit { display: grid; flex: 0 0 3.5rem; width: 3.5rem; min-width: 3.5rem; height: 3.5rem; min-height: 3.5rem;');
    expect(page).toContain('.search-submit svg { display: block; width: 1.375rem; height: 1.375rem; fill: currentColor; }');
    expect(page).toContain(':focus-visible');
    expect(page).toContain('.search-submit:active');
    expect(page).toContain('.search-submit:disabled');
    expect(page).toContain('/api/v1/search');
    expect(page).toContain('formatArs');
    expect(page).not.toContain('item.brand');
    expect(page).toContain('item.article');
    expect(page).not.toContain('item.category');
    expect(page).toContain('item.code');
    expect(page).toContain("if (value === null) return 'Sin precio'");
    expect(page).toContain('response.status === 400');
    expect(page).toContain('Buscando…');
    expect(page).toContain('No hay resultados relevantes.');
    expect(page).toContain("const SCANNER_NOT_FOUND_MESSAGE = 'Código no encontrado.'");
    expect(page).toContain("async function lookup(query, notFoundMessage = 'No hay resultados relevantes.')");
    expect(page).toContain("form.addEventListener('submit', (event) => { event.preventDefault(); void lookup(input.value.trim()); });");
    expect(page).toContain("lookup: (query) => lookup(query, null)");
    expect(page).toContain('onFinalNotFound: showScannerNoMatch');
    expect(page).toContain("'catalog-miss': SCANNER_NOT_FOUND_MESSAGE");
    expect(page).toContain('No se pudo consultar.');
    expect(page).not.toContain('No se encontró un precio coincidente.');
    expect(page).toContain("'catalog-miss'");
    expect(page).toContain('id="cancel-scan"');
    expect(page).toContain('HTTPS requerido. Busque manualmente.');
    expect(page).toContain('Escaneo cancelado.');
    expect(page).toContain("on ? 'Apagar luz' : 'Encender luz'");
  });

  it('centers the idle search and scanner controls in the safe dynamic viewport while output can flow below', async () => {
    const page = await publicSurface();

    expect(page).toContain('<div class="lookup-stage">');
    expect(page).toContain('<div class="lookup-controls">');
    expect(page).toMatch(/main \{[^}]*grid-template-rows: auto auto auto 1fr;[^}]*min-height: 100dvh;[^}]*scroll-padding-block:/);
    expect(page).toContain('.lookup-stage { display: grid; min-height: clamp(14rem, 46svh, 21rem); align-items: center; justify-items: center; padding-block: clamp(1rem, 5svh, 2.75rem) 0; }');
    expect(page).toContain('.lookup-controls { display: grid; width: min(100%, 34rem); gap: clamp(1.7rem, 5.5svh, 3.25rem); justify-items: center; }');
    expect(page).toContain('.scan-launch { display: grid; place-items: center; }');
    expect(page.indexOf('id="scan"')).toBeLessThan(page.indexOf('id="lookup-form"'));
    expect(page).toContain('.scan { width: 6rem; min-width: 6rem; height: 6rem; min-height: 6rem; border: 2px solid var(--accent); border-radius: 50%; place-items: center; color: var(--accent);');
    expect(page).toContain('.scan:hover { color: var(--accent); background: linear-gradient(180deg, #fdfdfc, #e7e5e4); }');
    expect(page).toContain('.scan:active { color: var(--accent); background: #e7e5e4; transform: translateY(1px); }');
    expect(page).toContain('.scan-logo { display: block; width: 4.25rem; height: 4.25rem; object-fit: contain; }');
    expect(page).toContain('@media (max-height: 42rem)');
    expect(page).toContain('.scan { width: 5.35rem; min-width: 5.35rem; height: 5.35rem; min-height: 5.35rem; }');
    expect(page.indexOf('id="status"')).toBeGreaterThan(page.indexOf('<div class="lookup-stage">'));
    expect(page.indexOf('id="result"')).toBeGreaterThan(page.indexOf('id="status"'));
  });

  it('keeps the scanner closed until its reachable trigger opens it, then restores the trigger when closed', async () => {
    const page = await publicSurface();

    expect(page).toContain('id="scan" type="button" aria-label="Abrir escáner de código de barras"');
    expect(page).toContain('<img class="scan-logo"');
    expect(page).toContain("filename='favicon.svg'");
    expect(page).toContain('aria-haspopup="dialog"');
    expect(page).toContain('aria-pressed="false"');
    expect(page).toContain('<dialog class="scanner" id="scanner" aria-modal="true" aria-labelledby="scanner-title"');
    expect(page).not.toMatch(/<dialog[^>]*\bid="scanner"[^>]*\bopen(?:\s|=|>)/);
    expect(page).toContain('scannerPanel.showModal()');
    expect(page).toContain('.scanner:not([open]) { display: none; }');
    expect(page).toContain('.scanner[open] { display: grid;');
    expect(page).toContain("scannerPanel.addEventListener('cancel'");
    expect(page).toContain("cancelScan.addEventListener('click', () => closeScanner())");
    expect(page).toContain('scanner.stop();');
    expect(page).toContain('scan.disabled = false;');
    expect(page).toContain("scan.setAttribute('aria-pressed', 'false');");
    expect(page).toContain("if (outcome === 'matched' || outcome === 'not-found') closeScanner(null, false)");
    expect(page).toContain('async function lookupScannedBarcode(text)');
    expect(page).toContain("import { lookupScannedBarcode as runScannedBarcodeLookup } from './scanner-lookup.js';");
    expect(page).toContain("event: 'scanner-leading-zero-fallback'");
    expect(page).toContain("document.addEventListener('visibilitychange'");
    expect(page).toContain("window.addEventListener('pagehide'");
    expect(page).toContain('width: 100dvw; height: 100dvh;');
    expect(page).toContain('max-width: none; max-height: none; margin: 0; padding: 0;');
    expect(page).toContain('.scan-launch { display: grid; place-items: center; }');
    expect(page).toContain('.scan-band::before');
    expect(page).toContain('scanBand.dataset.loading = \'true\';');
    expect(page).toContain("camera.addEventListener('loadeddata'");
    expect(page).toContain('object-fit: cover;');
    expect(page).not.toContain('box-shadow: 0 0 0 100vmax');
    expect(page).toContain('env(safe-area-inset-bottom)');
    expect(page).toContain('aria-describedby="scanner-status"');
    expect(page).toContain('id="scanner-status" class="sr-only" role="status" aria-live="polite" aria-atomic="true"');
    expect(page).not.toContain('id="scanner-guide"');
    expect(page).not.toContain('Mantenga el código de barras dentro de la banda.');
    expect(page).not.toContain('#scanner-status {');
  });

  it('keeps status and results out of the initial public screen until they are relevant', async () => {
    const page = await publicSurface();

    expect(page).toContain('id="status" class="status" aria-live="polite" aria-atomic="true" role="status" hidden');
    expect(page).toContain('status.hidden = false;');
    expect(page).toContain('<article id="result" class="result" aria-busy="false" hidden></article>');
    expect(page).not.toContain('Enter a code or article to see the current price.');
  });

  it('renders a centered, decorative Flork only through the scanner final-miss path', async () => {
    const page = await publicSurface();

    expect(page).toContain("import { pickScannerNoMatchImage } from './no-repeat-picker.js';");
    expect(page).toContain('function showScannerNoMatch()');
    expect(page).toContain("image.alt = '';");
    expect(page).toContain("image.setAttribute('aria-hidden', 'true');");
    expect(page).toContain("message.textContent = SCANNER_NOT_FOUND_MESSAGE;");
    expect(page).toContain("message.setAttribute('aria-hidden', 'true');");
    expect(page).toContain("setStatus(SCANNER_NOT_FOUND_MESSAGE, 'empty', true);");
    expect(page).toContain('.result[data-state="scanner-no-match"] { display: grid;');
    expect(page).toContain('.scanner-no-match { display: grid; inline-size: min(100%, 22rem);');
    expect(page).toContain('inline-size: min(100%, 19rem, 42dvh);');
    expect(page).toContain('aspect-ratio: 1;');
    expect(page).toContain('object-fit: contain;');
    expect(page).toContain('.status.sr-only {');
  });

  it('renders every ranked API result in an accessible ordered list', async () => {
    const page = await publicSurface();

    expect(page).toContain('function showResults(items');
    expect(page).toContain('for (const item of items)');
    expect(page).toContain("document.createElement('ol')");
    expect(page).toContain("'aria-label', 'Resultados de búsqueda ordenados'");
    expect(page).toContain("items.length === 1 ? 'resultado' : 'resultados'");
    expect(page).toContain("new Intl.DateTimeFormat('es-AR'");
    expect(page).toContain("timeZone: 'America/Argentina/Buenos_Aires'");
    expect(page).toContain('Actualizado:');
    expect(page).toContain('Sin actualización.');
    expect(page).toContain('showResults(data.results, data.freshness)');
    expect(page).not.toContain('data.results[0]');
  });
});
