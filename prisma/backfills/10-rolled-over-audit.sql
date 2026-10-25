-- ============================================================================
-- 10 — Rolled-over date audit (Round 4, L-S3) — REPORT ONLY
-- ============================================================================
-- WHAT:   Before the parseDateOnly round-trip fix, impossible dates
--         (e.g. 2026-02-30) silently rolled over (Mar 2) and were
--         stored as if genuine. A pre-fix booking stored as Mar 2 now
--         behaves EXACTLY like a genuine Mar 2 booking — no stored
--         trace of the requested date survives — so per-row healing is
--         IMPOSSIBLE. The same silent shift applies to SlotBlock,
--         RecurringBlock and CourtPriceWindow dates.
-- WHY REPORT-ONLY: any "fix" here would be guessing which rows were
--         rolled and what was requested. The honest action is an
--         operator review list, not a bulk rewrite.
-- HEURISTIC: rows created before the fix (2026-10-25) whose play date
--         is BEFORE their creation date cannot be genuine advance
--         bookings (you cannot book a past slot) — they are either
--         rolled dates or backdated admin entries, both worth review.
--         Blocks/windows have no created-date-vs-play-date signal, so
--         they are listed only when their date falls on a month
--         boundary rollover pattern (1st–3rd of a month, created before
--         the fix) — a weak signal, flagged as such.
-- RUN:    psql "$DATABASE_URL" -f 10-rolled-over-audit.sql
-- ============================================================================

-- Bookings dated before they were created (created before the fix).
SELECT 'booking-past-dated' AS issue, "id", "venueId", "courtId",
       "date", "startMinutes", "status", "createdAt"
FROM "Booking"
WHERE "createdAt" < '2026-10-25'::timestamptz
  AND "date" < "createdAt"::date
ORDER BY "createdAt";

-- One-off blocks on month-boundary dates, created before the fix
-- (weak signal — review, do not bulk-edit).
SELECT 'block-month-boundary' AS issue, "id", "courtId",
       "date", "startMinutes", "endMinutes", "createdAt"
FROM "SlotBlock"
WHERE "createdAt" < '2026-10-25'::timestamptz
  AND EXTRACT(DAY FROM "date") <= 3
ORDER BY "createdAt";

-- Recurring blocks starting on month-boundary dates, before the fix.
SELECT 'recurring-month-boundary' AS issue, "id", "courtId",
       "startsOn", "endsOn", "createdAt"
FROM "RecurringBlock"
WHERE "createdAt" < '2026-10-25'::timestamptz
  AND "startsOn" IS NOT NULL AND EXTRACT(DAY FROM "startsOn") <= 3
ORDER BY "createdAt";
