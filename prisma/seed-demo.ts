/**
 * Demo data for the plans & billing scenarios (run AFTER `npm run db:seed`):
 *
 *   npm run db:seed:demo
 *
 * Creates one demo arena per scenario so every screen has something real
 * to show:
 *   1. Free trial        — Normal plan, approved a month ago
 *   2. Active (paid)     — Premium plan, current period settled
 *   3. Payment due       — Basic plan, free period ended 5 days ago (grace)
 *   4. Overdue — paused  — Basic plan, unpaid past grace, hidden from players
 *   5. Specialized plan  — custom founding plan, long free period
 *   6. Pending approval  — submitted, waiting in Admin → Approvals
 *   7. Draft             — owner still setting up
 *
 * Demo owners sign in with password "Demo@1234". Dates are computed
 * relative to today, so the statuses hold whenever the script runs.
 * Running it twice is safe: it exits early if the demo data exists.
 */
import { PrismaClient, VenueStatus } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

function daysFromNow(days: number): Date {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d;
}
function monthsFromNow(months: number): Date {
  const d = new Date();
  d.setMonth(d.getMonth() + months);
  return d;
}

const COURTS = [
  {
    name: 'Turf A',
    sport: 'Football',
    size: '7v7',
    surface: 'artificial_grass',
    indoor: false,
    pricePerHour: 4500,
    openMinutes: 480,
    closeMinutes: 1440,
    slotMinutes: 60,
  },
  {
    name: 'Padel Court 1',
    sport: 'Padel',
    size: '2v2',
    surface: 'hard',
    indoor: true,
    pricePerHour: 3000,
    openMinutes: 600,
    closeMinutes: 1380,
    slotMinutes: 60,
  },
];

