from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import threading
from collections import OrderedDict, deque
from time import monotonic, perf_counter
from typing import Any, Literal

from flask import Response, current_app, request
from itsdangerous import BadData, URLSafeTimedSerializer

from app.errors import ApiError, request_id

MIN_PBKDF2_ITERATIONS = 600_000
PASSWORD_PREFIX = "pbkdf2-sha256"
SessionKind = Literal["app", "admin"]
ThrottleKey = tuple[SessionKind, str]

_MAX_THROTTLE_CLIENTS = 4096
_throttle_attempts: OrderedDict[ThrottleKey, deque[float]] = OrderedDict()
_throttle_lock = threading.Lock()


def _b64url_encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _b64url_decode(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def create_password_hash(password: str, *, iterations: int = MIN_PBKDF2_ITERATIONS) -> str:
    if iterations < MIN_PBKDF2_ITERATIONS:
        raise ValueError(f"iterations must be at least {MIN_PBKDF2_ITERATIONS}")
    salt = secrets.token_bytes(16)
    derived = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, iterations, dklen=32)
    return f"{PASSWORD_PREFIX}${iterations}${_b64url_encode(salt)}${_b64url_encode(derived)}"


def verify_password(encoded_hash: str, password: str) -> bool:
    try:
        prefix, iteration_text, salt_text, expected_text = encoded_hash.split("$")
        iterations = int(iteration_text)
        if prefix != PASSWORD_PREFIX or iterations < MIN_PBKDF2_ITERATIONS:
            return False
        salt = _b64url_decode(salt_text)
        expected = _b64url_decode(expected_text)
        if not salt or not expected:
            return False
        derived = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, iterations, dklen=len(expected))
        return hmac.compare_digest(derived, expected)
    except (ValueError, TypeError):
        return False


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _same_origin() -> None:
    origin = request.headers.get("Origin", "").rstrip("/")
    expected = current_app.config["TRUSTED_ORIGIN"] or request.host_url.rstrip("/")
    if not origin or not hmac.compare_digest(origin, expected):
        raise ApiError(403, "INVALID_ORIGIN", "Request origin is not allowed.")


def read_json_payload() -> Any:
    content_type = request.headers.get("Content-Type", "")
    if "application/json" not in content_type:
        raise ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "Requests must use application/json.")
    declared = request.content_length or 0
    if declared > current_app.config["JSON_BODY_LIMIT"]:
        raise ApiError(413, "REQUEST_TOO_LARGE", "Request body exceeds 4096 bytes.")
    raw = request.get_data(cache=True)
    if len(raw) > current_app.config["JSON_BODY_LIMIT"]:
        raise ApiError(413, "REQUEST_TOO_LARGE", "Request body exceeds 4096 bytes.")
    try:
        payload = json.loads(raw)
    except (json.JSONDecodeError, UnicodeDecodeError):
        raise ApiError(400, "INVALID_JSON", "Request body must be valid JSON.") from None
    return payload


def _client_key() -> str:
    address = request.remote_addr or "unknown"
    return hashlib.sha256(address.encode()).hexdigest()


def _throttle_now() -> float:
    return monotonic()


def _prune_throttle(now: float, window_seconds: int) -> None:
    cutoff = now - window_seconds
    for throttle_key, attempts in list(_throttle_attempts.items()):
        while attempts and attempts[0] <= cutoff:
            attempts.popleft()
        if not attempts:
            del _throttle_attempts[throttle_key]
    while len(_throttle_attempts) > _MAX_THROTTLE_CLIENTS:
        _throttle_attempts.popitem(last=False)


def _raise_throttled() -> None:
    raise ApiError(429, "LOGIN_THROTTLED", "Login is temporarily unavailable. Try again later.")


def _precheck_throttle(kind: SessionKind, key: str) -> None:
    now = _throttle_now()
    with _throttle_lock:
        _prune_throttle(now, current_app.config["LOGIN_WINDOW_SECONDS"])
        attempts = _throttle_attempts.get((kind, key))
        if attempts is not None and len(attempts) >= current_app.config["LOGIN_MAX_ATTEMPTS"]:
            _raise_throttled()


def _finalize_throttle(kind: SessionKind, key: str, authenticated: bool) -> None:
    now = _throttle_now()
    throttle_key = (kind, key)
    with _throttle_lock:
        _prune_throttle(now, current_app.config["LOGIN_WINDOW_SECONDS"])
        attempts = _throttle_attempts.get(throttle_key)
        if attempts is not None and len(attempts) >= current_app.config["LOGIN_MAX_ATTEMPTS"]:
            _raise_throttled()
        if authenticated:
            _throttle_attempts.pop(throttle_key, None)
            return
        if attempts is None:
            while len(_throttle_attempts) >= _MAX_THROTTLE_CLIENTS:
                _throttle_attempts.popitem(last=False)
            attempts = deque()
            _throttle_attempts[throttle_key] = attempts
        attempts.append(now)
        _throttle_attempts.move_to_end(throttle_key)


def _reset_login_throttle() -> None:
    with _throttle_lock:
        _throttle_attempts.clear()


