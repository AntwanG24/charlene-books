-- Charlene Book List - D1 Schema
CREATE TABLE IF NOT EXISTS books (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  tab       TEXT    NOT NULL CHECK(tab IN ('en','zh','pending')),
  title     TEXT    NOT NULL,
  series    TEXT    DEFAULT '',
  author    TEXT    DEFAULT '',
  publisher TEXT    DEFAULT '',
  isbn13    TEXT    DEFAULT '',
  pages     TEXT    DEFAULT '',
  lexile    TEXT    DEFAULT '',
  found_at  TEXT    DEFAULT '',
  read_in   TEXT    DEFAULT '',
  note      TEXT    DEFAULT '',
  status    TEXT    DEFAULT 'unread' CHECK(status IN ('registered','read','unread')),
  cover_url TEXT    DEFAULT '',
  added_at  INTEGER DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_books_tab ON books(tab);
