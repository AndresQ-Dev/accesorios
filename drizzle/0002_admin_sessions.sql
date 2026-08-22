CREATE TABLE admin_sessions (
  token_hash TEXT PRIMARY KEY NOT NULL,
  csrf_token TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  actor_session_hash TEXT NOT NULL,
  action TEXT NOT NULL,
  product_id INTEGER REFERENCES products(id) ON DELETE RESTRICT,
  details TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE INDEX admin_sessions_expiry_index ON admin_sessions (expires_at);
--> statement-breakpoint
CREATE INDEX audit_log_product_index ON audit_log (product_id);
