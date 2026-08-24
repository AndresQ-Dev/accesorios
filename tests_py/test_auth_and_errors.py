from __future__ import annotations

import hashlib
import logging
import sqlite3
from collections.abc import Callable
from pathlib import Path

from flask.testing import FlaskClient

from tests_py.conftest import ORIGIN


def test_general_and_independent_admin_barriers(
    client: FlaskClient,
    login_app: Callable[[], str],
) -> None:
    root = client.get("/", base_url=ORIGIN)
    assert root.status_code == 302
    assert root.headers["Location"].startswith("/login")
    protected = client.get("/api/v1/search?q=test", base_url=ORIGIN)
    assert protected.status_code == 401
    assert protected.get_json()["error"]["requestId"]

    login_app()
    assert client.get("/", base_url=ORIGIN).status_code == 200
    assert client.get("/admin", base_url=ORIGIN).status_code == 200
    admin_api = client.get("/api/v1/admin/categories", base_url=ORIGIN)
    assert admin_api.status_code == 401


def test_scan_debug_requires_app_auth_validates_shape_and_logs(
    client: FlaskClient,
    login_app: Callable[[], str],
    caplog,
) -> None:  # type: ignore[no-untyped-def]
    unauthenticated = client.post(
        "/api/v1/scan-debug",
        json={"event": "start", "details": {}},
        base_url=ORIGIN,
    )
    assert unauthenticated.status_code == 401

    login_app()
    caplog.set_level(logging.INFO)
    accepted = client.post(
        "/api/v1/scan-debug",
        json={
            "at": "2026-08-23T00:00:00.000Z",
            "event": "track-ended",
            "details": {
                "video": {"readyState": 2, "paused": False, "currentTime": 1.2, "width": 640, "height": 480},
                "track": {"readyState": "ended", "muted": False, "enabled": True},
                "idleStreak": 4,
                "streamRestarts": 1,
                "candidate": {"length": 14, "digits": True, "prefix": "04…", "suffix": "…33"},
            },
        },
        base_url=ORIGIN,
    )
    assert accepted.status_code == 204
    assert accepted.get_data() == b""
    assert "SCAN_DEBUG" in caplog.text
    assert "track-ended" in caplog.text
    assert "readyState" in caplog.text

    invalid = client.post(
        "/api/v1/scan-debug",
        json={"event": "x" * 65, "details": {}},
        base_url=ORIGIN,
    )
    assert invalid.status_code == 400


def test_sessions_store_only_token_hashes_and_secure_cookies(
    client: FlaskClient,
    database_path: Path,
    passwords: dict[str, str],
) -> None:
    response = client.post(
        "/api/v1/login",
        json={"password": passwords["app"]},
        headers={"Origin": ORIGIN},
        base_url=ORIGIN,
    )
    assert response.status_code == 200
    cookie_header = response.headers["Set-Cookie"]
    assert "HttpOnly" in cookie_header
    assert "Secure" in cookie_header
    assert "SameSite=Strict" in cookie_header
    token = client.get_cookie("app_session", domain="local.test").value
    connection = sqlite3.connect(database_path)
    stored = connection.execute("SELECT token_hash FROM app_sessions").fetchone()[0]
    connection.close()
    assert stored == hashlib.sha256(token.encode()).hexdigest()
    assert token not in stored


def test_session_expiry_is_enforced(
    client: FlaskClient,
    database_path: Path,
    login_app: Callable[[], str],
) -> None:
    login_app()
    connection = sqlite3.connect(database_path)
    connection.execute("UPDATE app_sessions SET expires_at = ?", ("2000-01-01T00:00:00.000Z",))
    connection.commit()
    connection.close()
    assert client.get("/api/v1/search?q=test", base_url=ORIGIN).status_code == 401


