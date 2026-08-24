const form = document.querySelector('#app-login-form');
const password = document.querySelector('#app-password');
const submit = document.querySelector('#app-login-submit');
const status = document.querySelector('#login-status');

function showStatus(message, tone = 'info') {
  status.textContent = message;
  status.dataset.tone = tone;
  status.setAttribute('role', tone === 'error' ? 'alert' : 'status');
  status.hidden = false;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (submit.disabled) return;
  submit.disabled = true;
  showStatus('Verificando acceso…');
  try {
    const response = await fetch('/api/v1/login', {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: password.value }),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      const message = payload.error?.code === 'LOGIN_THROTTLED'
        ? 'Se alcanzó el límite de intentos. Espere unos minutos antes de volver a intentar.'
        : payload.error?.code === 'INVALID_APP_PASSWORD'
        ? 'La contraseña no coincide. Revise el acceso e intente nuevamente.'
        : 'No se pudo validar el acceso. Revise la contraseña e intente nuevamente.';
      throw new Error(message);
    }
    const next = new URLSearchParams(window.location.search).get('next');
    window.location.assign(next?.startsWith('/') && !next.startsWith('//') ? next : '/');
  } catch (error) {
    showStatus(error instanceof Error ? error.message : 'No se pudo iniciar sesión.', 'error');
    password.select();
  } finally {
    submit.disabled = false;
  }
});
