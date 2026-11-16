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
--   -- Round 5, D5-B4: the old script stopped here, so inverted
--   -- bookings the pre-guard sweep already struck (no_show) or
--   -- auto-completed (completed) kept their strike / revenue.
--   -- Both are handled below now — inspect these too:
--   SELECT b."id", b."userId", b."venueId", b."courtId", b."date",
--          b."startMinutes", b."endMinutes", b."status", b."totalPrice",
--          u."noShowCount"
--   FROM "Booking" b LEFT JOIN "User" u ON u."id" = b."userId"
--   WHERE b."endMinutes" <= b."startMinutes" AND b."status" IN ('no_show', 'completed');
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
--         (f) Round 5, D5-B4: inverted bookings already in no_show
--             get their strike REVERSED (User.noShowCount -1 per
--             booking, floored at 0 — markNoShow increments exactly
--             once per booking, so one reversal per booking is exact)
--             and are cancelled like the rest. Inverted bookings
--             already in completed are REPORTED ONLY, never cancelled
--             (Round 5, R3 decision): a played game cannot be
--             un-played — cancelling a completed booking would
--             rewrite history (revenue, reviews, strikes already
--             settled around it) for a slot that, however it was
--             stored, was treated as played. The leftover report
--             (STEP 8b) lists them for operator review instead.
--             Suspension state is deliberately NOT auto-reversed: a
--             suspension may have other causes, so the audit row
--             flags it for operator review instead.
--         (g) Round 5, D5-S6: every write re-checks the snapshotted
--             status — a booking legitimately completed (or otherwise
--             resolved) between the snapshot and the write is NOT
--             overwritten to cancelled, and is listed by the final
--             report step instead.
-- IDEMPOTENT: every step filters on the pre-fix state (status, post
--         status, redemption existence), so re-running is a no-op.
-- ROLLBACK: restore from backup. Cancellation is not reversible from
--         this script alone (the prior status is preserved in the
--         audit details for manual reconstruction).
-- ORDER:  run AFTER 01 (quarantine) so no new inverted booking can land
--         while this script runs.
-- RUN:    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f 02-inverted-bookings.sql
-- ============================================================================

-- Round 5, D5-T3 guard — ABORTS before anything is written if any
-- ACTIVE slotMinutes <= 0 court remains (i.e. backfill 01 has not
-- been run, or a new bad court appeared since). The code guards
-- already refuse new bookings on such courts, so this is an
-- ordering enforcement, not a data repair: run 01 first, then 02.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "Court" WHERE "slotMinutes" <= 0 AND "isActive" = true) THEN
    RAISE EXCEPTION 'Backfill 02 aborted: % active court(s) with slotMinutes <= 0 remain — run prisma/backfills/01-bad-slotminutes-courts.sql first (backfill 01), then re-run this script.',
      (SELECT COUNT(*) FROM "Court" WHERE "slotMinutes" <= 0 AND "isActive" = true);
  END IF;
END $$;

-- STEP 0 — dry run (read-only).
SELECT "id", "userId", "venueId", "courtId", "date", "startMinutes",
       "endMinutes", "status", "totalPrice"
FROM "Booking"
WHERE "endMinutes" <= "startMinutes" AND "status" IN ('pending', 'confirmed')
ORDER BY "date", "venueId";
-- Already-struck / already-completed inverted bookings (D5-B4).
SELECT b."id", b."userId", b."venueId", b."courtId", b."date",
       b."startMinutes", b."endMinutes", b."status", b."totalPrice",
       u."noShowCount"
FROM "Booking" b LEFT JOIN "User" u ON u."id" = b."userId"
WHERE b."endMinutes" <= b."startMinutes" AND b."status" IN ('no_show', 'completed')
ORDER BY b."date", b."venueId";

BEGIN;

-- STEP 1 — snapshot the affected set (temp table, transaction-local).
-- All four live statuses: pending/confirmed (the original set) plus
-- no_show/completed (D5-B4). The prior status is kept so strike
-- reversal and audit rows can distinguish them.
CREATE TEMP TABLE bf_inverted ON COMMIT DROP AS
SELECT "id", "userId", "venueId", "courtId", "date", "startMinutes", "endMinutes",
       "status" AS prior_status
FROM "Booking"
WHERE "endMinutes" <= "startMinutes"
  AND "status" IN ('pending', 'confirmed', 'no_show', 'completed');

-- STEP 2 — cancel the bookings, but ONLY rows whose status still
-- equals the snapshot (D5-S6): a booking legitimately completed
-- between STEP 1 and here keeps its completion. Cancelled ids land
-- in bf_cancelled, and every later step gates on it — never on the
-- raw snapshot. Completed rows are EXCLUDED here (R3 decision,
-- see (f) above): they are reported in STEP 8b, never cancelled.
CREATE TEMP TABLE bf_cancelled ON COMMIT DROP AS
WITH cancelled AS (
  UPDATE "Booking" b
  SET "status" = 'cancelled'
  FROM bf_inverted t
  WHERE b."id" = t."id" AND b."status" = t.prior_status
    AND t.prior_status IN ('pending', 'confirmed', 'no_show')
  RETURNING b."id"
)
SELECT c."id" FROM cancelled c;