async function main() {
  const marker = await prisma.user.findFirst({
    where: { email: { endsWith: '@demo.areana.pk' } },
  });
  const hasCore = !!marker;
  if (hasCore) {
    console.log('Core demo data already exists — skipping the scenario arenas.');
  }

  const ownerRole = await prisma.role.findFirst({ where: { name: 'owner' } });
  if (!ownerRole) throw new Error('Owner role missing — run `npm run db:seed` first.');
  const plans = await prisma.plan.findMany({ where: { isCustom: false } });
  const basic = plans.find((p) => p.name === 'Basic');
  const normal = plans.find((p) => p.name === 'Normal');
  const premium = plans.find((p) => p.name === 'Premium');
  if (!basic || !normal || !premium) {
    throw new Error('Launch plans missing — run `npm run db:seed` first.');
  }
  const arenaRoles = await prisma.role.findMany({ where: { scope: 'arena' } });

  if (!hasCore) {
  let founding = await prisma.plan.findFirst({
    where: { name: 'Founding Partner (Demo)', isCustom: true },
  });
  if (!founding) {
    founding = await prisma.plan.create({
      data: {
        name: 'Founding Partner (Demo)',
        priceYearly: 12000,
        freeMonths: 6,
        features: [
          'peak_pricing',
          'advanced_availability',
          'staff_accounts',
          'customers_insight',
          'featured_placement',
        ],
        isCustom: true,
      },
    });
  }

  const passwordHash = await bcrypt.hash('Demo@1234', 10);

  const scenarios: {
    label: string;
    venueName: string;
    planId: string | null;
    status: VenueStatus;
    billingStartAt?: Date;
    billingPaidUntil?: Date;
    billingPaused?: boolean;
  }[] = [
    {
      label: 'Free trial (Normal)',
      venueName: 'Demo Trial Arena',
      planId: normal.id,
      status: VenueStatus.approved,
      billingStartAt: daysFromNow(-30),
    },
    {
      label: 'Active — paid (Premium)',
      venueName: 'Demo Active Arena',
      planId: premium.id,
      status: VenueStatus.approved,
      billingStartAt: monthsFromNow(-5),
      // First paid period runs from freeUntil (start + 3mo) for a year.
      billingPaidUntil: monthsFromNow(10),
    },
    {
      label: 'Payment due (Basic, in grace)',
      venueName: 'Demo Due Arena',
      planId: basic.id,
      status: VenueStatus.approved,
      billingStartAt: daysFromNow(-(3 * 30 + 5)),
    },
    {
      label: 'Overdue — paused (Basic)',
      venueName: 'Demo Overdue Arena',
      planId: basic.id,
      status: VenueStatus.approved,
      billingStartAt: monthsFromNow(-4),
      billingPaused: true,
    },
    {
      label: 'Specialized plan (trial)',
      venueName: 'Demo Founding Arena',
      planId: founding.id,
      status: VenueStatus.approved,
      billingStartAt: daysFromNow(-10),
    },
    {
      label: 'Pending approval',
      venueName: 'Demo Pending Arena',
      planId: null,
      status: VenueStatus.pending,
    },
    {
      label: 'Draft',
      venueName: 'Demo Draft Arena',
      planId: null,
      status: VenueStatus.draft,
    },
  ];

  for (let i = 0; i < scenarios.length; i++) {
    const s = scenarios[i];
    const owner = await prisma.user.create({
      data: {
        email: `demo.owner${i + 1}@demo.areana.pk`,
        name: `Demo Owner ${i + 1}`,
        phone: `+92 300 000000${i + 1}`,
        passwordHash,
        roleId: ownerRole.id,
        status: 'active',
      },
    });
    const venue = await prisma.venue.create({
      data: {
        ownerId: owner.id,
        name: s.venueName,
        address: `${i + 1} Demo Street, DHA Phase 5`,
        city: 'Lahore',
        phone: '+92 42 35770000',
        lat: 31.4697 + i * 0.01,
        lng: 74.3723 + i * 0.01,
        sports: ['Football', 'Padel'],
        amenities: ['Floodlights', 'Parking', 'Cafe', 'Changing rooms'],
        status: s.status,
        planId: s.planId,
        billingStartAt: s.billingStartAt,
        billingPaidUntil: s.billingPaidUntil,
        billingPaused: s.billingPaused ?? false,
      },
    });
    if (arenaRoles.length > 0) {
      await prisma.venueAllowedRole.createMany({
        data: arenaRoles.map((r) => ({ venueId: venue.id, roleId: r.id })),
        skipDuplicates: true,
      });
    }
    for (const c of COURTS) {
      await prisma.court.create({ data: { venueId: venue.id, ...c } });
    }
    console.log(`✓ ${s.label}: ${s.venueName} (owner login demo.owner${i + 1}@demo.areana.pk)`);
  }

  }

  // ------------------------------------------------------------------
  // Approvals inbox demo — pending owner signups + court submissions,
  // so Admin → Approvals shows every section. Idempotent on its own:
  // safe to re-run even when the core demo data above already exists.
  // ------------------------------------------------------------------
  const passwordHash2 = await bcrypt.hash('Demo@1234', 10);
  const signups: {
    email: string;
    name: string;
    phone: string;
    city: string;
    daysAgo: number;
  }[] = [
    { email: 'demo.signup1@demo.areana.pk', name: 'Ahmed Raza', phone: '+92 321 5550101', city: 'Lahore', daysAgo: 1 },
    { email: 'demo.signup2@demo.areana.pk', name: 'Bilal Hussain', phone: '+92 333 5550102', city: 'Karachi', daysAgo: 2 },
    { email: 'demo.signup3@demo.areana.pk', name: 'Usman Tariq', phone: '+92 345 5550103', city: 'Islamabad', daysAgo: 4 },
  ];
  for (const s of signups) {
    const exists = await prisma.user.findUnique({ where: { email: s.email } });
    if (exists) continue;
    await prisma.user.create({
      data: {
        email: s.email,
        name: s.name,
        phone: s.phone,
        city: s.city,
        passwordHash: passwordHash2,
        roleId: ownerRole.id,
        status: 'pending',
        createdAt: daysFromNow(-s.daysAgo),
      },
    });
    console.log(`✓ Owner signup awaiting approval: ${s.name} (${s.email})`);
  }

  const courtSubmissions: {
    venueName: string;
    court: (typeof COURTS)[number];
  }[] = [
    {
      venueName: 'Demo Active Arena',
      court: {
        name: 'Futsal Court 2',
        sport: 'Futsal',
        size: '5v5',
        surface: 'artificial_grass',
        indoor: true,
        pricePerHour: 3500,
        openMinutes: 600,
        closeMinutes: 1440,
        slotMinutes: 60,
      },
    },
    {
      venueName: 'Demo Trial Arena',
      court: {
        name: 'Cricket Cage 1',
        sport: 'Cricket',
        size: 'nets',
        surface: 'artificial_grass',
        indoor: false,
        pricePerHour: 5000,
        openMinutes: 480,
        closeMinutes: 1380,
        slotMinutes: 60,
      },
    },
    {
      venueName: 'Demo Founding Arena',
      court: {
        name: 'Tennis Court 1',
        sport: 'Tennis',
        size: 'singles',
        surface: 'hard',
        indoor: false,
        pricePerHour: 2800,
        openMinutes: 420,
        closeMinutes: 1320,
        slotMinutes: 60,
      },
    },
  ];
  for (const sub of courtSubmissions) {
    const venue = await prisma.venue.findFirst({ where: { name: sub.venueName } });
    if (!venue) continue;
    const exists = await prisma.court.findFirst({
      where: { venueId: venue.id, name: sub.court.name },
    });
    if (exists) continue;
    await prisma.court.create({
      data: { venueId: venue.id, ...sub.court, status: 'pending' },
    });
    console.log(`✓ Court submission awaiting approval: ${sub.court.name} at ${sub.venueName}`);
  }

  // A second pending arena (Karachi) so the approvals grid shows variety.
  const coastalOwner = await prisma.user.findUnique({
    where: { email: 'demo.owner8@demo.areana.pk' },
  });
  if (!coastalOwner) {
    const owner8 = await prisma.user.create({
      data: {
        email: 'demo.owner8@demo.areana.pk',
        name: 'Demo Owner 8',
        phone: '+92 300 0000008',
        passwordHash: passwordHash2,
        roleId: ownerRole.id,
        status: 'active',
      },
    });
    const venue8 = await prisma.venue.create({
      data: {
        ownerId: owner8.id,
        name: 'Demo Coastal Arena',
        address: '14 Sea View Road, Clifton Block 4',
        city: 'Karachi',
        phone: '+92 21 35830000',
        lat: 24.8138,
        lng: 67.0299,
        sports: ['Football', 'Cricket'],
        amenities: ['Floodlights', 'Parking', 'Showers', 'Washrooms'],
        status: VenueStatus.pending,
        planId: null,
      },
    });
    if (arenaRoles.length > 0) {
      await prisma.venueAllowedRole.createMany({
        data: arenaRoles.map((r) => ({ venueId: venue8.id, roleId: r.id })),
        skipDuplicates: true,
      });
    }
    for (const c of COURTS) {
      await prisma.court.create({ data: { venueId: venue8.id, ...c } });
    }
    console.log('✓ Pending approval (Karachi): Demo Coastal Arena (owner demo.owner8@demo.areana.pk)');
  }

  console.log('\nDemo seed complete. Owner password for all demo accounts: Demo@1234');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
