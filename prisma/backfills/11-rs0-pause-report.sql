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

-- Cancelled bookings at those venues, filtered to the pause → settle
-- window (Round 5, D5-S18). Booking has no cancelledAt column, so
-- updatedAt is used as a PROXY for cancellation time: a booking
-- whose last write falls between its venue's pause audit row and its
-- settle audit row is a plausible pause victim. Stated plainly, this
-- proxy is imperfect — a booking cancelled long before the pause and
-- edited inside the window (or a pause victim edited after the
-- settle) lands on the wrong side of the filter — so treat the list
-- as candidates for operator re-notification, not as proof.
SELECT b."id" AS booking_id, b."venueId", b."userId", u."email" AS player_email,
       b."date", b."startMinutes", b."endMinutes", b."status",
       b."updatedAt" AS last_updated_at
FROM "Booking" b
LEFT JOIN "User" u ON u."id" = b."userId"
WHERE b."status" = 'cancelled'
  AND EXISTS (
    SELECT 1 FROM "AuditLog" a
    JOIN "AuditLog" p
      ON p."entityId" = a."entityId"
      AND p."action" = 'venue.billing.paused'
      AND p."createdAt" < a."createdAt"
    WHERE a."action" = 'venue.billing.auto_settled'
      AND a."entityId" = b."venueId"
      AND b."updatedAt" > p."createdAt"
      AND b."updatedAt" < a."createdAt"
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
-- D5-S19) — REGARDLESS of current billingPaused / status: a venue
-- paused over Rs 0 debt and later manually resumed (mark-paid /
-- extend, no auto_settled row), or still paused / suspended /
-- non-approved (which "wait out" the cycle), carries the same harm
-- and was invisible to the old report, which required a settle row.
-- Current state is shown, not filtered on, so the operator can tell
-- a still-paused venue from an already-resumed one.
SELECT DISTINCT p."entityId" AS venue_id, v."name" AS venue_name,
       v."status" AS venue_status, v."billingPaused" AS currently_paused,
       MAX(p."createdAt") AS latest_paused_at,
       v."billingPaidUntil" AS paid_until_now
FROM "AuditLog" p
JOIN "Venue" v ON v."id" = p."entityId"
WHERE p."action" = 'venue.billing.paused'
  AND NOT EXISTS (
    SELECT 1 FROM "AuditLog" a2
    WHERE a2."entityId" = p."entityId"
      AND a2."action" = 'venue.billing.auto_settled'
      AND a2."createdAt" > p."createdAt"
  )
GROUP BY p."entityId", v."name", v."status", v."billingPaused", v."billingPaidUntil"
ORDER BY latest_paused_at;

-- Cancelled bookings at those never-settled paused venues (same
-- updatedAt proxy as above, but open-ended: any cancellation whose
-- last write falls after the venue's latest pause with no settle
-- after it). The harm is identical to the settled set — bookings
-- cancelled by a pause that was never auto-healed — so these
-- players need the same re-booking conversation.
SELECT b."id" AS booking_id, b."venueId", b."userId", u."email" AS player_email,
       b."date", b."startMinutes", b."endMinutes", b."status",
       b."updatedAt" AS last_updated_at
FROM "Booking" b
LEFT JOIN "User" u ON u."id" = b."userId"
WHERE b."status" = 'cancelled'
  AND EXISTS (
    SELECT 1 FROM "AuditLog" p
    WHERE p."entityId" = b."venueId"
      AND p."action" = 'venue.billing.paused'
      AND b."updatedAt" > p."createdAt"
      AND NOT EXISTS (
        SELECT 1 FROM "AuditLog" a2
        WHERE a2."entityId" = b."venueId"
          AND a2."action" = 'venue.billing.auto_settled'
          AND a2."createdAt" > p."createdAt"
      )
  )
ORDER BY b."venueId", b."date";
