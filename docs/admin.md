# Super-admin panel backend

Everything under `/admin/*` defaults to the `'*'` permission (class-level
`@RequirePerm('*')`) — but a method-level `@RequirePerm` **overrides**
the class wildcard, so a role granted that key passes too (e.g. any role
with `venues.onboard` can onboard — see below). Every mutating action
writes an `audit_logs` row (`GET /admin/audit-logs?entity=` — `OffsetPage`).

## Approvals

Queues sort oldest-first and page by cursor (30 per page, with totals;
the sidebar badge reads the totals).

| Method & path | Effect |
|---|---|
| `GET /admin/owners/pending` | Owner accounts with `status: pending` |
| `GET /admin/venues/pending` | Venues with `status: pending` (+ owner contact, readiness checklist, photo strip) |
| `GET /admin/courts/pending` | Courts with `status: pending` |
| `POST /admin/venues/:id/approve` | `pending → approved` — venue goes live in the app; blocked until go-live readiness passes (see owner doc); billing starts here (`billingStartAt`) |
| `POST /admin/venues/:id/reject` | `pending → rejected` |
| `POST /admin/venues/:id/suspend` | Hidden from the app immediately |
| `POST /admin/courts/:id/approve` | Court goes live (visible/bookable) |
| `POST /admin/courts/:id/reject` | Court rejected; re-queues on owner edit |
| `PATCH /admin/users/:id/status` | `{ "status": "pending" \| "active" \| "suspended" }` — also approves owners |
| `PATCH /admin/venues/:id/staff-roles` | `{ "roleIds": [...] }` — which staff roles this arena's owner may hand out |

## Venues directory & onboarding

| Method & path | Effect |
|---|---|
| `GET /admin/venues` | All venues (any status) with owner, courts, plan + billing summary. Sorts `bookings\|views\|clicks\|revenue\|name`, ranges `7d\|30d\|all` |
| `GET /admin/venues/:id` | Venue + owner, courts with booking counts, full payment info, stats band (GMV, seats used/allowed = plan `maxStaff` per venue, per-court stats) |
| `POST /admin/venues/onboard` | Perm `venues.onboard`: creates owner login (owner role, bcrypt) + venue + courts in one transaction, attaches default arena staff-role allowances, optional `planId` + `approveNow`. `approveNow` still creates the venue as `pending` — approval + billing start happen at the real approve, no bypass |
| `POST /admin/venues/:id/images` (+ `PATCH/DELETE .../images[/tag]`) | Admin image management, perm `venues.onboard` |
| `POST /admin/venues/:id/court-limit` | Per-arena `courtLimitOverride` (override wins; a change below current usage needs a danger confirmation; the owner is notified) |
| `POST /admin/venues/:id/staff-limit` | Per-arena `staffLimitOverride` (same rules) |

## Moderation & reports

Moderation states: `none|paused|blocked|disabled` + a **mandatory** reason.
Any non-`none` state hides the venue on all public surfaces; the owner is
notified and sees a banner. Sanction / pause / suspend / overdue-pause of
a venue cancels its upcoming bookings and notifies players.

| Method & path | Effect |
|---|---|
| `POST /admin/venues/:id/moderation` | Set moderation state + reason |
| `GET /admin/venue-reports` | Player venue reports (one open report per player per arena) |
| `POST /admin/venue-reports/:id/resolve` | `open → reviewed\|actioned\|dismissed`. An `actioned` `fake_listing`/`unsafe` report auto-pauses the venue |

## Charts

Daily stacked bars by play date (Asia/Karachi): bookings by state (with
toggle chips), revenue, traffic. Presets `7d|30d|90d` + custom From–To
(inclusive, reversed ranges swapped, 366d cap).

| Method & path | Effect |
|---|---|
| `GET /admin/venues/:id/series` | Venue chart series |
| `GET /admin/courts/:id/detail` | Court detail (totals, chart, spec, recent bookings) |

## Plans & billing

| Method & path | Effect |
|---|---|
| `GET/POST /admin/plans`, `PATCH/DELETE /admin/plans/:id` | Plan cards (create/edit, delete guards). Seed: Basic Rs 18,000/yr, Normal Rs 36,000/yr DEFAULT, Premium Rs 60,000/yr; first 3 months free by default. `GET /admin/plans/features` is the feature catalog |
| `GET /admin/plans/venues` | Venue billing table (`OffsetPage`) |
| `GET /admin/venues/:id/billing` | One venue's plan + payment history |
| `POST /admin/venues/:id/plan` | Change plan (freezes via `frozenPlanId` until the period ends) |
| `POST /admin/venues/:id/billing/extend-free` | Extend free period (idempotency-keyed) |
| `POST /admin/venues/:id/billing/mark-paid` | Mark a period paid — rejects any amount ≠ the period price; due = `totalPrice` (already net); billing freezes at the first unpaid period, no auto-resume |
| `POST /admin/venues/:id/billing/:paymentId/void` | Void the latest standing payment (rewinds stacked `freeUntilOverride`; period-less payments refused; re-mark accepts the original amount) |

