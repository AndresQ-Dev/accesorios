from __future__ import annotations

import hashlib
import queue
import threading
from collections.abc import Callable

from flask import Flask
from flask.testing import FlaskClient

from app import auth
from app import db as database
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
    monkeypatch,
) -> None:  # type: ignore[no-untyped-def]
    logged: list[str] = []

    def capture_warning(message: str, *args: object, **_kwargs: object) -> None:
        logged.append(message % args)

    monkeypatch.setattr(client.application.logger, "warning", capture_warning)
    unauthenticated = client.post(
        "/api/v1/scan-debug",
        json={"event": "start", "details": {}},
        base_url=ORIGIN,
    )
    assert unauthenticated.status_code == 401

    login_app()
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
    assert "SCAN_DEBUG" in logged[0]
    assert "track-ended" in logged[0]
    assert "readyState" in logged[0]

    invalid = client.post(
        "/api/v1/scan-debug",
        json={"event": "x" * 65, "details": {}},
        base_url=ORIGIN,
    )
    assert invalid.status_code == 400


def test_successful_app_and_admin_authentication_never_accesses_sqlite(
    client: FlaskClient,
    passwords: dict[str, str],
    monkeypatch,
) -> None:  # type: ignore[no-untyped-def]
    def forbidden_connection():  # type: ignore[no-untyped-def]
        raise AssertionError("authentication must not access SQLite")

    monkeypatch.setattr(database, "read_connection", forbidden_connection)
    monkeypatch.setattr(database, "write_connection", forbidden_connection)
    monkeypatch.setattr(auth, "read_connection", forbidden_connection, raising=False)
    monkeypatch.setattr(auth, "write_connection", forbidden_connection, raising=False)

    app_response = client.post(
        "/api/v1/login",
        json={"password": passwords["app"]},
        headers={"Origin": ORIGIN},
        base_url=ORIGIN,
    )
    admin_response = client.post(
        "/api/v1/admin/login",
        json={"password": passwords["admin"]},
        headers={"Origin": ORIGIN},
        base_url=ORIGIN,
    )

    assert app_response.status_code == 200
    assert admin_response.status_code == 200
    assert client.get("/", base_url=ORIGIN).status_code == 200
    assert client.get("/admin", base_url=ORIGIN).status_code == 200


def test_invalid_app_and_admin_authentication_never_accesses_sqlite(
    client: FlaskClient,
    passwords: dict[str, str],
    monkeypatch,
) -> None:  # type: ignore[no-untyped-def]
    def forbidden_connection():  # type: ignore[no-untyped-def]
        raise AssertionError("authentication must not access SQLite")

    monkeypatch.setattr(database, "read_connection", forbidden_connection)
    monkeypatch.setattr(database, "write_connection", forbidden_connection)
    monkeypatch.setattr(auth, "read_connection", forbidden_connection, raising=False)
    monkeypatch.setattr(auth, "write_connection", forbidden_connection, raising=False)

    invalid_app = client.post(
        "/api/v1/login",
        json={"password": "wrong-app-password"},
        headers={"Origin": ORIGIN},
        base_url=ORIGIN,
    )
    valid_app = client.post(
        "/api/v1/login",
        json={"password": passwords["app"]},
        headers={"Origin": ORIGIN},
        base_url=ORIGIN,
    )
    invalid_admin = client.post(
        "/api/v1/admin/login",
        json={"password": "wrong-admin-password"},
        headers={"Origin": ORIGIN},
        base_url=ORIGIN,
    )

    assert invalid_app.status_code == 401
    assert invalid_app.get_json()["error"]["code"] == "INVALID_APP_PASSWORD"
    assert valid_app.status_code == 200
    assert invalid_admin.status_code == 401
    assert invalid_admin.get_json()["error"]["code"] == "INVALID_ADMIN_PASSWORD"


