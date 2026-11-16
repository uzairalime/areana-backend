-- ============================================================================
-- 04 — Demo-venue data repair (Round 4, M-S5 + M-S6)
-- ============================================================================
-- WHAT:   (a) Demo arenas seeded as `approved` with ZERO photos: the first
--         later edit drops them to `pending` (dropVenueIfUnready) and
--         re-approval is blocked by the readiness gate the seed never
--         satisfied. The seed fix (seed-demo.ts) ships placeholder
--         photos for NEW runs; this script REPAIRS existing rows.
--         (b) "Demo Active Arena" claimed a paid period (billingPaidUntil)
--         with ZERO VenuePayment rows, so mark-paid could double-settle
--         or skip a period. The seed fix writes the matching row for new
--         runs; this script inserts it for existing demo rows.
-- SCOPE:  The ledger insert is DEMO-ONLY (venues owned by a
--         @demo.areana.pk user). A REAL venue with billingPaidUntil but
--         no ledger rows is reported, never silently papered over —
--         inventing a payment row for a real venue would falsify money.
-- DRY RUN (read-only — run first):
--   SELECT v."id", v."name", v."status", array_length(v."images", 1) AS imgs,
--          array_length(v."sports", 1) AS sports_n, v."billingPaidUntil"
--   FROM "Venue" v JOIN "User" o ON o."id" = v."ownerId"
--   WHERE v."status" = 'approved'
--     AND COALESCE(array_length(v."images", 1), 0)
--         < GREATEST(4, COALESCE(array_length(v."sports", 1), 0));
-- FIX:    (a) For demo venues only: APPEND placeholder photos up to
--         max(4, sports count) — never replacing the array (the old
--         SET destroyed 1–3 real images) — with tags continuing the
--         cycle from the existing photos count, so a 5-sport venue
--         gets its 5th sport tagged. Real venues are REPORTED, not
--         touched — their photos are real business data.
--         (b) For demo venues with billingPaidUntil set and no payment
--         row ending at that date: insert the matching row (amount =
--         the venue plan's priceYearly, method 'other', clearly noted
--         as a backfill; id scoped by venue AND periodEnd so a second
--         period's repair is never dropped by a collision). Real
--         venues: reported only.
-- IDEMPOTENT: photo repair only touches venues short of max(4,
--         sports); the ledger insert only fires when no row with
--         that periodEnd exists (re-runs find it and skip).
-- ROLLBACK: restore from backup, or delete the inserted payment rows
--         (note LIKE 'Demo backfill%') and clear the placeholder images
--         on the demo venues.
-- RUN:    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f 04-demo-venues.sql
-- ============================================================================

-- STEP 0 — dry run (read-only): approved venues short on photos.
-- (The write below is now filtered to status='approved' too —
-- Round 5, D5-S9: the old write touched draft/pending demo venues
-- the operator never inspected. The predicate also matches the
-- write exactly: fewer images than the repair target
-- max(4, sports count), not just < 4 — Round 5, D5-S11.)
SELECT v."id", v."name", v."status", array_length(v."images", 1) AS imgs,
       array_length(v."sports", 1) AS sports_n,
       v."billingPaidUntil", o."email" AS owner_email
FROM "Venue" v JOIN "User" o ON o."id" = v."ownerId"
WHERE v."status" = 'approved'
  AND COALESCE(array_length(v."images", 1), 0)
      < GREATEST(4, COALESCE(array_length(v."sports", 1), 0))
ORDER BY o."email", v."name";

-- STEP 0b — dry run: venues claiming paid time with no ledger row
-- ending at that date (matches STEP 2's predicate, not "no rows at
-- all" — a venue with an old-period row claiming a new paid-until
-- still needs the new row).
SELECT v."id", v."name", v."billingPaidUntil", o."email" AS owner_email
FROM "Venue" v JOIN "User" o ON o."id" = v."ownerId"
WHERE v."billingPaidUntil" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "VenuePayment" p
    WHERE p."venueId" = v."id" AND p."periodEnd" = v."billingPaidUntil"
  )
