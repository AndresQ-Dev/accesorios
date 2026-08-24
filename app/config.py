from __future__ import annotations

import os
from pathlib import Path
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parent.parent


def _path(name: str, default: Path) -> Path:
    return Path(os.environ.get(name, default)).expanduser().resolve()


def _boolean(name: str, default: bool) -> bool:
    value = os.environ.get(name)
    return default if value is None else value.lower() not in {"0", "false", "no"}


class Config:
    DATABASE_PATH = _path("DATABASE_URL", PROJECT_ROOT / "data" / "catalog.sqlite")
    BACKUP_DIRECTORY = _path("BACKUP_DIRECTORY", DATABASE_PATH.parent / "backups")
    APP_PASSWORD_HASH = os.environ.get("APP_PASSWORD_HASH", "")
    ADMIN_PASSWORD_HASH = os.environ.get("ADMIN_PASSWORD_HASH", "")
    TRUSTED_ORIGIN = os.environ.get("TRUSTED_ORIGIN", "").rstrip("/")
    SESSION_SECONDS = int(os.environ.get("SESSION_SECONDS", str(8 * 60 * 60)))
    PREVIEW_SECONDS = int(os.environ.get("PREVIEW_SECONDS", str(10 * 60)))
    LOGIN_WINDOW_SECONDS = int(os.environ.get("LOGIN_WINDOW_SECONDS", str(15 * 60)))
    LOGIN_MAX_ATTEMPTS = int(os.environ.get("LOGIN_MAX_ATTEMPTS", "5"))
    BACKUP_RETENTION_COUNT = int(os.environ.get("BACKUP_RETENTION_COUNT", "5"))
    BACKUP_RETENTION_BYTES = int(os.environ.get("BACKUP_RETENTION_BYTES", str(128 * 1024 * 1024)))
    JSON_BODY_LIMIT = 4096
    XLSX_UPLOAD_LIMIT = 2 * 1024 * 1024
    MAX_CONTENT_LENGTH = XLSX_UPLOAD_LIMIT + 64 * 1024
    COOKIE_SECURE = _boolean("COOKIE_SECURE", True)
    SESSION_COOKIE_SECURE = True
    SESSION_COOKIE_HTTPONLY = True
    SESSION_COOKIE_SAMESITE = "Strict"

    @classmethod
    def as_dict(cls) -> dict[str, Any]:
        return {
            name: getattr(cls, name)
            for name in dir(cls)
            if name.isupper() and not name.startswith("_")
        }
