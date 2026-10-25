-- ============================================================================
-- 03 — Dedupe legacy courts / roles (Round 4, M-B3 + L-B6)
-- ============================================================================
-- WHAT:   Two index migrations fail on duplicates, which blocks the whole
--         deploy (later migrations never land):
--           * Court(venueId, lower(name)) — "Turf A" vs "turf a" in one
--             venue, AND trailing-space pairs ("Turf A" vs "Turf A ")
--             which pass the index (lower() does not trim) but fail the
--             code check (assertCourtNameFree trims).
--           * Role system names, case-insensitive (Round 2) — "coach"
--             vs "Coach", and case-variant "Super_Admin" which evades
--             every last-admin guard (all guards compare exact
--             'super_admin').
-- DRY RUN (read-only — run first):
--   SELECT "venueId", lower(btrim("name")) AS key, COUNT(*),
--          string_agg("name", ' | ' ORDER BY "createdAt") AS variants
--   FROM "Court" GROUP BY 1, 2 HAVING COUNT(*) > 1;
--   SELECT lower(btrim("name")) AS key, COUNT(*),
--          string_agg("name", ' | ' ORDER BY "createdAt") AS variants
--   FROM "Role" WHERE "ownerId" IS NULL GROUP BY 1 HAVING COUNT(*) > 1;
--   SELECT "ownerId", lower(btrim("name")) AS key, COUNT(*)
--   FROM "Role" WHERE "ownerId" IS NOT NULL
--   GROUP BY 1, 2 HAVING COUNT(*) > 1;
-- FIX:    Courts are RENAMED, never deleted (Booking.court has no
--         onDelete — deleting a court with bookings fails on the FK).
--         Roles are RE-POINTED first (users + VenueAllowedRole), then
--         the emptied duplicates are deleted (User.role has no
--         onDelete, so a bare DELETE would fail — re-pointing first is
--         the whole procedure). Security-sensitive system names
--         (super_admin/owner/staff/player) are normalised to lowercase
--         on the keeper, so no case-variant can evade the guards again;
--         other role names keep the keeper's original casing.
-- IDEMPOTENT: every step filters on the duplicate state, so re-running
--         is a no-op. A rename whose target name already exists in the
--         venue is SKIPPED (not forced) and listed by the final report
--         query for manual resolution.
-- ROLLBACK: restore from backup. Renames are recorded in AuditLog rows
--         (details carry the old name) for manual reversal.
-- ORDER:  run BEFORE `prisma migrate deploy` (the index migrations fail
--         until this is clean). Also run scripts/predeploy-check.js.
-- RUN:    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f 03-dedupe-courts-roles.sql
-- ============================================================================

-- STEP 0 — dry run (read-only): show every duplicate group.
SELECT "venueId", lower(btrim("name")) AS key, COUNT(*) AS n,
       string_agg("name", ' | ' ORDER BY "createdAt") AS variants
FROM "Court" GROUP BY 1, 2 HAVING COUNT(*) > 1;
SELECT lower(btrim("name")) AS key, COUNT(*) AS n,
       string_agg("name", ' | ' ORDER BY "createdAt") AS variants
FROM "Role" WHERE "ownerId" IS NULL GROUP BY 1 HAVING COUNT(*) > 1;
SELECT "ownerId", lower(btrim("name")) AS key, COUNT(*) AS n
FROM "Role" WHERE "ownerId" IS NOT NULL GROUP BY 1, 2 HAVING COUNT(*) > 1;

BEGIN;

-- STEP 1 — courts: rank duplicates per (venue, trimmed-lower name).
CREATE TEMP TABLE bf_court_dups ON COMMIT DROP AS
SELECT
  "id", "venueId", "name",
  ROW_NUMBER() OVER (
    PARTITION BY "venueId", lower(btrim("name")) ORDER BY "createdAt" ASC, "id" ASC
  ) AS rn
FROM "Court"
WHERE ("venueId", lower(btrim("name"))) IN (
  SELECT "venueId", lower(btrim("name")) FROM "Court"
  GROUP BY 1, 2 HAVING COUNT(*) > 1
);

-- Rename every non-keeper (rn > 1) to "<trimmed name> (dup <rn>)",
-- unless that target already exists in the venue (then skip — the
-- final report lists it for manual resolution). Renamed ids are
-- captured in bf_court_renamed FIRST (Round 5, D5-S7): the old audit
-- filtered on names LIKE '% (dup %)' AFTER the rename, so a skipped
-- rename whose original name already contained "(dup …)" got a
-- FALSE "renamed" audit row, and that consumed audit id then
-- suppressed the TRUE audit row if the court was later really
-- renamed (ON CONFLICT DO NOTHING). The audit below reads only
-- from the actually-renamed set (rows the UPDATE touched with a
-- changed value), so neither failure can recur.
CREATE TEMP TABLE bf_court_renamed ON COMMIT DROP AS
WITH renamed AS (
  UPDATE "Court" c
  SET "name" = btrim(c."name") || ' (dup ' || d.rn || ')'
  FROM bf_court_dups d
  WHERE c."id" = d."id" AND d.rn > 1
    AND c."name" IS DISTINCT FROM btrim(c."name") || ' (dup ' || d.rn || ')'
    AND NOT EXISTS (
      SELECT 1 FROM "Court" x
      WHERE x."venueId" = c."venueId"
        AND lower(btrim(x."name")) = lower(btrim(c."name") || ' (dup ' || d.rn || ')')
    )
  RETURNING c."id" AS "id", c."name" AS new_name
)
SELECT r."id", d."name" AS old_name, r.new_name, d."venueId"
FROM renamed r JOIN bf_court_dups d ON d."id" = r."id";

