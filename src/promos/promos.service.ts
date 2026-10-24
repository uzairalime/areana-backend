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
  async refundBookingPromo(bookingId: string) {
    const redemptions = await this.prisma.promoRedemption.findMany({
      where: { bookingId },
      select: { promoCodeId: true },
    });
    if (redemptions.length === 0) return;
    await this.prisma.promoRedemption.deleteMany({ where: { bookingId } });
    for (const r of redemptions) {
      await this.prisma.promoCode.updateMany({
        where: { id: r.promoCodeId, usedCount: { gt: 0 } },
        data: { usedCount: { decrement: 1 } },
      });
    }
  }

  /**
   * Creates a single-use personal promo (e.g. referral welcome/reward).
   * The unique code itself is the targeting mechanism.
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