def test_origin_csrf_and_error_contracts(
    client: FlaskClient,
    login_admin: Callable[[], str],
) -> None:
    csrf = login_admin()
    missing_origin = client.post(
        "/api/v1/admin/categories", json={"name": "Cascos"},
        headers={"X-CSRF-Token": csrf}, base_url=ORIGIN,
    )
    assert missing_origin.status_code == 403
    assert set(missing_origin.get_json()["error"]) == {"code", "message", "requestId"}
    wrong_csrf = client.post(
        "/api/v1/admin/categories", json={"name": "Cascos"},
        headers={"Origin": ORIGIN, "X-CSRF-Token": "wrong"}, base_url=ORIGIN,
    )
    assert wrong_csrf.status_code == 403
    invalid_query = client.get("/api/v1/search?q=%20", base_url=ORIGIN)
    assert invalid_query.status_code == 400
    assert invalid_query.get_json()["error"]["fields"] == {"q": "Required"}


def test_bounded_login_throttling_does_not_change_invalid_credential_response(
    client: FlaskClient,
) -> None:
    statuses = []
    for _ in range(4):
        response = client.post(
            "/api/v1/login", json={"password": "wrong"},
            headers={"Origin": ORIGIN}, base_url=ORIGIN,
        )
        statuses.append((response.status_code, response.get_json()["error"]["code"]))
    assert statuses[:3] == [(401, "INVALID_APP_PASSWORD")] * 3
    assert statuses[3] == (429, "LOGIN_THROTTLED")


def test_admin_login_reports_invalid_admin_password_without_session_expiry_confusion(
    client: FlaskClient,
    login_app: Callable[[], str],
) -> None:
    login_app()
    response = client.post(
        "/api/v1/admin/login",
        json={"password": "wrong-admin-password"},
        headers={"Origin": ORIGIN},
        base_url=ORIGIN,
    )
    assert response.status_code == 401
    assert response.get_json()["error"]["code"] == "INVALID_ADMIN_PASSWORD"


def test_login_throttling_ignores_untrusted_forwarded_addresses(client: FlaskClient) -> None:
    for index in range(3):
        response = client.post(
            "/api/v1/login", json={"password": "wrong"},
            headers={"Origin": ORIGIN, "X-Forwarded-For": f"198.51.100.{index}, 127.0.0.1"},
            base_url=ORIGIN,
        )
        assert response.status_code == 401
    blocked = client.post(
        "/api/v1/login", json={"password": "wrong"},
        headers={"Origin": ORIGIN, "X-Forwarded-For": "203.0.113.10, 127.0.0.1"},
        base_url=ORIGIN,
    )
    assert blocked.status_code == 429


def test_request_media_type_size_and_json_errors(
    client: FlaskClient,
    login_app: Callable[[], str],
) -> None:
    login_app()
    unsupported = client.post(
        "/api/v1/admin/login", data="{}", headers={"Origin": ORIGIN, "Content-Type": "text/plain"},
        base_url=ORIGIN,
    )
    assert unsupported.status_code == 415
    malformed = client.post(
        "/api/v1/admin/login", data="{", headers={"Origin": ORIGIN, "Content-Type": "application/json"},
        base_url=ORIGIN,
    )
    assert malformed.status_code == 400
    too_large = client.post(
        "/api/v1/admin/login", data='{"password":"' + "x" * 5000 + '"}',
        headers={"Origin": ORIGIN, "Content-Type": "application/json"}, base_url=ORIGIN,
    )
    assert too_large.status_code == 413


def test_domain_specific_errors_are_preserved_for_non_object_json(
    client: FlaskClient,
    login_admin: Callable[[], str],
) -> None:
    csrf = login_admin()
    secured = {"Origin": ORIGIN, "X-CSRF-Token": csrf}
    category = client.post(
        "/api/v1/admin/categories", json=[], headers=secured, base_url=ORIGIN,
    )
    assert category.status_code == 422
    assert category.get_json()["error"]["code"] == "INVALID_CATEGORY"
    product = client.patch(
        "/api/v1/admin/products/1", json=[], headers=secured, base_url=ORIGIN,
    )
    assert product.status_code == 422
    assert product.get_json()["error"]["code"] == "INVALID_EDIT"
    confirmation = client.post(
        "/api/v1/admin/import/confirm", json=[], headers=secured, base_url=ORIGIN,
    )
    assert confirmation.status_code == 422
    assert confirmation.get_json()["error"]["code"] == "INVALID_CONFIRMATION"
