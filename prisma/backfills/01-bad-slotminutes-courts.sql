-- ============================================================================
-- 01 — Quarantine legacy courts with slotMinutes <= 0 (Round 4, L-B1/L-B2)
-- ============================================================================
-- WHAT:   Courts created before the slotMinutes >= 15 floor (Round 1 of the
--         edge-case fix program) can carry slotMinutes = 0 or NEGATIVE.
--         slotMinutes = 0 fails closed by accident (modulo yields NaN);
--         slotMinutes < 0 mints NEW free, inverted bookings (end < start)
--         and hangs availability forever (the loop step never advances).
--         The code guards added in Round 1 already refuse NEW bookings
--         and availability on such courts; this script quarantines the
--         STORED rows so they stop appearing as bookable anywhere.
-- DRY RUN (read-only — run first, inspect the rows):
--   SELECT "id", "venueId", "name", "slotMinutes", "isActive", "status"
--   FROM "Court" WHERE "slotMinutes" <= 0 ORDER BY "venueId", "name";
-- FIX:    Deactivate (isActive = false) — NEVER delete: Booking.court has
--         no onDelete, so deleting a court with bookings fails on the FK.
--         Deactivation hides the court from players while its history
--         survives. Setting a sane slotMinutes is an OPERATOR decision
--         (it re-grids the court and strands off-grid bookings), so the
--         script does NOT guess a value — after deactivating, fix the
--         value in the panel (or the UPDATE below, uncommented) and
--         reactivate once 02-inverted-bookings.sql has cancelled the
--         inverted bookings on that court.
-- IDEMPOTENT: re-running affects zero rows (already inactive courts are
--         excluded by the WHERE clause).
-- ROLLBACK: restore from backup, or re-activate with:
--   UPDATE "Court" SET "isActive" = true WHERE "id" IN (...);
-- RUN:    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f 01-bad-slotminutes-courts.sql
-- ============================================================================

-- STEP 0 — dry run (read-only): list every affected court.
SELECT "id", "venueId", "name", "slotMinutes", "isActive", "status"
FROM "Court"
WHERE "slotMinutes" <= 0
ORDER BY "venueId", "name";

BEGIN;

-- STEP 1 — quarantine: deactivate every bad court that is still active.
UPDATE "Court"
SET "isActive" = false
WHERE "slotMinutes" <= 0 AND "isActive" = true;

-- STEP 2 — audit trail (one system row per quarantined court; the id is
-- derived from the court id, so a re-run inserts nothing new).
INSERT INTO "AuditLog" ("id", "actorId", "action", "entity", "entityId", "details", "createdAt")
SELECT
  'bf-quarantine-' || c."id",
  NULL,
  'court.quarantined.bad_slot_minutes',
  'court',
  c."id",
  'Round-4 backfill: deactivated legacy court with slotMinutes=' || c."slotMinutes" || ' (bookings/availability refused by code guards; operator must set a sane slot length before reactivating)',
  now()
FROM "Court" c
WHERE c."slotMinutes" <= 0
ON CONFLICT ("id") DO NOTHING;

COMMIT;

-- STEP 3 — operator follow-up (NOT run automatically): for each court above,
-- decide the correct slot length, move or cancel its bookings FIRST (see
-- 02-inverted-bookings.sql for the inverted ones), then:
--   UPDATE "Court" SET "slotMinutes" = <sane value, >= 15>, "isActive" = true
--   WHERE "id" = '<court id>';
