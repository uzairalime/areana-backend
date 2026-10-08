#!/usr/bin/env node
/**
 * Areana API smoke test — exercises the full v1 flow end to end:
 *   health → admin login → owner register/approve → venue+court → approve →
 *   player OTP signup (via Mailpit) → slot search → booking → owner accept →
 *   player bookings → analytics.
 *
 * Run:  node scripts/smoke-test.mjs
 * Env:  API_URL (default http://localhost:3000)
 *       MAILPIT_URL (default http://localhost:8025)
 *       ADMIN_EMAIL / ADMIN_PASSWORD (seeded super admin)
 *
 * Requires: API running (`npm run start:dev`), postgres + mailpit up,
 *           `npx prisma migrate dev` and `npm run db:seed` already done.
 */
const API = process.env.API_URL ?? 'http://localhost:3000';
const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:8025';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? 'admin@areana.pk';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? 'changeme';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function api(method, path, token, body) {
  const res = await fetch(`${API}/api${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-json */ }
  if (!res.ok) {
    throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 200)}`);
  }
  return json;
}

/** Pull the latest OTP code for `email` out of Mailpit. */
async function readOtp(email) {
  for (let i = 0; i < 10; i++) {
    const { messages } = await (await fetch(`${MAILPIT}/api/v1/messages`)).json();
    const msg = (messages ?? []).find((m) =>
      (m.To ?? []).some((t) => t.Address === email),
    );
    if (msg) {
      const full = await (await fetch(`${MAILPIT}/api/v1/message/${msg.ID}`)).json();
      const m = (full.Text ?? '').match(/\b(\d{6})\b/);
      if (m) return m[1];
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('OTP email not found in Mailpit');
}

function pickSlot() {
  // Aligned to the hourly grid, ~3h out (past the 2h min-advance), else tomorrow 18:00.
  const now = new Date();
  const target = new Date(now.getTime() + 180 * 60_000);
  target.setMinutes(0, 0, 0);
  let startMinutes = target.getHours() * 60;
  let date = new Date(target);
  if (startMinutes >= 22 * 60) {
    startMinutes = 18 * 60;
    date = new Date(now.getTime() + 24 * 3600_000);
  }
  const ds = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  return { date: ds, startMinutes };
}

async function main() {
  const ts = Date.now().toString(36);
  const playerEmail = `player+${ts}@example.com`;
  const ownerEmail = `owner+${ts}@example.com`;

  // 1. Health + DB
  try {
    const h = await api('GET', '/health');
    check('health', h.ok === true && h.db === 'up', JSON.stringify(h));
  } catch (e) { check('health', false, e.message); return summary(); }

  // 2. Super admin login
  let adminToken;
  try {
    const r = await api('POST', '/auth/staff/login', null, { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    adminToken = r.accessToken;
    check('admin login', !!adminToken);
  } catch (e) { check('admin login', false, e.message); return summary(); }

  // 3. Owner register → approve → login
  let ownerToken, ownerId;
  try {
    const reg = await api('POST', '/auth/owner/register', null, {
      email: ownerEmail, password: 'ownerpass123', name: 'Test Owner', phone: '03000000001',
    });
    ownerId = reg.userId;
    await api('PATCH', `/admin/users/${ownerId}/status`, adminToken, { status: 'active' });
    const login = await api('POST', '/auth/staff/login', null, { email: ownerEmail, password: 'ownerpass123' });
    ownerToken = login.accessToken;
    check('owner register → approve → login', !!ownerToken);
  } catch (e) { check('owner register → approve → login', false, e.message); return summary(); }

  // 4. Venue + court → submit → approve
  let venueId, courtId;
  try {
    const venue = await api('POST', '/owner/venues', ownerToken, {
      name: `Smoke Turf ${ts}`, address: 'DHA Phase 5', city: 'Lahore', sports: ['Football'],
    });
    venueId = venue.id;
    const court = await api('POST', `/owner/venues/${venueId}/courts`, ownerToken, {
      name: 'Turf A', sport: 'Football', size: '7v7', pricePerHour: 2500,
    });
    courtId = court.id;
    await api('POST', `/owner/venues/${venueId}/submit`, ownerToken);
    await api('POST', `/admin/venues/${venueId}/approve`, adminToken);
    check('venue + court → submit → approve', !!courtId);
  } catch (e) { check('venue + court → submit → approve', false, e.message); return summary(); }

  // 5. Player OTP signup via Mailpit
  let playerToken;
  try {
    await api('POST', '/auth/request-otp', null, { email: playerEmail });
    const code = await readOtp(playerEmail);
    const verified = await api('POST', '/auth/verify-otp', null, {
      email: playerEmail, code, name: 'Test Player', phone: '03000000002', city: 'Lahore',
    });
    playerToken = verified.accessToken;
    check('player OTP signup', !!playerToken);
  } catch (e) { check('player OTP signup', false, e.message); return summary(); }

  // 6. Slot search finds the new court
  const slot = pickSlot();
  try {
    const s = await api('GET', `/search/slots?city=Lahore&sport=Football&date=${slot.date}`, playerToken);
    const found = (s.results ?? []).some((r) => r.courts.some((c) => c.id === courtId));
    check('slot search', found, `${s.results?.length ?? 0} venues`);
  } catch (e) { check('slot search', false, e.message); }

  // 7. Booking (pending) → owner accept → player sees confirmed
  try {
    const booking = await api('POST', '/bookings', playerToken, {
      courtId, date: slot.date, startMinutes: slot.startMinutes,
    });
    const pendingOk = booking.status === 'pending';
    await api('PATCH', `/owner/bookings/${booking.id}/accept`, ownerToken);
    const mine = await api('GET', '/bookings/me?filter=upcoming', playerToken);
    const confirmed = mine.some((b) => b.id === booking.id && b.status === 'confirmed');
    check('booking pending → accept → confirmed', pendingOk && confirmed, booking.id);
  } catch (e) { check('booking pending → accept → confirmed', false, e.message); }

  // 8. Double-booking the same slot must fail with 409
  try {
    await api('POST', '/bookings', playerToken, { courtId, date: slot.date, startMinutes: slot.startMinutes });
    check('double-booking rejected', false, 'second booking succeeded!');
  } catch (e) {
    check('double-booking rejected', /409/.test(e.message), e.message.slice(0, 60));
  }

  // 9. Game board + favorites + promo validate
  try {
    await api('POST', '/game-posts', playerToken, {
      sport: 'Football', city: 'Lahore', date: slot.date, startMinutes: slot.startMinutes,
      playersNeeded: 10, note: 'smoke test',
    });
    await api('POST', '/favorites', playerToken, { venueId });
    const favs = await api('GET', '/favorites', playerToken);
    check('game post + favorites', favs.length > 0);
  } catch (e) { check('game post + favorites', false, e.message); }

  // 10. Admin analytics sees the activity
  try {
    const o = await api('GET', '/admin/analytics/overview', adminToken);
    check('admin analytics', o.players >= 1 && o.venuesByStatus?.approved >= 1,
      `${o.players} players, ${o.gmv} GMV`);
  } catch (e) { check('admin analytics', false, e.message); }

  summary();
}

function summary() {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
