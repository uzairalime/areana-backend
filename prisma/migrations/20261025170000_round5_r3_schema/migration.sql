-- Round 5, R3 schema bundle (no existing migration file touched).
-- Pre-checks before applying (all must return zero rows, else fix first):
--   SELECT COUNT(*) FROM "VenuePayment" WHERE "method" = 'void' AND "note" IS NULL;
--     (NULL-note void rows would make the new CHECK constraint fail validation
--      for future writes; delete or annotate such manual rows first. The
--      constraint is added NOT VALID so it never blocks the migration itself,
--      but it is enforced on every new/updated row from this point on.)
--   SELECT "bookingId", "phone", COUNT(*) FROM "BookingParticipant"
--     WHERE "phone" IS NOT NULL GROUP BY 1, 2 HAVING COUNT(*) > 1;
--   SELECT "bookingId", COUNT(*) FROM "RescheduleRequest"
--     WHERE "status" = 'pending' GROUP BY 1 HAVING COUNT(*) > 1;
-- If either duplicate query returns rows, dedupe (keep earliest) before migrating.

-- D5-S54: signed-in joiner identity on shared-booking participants.
ALTER TABLE "BookingParticipant" ADD COLUMN IF NOT EXISTS "userId" TEXT;

-- D5-S49: mark pre-counts broadcast rows as unreliable. Every row that
-- exists at migration time predates delivered/failed counts, so all of
-- them are set false here; the column default (true) covers new rows.
ALTER TABLE "Broadcast" ADD COLUMN IF NOT EXISTS "countsReliable" BOOLEAN NOT NULL DEFAULT true;
UPDATE "Broadcast" SET "countsReliable" = false;

-- R5-S4: snapshot slot for the pre-extension freeUntilOverride value.
ALTER TABLE "Venue" ADD COLUMN IF NOT EXISTS "freeUntilOverridePrev" TIMESTAMP(3);

-- D5-S54: one participant per phone per shared booking (guests with no
-- phone are unaffected: NULLs are distinct in a partial unique index).
CREATE UNIQUE INDEX IF NOT EXISTS "BookingParticipant_booking_phone_key"
  ON "BookingParticipant"("bookingId", "phone") WHERE "phone" IS NOT NULL;

-- P5-S50: at most one pending reschedule request per booking.
CREATE UNIQUE INDEX IF NOT EXISTS "RescheduleRequest_booking_pending_key"
  ON "RescheduleRequest"("bookingId") WHERE "status" = 'pending';

-- D5-T5: a void reversal row must always carry its void:<id> note.
-- NOT VALID: enforced for new/updated rows, never fails the migration
-- itself on legacy manual rows (see pre-check above).
ALTER TABLE "VenuePayment"
  ADD CONSTRAINT "VenuePayment_void_note_not_null"
  CHECK ("method" <> 'void' OR "note" IS NOT NULL) NOT VALID;
