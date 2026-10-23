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
    // Role.name is no longer globally unique (owner-created roles share
    // names across owners) — system roles are matched by name + ownerId null.
    const existing = await prisma.role.findFirst({
      where: { name: r.name, ownerId: null },
    });
    if (existing) {
      await prisma.role.update({
        where: { id: existing.id },
        data: { permissions: r.permissions, description: r.description },
      });
    } else {
      await prisma.role.create({ data: r });
    }
  }
  console.log('Roles seeded');

  const adminEmail = process.env.ADMIN_EMAIL;
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (adminEmail && adminPassword) {
    const superAdmin = await prisma.role.findFirstOrThrow({ where: { name: 'super_admin', ownerId: null } });
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

  // Subscription plans: venues pay a yearly flat fee per plan, first
  // freeMonths free; the super admin adjusts everything in the panel,
  // so seed only creates them when missing.
  const planSeed = [
    { name: 'Basic', priceYearly: 18000, freeMonths: 3, features: [] as string[], maxVenues: 1, maxCourts: 2, maxStaff: 0, isDefault: false, isCustom: false, sortOrder: 1 },
    { name: 'Normal', priceYearly: 36000, freeMonths: 3, features: ['peak_pricing', 'advanced_availability', 'staff_accounts', 'customers_insight'], maxVenues: 3, maxCourts: null, maxStaff: 3, isDefault: true, isCustom: false, sortOrder: 2 },
    { name: 'Premium', priceYearly: 60000, freeMonths: 3, features: ['peak_pricing', 'advanced_availability', 'staff_accounts', 'customers_insight', 'featured_placement'], maxVenues: null, maxCourts: null, maxStaff: null, isDefault: false, isCustom: false, sortOrder: 3 },
  ];
  for (const planData of planSeed) {
    const existing = await prisma.plan.findFirst({
      where: { name: planData.name, isCustom: false },
    });
    if (!existing) await prisma.plan.create({ data: planData });
  }
  console.log('Plans seeded');

  // Sports catalog — super-admin managed; seeded once with the defaults.
  const DEFAULT_SPORTS = [
    'Football',
    'Futsal',
    'Cricket',
    'Padel',
    'Tennis',
    'Badminton',
    'Basketball',
    'Volleyball',
    'Hockey',
    'Squash',
  ];
  // Defaults are a starting point ONLY: once the catalog exists it is
  // fully admin-managed, so re-seeding must never resurrect a sport the
  // admin renamed or removed.
  if ((await prisma.sport.count()) === 0) {
    for (const [i, name] of DEFAULT_SPORTS.entries()) {
      await prisma.sport.create({ data: { name, sortOrder: i } });
    }
  }
  console.log('Sports seeded');

  // Amenities catalog — same rule as sports: seed the defaults ONCE,
  // afterwards the catalog is fully admin-managed.
  if ((await prisma.amenity.count()) === 0) {
    const defaults = [
      'Parking',
      'Floodlights',
      'Changing Rooms',
      'Showers',
      'Washrooms',
      'Cafe',
      'Seating Area',
      'First Aid',
      'Equipment Rental',
      'Drinking Water',
      'Wi-Fi',
      'Prayer Area',
    ];
    for (const [i, name] of defaults.entries()) {
      await prisma.amenity.create({ data: { name, sortOrder: i } });
    }
  }
  console.log('Amenities seeded');

  const settings: Record<string, string> = {
    commissionPct: '10',
    billingGraceDays: '14',
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
