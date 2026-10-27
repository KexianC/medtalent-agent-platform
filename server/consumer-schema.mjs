// Additive consumer schema: deliberately separate from administration accounts.
export const CONSUMER_TABLES = ["consumer_users", "consumer_sessions", "consumer_login_requests", "consumer_login_codes", "consumer_documents"];

export const consumerSqliteSchema = `
CREATE TABLE IF NOT EXISTS consumer_users (
 id TEXT PRIMARY KEY, app_id TEXT NOT NULL, open_id TEXT NOT NULL,
 display_name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 UNIQUE(app_id,open_id)
);
CREATE TABLE IF NOT EXISTS consumer_sessions (
 token_hash TEXT PRIMARY KEY, user_id TEXT REFERENCES consumer_users(id),
 expires_at TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS consumer_sessions_expiry ON consumer_sessions(expires_at);
CREATE TABLE IF NOT EXISTS consumer_login_requests (
 id TEXT PRIMARY KEY, session_hash TEXT NOT NULL, bridge_hash TEXT NOT NULL,
 status TEXT NOT NULL, user_id TEXT REFERENCES consumer_users(id),
 return_path TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS consumer_requests_session ON consumer_login_requests(session_hash);
CREATE INDEX IF NOT EXISTS consumer_requests_expiry ON consumer_login_requests(expires_at);
CREATE TABLE IF NOT EXISTS consumer_login_codes (code_hash TEXT PRIMARY KEY, expires_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS consumer_documents (
 user_id TEXT NOT NULL REFERENCES consumer_users(id), agent_slug TEXT NOT NULL REFERENCES agents(slug),
 section TEXT NOT NULL, value_json TEXT NOT NULL, revision INTEGER NOT NULL, updated_at TEXT NOT NULL,
 PRIMARY KEY(user_id,agent_slug,section)
);
`;

const suffix = "ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_bin";
export const consumerMysqlStatements = [
  `CREATE TABLE IF NOT EXISTS consumer_users (
    id VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    app_id VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    open_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    display_name VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    created_at CHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    updated_at CHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    PRIMARY KEY (id), UNIQUE KEY consumer_identity (app_id,open_id)
  ) ${suffix}`,
  `CREATE TABLE IF NOT EXISTS consumer_sessions (
    token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    user_id VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
    expires_at CHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    created_at CHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    PRIMARY KEY (token_hash), KEY consumer_sessions_expiry (expires_at),
    CONSTRAINT consumer_sessions_user_fk FOREIGN KEY (user_id) REFERENCES consumer_users(id)
  ) ${suffix}`,
  `CREATE TABLE IF NOT EXISTS consumer_login_requests (
    id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    session_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    bridge_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    user_id VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
    return_path VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    expires_at CHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    created_at CHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    PRIMARY KEY (id), KEY consumer_requests_session (session_hash), KEY consumer_requests_expiry (expires_at),
    CONSTRAINT consumer_requests_user_fk FOREIGN KEY (user_id) REFERENCES consumer_users(id)
  ) ${suffix}`,
  `CREATE TABLE IF NOT EXISTS consumer_login_codes (
    code_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    expires_at CHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    PRIMARY KEY (code_hash)
  ) ${suffix}`,
  `CREATE TABLE IF NOT EXISTS consumer_documents (
    user_id VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    agent_slug VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    section VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    value_json LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    revision INT UNSIGNED NOT NULL,
    updated_at CHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    PRIMARY KEY (user_id,agent_slug,section),
    CONSTRAINT consumer_documents_user_fk FOREIGN KEY (user_id) REFERENCES consumer_users(id),
    CONSTRAINT consumer_documents_agent_fk FOREIGN KEY (agent_slug) REFERENCES agents(slug),
    CONSTRAINT consumer_documents_json CHECK (JSON_VALID(value_json))
  ) ${suffix}`,
];
