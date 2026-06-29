ALTER TABLE rank_tracking_keywords ADD COLUMN location_code INTEGER;
ALTER TABLE rank_tracking_keywords ADD COLUMN location_name TEXT;

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
