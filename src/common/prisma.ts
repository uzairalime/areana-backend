import { Global, Injectable, Module, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * Round 4, P-S12: the client used to run bare — no pool, lock, or
 * statement timeout anywhere — so under lock contention a request
 * waited forever (single queries have no Prisma timeout at all) or
 * died as a generic P2028 500. Pool sizing comes from the datasource
 * URL (Prisma honours connection_limit / pool_timeout there); values
 * already present in DATABASE_URL win, these are defaults, not
 * overrides. Statement/lock timeouts are per-transaction SET LOCAL in
 * the long-lock paths (court delete, venue cascade claim, billing
 * sweep claim) — a pool-wide SET would not stick across pooled
 * connections, so it is set where the lock is actually held.
 *
 * Round 5, D5-S41: connection_limit 10 → 25. Ten connections turned
 * ordinary load into 503s: an 11th concurrent slow query (slot
 * search, analytics) waited out the 10s pool_timeout and died as
 * P2028. Twenty-five still fits a small VPS Postgres (default
 * max_connections 100) with headroom for migrations/seeds, while
 * the unchanged 10s pool_timeout keeps overload failing fast with
 * an honest 503 instead of hanging. No pool-wide statement_timeout
 * is set via the URL: Prisma only honours its own pool params there,
 * so arbitrary libpq params are not a reliable timeout mechanism —
 * single queries stay unbounded outside the SET LOCAL paths, and
 * the P2028 → 503 filter keeps that failure honest.
 */
function withPoolDefaults(url: string | undefined): string | undefined {
  if (!url) return url;
  try {
    const u = new URL(url);
    if (!u.searchParams.has('connection_limit')) u.searchParams.set('connection_limit', '25');
    if (!u.searchParams.has('pool_timeout')) u.searchParams.set('pool_timeout', '10');
    return u.toString();
  } catch {
    return url;
  }
}

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    super({
      datasources: { db: { url: withPoolDefaults(process.env.DATABASE_URL) } },
    });
  }
  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}

@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
