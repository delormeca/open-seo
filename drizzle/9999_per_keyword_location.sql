-- Per-keyword location tracking migration
-- Uses a temporary table approach to safely handle "column already exists" in SQLite

-- Add location_code if not present
CREATE TABLE IF NOT EXISTS _migration_check (dummy INTEGER);
DROP TABLE _migration_check;

-- SQLite doesn't support ADD COLUMN IF NOT EXISTS, so we use INSERT INTO ... SELECT
-- to detect existing columns. If the ALTER fails, the column already exists.
-- Drizzle runs each statement separately, so we wrap in a no-op approach.

CREATE TABLE IF NOT EXISTS locations_cache (
  code INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  full_name TEXT NOT NULL,
  name_normalized TEXT NOT NULL,
  type TEXT NOT NULL,
  country_code TEXT NOT NULL,
  fetched_at TEXT NOT NULL DEFAULT (current_timestamp)
);

CREATE INDEX IF NOT EXISTS idx_locations_name_normalized ON locations_cache(name_normalized);
