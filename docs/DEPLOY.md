# Areana API — deploy runbook (Round-4 fix, Oct 25, 2026)

Read this before running `prisma migrate deploy` on any database that
already has data. The short version: **fresh DB → `db push` first;
existing DB → dedupe pre-checks, then deploy; a failed migration is
recovered with `--rolled-back`, never blind `--applied`.**

## 1. Fresh database (first install)

`prisma/migrations/` holds only hand-written folders — 12 of them, and
it is NOT a full baseline: `migrate deploy` on an empty database
creates only those objects and the API then crashes on first query
(every other table missing).

| Migration folder | Object | Created by `db push`? |
|---|---|---|
| `20261025034800_system_role_name_unique` | Partial unique index `Role_system_name_key` (`name` WHERE `ownerId` IS NULL) | NO — raw SQL, no Prisma declaration |
| `20261025041500_court_venue_name_unique` | Unique index `Court_venue_name_ci_key` (`venueId`, `lower(name)`) | NO — raw SQL, no Prisma declaration |
| `20261025041600_idempotency_key` | Table `IdempotencyKey` | YES — declared in `schema.prisma` |
| `20261025070700_void_note_unique` | Partial unique index `VenuePayment_void_note_key` (`note` WHERE `method = 'void'`) | NO — raw SQL, no Prisma declaration |
| `20261025123000_round4_r2_court_weekly_hours_version` | Column `Court.weeklyHoursVersion` | YES — declared in `schema.prisma` |
| `20261025123100_round4_r2_system_role_name_ci` | Partial unique index `Role_system_name_ci_key` (`lower(name)` WHERE `ownerId` IS NULL) | NO — raw SQL, no Prisma declaration |
| `20261025123200_round4_r2_waitlist_slot_minutes` | Column `SlotWaitlist.slotMinutes` | YES — declared in `schema.prisma` |
| `20261025140000_round4_r5b_broadcast_counts` | Columns `Broadcast.delivered`, `Broadcast.failed` | YES — declared in `schema.prisma` |
| `20261025143000_round5_r1_refresh_replaced_by` | Column `RefreshSession.replacedById` | YES — declared in `schema.prisma` |
| `20261025170000_round5_r3_schema` | Columns `Broadcast.countsReliable`, `BookingParticipant.userId`, `Venue.freeUntilOverridePrev`; partial unique indexes `BookingParticipant_booking_phone_key` (`bookingId`, `phone` WHERE `phone` IS NOT NULL) and `RescheduleRequest_booking_pending_key` (`bookingId` WHERE `status = 'pending'`); CHECK `VenuePayment_void_note_not_null` (`method <> 'void' OR note IS NOT NULL`, NOT VALID) | PARTIAL — the 3 columns YES (declared in `schema.prisma`); the 2 indexes + CHECK NO (raw SQL, no Prisma declaration) |
| `20261025180000_round5_r5_review_reply_history` | Column `Review.ownerReplyHistory` | YES — declared in `schema.prisma` |
| `20261025190000_reaudit_schema_drift` | Columns `Venue.createdById`, `Venue.frozenPlanId`; `Dispute.bookingId` + `AuditLog.actorId` nullable with `ON DELETE SET NULL` FKs (re-created) | YES — declared in `schema.prisma` |

**Fresh-install path (until a real baseline migration is committed):**

```bash
cd areana-api
# 1. Create the full schema from schema.prisma (NOT migrate deploy):
npx prisma db push
# 2. For the objects `db push` DID create (table + columns above):
#    verify each one exists and matches the migration SQL, then mark
#    ONLY those migrations applied:
npx prisma migrate resolve --applied 20261025041600_idempotency_key
npx prisma migrate resolve --applied 20261025123000_round4_r2_court_weekly_hours_version
npx prisma migrate resolve --applied 20261025123200_round4_r2_waitlist_slot_minutes
npx prisma migrate resolve --applied 20261025140000_round4_r5b_broadcast_counts
npx prisma migrate resolve --applied 20261025143000_round5_r1_refresh_replaced_by
npx prisma migrate resolve --applied 20261025180000_round5_r5_review_reply_history
npx prisma migrate resolve --applied 20261025190000_reaudit_schema_drift
# 3. For the objects `db push` did NOT create (the 4 partial/unique
#    indexes above, plus the 2 indexes + CHECK in
#    20261025170000_round5_r3_schema): do NOT resolve them — let
#    deploy create them. NOTE: 20261025170000 is MIXED (its columns
#    ARE created by db push, its indexes/CHECK are not) — do NOT
#    resolve it either: its column adds are IF NOT EXISTS-safe and
#    its index creates are IF NOT EXISTS-safe, so a plain deploy
#    creates the missing pieces without duplicating the columns.
#    Resolving it would void the two partial indexes + CHECK.
npx prisma migrate deploy
# 4. Future deploys are plain `npx prisma migrate deploy`.
```

