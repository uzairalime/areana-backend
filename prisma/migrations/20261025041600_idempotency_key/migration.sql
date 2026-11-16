-- Idempotency records for destructive admin mutations (mark-paid,
-- suspend/unsuspend, role create, plan assign, user status). Written in
-- the standard Prisma layout for the IdempotencyKey model so `prisma
-- migrate dev` finds no drift after applying it.
CREATE TABLE "IdempotencyKey" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "response" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IdempotencyKey_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "IdempotencyKey_scope_actorId_key_key" ON "IdempotencyKey"("scope", "actorId", "key");

CREATE INDEX "IdempotencyKey_createdAt_idx" ON "IdempotencyKey"("createdAt");
