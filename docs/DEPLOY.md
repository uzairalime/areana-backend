# Areana API — deploy runbook (Round-4 fix, Oct 25, 2026)

Read this before running `prisma migrate deploy` on any database that
already has data. The short version: **fresh DB → `db push` first;
existing DB → dedupe pre-checks, then deploy; a failed migration is
recovered with `--rolled-back`, never blind `--applied`.**

## 1. Fresh database (first install)

`prisma/migrations/` holds only hand-written folders (the two partial
indexes, the court-name index, the void-note index, the broadcast
counts, plus `IdempotencyKey`). It is NOT a full baseline: `migrate
deploy` on an empty database creates only those objects and the API
then crashes on first query (every other table missing).

**Fresh-install path (until a real baseline migration is committed):**

```bash
cd areana-api
# 1. Create the full schema from schema.prisma (NOT migrate deploy):
npx prisma db push
# 2. Mark the hand-written migrations as applied ONLY after verifying
#    each object below exists and matches the migration SQL (step 3):
npx prisma migrate resolve --applied 20261025034800_system_role_name_unique
npx prisma migrate resolve --applied 20261025041500_court_venue_name_unique
npx prisma migrate resolve --applied 20261025041600_idempotency_key
npx prisma migrate resolve --applied 20261025070700_void_note_unique
npx prisma migrate resolve --applied 20261025123100_round4_r2_system_role_name_ci
# ... plus every later migration folder, in folder-name order.
# 3. Future deploys are plain `npx prisma migrate deploy`.
```

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
-- Duplicate system roles (exact AND case-insensitive):
SELECT name, COUNT(*) FROM "Role" WHERE "ownerId" IS NULL GROUP BY name HAVING COUNT(*) > 1;
SELECT lower(btrim("name")), COUNT(*) FROM "Role" WHERE "ownerId" IS NULL GROUP BY 1 HAVING COUNT(*) > 1;
-- Duplicate courts per venue (trimmed, case-insensitive — the index is
-- lower(name) with no trim, while the code check trims, so "Turf A" vs
-- "Turf A " pass the index but fail the code check):
SELECT "venueId", lower("name"), COUNT(*) FROM "Court" GROUP BY 1, 2 HAVING COUNT(*) > 1;
SELECT "venueId", lower(btrim("name")), COUNT(*) FROM "Court" GROUP BY 1, 2 HAVING COUNT(*) > 1;
-- Duplicate void notes (blocks the void unique index):
SELECT note, COUNT(*) FROM "VenuePayment" WHERE method = 'void' GROUP BY note HAVING COUNT(*) > 1;
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
  `Role_system_name_ci_key`, or `Court_venue_name_key` — accepting a
  drop silently removes the backstops. (`schema.prisma` carries a
  comment saying exactly this at the `IdempotencyKey` model.)
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

- **TRUST_PROXY**: accepted values are unset (warn in production), a
  hop count ≥ 1, `'true'` (all proxies, with a spoofing warning), or a
  comma list of proxy IPs/CIDRs. `'false'` crashes Express and `'0'`
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
  unless explicitly set to `'true'`.
- **Environment precedence** (P-S15): the image contains NO `.env`
  (the Dockerfile copies only `dist/`, `prisma/`, `.prisma`,
  `package*.json`). Effective precedence is `environment:` >
  `env_file:` > image `ENV` > `.env` file (dotenv never overwrites
  already-set process env). Editing `.env` while the Compose file
  also sets that variable under `environment:` silently loses — the
  stale Compose value wins. The boot log prints the effective
  non-secret configuration (NODE_ENV, TZ, CORS origins, SMTP host,
  FCM, storage, TRUST_PROXY) — check it on every deploy; secrets
  (JWT, SMTP creds, the DB password inside `DATABASE_URL`) are never
  logged.

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

## 8. Backfills

`prisma/backfills/` — see its README for the order and the
deliberately-not-bulk-fixed list. In short: 01 (quarantine bad courts)
before 02 (cancel inverted bookings); 03 (dedupe) before deploy;
08/10/11 are reports, not writes.
