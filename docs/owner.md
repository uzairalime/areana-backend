# Owner panel backend

Everything the arena owner (and their staff) does. All routes are under
`/owner/*`. Permissions decide *what* you may do; `venue_staff` links decide
*which venues* you may touch (`403 Not your venue` otherwise).

## Dashboard

### `GET /owner/dashboard?venueId=&date=` — authenticated
One call for the panel home screen:
```json
{
  "date": "2026-10-08",
  "todayBookings": [ { "id": "...", "startMinutes": 1080, "status": "pending",
                        "court": { "name": "Turf A" },
                        "user": { "name": "Ahmed", "phone": "0300..." } } ],
  "pendingCount": 3, "confirmedCount": 12,
  "revenueToday": 37500, "revenueMonth": 812500,
  "occupancyPct": 64
}
```
Revenue counts `confirmed` + `completed`; occupancy = booked slot-minutes ÷
total court-minutes for the day.

## Venues

| Method & path | Perm | Notes |
|---|---|---|
| `GET /owner/venues` | — | Your (or assigned) venues, with court counts |
| `POST /owner/venues` | `venues.manage` | Creates as `draft`; attaches default allowed staff roles |
| `PATCH /owner/venues/:id` | `venues.manage` | Name, address, sports, amenities, `autoAccept`, `minAdvanceMinutes`, `maxAdvanceDays` |
| `POST /owner/venues/:id/submit` | `venues.manage` | `draft → pending`; blocked until go-live readiness passes (see below) |
| `POST /owner/venues/:id/images` | `venues.manage` | `multipart/form-data`, field `image` (JPEG/PNG/WebP ≤5 MB) + optional `sport` tag → URL appended to `images`, entry appended to `photos` |
| `PATCH /owner/venues/:id/images/tag` | `venues.manage` | `{ "url", "sport" }` — tag an existing photo to a sport |
| `PATCH /owner/venues/:id/images/order` | `venues.manage` | `{ "urls" }` — the exact current set in the new order (first = cover) |
| `DELETE /owner/venues/:id/images` | `venues.manage` | `{ "url": "..." }` removes from venue and storage |

New venues go `draft → pending → approved` (super admin). Approved venues are
live in the app; edits don't unpublish them.

**Go-live readiness (API-enforced).** A venue cannot be submitted (owner)
or approved (admin) until ALL pass: ≥ 4 photos, amenities non-empty,
lat/lng set, ≥ 1 photo tagged per sport in `venue.sports`, ≥ 1 active
court. The API returns the gaps; the panels show a live checklist.

## Courts

| Method & path | Perm | Notes |
|---|---|---|
| `GET /owner/venues/:venueId/courts` | `courts.manage` | All courts incl. inactive |
| `POST /owner/venues/:venueId/courts` | `courts.manage` | `{ name, sport, size?, surface?, indoor?, pricePerHour, openMinutes?, closeMinutes?, slotMinutes? }` — starts `pending`, invisible/unbookable until an admin approves (rejected courts re-queue on edit) |
| `PATCH /owner/courts/:id` | `courts.manage` | Any field incl. `isActive` (soft-off a court). Clashing future bookings need `acknowledgeConflicts`; bookings are grandfathered, never auto-cancelled. A rejected court re-queues on edit |

### Timings & availability

| Method & path | Perm | Notes |
|---|---|---|
| `PUT /owner/courts/:courtId/weekly-hours` | `schedule.manage` | `{ days: [{ weekday, windows: [{ startMinutes, endMinutes }] }], acknowledgeConflicts?, expectedVersion? }` — split shifts; empty `days: []` is rejected; stale `expectedVersion` → `409` (bumps `weeklyHoursVersion`) |
| `POST /owner/courts/:courtId/recurring-blocks` | `schedule.manage` | `{ weekdays, startMinutes, endMinutes, reason?, startsOn?, endsOn? }` |
| `DELETE /owner/recurring-blocks/:id` | `schedule.manage` | |
| `POST /owner/venues/:venueId/closures` | `schedule.manage` | Full-day closure |
| `GET /owner/courts/:courtId/availability` | `schedule.manage` | The court's availability rules (template, blocks, price windows) |

Overnight courts supported (max 20h/day). The open/close minutes are the
fallback when a court has no weekly template.

### Peak pricing

| Method & path | Perm | Notes |
|---|---|---|
| `POST /owner/courts/:courtId/price-windows` | `schedule.manage` | `{ weekdays, startMinutes, endMinutes, pricePerHour, startsOn?, endsOn? }` — no-overlap; one special rate per slot |
| `DELETE /owner/price-windows/:id` | `schedule.manage` | |

Gated by the venue's plan (`peak_pricing` feature). See
[peak-pricing.md](peak-pricing.md).

## Slot blocks

| Method & path | Perm |
|---|---|
| `GET /owner/venues/:venueId/blocks?date=` | `blocks.manage` or `schedule.manage` |
| `POST /owner/blocks` | `blocks.manage` or `schedule.manage` |
| `DELETE /owner/blocks/:id` | `blocks.manage` or `schedule.manage` |