Resolving an index migration on a `db push` DB — where the index
does NOT exist — is the exact failure §3 warns against: the
migration is marked done while its backstop is absent, so duplicate
system roles / courts become creatable with no error and the code's
P2002 mappings keep compiling against an index that isn't there.
`scripts/predeploy-check.js` enforces this split: an object without
a migration row is BLOCKING until resolved, and a resolved migration
without its object is BLOCKING until rolled back and deployed.

Do NOT hand-write a 30-model baseline migration to "fix" this — a
hand-written baseline drifts from `schema.prisma` on the next model
change and fails exactly like M-B2. The correct long-term fix is
generating the baseline from a scratch database (`migrate dev` on an
empty scratch DB, inspect the SQL, commit it) — see §5.

## 2. Existing database: dedupe pre-checks (blocking)

The index migrations FAIL on duplicates, and a failed migration blocks
the whole deploy (later migrations never land). Run these BEFORE
deploy — or run `node scripts/predeploy-check.js`, which runs them all
and exits non-zero on blocking rows:

```sql
-- Duplicate system roles (exact AND case-insensitive). The CI index
-- is lower(name) with NO trim, so the lower() query is the one that
-- decides whether the index migration fails; the EXCEPT queries list
-- trailing-space-only pairs, which PASS the index but FAIL the code
-- check (the code trims) — warnings, not index blockers:
SELECT name, COUNT(*) FROM "Role" WHERE "ownerId" IS NULL GROUP BY name HAVING COUNT(*) > 1;
SELECT lower("name"), COUNT(*) FROM "Role" WHERE "ownerId" IS NULL GROUP BY 1 HAVING COUNT(*) > 1;
SELECT lower(btrim("name")), COUNT(*) FROM "Role" WHERE "ownerId" IS NULL GROUP BY 1 HAVING COUNT(*) > 1
EXCEPT
SELECT lower("name"), COUNT(*) FROM "Role" WHERE "ownerId" IS NULL GROUP BY 1 HAVING COUNT(*) > 1;
-- Duplicate courts per venue (same split: lower() blocks the index,
-- the EXCEPT query is code-check-only):
SELECT "venueId", lower("name"), COUNT(*) FROM "Court" GROUP BY 1, 2 HAVING COUNT(*) > 1;
SELECT "venueId", lower(btrim("name")), COUNT(*) FROM "Court" GROUP BY 1, 2 HAVING COUNT(*) > 1
EXCEPT
SELECT "venueId", lower("name"), COUNT(*) FROM "Court" GROUP BY 1, 2 HAVING COUNT(*) > 1;
-- Duplicate void notes (blocks the void unique index). NULL notes are
-- EXCLUDED: Postgres groups NULLs together, but the partial unique
-- index treats NULLs as distinct, so NULL-note void rows never block it:
SELECT note, COUNT(*) FROM "VenuePayment" WHERE method = 'void' AND note IS NOT NULL GROUP BY note HAVING COUNT(*) > 1;
```

If any query returns rows, dedupe FIRST — see
`prisma/backfills/03-dedupe-courts-roles.sql` (courts: rename, never
bare-delete — `Booking.court` has no onDelete; roles: re-point users
and `VenueAllowedRole` rows to the keeper, THEN delete the emptied
duplicate — `User.role` has no onDelete, so a bare DELETE fails on the
FK). For void notes: keep one reversal per payment, delete the extras.

## 3. `migrate deploy` onto a `db push` database (M-B2)

