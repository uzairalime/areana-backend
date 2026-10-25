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
--          v."photos"::text AS photos, v."billingPaidUntil"
--   FROM "Venue" v JOIN "User" o ON o."id" = v."ownerId"
--   WHERE v."status" = 'approved'
--     AND (v."images" IS NULL OR array_length(v."images", 1) IS NULL
--          OR array_length(v."images", 1) < 4);
-- FIX:    (a) For demo venues only: attach the same 4 placeholder photos
--         the seed now ships (tagged per the venue's sports) when the
--         venue has fewer than 4 images. Real venues are REPORTED, not
--         touched — their photos are real business data.
--         (b) For demo venues with billingPaidUntil set and no payment
--         row ending at that date: insert the matching row (amount =
--         the venue plan's priceYearly, method 'other', clearly noted
--         as a backfill). Real venues: reported only.
-- IDEMPOTENT: photo repair only touches venues with < 4 images; the
--         ledger insert only fires when no row with that periodEnd
--         exists (re-runs find it and skip).
-- ROLLBACK: restore from backup, or delete the inserted payment rows
--         (note LIKE 'Demo backfill%') and clear the placeholder images
--         on the demo venues.
-- RUN:    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f 04-demo-venues.sql
-- ============================================================================

-- STEP 0 — dry run (read-only): approved venues short on photos.
SELECT v."id", v."name", v."status", array_length(v."images", 1) AS imgs,
       v."billingPaidUntil", o."email" AS owner_email
FROM "Venue" v JOIN "User" o ON o."id" = v."ownerId"
WHERE v."status" = 'approved'
  AND (v."images" IS NULL OR array_length(v."images", 1) IS NULL
       OR array_length(v."images", 1) < 4)
ORDER BY o."email", v."name";

-- STEP 0b — dry run: venues claiming paid time with no ledger rows.
SELECT v."id", v."name", v."billingPaidUntil", o."email" AS owner_email
FROM "Venue" v JOIN "User" o ON o."id" = v."ownerId"
WHERE v."billingPaidUntil" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "VenuePayment" p WHERE p."venueId" = v."id")
ORDER BY o."email", v."name";

BEGIN;

-- STEP 1 — demo photo repair (demo-owned venues with < 4 images only).
-- The placeholder URLs match seed-demo.ts demoPhotos(); tags cycle
-- through the venue's own sports so the per-sport gate is satisfied.
UPDATE "Venue" v
SET "images" = ARRAY[
      'https://picsum.photos/seed/areana-demo-backfill-1/800/600',
      'https://picsum.photos/seed/areana-demo-backfill-2/800/600',
      'https://picsum.photos/seed/areana-demo-backfill-3/800/600',
      'https://picsum.photos/seed/areana-demo-backfill-4/800/600'
    ],
    "photos" = (
      SELECT jsonb_agg(jsonb_build_object(
        'url', u,
        'sport', v."sports"[1 + ((ord - 1) % GREATEST(array_length(v."sports", 1), 1))]
      ))
      FROM unnest(ARRAY[
        'https://picsum.photos/seed/areana-demo-backfill-1/800/600',
        'https://picsum.photos/seed/areana-demo-backfill-2/800/600',
        'https://picsum.photos/seed/areana-demo-backfill-3/800/600',
        'https://picsum.photos/seed/areana-demo-backfill-4/800/600'
      ]) WITH ORDINALITY AS t(u, ord)
    )
FROM "User" o
WHERE o."id" = v."ownerId"
  AND o."email" LIKE '%@demo.areana.pk'
  AND (v."images" IS NULL OR array_length(v."images", 1) IS NULL
       OR array_length(v."images", 1) < 4);

-- STEP 2 — demo ledger repair: one matching row per demo venue whose
-- billingPaidUntil has no payment row ending at that date. The period
-- start is 12 months before the claimed paid-until (yearly periods);
-- the amount is the venue plan's current priceYearly (demo plans are
-- never edited, so this equals the claimed period's price).
INSERT INTO "VenuePayment"
  ("id", "venueId", "planId", "amount", "method", "periodStart", "periodEnd",
   "note", "recordedById", "createdAt")
SELECT
  'bf-demo-ledger-' || v."id",
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
-- (a) Approved real venues short on photos (operator must photograph
--     them; do NOT bulk-attach placeholders to real businesses).
SELECT 'real-venue-short-photos' AS issue, v."id", v."name", o."email" AS owner_email
FROM "Venue" v JOIN "User" o ON o."id" = v."ownerId"
WHERE v."status" = 'approved'
  AND o."email" NOT LIKE '%@demo.areana.pk'
  AND (v."images" IS NULL OR array_length(v."images", 1) IS NULL
       OR array_length(v."images", 1) < 4);
-- (b) Real venues claiming paid time with no ledger rows at all.
SELECT 'real-venue-paid-no-ledger' AS issue, v."id", v."name",
       v."billingPaidUntil", o."email" AS owner_email
FROM "Venue" v JOIN "User" o ON o."id" = v."ownerId"
WHERE v."billingPaidUntil" IS NOT NULL
  AND o."email" NOT LIKE '%@demo.areana.pk'
  AND NOT EXISTS (SELECT 1 FROM "VenuePayment" p WHERE p."venueId" = v."id");
