-- ============================================================================
-- 11 — Rs 0 auto-settle pause report (Round 4, L-S4) — REPORT ONLY
-- ============================================================================
-- WHAT:   The sweep heals the FLAG but never the bookings a Rs 0 pause
--         cancelled: a venue paused pre-fix over Rs 0 debt with 10
--         upcoming bookings cancelled, then auto-settled and un-paused,
--         returns "live" with an empty calendar — the 10 cancelled
--         bookings stay cancelled and the players are never re-notified.
--         Pause-only design has no resume/restore path, so there is no
--         safe bulk "undo": re-booking is an operator conversation with
--         each affected player (their slot may since have been re-sold).
--         Venues whose owner is suspended, or whose status is not
--         `approved`, wait out an unsuspend → pending → approve cycle
--         before the sweep even sees them.
-- REPORT: venues the sweep auto-settled (audit action
--         venue.billing.auto_settled) that had previously been paused
--         by the sweep (venue.billing.paused), with their cancelled
--         bookings listed for manual re-booking/notice.
-- RUN:    psql "$DATABASE_URL" -f 11-rs0-pause-report.sql
-- ============================================================================

-- Venues auto-settled after a prior sweep pause (the L-S4 pattern).
SELECT DISTINCT a."entityId" AS venue_id, v."name" AS venue_name,
       v."status" AS venue_status, v."billingPaused" AS currently_paused,
       MIN(p."createdAt") AS first_paused_at, MIN(a."createdAt") AS first_settled_at
FROM "AuditLog" a
JOIN "AuditLog" p
  ON p."entityId" = a."entityId"
  AND p."action" = 'venue.billing.paused'
  AND p."createdAt" < a."createdAt"
JOIN "Venue" v ON v."id" = a."entityId"
WHERE a."action" = 'venue.billing.auto_settled'
GROUP BY a."entityId", v."name", v."status", v."billingPaused"
ORDER BY first_settled_at;

-- Cancelled bookings at those venues, between the pause and the
-- settle (the bookings the operator must re-book/notify manually).
SELECT b."id" AS booking_id, b."venueId", b."userId", u."email" AS player_email,
       b."date", b."startMinutes", b."endMinutes", b."status"
FROM "Booking" b
LEFT JOIN "User" u ON u."id" = b."userId"
WHERE b."status" = 'cancelled'
  AND b."venueId" IN (
    SELECT DISTINCT a."entityId"
    FROM "AuditLog" a
    JOIN "AuditLog" p
      ON p."entityId" = a."entityId"
      AND p."action" = 'venue.billing.paused'
      AND p."createdAt" < a."createdAt"
    WHERE a."action" = 'venue.billing.auto_settled'
  )
ORDER BY b."venueId", b."date";