A database built by `db push` already HAS the `IdempotencyKey` table
(and possibly the indexes) without `_prisma_migrations` rows, so plain
`deploy` fails with "relation already exists" and stops. Recovery:

1. Verify the existing object matches the migration SQL, column for
   column (for `IdempotencyKey`: id, scope, actorId, key, response,
   createdAt; for the indexes: the exact partial-index predicates).
   Name alone is NOT verification — a hand-applied index with the
   right name but the wrong predicate (e.g. a full unique on
   `VenuePayment.note` with no `WHERE method = 'void'`, or a
   `lower(name)` index with no `WHERE ownerId IS NULL`) is skipped
   by the migration's `IF NOT EXISTS` and leaves the wrong backstop
   standing. Verify predicates with:
   ```sql
   SELECT c.relname AS indexname,
          pg_get_expr(i.indpred, i.indrelid) AS predicate,
          pg_get_expr(i.indexprs, i.indrelid) AS expression
   FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
   WHERE c.relname IN ('Role_system_name_key', 'Role_system_name_ci_key',
     'Court_venue_name_ci_key', 'VenuePayment_void_note_key',
     'BookingParticipant_booking_phone_key', 'RescheduleRequest_booking_pending_key');
   -- Expected predicates:
   --   Role_system_name_key:        WHERE "ownerId" IS NULL
   --   Role_system_name_ci_key:     WHERE "ownerId" IS NULL (on lower(name))
   --   Court_venue_name_ci_key:    no predicate (unique on venueId, lower(name))
   --   VenuePayment_void_note_key: WHERE "method" = 'void'
   --   BookingParticipant_booking_phone_key: WHERE "phone" IS NOT NULL (on bookingId, phone)
   --   RescheduleRequest_booking_pending_key: WHERE "status" = 'pending' (on bookingId)
   ```
   `scripts/predeploy-check.js` runs this definition check
   automatically (it compares the normalised `indexdef`).
2. Only then mark it applied:
   `npx prisma migrate resolve --applied <migration-name>`.
3. Re-run `npx prisma migrate deploy`.

**NEVER run `resolve --applied` without step 1.** Marking an index
migration applied while the index DOES NOT exist silently voids the
backstop: duplicate system roles / courts become creatable again with
no error anywhere, and the code's P2002 mappings keep compiling
against an index that isn't there.

## 4. A failed migration is NOT retried (M-S2)

Each migration is effectively a single statement, transactional on
Postgres — a duplicate failure rolls back the whole file. But Prisma
records the failed attempt in `_prisma_migrations`, so re-running
`deploy` does NOT retry it; it errors demanding resolution. Correct
recovery:

```bash
# 1. Fix the cause (dedupe — see §2).
# 2. Roll the failed migration back in Prisma's bookkeeping:
npx prisma migrate resolve --rolled-back <migration-name>
# 3. Deploy again (the migration now runs for real):
npx prisma migrate deploy
```

`--applied` without fixing the cause is forbidden (§3): it marks the
migration done while its object does not exist.

## 5. Authoring migrations (M-S1, M-S3)

- **Never edit an applied `migration.sql`.** `_prisma_migrations`
  stores a checksum per applied migration — "fixing" a comment after
  application breaks every later deploy with a checksum-mismatch
  refusal until resolved. Corrections go in a NEW migration.
- **Never run `migrate dev` against the real dev DB without first
  running it on a scratch DB and inspecting the generated SQL.** Two
  raw partial indexes (system role name, court venue+lower(name))
  have NO Prisma declaration, so the shadow-DB diff cannot match them:
  it may propose DROPPING them, or flag drift and offer only a reset.
  Reject any generated `DROP INDEX` for `Role_system_name_key`,
  `Role_system_name_ci_key`, `Court_venue_name_ci_key`, or
  `VenuePayment_void_note_key` — accepting a drop silently removes
  the backstops. (`schema.prisma` carries a comment saying exactly
  this at the `IdempotencyKey` model.)
- **Rebase onto the current `migrations/` head before merging.**
  Hand-written timestamps (20261025034800/41500/41600, all Oct 25)
  mean a developer on a stale checkout can author
  `20261025040000_add_x` assuming `IdempotencyKey` exists via `db
  push`; after merge, `deploy` applies strictly by folder-name order
  and `…040000` runs BEFORE `…041600`, failing on a nonexistent
  table on a migrate-built DB. Any migration depending on a
  hand-written one must say so in its header.

