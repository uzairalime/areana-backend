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
   *
   * Round 5, R5-9: the outcome is DISTINGUISHABLE, not a bare null:
   * 'applied' (referral + welcome promo created), 'invalid' (no user
   * holds that code), 'self' (the referee's own code), 'failed'
   * (the code was valid but the referral/promo could not be created
   * — e.g. the referee already has a referral row, or the promo
   * create threw). Callers must surface the status even when the
   * promo is null, so the client never has to guess which failure it
   * was. A promo-create throw is caught here and reported as
   * 'failed' rather than failing the whole signup.
   */
  async handleSignupReferral(
    refereeId: string,
    referralCode: string,
  ): Promise<
    | { status: 'applied'; promo: { code: string } }
    | { status: 'invalid' | 'self' | 'failed'; promo: null }
  > {
    const referrer = await this.prisma.user.findFirst({
      where: { referralCode: referralCode.toUpperCase().trim() },
    });
    if (!referrer) return { status: 'invalid', promo: null };
    if (referrer.id === refereeId) return { status: 'self', promo: null };
    const existing = await this.prisma.referral.findUnique({
      where: { refereeId },
    });
    if (existing) return { status: 'failed', promo: null };

    try {
      await this.prisma.referral.create({
        data: { referrerId: referrer.id, refereeId, status: 'pending' },
      });
      const promo = await this.promos.createPersonalPromo(refereeId, 'percent', 15, 30, 'WELCOME');
      return { status: 'applied', promo };
    } catch {
      return { status: 'failed', promo: null };
    }
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
        // Claim the reward: two overlapping nightly runs used to both
        // read this row as pending and mint a promo each. The loser
        // gets count 0 and mints nothing.
        const claimed = await this.prisma.referral.updateMany({
          where: { id: r.id, status: 'pending' },
          data: { status: 'rewarded' },
        });
        if (claimed.count === 0) continue;
        await this.promos.createPersonalPromo(r.referrerId, 'percent', 10, 60, 'REWARD');
        granted++;
      }
    }
    return { granted };
  }
}
