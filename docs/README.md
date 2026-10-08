# Areana API — Documentation

Complete reference for the Areana v1 backend. Every section documents its
endpoints (method, path, auth, request, response, errors), the models involved,
and how the pieces are used together.

## Contents

| File | Covers |
|---|---|
| [README.md](README.md) | This index + global conventions |
| [auth.md](auth.md) | Player OTP, owner/staff login, tokens, `/users/me` |
| [permissions.md](permissions.md) | RBAC: roles table, permission keys, guards, staff governance |
| [discovery.md](discovery.md) | Venues, courts, availability engine, slot search, banners, deep links |
| [bookings.md](bookings.md) | Booking lifecycle, multi-slot, recurring, reschedules, share links, promos at checkout |
| [player-social.md](player-social.md) | Favorites, reviews, game board, promos & referrals, disputes, suggestions |
| [owner.md](owner.md) | Owner panel backend: dashboard, approvals, calendar ops, staff, customers |
| [admin.md](admin.md) | Super-admin: approvals, users, roles, badges, disputes, broadcasts, settings, interventions |
| [analytics.md](analytics.md) | Layered analytics: KPIs → trends → breakdowns → leaderboard → drill-downs |
| [platform.md](platform.md) | Notifications, image storage, scheduler jobs, health |
| [models.md](models.md) | Every database model, field by field |

Interactive explorer: `http://localhost:3000/api/docs` (Swagger, auto-generated).

## Swagger UI

Every endpoint below is also live in Swagger at `/api/docs`, generated from the
code's decorators (`@ApiTags`, `@ApiProperty`, `@ApiBearerAuth`).

- **Trying authenticated endpoints:** get a token first (`POST /auth/verify-otp`
  or `/auth/staff/login`), then click **Authorize** in Swagger and paste
  `Bearer <accessToken>`. Player endpoints need a player token; `/owner/*`
  needs an owner/staff token; `/admin/*` needs the super-admin token.
- **Schemas:** every request/response DTO is documented under *Schemas* —
  required fields, types, and examples come straight from the
  `class-validator` + `@ApiProperty` decorators, so Swagger never drifts from
  the code.
- This markdown documents the *why* and the flows; Swagger documents the exact
  wire shapes. Use both.

## Global conventions

**Base URL.** All routes live under `/api`, e.g. `POST http://localhost:3000/api/bookings`.

**Auth.** `Authorization: Bearer <accessToken>` (15-minute TTL).
Refresh with `POST /auth/refresh`. Endpoints marked **public** need no token;
everything else needs a token, and most need specific permissions (see
[permissions.md](permissions.md)).

**Dates & times.**
- Dates are `YYYY-MM-DD` strings (`"2026-10-08"`), stored as `DATE`.
- Times of day are integers: **minutes since midnight** (`1080` = 6:00 PM).
- The server runs on `Asia/Karachi`; "today" and all cutoffs use server time.
  Clients never do timezone math.

**Money.** Decimal strings/numbers in PKR (`2500`, `1875.50`).

**Errors.** NestJS format, always JSON:
```json
{ "statusCode": 409, "message": "Slot overlaps an existing booking", "error": "Conflict" }
```
Common codes: `400` validation/business rule, `401` bad/expired token,
`403` missing permission or not-your-venue, `404` not found,
`409` conflict (double-booking, duplicate), `429` rate limited (OTP).

**IDs.** Opaque `cuid` strings (`"cm3x..."`). Never guessable, never sequential.

**Pagination.** List endpoints return `{ total, page, limit, data }` unless noted.

**Soft rules enforced everywhere.**
- Only `approved` venues are visible to players; drafts/pending/rejected/suspended are hidden.
- Only `active` courts can be booked.
- Pending bookings hold slots exactly like confirmed ones.
- A venue's `minAdvanceMinutes` / `maxAdvanceDays` window is enforced on every player booking.
