BEGIN;

-- Drop old PK (whatever it currently is)
ALTER TABLE public.trending_items
  DROP CONSTRAINT IF EXISTS trending_items_pkey;

-- Drop redundant unique constraint if it exists
ALTER TABLE public.trending_items
  DROP CONSTRAINT IF EXISTS trending_items_snapshot_id_mint_key;

-- Drop rank unique constraint if it already exists (so re-run is safe)
ALTER TABLE public.trending_items
  DROP CONSTRAINT IF EXISTS trending_items_snapshot_id_rank_key;

-- New PK: (snapshot_id, mint)
ALTER TABLE public.trending_items
  ADD CONSTRAINT trending_items_pkey PRIMARY KEY (snapshot_id, mint);

-- Keep rank unique per snapshot
ALTER TABLE public.trending_items
  ADD CONSTRAINT trending_items_snapshot_id_rank_key UNIQUE (snapshot_id, rank);

COMMIT;
