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
| `POST /owner/venues/:id/submit` | `venues.manage` | `draft → pending`; needs ≥1 active court |
| `POST /owner/venues/:id/images` | `venues.manage` | `multipart/form-data`, field `image` (JPEG/PNG/WebP ≤5 MB) → URL appended to `images` |
| `DELETE /owner/venues/:id/images` | `venues.manage` | `{ "url": "..." }` removes from venue and storage |

New venues go `draft → pending → approved` (super admin). Approved venues are
live in the app; edits don't unpublish them.

## Courts

| Method & path | Perm | Notes |
|---|---|---|
| `GET /owner/venues/:venueId/courts` | `courts.manage` | All courts incl. inactive |
| `POST /owner/venues/:venueId/courts` | `courts.manage` | `{ name, sport, size?, surface?, indoor?, pricePerHour, openMinutes?, closeMinutes?, slotMinutes? }` |
| `PATCH /owner/courts/:id` | `courts.manage` | Any field incl. `isActive` (soft-off a court) |

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
| `GET /owner/bookings?venueId=&date=&status=` | `bookings.manage` or `bookings.review` | Up to 200, newest first, with court/user/participant count |
| `PATCH /owner/bookings/:id/accept` | `bookings.review` | `pending → confirmed`; player gets a push |
| `PATCH /owner/bookings/:id/reject` | `bookings.review` | `{ "reason" }` → `cancelled`; player gets a push with the reason |
| `POST /owner/bookings/recurring/:recurrenceId/accept` | `bookings.review` | `{ "venueId" }` — batch-accepts a series; conflicts re-checked, `{ accepted[], skipped[] }` |
| `PATCH /owner/bookings/:id/cancel` | `bookings.manage` | Cancel an upcoming booking |
| `PATCH /owner/bookings/:id/check-in` | `bookings.manage` | Sets `checkedInAt` |
| `PATCH /owner/bookings/:id/no-show` | `bookings.manage` | → `no_show` + player strike (auto-suspend at limit) |
| `POST /owner/bookings/walk-in` | `booking.manage` | `{ courtId, date, startMinutes, slotCount?, guestName }` — confirmed + checked in immediately, skips the advance-notice window |
| `POST /owner/bookings/check-in-scan` | `bookings.manage` | `{ "code": "X8T2QW9M4P", "venueId": "..." }` — validates a QR, returns the booking for confirmation |

## Reschedule queue

| Method & path | Perm | Notes |
|---|---|---|
| `GET /owner/reschedules?status=pending` | `bookings.manage` or `bookings.review` | With booking, court, and player details |
| `PATCH /owner/reschedules/:id/accept` | `bookings.review` | Conflict re-checked; booking moved + confirmed atomically |
| `PATCH /owner/reschedules/:id/reject` | `bookings.review` | `{ "reason" }`; original booking untouched |

## Team (staff)

| Method & path | Perm | Notes |
|---|---|---|
| `GET /owner/venues/:venueId/allowed-roles` | — | Roles the super admin enabled for this arena |
| `GET /owner/venues/:venueId/staff` | `staff.manage` | Team list with role names |
| `POST /owner/venues/:venueId/staff` | `staff.manage` | `{ email, name, password, roleId }` — `roleId` must be in the allowed list, `403` otherwise |
| `DELETE /owner/staff/:id` | `staff.manage` | Removes the venue link |

See [permissions.md](permissions.md) for the full governance flow.

## Customers

### `GET /owner/customers?venueId=` — perm `customers.read`
```json
[ { "userId": "...", "name": "Ahmed", "phone": "0300...", "email": "...",
    "visits": 14, "noShows": 1, "lastVisit": "2026-10-05" } ]
```
Sorted by visits. Non-cancelled bookings count as visits.

## Review replies

`GET /owner/reviews?venueId=` (perm `reviews.reply`) and
`POST /owner/reviews/:id/reply { "reply" }` — see [player-social.md](player-social.md).
