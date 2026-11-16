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
-- HEURISTIC: rollover moves dates FORWARD, so a rolled advance
--         booking has date >= createdAt and is indistinguishable
--         from a genuine booking on that date. The date < createdAt
--         query therefore lists BACKDATED/admin entries (review
--         under that label, Round 5, D5-S17), NOT rollover evidence.
--         Genuine rollover candidates are pre-fix rows on month-
--         boundary dates (1st–3rd of a month — the shape an
--         impossible late-month date rolls into) — a weak signal,
--         flagged as such, for bookings, blocks, recurring blocks
--         (startsOn OR endsOn) and price windows.
-- RUN:    psql "$DATABASE_URL" -f 10-rolled-over-audit.sql
-- ============================================================================

-- Bookings dated before they were created (created before the fix).
-- Round 5, D5-S17: this is BACKDATED review, NOT rollover evidence —
-- rollover moves dates FORWARD (requested 2026-02-30 → stored
-- 2026-03-02), so a genuine rolled advance booking has
-- date >= createdAt and never appears here; this query instead
-- lists backdated/admin entries. Relabelled accordingly.
SELECT 'booking-backdated-review' AS issue, "id", "venueId", "courtId",
       "date", "startMinutes", "status", "createdAt"
FROM "Booking"
WHERE "createdAt" < '2026-10-25'::timestamptz
  AND "date" < "createdAt"::date
ORDER BY "createdAt";

-- Bookings on month-boundary dates (day 1–3, created before the fix)
-- — the canonical rollover shape: an impossible late-month date
-- rolls into the 1st–3rd of the next month. Weak signal (genuine
-- 1st–3rd bookings are common) — review, do not bulk-edit.
SELECT 'booking-month-boundary-rollover-candidate' AS issue, "id", "venueId", "courtId",
       "date", "startMinutes", "status", "createdAt"
FROM "Booking"
WHERE "createdAt" < '2026-10-25'::timestamptz
  AND EXTRACT(DAY FROM "date") <= 3
ORDER BY "createdAt";

-- One-off blocks on month-boundary dates, created before the fix
-- (weak signal — review, do not bulk-edit).
SELECT 'block-month-boundary' AS issue, "id", "courtId",
       "date", "startMinutes", "endMinutes", "createdAt"
FROM "SlotBlock"
WHERE "createdAt" < '2026-10-25'::timestamptz
  AND EXTRACT(DAY FROM "date") <= 3
ORDER BY "createdAt";

-- Recurring blocks starting OR ending on month-boundary dates,
-- before the fix (Round 5, D5-S17: the old query checked startsOn
-- only, missing a rolled endsOn).
SELECT 'recurring-month-boundary' AS issue, "id", "courtId",
       "startsOn", "endsOn", "createdAt"
FROM "RecurringBlock"
WHERE "createdAt" < '2026-10-25'::timestamptz
  AND (( "startsOn" IS NOT NULL AND EXTRACT(DAY FROM "startsOn") <= 3)
    OR ("endsOn" IS NOT NULL AND EXTRACT(DAY FROM "endsOn") <= 3))
ORDER BY "createdAt";

-- Price windows on month-boundary dates, before the fix (Round 5,
-- D5-S17: the header claimed the same shift applies to
-- CourtPriceWindow dates, but the script contained no such query —
-- rolled window dates were never listed at all).
SELECT 'price-window-month-boundary' AS issue, "id", "courtId",
       "startsOn", "endsOn", "createdAt"
FROM "CourtPriceWindow"
WHERE "createdAt" < '2026-10-25'::timestamptz
  AND (( "startsOn" IS NOT NULL AND EXTRACT(DAY FROM "startsOn") <= 3)
    OR ("endsOn" IS NOT NULL AND EXTRACT(DAY FROM "endsOn") <= 3))
ORDER BY "createdAt";
