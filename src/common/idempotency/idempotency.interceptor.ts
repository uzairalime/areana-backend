import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Observable, concatMap, of } from 'rxjs';
import { PrismaService } from '../prisma';

/**
 * Idempotency for destructive admin mutations (mark-paid, suspend /
 * unsuspend, role create, plan assign, extend-free, user set-status).
 * The panel sends a fresh `Idempotency-Key` per user-confirmed action
 * and reuses it across retries of that action (a 60s timeout, a
 * 401-refresh retry, a tab reload inside the 5-minute window); a
 * replay within 24h returns the stored response instead of
 * re-executing, so a retry can never double-charge a ledger,
 * double-suspend, or create a duplicate role/plan assignment.
 *
 * Requests WITHOUT the header pass through unchanged (old clients,
 * non-keyed routes). Scope is method + concrete path + actor + a
 * SHA-256 hash of the canonicalised request body, so a key can never
 * replay across endpoints, venues, admins, or DIFFERENT payloads
 * (round-4 R-B1: the old payload-blind scope replayed a 10:00 suspend
 * response for a genuinely new 10:03 re-suspend). Rows stored under
 * the old payload-blind scope format never match a new lookup (the
 * scope string now carries a `#sha256:` suffix), so pre-existing keys
 * simply execute fresh — never 500, never a false replay.
 *
 * REPLAY POLICY (round-4 R-B1 / R-S1, one coherent rule): a stored
 * response is replayed ONLY while the action's post-condition still
 * holds against current state (see REPLAY_CHECKS below). If the state
 * moved on — venue unsuspended after a suspend, payment voided after
 * a mark-paid, free period extended again — the stored response is
 * stale and the request RE-EXECUTES as a fresh action, replacing the
 * stored row. Re-execution is safe here because every keyed endpoint
 * has an in-transaction claim (mark-paid, suspend/unsuspend, user
 * status), a unique index (role name), or a restart guard (plan
 * restart refuses while a payment recorded since the last restart
 * still stands) — a stale replay returning "success" for something
 * that is no longer true is the one outcome that must never happen.
 * A check that throws (deleted target, DB error) is treated as stale
 * and also re-executes, so a broken check can never 500 a keyed
 * endpoint or serve a lie.
 *
 * WRITE-BEFORE-RESPOND (round-4 R-B2): the idempotency row is written
 * (one retry, errors swallowed) BEFORE the response is emitted, so a
 * timeout that committed server-side cannot leave a keyless success
 * for a retry to re-execute. This costs one upsert of latency on
 * keyed endpoints — correctness over milliseconds, deliberately.
 *
 * FAIL OPEN (round-4 R-B5): every idempotency storage access is
 * wrapped — a read error (e.g. the IdempotencyKey table missing after
 * a partial migration) logs and proceeds with the request normally
 * instead of 500ing all keyed endpoints. Failures are never stored,
 * so a failed action can always be retried with the same key.
 * Concurrent duplicates with the same key both executing is still
 * possible (the claim is checked at handler entry, not held as a
 * lock); the in-transaction claims and unique indexes above are the
 * backstop there — the panel's busy flags make true simultaneous
 * duplicates unlikely.
 */
const TTL_MS = 24 * 3600_000;

/** JSON with sorted object keys, so equal payloads hash equally. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`)
    .join(',')}}`;
}

function bodyHash(body: unknown): string {
  return createHash('sha256')
    .update(canonical(body ?? null))
    .digest('hex');
}

/** Same instant? DB Dates vs JSON-serialised ISO strings. */
function sameInstant(a: unknown, b: unknown): boolean {
  const norm = (v: unknown): string => {
    if (v === null || v === undefined) return '';
    if (v instanceof Date) return v.toISOString();
    return String(v);
  };
  return norm(a) === norm(b);
}

type ReplayCheck = (
  prisma: PrismaService,
  params: Record<string, string>,
  body: Record<string, unknown> | undefined,
  stored: Record<string, unknown>,
) => Promise<boolean>;

const venueId = (params: Record<string, string>) => params.id;

