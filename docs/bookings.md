# Bookings

The heart of Areana. Player bookings start as `pending` (holding the slot),
the arena accepts or rejects, and unanswered requests auto-expire.

## Lifecycle

```
pending → confirmed → completed
   ↓          ↓
cancelled   no_show
```
- `pending` — waiting on the arena; holds the slot; auto-expires after
  `pendingExpiryHours` (setting, default 2) via the scheduler.
- `confirmed` — accepted by the arena (or auto-accepted, or walk-in).
- `completed` — nightly job flips past `confirmed` bookings; unlocks reviews.
- `cancelled` — by player, arena, expiry, or super admin.
- `no_show` — arena marked the player absent; adds a strike (see below).

## Create a booking

### `POST /bookings` — perm `bookings.create`
```json
// request
{ "courtId": "cm3x...", "date": "2026-10-08", "startMinutes": 1080,
  "slotCount": 2, "promoCode": "WELCOME-AB12CD" }   // slotCount/promoCode optional

// response 201
{
  "id": "cm4y...", "venueId": "cm3y...", "courtId": "cm3x...",
  "date": "2026-10-08T00:00:00.000Z", "startMinutes": 1080, "endMinutes": 1200,
  "totalPrice": 4250, "discountAmount": 750, "status": "pending",
  "shareCode": "K7P2M9QZ", "checkInCode": "X8T2QW9M4P", "recurrenceId": null
}
```
Validation layers, in order:
1. Court active, venue approved.
2. `startMinutes` aligned to the court's grid, `endMinutes ≤ closeMinutes`.
3. Venue booking window: not sooner than `minAdvanceMinutes`, not later than `maxAdvanceDays`; not in the past.
4. **Overlap check across the full range** (`slotCount` slots) against
   `pending`/`confirmed` bookings and slot blocks.
5. Promo validated (active, in window, usage limits) → discount applied.
6. `@@unique(courtId, date, startMinutes)` as the final backstop under races.

On success the arena owner gets an email; the player gets a push on accept/reject.
`totalPrice` = `pricePerHour × hours − discount`. `checkInCode` is the QR the
app displays; `shareCode` powers group join links.

Errors: `400` misaligned/outside hours/window, `409` overlap ("Slot overlaps an
existing booking") or fully-used promo, `404` court not found.

### `GET /bookings/validate-promo?code=&courtId=&slotCount=` — perm `bookings.create`
Preview a promo before booking: `{ promo, discount }`. Same rules as checkout.

## Recurring bookings

### `POST /bookings/recurring` — perm `bookings.create`
```json
// request — every Saturday 6 PM, 8 occurrences
{ "courtId": "cm3x...", "dayOfWeek": 6, "startMinutes": 1080,
  "slotCount": 1, "occurrences": 8 }
// response 201
{ "recurrenceId": "rec_...",
  "created": [ {booking}, ... ],
  "skipped": [ { "date": "2026-11-07", "reason": "Slot overlaps an existing booking" } ] }
```
Each occurrence is its own `pending` booking sharing a `recurrenceId`. The
arena approves the whole series in one action
(`POST /owner/bookings/recurring/:recurrenceId/accept`); conflicts are
re-checked at accept time and reported per booking.

### `PATCH /bookings/recurring/:recurrenceId/cancel` — perm `bookings.read`
Cancels all future `pending`/`confirmed` bookings in the series. `{ cancelled: n }`.

## My bookings

### `GET /bookings/me?filter=upcoming|past` — perm `bookings.read`
Upcoming = future `pending`/`confirmed`; past = everything else. Includes court,
venue, and participant count.

### `PATCH /bookings/:id/cancel` — perm `bookings.read`
Player cancels an own upcoming booking (not one that already started).

## Reschedule requests

### `POST /bookings/:id/reschedule` — perm `bookings.read`
```json
// request — same duration as the original, new start
{ "date": "2026-10-10", "startMinutes": 1140 }
```
Creates a `pending` row in `reschedule_requests`. **The original booking stays
`confirmed`** until the arena decides (`PATCH /owner/reschedules/:id/accept|reject`);
acceptance re-checks conflicts atomically. One pending request per booking.

## Group bookings

### `POST /bookings/:id/share` — perm `bookings.read`
`{ "shareCode": "K7P2M9QZ", "joinUrl": "/join/K7P2M9QZ" }` — idempotent.

### `GET /bookings/shared/:shareCode` — public
What a friend sees: court, venue, date/time, price, participant list
(no check-in code).

### `POST /bookings/shared/:shareCode/join` — public
`{ "name": "Bilal", "phone": "0300..." }` → adds a `booking_participants` row.

## No-show strikes

When the arena marks `no_show` (`PATCH /owner/bookings/:id/no-show`), the
player's `noShowCount` increments. At the `noShowStrikeLimit` setting (default
3) the account is auto-`suspended`. Super admin can reset via
`POST /admin/users/:id/reset-strikes`.

## Models involved

`bookings` (the row: court+date+start/end, price, discount, status, share/check-in
codes, recurrence), `booking_participants`, `reschedule_requests`, `slot_blocks`,
`promo_codes` + `promo_redemptions`. Full field reference: [models.md](models.md).