def _session_serializer(kind: SessionKind) -> URLSafeTimedSerializer:
    config_name = "APP_PASSWORD_HASH" if kind == "app" else "ADMIN_PASSWORD_HASH"
    credential_hash = current_app.config[config_name]
    signing_key = hashlib.sha256(
        b"precios-session-signing-v1\0" + kind.encode() + b"\0" + credential_hash.encode()
    ).digest()
    return URLSafeTimedSerializer(
        signing_key,
        salt=f"precios-{kind}-session-v1",
        signer_kwargs={"digest_method": hashlib.sha256},
    )


def _issue_session(kind: SessionKind) -> tuple[str, str]:
    csrf_token = secrets.token_urlsafe(32)
    token = _session_serializer(kind).dumps(
        {"kind": kind, "csrf": csrf_token, "session": secrets.token_urlsafe(32)}
    )
    return token, csrf_token


def login(kind: SessionKind) -> tuple[dict[str, str], str, int]:
    _same_origin()
    payload = read_json_payload()
    password = payload.get("password") if isinstance(payload, dict) else None
    if not isinstance(password, str):
        raise ApiError(400, "INVALID_LOGIN", "A password is required.", {"password": "Required"})

    started_at = perf_counter()
    precheck_seconds = 0.0
    verification_seconds = 0.0
    finalize_seconds = 0.0
    token_seconds = 0.0
    result = "failed"
    key = _client_key()
    config_name = "APP_PASSWORD_HASH" if kind == "app" else "ADMIN_PASSWORD_HASH"
    token = ""
    csrf_token = ""

    try:
        phase_started_at = perf_counter()
        try:
            _precheck_throttle(kind, key)
        finally:
            precheck_seconds = perf_counter() - phase_started_at

        phase_started_at = perf_counter()
        try:
            authenticated = verify_password(current_app.config[config_name], password)
        finally:
            verification_seconds = perf_counter() - phase_started_at

        phase_started_at = perf_counter()
        try:
            _finalize_throttle(kind, key, authenticated)
        finally:
            finalize_seconds = perf_counter() - phase_started_at

        if not authenticated:
            result = "invalid-password"
            code = "INVALID_APP_PASSWORD" if kind == "app" else "INVALID_ADMIN_PASSWORD"
            message = "Invalid credentials." if kind == "app" else "Invalid administrator credentials."
            raise ApiError(401, code, message)

        phase_started_at = perf_counter()
        try:
            token, csrf_token = _issue_session(kind)
        finally:
            token_seconds = perf_counter() - phase_started_at

        result = "success"
        return {"csrfToken": csrf_token}, token, current_app.config["SESSION_SECONDS"]
    except ApiError as error:
        if error.code == "LOGIN_THROTTLED":
            result = "throttled"
        raise
    finally:
        current_app.logger.info(
            "LOGIN_TIMING throttle_precheck_ms=%.3f password_verify_ms=%.3f "
            "throttle_finalize_ms=%.3f token_issue_ms=%.3f total_ms=%.3f "
            "session_kind=%s result=%s request_id=%s",
            precheck_seconds * 1000,
            verification_seconds * 1000,
            finalize_seconds * 1000,
            token_seconds * 1000,
            (perf_counter() - started_at) * 1000,
            kind,
            result,
            request_id(),
        )


def set_session_cookie(response: Response, kind: SessionKind, token: str, max_age: int) -> None:
    name = "app_session" if kind == "app" else "admin_session"
    response.set_cookie(
        name,
        token,
        max_age=max_age,
        secure=current_app.config["COOKIE_SECURE"],
        httponly=True,
        samesite="Strict",
        path="/",
    )


def _session(kind: SessionKind) -> dict[str, str]:
    name = "app_session" if kind == "app" else "admin_session"
    token = request.cookies.get(name)
    if not token:
        label = "Application" if kind == "app" else "Administrator"
        raise ApiError(401, "UNAUTHENTICATED", f"{label} authentication is required.")
    try:
        payload = _session_serializer(kind).loads(
            token,
            max_age=current_app.config["SESSION_SECONDS"],
        )
    except BadData:
        label = "Application" if kind == "app" else "Administrator"
        raise ApiError(401, "UNAUTHENTICATED", f"{label} authentication is required.") from None
    if (
        not isinstance(payload, dict)
        or set(payload) != {"kind", "csrf", "session"}
        or payload.get("kind") != kind
        or not isinstance(payload.get("csrf"), str)
        or not isinstance(payload.get("session"), str)
    ):
        label = "Application" if kind == "app" else "Administrator"
        raise ApiError(401, "UNAUTHENTICATED", f"{label} authentication is required.")
    return {"tokenHash": token_hash(token), "csrfToken": payload["csrf"]}


def require_app(*, csrf: bool = False) -> str:
    session = _session("app")
    if csrf:
        _validate_request_security(session["csrfToken"])
    return session["tokenHash"]


def require_admin_session(*, csrf: bool = True) -> dict[str, str]:
    require_app(csrf=False)
    session = _session("admin")
    if csrf:
        _validate_request_security(session["csrfToken"])
    return session


def require_admin(*, csrf: bool = True) -> str:
    session = require_admin_session(csrf=csrf)
    return session["tokenHash"]


def _validate_request_security(expected_csrf: str) -> None:
    _same_origin()
    supplied = request.headers.get("X-CSRF-Token", "")
    if not supplied or not hmac.compare_digest(supplied, expected_csrf):
        raise ApiError(403, "INVALID_CSRF", "CSRF token validation failed.")