/** Post-condition per keyed route. True = stored response still holds. */
const REPLAY_CHECKS: Array<{
  method: string;
  pattern: RegExp;
  check: ReplayCheck;
}> = [
  {
    method: 'POST',
    pattern: /^\/admin\/venues\/[^/]+\/suspend$/,
    check: async (prisma, params, _body, _stored) => {
      const v = await prisma.venue.findUnique({
        where: { id: venueId(params) },
        select: { status: true },
      });
      return v?.status === 'suspended';
    },
  },
  {
    method: 'POST',
    pattern: /^\/admin\/venues\/[^/]+\/unsuspend$/,
    check: async (prisma, params, _body, _stored) => {
      const v = await prisma.venue.findUnique({
        where: { id: venueId(params) },
        select: { status: true },
      });
      // Unsuspend lands on approved or pending; a re-suspend since
      // then means the stored "reinstated" response is stale.
      return !!v && v.status !== 'suspended';
    },
  },
  {
    method: 'PATCH',
    pattern: /^\/admin\/users\/[^/]+\/status$/,
    check: async (prisma, params, body, _stored) => {
      const u = await prisma.user.findUnique({
        where: { id: venueId(params) },
        select: { status: true },
      });
      return !!u && !!body && u.status === body.status;
    },
  },
  {
    method: 'POST',
    pattern: /^\/admin\/roles$/,
    check: async (prisma, _params, _body, stored) => {
      if (typeof stored.id !== 'string') return false;
      const r = await prisma.role.findUnique({
        where: { id: stored.id },
        select: { id: true },
      });
      return !!r;
    },
  },
  {
    method: 'POST',
    pattern: /^\/admin\/venues\/[^/]+\/plan$/,
    check: async (prisma, params, body, stored) => {
      const v = await prisma.venue.findUnique({
        where: { id: venueId(params) },
        select: { planId: true, billingStartAt: true },
      });
      if (!v || !body || v.planId !== body.planId) return false;
      // A restart re-anchors the clock: the stored response is only
      // still true if the clock was never re-anchored since.
      if (body.restartBilling) {
        const storedVenue = stored.venue as
          | Record<string, unknown>
          | undefined;
        return sameInstant(v.billingStartAt, storedVenue?.billingStartAt);
      }
      return true;
    },
  },
  {
    method: 'POST',
    pattern: /^\/admin\/venues\/[^/]+\/billing\/mark-paid$/,
    check: async (prisma, params, _body, stored) => {
      const v = await prisma.venue.findUnique({
        where: { id: venueId(params) },
        select: { billingPaidUntil: true, billingPaused: true },
      });
      const storedVenue = stored.venue as
        | Record<string, unknown>
        | undefined;
      if (!v || !storedVenue) return false;
      // A void rolls paidUntil back and a second mark-paid advances
      // it — either way the stored receipt no longer describes the
      // venue, so a retry must settle the period that is actually
      // outstanding now instead of replaying the old receipt.
      return (
        sameInstant(v.billingPaidUntil, storedVenue.billingPaidUntil) &&
        v.billingPaused === storedVenue.billingPaused
      );
    },
  },
  {
    method: 'POST',
    pattern: /^\/admin\/venues\/[^/]+\/billing\/extend-free$/,
    check: async (prisma, params, _body, stored) => {
      const v = await prisma.venue.findUnique({
        where: { id: venueId(params) },
        select: { freeUntilOverride: true },
      });
      const storedVenue = stored.venue as
        | Record<string, unknown>
        | undefined;
      if (!v || !storedVenue) return false;
      return sameInstant(
        v.freeUntilOverride,
        storedVenue.freeUntilOverride,
      );
    },
  },
];

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly logger = new Logger(IdempotencyInterceptor.name);

  constructor(private prisma: PrismaService) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    const req = context.switchToHttp().getRequest();
    const key: string | undefined =
      req.headers?.['idempotency-key'] ?? req.headers?.['Idempotency-Key'];
    const actorId: string | undefined = req.user?.id;
    if (!key || !actorId) return next.handle();

    const url: string = (req.url ?? '').split('?')[0];
    const scope = `${req.method} ${url}#sha256:${bodyHash(req.body)}`;
    const since = new Date(Date.now() - TTL_MS);

    // Fail open (R-B5): a storage error must never 500 a keyed
    // endpoint — log and proceed as if no key had been sent.
    let existing: { response: unknown; createdAt: Date } | null = null;
    try {
      existing = await this.prisma.idempotencyKey.findUnique({
        where: { scope_actorId_key: { scope, actorId, key } },
      });
    } catch (e) {
      this.logger.warn(
        `Idempotency read failed, proceeding without replay: ${(e as Error).message}`,
      );
    }
    if (existing && existing.createdAt >= since) {
      const stored = existing.response as Record<string, unknown>;
      const rule = REPLAY_CHECKS.find(
        (r) => r.method === req.method && r.pattern.test(url),
      );
      let fresh = true;
      if (rule) {
        try {
          fresh = await rule.check(
            this.prisma,
            req.params ?? {},
            req.body,
            stored,
          );
        } catch (e) {
          // A broken check re-executes (safe: claims guard doubles)
          // rather than serving a possibly-stale success.
          this.logger.warn(
            `Idempotency replay check failed, re-executing: ${(e as Error).message}`,
          );
          fresh = false;
        }
      }
      // No rule for this route: replay verbatim (pre-existing
      // behaviour for any future keyed route without a check).
      if (!rule || fresh) return of(existing.response);
    }

    return next.handle().pipe(
      concatMap(async (body) => {
        // Write BEFORE the response is emitted (R-B2): one retry,
        // errors swallowed — bookkeeping must never fail an action
        // that already succeeded, but in the normal case the row
        // lands before the client can retry.
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const stored = JSON.parse(JSON.stringify(body ?? null));
            await this.prisma.idempotencyKey.upsert({
              where: { scope_actorId_key: { scope, actorId, key } },
              update: { response: stored, createdAt: new Date() },
              create: { scope, actorId, key, response: stored },
            });
            await this.prisma.idempotencyKey.deleteMany({
              where: { createdAt: { lt: since } },
            });
            break;
          } catch (e) {
            if (attempt === 1) {
              this.logger.warn(
                `Idempotency write failed, response still returned: ${(e as Error).message}`,
              );
            }
          }
        }
        return body;
      }),
    );
  }
}
