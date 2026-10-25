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
 * Running it twice is safe: every section is idempotent on its own
 * (scenario arenas are keyed by owner email + venue name, so a partial
 * run is repaired by re-running — Round 4, M-S4 used to gate the whole
 * core block on ANY @demo.areana.pk user, so one stray demo-domain
 * signup silently skipped all 7 arenas while the script printed
 * success).
 */
import { BookingStatus, PrismaClient, VenueStatus } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

function daysFromNow(days: number): Date {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d;
}
// Clamped month arithmetic (mirrors src/common/date.util addMonths):
// setMonth alone rolls Jan 31 + 1mo to Mar 3; clamping to the target
// month's last day keeps billing periods exactly 12 months long.
// Round 5, D5-S24: monthsFromNow used to be the RAW unclamped
// setMonth — an Aug-31 run rolled billingPaidUntil Jun 31 → Jul 1,
// 2027, while the context period is Jun 30, 2026–Jun 30, 2027, so
// the seeded ledger row matched neither context boundary (and
// void-then-re-mark missed the original amount on a repriced plan).
// There is no unclamped month helper left: every month offset goes
// through addMonths, so first runs cannot drift either.
function addMonths(d: Date, months: number): Date {
  const day = d.getDate();
  const out = new Date(d);
  out.setDate(1);
  out.setMonth(out.getMonth() + months);
  const last = new Date(out.getFullYear(), out.getMonth() + 1, 0).getDate();
  out.setDate(Math.min(day, last));
  return out;
}

// Round 4, M-S5: demo venues used to be approved with ZERO photos, so
// the first later edit dropped them to pending and re-approval was
// blocked by the readiness gate (4+ photos, one tagged per sport).
// Seeded venues now carry 4 placeholder photos tagged per sport, so
// they satisfy the gate they bypassed at creation.
function demoPhotos(seed: string, sports: string[]): { images: string[]; photos: { url: string; sport: string }[] } {
  const images = [1, 2, 3, 4].map(
    (k) => `https://picsum.photos/seed/areana-demo-${seed}-${k}/800/600`,
  );
  const photos = images.map((url, i) => ({
    url,
    sport: sports[i % sports.length],
  }));
  return { images, photos };
}

