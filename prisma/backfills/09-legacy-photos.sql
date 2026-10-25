-- ============================================================================
-- 09 — Backfill venue `photos` entries from `images` (Round 4, L-S14)
-- ============================================================================
-- WHAT:   Venue photos carry sport tags in the `photos` Json column, but
--         the gallery itself lives in `images` (String[]). Venues
--         approved pre-`photos` era have images but EMPTY photos: they
--         stay live until suspended, then unsuspend/re-approval drops
--         them to `pending` ("back in review") on the sport-tag check —
--         and they cannot go live again until every sport is re-tagged,
--         even though nothing about the arena changed.
-- DRY RUN (read-only — run first):
--   SELECT "id", "name", "status", "sports",
--          array_length("images", 1) AS imgs, "photos"::text
--   FROM "Venue"
--   WHERE array_length("images", 1) > 0
--     AND ("photos" IS NULL OR "photos"::text = '[]');
-- FIX:    Build `photos` entries from `images` in order ({url} per
--         image, no sport tag — tags are an operator decision and are
--         NOT invented here). This alone does not satisfy the
--         per-sport readiness gate (untagged photos carry no sport),
--         but it restores the entries the readiness code reads, so an
--         operator tagging pass — not a full re-upload — unblocks
--         re-approval. Venues whose photos are PARTIALLY present
--         (some images without entries) are REPORTED, not overwritten:
--         overwriting would destroy existing tags.
-- IDEMPOTENT: only venues with empty/missing photos are touched.
-- ROLLBACK: restore from backup, or reset "photos" to '[]' on the
--         venues this script touched (they are listed in the audit
--         rows it writes).
-- RUN:    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f 09-legacy-photos.sql
-- ============================================================================

-- STEP 0 — dry run (read-only).
SELECT "id", "name", "status", "sports",
       array_length("images", 1) AS imgs, "photos"::text
FROM "Venue"
WHERE array_length("images", 1) > 0
  AND ("photos" IS NULL OR "photos"::text = '[]');

BEGIN;

-- Capture the touched set first (temp table, transaction-local), so
-- the audit insert below lists exactly the venues this run repaired.
CREATE TEMP TABLE bf_photos_touched ON COMMIT DROP AS
SELECT "id" FROM "Venue"
WHERE array_length("images", 1) > 0
  AND ("photos" IS NULL OR "photos"::text = '[]');

UPDATE "Venue" v
SET "photos" = COALESCE((
  SELECT jsonb_agg(jsonb_build_object('url', u))
  FROM unnest(v."images") AS t(u)
  -- Round 5, D5-S16: NULL/empty image elements used to produce
  -- {"url": null} photo entries, keeping the count mismatched after
  -- a "successful" repair. Filter them out of the built array.
  WHERE u IS NOT NULL AND btrim(u) <> ''
), '[]'::jsonb)
WHERE v."id" IN (SELECT "id" FROM bf_photos_touched);

INSERT INTO "AuditLog" ("id", "actorId", "action", "entity", "entityId", "details", "createdAt")
SELECT
  'bf-photos-' || t."id",
  NULL, 'venue.photos.backfilled', 'venue', t."id",
  'Round-4 backfill: built photos entries from images (order preserved, no sport tags invented — operator must tag per sport before re-approval)',
  now()
FROM bf_photos_touched t
ON CONFLICT ("id") DO NOTHING;

COMMIT;

-- STEP 1 — report (read-only): venues with PARTIAL photos (some images
-- without entries) — operator must tag the missing ones by hand; the
-- script deliberately does not overwrite existing tags.
-- Round 5, D5-S16: the old report compared COUNTS only, so images
-- replaced with new URLs at the same count read "clean" while
-- gallery and tagged photos diverged. This compares the URL SETS
-- (distinct, sorted, NULL/empty filtered on both sides): any
-- difference — count or content — is reported.
SELECT 'partial-photos' AS issue, v."id", v."name", v."status",
       v."images" AS images, v."photos"::text AS photos
FROM "Venue" v
WHERE array_length(v."images", 1) > 0
  AND v."photos"::text <> '[]'
  AND (
    SELECT COALESCE(ARRAY_AGG(DISTINCT u ORDER BY u), ARRAY[]::text[])
    FROM unnest(v."images") AS t(u)
    WHERE u IS NOT NULL AND btrim(u) <> ''
  ) IS DISTINCT FROM (
    SELECT COALESCE(ARRAY_AGG(DISTINCT e->>'url' ORDER BY e->>'url'), ARRAY[]::text[])
    FROM jsonb_array_elements(COALESCE(v."photos"::jsonb, '[]'::jsonb)) AS e
    WHERE e->>'url' IS NOT NULL AND btrim(e->>'url') <> ''
  );