INSERT INTO "AuditLog" ("id", "actorId", "action", "entity", "entityId", "details", "createdAt")
SELECT
  'bf-dedupe-court-' || r."id",
  NULL, 'court.renamed.duplicate', 'court', r."id",
  'Round-4 backfill: renamed duplicate court "' || r.old_name || '" (venue ' || r."venueId" || ') to "' || r.new_name || '" to resolve a name collision',
  now()
FROM bf_court_renamed r
ON CONFLICT ("id") DO NOTHING;

-- STEP 2 — roles: rank duplicates. System roles group by trimmed-lower
-- name; owner roles group by (owner, trimmed-lower name). Keeper = the
-- row whose name is already canonical (exact lowercase, trimmed) if
-- one exists, else the earliest created — with "id" as the final
-- tie-break (Round 5, D5-S8): two case-variant roles created in the
-- same seeding millisecond used to tie on createdAt, making the
-- keeper (and therefore which permission set all merged users ended
-- up with) arbitrary. The discarded permission sets are recorded in
-- the audit details below, so the merge is reconstructable.
CREATE TEMP TABLE bf_role_dups ON COMMIT DROP AS
SELECT
  "id", "ownerId", "name", "permissions",
  ROW_NUMBER() OVER (
    PARTITION BY "ownerId", lower(btrim("name"))
    ORDER BY CASE WHEN "name" = lower(btrim("name")) THEN 0 ELSE 1 END,
             "createdAt" ASC, "id" ASC
  ) AS rn,
  FIRST_VALUE("id") OVER (
    PARTITION BY "ownerId", lower(btrim("name"))
    ORDER BY CASE WHEN "name" = lower(btrim("name")) THEN 0 ELSE 1 END,
             "createdAt" ASC, "id" ASC
  ) AS keeper_id
FROM "Role"
WHERE ("ownerId", lower(btrim("name"))) IN (
  SELECT "ownerId", lower(btrim("name")) FROM "Role"
  GROUP BY 1, 2 HAVING COUNT(*) > 1
);

-- Re-point users from duplicates to their keeper.
UPDATE "User" u
SET "roleId" = d.keeper_id
FROM bf_role_dups d
WHERE u."roleId" = d."id" AND d.rn > 1 AND d."id" <> d.keeper_id;

-- Re-point VenueAllowedRole rows (insert keeper rows, ignore conflicts
-- where the keeper is already allowed at that venue, then drop dup rows).
INSERT INTO "VenueAllowedRole" ("venueId", "roleId")
SELECT var."venueId", d.keeper_id
FROM "VenueAllowedRole" var
JOIN bf_role_dups d ON var."roleId" = d."id"
WHERE d.rn > 1 AND d."id" <> d.keeper_id
ON CONFLICT ("venueId", "roleId") DO NOTHING;

DELETE FROM "VenueAllowedRole" var
USING bf_role_dups d
WHERE var."roleId" = d."id" AND d.rn > 1 AND d."id" <> d.keeper_id;

-- Normalise security-sensitive keeper names to lowercase so no
-- case-variant can evade the exact-match last-admin guards again.
UPDATE "Role" r
SET "name" = lower(btrim(r."name"))
FROM bf_role_dups d
WHERE r."id" = d.keeper_id AND d.rn = 1
  AND lower(btrim(r."name")) IN ('super_admin', 'owner', 'staff', 'player')
  AND r."name" <> lower(btrim(r."name"));

-- Delete the emptied duplicates (zero users + zero allowed rows now,
-- by construction — the WHERE clause re-verifies instead of assuming).
DELETE FROM "Role" r
USING bf_role_dups d
WHERE r."id" = d."id" AND d.rn > 1 AND d."id" <> d.keeper_id
  AND NOT EXISTS (SELECT 1 FROM "User" u WHERE u."roleId" = r."id")
  AND NOT EXISTS (SELECT 1 FROM "VenueAllowedRole" v WHERE v."roleId" = r."id");

INSERT INTO "AuditLog" ("id", "actorId", "action", "entity", "entityId", "details", "createdAt")
SELECT
  'bf-dedupe-role-' || d."id",
  NULL, 'role.merged.duplicate', 'role', d.keeper_id,
  'Round-4 backfill: merged duplicate role "' || d."name" || '" (permissions ' || (d."permissions")::text || ') into keeper ' || d.keeper_id || ' (permissions ' || (k."permissions")::text || '; users + allowed venues re-pointed)',
  now()
FROM bf_role_dups d
JOIN bf_role_dups k ON k."id" = d.keeper_id
WHERE d.rn > 1
  -- Only duplicates actually deleted above (the DELETE re-verifies
  -- emptiness; a row that survived it must not get a "merged" audit).
  AND NOT EXISTS (SELECT 1 FROM "Role" r WHERE r."id" = d."id")
ON CONFLICT ("id") DO NOTHING;

COMMIT;

-- STEP 3 — report leftovers (read-only): any group still duplicated
-- needs manual resolution (usually a rename-target collision).
SELECT 'court' AS kind, "venueId", lower(btrim("name")) AS key, COUNT(*) AS n
FROM "Court" GROUP BY 1, 2, 3 HAVING COUNT(*) > 1;
SELECT 'role-system' AS kind, NULL AS "venueId", lower(btrim("name")) AS key, COUNT(*) AS n
FROM "Role" WHERE "ownerId" IS NULL GROUP BY 1, 2, 3 HAVING COUNT(*) > 1;
SELECT 'role-owner' AS kind, "ownerId" AS "venueId", lower(btrim("name")) AS key, COUNT(*) AS n
FROM "Role" WHERE "ownerId" IS NOT NULL GROUP BY 1, 2, 3 HAVING COUNT(*) > 1;
