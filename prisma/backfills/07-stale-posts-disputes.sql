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

-- STEP 1 — close stale posts.
UPDATE "GamePost" gp
SET "status" = 'closed'
FROM "Booking" b
WHERE gp."bookingId" = b."id"
  AND gp."status" IN ('open', 'full')
  AND b."status" = 'cancelled';

-- STEP 2 — dismiss null-booking disputes (dismiss-only path).
UPDATE "Dispute"
SET "status" = 'dismissed',
    "resolution" = 'Bulk-dismissed by Round-4 backfill: no booking attached, so no-show cannot be confirmed.',
    "resolvedAt" = now()
WHERE "bookingId" IS NULL AND "status" = 'open';

COMMIT;