ORDER BY o."email", v."name";

BEGIN;

-- Snapshot the demo venues STEP 1 will touch, with their pre-repair
-- images (Round 5, D5-S9: the old script wrote no audit rows at
-- all, so destroyed images were unrecoverable from the trail).
CREATE TEMP TABLE bf_demo_photo_before ON COMMIT DROP AS
SELECT v."id", v."images" AS old_images
FROM "Venue" v JOIN "User" o ON o."id" = v."ownerId"
WHERE v."status" = 'approved'
  AND o."email" LIKE '%@demo.areana.pk'
  AND COALESCE(array_length(v."images", 1), 0)
      < GREATEST(4, COALESCE(array_length(v."sports", 1), 0));

-- STEP 1 — demo photo repair (approved demo-owned venues short of
-- the target only). Placeholders are APPENDED up to the target
-- count, never replacing the array (Round 5, D5-S9: the old SET
-- replaced 1–3 REAL images with placeholders, destroying them).
-- The target is max(4, number of sports) (Round 5, D5-S11: 4
-- placeholders could not cover a 5-sport venue's per-sport gate),
-- and new tags continue the cycle from the existing photos count
-- (so a 5-sport venue whose 4 placeholders already cover sports
-- 1–4 gets sport 5, not another sport 1). A venue with an empty
-- sports array gets untagged placeholders and is listed by the
-- STEP 3(c) report (its gate cannot be satisfied by placeholders
-- alone).
UPDATE "Venue" v
SET "images" = COALESCE(v."images", ARRAY[]::text[]) || ARRAY(
      SELECT 'https://picsum.photos/seed/areana-demo-backfill-' || g || '/800/600'
      FROM generate_series(1, GREATEST(4, COALESCE(array_length(v."sports", 1), 0)) - COALESCE(array_length(v."images", 1), 0)) AS g
    ),
    "photos" = COALESCE(v."photos"::jsonb, '[]'::jsonb) || COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'url', 'https://picsum.photos/seed/areana-demo-backfill-' || g || '/800/600',
        'sport', CASE WHEN COALESCE(array_length(v."sports", 1), 0) = 0 THEN NULL
                      ELSE v."sports"[1 + ((photo_off + g - 1) % array_length(v."sports", 1))] END
      ))
      FROM generate_series(1, GREATEST(4, COALESCE(array_length(v."sports", 1), 0)) - COALESCE(array_length(v."images", 1), 0)) AS g
      CROSS JOIN (SELECT CASE WHEN jsonb_typeof(v."photos"::jsonb) = 'array'
                               THEN jsonb_array_length(v."photos"::jsonb) ELSE 0 END AS photo_off) AS off
    ), '[]'::jsonb)
FROM "User" o
WHERE o."id" = v."ownerId"
  AND v."id" IN (SELECT "id" FROM bf_demo_photo_before);

-- Audit rows carrying the pre-repair images (D5-S9).
INSERT INTO "AuditLog" ("id", "actorId", "action", "entity", "entityId", "details", "createdAt")
SELECT
  'bf-demo-photos-' || b."id",
  NULL, 'venue.photos.backfilled.demo', 'venue', b."id",
  'Round-4 backfill: appended demo placeholder photos to venue with < 4 images (pre-repair images: ' || COALESCE(array_to_string(b.old_images, ', '), '(none)') || ')',
  now()
FROM bf_demo_photo_before b
ON CONFLICT ("id") DO NOTHING;

