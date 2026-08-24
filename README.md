# Run Accesorios locally

The Flask application is the primary runtime. It preserves the existing `/api/v1` contracts, serves the
Jinja user interface, and keeps the browser-only ZXing scanner as compiled static assets.

## Quick path

1. Create a Python 3.13 virtual environment and install the application.
2. Build the browser scanner assets.
3. configure two independent password hashes and a private SQLite path.
4. Apply and validate migrations.
5. Start Flask without importing an `app.run()` side effect.

```bash
python3.13 -m venv .venv
.venv/bin/pip install -e '.[dev]'
npm ci
npm run build:python-static

export DATABASE_URL="$PWD/data/catalog.sqlite"
export BACKUP_DIRECTORY="$PWD/data/backups"
export APP_PASSWORD_HASH="$(.venv/bin/flask --app wsgi:application password-hash 'local-app-password')"
export ADMIN_PASSWORD_HASH="$(.venv/bin/flask --app wsgi:application password-hash 'different-local-admin-password')"
export TRUSTED_ORIGIN="http://127.0.0.1:5000"
export COOKIE_SECURE=false

.venv/bin/flask --app wsgi:application db-upgrade
.venv/bin/flask --app wsgi:application db-validate
.venv/bin/flask --app wsgi:application run --host 127.0.0.1 --port 5000
```

Use local-only test passwords. Never commit passwords or generated hashes. `COOKIE_SECURE=false` is only for
the loopback development server; production defaults to secure cookies and must use HTTPS.

## Verification

```bash
.venv/bin/ruff check app tests_py
.venv/bin/mypy app
.venv/bin/pytest
.venv/bin/python scripts/smoke_wsgi.py
npm test -- --run
npm run typecheck
```

Create and verify an operator backup with:

```bash
.venv/bin/flask --app wsgi:application backup-create
```

The command uses SQLite's online backup API, writes a SHA-256 sidecar, and applies count/byte retention.
Database files, WAL files, previews, and backups remain under `data/`, never under `app/static/`.

## Deployment

Follow [`docs/pythonanywhere.md`](docs/pythonanywhere.md). The root `wsgi.py` exports `application` and does
not start a development server at import time.
