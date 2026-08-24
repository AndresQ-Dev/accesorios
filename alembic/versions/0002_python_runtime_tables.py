"""Add Python runtime sessions, throttling, and persistent import previews.

Revision ID: 0002_python_runtime
Revises: 0001_adopt_drizzle
"""

from alembic import op

revision = "0002_python_runtime"
down_revision = "0001_adopt_drizzle"
branch_labels = None
depends_on = None


def upgrade() -> None:
    statements = [
        """CREATE TABLE IF NOT EXISTS app_sessions (
            token_hash TEXT PRIMARY KEY NOT NULL, csrf_token TEXT NOT NULL,
            expires_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )""",
        "CREATE INDEX IF NOT EXISTS app_sessions_expiry_index ON app_sessions (expires_at)",
        """CREATE TABLE IF NOT EXISTS login_attempts (
            scope TEXT NOT NULL, client_key TEXT NOT NULL, attempted_at TEXT NOT NULL
        )""",
        "CREATE INDEX IF NOT EXISTS login_attempts_lookup_index ON login_attempts (scope, client_key, attempted_at)",
        """CREATE TABLE IF NOT EXISTS import_previews (
            reference TEXT PRIMARY KEY NOT NULL, actor_session_hash TEXT NOT NULL,
            content_hash TEXT NOT NULL, base_catalog_version INTEGER NOT NULL,
            expires_at TEXT NOT NULL, rows_json TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )""",
        "CREATE INDEX IF NOT EXISTS import_previews_expiry_index ON import_previews (expires_at)",
        "CREATE INDEX IF NOT EXISTS import_previews_actor_index ON import_previews (actor_session_hash)",
    ]
    for statement in statements:
        op.execute(statement)


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS import_previews")
    op.execute("DROP TABLE IF EXISTS login_attempts")
    op.execute("DROP TABLE IF EXISTS app_sessions")
