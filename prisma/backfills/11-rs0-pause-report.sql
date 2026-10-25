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

-- Cancelled bookings at those venues (all cancelled bookings at the
-- venue — the operator filters to the pause window by booking date;
-- there is no cancelled-at column to scope this precisely).
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

-- Venues whose Venue.updatedAt falls between their sweep pause and
-- their auto-settle (Round 5, D5-S18: the stated proxy for "the
-- window did something" — a venue row touched mid-window, e.g. a
-- plan change or manual edit during the pause, that the settle
-- then papered over without comment).
SELECT DISTINCT a."entityId" AS venue_id, v."name" AS venue_name,
       p."createdAt" AS paused_at, a."createdAt" AS settled_at,
       v."updatedAt" AS venue_updated_at
FROM "AuditLog" a
JOIN "AuditLog" p
  ON p."entityId" = a."entityId"
 AND p."action" = 'venue.billing.paused'
 AND p."createdAt" < a."createdAt"
JOIN "Venue" v ON v."id" = a."entityId"
WHERE a."action" = 'venue.billing.auto_settled'
  AND v."updatedAt" > p."createdAt"
  AND v."updatedAt" < a."createdAt"
ORDER BY a."createdAt";

-- Venues paused by the sweep with NO later auto-settle (Round 5,
-- D5-S19): still paused today, the set an operator needs to chase
-- (payment, write-off, or manual resume). The old report required
-- a settle row, so these never appeared at all.
SELECT DISTINCT p."entityId" AS venue_id, v."name" AS venue_name,
       MAX(p."createdAt") AS latest_paused_at,
       v."billingPaidUntil" AS paid_until_now
FROM "AuditLog" p
JOIN "Venue" v ON v."id" = p."entityId"
WHERE p."action" = 'venue.billing.paused'
  AND v."billingPaused" = true
  AND NOT EXISTS (
    SELECT 1 FROM "AuditLog" a2
    WHERE a2."entityId" = p."entityId"
      AND a2."action" = 'venue.billing.auto_settled'
      AND a2."createdAt" > p."createdAt"
  )
GROUP BY p."entityId", v."name", v."billingPaidUntil"
ORDER BY latest_paused_at;
