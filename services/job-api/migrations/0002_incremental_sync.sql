-- Keep one active storage namespace and mutate it incrementally. The column is
-- intentionally unindexed: it marks the current source payload so vanished jobs
-- can be deleted without loading a second complete dataset.
ALTER TABLE jobs ADD COLUMN last_seen_sync TEXT NOT NULL DEFAULT '';
