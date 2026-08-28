const loginForm = document.querySelector('#login-form');
const password = document.querySelector('#password');
const loginButton = document.querySelector('#login-submit');
const loginPanel = document.querySelector('#login-panel');
const importPanel = document.querySelector('#import-panel');
const catalogPanel = document.querySelector('#catalog-panel');
const productSearchForm = document.querySelector('#product-search-form');
const productQuery = document.querySelector('#product-query');
const productPriceAttention = document.querySelector('#product-price-attention');
const productSearchButton = document.querySelector('#product-search-submit');
const productResults = document.querySelector('#product-results');
const productEditor = document.querySelector('#product-editor');
const productCode = document.querySelector('#product-code');
const productBarcode = document.querySelector('#product-barcode');
const productArticle = document.querySelector('#product-article');
const productPrice = document.querySelector('#product-price');
const productRevision = document.querySelector('#product-revision');
const productSave = document.querySelector('#product-save');
const previewForm = document.querySelector('#preview-form');
const fileInput = document.querySelector('#xlsx-file');
const fileName = document.querySelector('#file-name');
const previewButton = document.querySelector('#preview-submit');
const previewSummary = document.querySelector('#preview-summary');
const confirmButton = document.querySelector('#confirm-import');
const successSummary = document.querySelector('#success-summary');
const newImport = document.querySelector('#new-import');
const status = document.querySelector('#admin-status');
const rows = document.querySelector('#summary-rows');
const creates = document.querySelector('#summary-creates');
const updates = document.querySelector('#summary-updates');
const version = document.querySelector('#summary-version');
const expiry = document.querySelector('#summary-expiry');
const successDetails = document.querySelector('#success-details');
const csrfMeta = document.querySelector('meta[name="admin-csrf-token"]');
let csrfToken = csrfMeta?.content || null;
let preview = null;
let selectedProduct = null;
let busy = false;

const spanishError = {
  INVALID_LOGIN: 'Ingrese la contraseña.',
  INVALID_ADMIN_PASSWORD: 'Acceso inválido.',
  INVALID_APP_PASSWORD: 'Acceso inválido.',
  UNAUTHENTICATED: 'Sesión vencida.',
  LOGIN_THROTTLED: 'Espere unos minutos.',
  INVALID_ORIGIN: 'No se pudo completar.',
  INVALID_CSRF: 'Sesión vencida.',
  INVALID_QUERY: 'Ingrese un código, código de barras o artículo.',
  PRODUCT_NOT_FOUND: 'El producto ya no está disponible.',
  INVALID_EDIT: 'Revise los datos del producto.',
  CODE_COLLISION: 'El código ya existe.',
  UNSUPPORTED_MEDIA_TYPE: 'XLSX inválido.',
  XLSX_TOO_LARGE: 'XLSX demasiado grande.',
  INVALID_XLSX: 'Formato inválido.',
  PREVIEW_NOT_FOUND: 'Vista previa vencida.',
  PREVIEW_EXPIRED: 'Vista previa vencida.',
  PREVIEW_MISMATCH: 'Archivo distinto.',
  REVISION_CONFLICT: 'Catálogo actualizado. Genere otra vista previa.',
  BARCODE_COLLISION: 'Código de barras duplicado.',
  INVALID_CONFIRMATION: 'Vista previa inválida.',
  INTERNAL_ERROR: 'No se pudo completar.',
};

function showStatus(message, tone = 'info', focus = false) {
  status.textContent = message; status.dataset.tone = tone;
  status.setAttribute('role', tone === 'error' ? 'alert' : 'status'); status.hidden = false;
  if (focus) status.focus();
}
async function responseError(response) {
  const payload = await response.json().catch(() => ({}));
  return { code: payload.error?.code, message: spanishError[payload.error?.code] ?? 'No se pudo completar.' };
}
function setBusy(next) {
  busy = next;
  if (loginButton) loginButton.disabled = next;
  if (fileInput) fileInput.disabled = next;
  if (previewButton) previewButton.disabled = next || !fileInput?.files?.[0];
  if (confirmButton) confirmButton.disabled = next || !preview;
  if (productQuery) productQuery.disabled = next;
  if (productPriceAttention) productPriceAttention.disabled = next;
  if (productSearchButton) productSearchButton.disabled = next;
  if (productCode) productCode.disabled = next;
  if (productBarcode) productBarcode.disabled = next;
  if (productArticle) productArticle.disabled = next;
  if (productPrice) productPrice.disabled = next;
  if (productSave) productSave.disabled = next || !selectedProduct;
}
function clearPreview(focusFile = false) {
  preview = null;
  if (previewSummary) previewSummary.hidden = true;
  if (confirmButton) confirmButton.disabled = true;
  if (focusFile) fileInput?.focus();
}
function returnToLogin(message) {
  csrfToken = null; clearPreview();
  if (importPanel) importPanel.hidden = true;
  if (catalogPanel) catalogPanel.hidden = true;
  loginPanel.hidden = false;
  password.value = ''; showStatus(message, 'error'); password.focus();
}
function invalidPreview(code) { return ['PREVIEW_NOT_FOUND', 'PREVIEW_EXPIRED', 'PREVIEW_MISMATCH', 'REVISION_CONFLICT', 'INVALID_CONFIRMATION'].includes(code); }

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