## 6. Boot guards — the exact conditions (P-S2, P-S3, P-S11, P-S15)

`src/main.ts` fails boot (throws) or warns by this rule:

| Check | Fail boot when | Warn otherwise |
|---|---|---|
| Effective TZ ≠ Asia/Karachi (TZ env, else host system zone) | NODE_ENV = production, unset, or unrecognised | explicit development/test |
| CORS open (`*` or empty, after trim) | NODE_ENV = production or unrecognised | unset / development / test |
| SMTP_HOST unset or `localhost` | NODE_ENV = production or unrecognised | otherwise |
| TRUST_PROXY invalid (`false`, `0`, garbage) | always (it is a misconfiguration, not an environment question) | — |
| Postgres timezone ≠ Asia/Karachi | same rule as TZ | otherwise |

Notes:

- **TRUST_PROXY**: accepted values are unset (warns when boot must
  fail — production or unrecognised `NODE_ENV`), a hop count ≥ 1
  (counts above 5 warn: trusting that many hops is effectively
  trusting everyone), `'true'` (all proxies, with a spoofing
  warning), or a comma list of proxy IPs/CIDRs with validated octets
  (0–255) and CIDR ranges (0–32 IPv4, 0–128 IPv6). A whitespace-only
  value is REJECTED as invalid (it used to be treated as unset and
  silently skipped the warning); `'false'` crashes Express and `'0'`
  silently pools every visitor under the proxy IP while skipping the
  warning — both are rejected with a clear message. `'true'`/`1`
  trust the leftmost `X-Forwarded-For` entry: if the VPS proxy
  appends rather than strips client-supplied headers, any caller can
  rotate a spoofed header per request and evade the per-IP OTP cap and
  throttler. That buys OTP/throttle evasion, NOT session hijack
  (refresh-token reuse detection is not IP-keyed). The proxy MUST
  strip inbound `X-Forwarded-For`. Production value: `TRUST_PROXY=1`.
- **Postgres timezone**: Postgres bakes its timezone at initdb —
  changing the `TZ` env on an existing `pgdata` volume does NOT change
  the cluster's setting. Fix a wrong cluster with
  `ALTER DATABASE areana SET timezone = 'Asia/Karachi';` (then
  reconnect) or re-initialise the volume. The boot check runs
  `SHOW timezone`; a DB that is down at boot only warns (`/api/health`
  reports it and the orchestrator restarts).
- **Swagger**: `/api/docs` is served only when `SWAGGER_ENABLED`
  allows it — on by default outside production, off in production
  unless explicitly set to `'true'`. An unrecognised `NODE_ENV`
  (`staging`, `prod`, a typo like `prodution`) is treated as
  production for this gate AND for plaintext OTP logging: docs stay
  off and OTP codes stay out of the server log unless
  `SWAGGER_ENABLED='true'` is set explicitly (and OTP logging
  follows the same production-like rule). Only the three known
  values (`development`, `test`, `production`) get dev behaviours;
  anything else — including unset for the TZ guard — is fail-safe.
- **Environment precedence** (P-S15): the image contains NO `.env`
  (the Dockerfile copies only `dist/`, `prisma/`, `.prisma`,
  `package*.json`). Prod Compose declares NO `env_file:` at all —
  its `environment:` values are interpolated from the project `.env`
  / shell (`${VAR:-default}`, `${VAR:?…}`). So the effective rule
  is: a variable set directly under `environment:` wins over any
  project-`.env` edit, and the project `.env` only matters where a
  Compose `environment:` entry interpolates it. Editing `.env`
  while the Compose file also sets that variable under
  `environment:` silently loses — the stale Compose value wins. The
  boot log prints the effective non-secret configuration (NODE_ENV,
  TZ, CORS origins, SMTP host, FCM, storage, TRUST_PROXY) — check it
  on every deploy; secrets (JWT, SMTP creds, the DB password inside
  `DATABASE_URL`) are never logged.

## 7. Production Compose (P-S14)

