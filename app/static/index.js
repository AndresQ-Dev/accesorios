import { createBrowserScanner } from './scanner.js';

const form = document.querySelector('#lookup-form');
const input = document.querySelector('#query');
const submit = form.querySelector('button[type="submit"]');
const status = document.querySelector('#status');
const result = document.querySelector('#result');
const scan = document.querySelector('#scan');
const scannerPanel = document.querySelector('#scanner');
const camera = document.querySelector('#camera');
const scanBand = document.querySelector('.scan-band');
const torch = document.querySelector('#torch');
const cancelScan = document.querySelector('#cancel-scan');
const scannerStatus = document.querySelector('#scanner-status');
const scanDebugPanel = document.querySelector('#scan-debug');
const scanDebugList = scanDebugPanel.querySelector('ol');
const scanDebugEntries = [];
const scanDebugEnabled = (() => {
  try { return new URLSearchParams(window.location.search).get('scanDebug') === '1' || window.localStorage.getItem('scanDebug') === '1'; }
  catch { return false; }
})();
scanDebugPanel.hidden = true;

function formatArs(value) {
  if (value === null) return 'Sin precio';
  return new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(value);
}

function formatArgentinaDateTime(value) {
  const source = typeof value === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value;
  const date = new Date(source);
  if (Number.isNaN(date.valueOf())) return 'fecha no disponible';
  const formatted = new Intl.DateTimeFormat('es-AR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
    timeZone: 'America/Argentina/Buenos_Aires',
  }).format(date);
  return `${formatted.replace(',', '')} hs`;
}

function setStatus(message, tone = 'info') {
  if (!status.hidden && status.textContent === message && status.dataset.tone === tone) return;
  status.textContent = message;
  status.dataset.tone = tone;
  status.hidden = false;
}

function showLoading() {
  result.hidden = false;
  result.dataset.loading = 'true';
  result.setAttribute('aria-busy', 'true');
  result.replaceChildren(document.createElement('div'));
  setStatus('Consultando el precio actual…', 'loading');
}

function showResults(items, freshness) {
  if (scanDebugEnabled) scanDebugPanel.hidden = true;
  const heading = document.createElement('h2'); heading.className = 'results-heading';
  heading.textContent = `${items.length} ${items.length === 1 ? 'precio encontrado' : 'precios encontrados'}`;
  const list = document.createElement('ol'); list.className = 'results'; list.setAttribute('aria-label', 'Resultados de búsqueda ordenados');
  for (const item of items) {
    const listItem = document.createElement('li'); listItem.className = 'result-item';
    const article = document.createElement('h3'); article.className = 'article'; article.textContent = item.article;
    const price = document.createElement('p'); price.className = 'price'; price.textContent = formatArs(item.priceArs);
    const code = document.createElement('p'); code.className = 'code'; code.textContent = item.code;
    listItem.replaceChildren(article, price, code);
    list.append(listItem);
  }
  const updated = document.createElement('p'); updated.className = 'freshness';
  updated.textContent = freshness ? `Última actualización: ${formatArgentinaDateTime(freshness)}` : 'No hay información sobre la actualización del catálogo';
  result.dataset.loading = 'false'; result.setAttribute('aria-busy', 'false'); result.replaceChildren(heading, list, updated);
  setStatus(`${items.length} ${items.length === 1 ? 'precio encontrado' : 'precios encontrados'}.`, 'success');
}