function formatArs(value) {
  if (value === null) return 'Sin precio';
  return new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(value);
}

function renderSearchResults(items) {
  if (!productResults) return;
  productResults.replaceChildren();
  productResults.hidden = false;
  if (items.length === 0) {
    const empty = document.createElement('p'); empty.textContent = 'No hay productos coincidentes.';
    productResults.append(empty); return;
  }
  const heading = document.createElement('h3'); heading.textContent = `${items.length} resultado${items.length === 1 ? '' : 's'}`;
  const list = document.createElement('ol'); list.className = 'product-result-list';
  for (const item of items) {
    const entry = document.createElement('li');
    const button = document.createElement('button'); button.type = 'button'; button.className = 'product-result'; button.dataset.productId = String(item.id);
    const article = document.createElement('span'); article.className = 'product-result__article'; article.textContent = item.article;
    const metadata = document.createElement('span'); metadata.className = 'product-result__meta'; metadata.textContent = `${item.code} · ${item.barcode ?? 'Sin código de barras'} · ${formatArs(item.priceArs)}`;
    button.replaceChildren(article, metadata);
    button.addEventListener('click', () => { void loadProduct(item.id); });
    entry.append(button); list.append(entry);
  }
  productResults.append(heading, list);
}

function showProduct(product) {
  selectedProduct = product;
  if (!productEditor || !productCode || !productBarcode || !productArticle || !productPrice || !productRevision) return;
  productCode.value = product.code;
  productBarcode.value = product.barcode ?? '';
  productArticle.value = product.article;
  productPrice.value = product.priceArs === null ? '' : String(product.priceArs);
  productRevision.textContent = `Versión ${product.revision}`;
  productEditor.hidden = false;
  productCode.focus();
}

async function loadProduct(productId) {
  if (busy || !csrfToken) return;
  setBusy(true); showStatus('Cargando producto…');
  try {
    const response = await fetch(`/api/v1/admin/products/${encodeURIComponent(productId)}`, { credentials: 'same-origin', headers: { accept: 'application/json' } });
    if (response.status === 401 || response.status === 403) { returnToLogin((await responseError(response)).message); return; }
    if (!response.ok) throw new Error((await responseError(response)).message);
    const product = await response.json();
    if (!Number.isInteger(product.id) || !Number.isInteger(product.revision)) throw new Error('Producto inválido.');
    showProduct(product); showStatus('Producto cargado.', 'success');
  } catch (error) { showStatus(error instanceof Error ? error.message : 'No se pudo cargar el producto.', 'error', true); }
  finally { setBusy(false); }
}

productSearchForm?.addEventListener('submit', async (event) => {
  event.preventDefault(); const query = productQuery?.value.trim() ?? '';
  if (busy || !csrfToken) return;
  if (!query && !productPriceAttention?.checked) { showStatus('Ingrese un código, código de barras o artículo.', 'error', true); productQuery?.focus(); return; }
  const searchParameters = new URLSearchParams();
  if (query) searchParameters.set('q', query);
  if (productPriceAttention?.checked) searchParameters.set('needsPriceAttention', 'true');
  setBusy(true); showStatus('Buscando productos…');
  try {
    const response = await fetch(`/api/v1/admin/products?${searchParameters.toString()}`, { credentials: 'same-origin', headers: { accept: 'application/json' } });
    if (response.status === 401 || response.status === 403) { returnToLogin((await responseError(response)).message); return; }
    if (!response.ok) throw new Error((await responseError(response)).message);
    const payload = await response.json();
    if (!Array.isArray(payload.results)) throw new Error('Resultados inválidos.');
    renderSearchResults(payload.results); showStatus(`${payload.results.length} resultado${payload.results.length === 1 ? '' : 's'}.`, 'success');
  } catch (error) { showStatus(error instanceof Error ? error.message : 'No se pudo buscar.', 'error', true); }
  finally { setBusy(false); }
});