-- STEP 2b — reverse strikes for previously-struck inverted bookings
-- (D5-B4): one decrement per cancelled ex-no_show booking, floored
-- at 0. Suspension itself is NOT touched (it may have other causes)
-- — the audit row flags it for operator review.
UPDATE "User" u
SET "noShowCount" = GREATEST(u."noShowCount" - s.n, 0)
FROM (
  SELECT t."userId", COUNT(*)::int AS n
  FROM bf_inverted t
  WHERE t.prior_status = 'no_show'
    AND t."userId" IS NOT NULL
    AND t."id" IN (SELECT "id" FROM bf_cancelled)
  GROUP BY t."userId"
) s
WHERE u."id" = s."userId";

INSERT INTO "AuditLog" ("id", "actorId", "action", "entity", "entityId", "details", "createdAt")
SELECT
  'bf-inverted-strike-' || t."id",
  NULL,
  'booking.strike.reversed.inverted_slot',
  'booking',
  t."id",
  'Round-5 backfill: reversed the no-show strike for inverted booking (' || t."startMinutes" || '–' || t."endMinutes" || ' on ' || t."date"::text || ') — game was never playable. Suspension state (if any) NOT auto-reversed; operator to review.',
  now()
FROM bf_inverted t
WHERE t.prior_status = 'no_show'
  AND t."id" IN (SELECT "id" FROM bf_cancelled)
ON CONFLICT ("id") DO NOTHING;

-- STEP 3 — refund promos: drop redemptions, decrement usedCount by the
-- exact deleted count (never below zero). Gated on bf_cancelled.
WITH deleted AS (
  DELETE FROM "PromoRedemption" pr
  USING bf_cancelled c
  WHERE pr."bookingId" = c."id"
  RETURNING pr."promoCodeId"
)
UPDATE "PromoCode" pc
SET "usedCount" = GREATEST(pc."usedCount" - d.n, 0)
FROM (SELECT "promoCodeId", COUNT(*) AS n FROM deleted GROUP BY "promoCodeId") d
WHERE pc."id" = d."promoCodeId";

-- STEP 4 — close game posts on the cancelled bookings.
UPDATE "GamePost"
SET "status" = 'closed'
WHERE "bookingId" IN (SELECT "id" FROM bf_cancelled)
  AND "status" IN ('open', 'full');

-- STEP 5 — reject pending reschedule requests on the cancelled bookings.
UPDATE "RescheduleRequest"
SET "status" = 'rejected', "decidedAt" = now()
WHERE "bookingId" IN (SELECT "id" FROM bf_cancelled)
  AND "status" = 'pending';

-- STEP 6 — player inbox notice (one row per affected player booking;
-- derived id makes re-runs insert nothing new). The body varies by
-- prior status so a struck player learns the strike was reversed.
INSERT INTO "Notification" ("id", "userId", "type", "title", "body", "createdAt")
SELECT
  'bf-inverted-' || t."id",
  t."userId",
  'booking_cancelled',
  'Booking cancelled — invalid slot',
  CASE t.prior_status
    WHEN 'no_show' THEN 'A booking at your arena was cancelled because its slot was stored incorrectly (end before start) and could never be played. The no-show strike recorded for it has been reversed. Please re-book the slot.'
    ELSE 'A booking at your arena was cancelled because its slot was stored incorrectly (end before start) and could never be played. No no-show strike was recorded. Please re-book the slot.'
  END,
  now()
FROM bf_inverted t
WHERE t."userId" IS NOT NULL
  AND t."id" IN (SELECT "id" FROM bf_cancelled)
ON CONFLICT ("id") DO NOTHING;

-- STEP 7 — audit trail (one system row per cancelled booking, with
-- the prior status so no_show handling is reconstructable; completed
-- rows are not cancelled and appear only in the STEP 8b report).
INSERT INTO "AuditLog" ("id", "actorId", "action", "entity", "entityId", "details", "createdAt")
SELECT
  'bf-inverted-audit-' || t."id",
  NULL,
  'booking.cancelled.inverted_slot',
  'booking',
  t."id",
  'Round-4 backfill: cancelled stored inverted booking (' || t."startMinutes" || '–' || t."endMinutes" || ' on ' || t."date"::text || ', was ' || t.prior_status || '), promo refunded, game post closed' ||
  CASE WHEN t.prior_status = 'no_show' THEN ' (prior strike reversed; suspension NOT auto-reversed)'
       ELSE ' (no strike recorded)' END,
  now()
FROM bf_inverted t
WHERE t."id" IN (SELECT "id" FROM bf_cancelled)
ON CONFLICT ("id") DO NOTHING;

-- STEP 8 — report (read-only, before COMMIT drops the temp tables):
-- snapshotted rows whose status legitimately changed mid-run and
-- were therefore NOT overwritten (D5-S6). These need no action —
-- they resolved themselves — but the operator should see them.
SELECT 'skipped-status-changed' AS issue, t."id", t.prior_status,
       b."status" AS current_status
FROM bf_inverted t
JOIN "Booking" b ON b."id" = t."id"
WHERE t."id" NOT IN (SELECT "id" FROM bf_cancelled)
  AND t.prior_status <> 'completed';

-- STEP 8b — leftover report (read-only): completed inverted bookings
-- are deliberately NOT cancelled (R3 decision — a played game cannot
-- be un-played). These stay completed with their revenue/reviews
-- intact; the operator reviews them individually (e.g. whether the
-- slot was in fact played under a corrected grid) and takes no bulk
-- action from this script.
SELECT 'leftover-completed-inverted' AS issue, t."id", t."userId",
       t."venueId", t."courtId", t."date", t."startMinutes",
       t."endMinutes", u."noShowCount"
FROM bf_inverted t
LEFT JOIN "User" u ON u."id" = t."userId"
WHERE t.prior_status = 'completed'
ORDER BY t."date", t."venueId";

COMMIT;