def test_signed_session_cookies_preserve_security_attributes(
    client: FlaskClient,
    passwords: dict[str, str],
) -> None:
    app_response = client.post(
        "/api/v1/login",
        json={"password": passwords["app"]},
        headers={"Origin": ORIGIN},
        base_url=ORIGIN,
    )
    admin_response = client.post(
        "/api/v1/admin/login",
        json={"password": passwords["admin"]},
        headers={"Origin": ORIGIN},
        base_url=ORIGIN,
    )

    for response, cookie_name in (
        (app_response, "app_session"),
        (admin_response, "admin_session"),
    ):
        assert response.status_code == 200
        cookie_header = response.headers["Set-Cookie"]
        assert cookie_header.startswith(f"{cookie_name}=")
        assert "HttpOnly" in cookie_header
        assert "Secure" in cookie_header
        assert "SameSite=Strict" in cookie_header
        assert "Path=/" in cookie_header
        token = client.get_cookie(cookie_name, domain="local.test").value
        assert passwords[f"{cookie_name.removesuffix('_session')}_hash"] not in token


def test_tampered_session_token_is_rejected(
    client: FlaskClient,
    login_app: Callable[[], str],
) -> None:
    login_app()
    token = client.get_cookie("app_session", domain="local.test").value
    tampered = ("A" if token[0] != "A" else "B") + token[1:]
    client.set_cookie("app_session", tampered, domain="local.test", secure=True)

    response = client.get("/api/v1/search?q=test", base_url=ORIGIN)

    assert response.status_code == 401
    assert response.get_json()["error"]["code"] == "UNAUTHENTICATED"


def test_session_expiry_is_enforced(
    app: Flask,
    client: FlaskClient,
    login_app: Callable[[], str],
) -> None:
    login_app()
    app.config["SESSION_SECONDS"] = -1
    assert client.get("/api/v1/search?q=test", base_url=ORIGIN).status_code == 401


def test_app_and_admin_tokens_are_not_interchangeable(
    client: FlaskClient,
    login_admin: Callable[[], str],
) -> None:
    login_admin()
    app_token = client.get_cookie("app_session", domain="local.test").value
    admin_token = client.get_cookie("admin_session", domain="local.test").value

    client.set_cookie("app_session", admin_token, domain="local.test", secure=True)
    assert client.get("/api/v1/search?q=test", base_url=ORIGIN).status_code == 401

    client.set_cookie("app_session", app_token, domain="local.test", secure=True)
    client.set_cookie("admin_session", app_token, domain="local.test", secure=True)
    assert client.get("/api/v1/admin/categories", base_url=ORIGIN).status_code == 401


def test_signed_token_payload_must_match_session_kind(
    app: Flask,
    client: FlaskClient,
    login_admin: Callable[[], str],
) -> None:
    login_admin()
    with app.app_context():
        wrong_kind = auth._session_serializer("admin").dumps(
            {"kind": "app", "csrf": "csrf", "session": "session"}
        )
    client.set_cookie("admin_session", wrong_kind, domain="local.test", secure=True)

    response = client.get("/api/v1/admin/categories", base_url=ORIGIN)

    assert response.status_code == 401
    assert response.get_json()["error"]["code"] == "UNAUTHENTICATED"


def test_password_hash_rotation_invalidates_each_session_kind(
    app: Flask,
    client: FlaskClient,
    login_admin: Callable[[], str],
) -> None:
    login_admin()
    original_app_hash = app.config["APP_PASSWORD_HASH"]
    app.config["APP_PASSWORD_HASH"] = auth.create_password_hash("rotated-app-password")
    assert client.get("/api/v1/search?q=test", base_url=ORIGIN).status_code == 401

    app.config["APP_PASSWORD_HASH"] = original_app_hash
    app.config["ADMIN_PASSWORD_HASH"] = auth.create_password_hash("rotated-admin-password")
    response = client.get("/api/v1/admin/categories", base_url=ORIGIN)
    assert response.status_code == 401
    assert response.get_json()["error"]["code"] == "UNAUTHENTICATED"


def test_admin_session_still_requires_application_session(
    client: FlaskClient,
    login_admin: Callable[[], str],
) -> None:
    login_admin()
    client.delete_cookie("app_session", domain="local.test")

    response = client.get("/api/v1/admin/categories", base_url=ORIGIN)

    assert response.status_code == 401
    assert response.get_json()["error"]["code"] == "UNAUTHENTICATED"


