-- ============================================================================
-- 08 — Cross-owner staff review list (Round 4, L-B5) — REPORT ONLY
-- ============================================================================
-- WHAT:   Staff hired under another owner's role BEFORE the allowed-roles
--         fix still hold that role's live permissions: the allowed-roles
--         filter and createStaff rejection gate only NEW assignments,
--         and jwt.strategy used to hand out user.role.permissions with
--         no VenueAllowedRole check at request time.
-- WHY REPORT-ONLY: revoking access blindly could lock legitimate staff
--         out mid-shift. The request-time check added in Round 5b
--         (jwt.strategy: an arena role owned by someone else grants
--         permissions ONLY when the holder staffs a venue of that
--         owner — otherwise permissions are zeroed, fail closed)
--         already neutralises the leak at runtime. This script lists
--         exactly the affected users so an admin can re-point each one
--         to a correct role deliberately, then verify the list is empty.
-- DRY RUN = THE WHOLE SCRIPT (read-only, no writes at all):
--   Users whose role.ownerId is neither NULL nor the owner of a venue
--   they staff (VenueStaff), plus the VenueAllowedRole rows that let
--   those cross-owner roles into venues.
-- RE-POINT PROCEDURE (manual, per user): in the panel (or SQL), set
--   the user's role to a system role (ownerId NULL) or to a role owned
--   by the owner of the venue they staff, and remove the cross-owner
--   VenueAllowedRole rows for that venue. Re-run this script to verify.
-- RUN:    psql "$DATABASE_URL" -f 08-cross-owner-staff.sql
-- ============================================================================

-- Users holding a foreign owner's arena role without staffing any venue
-- of that owner (these users get ZERO permissions from the Round 5b
-- request-time check until re-pointed).
SELECT u."id" AS user_id, u."email", u."name",
       r."id" AS role_id, r."name" AS role_name, r."ownerId" AS role_owner_id,
       ro."email" AS role_owner_email
FROM "User" u
JOIN "Role" r ON r."id" = u."roleId"
LEFT JOIN "User" ro ON ro."id" = r."ownerId"
WHERE r."ownerId" IS NOT NULL
  AND r."ownerId" <> u."id"
  AND NOT EXISTS (
    SELECT 1 FROM "VenueStaff" vs
    JOIN "Venue" v ON v."id" = vs."venueId"
    WHERE vs."userId" = u."id" AND v."ownerId" = r."ownerId"
  )
ORDER BY ro."email", u."email";

-- VenueAllowedRole rows attaching a foreign owner's role to a venue
-- whose owner is not that role's owner.
SELECT var."venueId", v."name" AS venue_name, v."ownerId" AS venue_owner_id,
       var."roleId", r."name" AS role_name, r."ownerId" AS role_owner_id
FROM "VenueAllowedRole" var
JOIN "Venue" v ON v."id" = var."venueId"
JOIN "Role" r ON r."id" = var."roleId"
WHERE r."ownerId" IS NOT NULL AND r."ownerId" <> v."ownerId"
ORDER BY v."name", r."name";