```json
// POST /owner/blocks
{ "courtId": "cm3x...", "date": "2026-10-09",
  "startMinutes": 1080, "endMinutes": 1200, "reason": "Maintenance" }
```
Blocked ranges are excluded from availability like bookings.

## Booking operations

| Method & path | Perm | Notes |
|---|---|---|
| `GET /owner/bookings?venueId=&date=&status=` | `bookings.manage` or `bookings.review` | `OffsetPage` (default 50), newest first, with court/user/participant count |
| `PATCH /owner/bookings/:id/accept` | `bookings.review` | `pending → confirmed`; player gets a push |
| `PATCH /owner/bookings/:id/reject` | `bookings.review` | `{ "reason" }` → `cancelled`; player gets a push with the reason |
| `POST /owner/bookings/recurring/:recurrenceId/accept` | `bookings.review` | `{ "venueId" }` — batch-accepts a series; conflicts re-checked, `{ accepted[], skipped[] }` |
| `PATCH /owner/bookings/:id/cancel` | `bookings.manage` | Cancel an upcoming booking |
| `PATCH /owner/bookings/:id/check-in` | `bookings.manage` | Sets `checkedInAt` |
| `PATCH /owner/bookings/:id/no-show` | `bookings.manage` | → `no_show` + player strike (auto-suspend at limit) |
| `POST /owner/bookings/walk-in` | `booking.manage` | `{ courtId, date, startMinutes, slotCount?, guestName }` — future walk-ins are confirmed but checked in only when the slot is today; skips the advance-notice window |
| `POST /owner/bookings/check-in-scan` | `bookings.manage` | `{ "code": "X8T2QW9M4P", "venueId": "..." }` — validates a QR, returns the booking for confirmation |

## Reschedule queue

| Method & path | Perm | Notes |
|---|---|---|
| `GET /owner/reschedules?status=pending` | `bookings.manage` or `bookings.review` | With booking, court, and player details |
| `PATCH /owner/reschedules/:id/accept` | `bookings.review` | Conflict re-checked; booking moved + confirmed atomically; the booking is re-priced on the new slot |
| `PATCH /owner/reschedules/:id/reject` | `bookings.review` | `{ "reason" }`; original booking untouched |

## Team (staff)

| Method & path | Perm | Notes |
|---|---|---|
| `GET /owner/venues/:venueId/allowed-roles` | — | Roles the super admin enabled for this arena |
| `GET /owner/venues/:venueId/staff` | `staff.manage` | Team list with role names |
| `POST /owner/venues/:venueId/staff` | `staff.manage` | `{ email, name, password, roleId }` — `roleId` must be in the allowed list, `403` otherwise |
| `DELETE /owner/staff/:id` | `staff.manage` | Removes the venue link |

### Own roles

Owners can also create roles for their own team (`Role.ownerId`, name
unique per owner, gated by `staff.manage` and limited to the 10
arena-grantable keys — see [permissions.md](permissions.md)). A disabled
role grants zero permissions.

| Method & path | Perm | Notes |
|---|---|---|
| `GET /owner/roles` | `staff.manage` | Own roles (all venues) |
| `POST /owner/roles` | `staff.manage` | `{ name, permissions[] }` — keys must be arena-grantable |
| `PATCH /owner/roles/:id` | `staff.manage` | Incl. `isActive` |
| `DELETE /owner/roles/:id` | `staff.manage` | |

See [permissions.md](permissions.md) for the full governance flow.

## Billing

`GET /owner/billing` (perm `billing.view`) — the venue's plan, billing
status (none → trial → active → due → overdue), current period, and
payment history. Plan changes freeze the venue onto its old plan until
the period ends (`frozenPlanId`); approved venues with no `billingStartAt`
are deliberately not billed until an admin assigns/restarts billing.
Plan gates are enforced in the service layer: venue/court counts, price
windows, recurring blocks + split shifts, staff seats, and the customers
list all check the venue's plan features first. Staff without
`billing.view` see bookings and occupancy, but not money.

## Promos

Owner promos are venue-scoped (`PromoCode.venueId`, `createdById`); codes
stay globally unique (max 24 chars).

| Method & path | Perm | Notes |
|---|---|---|
| `GET /owner/promos` | `venues.manage` | Own promos (admin list shows Scope: platform vs venue) |
| `POST /owner/promos` | `venues.manage` | Create a venue promo |
| `PATCH /owner/promos/:id` | `venues.manage` | Edit (admin editing is activate/deactivate only) |
| `DELETE /owner/promos/:id` | `venues.manage` | |

## Customers

### `GET /owner/customers?venueId=` — perm `customers.read`
```json
[ { "userId": "...", "name": "Ahmed", "phone": "0300...", "email": "...",
    "visits": 14, "noShows": 1, "lastVisit": "2026-10-05" } ]
```
`OffsetPage` of computed rows, sorted by visits. A "visit" is a
past/current, non-cancelled booking whose slot has already started
(future bookings don't count before the player arrives). Non-cancelled
bookings count as visits. Gated by the venue's plan (`customers_insight`
feature).

## Review replies

`GET /owner/reviews?venueId=` (perm `reviews.reply`) and
`POST /owner/reviews/:id/reply { "reply" }` — replies keep an edit trail
(`ownerReplyHistory`); see [player-social.md](player-social.md).
