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
  // Round 5, D5-T8: a P2002 on any single seed item means "already
  // seeded" (a concurrent/partial run created it) — log and continue
  // with the next item, never abort the whole seed on one duplicate.
  const alreadySeeded = (label: string, e: unknown): boolean => {
    if ((e as { code?: string })?.code === 'P2002') {
      console.log(`Already seeded, skipping: ${label}`);
      return true;
    }
    return false;
  };
  // Round 5, D5-S28: snapshot which system roles existed BEFORE this
  // run, so recreating a missing one while others exist can warn
  // that it may resurrect a renamed/deleted role (fresh installs,
  // where nothing exists yet, get no warning).
  const preExistingRoles = await prisma.role.findMany({
    where: { name: { in: ROLES.map((r) => r.name) }, ownerId: null },
    select: { name: true },
  });
  const preExistingNames = new Set(preExistingRoles.map((r) => r.name));
  for (const r of ROLES) {
    // Role.name is no longer globally unique (owner-created roles share
    // names across owners) — system roles are matched by name + ownerId null.
    // Round 4, M-B5: re-running the seed used to OVERWRITE system-role
    // permissions — an admin removing a dangerous key (e.g.
    // staff.manage) from the owner role saw it silently restored, with
    // no audit row, the next time anyone re-ran db:seed as a "repair".
    // Create-if-missing only now, like settings/badges (update: {}):
    // admin permission edits survive re-seeds. To deliberately reset
    // a role's permissions, edit it in the panel.
    const existing = await prisma.role.findFirst({
      where: { name: r.name, ownerId: null },
    });
    if (!existing) {
      if (preExistingNames.size > 0) {
        console.warn(
          `WARNING: recreating system role '${r.name}' while other system roles already exist — ` +
            'this may resurrect a role an admin renamed or deleted. ' +
            'If that was intentional, ignore this warning; if not, delete the recreated role in the panel.',
        );
      }
      try {
        await prisma.role.create({ data: r });
      } catch (e) {
        if (!alreadySeeded(`role ${r.name}`, e)) throw e;
      }
    } else {
      // Round 5, D5-S28 key-merge: ADD any seed keys missing from
      // the stored role's permissions, NEVER remove keys (an admin
      // removing a dangerous key must survive re-seeds, per M-B5).
      // Future releases that add a key to a system role therefore
      // reach existing installs without a hand-edit in the panel.
      const stored = Array.isArray(existing.permissions)
        ? (existing.permissions as unknown[]).filter(
            (k): k is string => typeof k === 'string',
          )
        : [];
      const added = r.permissions.filter((k) => !stored.includes(k));
      if (added.length > 0) {
        await prisma.role.update({
          where: { id: existing.id },
          data: { permissions: [...stored, ...added] },
        });
        console.log(
          `Role '${r.name}': added missing seed permission key(s): ${added.join(', ')} (existing keys untouched)`,
        );
      }
    }
  }
  console.log('Roles seeded');

  const adminEmail = process.env.ADMIN_EMAIL;
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (adminEmail && adminPassword) {
    const superAdmin = await prisma.role.findFirstOrThrow({ where: { name: 'super_admin', ownerId: null } });
    // Round 5, D5-S27: the old upsert + unconditional "ready" log
    // lied twice — an ADMIN_EMAIL matching an existing player or
    // suspended user was left untouched while the log claimed the
    // super admin was ready, and a rotated ADMIN_PASSWORD was
    // silently ignored for an existing admin (update: {} never
    // touches the password). Verify after the upsert instead.
    const preExisting = await prisma.user.findUnique({ where: { email: adminEmail } });
    if (preExisting) {
      console.warn(
        `Super admin ${adminEmail} already exists — ADMIN_PASSWORD was NOT applied (upsert never overwrites an existing password). Reset it in the panel if rotation was intended.`,
      );
    }
    const admin = await prisma.user.upsert({
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
    if (admin.roleId !== superAdmin.id || admin.status !== UserStatus.active) {
      console.warn(
        `Super admin ${adminEmail} is NOT ready: existing account holds role ${admin.roleId} / status ${admin.status} (expected the super_admin role, active). Fix the account in the panel — the seed deliberately does not overwrite it.`,
      );
    } else {
      console.log(`Super admin ready: ${adminEmail}`);
    }
  } else if (adminEmail && !adminPassword) {
    // Round 5, D5-S42: ADMIN_EMAIL alone seeds nothing — warn
    // instead of silently skipping the admin block.
    console.warn(
      'ADMIN_EMAIL is set but ADMIN_PASSWORD is missing — no super admin was created or verified. Set both to seed the admin.',
    );
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
    if (existing) continue;
    // Round 4, M-B4: re-running the seed used to create a SECOND
    // default plan (admin makes Premium the default, deletes Normal,
    // someone re-runs db:seed: Normal is recreated with isDefault
    // true, and defaultPlan() picked nondeterministically between
    // two defaults). A seed plan only becomes the default when no
    // default exists yet; otherwise it is created non-default and the
    // operator is told to pick in the panel. (The service's
    // defaultPlan() is also ordered by createdAt now, so even a
    // legacy duplicate resolves deterministically.)
    let isDefault = planData.isDefault;
    if (isDefault) {
      const anyDefault = await prisma.plan.findFirst({ where: { isDefault: true } });
      if (anyDefault) {
        console.log(
          `Plan ${planData.name} would be a second default (existing: ${anyDefault.name}) — creating it non-default instead.`,
        );
        isDefault = false;
      }
    }
    try {
      await prisma.plan.create({ data: { ...planData, isDefault } });
    } catch (e) {
      if (!alreadySeeded(`plan ${planData.name}`, e)) throw e;
    }
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
  // admin renamed or removed. Round 4, borderline note: that holds
  // for PARTIAL deletions only — if the admin deletes the ENTIRE
  // catalog, count() === 0 and re-seed resurrects all 10 sports / 12
  // amenities. That total-wipe case is accepted (an empty catalog is
  // worse than a resurrected one); partial deletions stay deleted.
  if ((await prisma.sport.count()) === 0) {
    for (const [i, name] of DEFAULT_SPORTS.entries()) {
      try {
        await prisma.sport.create({ data: { name, sortOrder: i } });
      } catch (e) {
        if (!alreadySeeded(`sport ${name}`, e)) throw e;
      }
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
      try {
        await prisma.amenity.create({ data: { name, sortOrder: i } });
      } catch (e) {
        if (!alreadySeeded(`amenity ${name}`, e)) throw e;
      }
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