def test_origin_csrf_and_error_contracts(
    client: FlaskClient,
    login_admin: Callable[[], str],
) -> None:
    csrf = login_admin()
    missing_origin = client.post(
        "/api/v1/admin/categories",
        json={"name": "Cascos"},
        headers={"X-CSRF-Token": csrf},
        base_url=ORIGIN,
    )
    assert missing_origin.status_code == 403
    assert set(missing_origin.get_json()["error"]) == {"code", "message", "requestId"}
    wrong_csrf = client.post(
        "/api/v1/admin/categories",
        json={"name": "Cascos"},
        headers={"Origin": ORIGIN, "X-CSRF-Token": "wrong"},
        base_url=ORIGIN,
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
            "/api/v1/login",
            json={"password": "wrong"},
            headers={"Origin": ORIGIN},
            base_url=ORIGIN,
        )
        statuses.append((response.status_code, response.get_json()["error"]["code"]))
    assert statuses[:3] == [(401, "INVALID_APP_PASSWORD")] * 3
    assert statuses[3] == (429, "LOGIN_THROTTLED")


def test_login_throttling_is_separate_for_app_and_admin(
    app: Flask,
    client: FlaskClient,
    passwords: dict[str, str],
) -> None:
    app.config["LOGIN_MAX_ATTEMPTS"] = 1
    assert client.post(
        "/api/v1/login",
        json={"password": passwords["app"]},
        headers={"Origin": ORIGIN},
        base_url=ORIGIN,
    ).status_code == 200

    invalid_admin = client.post(
        "/api/v1/admin/login",
        json={"password": "wrong"},
        headers={"Origin": ORIGIN},
        base_url=ORIGIN,
    )
    blocked_admin = client.post(
        "/api/v1/admin/login",
        json={"password": "wrong"},
        headers={"Origin": ORIGIN},
        base_url=ORIGIN,
    )
    app_login = client.post(
        "/api/v1/login",
        json={"password": passwords["app"]},
        headers={"Origin": ORIGIN},
        base_url=ORIGIN,
    )

    assert invalid_admin.status_code == 401
    assert blocked_admin.status_code == 429
    assert app_login.status_code == 200


def test_login_authoritatively_rechecks_throttle_for_concurrent_attempts(
    app: Flask,
    monkeypatch,
) -> None:  # type: ignore[no-untyped-def]
    app.config["LOGIN_MAX_ATTEMPTS"] = 1
    verification_barrier = threading.Barrier(2)
    results: queue.SimpleQueue[tuple[int, str]] = queue.SimpleQueue()

    def synchronized_failure(_encoded_hash: str, _password: str) -> bool:
        verification_barrier.wait(timeout=5)
        return False

    def attempt() -> None:
        with app.test_client() as concurrent_client:
            response = concurrent_client.post(
                "/api/v1/login",
                json={"password": "wrong"},
                headers={"Origin": ORIGIN},
                base_url=ORIGIN,
            )
            results.put((response.status_code, response.get_json()["error"]["code"]))

    monkeypatch.setattr(auth, "verify_password", synchronized_failure)
    threads = [threading.Thread(target=attempt) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=10)

    assert all(not thread.is_alive() for thread in threads)
    assert sorted(results.get_nowait() for _ in threads) == [
        (401, "INVALID_APP_PASSWORD"),
        (429, "LOGIN_THROTTLED"),
    ]


def test_login_throttle_expires_attempts_and_bounds_client_buckets(
    app: Flask,
    client: FlaskClient,
    monkeypatch,
) -> None:  # type: ignore[no-untyped-def]
    app.config["LOGIN_MAX_ATTEMPTS"] = 1
    clock = [1000.0]
    monkeypatch.setattr(auth, "_throttle_now", lambda: clock[0])
    monkeypatch.setattr(auth, "_MAX_THROTTLE_CLIENTS", 2)

    addresses = ["192.0.2.1", "192.0.2.2", "192.0.2.3"]
    for address in addresses:
        response = client.post(
            "/api/v1/login",
            json={"password": "wrong"},
            headers={"Origin": ORIGIN},
            base_url=ORIGIN,
            environ_base={"REMOTE_ADDR": address},
        )
        assert response.status_code == 401

    assert len(auth._throttle_attempts) == 2
    stored_keys = {key for _kind, key in auth._throttle_attempts}
    assert hashlib.sha256(addresses[0].encode()).hexdigest() not in stored_keys
    assert addresses[1] not in repr(auth._throttle_attempts)

    clock[0] += app.config["LOGIN_WINDOW_SECONDS"] + 1
    response = client.post(
        "/api/v1/login",
        json={"password": "wrong"},
        headers={"Origin": ORIGIN},
        base_url=ORIGIN,
        environ_base={"REMOTE_ADDR": "192.0.2.4"},
    )
    assert response.status_code == 401
    assert len(auth._throttle_attempts) == 1


