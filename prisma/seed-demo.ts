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
import { BookingStatus, PrismaClient, VenueStatus } from '@prisma/client';
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
    avatarUrl: string;
  }[] = [
    { email: 'demo.signup1@demo.areana.pk', name: 'Ahmed Raza', phone: '+92 321 5550101', city: 'Lahore', daysAgo: 1, avatarUrl: 'https://randomuser.me/api/portraits/men/32.jpg' },
    { email: 'demo.signup2@demo.areana.pk', name: 'Bilal Hussain', phone: '+92 333 5550102', city: 'Karachi', daysAgo: 2, avatarUrl: 'https://randomuser.me/api/portraits/men/45.jpg' },
    { email: 'demo.signup3@demo.areana.pk', name: 'Usman Tariq', phone: '+92 345 5550103', city: 'Islamabad', daysAgo: 4, avatarUrl: 'https://randomuser.me/api/portraits/men/67.jpg' },
  ];
  for (const s of signups) {
    const exists = await prisma.user.findUnique({ where: { email: s.email } });
    if (exists) {
      // Backfill the portrait for signups seeded before avatarUrl existed.
      if (!exists.avatarUrl) {
        await prisma.user.update({
          where: { id: exists.id },
          data: { avatarUrl: s.avatarUrl },
        });
      }
      continue;
    }
    await prisma.user.create({
      data: {
        email: s.email,
        name: s.name,
        phone: s.phone,
        city: s.city,
        passwordHash: passwordHash2,
        roleId: ownerRole.id,
        status: 'pending',
        avatarUrl: s.avatarUrl,
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

  // ------------------------------------------------------------------
  // Disputes inbox demo — demo players + past bookings + disputes in
  // every state, so Admin → Disputes shows real rows, working status
  // counts and the resolve flow. Idempotent on its own: each dispute's
  // booking carries a deterministic checkInCode (DEMO-DISP-n) and an
  // existing one is skipped, so re-running never duplicates.
  // ------------------------------------------------------------------
  const playerRole = await prisma.role.findFirst({
    where: { name: 'player', ownerId: null },
  });
  const superAdminUser = await prisma.user.findFirst({
    where: { role: { name: 'super_admin' } },
    orderBy: { createdAt: 'asc' },
  });
  if (!playerRole) {
    console.log('Player role missing — skipping the disputes demo (run `npm run db:seed` first).');
  } else {
    const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000);
    const demoPlayers: { email: string; name: string; phone: string; city: string }[] = [
      { email: 'demo.player1@demo.areana.pk', name: 'Ali Hamza', phone: '+92 321 5550201', city: 'Lahore' },
      { email: 'demo.player2@demo.areana.pk', name: 'Sara Khan', phone: '+92 333 5550202', city: 'Lahore' },
      { email: 'demo.player3@demo.areana.pk', name: 'Hassan Sheikh', phone: '+92 345 5550203', city: 'Karachi' },
      { email: 'demo.player4@demo.areana.pk', name: 'Fatima Noor', phone: '+92 300 5550204', city: 'Islamabad' },
    ];
    const players = [];
    for (const p of demoPlayers) {
      const player = await prisma.user.upsert({
        where: { email: p.email },
        update: {},
        create: { ...p, roleId: playerRole.id, status: 'active' },
      });
      players.push(player);
    }

    const disputeSpecs: {
      player: number;
      venueName: string;
      bookingDaysAgo: number;
      startMinutes: number;
      bookingStatus: BookingStatus;
      reason: string;
      disputeStatus: 'open' | 'resolved' | 'dismissed';
      createdHoursAgo: number;
      resolution?: string;
      resolvedHoursAgo?: number;
    }[] = [
      {
        player: 0,
        venueName: 'Demo Active Arena',
        bookingDaysAgo: 2,
        startMinutes: 1140,
        bookingStatus: BookingStatus.completed,
        reason:
          'We arrived on time but the court was given to another group for the first 20 minutes — our hour started late and nobody adjusted it.',
        disputeStatus: 'open',
        createdHoursAgo: 5,
      },
      {
        player: 1,
        venueName: 'Demo Trial Arena',
        bookingDaysAgo: 3,
        startMinutes: 1200,
        bookingStatus: BookingStatus.completed,
        reason:
          'The floodlights went out halfway through our match and staff refused to extend our time or move us to the other court.',
        disputeStatus: 'open',
        createdHoursAgo: 26,
      },
      {
        player: 2,
        venueName: 'Demo Founding Arena',
        bookingDaysAgo: 4,
        startMinutes: 1080,
        bookingStatus: BookingStatus.no_show,
        reason:
          'I was marked as a no-show but I reached the arena 10 minutes late and played the full hour — please remove the strike.',
        disputeStatus: 'open',
        createdHoursAgo: 49,
      },
      {
        player: 3,
        venueName: 'Demo Active Arena',
        bookingDaysAgo: 5,
        startMinutes: 1260,
        bookingStatus: BookingStatus.completed,
        reason:
          'The turf was still wet and slippery from cleaning when our slot started — we had to stop after 15 minutes because it was unsafe.',
        disputeStatus: 'open',
        createdHoursAgo: 73,
      },
      {
        player: 1,
        venueName: 'Demo Trial Arena',
        bookingDaysAgo: 7,
        startMinutes: 1140,
        bookingStatus: BookingStatus.completed,
        reason:
          'Paid for a full hour but the venue closed the second half for a private event without telling us in advance.',
        disputeStatus: 'resolved',
        createdHoursAgo: 144,
        resolution:
          'Verified with the venue — the second half was closed for a private event. Player credited at the venue for the lost half hour.',
        resolvedHoursAgo: 120,
      },
      {
        player: 0,
        venueName: 'Demo Founding Arena',
        bookingDaysAgo: 8,
        startMinutes: 1200,
        bookingStatus: BookingStatus.completed,
        reason:
          'Equipment rental was charged but no balls or net were provided for our game.',
        disputeStatus: 'dismissed',
        createdHoursAgo: 168,
        resolution:
          'Check-in scan and the venue log confirm the full hour was played with venue equipment — dispute dismissed.',
        resolvedHoursAgo: 144,
      },
    ];

    for (let i = 0; i < disputeSpecs.length; i++) {
      const spec = disputeSpecs[i];
      const checkInCode = `DEMO-DISP-${i + 1}`;
      const existing = await prisma.booking.findUnique({ where: { checkInCode } });
      if (existing) continue;
      const venue = await prisma.venue.findFirst({ where: { name: spec.venueName } });
      const court = venue
        ? await prisma.court.findFirst({ where: { venueId: venue.id }, orderBy: { name: 'asc' } })
        : null;
      if (!venue || !court) {
        console.log(`Skipping dispute demo ${i + 1}: ${spec.venueName} (or a court) not found.`);
        continue;
      }
      const booking = await prisma.booking.create({
        data: {
          userId: players[spec.player].id,
          venueId: venue.id,
          courtId: court.id,
          date: daysFromNow(-spec.bookingDaysAgo),
          startMinutes: spec.startMinutes,
          endMinutes: spec.startMinutes + 60,
          totalPrice: court.pricePerHour,
          status: spec.bookingStatus,
          checkInCode,
          checkedInAt:
            spec.bookingStatus === BookingStatus.completed
              ? hoursAgo(spec.createdHoursAgo + 3)
              : null,
          createdAt: hoursAgo(spec.createdHoursAgo + 3),
        },
      });
      await prisma.dispute.create({
        data: {
          bookingId: booking.id,
          raisedById: players[spec.player].id,
          reason: spec.reason,
          status: spec.disputeStatus,
          resolution: spec.disputeStatus === 'open' ? null : (spec.resolution ?? null),
          resolvedById:
            spec.disputeStatus === 'open' ? null : (superAdminUser?.id ?? null),
          resolvedAt:
            spec.disputeStatus === 'open'
              ? null
              : hoursAgo(spec.resolvedHoursAgo ?? spec.createdHoursAgo - 24),
          createdAt: hoursAgo(spec.createdHoursAgo),
        },
      });
      console.log(
        `✓ Dispute (${spec.disputeStatus}): ${players[spec.player].name} @ ${spec.venueName}`,
      );
    }
  }

  // ------------------------------------------------------------------
  // Suggestions inbox demo — venue suggestions (arena leads) in every
  // state, so Admin → Suggestions shows real cards, working status
  // counts and the status-change actions. Idempotent on its own:
  // suggestions are keyed by their (unique demo) venue name and an
  // existing one is skipped. Suggested-by points at the demo players
  // from the disputes section, with two anonymous entries to show the
  // "Anonymous" rendering.
  // ------------------------------------------------------------------
  const suggestionSpecs: {
    name: string;
    city: string;
    phone?: string;
    note: string;
    status: 'new' | 'contacted' | 'converted' | 'dismissed';
    daysAgo: number;
    byPlayer?: string;
  }[] = [
    {
      name: 'Smash Padel Club',
      city: 'Lahore',
      phone: '+92 321 5550301',
      note: 'New padel club in Johar Town with 3 courts — not on any booking app yet. Great lighting and a small cafe.',
      status: 'new',
      daysAgo: 1,
      byPlayer: 'demo.player1@demo.areana.pk',
    },
    {
      name: 'Goal Arena Bahria',
      city: 'Lahore',
      phone: '+92 333 5550302',
      note: 'Big 8v8 turf in Bahria Town. Always packed on weekends, bookings are still handled on a notebook at the gate.',
      status: 'new',
      daysAgo: 2,
    },
    {
      name: 'Skyline Futsal Rooftop',
      city: 'Karachi',
      phone: '+92 345 5550303',
      note: 'Rooftop futsal in Clifton, open till 2am. Would be perfect for late-night games.',
      status: 'new',
      daysAgo: 3,
      byPlayer: 'demo.player2@demo.areana.pk',
    },
    {
      name: 'Champion Sports Complex',
      city: 'Islamabad',
      phone: '+92 300 5550304',
      note: 'Multi-sport complex in F-7 with tennis courts and cricket nets under one roof.',
      status: 'contacted',
      daysAgo: 5,
      byPlayer: 'demo.player3@demo.areana.pk',
    },
    {
      name: 'Velocity Badminton Hall',
      city: 'Lahore',
      phone: '+92 321 5550305',
      note: 'Six indoor badminton courts in Model Town, proper wooden flooring. Hosts a league every winter.',
      status: 'contacted',
      daysAgo: 6,
    },
    {
      name: 'PowerPlay Turf',
      city: 'Lahore',
      phone: '+92 333 5550306',
      note: 'Suggested during beta testing in our players group — the owner signed up and the arena is live now.',
      status: 'converted',
      daysAgo: 12,
      byPlayer: 'demo.player4@demo.areana.pk',
    },
    {
      name: 'City Ground DHA',
      city: 'Karachi',
      note: 'Huge open ground near Phase 6 — turns out it was demolished last year, so this lead is dead.',
      status: 'dismissed',
      daysAgo: 9,
      byPlayer: 'demo.player1@demo.areana.pk',
    },
  ];
  for (const spec of suggestionSpecs) {
    const exists = await prisma.venueSuggestion.findFirst({
      where: { name: spec.name },
    });
    if (exists) continue;
    const suggester = spec.byPlayer
      ? await prisma.user.findUnique({ where: { email: spec.byPlayer } })
      : null;
    await prisma.venueSuggestion.create({
      data: {
        name: spec.name,
        city: spec.city,
        phone: spec.phone ?? null,
        note: spec.note,
        status: spec.status,
        suggestedById: suggester?.id ?? null,
        createdAt: daysFromNow(-spec.daysAgo),
      },
    });
    console.log(`✓ Suggestion (${spec.status}): ${spec.name} — ${spec.city}`);
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