productEditor?.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (busy || !csrfToken || !selectedProduct || !productCode || !productBarcode || !productArticle || !productPrice) return;
  const priceRaw = productPrice.value.trim();
  if (priceRaw !== '' && (!/^\d+$/.test(priceRaw) || Number(priceRaw) > 9_007_199_254_740_991)) {
    showStatus('Ingrese un precio entero no negativo o déjelo vacío.', 'error', true); productPrice.focus(); return;
  }
  const payload = {
    expectedRevision: selectedProduct.revision,
    code: productCode.value,
    barcode: productBarcode.value || null,
    article: productArticle.value,
    priceArs: priceRaw === '' ? null : Number(priceRaw),
  };
  setBusy(true); showStatus('Guardando cambios…');
  try {
    const response = await fetch(`/api/v1/admin/products/${encodeURIComponent(selectedProduct.id)}`, { method: 'PATCH', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify(payload) });
    if (response.status === 401 || response.status === 403) { returnToLogin((await responseError(response)).message); return; }
    if (!response.ok) {
      const issue = await responseError(response);
      throw new Error(issue.code === 'REVISION_CONFLICT' ? 'El producto cambió. Vuelva a cargarlo.' : issue.message);
    }
    const product = await response.json();
    if (!Number.isInteger(product.id) || !Number.isInteger(product.revision)) throw new Error('Respuesta inválida.');
    showProduct(product); showStatus('Cambios guardados.', 'success');
  } catch (error) { showStatus(error instanceof Error ? error.message : 'No se pudieron guardar los cambios.', 'error', true); }
  finally { setBusy(false); }
});

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault(); if (busy) return; setBusy(true); showStatus('Ingresando…');
  try {
    const response = await fetch('/api/v1/admin/login', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: password.value }) });
    if (!response.ok) throw new Error((await responseError(response)).message);
    const payload = await response.json();
    if (typeof payload.csrfToken !== 'string') throw new Error('No se pudo completar.');
    csrfToken = payload.csrfToken; password.value = ''; loginPanel.hidden = true;
    if (!importPanel || !catalogPanel) { window.location.reload(); return; }
    importPanel.hidden = false;
    catalogPanel.hidden = false;
    showStatus('Seleccione XLSX.', 'success'); fileInput.focus();
  } catch (error) { showStatus(error instanceof Error ? error.message : 'No se pudo completar.', 'error'); password.focus(); }
  finally { setBusy(false); }
});

fileInput?.addEventListener('change', () => {
  const file = fileInput.files?.[0]; fileName.textContent = file ? file.name : 'Sin archivo.';
  clearPreview(); successSummary.hidden = true; previewButton.disabled = !file;
});

previewForm?.addEventListener('submit', async (event) => {
  event.preventDefault(); const file = fileInput.files?.[0]; if (busy || !file || !csrfToken) return;
  if (!file.name.toLowerCase().endsWith('.xlsx')) { showStatus('Seleccione .xlsx.', 'error'); fileInput.focus(); return; }
  clearPreview(); setBusy(true); showStatus('Generando vista previa…');
  try {
    const response = await fetch('/api/v1/admin/import/preview', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'x-csrf-token': csrfToken }, body: file });
    if (response.status === 401 || response.status === 403) { returnToLogin((await responseError(response)).message); return; }
    if (!response.ok) throw new Error((await responseError(response)).message);
    const payload = await response.json();
    if (!payload.previewReference || !payload.contentHash || !Number.isInteger(payload.baseCatalogVersion) || !Array.isArray(payload.rows)) throw new Error('Vista previa inválida.');
    preview = payload; rows.textContent = String(payload.rows.length); creates.textContent = String(payload.diff.creates);
    updates.textContent = String(payload.diff.updates); version.textContent = String(payload.baseCatalogVersion);
    expiry.textContent = formatArgentinaDateTime(payload.expiresAt); previewSummary.hidden = false;
    showStatus('Vista previa lista.', 'success'); confirmButton.focus();
  } catch (error) { showStatus(error instanceof Error ? error.message : 'No se pudo generar.', 'error'); fileInput.focus(); }
  finally { setBusy(false); }
});

confirmButton?.addEventListener('click', async () => {
  if (busy || !preview || !csrfToken) return; setBusy(true); showStatus('Importando…');
  try {
    const response = await fetch('/api/v1/admin/import/confirm', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify({ previewReference: preview.previewReference, contentHash: preview.contentHash, baseCatalogVersion: preview.baseCatalogVersion }) });
    const payload = await response.json().catch(() => ({}));
    if (response.status === 401 || response.status === 403) { returnToLogin(spanishError[payload.error?.code] ?? 'Sesión vencida.'); return; }
    if (!response.ok) {
      if (invalidPreview(payload.error?.code)) { clearPreview(); fileInput.value = ''; fileName.textContent = 'Seleccione el archivo otra vez.'; showStatus(spanishError[payload.error?.code] ?? 'Vista previa inválida.', 'error'); fileInput.focus(); return; }
      throw new Error(spanishError[payload.error?.code] ?? 'No se pudo importar.');
    }
    successDetails.textContent = `Altas: ${payload.creates ?? 0}. Cambios: ${payload.updates ?? 0}. Versión: ${payload.catalogVersion ?? '—'}.`;
    clearPreview(); previewForm.reset(); fileName.textContent = 'Sin archivo.';
    successSummary.hidden = false; showStatus('Actualizado.', 'success'); newImport.focus();
  } catch (error) { showStatus(error instanceof Error ? error.message : 'No se pudo importar.', 'error'); confirmButton.focus(); }
  finally { setBusy(false); }
});

newImport?.addEventListener('click', () => {
  successSummary.hidden = true; previewForm.reset(); fileName.textContent = 'Sin archivo.';
  clearPreview(true); showStatus('Seleccione XLSX.');
});