`docker-compose.prod.yml` (versioned in this repo) is the production
shape: `api` service + `db` with healthchecks,
`depends_on: db: condition: service_healthy`,
`restart: unless-stopped`, and the API healthcheck on `/api/health`
(which now returns 503 when the DB is down, so the healthy gate can
actually fail). The dev `docker-compose.yml` (db + mailpit only) is
NOT a production file — the old "real prod Compose" was unversioned
and unverifiable from this repo. Every API restart is full downtime
(single container); a restart spanning a tick relies on the startup
catch-ups (billing sweep + reminders + nightly-if-missed, all in
`SchedulerService.onModuleInit`).

**Production Compose rules (Round 5, R2):**

- **Volume:** the prod `db` volume is `pgdata_prod`, deliberately
  distinct from dev's `pgdata`. Sharing one named volume across
  Compose files in the same directory (same default project name)
  let a dev-initialised volume leak into prod: `POSTGRES_PASSWORD`
  is ignored on an existing volume, so the prod password fails auth,
  and dev/demo data appears in prod. An existing prod install that
  already runs on `pgdata` must move its data deliberately (stop,
  copy the volume, re-point) — never just rename and boot empty.
- **`DATABASE_URL` must point at the Compose `db` service** (host
  `db`, with the `POSTGRES_USER` / `POSTGRES_DB` credentials).
  Nothing validates this: a `localhost:5432` (or stale-host) URL
  runs `migrate deploy` and the app against the wrong database
  while the healthcheck gate (which only waits on the local `db`)
  passes. The Compose header states the rule; check the boot log's
  effective config on every deploy.
- **Healthcheck failure does NOT restart the container.** Docker
  marks a container unhealthy but never restarts it on health
  failure, so a pool-wedged API (health 503) stays up indefinitely
  unless something external acts. Run an external watchdog or
  alerting on the health endpoint (or an orchestrator restart
  policy) — do not assume `restart: unless-stopped` recovers it.
- **A failed migration restart-loops until resolved.** The image
  CMD is `migrate deploy && node dist/main`: a failed migration
  exits non-zero, `unless-stopped` restarts it, and `deploy` fails
  again on the failed `_prisma_migrations` row until someone runs
  `migrate resolve` manually (see §4). Alert on repeated migrate
  failures; do not let the loop run silently.
- **Seeding needs `ADMIN_PASSWORD` and, for S3, the S3 set.**
  `ADMIN_EMAIL` alone seeds nothing (the admin block requires both
  email and password, and now warns when the password is missing);
  `STORAGE_DRIVER=s3` without `S3_BUCKET` / `S3_REGION` /
  `S3_ENDPOINT` / `S3_ACCESS_KEY` / `S3_SECRET_KEY` boots fine and
  fails only at first upload — the boot guard now fails (or warns
  outside production-like envs) when the S3 set is incomplete.

## 8. Backfills

`prisma/backfills/` — see its README for the order and the
deliberately-not-bulk-fixed list. In short: 01 (quarantine bad courts)
before 02 (cancel inverted bookings); 03 (dedupe) before deploy;
08/10/11 are reports, not writes.

## 9. Errata — applied migration headers that must NOT be edited

**Never edit an applied `migration.sql` to fix these** (see §5:
`_prisma_migrations` checksums break every later deploy). The
corrections live here, not in the migration files:

- **`20261025123000_round4_r2_court_weekly_hours_version`** — its
  header mislabels its pre-check: the `SELECT name … GROUP BY name`
  query is an EXACT-match check, not "case-insensitive" as labelled,
  and the header lists sibling dedupe checks that are irrelevant to
  this migration (it only adds the `Court.weeklyHoursVersion`
  column and can never fail on duplicates). Read the true
  case-insensitive check from §2 above, not from that header.
  (Same note applies to `20261025123200`'s header, which repeats
  the pattern.)
- **`20261025140000_round4_r5b_broadcast_counts`** — its header
  says "nullable-with-default columns only", but the SQL is
  `ADD COLUMN … INTEGER NOT NULL DEFAULT 0`, matching
  `schema.prisma` (`delivered` / `failed Int @default(0)`,
  non-nullable). Trust the SQL, not the header: history rows carry
  `0`, not NULL, for both counts.
