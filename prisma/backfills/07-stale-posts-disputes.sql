-- ============================================================================
-- 07 — Close stale game posts + dismiss null-booking disputes
--     (Round 4, L-S9 + L-S10)
-- ============================================================================
-- WHAT:   (a) Game posts on bookings cancelled BEFORE game-post cleanup
--         existed are still joinable: join checks post status, venue
--         liveness and date — never booking.status (Round 2 added the
--         check for NEW joins; stored posts are still open). A player
--         joins, is accepted, and shows up to a game whose court
--         booking no longer exists.
--         (b) A null-bookingId dispute can never be confirmed
--         (confirm_no_show throws "Dispute has no booking"), and the
--         admin wrapper had no null guard (Round 2 added the guard +
--         dismiss path for new actions; stored rows still sit in the
--         open queue).
-- DRY RUN (read-only — run first):
--   SELECT gp."id", gp."bookingId", gp."status", b."status" AS booking_status
--   FROM "GamePost" gp JOIN "Booking" b ON b."id" = gp."bookingId"
--   WHERE gp."status" IN ('open', 'full') AND b."status" = 'cancelled';
--   SELECT "id", "reason", "status" FROM "Dispute"
--   WHERE "bookingId" IS NULL AND "status" = 'open';
-- FIX:    (a) Close (never delete — status stays truthful for history)
--         open/full posts whose booking is cancelled. Curated posts
--         (bookingId NULL) are NOT touched — they have no booking to
--         be cancelled.
--         (b) Bulk-dismiss open null-booking disputes with a clear
--         resolution note. Dismiss is the only honest terminal state
--         for them: there is no booking to confirm a no-show against.
-- IDEMPOTENT: both steps filter on the pre-fix state.
-- ROLLBACK: restore from backup. Closed posts can be re-opened by an
--         admin if a booking is ever reinstated; dismissed disputes
--         cannot be re-opened by design (one dispute per booking ever
--         after terminal resolution — and these have no booking).
-- RUN:    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f 07-stale-posts-disputes.sql
-- ============================================================================

-- STEP 0 — dry run (read-only).
SELECT gp."id", gp."bookingId", gp."status", b."status" AS booking_status
FROM "GamePost" gp JOIN "Booking" b ON b."id" = gp."bookingId"
WHERE gp."status" IN ('open', 'full') AND b."status" = 'cancelled';
SELECT "id", "reason", "status" FROM "Dispute"
WHERE "bookingId" IS NULL AND "status" = 'open';

BEGIN;

-- Snapshot both affected sets FIRST (temp tables, transaction-local),
-- so the audit rows below list exactly what this run changed with
-- its prior status (Round 5, D5-S14: the old script closed posts
-- and dismissed disputes with ZERO audit rows, so the header's
-- "can be re-opened by an admin" rollback for posts was unusable —
-- there was no durable list of which posts were closed).
CREATE TEMP TABLE bf_07_posts ON COMMIT DROP AS
SELECT gp."id", gp."status" AS old_status
FROM "GamePost" gp JOIN "Booking" b ON b."id" = gp."bookingId"
WHERE gp."status" IN ('open', 'full') AND b."status" = 'cancelled';
CREATE TEMP TABLE bf_07_disputes ON COMMIT DROP AS
SELECT "id", "status" AS old_status
FROM "Dispute"
WHERE "bookingId" IS NULL AND "status" = 'open';

-- STEP 1 — close stale posts.
UPDATE "GamePost" gp
SET "status" = 'closed'
WHERE gp."id" IN (SELECT "id" FROM bf_07_posts);

-- STEP 2 — dismiss null-booking disputes (dismiss-only path).
UPDATE "Dispute"
SET "status" = 'dismissed',
    "resolution" = 'Bulk-dismissed by Round-4 backfill: no booking attached, so no-show cannot be confirmed.',
    "resolvedAt" = now()
WHERE "id" IN (SELECT "id" FROM bf_07_disputes);

-- STEP 3 — audit rows (one per closed post / dismissed dispute, with
-- the prior status, inside the same transaction).
INSERT INTO "AuditLog" ("id", "actorId", "action", "entity", "entityId", "details", "createdAt")
SELECT
  'bf-stale-post-' || p."id",
  NULL, 'game_post.closed.stale_booking', 'game_post', p."id",
  'Round-4 backfill: closed game post (was ' || p.old_status || ') whose booking is cancelled — re-openable by an admin if the booking is ever reinstated',
  now()
FROM bf_07_posts p
ON CONFLICT ("id") DO NOTHING;
INSERT INTO "AuditLog" ("id", "actorId", "action", "entity", "entityId", "details", "createdAt")
SELECT
  'bf-null-dispute-' || d."id",
  NULL, 'dispute.dismissed.no_booking', 'dispute', d."id",
  'Round-4 backfill: bulk-dismissed open dispute with no booking attached (was ' || d.old_status || ') — no-show cannot be confirmed without a booking',
  now()
FROM bf_07_disputes d
ON CONFLICT ("id") DO NOTHING;

COMMIT;
