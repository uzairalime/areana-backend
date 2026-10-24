import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, of, tap } from 'rxjs';
import { PrismaService } from '../prisma';

/**
 * Idempotency for destructive admin mutations (mark-paid, suspend /
 * unsuspend, role create, plan assign). The panel sends a fresh
 * `Idempotency-Key` per user-confirmed action and reuses it across
 * retries of that action (a 60s timeout, a 401-refresh retry); a replay
 * within 24h returns the stored response instead of re-executing, so a
 * retry can never double-charge a ledger, double-suspend, or create a
 * duplicate role/plan assignment.
 *
 * Requests WITHOUT the header pass through unchanged (old clients,
 * non-keyed routes). Scope is method + concrete path + actor, so a key
 * can never replay across endpoints, venues, or admins. Failures are
 * never stored, so a failed action can always be retried with the same
 * key. Concurrent duplicates with the same key both executing is still
 * possible (the claim is checked at handler entry, not held as a lock);
 * the in-transaction claims on these endpoints (mark-paid, suspend)
 * and the role-name unique index are the backstop there — the panel's
 * busy flags make true simultaneous duplicates unlikely.
 */
const TTL_MS = 24 * 3600_000;

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
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
    const scope = `${req.method} ${url}`;
    const since = new Date(Date.now() - TTL_MS);
    const existing = await this.prisma.idempotencyKey.findUnique({
      where: { scope_actorId_key: { scope, actorId, key } },
    });
    if (existing && existing.createdAt >= since) {
      return of(existing.response);
    }

    return next.handle().pipe(
      tap({
        next: (body) => {
          // Fire-and-forget: a slow idempotency write must never slow
          // the mutation's own response, and its failure must not fail
          // an action that already succeeded.
          void (async () => {
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
            } catch {
              /* idempotency bookkeeping must never break the mutation */
            }
          })();
        },
      }),
    );
  }
}
