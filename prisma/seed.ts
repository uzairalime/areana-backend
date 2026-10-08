import { PrismaClient, UserStatus } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

// Permission keys are defined in code (src/common/permissions.ts) and
// assigned to roles here. The panel can remix them without code changes.
const ROLES = [
  {
    name: 'super_admin',
    scope: 'platform' as const,
    description: 'Platform operator — full access',
    permissions: ['*'],
    isSystem: true,
  },
  {
    name: 'owner',
    scope: 'arena' as const,
    description: 'Arena owner — manages own venues',
    permissions: [
      'venues.manage',
      'courts.manage',
      'bookings.review',
      'bookings.manage',
      'blocks.manage',
      'schedule.manage',
      'customers.read',
      'staff.manage',
      'reviews.reply',
    ],
    isSystem: true,
  },
  {
    name: 'staff',
    scope: 'arena' as const,
    description: 'Arena team member — bookings operations on assigned venues',
    permissions: ['bookings.review', 'bookings.manage', 'blocks.manage', 'customers.read'],
    isSystem: true,
  },
  {
    name: 'player',
    scope: 'arena' as const,
    description: 'End user — books and plays',
    permissions: [
      'bookings.create',
      'bookings.read',
      'reviews.write',
      'favorites.manage',
      'games.manage',
      'referrals.read',
    ],
    isSystem: true,
  },
];

async function main() {
  for (const r of ROLES) {
    await prisma.role.upsert({
      where: { name: r.name },
      update: { permissions: r.permissions, description: r.description },
      create: r,
    });
  }
  console.log('Roles seeded');

  const adminEmail = process.env.ADMIN_EMAIL;
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (adminEmail && adminPassword) {
    const superAdmin = await prisma.role.findUniqueOrThrow({ where: { name: 'super_admin' } });
    await prisma.user.upsert({
      where: { email: adminEmail },
      update: {},
      create: {
        email: adminEmail,
        name: 'Super Admin',
        roleId: superAdmin.id,
        status: UserStatus.active,
        passwordHash: await bcrypt.hash(adminPassword, 10),
      },
    });
    console.log(`Super admin ready: ${adminEmail}`);
  }

  // Arena badge series (tiers refined later with real data)
  const badges = [
    { name: 'Rising Arena', tier: 1, criteriaDescription: 'New and promising — complete profile, first 10 bookings' },
    { name: 'Top Arena', tier: 2, criteriaDescription: 'Rating 4.5+, 50+ bookings, high acceptance' },
    { name: 'Elite Arena', tier: 3, criteriaDescription: 'Rating 4.8+, 200+ bookings, near-zero cancellations' },
  ];
  for (const b of badges) {
    await prisma.badge.upsert({
      where: { id: `seed-${b.tier}` },
      update: {},
      create: { id: `seed-${b.tier}`, ...b },
    });
  }

  const settings: Record<string, string> = {
    commissionPct: '10',
    pendingExpiryHours: '2',
    noShowStrikeLimit: '3',
    referralWelcomePct: '15',
    referralRewardPct: '10',
  };
  for (const [key, value] of Object.entries(settings)) {
    await prisma.setting.upsert({ where: { key }, update: {}, create: { key, value } });
  }
  console.log('Settings + badges seeded');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
