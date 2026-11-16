-- Court names are unique per venue (case-insensitive). The code-level
-- check (assertCourtNameFree) can be raced by two simultaneous creates;
-- this index is the backstop, and both createCourt paths map its P2002
-- to a clean 409 instead of a raw 500.
-- NOTE: this migration FAILS if duplicate court names already exist
-- within one venue (case-insensitive) — dedupe them before applying.
CREATE UNIQUE INDEX "Court_venue_name_ci_key" ON "Court"("venueId", (lower("name")));
