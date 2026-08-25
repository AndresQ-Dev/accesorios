# Deploy the Flask application on PythonAnywhere

This procedure makes the Python application the only database writer. Complete every validation step before
switching traffic; do not run any legacy writer against the same SQLite database afterward.

## Quick path

1. Push the project code to GitHub, then clone it into your PythonAnywhere home directory.
2. Create a Python 3.13 virtual environment and install `requirements.txt`.
3. Build static scanner assets before upload, or build them where Node is available.
4. Upload the prepared SQLite database to `data/catalog.sqlite`; product spreadsheets are intentionally not committed.
5. Configure the WSGI file, environment secrets, and `/static/` mapping.
6. Run Alembic/schema validation, reload the web app, and verify HTTPS login, search, admin login, and an isolated import.

## Files and secrets

Keep these paths outside `app/static/`:

| Purpose | Example path |
|---|---|
| SQLite database | `/home/<user>/Precios_accesorios/data/catalog.sqlite` |
| Import backups | `/home/<user>/Precios_accesorios/data/backups` |
| Virtual environment | `/home/<user>/.virtualenvs/precios-accesorios` |

Set these values in the PythonAnywhere WSGI configuration or another private environment mechanism:

```python
import os

os.environ["DATABASE_URL"] = "/home/<user>/Precios_accesorios/data/catalog.sqlite"
os.environ["BACKUP_DIRECTORY"] = "/home/<user>/Precios_accesorios/data/backups"
os.environ["APP_PASSWORD_HASH"] = "<pbkdf2-sha256 hash>"
os.environ["ADMIN_PASSWORD_HASH"] = "<different pbkdf2-sha256 hash>"
os.environ["FLASK_SECRET_KEY"] = "<long random secret>"
os.environ["TRUSTED_ORIGIN"] = "https://<user>.pythonanywhere.com"
```

Generate each hash offline with `flask --app wsgi:application password-hash`. Use distinct long passwords;
never place plaintext credentials in the repository.

For this deployment, a local ignored helper file can hold the generated values before you paste them into
PythonAnywhere: `secrets/pythonanywhere.env`. Replace `YOUR_PYTHONANYWHERE_USERNAME` with the real account name
before using the paths and origin. Do not upload this file to GitHub.

The application password controls `/login`. The administrator password controls `/admin`, where missing product
prices can be filled in after deployment.

## Adopt and validate the existing database

Stop every previous writer first. Upload the prepared database copy to:

```text
/home/<user>/Precios_accesorios/data/catalog.sqlite
```

When preparing that file from a live local SQLite runtime, do not copy only the `.sqlite` file while WAL is active.
Use SQLite's online backup API or stop the writer and include all WAL state; otherwise recent imports can be absent
from the uploaded database.

Then create an operator backup before migration:

```bash
cd /home/<user>/Precios_accesorios
workon precios-accesorios
flask --app wsgi:application backup-create
flask --app wsgi:application db-upgrade
flask --app wsgi:application db-validate
```

The Alembic baseline uses `CREATE ... IF NOT EXISTS`, preserves existing IDs and timestamps, initializes
`catalog_metadata` only when absent, and ensures the verified ITF alias exists. The additive migrations create
runtime session/import tables and allow products with pending prices.

## WSGI entrypoint

Point the PythonAnywhere WSGI file at the project; do not call `app.run()`:

```python
import sys

project = "/home/<user>/Precios_accesorios"
if project not in sys.path:
    sys.path.insert(0, project)

from wsgi import application
```

Select the matching Python 3.13 virtual environment in the Web tab.

## Static mapping and WASM

Add this static mapping in the Web tab:

| URL | Directory |
|---|---|
| `/static/` | `/home/<user>/Precios_accesorios/app/static/` |

Before upload, run `npm ci && npm run build:python-static`. Confirm these generated files exist:

- `app/static/scanner.js`
- `app/static/vendor/zxing_reader.wasm`

After reload, verify HTTPS and MIME behavior:

```bash
curl -I https://<user>.pythonanywhere.com/static/vendor/zxing_reader.wasm
```

The response must be successful and use `Content-Type: application/wasm`. If the static service reports a
different MIME type, open a PythonAnywhere support request rather than serving the database or broad project
directory through Flask.

## Storage and operations

Defaults retain at most five import backups and 128 MiB, whichever limit is reached first. A single newest
backup is always retained. Tune `BACKUP_RETENTION_COUNT` and `BACKUP_RETENTION_BYTES` downward if the account
approaches its storage quota. Each backup has a `.sha256` sidecar and is produced through
`sqlite3.Connection.backup` while WAL remains enabled.

SQLite connections enable foreign keys, WAL, and a five-second busy timeout. Mutations use `BEGIN IMMEDIATE`.
Do not run a second application writer, cron importer, or legacy Node server against this database.

## Release and rollback checklist

- [ ] Previous writers are stopped.
- [ ] A verified backup exists outside static paths.
- [ ] `db-upgrade` and `db-validate` succeed.
- [ ] `/login` blocks unauthenticated application access.
- [ ] `/admin` still requires the independent administrator password.
- [ ] Search and scanner assets work over HTTPS.
- [ ] An XLSX preview survives a web-app reload and confirmation remains session-bound.
- [ ] A test import creates a checksum backup and one audit/import run.

Rollback means stopping the Python web app, restoring the verified pre-migration backup to a new path, pointing
`DATABASE_URL` at that restored file, and validating it before enabling exactly one writer. The additive tables
do not alter existing catalog IDs or timestamps and may safely remain if returning temporarily to read-only
legacy behavior.
