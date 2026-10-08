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
  async validatePromo(code: string, userId: string, amount: number): Promise<PromoValidation> {
    const promo = await this.prisma.promoCode.findUnique({
      where: { code: code.toUpperCase().trim() },
    });
    if (!promo || !promo.isActive) throw new BadRequestException('Invalid promo code');

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
    }
    return { promo, discount: Math.round(discount * 100) / 100 };
  }

  /**
   * Records promo usage. Pass the caller's transaction client to keep the
   * booking + redemption atomic.
   */
  async applyPromo(
    promoId: string,
    userId: string,
    bookingId: string,
    tx?: Prisma.TransactionClient,
  ) {
    const db = tx ?? this.prisma;
    await db.promoCode.update({
      where: { id: promoId },
      data: { usedCount: { increment: 1 } },
    });
    return db.promoRedemption.create({
      data: { promoCodeId: promoId, userId, bookingId },
    });
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
