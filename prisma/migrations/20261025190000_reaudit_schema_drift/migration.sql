-- Re-audit schema drift (Oct 25): these schema.prisma fields were added
-- in the re-audit round without a migration file, which is why
-- `prisma migrate dev` prompted for a new migration after the other
-- 11 folders applied:
--   Venue.createdById / Venue.frozenPlanId (new columns)
--   Dispute.bookingId + AuditLog.actorId nullable, FKs re-created
--   ON DELETE SET NULL (previously required + old FK actions)
-- Every statement is guarded (IF NOT EXISTS / IF EXISTS / pg_constraint
-- checks), so this is safe on migrate-dev DBs AND on db-push-built DBs
-- (fresh-install path resolves it --applied; see docs/DEPLOY.md §1).
-- Mirrors the `migrate diff --from-migrations` output verbatim in
-- effect (25 lines: 2 FK drops, 2 nullability drops, 2 column adds,
-- 3 FK adds).

ALTER TABLE "AuditLog" DROP CONSTRAINT IF EXISTS "AuditLog_actorId_fkey";
ALTER TABLE "Dispute" DROP CONSTRAINT IF EXISTS "Dispute_bookingId_fkey";

ALTER TABLE "AuditLog" ALTER COLUMN "actorId" DROP NOT NULL;
ALTER TABLE "Dispute" ALTER COLUMN "bookingId" DROP NOT NULL;

ALTER TABLE "Venue" ADD COLUMN IF NOT EXISTS "createdById" TEXT;
ALTER TABLE "Venue" ADD COLUMN IF NOT EXISTS "frozenPlanId" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Venue_frozenPlanId_fkey') THEN
    ALTER TABLE "Venue" ADD CONSTRAINT "Venue_frozenPlanId_fkey" FOREIGN KEY ("frozenPlanId") REFERENCES "Plan"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Dispute_bookingId_fkey') THEN
    ALTER TABLE "Dispute" ADD CONSTRAINT "Dispute_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AuditLog_actorId_fkey') THEN
    ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
