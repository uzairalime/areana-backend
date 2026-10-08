# areana-api

NestJS + PostgreSQL + Prisma backend for Areana — sports arena booking platform.
Implements the full v1 plan (`~/workspace/areana/PLAN.md`).

## Quick start

```bash
cp .env.example .env          # then set JWT secrets + ADMIN_PASSWORD
docker compose up -d          # postgres + mailpit (email catcher)
npm install
npx prisma migrate dev --name init
npm run db:seed               # roles, badges, settings + super admin from ADMIN_EMAIL/ADMIN_PASSWORD
npm run start:dev
```

- API: http://localhost:3000/api
- Swagger docs: http://localhost:3000/api/docs
- Mailpit (read OTP emails): http://localhost:8025 — OTPs are also logged to console in dev

> Keep `TZ=Asia/Karachi` — "today" and slot cutoffs are computed in server local time.

## Auth & permissions

| Who | How |
|---|---|
| Players (Flutter app) | Passwordless: `POST /auth/request-otp` → 6-digit code by email → `POST /auth/verify-otp` (first verify with `name` + `phone` + `city` = signup; optional `referralCode`) |
| Owners (web) | `POST /auth/owner/register` (needs super-admin approval) → `POST /auth/staff/login` |
| Staff / super admin (web) | `POST /auth/staff/login` (email + password) |

JWT access (15 min) + refresh (7 days). **Roles are data-driven**: the `roles` table holds
permission keys, the JWT carries `roleId` + `roleName`, and the `PermGuard` loads the
role's permissions per request. Routes use `@RequirePerm('bookings.manage')` /
`@RequireAnyPerm(...)`; super admin holds the `'*'` wildcard. New roles and permission
mixes are created in the super-admin panel — no code changes.

## Key routes

```
# auth
POST /api/auth/request-otp  POST /api/auth/verify-otp  POST /api/auth/refresh  GET /api/auth/me
POST /api/auth/owner/register   POST /api/auth/staff/login
# discovery (public)
GET  /api/venues?city=&sport=&q=          GET /api/venues/:id
GET  /api/venues/:id/courts               GET /api/courts/:id/availability?date=YYYY-MM-DD
GET  /api/search/slots?sport=&city=&date=   ("football tonight near DHA")
GET  /api/banners?city=                   GET /api/v/:id  GET /api/join/:code  (deep links)
# player bookings
POST /api/bookings  POST /api/bookings/recurring
GET  /api/bookings/me?filter=upcoming|past  PATCH /api/bookings/:id/cancel
POST /api/bookings/:id/share  GET /api/bookings/shared/:code  POST /api/bookings/shared/:code/join
POST /api/bookings/:id/reschedule   GET /api/bookings/validate-promo?code=&courtId=
# player social
GET/POST/DELETE /api/favorites   POST /api/reviews   GET /api/venues/:id/reviews
GET/POST /api/game-posts  POST /api/game-posts/:id/join|leave
POST /api/venue-suggestions   POST /api/disputes   GET /api/referrals/me
GET/PATCH /api/users/me   POST /api/users/me/device-tokens
# owner panel
GET  /api/owner/dashboard
GET/POST /api/owner/venues   PATCH /api/owner/venues/:id   POST /api/owner/venues/:id/submit
POST /api/owner/venues/:id/images (multipart)
.../venues/:venueId/courts CRUD, /venues/:venueId/blocks, /blocks
GET  /api/owner/bookings?venueId=&date=&status=
PATCH /api/owner/bookings/:id/accept|reject|cancel|check-in|no-show
POST /api/owner/bookings/walk-in   POST /api/owner/bookings/check-in-scan
GET  /api/owner/reschedules   PATCH /api/owner/reschedules/:id/accept|reject
GET  /api/owner/venues/:venueId/allowed-roles|staff   POST /api/owner/venues/:venueId/staff
GET  /api/owner/customers   GET /api/owner/reviews   POST /api/owner/reviews/:id/reply
# super admin (permission '*')
GET /api/admin/analytics/overview|trends|breakdown|venues  (+ drill-downs)
GET /api/admin/owners/pending   GET /api/admin/venues/pending
POST /api/admin/venues/:id/approve|reject|suspend   PATCH /api/admin/venues/:id/staff-roles
GET/POST/PATCH/DELETE /api/admin/users|roles|promos|badges|banners
GET /api/admin/permissions   GET /api/admin/disputes   GET /api/admin/audit-logs
POST /api/admin/broadcasts   GET/PATCH /api/admin/settings
POST /api/admin/bookings/:id/cancel|force-confirm
```

## Structure

```
prisma/           schema.prisma (full v1 data model) + seed.ts (roles, badges, settings, super admin)
src/
  main.ts         bootstrap: /api prefix, validation, CORS, swagger, /uploads static
  app.module.ts   module wiring + global JwtAuthGuard / PermGuard
  config.ts       env loading + validation (JWT, SMTP, FCM, storage)
  common/         prisma.ts (global), auth.ts (RequirePerm/RequireAnyPerm/Public + guards),
                  permissions.ts (permission catalog), date.util.ts
  auth/           OTP (players) + password login (staff), owner registration, referral hook
  users/          profile, device tokens (FCM)
  venues/ courts/ availability/   public browse + slot engine (server-side source of truth)
  search/         availability-first slot search across venues
  bookings/       transaction-safe create (multi-slot, overlap-checked, promo-aware),
                  recurring series, share links, reschedule requests, no-show strikes
  game-posts/     find players/opponents board (+ curated)
  promos/         promo codes + referrals (validate/apply/personal, rewards)
  favorites/ reviews/ badges/ disputes/ broadcasts/ suggestions/
  deeplink/       /v/:id and /join/:code landing pages
  owner/          dashboard, approvals, calendar ops, staff, customers, review replies
  admin/          approvals, layered analytics, disputes, audit, roles, broadcasts, settings
  notifications/  email + FCM push (log-only in dev); dead-token cleanup
  storage/        venue images — local disk (dev) / S3-compatible (prod)
  scheduler/      expire pendings, reminders, auto-complete, referral rewards, badge recompute
```

## Design notes

- **Availability is computed, never stored**: slots = court hours ÷ slot length − bookings − owner blocks − past slots − booking-window rules.
- **No double booking**: overlap check across the full multi-slot range + `@@unique(courtId, date, startMinutes)` backstop → clean `409 Conflict`, safe under concurrency.
- **Time**: `DATE` + minutes-since-midnight ints, server `TZ=Asia/Karachi`. No timezone math on clients.
- **Approval flow**: booking starts `pending` (holds the slot) → owner accepts/rejects → auto-expires after `pendingExpiryHours` (setting, default 2). Per-venue `autoAccept` toggle. Walk-ins are confirmed instantly.
- **Staff governance**: super admin designs arena-scope roles and sets `venue_allowed_roles` per arena; owners create team logins only from those roles.
- **Background jobs**: `@nestjs/schedule` crons — expire pendings (15m), reminders (30m), nightly auto-complete + referral rewards + badge recompute.
- **Phase 2**: `payments/` module placeholder — Easypaisa/JazzCash go there.
