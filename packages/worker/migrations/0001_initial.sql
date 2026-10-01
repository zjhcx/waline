CREATE TABLE IF NOT EXISTS wl_Comment (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  comment TEXT NOT NULL,
  insertedAt TEXT NOT NULL DEFAULT (datetime('now')),
  ip TEXT,
  link TEXT,
  mail TEXT,
  nick TEXT,
  rid INTEGER,
  pid INTEGER,
  sticky INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'approved',
  "like" INTEGER NOT NULL DEFAULT 0,
  ua TEXT,
  url TEXT NOT NULL,
  createdAt TEXT NOT NULL DEFAULT (datetime('now')),
  updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_comment_url_status ON wl_Comment(url, status);
CREATE INDEX IF NOT EXISTS idx_comment_rid ON wl_Comment(rid);
CREATE INDEX IF NOT EXISTS idx_comment_inserted_at ON wl_Comment(insertedAt DESC);

CREATE TABLE IF NOT EXISTS wl_Counter (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  time INTEGER NOT NULL DEFAULT 0,
  reaction0 INTEGER NOT NULL DEFAULT 0,
  reaction1 INTEGER NOT NULL DEFAULT 0,
  reaction2 INTEGER NOT NULL DEFAULT 0,
  reaction3 INTEGER NOT NULL DEFAULT 0,
  reaction4 INTEGER NOT NULL DEFAULT 0,
  reaction5 INTEGER NOT NULL DEFAULT 0,
  reaction6 INTEGER NOT NULL DEFAULT 0,
  reaction7 INTEGER NOT NULL DEFAULT 0,
  reaction8 INTEGER NOT NULL DEFAULT 0,
  url TEXT NOT NULL UNIQUE,
  createdAt TEXT NOT NULL DEFAULT (datetime('now')),
  updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS wl_Users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  display_name TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  password TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT '',
  label TEXT,
  github TEXT,
  twitter TEXT,
  facebook TEXT,
  google TEXT,
  weibo TEXT,
  qq TEXT,
  oidc TEXT,
  huawei TEXT,
  "2fa" TEXT,
  avatar TEXT,
  url TEXT,
  createdAt TEXT NOT NULL DEFAULT (datetime('now')),
  updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
);
