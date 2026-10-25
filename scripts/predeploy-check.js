/* eslint-disable no-console */
/**
 * Pre-deploy verification (Round 4, M-B3 + deploy runbook; Round 5, R2).
 *
 * Runs the blocking dedupe queries and the hand-written-object checks
 * BEFORE `prisma migrate deploy`, because the index migrations FAIL on
 * duplicates and a failed migration blocks the whole deploy (and is
 * not retried — see docs/DEPLOY.md §4).
 *
 * Usage (from areana-api):
 *   node scripts/predeploy-check.js
 *
 * DATABASE_URL comes from the environment, else from .env in this
 * directory (process env wins, matching dotenv precedence). Exits 0
 * when clean, 1 when blocking rows exist, 2 on connection/config
 * errors. Prints the exact remediation for every finding.
 *
 * Round 5, R2 rules (see docs/DEPLOY.md §2–§3):
 * - Index-blocking duplicates use the index's own predicate: lower()
 *   with NO trim. Trailing-space-only pairs pass the index but fail
 *   the code check — they are reported as WARNINGS (code-check-only),
 *   not as index blockers, via an EXCEPT query.
 * - Void-duplicate grouping excludes NULL notes: Postgres groups
 *   NULLs together, but the partial unique index treats NULLs as
 *   distinct, so NULL-note void rows never block the index.
 * - Index verification checks the actual index DEFINITION (predicate
 *   / expression), not just the name: a hand-applied index with the
 *   right name but the wrong predicate is BLOCKING.
 * - An object WITHOUT a migration row (db-push DB) is BLOCKING, not
 *   a NOTE: as a deploy gate, exit 0 there would green-light a
 *   `migrate deploy` that immediately fails with "relation already
 *   exists". Resolve first (docs/DEPLOY.md §3), then re-run.
 * - All 9 hand-written migration folders are covered, including the
 *   4 column-adding Round-4/5 migrations (checked against
 *   information_schema.columns) and the Round-5 refresh migration.
 */
const fs = require('fs');
const path = require('path');

function loadDotEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    process.env[m[1]] = v;
  }
}

