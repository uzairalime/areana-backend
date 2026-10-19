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
  if (marker) {
    console.log('Demo data already exists — skipping. (Delete the @demo.areana.pk users to reseed.)');
    return;
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
