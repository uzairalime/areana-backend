/* eslint-disable no-console */
/**
 * Pre-deploy verification (Round 4, M-B3 + deploy runbook).
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
    const dupRolesCi = await prisma.$queryRaw`
      SELECT lower(btrim("name")) AS key, COUNT(*)::int AS n FROM "Role"
      WHERE "ownerId" IS NULL GROUP BY 1 HAVING COUNT(*) > 1`;
    if (dupRolesCi.length > 0) {
      fail(
        'Duplicate system role names (case-insensitive / trailing space)',
        dupRolesCi,
        'Run prisma/backfills/03-dedupe-courts-roles.sql, then re-run this check.',
      );
    }
    const dupCourts = await prisma.$queryRaw`
      SELECT "venueId", lower(btrim("name")) AS key, COUNT(*)::int AS n FROM "Court"
      GROUP BY 1, 2 HAVING COUNT(*) > 1`;
    if (dupCourts.length > 0) {
      fail(
        'Duplicate court names per venue (trimmed, case-insensitive)',
        dupCourts,
        'Run prisma/backfills/03-dedupe-courts-roles.sql, then re-run this check.',
      );
    }
    const dupVoids = await prisma.$queryRaw`
      SELECT note, COUNT(*)::int AS n FROM "VenuePayment"
      WHERE method = 'void' GROUP BY note HAVING COUNT(*) > 1`;
    if (dupVoids.length > 0) {
      fail(
        'Duplicate void notes (blocks the void unique index)',
        dupVoids,
        'Keep one reversal per payment, delete the extras, then re-run this check.',
      );
    }
    // Informational: hand-written objects vs _prisma_migrations rows.
    // A missing object WITH a migration row is the dangerous case
    // (resolve --applied without the object voids the backstop);
    // a present object WITHOUT a row is the db-push case (§3).
    const objects = await prisma.$queryRaw`
      SELECT indexname AS name FROM pg_indexes
      WHERE indexname IN ('Role_system_name_key', 'Role_system_name_ci_key',
        'Court_venue_name_key', 'VenuePayment_void_note_key')
      UNION ALL
      SELECT tablename AS name FROM pg_tables WHERE tablename = 'IdempotencyKey'`;
    const present = new Set(objects.map((o) => o.name));
    // A db-push database has no _prisma_migrations table at all —
    // that is the expected §3 case, not an error: treat it as "no
    // rows applied" so the NOTE branch below fires per object.
    let applied = [];
    try {
      applied = await prisma.$queryRaw`
        SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL`;
    } catch (e) {
      if (!/does not exist/i.test(e.message)) throw e;
    }
    const appliedNames = new Set(applied.map((r) => r.migration_name));
    const expected = {
      '20261025034800_system_role_name_unique': ['Role_system_name_key'],
      '20261025123100_round4_r2_system_role_name_ci': ['Role_system_name_ci_key'],
      '20261025041500_court_venue_name_unique': ['Court_venue_name_key'],
      '20261025070700_void_note_unique': ['VenuePayment_void_note_key'],
      '20261025041600_idempotency_key': ['IdempotencyKey'],
    };
    for (const [mig, objs] of Object.entries(expected)) {
      const objsPresent = objs.every((o) => present.has(o));
      const rowPresent = appliedNames.has(mig);
      if (rowPresent && !objsPresent) {
        blocking += 1;
        console.error(
          `\nBLOCKING: migration ${mig} is marked applied but its object(s) ${objs.join(', ')} do NOT exist. ` +
            'Do NOT deploy past this — dedupe/verify, then resolve --rolled-back and deploy again (docs/DEPLOY.md §4).',
        );
      } else if (!rowPresent && objsPresent) {
        console.error(
          `\nNOTE: object(s) ${objs.join(', ')} exist without a migration row (db-push DB). ` +
            `Verify against the migration SQL, then: npx prisma migrate resolve --applied ${mig} (docs/DEPLOY.md §3).`,
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
