# Deploy Accesorios safely on PythonAnywhere

Use this runbook to deploy the Flask application without exposing state or creating a second SQLite writer. PythonAnywhere configuration and the deployed directory are user-managed; this project has historically had two clones. **Pull in the clone actually configured by the Web app's WSGI file and `/static/` mapping, then reload that Web app.**

## Before you deploy

1. Identify the configured project path in the PythonAnywhere Web tab (WSGI file and `/static/` mapping).
2. Confirm that path is the intended clone. Do not assume `/home/<user>/Precios_accesorios` is the live one.
3. Stop or remove every other SQLite writer: legacy server, cron importer, or second web process.
4. Keep the database, backups, XLSX files, and environment values outside `/static/` and outside Git.
5. Build scanner assets where Node 24.x is available before deploying them.

## Runtime configuration

The application requires Python `>=3.13,<3.14`. Select the matching Python 3.13 virtualenv in the Web tab. Install the project from the configured checkout:

```bash
python3.13 -m venv /home/<user>/.virtualenvs/precios-accesorios
source /home/<user>/.virtualenvs/precios-accesorios/bin/activate
pip install -e '.[dev]'
```

Configure only values the application reads, using the WSGI file or another private PythonAnywhere mechanism:

```python
import os

os.environ["DATABASE_URL"] = "/home/<user>/private-data/catalog.sqlite"
os.environ["BACKUP_DIRECTORY"] = "/home/<user>/private-data/backups"
os.environ["APP_PASSWORD_HASH"] = "<application-password-hash>"
os.environ["ADMIN_PASSWORD_HASH"] = "<different-admin-password-hash>"
os.environ["TRUSTED_ORIGIN"] = "https://<user>.pythonanywhere.com"
os.environ["COOKIE_SECURE"] = "true"
```

Optional operational values are `SESSION_SECONDS`, `PREVIEW_SECONDS`, `LOGIN_WINDOW_SECONDS`, `LOGIN_MAX_ATTEMPTS`, `BACKUP_RETENTION_COUNT`, and `BACKUP_RETENTION_BYTES`. Do **not** configure `FLASK_SECRET_KEY`: session signing keys are derived privately from the existing password hashes, and this application does not read Flask's secret-key setting.

Generate password hashes privately:

```bash
flask --app wsgi:application password-hash '<password-entered-interactively-or-from-a-secure-source>'
```

The application and administrator passwords are independent. Never commit plaintext credentials, real hashes, `.env` files, SQLite files, WAL files, backups, or XLSX files.

## WSGI and static mapping

The WSGI file should add the configured checkout to `sys.path` and import the supplied WSGI application without calling `app.run()`:

```python
import sys

project = "/home/<user>/<configured-clone>"
if project not in sys.path:
    sys.path.insert(0, project)

from wsgi import application
```

Map `/static/` only to the corresponding static directory in that same checkout:

| URL | Directory |
|---|---|
| `/static/` | `/home/<user>/<configured-clone>/app/static/` |

Never map the project root, `data/`, private environment files, backups, or spreadsheet directories as static content.

## Safe deploy workflow

Run these commands in the exact configured clone, not merely the newest clone in the home directory:

```bash
cd /home/<user>/<configured-clone>
git pull --ff-only
source /home/<user>/.virtualenvs/precios-accesorios/bin/activate
pip install -e '.[dev]'
flask --app wsgi:application backup-create
flask --app wsgi:application db-upgrade
flask --app wsgi:application db-validate
```

For the first deployment that converts an existing WAL database, use a quiet maintenance window. Create the verified backup first, then stop the Web app long enough to retire every old pooled SQLite connection before running `db-upgrade` and `db-validate` from one console. Re-enable/reload the Web app only after both commands succeed. If the journal transition reports a lock or a mode other than `delete`, leave the database and its sidecars untouched, confirm that no old web worker, task, console, or importer still has the database open, and run the command again only after the database is uncontended.

Build and deploy scanner assets with the matching source revision. If Node is available on the deployment host:

```bash
npm ci
npm run build:python-static
```

Otherwise build them in a controlled Node 24.x environment and ensure the deployed checkout contains the resulting `app/static/scanner.js` and `app/static/vendor/zxing_reader.wasm` from the same revision. Then reload the Web app from the PythonAnywhere Web tab.

`git pull --ff-only` intentionally refuses a divergent deploy checkout. Resolve the deployment state before continuing; do not overwrite local database, backup, secret, or generated production state with Git commands.

## Database safety

