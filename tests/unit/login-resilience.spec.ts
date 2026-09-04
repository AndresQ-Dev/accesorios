import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FetchTimeoutError, fetchWithTimeout } from '../../app/static/fetch-with-timeout.js';

interface SubmitEventLike {
  preventDefault: () => void;
}

type SubmitListener = (event: SubmitEventLike) => Promise<void> | void;

class FakeElement {
  disabled = false;
  hidden = true;
  textContent = '';
  value = '';
  readonly dataset: Record<string, string> = {};
  readonly focus = vi.fn();
  readonly select = vi.fn();
  private submitListener: SubmitListener | undefined;

  addEventListener(type: string, listener: SubmitListener): void {
    if (type === 'submit') this.submitListener = listener;
  }

  setAttribute(): void {}

  async submit(): Promise<void> {
    await this.submitListener?.({ preventDefault: vi.fn() });
  }
}

interface LoginElements {
  button: FakeElement;
  form: FakeElement;
  password: FakeElement;
  status: FakeElement;
}

interface LoginFixture {
  elements: LoginElements;
  selector: (query: string) => FakeElement | null;
}

let moduleCounter = 0;

function loginFixture(admin: boolean): LoginFixture {
  const form = new FakeElement();
  const password = new FakeElement();
  const button = new FakeElement();
  const status = new FakeElement();
  const selectors = new Map<string, FakeElement>([
    [admin ? '#login-form' : '#app-login-form', form],
    [admin ? '#password' : '#app-password', password],
    [admin ? '#login-submit' : '#app-login-submit', button],
    [admin ? '#admin-status' : '#login-status', status],
  ]);

  return { elements: { button, form, password, status }, selector: (query) => selectors.get(query) ?? null };
}

async function loadLoginModule(path: string, fixture: LoginFixture): Promise<void> {
  vi.stubGlobal('document', { querySelector: fixture.selector });
  vi.stubGlobal('window', { location: { search: '', assign: vi.fn(), reload: vi.fn() } });
  await import(`${new URL(path, import.meta.url).href}?test=${moduleCounter += 1}`);
}

function pendingFetch(_input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('fetchWithTimeout', () => {
  it('propagates a caller abort signal to fetch', async () => {
    const caller = new AbortController();
    const abortReason = new Error('caller cancelled');
    let receivedSignal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      receivedSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        receivedSignal?.addEventListener('abort', () => reject(receivedSignal?.reason), { once: true });
      });
    }));

    const request = fetchWithTimeout('/api/v1/login', { signal: caller.signal });
    caller.abort(abortReason);

    await expect(request).rejects.toBe(abortReason);
    expect(receivedSignal?.aborted).toBe(true);
  });

  it('aborts at the deadline with a dedicated timeout error and cleans up its timer', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(pendingFetch));

    const request = fetchWithTimeout('/api/v1/login', {}, 15);
    const timeout = expect(request).rejects.toBeInstanceOf(FetchTimeoutError);
    await vi.advanceTimersByTimeAsync(15);

    await timeout;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cleans up after success and preserves ordinary fetch failures', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}')));

    await expect(fetchWithTimeout('/api/v1/login')).resolves.toBeInstanceOf(Response);
    expect(vi.getTimerCount()).toBe(0);

    const failure = new Error('network unavailable');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(failure));
    await expect(fetchWithTimeout('/api/v1/login')).rejects.toBe(failure);
  });
});

describe('bounded login UI', () => {
  it.each([
    ['public', '../../app/static/login.js', false],
    ['admin', '../../app/static/admin.js', true],
  ])('restores the %s login controls after a timeout', async (_kind, path, admin) => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(pendingFetch));
    const fixture = loginFixture(admin);
    fixture.elements.password.value = 'password-to-keep-private';
    await loadLoginModule(path, fixture);

    const submission = fixture.elements.form.submit();
    expect(fixture.elements.button.disabled).toBe(true);
    await vi.advanceTimersByTimeAsync(15_000);
    await submission;

    expect(fixture.elements.status.textContent).toBe('La solicitud demoró demasiado. Intente nuevamente.');
    expect(fixture.elements.button.disabled).toBe(false);
    expect(fixture.elements.password.select).toHaveBeenCalledOnce();
  });

  it('maps LOGIN_BUSY without changing invalid and throttled handling', async () => {
    const loginScript = await readFile(new URL('../../app/static/login.js', import.meta.url), 'utf8');
    const adminScript = await readFile(new URL('../../app/static/admin.js', import.meta.url), 'utf8');

    for (const script of [loginScript, adminScript]) {
      expect(script).toContain("LOGIN_BUSY");
      expect(script).toContain('El acceso está ocupado. Intente nuevamente.');
      expect(script).toContain('LOGIN_THROTTLED');
    }
  });
});
