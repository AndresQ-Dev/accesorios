# Accesorios

Private price lookup and catalog administration for accessories. Flask serves the protected Jinja UI and the versioned `/api/v1` API; SQLite stores catalog and operational state; the browser scanner is built from TypeScript into Flask static assets.

## Fast start

**Requirements:** Python `>=3.13,<3.14` and Node `24.x`.

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

Use local-only passwords and hashes. `COOKIE_SECURE=false` is only for local HTTP; production requires HTTPS and secure cookies.

## What operators can do

| Area | Everyday flow |
|---|---|
| Price lookup | Sign in at `/login`, then search from `/` by code, barcode, article, brand, or category. A manual empty result says `No hay resultados relevantes.` |
| Scanner | Open the camera from `/`. It accepts plausible 13/14-digit scans and looks up the code without uploading camera frames. A final miss says `Código no encontrado.` |
| Admin editor | Open `/admin` after the application login, then complete the separate admin login. Search products, optionally filter records with a missing or zero price, load one record, and edit code, barcode, article, or price. A blank price is stored as no price and shown as `Sin precio`. |
| XLSX import | In the same admin area, upload an XLSX to create a persistent, expiring preview, then confirm it. Confirmation verifies the preview hash and catalog version, creates a SQLite backup, and applies changes atomically. |

Admin editing and XLSX import are separate capabilities; importing is not the only administrative workflow.

## Verify locally

```bash
.venv/bin/ruff check app tests_py
.venv/bin/mypy app
.venv/bin/pytest
.venv/bin/python scripts/smoke_wsgi.py
npm test -- --run
npm run typecheck
```

To make and verify an operator backup:

```bash
.venv/bin/flask --app wsgi:application backup-create
```

## Documentation

- [Technical architecture](docs/technical-architecture.md): route contracts, security boundaries, scanner behavior, data lifecycle, PWA, and test map.
- [PythonAnywhere runbook](docs/pythonanywhere.md): safe pull, reload, static/PWA verification, and rollback guidance.

## Guardrails

- Never commit SQLite databases, WAL files, backups, XLSX files, previews, `.env` files, password hashes, or credentials. `data/` and backup paths are local/production state.
- Keep `data/` and secrets outside `/static/`. Flask must be the only SQLite writer.
- When scanner source or its dependency changes, run `npm run build:python-static`; generated static assets must be deployed with the change.
- The service worker precaches only a closed static list. When that list changes, bump its cache version and deploy the updated service worker.

For deployment, follow [the PythonAnywhere runbook](docs/pythonanywhere.md). The root `wsgi.py` exports `application` and does not start a development server when imported.
