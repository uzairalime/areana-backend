-- Void reversals are unique per payment. The sequential double-void
-- guard (a findFirst for note = 'void:<paymentId>' before the
-- transaction) can be raced by two simultaneous voids: both pass the
-- check, both insert a -amount reversal, and the ledger nets -amount
-- for one payment. This partial index is the backstop, and voidPayment
-- maps its P2002 to the same 409 as the sequential path.
-- Only rows with method = 'void' are constrained; ordinary payments
-- (any note, including NULL) are unaffected. IF NOT EXISTS so a deploy
-- onto a DB where the index was applied by hand does not fail.
CREATE UNIQUE INDEX IF NOT EXISTS "VenuePayment_void_note_key" ON "VenuePayment"("note") WHERE "method" = 'void';
