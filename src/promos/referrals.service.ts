import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma';
import { PromosService } from './promos.service';

@Injectable()
export class ReferralsService {
  constructor(
    private prisma: PrismaService,
    private promos: PromosService,
  ) {}

  async getMyReferral(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { referralCode: true },
    });
    const [referredCount, rewards] = await Promise.all([
      this.prisma.referral.count({ where: { referrerId: userId } }),
      this.prisma.referral.count({ where: { referrerId: userId, status: 'rewarded' } }),
    ]);
    return {
      referralCode: user?.referralCode ?? null,
      referralUrl: user?.referralCode ? `https://areana.pk/r/${user.referralCode}` : null,
      referredCount,
      rewards,
    };
  }

  /**
   * Called at signup when a referral code was supplied.
   * Creates the pending referral and a 15% welcome promo for the referee.
   */
  async handleSignupReferral(refereeId: string, referralCode: string) {
    const referrer = await this.prisma.user.findFirst({
      where: { referralCode: referralCode.toUpperCase().trim() },
    });
    if (!referrer || referrer.id === refereeId) return null;
    const existing = await this.prisma.referral.findUnique({
      where: { refereeId },
    });
    if (existing) return null;

    await this.prisma.referral.create({
      data: { referrerId: referrer.id, refereeId, status: 'pending' },
    });
    const promo = await this.promos.createPersonalPromo(refereeId, 'percent', 15, 30, 'WELCOME');
    return { promo };
  }

  /**
   * Called by the scheduler: rewards referrers whose referee completed ≥1 booking.
   */
  async grantReferralRewards() {
    const pendings = await this.prisma.referral.findMany({
      where: { status: 'pending' },
      select: { id: true, referrerId: true, refereeId: true },
    });
    let granted = 0;
    for (const r of pendings) {
      const completed = await this.prisma.booking.count({
        where: { userId: r.refereeId, status: 'completed' },
      });
      if (completed > 0) {
        await this.prisma.referral.update({
          where: { id: r.id },
          data: { status: 'rewarded' },
        });
        await this.promos.createPersonalPromo(r.referrerId, 'percent', 10, 60, 'REWARD');
        granted++;
      }
    }
    return { granted };
  }
}