Yearly flat fee per venue is the launch model; commission % is only a
settings lever (default 0).

## Users

| Method & path | Notes |
|---|---|
| `GET /admin/users?q=&role=&status=` | Search by name/email, filter by role/status (`OffsetPage`, Load more) |
| `GET /admin/users/:id` | Full user + role |
| `POST /admin/users` | `{ email, name?, phone?, password?, roleId }` — create anyone directly |
| `PATCH /admin/users/:id/role` | `{ "roleId" }` |
| `POST /admin/users/:id/reset-strikes` | Zeroes `noShowCount`, re-activates |

## Roles & permissions

`GET /admin/roles` (with user counts), `POST /admin/roles`
`{ name, scope: "platform"|"arena", description?, permissions[] }`,
`PATCH /admin/roles/:id`, `DELETE /admin/roles/:id` (non-system, unused only).
`GET /admin/permissions` returns the key catalog for the panel UI.
System roles can't be deleted; `super_admin` can't be edited.
Owner-created roles (`Role.ownerId`) can only be **disabled** by an admin,
never edited — a disabled role grants zero permissions.

## Badges

Tiered arena badges (seeded: Rising → Top → Elite). `GET/POST /admin/badges`,
`PATCH/DELETE /admin/badges/:id`. Grant/downgrade per venue:
`POST /admin/venues/:id/badges { "badgeId" }`,
`DELETE /admin/venues/:id/badges/:badgeId`.
The nightly scheduler auto-grants tier 1 on the simple v1 rule
(rating ≥ 4.5, ≥ 5 reviews); thresholds get refined with real data.

## Promos

`GET/POST /admin/promos`, `PATCH /admin/promos/:id` (toggle `isActive`).
Create: `{ code?, kind: "percent"|"flat", value, maxDiscount?, maxUses?,
perUserLimit?, validTo, isActive? }` — code auto-generated if omitted
(max 24 chars; `maxDiscount: 0` rejected). The admin list shows Scope:
platform vs venue (owner promos are venue-scoped). Admin editing is
activate/deactivate only.

## Disputes

`GET /admin/disputes?status=` (with booking, venue, raiser;
`OffsetPage`).
`POST /admin/disputes/:id/resolve`:
```json
{ "action": "confirm_no_show", "resolution": "CCTV confirmed absence" }
// confirm_no_show → booking no_show + player strike (one transaction)
// dismiss → status resolved/dismissed with the note
```
There is no `credit` action (removed). One dispute per booking ever after
a terminal resolution.

## Broadcasts & banners

`POST /admin/broadcasts { title, body, city? }` → FCM push to all (or city)
device tokens, chunked at 500; returns `{ targeted }`. Every broadcast is
recorded at send with delivered/failed counts (`GET /admin/broadcasts`
history, `CursorPage`).
Banners CMS: `GET/POST /admin/banners`, `PATCH/DELETE /admin/banners/:id`
`{ title, imageUrl, linkUrl?, city?, isActive?, endsAt? }` — shown in the app via
public `GET /banners`.

## Suggestions & moderation

- `GET /admin/suggestions?status=`, `PATCH /admin/suggestions/:id { status }`
  (`new → contacted → converted/dismissed`).
- `PATCH /admin/game-posts/:id/curate|uncurate`, `DELETE /admin/game-posts/:id`.
- `DELETE /admin/reviews/:id` (venue rating recomputed).

## Booking interventions

`GET /admin/bookings/:id` (full detail),
`POST /admin/bookings/:id/cancel`, `POST /admin/bookings/:id/force-confirm`
— support tools for when the arena can't act.

## Settings

`GET /admin/settings` → `[{ key, value, updatedAt }]`.
`PATCH /admin/settings { settings: { commissionPct: "10", ... } }`.
Keys used by the API: `commissionPct`, `pendingExpiryHours`,
`noShowStrikeLimit`, `referralWelcomePct`, `referralRewardPct`,
`graceDays`. Parsed validate-or-fallback (strike limit 3/min 1, pending
expiry 2h, grace 14d).
