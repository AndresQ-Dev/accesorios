from __future__ import annotations

import hashlib
import sqlite3
from pathlib import Path
from uuid import uuid4

from flask import current_app


def _digest(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def enforce_retention(directory: Path, *, max_count: int, max_bytes: int) -> None:
    backups = sorted(
        directory.glob("catalog-import-*.sqlite"),
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )
    retained_bytes = 0
    for index, path in enumerate(backups):
        size = path.stat().st_size
        keep = index < max_count and (retained_bytes + size <= max_bytes or index == 0)
        sidecar = path.with_suffix(path.suffix + ".sha256")
        if keep:
            retained_bytes += size
            continue
        path.unlink(missing_ok=True)
        sidecar.unlink(missing_ok=True)
    existing = {
        path.with_suffix(path.suffix + ".sha256")
        for path in directory.glob("catalog-import-*.sqlite")
    }
    for sidecar in directory.glob("catalog-import-*.sqlite.sha256"):
        if sidecar not in existing:
            sidecar.unlink(missing_ok=True)


def create_backup() -> Path:
    database_path = Path(current_app.config["DATABASE_PATH"])
    directory = Path(current_app.config["BACKUP_DIRECTORY"])
    directory.mkdir(parents=True, exist_ok=True)
    timestamp = __import__("time").time_ns()
    destination = directory / f"catalog-import-{timestamp}-{uuid4()}.sqlite"
    source = sqlite3.connect(database_path)
    target = sqlite3.connect(destination)
    try:
        source.backup(target)
    except Exception:
        destination.unlink(missing_ok=True)
        raise
    finally:
        target.close()
        source.close()
    sidecar = destination.with_suffix(destination.suffix + ".sha256")
    sidecar.write_text(f"{_digest(destination)}\n", encoding="ascii")
    if not verify_backup(destination):
        destination.unlink(missing_ok=True)
        sidecar.unlink(missing_ok=True)
        raise OSError("Backup checksum verification failed.")
    enforce_retention(
        directory,
        max_count=current_app.config["BACKUP_RETENTION_COUNT"],
        max_bytes=current_app.config["BACKUP_RETENTION_BYTES"],
    )
    return destination


def verify_backup(path: Path) -> bool:
    expected = path.with_suffix(path.suffix + ".sha256").read_text(encoding="ascii").strip()
    return bool(expected) and __import__("hmac").compare_digest(expected, _digest(path))
