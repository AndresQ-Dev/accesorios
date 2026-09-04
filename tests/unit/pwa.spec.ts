import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';

const templates = [
  await readFile(new URL('../../app/templates/index.html', import.meta.url), 'utf8'),
  await readFile(new URL('../../app/templates/login.html', import.meta.url), 'utf8'),
  await readFile(new URL('../../app/templates/admin.html', import.meta.url), 'utf8'),
].join('\n');

const manifest = JSON.parse(await readFile(new URL('../../app/static/manifest.webmanifest', import.meta.url), 'utf8'));
const serviceWorker = await readFile(new URL('../../app/static/service-worker.js', import.meta.url), 'utf8');

describe('PWA readiness', () => {
  it('exposes install metadata from all rendered entry pages', () => {
    expect(templates.match(/rel="manifest"/g)).toHaveLength(3);
    expect(templates.match(/apple-mobile-web-app-capable" content="yes"/g)).toHaveLength(3);
    expect(templates.match(/rel="apple-touch-icon"/g)).toHaveLength(3);
    expect(templates.match(/rel="icon" type="image\/svg\+xml"/g)).toHaveLength(3);
    expect(templates.match(/pwa\.js/g)).toHaveLength(3);
    expect(templates).toContain('theme-color" content="#111111"');
    expect(templates).toContain('apple-mobile-web-app-title" content="Accesorios"');
  });

  it('defines a standalone Spanish price lookup app with Android and maskable icons', () => {
    expect(manifest.name).toBe('Accesorios');
    expect(manifest.short_name).toBe('Accesorios');
    expect(manifest.start_url).toBe('/');
    expect(manifest.scope).toBe('/');
    expect(manifest.display).toBe('standalone');
    expect(manifest.theme_color).toBe('#111111');
    expect(manifest.background_color).toBe('#F5F5F4');
    expect(manifest.icons).toEqual(expect.arrayContaining([
      expect.objectContaining({ src: '/static/icons/icon-192.png', sizes: '192x192', purpose: 'any' }),
      expect.objectContaining({ src: '/static/icons/icon-512.png', sizes: '512x512', purpose: 'any' }),
      expect.objectContaining({ src: '/static/icons/icon-maskable-512.png', sizes: '512x512', purpose: 'maskable' }),
    ]));
  });

  it('caches static assets only and leaves API plus navigations to the network', () => {
    expect(serviceWorker).toContain("const CACHE_VERSION = 'precios-static-v5'");
    expect(serviceWorker).not.toContain('precios-static-v4');
    expect(serviceWorker).toContain("'/static/fetch-with-timeout.js'");
    expect(serviceWorker).toContain("'/static/vendor/zxing_reader.wasm'");
    expect(serviceWorker).toContain("'/static/no-repeat-picker.js'");
    expect(serviceWorker).toContain("'/static/scanner-lookup.js'");
    expect(serviceWorker).toContain("'/static/images/scanner-no-match/01.webp'");
    expect(serviceWorker).toContain("'/static/images/scanner-no-match/02.webp'");
    expect(serviceWorker).toContain("'/static/images/scanner-no-match/04.webp'");
    expect(serviceWorker).toContain("'/static/images/scanner-no-match/05.webp'");
    expect(serviceWorker).toContain("if (url.pathname.startsWith('/api/')) return;");
    expect(serviceWorker).toContain("if (request.mode === 'navigate' || request.headers.get('accept')?.includes('text/html')) return;");
    expect(serviceWorker).toContain('if (!STATIC_ASSETS.includes(url.pathname)) return;');
    expect(serviceWorker).not.toContain("cache.put('/'");
  });

  it('deletes the previous static cache when the replacement worker activates', async () => {
    type WorkerEvent = { waitUntil: (promise: Promise<unknown>) => void };
    const listeners: Record<string, (event: WorkerEvent) => void> = {};
    const worker = {
      addEventListener: (type: string, listener: (event: WorkerEvent) => void) => { listeners[type] = listener; },
      clients: { claim: vi.fn() },
      location: { origin: 'https://example.test' },
      skipWaiting: vi.fn(),
    };
    const cacheStorage = {
      keys: vi.fn().mockResolvedValue(['precios-static-v1', 'precios-static-v2', 'precios-static-v3', 'precios-static-v4', 'precios-static-v5']),
      delete: vi.fn().mockResolvedValue(true),
    };

    new Function('self', 'caches', serviceWorker)(worker, cacheStorage);

    let activation: Promise<unknown> | undefined;
    listeners.activate({ waitUntil: (promise) => { activation = promise; } });
    if (!activation) throw new Error('The service worker did not register an activate handler.');
    await activation;

    expect(cacheStorage.delete).toHaveBeenCalledWith('precios-static-v1');
    expect(cacheStorage.delete).toHaveBeenCalledWith('precios-static-v2');
    expect(cacheStorage.delete).toHaveBeenCalledWith('precios-static-v3');
    expect(cacheStorage.delete).toHaveBeenCalledWith('precios-static-v4');
    expect(cacheStorage.delete).not.toHaveBeenCalledWith('precios-static-v5');
    expect(worker.clients.claim).toHaveBeenCalledOnce();
  });
});
