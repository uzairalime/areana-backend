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
--   WHERE "code" <> UPPER(btrim("code")) OR "code" = ''
--      OR ("maxUses" IS NOT NULL AND "perUserLimit" > "maxUses")
--      OR "maxDiscount" = 0;
--   SELECT COUNT(*) FROM "PromoRedemption" WHERE "bookingId" IS NULL;
-- FIX:    (a) Upper-trim codes (Round 5, D5-S12: lookup uppercases,
--         so a merely-trimmed "eid20" stays dead for "EID20").
--         Collisions resolve in a temp table first (Round 5, D5-B6):
--         one winner per upper-trimmed code (earliest created), and
--         a group is skipped entirely when an exact row already
--         holds the trimmed code — the transaction can never abort
--         on a unique violation from this step, and colliding trims
--         are REPORTED (never forced). Delete "" rows only when
--         nothing references them (no bookings, no redemptions);
--         otherwise deactivate + report.
--         (b) Clamp perUserLimit = min(perUserLimit, maxUses) where
--         maxUses is set; deactivate maxDiscount = 0 rows (a promo
--         that gives nothing must not advertise).
--         (c) Delete orphan redemptions, then recompute usedCount from
--         surviving rows per promo (usedCount semantics: +1 per live
--         redemption, refunded by row delete + decrement — so the
--         count of surviving rows IS the correct usedCount).
--         Every trim/clamp/deactivation/deletion writes an AuditLog
--         row with old/new values, and the final report lists every
--         usedCount delta (Round 5, D5-S13).
-- IDEMPOTENT: every step filters on the pre-fix state.
-- ROLLBACK: restore from backup. Trims/clamps/deactivations are listed
--         in the final report queries for manual reversal.
-- RUN:    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f 05-promo-cleanup.sql
-- ============================================================================

-- STEP 0 — dry run (read-only). Codes are upper-trimmed (Round 5,
-- D5-S12: lookup uppercases, so a merely-trimmed "eid20" stays dead
-- for "EID20" lookups); the report predicate matches the write.
SELECT "id", "code", "maxUses", "perUserLimit", "maxDiscount", "usedCount", "isActive"
FROM "PromoCode"
WHERE "code" <> UPPER(btrim("code")) OR "code" = ''
   OR ("maxUses" IS NOT NULL AND "perUserLimit" > "maxUses")
   OR "maxDiscount" = 0;
SELECT COUNT(*) AS orphan_redemptions
FROM "PromoRedemption" WHERE "bookingId" IS NULL;

BEGIN;

-- Before-image of every promo (for the audit rows and the usedCount
-- delta report — Round 5, D5-S13: the old script rewrote every
-- promo's usedCount with no audit trail and a dry run that never
-- listed untouched promos whose counts changed).
CREATE TEMP TABLE bf_promo_before ON COMMIT DROP AS
SELECT "id", "code", "maxUses", "perUserLimit", "maxDiscount", "usedCount", "isActive"
FROM "PromoCode";

-- STEP 1 — resolve trims in a temp table FIRST (Round 5, D5-B6):
-- the old single UPDATE checked NOT EXISTS against the pre-update
-- snapshot, so two spaced variants (" EID20", "EID20 ") both passed
-- and the second update violated the globally-unique code, aborting
-- the WHOLE transaction (and falsifying the header's "colliding
-- trims are REPORTED, never forced" promise — only pre-existing
-- exact collisions were skipped). One winner per upper-trimmed code
-- (earliest created, so the choice is deterministic); a group is
-- skipped entirely when an exact row already holds the trimmed code.
-- Only winners are updated, so the transaction can never abort on a
-- unique violation from this step.
CREATE TEMP TABLE bf_trim_groups ON COMMIT DROP AS
SELECT
  pc."id",
  UPPER(btrim(pc."code")) AS trimmed,
  ROW_NUMBER() OVER (
    PARTITION BY UPPER(btrim(pc."code")) ORDER BY pc."createdAt" ASC, pc."id" ASC
  ) AS rn,
  EXISTS (
    SELECT 1 FROM "PromoCode" other
    WHERE other."id" <> pc."id" AND other."code" = UPPER(btrim(pc."code"))
  ) AS has_exact
FROM "PromoCode" pc
WHERE pc."code" <> UPPER(btrim(pc."code")) AND UPPER(btrim(pc."code")) <> '';

UPDATE "PromoCode" pc
SET "code" = g.trimmed
FROM bf_trim_groups g
WHERE pc."id" = g."id" AND g.rn = 1 AND NOT g.has_exact;

-- Audit rows for the trims that ran (old → new).
INSERT INTO "AuditLog" ("id", "actorId", "action", "entity", "entityId", "details", "createdAt")
SELECT
  'bf-promo-trim-' || b."id",
  NULL, 'promo.trimmed', 'promo', b."id",
  'Round-4 backfill: upper-trimmed promo code "' || b."code" || '" to "' || pc."code" || '"',
  now()
FROM bf_promo_before b
JOIN "PromoCode" pc ON pc."id" = b."id"
JOIN bf_trim_groups g ON g."id" = b."id"
WHERE g.rn = 1 AND NOT g.has_exact
ON CONFLICT ("id") DO NOTHING;

