# Round-4 backfills (Oct 25, 2026) — as amended by Round-5 R2

Guarded, idempotent SQL for the legacy-data findings in
`~/workspace/goals/areana-sports-booking-platform/files/round4-edgecase-findings.md`.
Code guards already refuse NEW bad rows; these scripts repair STORED rows.

Round-5 R2 changes (see `round5-data-edgecase-findings.md`, D5-B4–B7,
D5-S5–S19): 01's dry run now matches its write predicate exactly;
02 also reverses strikes for already-struck no-shows, cancels
already-completed inverted bookings, re-checks status at write time,
and reports skipped rows; 03's role-keeper tie-break is
`createdAt ASC, id ASC` and its audit records both permission sets;
04 appends (never replaces) demo photos up to max(4, sports) and
uses a period-scoped ledger id; 05 resolves trims in a temp table
(one winner per code, never aborting on a unique violation),
upper-trims, and audits every change; 06 floors discounts at 0;
07 writes audit rows; 08 names the affected staffers; 09 compares
URL sets (not counts); 10 relabels backdated review, adds
month-boundary + price-window + endsOn queries; 11 adds the
updatedAt-window proxy and the never-settled paused set.

## How to run

```bash
# 1. Always back up first (these are writes; rollback = restore).
# 2. Run the pre-deploy check (it also runs the dedupe queries):
node scripts/predeploy-check.js
# 3. Run each script with its STEP 0 dry-run output inspected first:
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f prisma/backfills/01-bad-slotminutes-courts.sql
```

Every script starts with read-only STEP 0 queries — run those, inspect the
rows, then run the whole file. Re-running a script is a no-op (each step
filters on the pre-fix state, and audit/notification inserts use derived
ids with `ON CONFLICT DO NOTHING`).

## Order

| # | Script | Finding | Writes? |
|---|--------|---------|---------|
| 01 | `01-bad-slotminutes-courts.sql` | L-B1/L-B2 | Deactivates bad courts + audit rows |
| 02 | `02-inverted-bookings.sql` | L-B3 | Cancels inverted bookings (incl. already-completed ones), reverses already-struck no-show strikes, refunds promos, closes posts, notifies players |
| 03 | `03-dedupe-courts-roles.sql` | M-B3, L-B6 | Renames dup courts (audit via snapshot temp tables); re-points users, merges dup roles (deterministic keeper: createdAt, id) |
| 04 | `04-demo-venues.sql` | M-S5, M-S6 | Appends demo photos to max(4, sports) + audited; period-scoped ledger ids; real venues reported only |
| 05 | `05-promo-cleanup.sql` | L-S6, L-S7, L-S8 | Upper-trims codes (temp-table collision resolution), clamps limits, deletes orphans, recomputes usedCount, audits every change |
| 06 | `06-negative-prices.sql` | L-S12 | Floors negative totals, caps discounts (floored at 0) |
| 07 | `07-stale-posts-disputes.sql` | L-S9, L-S10 | Closes stale posts, dismisses null-booking disputes, with audit rows |
| 08 | `08-cross-owner-staff.sql` | L-B5 | **Report only** — names affected staffers; re-point manually, then verify empty |
| 09 | `09-legacy-photos.sql` | L-S14 | Builds `photos` entries from `images` (no tags invented); partial report compares URL sets |
| 10 | `10-rolled-over-audit.sql` | L-S3 | **Report only** — backdated review + month-boundary candidates + price windows; per-row healing is impossible |
| 11 | `11-rs0-pause-report.sql` | L-S4 | **Report only** — auto-settled pauses + updatedAt-window proxy + never-settled paused set; manual re-booking/notice per player |

Run 01 before 02 (no new inverted booking can land while 02 runs), and run
03 before `prisma migrate deploy` (the index migrations fail on duplicates).

## Deliberately NOT bulk-fixed

- **Trailing-space court pairs** (`"Turf A"` vs `"Turf A "`): script 03
  groups by `lower(btrim(name))`, so these ARE renamed like any other
  duplicate. (Noted in the audit as "note in the runbook, not a blocker"
  because the index itself passes them — the code check is what fails.)
- **Legacy courts with 1 ≤ slotMinutes < 15**: benign but grid-fragile.
  Do NOT "fix" them by editing slot length without moving their bookings
  first — a re-grid strands off-grid bookings at the accept fit-check.
- **Legacy `VenuePayment` rows with `planId = NULL`**: cosmetic only
  (SetNull on plan delete; the delete guard now blocks deleting plans
  with payments). Receipts render plan-less; no money impact.
- **Advisory-lock key collision** (`hashtext(user.id)` = 727001, ~2⁻³²
  per user): latency only, no deadlock — one owner's venue creation
  serialises against plan writes. Not worth a key-space change.
- **Idempotency fire-and-forget window**: already fixed in Round 3
  (the store is awaited before the response now); a crash in the old
  window only ever re-executed into an in-transaction claim or unique
  index, surfacing "already paid"/conflict rather than a double effect.
- **Applied migration files are immutable**: `_prisma_migrations`
  stores a checksum per applied migration — editing one (even a comment)
  breaks every later deploy with a checksum-mismatch refusal. Corrections
  go in a NEW migration. See `docs/DEPLOY.md`.
