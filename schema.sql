-- D1 Schema for Internet Tracker
-- Run with: npx wrangler d1 execute internet-tracker-db --file=./schema.sql

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL CHECK(event_type IN ('on', 'off')),
  timestamp TEXT NOT NULL,           -- ISO 8601 UTC
  date TEXT NOT NULL,                -- YYYY-MM-DD (derived from UTC+2)
  source TEXT,                       -- e.g. "general", "fitness", "driving", "quick catchup"
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_events_date ON events(date);
CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