-- STEP 2 — delete empty-code rows only when unreferenced (audited
-- via the RETURNING clause — the row is gone afterwards, so a
-- post-hoc join could never find it); otherwise deactivate so
-- preview (which now rejects empty codes) and booking creation
-- agree that the code is dead.
WITH deleted AS (
  DELETE FROM "PromoCode" pc
  WHERE pc."code" = ''
    AND NOT EXISTS (SELECT 1 FROM "Booking" b WHERE b."promoCodeId" = pc."id")
    AND NOT EXISTS (SELECT 1 FROM "PromoRedemption" r WHERE r."promoCodeId" = pc."id")
  RETURNING "id", "code"
)
INSERT INTO "AuditLog" ("id", "actorId", "action", "entity", "entityId", "details", "createdAt")
SELECT
  'bf-promo-deleted-' || d."id",
  NULL, 'promo.deleted.empty_code', 'promo', d."id",
  'Round-4 backfill: deleted unreferenced empty-code promo',
  now()
FROM deleted d
ON CONFLICT ("id") DO NOTHING;
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

-- Audit rows for clamps + deactivations (old → new, D5-S13).
INSERT INTO "AuditLog" ("id", "actorId", "action", "entity", "entityId", "details", "createdAt")
SELECT
  'bf-promo-clamp-' || b."id",
  NULL, 'promo.clamped', 'promo', b."id",
  'Round-4 backfill: clamped perUserLimit ' || b."perUserLimit" || ' to maxUses ' || b."maxUses" || ' (was ' || b."perUserLimit" || ' > maxUses)',
  now()
FROM bf_promo_before b
JOIN "PromoCode" pc ON pc."id" = b."id"
WHERE b."maxUses" IS NOT NULL AND b."perUserLimit" > b."maxUses"
  AND pc."perUserLimit" <> b."perUserLimit"
ON CONFLICT ("id") DO NOTHING;
INSERT INTO "AuditLog" ("id", "actorId", "action", "entity", "entityId", "details", "createdAt")
SELECT
  'bf-promo-deactivated-' || b."id",
  NULL, 'promo.deactivated', 'promo', b."id",
  'Round-4 backfill: deactivated promo (maxDiscount = 0 gives nothing, or empty code that is still referenced)',
  now()
FROM bf_promo_before b
JOIN "PromoCode" pc ON pc."id" = b."id"
WHERE b."isActive" = true AND pc."isActive" = false
  AND (b."maxDiscount" = 0 OR b."code" = '')
ON CONFLICT ("id") DO NOTHING;

-- STEP 4 — delete orphan redemptions, then recompute usedCount from
-- surviving rows (per promo, including promos untouched above — a
-- drifted count anywhere is healed, not just on orphan promos).
-- The deletion is audited per promo with its orphan count (D5-S13).
WITH deleted AS (
  DELETE FROM "PromoRedemption" WHERE "bookingId" IS NULL
  RETURNING "promoCodeId"
)
INSERT INTO "AuditLog" ("id", "actorId", "action", "entity", "entityId", "details", "createdAt")
SELECT
  'bf-promo-orphans-' || d."promoCodeId",
  NULL, 'promo.orphans.deleted', 'promo', d."promoCodeId",
  'Round-4 backfill: deleted ' || d.n || ' orphan redemption(s) (bookingId NULL) for this promo',
  now()
FROM (SELECT "promoCodeId", COUNT(*) AS n FROM deleted GROUP BY "promoCodeId") d
ON CONFLICT ("id") DO NOTHING;
UPDATE "PromoCode" pc
SET "usedCount" = COALESCE((
  SELECT COUNT(*) FROM "PromoRedemption" r WHERE r."promoCodeId" = pc."id"
), 0);

-- STEP 5 — report leftovers (read-only, BEFORE commit: the temp
-- tables below are ON COMMIT DROP, so these queries must run
-- inside the transaction): trims that collided (never forced — one
-- winner per trimmed code, or an exact row already holding it), and
-- empty-code rows that could not be deleted (still referenced).
SELECT 'trim-collision' AS issue, g."id", b."code",
       CASE WHEN g.has_exact THEN 'exact code already holds the trimmed value'
            ELSE 'lost the group to an earlier-created variant' END AS reason
FROM bf_trim_groups g
JOIN bf_promo_before b ON b."id" = g."id"
WHERE NOT (g.rn = 1 AND NOT g.has_exact);
SELECT 'empty-code-still-referenced' AS issue, pc."id",
       (SELECT COUNT(*) FROM "Booking" b WHERE b."promoCodeId" = pc."id") AS bookings,
       (SELECT COUNT(*) FROM "PromoRedemption" r WHERE r."promoCodeId" = pc."id") AS redemptions
FROM "PromoCode" pc WHERE pc."code" = '';
-- STEP 6 — usedCount deltas (read-only, D5-S13): every promo whose
-- recomputed count differs from its pre-run count — including
-- promos the dry run never listed.
SELECT 'usedCount-changed' AS issue, b."id", b."code",
       b."usedCount" AS before_count, pc."usedCount" AS after_count
FROM bf_promo_before b
JOIN "PromoCode" pc ON pc."id" = b."id"
WHERE pc."usedCount" <> b."usedCount";

COMMIT;
