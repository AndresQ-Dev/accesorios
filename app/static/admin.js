const loginForm = document.querySelector('#login-form');
const password = document.querySelector('#password');
const loginButton = document.querySelector('#login-submit');
const loginPanel = document.querySelector('#login-panel');
const importPanel = document.querySelector('#import-panel');
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
let busy = false;

const spanishError = {
  INVALID_LOGIN: 'Ingrese la contraseña.',
  INVALID_ADMIN_PASSWORD: 'Acceso inválido.',
  INVALID_APP_PASSWORD: 'Acceso inválido.',
  UNAUTHENTICATED: 'Sesión vencida.',
  LOGIN_THROTTLED: 'Espere unos minutos.',
  INVALID_ORIGIN: 'No se pudo completar.',
  INVALID_CSRF: 'Sesión vencida.',
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

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault(); if (busy) return; setBusy(true); showStatus('Ingresando…');
  try {
    const response = await fetch('/api/v1/admin/login', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: password.value }) });
    if (!response.ok) throw new Error((await responseError(response)).message);
    const payload = await response.json();
    if (typeof payload.csrfToken !== 'string') throw new Error('No se pudo completar.');
    csrfToken = payload.csrfToken; password.value = ''; loginPanel.hidden = true;
    if (!importPanel) { window.location.reload(); return; }
    importPanel.hidden = false;
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
