-- 002: automatic enrolment of custom-Agent nodes, up to 10 (was a fixed list of 6).
-- Run once in the D1 console AFTER the Worker that ships this file is deployed.
-- Until it runs, the Worker keeps using LATENCY_DETAIL_SERVER_IDS exactly as before.
-- Steps 1-4 rebuild latency_detail with a wider slot range, keeping every stored minute.
-- If any step fails, stop: the original table is only dropped after the copy succeeds.
CREATE TABLE latency_detail_new (
  server_slot INTEGER NOT NULL CHECK(server_slot >= 0 AND server_slot < 10),
  server_id TEXT NOT NULL,
  slot INTEGER NOT NULL CHECK(slot >= 0 AND slot < 1440),
  minute INTEGER NOT NULL,
  samples TEXT NOT NULL,
  PRIMARY KEY(server_slot, slot)
) WITHOUT ROWID;
INSERT INTO latency_detail_new (server_slot, server_id, slot, minute, samples)
  SELECT server_slot, server_id, slot, minute, samples FROM latency_detail;
DROP TABLE latency_detail;
ALTER TABLE latency_detail_new RENAME TO latency_detail;
-- Created last: its existence switches the Worker to automatic enrolment. On first use the
-- Worker seeds it from LATENCY_DETAIL_SERVER_IDS, keeping each existing node in its slot.
CREATE TABLE latency_detail_nodes (
  server_slot INTEGER PRIMARY KEY CHECK(server_slot >= 0 AND server_slot < 10),
  server_id TEXT NOT NULL UNIQUE,
  enrolled_at INTEGER NOT NULL
);
