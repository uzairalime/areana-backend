-- ============================================================================
-- 06 — Floor legacy negative booking prices (Round 4, L-S12)
-- ============================================================================
-- WHAT:   The first audit fixed CREATING negative prices, but stored
--         rows were never repaired: a legacy booking with gross
--         Rs 2,000 and a 150% promo sits at totalPrice = -1,000, which
--         subtracts Rs 1,000 from venue GMV, user spend and chart
--         revenue (admin sums use raw totalPrice with no floor), while
--         game shares floor it at Rs 0 and the player sees a negative
--         "due at venue".
-- DRY RUN (read-only — run first):
--   SELECT "id", "venueId", "totalPrice", "discountAmount",
--          ("totalPrice" + "discountAmount") AS gross
--   FROM "Booking" WHERE "totalPrice" < 0;
-- FIX:    totalPrice = max(0, totalPrice), and discountAmount capped at
--         the gross (totalPrice + discountAmount) so the discount can
--         never exceed what the booking was worth. Both columns are
--         updated in ONE statement, so the cap uses the PRE-fix values
--         (Postgres evaluates the SET expressions against the old row).
-- IDEMPOTENT: the WHERE clause excludes already-floored rows.
-- ROLLBACK: restore from backup. The pre-fix values are preserved in
--         the audit details below for manual reconstruction.
-- RUN:    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f 06-negative-prices.sql
-- ============================================================================

-- STEP 0 — dry run (read-only).
SELECT "id", "venueId", "totalPrice", "discountAmount",
       ("totalPrice" + "discountAmount") AS gross
FROM "Booking" WHERE "totalPrice" < 0;

BEGIN;

-- STEP 1 — audit trail first (captures pre-fix values).
INSERT INTO "AuditLog" ("id", "actorId", "action", "entity", "entityId", "details", "createdAt")
SELECT
  'bf-negprice-' || b."id",
  NULL, 'booking.price.floored', 'booking', b."id",
  'Round-4 backfill: floored negative totalPrice ' || b."totalPrice" || ' (discount ' || b."discountAmount" || ', gross ' || (b."totalPrice" + b."discountAmount") || ') to 0',
  now()
FROM "Booking" b
WHERE b."totalPrice" < 0
ON CONFLICT ("id") DO NOTHING;

-- STEP 2 — floor + cap (single statement: both expressions read the
-- old row, so the discount cap uses the pre-fix gross).
UPDATE "Booking"
SET "discountAmount" = LEAST("discountAmount", "totalPrice" + "discountAmount"),
    "totalPrice" = GREATEST("totalPrice", 0)
WHERE "totalPrice" < 0;

COMMIT;
