-- Round 5, P5-S7: rotation link for lost-response refresh replays.
-- replacedById is set ONLY when a session is revoked by a rotation,
-- pointing at the successor session. Logout revocations leave it NULL,
-- so the grace-replay path can never launder a logged-out token.
-- Additive + nullable: safe on any existing DB, no dedupe pre-check.
ALTER TABLE "RefreshSession" ADD COLUMN IF NOT EXISTS "replacedById" TEXT;
