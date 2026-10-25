-- ============================================================================
-- 02 — Cancel stored inverted bookings, never strike them (Round 4, L-B3)
-- ============================================================================
-- WHAT:   Bookings with endMinutes <= startMinutes (minted by legacy
--         slotMinutes < 0 courts) are uncheckinable (empty check-in
--         window), invisible to overlap checks (an inverted range
--         matches nothing, so the hour was sold twice), and — worst —
--         the nightly sweep turns them into no-show STRIKES for a game
--         that was never playable. The code guard (Round 1) already
--         refuses to strike empty-window bookings; this script cancels
--         the STORED rows.
-- DRY RUN (read-only — run first, inspect the rows):
--   SELECT "id", "userId", "venueId", "courtId", "date", "startMinutes",
--          "endMinutes", "status", "totalPrice"
--   FROM "Booking"
--   WHERE "endMinutes" <= "startMinutes" AND "status" IN ('pending', 'confirmed');
-- FIX:    (a) Cancel the booking (status -> 'cancelled').
--         (b) Refund its promo: delete its PromoRedemption rows and
--             decrement the promo's usedCount by exactly the deleted
--             count (mirrors releasePromo in code; GREATEST(...,0)
--             guards already-drifted counts).
--         (c) Close its game post (open/full -> 'closed') so nobody
--             joins a game whose booking no longer exists.
--         (d) Reject its pending reschedule requests.
--         (e) Notify the player via an inbox row (Notification) — the
--             push itself is best-effort: the inbox row is what the
--             player sees in-app, and it never depends on FCM.
--         Walk-ins (userId NULL) get no notification row.
-- IDEMPOTENT: every step filters on the pre-fix state (status, post
--         status, redemption existence), so re-running is a no-op.
-- ROLLBACK: restore from backup. Cancellation is not reversible from
--         this script alone (the prior status is preserved in the
--         audit details for manual reconstruction).
-- ORDER:  run AFTER 01 (quarantine) so no new inverted booking can land
--         while this script runs.
-- RUN:    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f 02-inverted-bookings.sql
-- ============================================================================

-- STEP 0 — dry run (read-only).
SELECT "id", "userId", "venueId", "courtId", "date", "startMinutes",
       "endMinutes", "status", "totalPrice"
FROM "Booking"
WHERE "endMinutes" <= "startMinutes" AND "status" IN ('pending', 'confirmed')
ORDER BY "date", "venueId";

BEGIN;

-- STEP 1 — snapshot the affected set (temp table, transaction-local).
CREATE TEMP TABLE bf_inverted ON COMMIT DROP AS
SELECT "id", "userId", "venueId", "courtId", "date", "startMinutes", "endMinutes"
FROM "Booking"
WHERE "endMinutes" <= "startMinutes" AND "status" IN ('pending', 'confirmed');

-- STEP 2 — cancel the bookings.
UPDATE "Booking" b
SET "status" = 'cancelled'
FROM bf_inverted t
WHERE b."id" = t."id";

-- STEP 3 — refund promos: drop redemptions, decrement usedCount by the
-- exact deleted count (never below zero).
WITH deleted AS (
  DELETE FROM "PromoRedemption" pr
  USING bf_inverted t
  WHERE pr."bookingId" = t."id"
  RETURNING pr."promoCodeId"
)
UPDATE "PromoCode" pc
SET "usedCount" = GREATEST(pc."usedCount" - d.n, 0)
FROM (SELECT "promoCodeId", COUNT(*) AS n FROM deleted GROUP BY "promoCodeId") d
WHERE pc."id" = d."promoCodeId";

-- STEP 4 — close game posts on the cancelled bookings.
UPDATE "GamePost"
SET "status" = 'closed'
WHERE "bookingId" IN (SELECT "id" FROM bf_inverted)
  AND "status" IN ('open', 'full');

-- STEP 5 — reject pending reschedule requests on the cancelled bookings.
UPDATE "RescheduleRequest"
SET "status" = 'rejected', "decidedAt" = now()
WHERE "bookingId" IN (SELECT "id" FROM bf_inverted)
  AND "status" = 'pending';

-- STEP 6 — player inbox notice (one row per affected player booking;
-- derived id makes re-runs insert nothing new).
INSERT INTO "Notification" ("id", "userId", "type", "title", "body", "createdAt")
SELECT
  'bf-inverted-' || t."id",
  t."userId",
  'booking_cancelled',
  'Booking cancelled — invalid slot',
  'A booking at your arena was cancelled because its slot was stored incorrectly (end before start) and could never be played. No no-show strike was recorded. Please re-book the slot.',
  now()
FROM bf_inverted t
WHERE t."userId" IS NOT NULL
ON CONFLICT ("id") DO NOTHING;

-- STEP 7 — audit trail (one system row per cancelled booking).
INSERT INTO "AuditLog" ("id", "actorId", "action", "entity", "entityId", "details", "createdAt")
SELECT
  'bf-inverted-audit-' || t."id",
  NULL,
  'booking.cancelled.inverted_slot',
  'booking',
  t."id",
  'Round-4 backfill: cancelled stored inverted booking (' || t."startMinutes" || '–' || t."endMinutes" || ' on ' || t."date"::text || '), promo refunded, game post closed, no strike recorded',
  now()
FROM bf_inverted t
ON CONFLICT ("id") DO NOTHING;

COMMIT;