// Normalise a pg_indexes.indexdef for predicate comparison: strip
// whitespace, double quotes and case so formatting differences in
// hand-applied indexes cannot hide a genuinely wrong predicate.
function normDef(def) {
  return (def || '').replace(/\s+/g, '').replace(/"/g, '').toLowerCase();
}

async function main() {
  loadDotEnv();
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('BLOCKED: DATABASE_URL is not set (env or .env).');
    process.exit(2);
  }
  // eslint-disable-next-line import/no-extraneous-dependencies
  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  let blocking = 0;
  const fail = (title, rows, fix) => {
    blocking += 1;
    console.error(`\nBLOCKING: ${title} — ${rows.length} row(s)`);
    for (const r of rows.slice(0, 20)) console.error(`  ${JSON.stringify(r)}`);
    if (rows.length > 20) console.error(`  ... and ${rows.length - 20} more`);
    console.error(`  Fix: ${fix}`);
  };
  const warn = (title, rows, fix) => {
    console.error(`\nWARNING: ${title} — ${rows.length} row(s)`);
    for (const r of rows.slice(0, 20)) console.error(`  ${JSON.stringify(r)}`);
    if (rows.length > 20) console.error(`  ... and ${rows.length - 20} more`);
    console.error(`  Fix: ${fix}`);
  };
  try {
    const dupRolesExact = await prisma.$queryRaw`
      SELECT "name", COUNT(*)::int AS n FROM "Role"
      WHERE "ownerId" IS NULL GROUP BY "name" HAVING COUNT(*) > 1`;
    if (dupRolesExact.length > 0) {
      fail(
        'Duplicate system role names (exact)',
        dupRolesExact,
        'Run prisma/backfills/03-dedupe-courts-roles.sql, then re-run this check.',
      );
    }
    // Index-blocking: the CI index is lower(name) with NO trim, so
    // this query (and only this one) decides whether the migration
    // itself fails.
    const dupRolesCi = await prisma.$queryRaw`
      SELECT lower("name") AS key, COUNT(*)::int AS n FROM "Role"
      WHERE "ownerId" IS NULL GROUP BY 1 HAVING COUNT(*) > 1`;
    if (dupRolesCi.length > 0) {
      fail(
        'Duplicate system role names (case-insensitive — blocks the Role_system_name_ci_key index)',
        dupRolesCi,
        'Run prisma/backfills/03-dedupe-courts-roles.sql, then re-run this check.',
      );
    }
    // Code-check-only: trimmed-lower duplicates that are NOT
    // lower() duplicates pass the index but fail the code check
    // (assertCourtNameFree / role guards trim). Warning, not
    // blocking: the migration alone would pass.
    const dupRolesCodeOnly = await prisma.$queryRaw`
      SELECT lower(btrim("name")) AS key, COUNT(*)::int AS n FROM "Role"
      WHERE "ownerId" IS NULL GROUP BY 1 HAVING COUNT(*) > 1
      EXCEPT
      SELECT lower("name") AS key, COUNT(*)::int AS n FROM "Role"
      WHERE "ownerId" IS NULL GROUP BY 1 HAVING COUNT(*) > 1`;
    if (dupRolesCodeOnly.length > 0) {
      warn(
        'Duplicate system role names (trailing-space-only — passes the index, fails the code check)',
        dupRolesCodeOnly,
        'Run prisma/backfills/03-dedupe-courts-roles.sql (it renames these too), then re-run this check.',
      );
    }
    const dupCourts = await prisma.$queryRaw`
      SELECT "venueId", lower("name") AS key, COUNT(*)::int AS n FROM "Court"
      GROUP BY 1, 2 HAVING COUNT(*) > 1`;
    if (dupCourts.length > 0) {
      fail(
        'Duplicate court names per venue (case-insensitive — blocks the Court_venue_name_ci_key index)',
        dupCourts,
        'Run prisma/backfills/03-dedupe-courts-roles.sql, then re-run this check.',
      );
    }
    const dupCourtsCodeOnly = await prisma.$queryRaw`
      SELECT "venueId", lower(btrim("name")) AS key, COUNT(*)::int AS n FROM "Court"
      GROUP BY 1, 2 HAVING COUNT(*) > 1
      EXCEPT
      SELECT "venueId", lower("name") AS key, COUNT(*)::int AS n FROM "Court"
      GROUP BY 1, 2 HAVING COUNT(*) > 1`;
    if (dupCourtsCodeOnly.length > 0) {
      warn(
        'Duplicate court names per venue (trailing-space-only — passes the index, fails the code check)',
        dupCourtsCodeOnly,
        'Run prisma/backfills/03-dedupe-courts-roles.sql (it renames these too), then re-run this check.',
      );
    }
    // NULL notes excluded: the partial unique index treats NULLs as
    // distinct, so NULL-note void rows never block it (Postgres
    // GROUP BY would otherwise lump all NULLs into one "duplicate").
    const dupVoids = await prisma.$queryRaw`
      SELECT note, COUNT(*)::int AS n FROM "VenuePayment"
      WHERE method = 'void' AND note IS NOT NULL GROUP BY note HAVING COUNT(*) > 1`;
    if (dupVoids.length > 0) {
      fail(
        'Duplicate void notes (blocks the void unique index)',
        dupVoids,
        'Keep one reversal per payment, delete the extras, then re-run this check.',
      );
    }
    // Hand-written objects vs _prisma_migrations rows. A missing
    // object WITH a migration row is the dangerous case (resolve
    // --applied without the object voids the backstop); a present
    // object WITHOUT a row is the db-push case (§3) — and is
    // BLOCKING here: as a deploy gate it must not exit 0, or the
    // next `migrate deploy` fails with "relation already exists".
    const indexRows = await prisma.$queryRaw`
      SELECT indexname AS name, indexdef AS def FROM pg_indexes
      WHERE indexname IN ('Role_system_name_key', 'Role_system_name_ci_key',
        'Court_venue_name_ci_key', 'VenuePayment_void_note_key')`;
    const indexDefs = new Map(indexRows.map((r) => [r.name, normDef(r.def)]));
    const columnRows = await prisma.$queryRaw`
      SELECT table_name AS t, column_name AS c FROM information_schema.columns
      WHERE (table_name = 'Court' AND column_name = 'weeklyHoursVersion')
         OR (table_name = 'SlotWaitlist' AND column_name = 'slotMinutes')
         OR (table_name = 'Broadcast' AND column_name IN ('delivered', 'failed'))
         OR (table_name = 'RefreshSession' AND column_name = 'replacedById')`;
    const columns = new Set(columnRows.map((r) => `${r.t}.${r.c}`));
    const tableRows = await prisma.$queryRaw`
      SELECT tablename AS name FROM pg_tables WHERE tablename = 'IdempotencyKey'`;
    const tables = new Set(tableRows.map((r) => r.name));
    // A db-push database has no _prisma_migrations table at all —
    // that is the expected §3 case, not an error: treat it as "no
    // rows applied" so every present object reports BLOCKING (resolve
    // first) instead of silently passing.
    let applied = [];
    try {
      applied = await prisma.$queryRaw`
        SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL`;
    } catch (e) {
      if (!/does not exist/i.test(e.message)) throw e;
    }
    const appliedNames = new Set(applied.map((r) => r.migration_name));
    // expected[migration] = checks; each check is { kind, name, need }:
    // - index: name must exist AND its definition must contain every
    //   substring in `need` (normalised predicate/expression parts).
    // - column: table.column must exist in information_schema.
    // - table: tablename must exist in pg_tables.
    const expected = {
      '20261025034800_system_role_name_unique': [
        { kind: 'index', name: 'Role_system_name_key', need: ['(name)', 'whereowneridisnull'] },
      ],
      '20261025123100_round4_r2_system_role_name_ci': [
        { kind: 'index', name: 'Role_system_name_ci_key', need: ['lower(name)', 'whereowneridisnull'] },
      ],
      '20261025041500_court_venue_name_unique': [
        { kind: 'index', name: 'Court_venue_name_ci_key', need: ['venueid', 'lower(name)'] },
      ],
      '20261025070700_void_note_unique': [
        { kind: 'index', name: 'VenuePayment_void_note_key', need: ['(note)', "wheremethod='void'"] },
      ],
      '20261025041600_idempotency_key': [{ kind: 'table', name: 'IdempotencyKey' }],
      '20261025123000_round4_r2_court_weekly_hours_version': [
        { kind: 'column', name: 'Court.weeklyHoursVersion' },
      ],
      '20261025123200_round4_r2_waitlist_slot_minutes': [
        { kind: 'column', name: 'SlotWaitlist.slotMinutes' },
      ],
      '20261025140000_round4_r5b_broadcast_counts': [
        { kind: 'column', name: 'Broadcast.delivered' },
        { kind: 'column', name: 'Broadcast.failed' },
      ],
      '20261025143000_round5_r1_refresh_replaced_by': [
        { kind: 'column', name: 'RefreshSession.replacedById' },
      ],
    };
    const objectPresent = (check) => {
      if (check.kind === 'table') return tables.has(check.name);
      if (check.kind === 'column') return columns.has(check.name);
      const def = indexDefs.get(check.name);
      if (!def) return false;
      // Predicate/expression verification: a hand-applied index with
      // the right name but the wrong predicate (e.g. a full unique
      // on VenuePayment.note with no WHERE method='void') must NOT
      // pass — the migration's IF NOT EXISTS would skip it and the
      // wrong backstop would stand.
      return check.need.every((n) => def.includes(n));
    };
    const objectWrongPredicate = (check) => {
      if (check.kind !== 'index') return false;
      const def = indexDefs.get(check.name);
      return def !== undefined && !check.need.every((n) => def.includes(n));
    };
    for (const [mig, checks] of Object.entries(expected)) {
      const names = checks.map((c) => c.name);
      const objsPresent = checks.every(objectPresent);
      const rowPresent = appliedNames.has(mig);
      if (checks.some(objectWrongPredicate)) {
        const bad = checks.filter(objectWrongPredicate).map((c) => c.name);
        blocking += 1;
        console.error(
          `\nBLOCKING: index(es) ${bad.join(', ')} exist but with the WRONG predicate/expression ` +
            `for migration ${mig} (see docs/DEPLOY.md §3 for the expected predicates). ` +
            'A migration with IF NOT EXISTS would skip the correct index and leave the wrong one standing — ' +
            'drop the wrong index and re-create it exactly as the migration SQL says, then re-run this check.',
        );
      } else if (rowPresent && !objsPresent) {
        blocking += 1;
        console.error(
          `\nBLOCKING: migration ${mig} is marked applied but its object(s) ${names.join(', ')} do NOT exist. ` +
            'Do NOT deploy past this — dedupe/verify, then resolve --rolled-back and deploy again (docs/DEPLOY.md §4).',
        );
      } else if (!rowPresent && objsPresent) {
        blocking += 1;
        console.error(
          `\nBLOCKING: object(s) ${names.join(', ')} exist without a migration row for ${mig} (db-push DB). ` +
            `Deploy would fail with "relation already exists" — verify the object(s) against the migration SQL, then: ` +
            `npx prisma migrate resolve --applied ${mig} (docs/DEPLOY.md §3), then re-run this check.`,
        );
      }
    }
  } catch (e) {
    console.error(`ERROR: could not run checks: ${e.message}`);
    process.exit(2);
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
  if (blocking > 0) {
    console.error(`\nPRE-DEPLOY CHECK FAILED: ${blocking} blocking issue(s). Fix them, then re-run.`);
    process.exit(1);
  }
  console.log('Pre-deploy check passed: no blocking duplicates; hand-written objects consistent.');
}

main();
