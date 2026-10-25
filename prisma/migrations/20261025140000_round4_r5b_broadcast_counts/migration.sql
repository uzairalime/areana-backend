-- Round-4 fix Round 5b (P-B1): record ACTUAL broadcast delivery, not just
-- the pre-send token count. New nullable-with-default columns only, so
-- this migration is safe on any existing DB (no dedupe pre-check needed).
-- Existing history rows keep delivered=0/failed=0 (unknown, not a lie:
-- pre-fix history recorded only `targeted`).
ALTER TABLE "Broadcast" ADD COLUMN IF NOT EXISTS "delivered" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Broadcast" ADD COLUMN IF NOT EXISTS "failed" INTEGER NOT NULL DEFAULT 0;