// Round 5, D5-T8: a P2002 on a single seed item means "already
// seeded" (a concurrent/partial run created it) — log and continue,
// never abort the whole demo seed on one duplicate.
async function createOrAlreadySeeded<T>(
  label: string,
  fn: () => Promise<T>,
): Promise<T | null> {
  try {
    return await fn();
  } catch (e) {
    if ((e as { code?: string })?.code === 'P2002') {
      console.log(`Already seeded, skipping: ${label}`);
      return null;
    }
    throw e;
  }
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
  // Round 4, M-S7: role lookups are owner-scoped now — the old
  // unscoped findFirst({ name: 'owner' }) could attach another
  // owner's custom role to demo users, and findMany({ scope: 'arena' })
  // attached EVERY arena-scope role (including owner-created custom
  // roles) to demo venues via VenueAllowedRole.
  const ownerRole = await prisma.role.findFirst({ where: { name: 'owner', ownerId: null } });
  if (!ownerRole) throw new Error('Owner role missing — run `npm run db:seed` first.');
  const plans = await prisma.plan.findMany({ where: { isCustom: false } });
  // Round 5, D5-S29: a name lookup that misses falls back to
  // defaultPlan() semantics (the isDefault plan) instead of
  // dead-ending — an admin renaming Normal → "Standard" used to
  // abort the whole demo seed, and re-running db:seed then
  // recreated a second "Normal" tier. The fallback is logged so a
  // renamed plan is visible, not silent.
  const pickPlan = (name: string) => {
    const byName = plans.find((p) => p.name === name);
    if (byName) return byName;
    const fallback = plans.find((p) => p.isDefault) ?? null;
    if (fallback) {
      console.warn(
        `Demo seed: plan '${name}' not found by name — falling back to the default plan '${fallback.name}'.`,
      );
    }
    return fallback;
  };
  const basic = pickPlan('Basic');
  const normal = pickPlan('Normal');
  const premium = pickPlan('Premium');
  if (!basic || !normal || !premium) {
    throw new Error('Launch plans missing — run `npm run db:seed` first.');
  }
  // Round 5, D5-T10: the player role is arena-scoped in seed.ts, so
  // the old unfiltered query attached it to demo venues via
  // VenueAllowedRole. Players must never be an allowed arena role.
  const arenaRoles = await prisma.role.findMany({
    where: { scope: 'arena', ownerId: null, name: { not: 'player' } },
  });

  // Round 4, M-S8: the Founding plan used to live inside the core
  // block, so deleting the demo venues (plan-delete guard permits it
  // once the venue count is 0) while any demo-domain user remained
  // meant the plan was never recreated on re-run. It is guarded by
  // its own name lookup now, independent of the core block.
  let founding = await prisma.plan.findFirst({
    where: { name: 'Founding Partner (Demo)', isCustom: true },
  });
  if (!founding) {
    const created = await createOrAlreadySeeded('Founding Partner (Demo) plan', () =>
      prisma.plan.create({
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
      }),
    );
    founding =
      created ??
      (await prisma.plan.findFirst({
        where: { name: 'Founding Partner (Demo)', isCustom: true },
      }));
    if (!founding) throw new Error('Founding Partner (Demo) plan could not be created.');
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
      billingStartAt: addMonths(new Date(), -5),
      // First paid period runs from freeUntil (start + 3mo) for a year.
      billingPaidUntil: addMonths(new Date(), 10),
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
      billingStartAt: addMonths(new Date(), -4),
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

  // Round 4, M-S4: each scenario is idempotent on its own (owner
  // email + venue name), so a partial run is repaired by re-running
  // instead of silently skipping everything behind a domain marker.
  for (let i = 0; i < scenarios.length; i++) {
    const s = scenarios[i];
    const ownerEmail = `demo.owner${i + 1}@demo.areana.pk`;
    let owner = await prisma.user.findUnique({ where: { email: ownerEmail } });
    if (owner) {
      // Round 5, D5-S26: a real player who registered a demo email
      // via OTP before the seed ran used to be silently adopted as
      // a demo owner — venues attached to a player-role user, panel
      // login 403ing, while the script printed the owner login.
      // Never adopt: abort loudly instead.
      if (owner.roleId !== ownerRole.id || owner.status !== 'active') {
        throw new Error(
          `Refusing to adopt ${ownerEmail} as a demo owner: existing account holds role ${owner.roleId} / status ${owner.status} (expected the system owner role, active). Re-point or delete that account, then re-run the seed.`,
        );
      }
    } else {
      owner = await prisma.user.create({
        data: {
          email: ownerEmail,
          name: `Demo Owner ${i + 1}`,
          phone: `+92 300 000000${i + 1}`,
          passwordHash,
          roleId: ownerRole.id,
          status: 'active',
        },
      });
    }
    const gallery = demoPhotos(`arena${i + 1}`, ['Football', 'Padel']);
    let venue = await prisma.venue.findFirst({
      where: { ownerId: owner.id, name: s.venueName },
    });
    if (!venue) {
      venue = await prisma.venue.create({
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
          images: gallery.images,
          photos: gallery.photos,
          status: s.status,
          planId: s.planId,
          billingStartAt: s.billingStartAt,
          billingPaidUntil: s.billingPaidUntil,
          billingPaused: s.billingPaused ?? false,
        },
      });
    } else {
      // Round 5, D5-T9: backfill the gallery ONLY when BOTH images
      // and photos are empty — a deliberate clear of one (e.g. an
      // operator emptying photos to re-tag) must not be restored
      // from the seed gallery.
      const imagesEmpty = !venue.images || venue.images.length === 0;
      const photosEmpty =
        !venue.photos ||
        (Array.isArray(venue.photos) && venue.photos.length === 0);
      if (imagesEmpty && photosEmpty) {
        // Backfill the gallery for arenas seeded before photos existed,
        // so they satisfy the readiness gate on their next edit.
        await prisma.venue.update({
          where: { id: venue.id },
          data: { images: gallery.images, photos: gallery.photos },
        });
      }
      // Round 5, D5-S25: an existing venue is NOT silently repaired
      // to its scenario — a billing sweep may have paused it, or an
      // admin may have re-planned it, and the old code still printed
      // ✓. Log the drift (stored vs scenario) instead of a silent ✓
      // for the fields the seed owns; dates are relative to "today"
      // on every run, so only plan/status/pause/paid-presence are
      // compared (exact billing dates would false-positive daily).
      const drifts: string[] = [];
      if (venue.planId !== s.planId) {
        drifts.push(`planId stored=${venue.planId ?? 'null'} scenario=${s.planId ?? 'null'}`);
      }
      if (venue.status !== s.status) {
        drifts.push(`status stored=${venue.status} scenario=${s.status}`);
      }
      if (venue.billingPaused !== (s.billingPaused ?? false)) {
        drifts.push(`billingPaused stored=${venue.billingPaused} scenario=${s.billingPaused ?? false}`);
      }
      if ((venue.billingPaidUntil !== null) !== (s.billingPaidUntil !== undefined)) {
        drifts.push(
          `billingPaidUntil stored=${venue.billingPaidUntil ? 'set' : 'null'} scenario=${s.billingPaidUntil ? 'set' : 'null'}`,
        );
      }
      if (drifts.length > 0) {
        console.warn(
          `DRIFT (existing venue, NOT repaired): ${s.venueName} — ${drifts.join('; ')}. ` +
            'Re-run the seed only after fixing this in the panel, or accept the drift deliberately.',
        );
      }
    }
    if (arenaRoles.length > 0) {
      await prisma.venueAllowedRole.createMany({
        data: arenaRoles.map((r) => ({ venueId: venue.id, roleId: r.id })),
        skipDuplicates: true,
      });
    }
    for (const c of COURTS) {
      const exists = await prisma.court.findFirst({
        where: { venueId: venue.id, name: c.name },
      });
      if (!exists)
        await createOrAlreadySeeded(`court ${c.name} at ${s.venueName}`, () =>
          prisma.court.create({ data: { venueId: venue.id, ...c } }),
        );
    }
    // Round 4, M-S6: the Active arena used to claim a paid period
    // (billingPaidUntil) with ZERO ledger rows, so mark-paid could
    // double-settle or skip a period. The claimed period now gets
    // its matching VenuePayment row — derived from the venue's stored
    // billingPaidUntil (not recomputed dates), so re-runs agree with
    // the original run instead of drifting by setMonth clamping.
    if (s.venueName === 'Demo Active Arena' && venue.billingPaidUntil && venue.planId) {
      const periodEnd = venue.billingPaidUntil;
      const existingPayment = await prisma.venuePayment.findFirst({
        where: { venueId: venue.id, periodEnd },
      });
      if (!existingPayment) {
        await prisma.venuePayment.create({
          data: {
            venueId: venue.id,
            planId: venue.planId,
            amount: premium.priceYearly,
            method: 'other',
            note: 'Demo seed — matches seeded billingPaidUntil',
            periodStart: addMonths(periodEnd, -12),
            periodEnd,
            recordedById: null,
          },
        });
      }
    }
    console.log(`✓ ${s.label}: ${s.venueName} (owner login ${ownerEmail})`);
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
      // Round 5, D5-S26 (same shape as scenario owners): a real
      // user holding a demo.signup email must never get the demo
      // avatar backfilled onto their account — skip them entirely.
      if (exists.roleId !== ownerRole.id) {
        console.warn(
          `Skipping demo signup ${s.email}: existing account does not hold the owner role — refusing to adopt it.`,
        );
        continue;
      }
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
    const venue = await prisma.venue.findFirst({
      where: { name: sub.venueName, owner: { email: { endsWith: '@demo.areana.pk' } } },
    });
    if (!venue) continue;
    const exists = await prisma.court.findFirst({
      where: { venueId: venue.id, name: sub.court.name },
    });
    if (exists) continue;
    await createOrAlreadySeeded(`court submission ${sub.court.name}`, () =>
      prisma.court.create({
        data: { venueId: venue.id, ...sub.court, status: 'pending' },
      }),
    );
    console.log(`✓ Court submission awaiting approval: ${sub.court.name} at ${sub.venueName}`);
  }

  // A second pending arena (Karachi) so the approvals grid shows variety.
  // Round 5, D5-S23: the whole Coastal block used to be gated on
  // `if (!coastalOwner)` — owner and venue created inside one
  // branch — so a crash after the owner insert but before the venue
  // insert skipped the venue FOREVER on every re-run. Split into
  // the same owner-then-venue lookups as the scenarios, so a partial
  // run is repaired by re-running.
  let coastalOwner = await prisma.user.findUnique({
    where: { email: 'demo.owner8@demo.areana.pk' },
  });
  if (coastalOwner) {
    if (coastalOwner.roleId !== ownerRole.id || coastalOwner.status !== 'active') {
      throw new Error(
        `Refusing to adopt demo.owner8@demo.areana.pk as a demo owner: existing account holds role ${coastalOwner.roleId} / status ${coastalOwner.status} (expected the system owner role, active).`,
      );
    }
  } else {
    coastalOwner = await prisma.user.create({
      data: {
        email: 'demo.owner8@demo.areana.pk',
        name: 'Demo Owner 8',
        phone: '+92 300 0000008',
        passwordHash: passwordHash2,
        roleId: ownerRole.id,
        status: 'active',
      },
    });
  }
  let venue8 = await prisma.venue.findFirst({
    where: { ownerId: coastalOwner.id, name: 'Demo Coastal Arena' },
  });
  if (!venue8) {
    const coastalGallery = demoPhotos('coastal', ['Football', 'Cricket']);
    venue8 = await prisma.venue.create({
      data: {
        ownerId: coastalOwner.id,
        name: 'Demo Coastal Arena',
        address: '14 Sea View Road, Clifton Block 4',
        city: 'Karachi',
        phone: '+92 21 35830000',
        lat: 24.8138,
        lng: 67.0299,
        sports: ['Football', 'Cricket'],
        amenities: ['Floodlights', 'Parking', 'Showers', 'Washrooms'],
        images: coastalGallery.images,
        photos: coastalGallery.photos,
        status: VenueStatus.pending,
        planId: null,
      },
    });
    console.log('✓ Pending approval (Karachi): Demo Coastal Arena (owner demo.owner8@demo.areana.pk)');
  }
  if (arenaRoles.length > 0) {
    await prisma.venueAllowedRole.createMany({
      data: arenaRoles.map((r) => ({ venueId: venue8.id, roleId: r.id })),
      skipDuplicates: true,
    });
  }
  for (const c of COURTS) {
    const exists = await prisma.court.findFirst({
      where: { venueId: venue8.id, name: c.name },
    });
    if (!exists)
      await createOrAlreadySeeded(`court ${c.name} at Demo Coastal Arena`, () =>
        prisma.court.create({ data: { venueId: venue8.id, ...c } }),
      );
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
      // Round 5, D5-S26 (same shape as scenario owners): never
      // silently adopt a real user holding a demo.player email —
      // disputes would attach to a real account. Abort loudly.
      const existingPlayer = await prisma.user.findUnique({ where: { email: p.email } });
      if (existingPlayer) {
        if (existingPlayer.roleId !== playerRole.id) {
          throw new Error(
            `Refusing to adopt ${p.email} as a demo player: existing account holds role ${existingPlayer.roleId} (expected the system player role).`,
          );
        }
        players.push(existingPlayer);
        continue;
      }
      const player = await prisma.user.create({
        data: { ...p, roleId: playerRole.id, status: 'active' },
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
      const venue = await prisma.venue.findFirst({
        where: { name: spec.venueName, owner: { email: { endsWith: '@demo.areana.pk' } } },
      });
      const court = venue
        ? await prisma.court.findFirst({ where: { venueId: venue.id }, orderBy: { name: 'asc' } })
        : null;
      if (!venue || !court) {
        console.log(`Skipping dispute demo ${i + 1}: ${spec.venueName} (or a court) not found.`);
        continue;
      }
      const booking = await prisma.$transaction(async (tx) => {
        // Round 5, D5-S22: booking and dispute used to be separate
        // awaits with the skip keyed on the booking — a crash after
        // the booking insert but before the dispute insert meant
        // every re-run saw the booking and skipped the dispute
        // FOREVER, while output still ended "Demo seed complete".
        // One transaction now: either both rows exist or neither
        // does, so the booking-keyed skip can never lose a dispute.
        const b = await tx.booking.create({
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
        await tx.dispute.create({
          data: {
            bookingId: b.id,
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
        return b;
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
  // suggestions are keyed by name + exact note (Round 4 trivial: a
  // bare-name key let a real lead sharing a demo name silently skip
  // the demo suggestion). Suggested-by points at the demo players
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
      where: { name: spec.name, note: spec.note },
    });
    if (exists) continue;
    const suggester = spec.byPlayer
      ? await prisma.user.findUnique({ where: { email: spec.byPlayer } })
      : null;
    await createOrAlreadySeeded(`suggestion ${spec.name}`, () =>
      prisma.venueSuggestion.create({
        data: {
          name: spec.name,
          city: spec.city,
          phone: spec.phone ?? null,
          note: spec.note,
          status: spec.status,
          suggestedById: suggester?.id ?? null,
          createdAt: daysFromNow(-spec.daysAgo),
        },
      }),
    );
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
