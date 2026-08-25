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
  INVALID_LOGIN: 'Ingresá la contraseña para continuar.',
  INVALID_ADMIN_PASSWORD: 'La contraseña de administrador no coincide. Revisala e intentá nuevamente.',
  INVALID_APP_PASSWORD: 'La contraseña de acceso no coincide. Volvé al ingreso principal.',
  UNAUTHENTICATED: 'La sesión no es válida o venció. Volvé a ingresar.',
  LOGIN_THROTTLED: 'Se alcanzó el límite de intentos. Esperá unos minutos antes de volver a intentar.',
  INVALID_ORIGIN: 'La solicitud debe realizarse desde esta misma aplicación.',
  INVALID_CSRF: 'La sesión de seguridad venció. Volvé a ingresar.',
  UNSUPPORTED_MEDIA_TYPE: 'El archivo debe ser un XLSX válido.',
  XLSX_TOO_LARGE: 'El archivo XLSX supera el tamaño permitido.',
  INVALID_XLSX: 'El archivo XLSX no cumple con el formato aprobado. Corregilo y volvé a seleccionarlo.',
  PREVIEW_NOT_FOUND: 'La vista previa ya no está disponible. Seleccioná el archivo nuevamente.',
  PREVIEW_EXPIRED: 'La vista previa venció. Seleccioná el archivo nuevamente.',
  PREVIEW_MISMATCH: 'La vista previa no coincide con el archivo preparado. Seleccioná el archivo nuevamente.',
  REVISION_CONFLICT: 'El catálogo cambió desde la vista previa. Generá una nueva antes de confirmar.',
  BARCODE_COLLISION: 'Uno de los códigos de barras ya pertenece a otro producto. Corregí el archivo y generá otra vista previa.',
  INVALID_CONFIRMATION: 'No se pudo validar la confirmación. Seleccioná el archivo nuevamente.',
  INTERNAL_ERROR: 'No se pudo completar la solicitud. Intentá nuevamente en unos minutos.',
};

function showStatus(message, tone = 'info', focus = false) {
  status.textContent = message; status.dataset.tone = tone;
  status.setAttribute('role', tone === 'error' ? 'alert' : 'status'); status.hidden = false;
  if (focus) status.focus();
}
async function responseError(response) {
  const payload = await response.json().catch(() => ({}));
  return { code: payload.error?.code, message: spanishError[payload.error?.code] ?? 'El servidor no pudo completar la solicitud. Intentá nuevamente.' };
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
  event.preventDefault(); if (busy) return; setBusy(true); showStatus('Verificando acceso…');
  try {
    const response = await fetch('/api/v1/admin/login', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: password.value }) });
    if (!response.ok) throw new Error((await responseError(response)).message);
    const payload = await response.json();
    if (typeof payload.csrfToken !== 'string') throw new Error('No se pudo iniciar una sesión segura. Intentá nuevamente.');
    csrfToken = payload.csrfToken; password.value = ''; loginPanel.hidden = true;
    if (!importPanel) { window.location.reload(); return; }
    importPanel.hidden = false;
    showStatus('Sesión iniciada. Seleccioná un archivo XLSX.', 'success'); fileInput.focus();
  } catch (error) { showStatus(error instanceof Error ? error.message : 'No se pudo iniciar sesión. Intentá nuevamente.', 'error'); password.focus(); }
  finally { setBusy(false); }
});

fileInput?.addEventListener('change', () => {
  const file = fileInput.files?.[0]; fileName.textContent = file ? file.name : 'No se seleccionó ningún archivo.';
  clearPreview(); successSummary.hidden = true; previewButton.disabled = !file;
});

previewForm?.addEventListener('submit', async (event) => {
  event.preventDefault(); const file = fileInput.files?.[0]; if (busy || !file || !csrfToken) return;
  if (!file.name.toLowerCase().endsWith('.xlsx')) { showStatus('Seleccioná un archivo con extensión .xlsx.', 'error'); fileInput.focus(); return; }
  clearPreview(); setBusy(true); showStatus('Validando archivo y generando vista previa…');
  try {
    const response = await fetch('/api/v1/admin/import/preview', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'x-csrf-token': csrfToken }, body: file });
    if (response.status === 401 || response.status === 403) { returnToLogin((await responseError(response)).message); return; }
    if (!response.ok) throw new Error((await responseError(response)).message);
    const payload = await response.json();
    if (!payload.previewReference || !payload.contentHash || !Number.isInteger(payload.baseCatalogVersion) || !Array.isArray(payload.rows)) throw new Error('La respuesta de la vista previa no es válida. Seleccioná el archivo nuevamente.');
    preview = payload; rows.textContent = String(payload.rows.length); creates.textContent = String(payload.diff.creates);
    updates.textContent = String(payload.diff.updates); version.textContent = String(payload.baseCatalogVersion);
    expiry.textContent = formatArgentinaDateTime(payload.expiresAt); previewSummary.hidden = false;
    showStatus('Vista previa lista. Revisá el resumen antes de confirmar.', 'success'); confirmButton.focus();
  } catch (error) { showStatus(error instanceof Error ? error.message : 'No se pudo generar la vista previa.', 'error'); fileInput.focus(); }
  finally { setBusy(false); }
});

confirmButton?.addEventListener('click', async () => {
  if (busy || !preview || !csrfToken) return; setBusy(true); showStatus('Confirmando importación…');
  try {
    const response = await fetch('/api/v1/admin/import/confirm', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify({ previewReference: preview.previewReference, contentHash: preview.contentHash, baseCatalogVersion: preview.baseCatalogVersion }) });
    const payload = await response.json().catch(() => ({}));
    if (response.status === 401 || response.status === 403) { returnToLogin(spanishError[payload.error?.code] ?? 'La sesión venció. Volvé a ingresar.'); return; }
    if (!response.ok) {
      if (invalidPreview(payload.error?.code)) { clearPreview(); fileInput.value = ''; fileName.textContent = 'Seleccioná nuevamente el archivo para generar otra vista previa.'; showStatus(spanishError[payload.error?.code] ?? 'La vista previa ya no es válida.', 'error'); fileInput.focus(); return; }
      throw new Error(spanishError[payload.error?.code] ?? 'No se pudo confirmar la importación.');
    }
    successDetails.textContent = `Se registraron ${payload.creates ?? 0} altas y ${payload.updates ?? 0} actualizaciones. Versión del catálogo: ${payload.catalogVersion ?? '—'}.`;
    clearPreview(); previewForm.reset(); fileName.textContent = 'No se seleccionó ningún archivo.';
    successSummary.hidden = false; showStatus('Importación confirmada correctamente.', 'success'); newImport.focus();
  } catch (error) { showStatus(error instanceof Error ? error.message : 'No se pudo confirmar la importación.', 'error'); confirmButton.focus(); }
  finally { setBusy(false); }
});

newImport?.addEventListener('click', () => {
  successSummary.hidden = true; previewForm.reset(); fileName.textContent = 'No se seleccionó ningún archivo.';
  clearPreview(true); showStatus('Seleccioná un archivo XLSX para preparar otra importación.');
});