-- STEP 2 — demo ledger repair: one matching row per demo venue whose
-- billingPaidUntil has no payment row ending at that date. The period
-- start is 12 months before the claimed paid-until (yearly periods);
-- the amount is the venue plan's current priceYearly (demo plans are
-- never edited, so this equals the claimed period's price).
-- Round 5, D5-B5: the id is scoped by venue AND periodEnd (epoch
-- seconds — timezone-independent). The old venue-only id collided
-- across periods: after a first repair extended billingPaidUntil, a
-- second run found no row ending at the NEW date, hit the same id,
-- and ON CONFLICT DO NOTHING silently dropped the new period's row.
INSERT INTO "VenuePayment"
  ("id", "venueId", "planId", "amount", "method", "periodStart", "periodEnd",
   "note", "recordedById", "createdAt")
SELECT
  'bf-demo-ledger-' || v."id" || '-' || EXTRACT(EPOCH FROM v."billingPaidUntil")::bigint,
  v."id",
  v."planId",
  COALESCE(p."priceYearly", 0),
  'other',
  v."billingPaidUntil" - INTERVAL '12 months',
  v."billingPaidUntil",
  'Demo backfill — matches seeded billingPaidUntil (Round-4 backfill 04)',
  NULL,
  now()
FROM "Venue" v
JOIN "User" o ON o."id" = v."ownerId"
LEFT JOIN "Plan" p ON p."id" = v."planId"
WHERE o."email" LIKE '%@demo.areana.pk'
  AND v."billingPaidUntil" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "VenuePayment" x
    WHERE x."venueId" = v."id" AND x."periodEnd" = v."billingPaidUntil"
  )
ON CONFLICT ("id") DO NOTHING;

COMMIT;

-- STEP 3 — report (read-only): REAL venues still needing attention.
-- (a) Approved real venues short of the repair target (operator must
--     photograph them; do NOT bulk-attach placeholders to real
--     businesses).
SELECT 'real-venue-short-photos' AS issue, v."id", v."name", o."email" AS owner_email
FROM "Venue" v JOIN "User" o ON o."id" = v."ownerId"
WHERE v."status" = 'approved'
  AND o."email" NOT LIKE '%@demo.areana.pk'
  AND COALESCE(array_length(v."images", 1), 0)
      < GREATEST(4, COALESCE(array_length(v."sports", 1), 0));
-- (b) Real venues claiming paid time with no ledger row ending at
--     that date (Round 5, D5-S10: the old report required NO ledger
--     rows at all, so a real venue with an old-period row claiming a
--     new billingPaidUntil — the same double-settle/skip risk as the
--     demo case — was never reported).
SELECT 'real-venue-paid-no-matching-ledger' AS issue, v."id", v."name",
       v."billingPaidUntil", o."email" AS owner_email
FROM "Venue" v JOIN "User" o ON o."id" = v."ownerId"
WHERE v."billingPaidUntil" IS NOT NULL
  AND o."email" NOT LIKE '%@demo.areana.pk'
  AND NOT EXISTS (
    SELECT 1 FROM "VenuePayment" p
    WHERE p."venueId" = v."id" AND p."periodEnd" = v."billingPaidUntil"
  );
-- (c) Demo venues STILL failing the per-sport gate after repair
--     (Round 5, D5-S11): sports with no tagged photo — including
--     empty-sports venues, whose placeholders carry no usable tag.
--     These need an operator tagging pass, not another script run.
SELECT 'demo-venue-still-unready-sport' AS issue, v."id", v."name", s.sport
FROM "Venue" v JOIN "User" o ON o."id" = v."ownerId"
CROSS JOIN LATERAL unnest(v."sports") AS s(sport)
WHERE o."email" LIKE '%@demo.areana.pk'
  AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(COALESCE(v."photos"::jsonb, '[]'::jsonb)) AS e
    WHERE e->>'sport' = s.sport
  );
SELECT 'demo-venue-empty-sports' AS issue, v."id", v."name"
FROM "Venue" v JOIN "User" o ON o."id" = v."ownerId"
WHERE o."email" LIKE '%@demo.areana.pk'
  AND (v."sports" IS NULL OR array_length(v."sports", 1) IS NULL);
