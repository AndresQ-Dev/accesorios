from __future__ import annotations

from collections.abc import Callable

from flask.testing import FlaskClient

from tests_py.conftest import ORIGIN


def test_jinja_pages_preserve_accessible_lookup_admin_and_login_surfaces(
    client: FlaskClient,
    login_app: Callable[[], str],
    login_admin: Callable[[], str],
) -> None:
    login = client.get("/login", base_url=ORIGIN)
    assert login.status_code == 200
    assert b'id="app-login-form"' in login.data
    assert b'autocomplete="current-password"' in login.data
    login_app()
    lookup = client.get("/", base_url=ORIGIN)
    assert b'id="lookup-form"' in lookup.data
    assert b'aria-live="polite"' in lookup.data
    assert b'id="scanner"' in lookup.data
    assert b'/static/index.js' in lookup.data
    assert b'/static/manifest.webmanifest' in lookup.data
    assert b'/static/pwa.js' in lookup.data
    assert b'apple-mobile-web-app-capable' in lookup.data
    admin = client.get("/admin", base_url=ORIGIN)
    assert b'id="login-panel"' in admin.data
    assert b'id="preview-form"' not in admin.data
    assert b'Confirmar importaci' not in admin.data
    login_admin()
    admin = client.get("/admin", base_url=ORIGIN)
    assert b'id="login-panel" class="panel" aria-labelledby="login-title" hidden' in admin.data
    assert b'id="preview-form"' in admin.data
    assert b'Confirmar importaci' in admin.data
    assert b'/static/manifest.webmanifest' in admin.data
    assert b'name="robots" content="noindex, nofollow, noarchive"' in lookup.data
    assert b'name="robots" content="noindex, nofollow, noarchive"' in login.data
    assert b'name="robots" content="noindex, nofollow, noarchive"' in admin.data


def test_public_robots_disallows_indexing(client: FlaskClient) -> None:
    response = client.get("/robots.txt", base_url=ORIGIN)
    assert response.status_code == 200
    assert response.mimetype == "text/plain"
    assert response.data == b"User-agent: *\nDisallow: /\n"


def test_compiled_scanner_assets_are_local_and_wasm_has_safe_mime_type(client: FlaskClient) -> None:
    scanner = client.get("/static/scanner.js", base_url=ORIGIN)
    assert scanner.status_code == 200
    assert b"ITF14" in scanner.data
    assert b"/static/vendor/zxing_reader.wasm" in scanner.data
    wasm = client.get("/static/vendor/zxing_reader.wasm", base_url=ORIGIN)
    assert wasm.status_code == 200
    assert wasm.mimetype == "application/wasm"
    assert len(wasm.data) > 100_000


def test_pwa_static_assets_are_served_with_safe_scope_and_real_icons(client: FlaskClient) -> None:
    manifest = client.get("/static/manifest.webmanifest", base_url=ORIGIN)
    assert manifest.status_code == 200
    assert manifest.mimetype == "application/manifest+json"
    assert manifest.get_json()["display"] == "standalone"
    service_worker = client.get("/static/service-worker.js", base_url=ORIGIN)
    assert service_worker.status_code == 200
    assert service_worker.headers["Service-Worker-Allowed"] == "/"
    assert b"url.pathname.startsWith('/api/')" in service_worker.data
    for path in (
        "/static/favicon.svg",
        "/static/favicon.ico",
        "/static/icons/apple-touch-icon.png",
        "/static/icons/icon-192.png",
        "/static/icons/icon-512.png",
        "/static/icons/icon-maskable-512.png",
    ):
        response = client.get(path, base_url=ORIGIN)
        assert response.status_code == 200
        assert len(response.data) > 100


def test_wsgi_security_headers_are_applied(client: FlaskClient) -> None:
    response = client.get("/login", base_url=ORIGIN)
    assert response.headers["X-Content-Type-Options"] == "nosniff"
    assert response.headers["X-Robots-Tag"] == "noindex, nofollow, noarchive"
    assert response.headers["Permissions-Policy"] == "camera=(self)"
    assert "frame-ancestors 'none'" in response.headers["Content-Security-Policy"]
    assert response.headers["X-Request-Id"]
