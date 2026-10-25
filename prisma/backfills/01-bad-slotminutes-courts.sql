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
-- DRY RUN (read-only — run first, inspect the rows). Round 5,
-- D5-S5: the dry run used to list ALL slotMinutes <= 0 courts while
-- the write only touched active ones, so the dry-run count never
-- matched the write count — the predicate below now matches STEP 1
-- exactly (active bad courts only).
--   SELECT "id", "venueId", "name", "slotMinutes", "isActive", "status"
--   FROM "Court" WHERE "slotMinutes" <= 0 AND "isActive" = true
--   ORDER BY "venueId", "name";
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

-- STEP 0 — dry run (read-only): list every court the write will touch.
SELECT "id", "venueId", "name", "slotMinutes", "isActive", "status"
FROM "Court"
WHERE "slotMinutes" <= 0 AND "isActive" = true
ORDER BY "venueId", "name";

BEGIN;

-- Snapshot the affected set FIRST (temp table, transaction-local):
-- the audit below must list exactly the courts STEP 1 changed. The
-- old audit selected all slotMinutes <= 0 courts AFTER the update,
-- so already-inactive courts (changed by nothing) got audit rows
-- claiming they were deactivated by this script.
CREATE TEMP TABLE bf_quarantined ON COMMIT DROP AS
SELECT "id", "slotMinutes"
FROM "Court"
WHERE "slotMinutes" <= 0 AND "isActive" = true;

-- STEP 1 — quarantine: deactivate every bad court that is still active.
UPDATE "Court"
SET "isActive" = false
WHERE "id" IN (SELECT "id" FROM bf_quarantined);

-- STEP 2 — audit trail (one system row per quarantined court; the id is
-- derived from the court id, so a re-run inserts nothing new).
INSERT INTO "AuditLog" ("id", "actorId", "action", "entity", "entityId", "details", "createdAt")
SELECT
  'bf-quarantine-' || q."id",
  NULL,
  'court.quarantined.bad_slot_minutes',
  'court',
  q."id",
  'Round-4 backfill: deactivated legacy court with slotMinutes=' || q."slotMinutes" || ' (bookings/availability refused by code guards; operator must set a sane slot length before reactivating)',
  now()
FROM bf_quarantined q
ON CONFLICT ("id") DO NOTHING;

COMMIT;

-- STEP 3 — operator follow-up (NOT run automatically): for each court above,
-- decide the correct slot length, move or cancel its bookings FIRST (see
-- 02-inverted-bookings.sql for the inverted ones), then:
--   UPDATE "Court" SET "slotMinutes" = <sane value, >= 15>, "isActive" = true
--   WHERE "id" = '<court id>';
