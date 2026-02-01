-- Drop UNIQUE(snapshot_id, rank) on trending_items so upsert on (snapshot_id, mint)
-- does not conflict when rank is recomputed each run (rankings change or new qualified mints).
ALTER TABLE public.trending_items
  DROP CONSTRAINT IF EXISTS trending_items_snapshot_id_rank_key;
