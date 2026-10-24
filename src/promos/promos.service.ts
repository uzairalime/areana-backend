import { BadRequestException, Injectable } from '@nestjs/common';
import { PromoCode, Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma';

export interface PromoValidation {
  promo: PromoCode;
  discount: number;
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

@Injectable()
export class PromosService {
  constructor(private prisma: PrismaService) {}

  /**
   * Validates a promo code for a user and computes the discount on `amount`.
   * Throws BadRequestException when the code cannot be applied.
   */
  async validatePromo(code: string, userId: string, amount: number, venueId?: string): Promise<PromoValidation> {
    const promo = await this.prisma.promoCode.findUnique({
      where: { code: code.toUpperCase().trim() },
    });
    if (!promo || !promo.isActive) throw new BadRequestException('Invalid promo code');
    // Code namespace decision (audit I-6, documented not changed):
    // codes are globally @unique even though validation is
    // venue-scoped, so two owners cannot both run WELCOME10 — the
    // namespace is first-come-first-served by design. Scoping
    // uniqueness to (venueId, code) would need partial unique indexes
    // (platform promos have venueId null, and Postgres treats NULLs
    // as distinct) plus collision rules between platform and venue
    // codes; that migration is not worth it while codes are
    // admin/owner-typed, not player-chosen.
    // Owner-managed promos are valid only at their own venue.
    if (promo.venueId && venueId && promo.venueId !== venueId) {
      throw new BadRequestException('This promo code is not valid for this venue');
    }

    const now = new Date();
    if (promo.validFrom > now || promo.validTo < now) {
      throw new BadRequestException('Promo code is expired');
    }
    if (promo.maxUses != null && promo.usedCount >= promo.maxUses) {
      throw new BadRequestException('Promo code is fully used');
    }
    const userUses = await this.prisma.promoRedemption.count({
      where: { promoCodeId: promo.id, userId },
    });
    if (userUses >= promo.perUserLimit) {
      throw new BadRequestException('Promo code already used');
    }

    let discount: number;
    if (promo.kind === 'percent') {
      discount = (amount * Number(promo.value)) / 100;
      if (promo.maxDiscount != null) {
        discount = Math.min(discount, Number(promo.maxDiscount));
      }
    } else {
      discount = Math.min(Number(promo.value), amount);
      if (promo.maxDiscount != null) {
        discount = Math.min(discount, Number(promo.maxDiscount));
      }
    }
    return { promo, discount: Math.round(discount * 100) / 100 };
  }

  /**
   * Records promo usage. Pass the caller's transaction client to keep the
   * booking + redemption atomic. Validation ran before the booking
   * transaction, so it is re-checked here: a promo deactivated (or
   * expired, or exhausted for this user) between validation and apply
   * must not be consumed. With a transaction client the promo row is
   * locked first, which serializes concurrent applies and makes the
   * per-user count check accurate.
   */
  async applyPromo(
    promoId: string,
    userId: string,
    bookingId: string,
    tx?: Prisma.TransactionClient,
  ) {
    const db = tx ?? this.prisma;
    if (tx) {
      await tx.$queryRaw`SELECT id FROM "PromoCode" WHERE id = ${promoId} FOR UPDATE`;
    }
    const promo = await db.promoCode.findUnique({ where: { id: promoId } });
    if (!promo || !promo.isActive) {
      throw new BadRequestException('Promo code is no longer active');
    }
    const now = new Date();
    if (promo.validFrom > now || promo.validTo < now) {
      throw new BadRequestException('Promo code is expired');
    }
    const userUses = await db.promoRedemption.count({
      where: { promoCodeId: promoId, userId },
    });
    if (userUses >= promo.perUserLimit) {
      throw new BadRequestException('Promo code already used');
    }
    // Atomic conditional increment: the WHERE re-checks the cap inside
    // the same UPDATE, so two simultaneous redemptions of the last use
    // can't both succeed (the old read-then-increment had a race window).
    const rows = await db.$queryRaw<{ id: string }[]>`
      UPDATE "PromoCode"
      SET "usedCount" = "usedCount" + 1
      WHERE "id" = ${promoId}
        AND ("maxUses" IS NULL OR "usedCount" < "maxUses")
      RETURNING "id"`;
    if (rows.length === 0) {
      throw new BadRequestException('Promo code is fully used');
    }
    return db.promoRedemption.create({
      data: { promoCodeId: promoId, userId, bookingId },
    });
  }

  /**
   * Refund a booking's promo: delete its redemptions and give the uses
   * back. Called on every cancel/expiry path, so a cancelled booking
   * never permanently burns a single-use code.
   */
  /**
   * Refund a booking's promo. Pass the caller's transaction client to
   * run the cleanup inside that transaction (court delete refunds
   * doomed bookings' promos in the same transaction that deletes them,
   * so a failed delete never leaves refunded promos on surviving
   * bookings); otherwise it opens its own transaction.
   */
  async refundBookingPromo(bookingId: string, tx?: Prisma.TransactionClient) {
    if (tx) return this.refundBookingPromoInTx(tx, bookingId);
    return this.prisma.$transaction((t) => this.refundBookingPromoInTx(t, bookingId));
  }

  private async refundBookingPromoInTx(tx: Prisma.TransactionClient, bookingId: string) {
    // Delete + decrement, decrementing only by the rows actually
    // deleted: two concurrent releases of the same booking used to
    // both read the row before either deleted, so one redemption
    // decremented usedCount twice and granted a phantom use past
    // maxUses. The promo row lock (same one applyPromo uses) serializes
    // concurrent releases of one booking: the loser waits, then finds
    // nothing left to refund.
    const promos = await tx.promoRedemption.findMany({
      where: { bookingId },
      select: { promoCodeId: true },
      distinct: ['promoCodeId'],
    });
    // Deterministic lock order, so two refunds touching several
    // promos can never deadlock each other.
    promos.sort((a, b) => a.promoCodeId.localeCompare(b.promoCodeId));
    for (const { promoCodeId } of promos) {
      await tx.$queryRaw`SELECT id FROM "PromoCode" WHERE id = ${promoCodeId} FOR UPDATE`;
      const deleted = await tx.promoRedemption.deleteMany({
        where: { bookingId, promoCodeId },
      });
      if (deleted.count > 0) {
        await tx.$executeRaw`UPDATE "PromoCode" SET "usedCount" = GREATEST("usedCount" - ${deleted.count}, 0) WHERE "id" = ${promoCodeId}`;
      }
    }
  }

  /**
   * Creates a single-use personal promo (e.g. referral welcome/reward).
   * The unique code itself is the targeting mechanism.
   */
  /**
   * Bearer-token semantics, by design: the code is NOT bound to a
   * recipient. `userId` names the intended holder but is not stored
   * on the row and is never checked at redemption — anyone holding
   * the code can redeem it, subject to maxUses/perUserLimit. Do not
   * "fix" this by scoping redemption to userId without a product
   * decision: the WELCOME/REWARD codes are meant to be shareable.
   */
  async createPersonalPromo(
    userId: string,
    kind: 'percent' | 'flat',
    value: number,
    daysValid: number,
    prefix: string,
  ) {
    return this.prisma.promoCode.create({
      data: {
        code: `${prefix}-${randomSuffix()}`,
        kind,
        value,
        maxUses: 1,
        perUserLimit: 1,
        validTo: new Date(Date.now() + daysValid * 86_400_000),
        isActive: true,
      },
    });
  }
}
