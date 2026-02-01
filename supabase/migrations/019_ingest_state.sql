-- Cursor state for incremental ingest pipelines (e.g. ingest-trending).

CREATE TABLE IF NOT EXISTS public.ingest_state (
  name text PRIMARY KEY,
  last_signature text,
  updated_at timestamptz DEFAULT now()
);

-- Seed row for trending ingest; idempotent.
INSERT INTO public.ingest_state (name, last_signature)
VALUES ('ingest-trending', NULL)
ON CONFLICT (name) DO NOTHING;
