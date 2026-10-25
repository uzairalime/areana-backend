-- ============================================================================
-- 05 — Promo-code legacy cleanup (Round 4, L-S6 + L-S7 + L-S8)
-- ============================================================================
-- WHAT:   (a) Spaced/empty legacy codes are permanently dead: lookup
--         trims, so " EID20 " matches no input forever and can never be
--         renamed (owner update has no code field, admin editing is
--         activate/deactivate only); a stored "" code IS found by
--         preview, so players saw a discount a booking could never
--         apply (creation skips falsy codes).
--         (b) perUserLimit > maxUses rows: the first user could drain
--         all uses; maxDiscount = 0 rows advertise a promo that gives
--         nothing (booking creation luckily skips discount-0 promos).
--         (c) Orphan PromoRedemption rows (bookingId NULL, from pre-fix
--         court deletes that never refunded) burn uses forever and can
--         break promo deletion (PromoRedemption.promoCodeId has no
--         onDelete, while the delete guard only checks usedCount).
-- DRY RUN (read-only — run first):
--   SELECT "id", "code", "maxUses", "perUserLimit", "maxDiscount", "usedCount", "isActive"
--   FROM "PromoCode"
--   WHERE "code" <> btrim("code") OR "code" = ''
--      OR ("maxUses" IS NOT NULL AND "perUserLimit" > "maxUses")
--      OR "maxDiscount" = 0;
--   SELECT COUNT(*) FROM "PromoRedemption" WHERE "bookingId" IS NULL;
-- FIX:    (a) Trim codes where the trimmed value collides with nothing;
--         colliding trims are REPORTED (never forced — overwriting a
--         live code would be worse). Delete "" rows only when nothing
--         references them (no bookings, no redemptions); otherwise
--         deactivate + report.
--         (b) Clamp perUserLimit = min(perUserLimit, maxUses) where
--         maxUses is set; deactivate maxDiscount = 0 rows (a promo
--         that gives nothing must not advertise).
--         (c) Delete orphan redemptions, then recompute usedCount from
--         surviving rows per promo (usedCount semantics: +1 per live
--         redemption, refunded by row delete + decrement — so the
--         count of surviving rows IS the correct usedCount).
-- IDEMPOTENT: every step filters on the pre-fix state.
-- ROLLBACK: restore from backup. Trims/clamps/deactivations are listed
--         in the final report queries for manual reversal.
-- RUN:    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f 05-promo-cleanup.sql
-- ============================================================================

-- STEP 0 — dry run (read-only).
SELECT "id", "code", "maxUses", "perUserLimit", "maxDiscount", "usedCount", "isActive"
FROM "PromoCode"
WHERE "code" <> btrim("code") OR "code" = ''
   OR ("maxUses" IS NOT NULL AND "perUserLimit" > "maxUses")
   OR "maxDiscount" = 0;
SELECT COUNT(*) AS orphan_redemptions
FROM "PromoRedemption" WHERE "bookingId" IS NULL;

BEGIN;

-- STEP 1 — trim codes that collide with nothing (empty codes excluded:
-- btrim('') = '' is not a usable code; handled in STEP 2).
UPDATE "PromoCode" pc
SET "code" = btrim(pc."code")
WHERE pc."code" <> btrim(pc."code") AND btrim(pc."code") <> ''
  AND NOT EXISTS (
    SELECT 1 FROM "PromoCode" other
    WHERE other."id" <> pc."id" AND other."code" = btrim(pc."code")
  );

-- STEP 2 — delete empty-code rows only when unreferenced; otherwise
-- deactivate so preview (which now rejects empty codes) and booking
-- creation agree that the code is dead.
DELETE FROM "PromoCode" pc
WHERE pc."code" = ''
  AND NOT EXISTS (SELECT 1 FROM "Booking" b WHERE b."promoCodeId" = pc."id")
  AND NOT EXISTS (SELECT 1 FROM "PromoRedemption" r WHERE r."promoCodeId" = pc."id");
UPDATE "PromoCode"
SET "isActive" = false
WHERE "code" = '';

-- STEP 3 — clamp perUserLimit to maxUses; deactivate maxDiscount = 0.
UPDATE "PromoCode"
SET "perUserLimit" = LEAST("perUserLimit", "maxUses")
WHERE "maxUses" IS NOT NULL AND "perUserLimit" > "maxUses";
UPDATE "PromoCode"
SET "isActive" = false
WHERE "maxDiscount" = 0 AND "isActive" = true;

-- STEP 4 — delete orphan redemptions, then recompute usedCount from
-- surviving rows (per promo, including promos untouched above — a
-- drifted count anywhere is healed, not just on orphan promos).
DELETE FROM "PromoRedemption" WHERE "bookingId" IS NULL;
UPDATE "PromoCode" pc
SET "usedCount" = COALESCE((
  SELECT COUNT(*) FROM "PromoRedemption" r WHERE r."promoCodeId" = pc."id"
), 0);

COMMIT;

-- STEP 5 — report leftovers (read-only): trims that collided, and
-- empty-code rows that could not be deleted (still referenced).
SELECT 'trim-collision' AS issue, "id", "code"
FROM "PromoCode" WHERE "code" <> btrim("code") AND btrim("code") <> '';
SELECT 'empty-code-still-referenced' AS issue, pc."id",
       (SELECT COUNT(*) FROM "Booking" b WHERE b."promoCodeId" = pc."id") AS bookings,
       (SELECT COUNT(*) FROM "PromoRedemption" r WHERE r."promoCodeId" = pc."id") AS redemptions
FROM "PromoCode" pc WHERE pc."code" = '';