function reportScannerDebug(event) {
  if (!scanDebugEnabled) return;
  const entry = { at: new Date().toISOString(), event: event.event, details: event.details ?? {} };
  scanDebugEntries.push(entry);
  while (scanDebugEntries.length > 30) scanDebugEntries.shift();
  scanDebugList.replaceChildren(...scanDebugEntries.map((item) => {
    const line = document.createElement('li');
    const time = new Date(item.at).toLocaleTimeString('es-AR', { hour12: false });
    line.textContent = `${time} ${item.event} ${JSON.stringify(item.details)}`;
    return line;
  }));
  try {
    void fetch('/api/v1/scan-debug', {
      method: 'POST', keepalive: true,
      headers: { 'Content-Type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(entry),
    }).catch(() => {});
  } catch { /* Diagnostic logging must never block scanning. */ }
}

async function lookup(query, decoded = false) {
  if (!query) { setStatus('Ingrese un código, artículo, marca o categoría para buscar.', 'error'); input.focus(); return 'retry'; }
  submit.disabled = true; showLoading();
  try {
    const response = await fetch(`/api/v1/search?q=${encodeURIComponent(query)}`, { headers: { accept: 'application/json' } });
    if (response.status === 401) { window.location.assign('/login'); return 'retry'; }
    if (response.status === 400) throw new Error('invalid-query');
    if (!response.ok) throw new Error('server-failure');
    const data = await response.json();
    if (data.results.length === 0) { result.hidden = true; setStatus(decoded ? 'No se encontró un precio coincidente. Continúe escaneando o busque manualmente.' : 'No se encontró un precio coincidente. Verifique el código o pruebe con otro artículo.', 'empty'); return 'not-found'; }
    showResults(data.results, data.freshness);
    return 'matched';
  } catch (error) {
    result.hidden = true;
    setStatus(error instanceof Error && error.message === 'invalid-query' ? 'Ingrese un código o artículo válido e inténtelo nuevamente.' : 'No se puede consultar el precio en este momento. Verifique la conexión e inténtelo nuevamente.', 'error');
    return 'retry';
  } finally { submit.disabled = false; result.setAttribute('aria-busy', 'false'); }
}

async function lookupScannedBarcode(text) {
  input.value = text;
  const outcome = await lookup(text, true);
  if (outcome !== 'not-found' || !/^0[0-9]{13}$/.test(text)) return outcome;
  const withoutLeadingZero = text.slice(1);
  reportScannerDebug({ event: 'scanner-leading-zero-fallback', details: { originalLength: text.length, retryLength: withoutLeadingZero.length } });
  input.value = withoutLeadingZero;
  return lookup(withoutLeadingZero, true);
}

function scannerState(state) {
  const messages = {
    insecure: 'Para escanear con la cámara se requiere HTTPS. La búsqueda manual sigue disponible.',
    unsupported: 'Este navegador no puede escanear este código de barras. Use la búsqueda manual.',
    'permission-denied': 'La aplicación no tiene permiso para usar la cámara. Permítalo en la configuración del navegador o busque manualmente.',
    'camera-error': 'La cámara se detuvo. Cierre el escáner y vuelva a abrirlo; si persiste, cierre otras aplicaciones que la usen.',
    scanning: 'Escaneando en este dispositivo. Las imágenes de la cámara no salen de él.',
    slow: 'Se sigue buscando. Mejore la iluminación, mantenga el código quieto o use la búsqueda manual.',
    'catalog-miss': 'No se encontró un precio coincidente. Continúe escaneando o busque manualmente.',
    unreadable: 'No se pudo leer un código válido. Enfoque el código dentro del recuadro y continúe escaneando.',
  };
  setStatus(messages[state], state === 'scanning' ? 'info' : state === 'catalog-miss' || state === 'unreadable' ? 'empty' : 'error');
  scannerStatus.textContent = messages[state];
  if (!['scanning', 'slow', 'catalog-miss', 'unreadable'].includes(state)) scanner.stop();
}

const scanner = createBrowserScanner(camera, {
  onState: scannerState,
  onTorch: (available) => { torch.hidden = !available; },
  onDiagnostic: reportScannerDebug,
  onDecode: async (text) => { const outcome = await lookupScannedBarcode(text); if (outcome === 'matched') closeScanner(null, false); return outcome; },
});

function closeScanner(message = 'Escaneo cancelado. La búsqueda manual está lista.', restoreFocus = true) {
  scanner.stop();
  if (scannerPanel.open) scannerPanel.close();
  torch.hidden = true;
  torch.textContent = 'Encender luz';
  torch.setAttribute('aria-pressed', 'false');
  scan.disabled = false;
  scan.setAttribute('aria-pressed', 'false');
  if (message) setStatus(message);
  if (restoreFocus) scan.focus();
}

scan.addEventListener('click', () => {
  scan.disabled = true; scan.setAttribute('aria-pressed', 'true'); torch.hidden = true;
  torch.textContent = 'Encender luz'; torch.setAttribute('aria-pressed', 'false');
  scanBand.dataset.loading = 'true'; scannerStatus.textContent = 'Iniciando cámara…';
  scannerPanel.showModal(); cancelScan.focus(); void scanner.start();
});
camera.addEventListener('loadeddata', () => { scanBand.dataset.loading = 'false'; });
cancelScan.addEventListener('click', () => closeScanner());
scannerPanel.addEventListener('cancel', (event) => { event.preventDefault(); closeScanner(); });
torch.addEventListener('click', async () => {
  const on = torch.getAttribute('aria-pressed') !== 'true';
  if (await scanner.toggleTorch(on)) { torch.textContent = on ? 'Apagar luz' : 'Encender luz'; torch.setAttribute('aria-pressed', String(on)); }
});
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') closeScanner(null, false); });
window.addEventListener('pagehide', () => closeScanner(null, false));
form.addEventListener('submit', (event) => { event.preventDefault(); void lookup(input.value.trim()); });
