# Super-admin panel backend

Everything under `/admin/*` requires the `'*'` permission (class-level
`@RequirePerm('*')`) — only `super_admin` passes. Every mutating action writes
an `audit_logs` row (`GET /admin/audit-logs?entity=`).

## Approvals

| Method & path | Effect |
|---|---|
| `GET /admin/owners/pending` | Owner accounts with `status: pending` |
| `GET /admin/venues/pending` | Venues with `status: pending` (+ owner contact) |
| `POST /admin/venues/:id/approve` | `pending → approved` — venue goes live in the app |
| `POST /admin/venues/:id/reject` | `pending → rejected` |
| `POST /admin/venues/:id/suspend` | Hidden from the app immediately |
| `PATCH /admin/users/:id/status` | `{ "status": "pending" \| "active" \| "suspended" }` — also approves owners |
| `PATCH /admin/venues/:id/staff-roles` | `{ "roleIds": [...] }` — which staff roles this arena's owner may hand out |

## Users

| Method & path | Notes |
|---|---|
| `GET /admin/users?q=&role=&status=` | Search by name/email, filter by role/status |
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
perUserLimit?, validTo, isActive? }` — code auto-generated if omitted.

## Disputes

`GET /admin/disputes?status=` (with booking, venue, raiser).
`POST /admin/disputes/:id/resolve`:
```json
{ "action": "confirm_no_show", "resolution": "CCTV confirmed absence" }
// confirm_no_show → booking no_show + player strike (one transaction)
// dismiss | credit → status resolved/dismissed with the note
```

## Broadcasts & banners

`POST /admin/broadcasts { title, body, city? }` → FCM push to all (or city)
device tokens; returns `{ targeted }`.
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
`noShowStrikeLimit`, `referralWelcomePct`, `referralRewardPct`.
