PRAGMA foreign_keys = ON;

CREATE TABLE snapshot_metadata (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  provider TEXT NOT NULL,
  tier TEXT NOT NULL,
  index_version TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  source TEXT NOT NULL,
  endpoint TEXT,
  model_count INTEGER NOT NULL,
  duplicate_records INTEGER NOT NULL DEFAULT 0,
  snapshot_checksum TEXT NOT NULL
);

CREATE TABLE models (
  aa_id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  release_date TEXT,
  creator_id TEXT,
  creator_name TEXT,
  intelligence_index REAL,
  coding_index REAL,
  agentic_index REAL,
  intelligence_index_total_cost REAL,
  intelligence_index_cost_per_task REAL,
  price_1m_input_tokens REAL,
  price_1m_output_tokens REAL,
  price_1m_cache_hit_tokens REAL,
  price_1m_cache_write_tokens REAL,
  median_output_tokens_per_second REAL,
  median_time_to_first_token_seconds REAL,
  median_time_to_first_answer_token_seconds REAL,
  median_end_to_end_response_time_seconds REAL,
  evaluations_json TEXT NOT NULL,
  pricing_json TEXT NOT NULL,
  performance_json TEXT NOT NULL,
  cost_json TEXT NOT NULL
);

CREATE TABLE route_mappings (
  route_id TEXT NOT NULL,
  profile TEXT NOT NULL DEFAULT '',
  aa_slug TEXT NOT NULL,
  mapping_source TEXT NOT NULL DEFAULT 'explicit',
  note TEXT,
  PRIMARY KEY (route_id, profile)
);

CREATE INDEX route_mappings_slug_idx ON route_mappings(aa_slug);