def test_login_timing_log_is_structured_and_excludes_sensitive_values(
    client: FlaskClient,
    passwords: dict[str, str],
    monkeypatch,
) -> None:  # type: ignore[no-untyped-def]
    logged: list[str] = []

    def capture_info(message: str, *args: object, **_kwargs: object) -> None:
        logged.append(message % args)

    monkeypatch.setattr(client.application.logger, "info", capture_info)

    response = client.post(
        "/api/v1/login",
        json={"password": passwords["app"]},
        headers={"Origin": ORIGIN},
        base_url=ORIGIN,
    )

    assert response.status_code == 200
    assert len(logged) == 1
    message = logged[0]
    assert "throttle_precheck_ms=" in message
    assert "password_verify_ms=" in message
    assert "throttle_finalize_ms=" in message
    assert "token_issue_ms=" in message
    assert "total_ms=" in message
    assert "write_ms=" not in message
    assert "session_kind=app result=success" in message
    assert f"request_id={response.headers['X-Request-Id']}" in message
    assert passwords["app"] not in message
    assert passwords["app_hash"] not in message
    assert response.get_json()["csrfToken"] not in message


def test_timeout_helper_is_served_as_a_static_esm_module(client: FlaskClient) -> None:
    response = client.get("/static/fetch-with-timeout.js", base_url=ORIGIN)

    assert response.status_code == 200
    assert response.mimetype in {"application/javascript", "text/javascript"}
    assert "fetchWithTimeout" in response.get_data(as_text=True)


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
            "/api/v1/login",
            json={"password": "wrong"},
            headers={"Origin": ORIGIN, "X-Forwarded-For": f"198.51.100.{index}, 127.0.0.1"},
            base_url=ORIGIN,
        )
        assert response.status_code == 401
    blocked = client.post(
        "/api/v1/login",
        json={"password": "wrong"},
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
        "/api/v1/admin/login",
        data="{}",
        headers={"Origin": ORIGIN, "Content-Type": "text/plain"},
        base_url=ORIGIN,
    )
    assert unsupported.status_code == 415
    malformed = client.post(
        "/api/v1/admin/login",
        data="{",
        headers={"Origin": ORIGIN, "Content-Type": "application/json"},
        base_url=ORIGIN,
    )
    assert malformed.status_code == 400
    too_large = client.post(
        "/api/v1/admin/login",
        data='{"password":"' + "x" * 5000 + '"}',
        headers={"Origin": ORIGIN, "Content-Type": "application/json"},
        base_url=ORIGIN,
    )
    assert too_large.status_code == 413


def test_domain_specific_errors_are_preserved_for_non_object_json(
    client: FlaskClient,
    login_admin: Callable[[], str],
) -> None:
    csrf = login_admin()
    secured = {"Origin": ORIGIN, "X-CSRF-Token": csrf}
    category = client.post(
        "/api/v1/admin/categories",
        json=[],
        headers=secured,
        base_url=ORIGIN,
    )
    assert category.status_code == 422
    assert category.get_json()["error"]["code"] == "INVALID_CATEGORY"
    product = client.patch(
        "/api/v1/admin/products/1",
        json=[],
        headers=secured,
        base_url=ORIGIN,
    )
    assert product.status_code == 422
    assert product.get_json()["error"]["code"] == "INVALID_EDIT"
    confirmation = client.post(
        "/api/v1/admin/import/confirm",
        json=[],
        headers=secured,
        base_url=ORIGIN,
    )
    assert confirmation.status_code == 422
    assert confirmation.get_json()["error"]["code"] == "INVALID_CONFIRMATION"
