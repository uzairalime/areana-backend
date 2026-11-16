-- Round 5, R5: review-reply edit history (no existing migration file touched).
-- Additive only: a JSON array column, default empty, so existing rows
-- need no backfill — a review with no edits simply has [].
ALTER TABLE "Review" ADD COLUMN IF NOT EXISTS "ownerReplyHistory" JSONB NOT NULL DEFAULT '[]';
