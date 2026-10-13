-- Run once against the EXISTING D1 database BEFORE enabling any node.
-- No secondary index, no delete cron. 1440 cyclic minute slots per enabled node.
CREATE TABLE IF NOT EXISTS latency_detail (
  server_slot INTEGER NOT NULL CHECK(server_slot >= 0 AND server_slot < 6),
  server_id TEXT NOT NULL,
  slot INTEGER NOT NULL CHECK(slot >= 0 AND slot < 1440),
  minute INTEGER NOT NULL,
  samples TEXT NOT NULL,
  PRIMARY KEY(server_slot, slot)
) WITHOUT ROWID;