`DATABASE_URL` and `BACKUP_DIRECTORY` are production state. Before migration, create the verified backup shown above. SQLite runs in verified rollback journal mode (`DELETE`), not WAL, because PythonAnywhere's filesystem is distributed and SQLite does not support WAL over network filesystems. `busy_timeout` is set before the mode transition. The first uncontended `db-upgrade`, `db-validate`, or application connection converts an existing persistent WAL database through SQLite's own `PRAGMA journal_mode=DELETE` operation and fails clearly if SQLite reports another mode. Never delete `-wal` or `-shm` files manually.

The application is the sole expected writer. Do not run a second Flask instance, legacy Node server, cron import, or manual writer against the configured database. XLSX confirmation also creates a backup before its atomic catalog update.

## Stateless authentication on the free plan

Application and administrator sessions are separate timestamped signed cookies. Login, session validation, invalid-password handling, and CSRF lookup perform no SQLite operations. Cookie names, `HttpOnly`, `Secure`, `SameSite=Strict`, `/` path scope, session expiry, the two-level app/admin barrier, trusted-origin checks, and CSRF validation remain unchanged. Rotating `APP_PASSWORD_HASH` invalidates app sessions; rotating `ADMIN_PASSWORD_HASH` invalidates admin sessions.

Login throttling is per process, keyed by login kind and a SHA-256 hash of the client address. It has a lock, an authoritative post-password-verification recheck, expiry pruning, and a bounded client map. The free PythonAnywhere plan runs one web worker, so no paid database is needed to make login independent of distributed-filesystem SQLite latency. Reloading or restarting that worker resets throttle history; treat that as the explicit tradeoff and continue monitoring repeated login failures at the platform boundary.

## Live verification after reload

Replace `<origin>` with the configured HTTPS origin. Verify the live endpoints and static bytes, not just the files in the clone:

```bash
curl -fsSI https://<origin>/static/vendor/zxing_reader.wasm
curl -fsS https://<origin>/static/service-worker.js
curl -fsSI https://<origin>/static/service-worker.js
curl -fsSI https://<origin>/static/scanner.js
```

Confirm all of the following:

- The WASM request succeeds and has `Content-Type: application/wasm`.
- The service-worker body contains `CACHE_VERSION='precios-static-v3'` for the current release and the response has `Service-Worker-Allowed: /`.
- The scanner bundle request succeeds and serves the current build.
- HTTPS `/login` works; `/` redirects without an application session.
- `/admin` requires the application session first and then the independent admin login.
- Existing sessions survive a normal worker reload when password hashes are unchanged; changing either hash invalidates only that session kind.
- A manual search works; scanner camera access works on HTTPS; an admin product search/editor action and an isolated XLSX preview can be completed safely.

PythonAnywhere can serve `/static/` directly, which bypasses Flask-provided headers. If direct static mapping omits `Service-Worker-Allowed: /`, configure the static serving path to preserve that header; otherwise the worker cannot use the required `/` scope.

## Browser-cache troubleshooting

The PWA caches only the closed static asset list. HTML, navigations, and API responses always use the network. When an asset is added or changed in the precache list, the release must also bump `CACHE_VERSION` and deploy the new service worker.

If a browser keeps an old scanner or service worker:

1. Confirm the live service-worker body and cache version with the commands above.
2. In browser DevTools, inspect Application → Service Workers and verify the active worker's script URL and version.
3. Reload after the new worker activates; if necessary unregister the old worker and clear only this site's storage.
4. Re-check `/static/scanner.js` and the WASM response. Do not solve cache issues by broadening static mappings or exposing private directories.

## Release checklist and rollback

- [ ] The configured WSGI/static clone, not an unused clone, received the pull.
- [ ] Python 3.13 virtualenv and configuration values are in use; no fictitious `FLASK_SECRET_KEY` was added.
- [ ] A verified backup exists outside static paths.
- [ ] `db-upgrade` and `db-validate` succeeded.
- [ ] The Web app was reloaded after the pull/build/configuration change.
- [ ] WASM, service-worker body/version/header, and scanner bundle were checked live.
- [ ] Authentication, search, admin barrier, CSRF rejection, and an isolated preview were verified over HTTPS.

To roll back, stop or reload the Web app only after selecting a verified backup. Restore it to a new private path, point `DATABASE_URL` to that path, run `db-validate`, and reload with exactly one writer. Do not restore a database under `/static/`, replace a live SQLite file piecemeal, or delete journal sidecars manually.
