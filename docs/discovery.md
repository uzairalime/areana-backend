# Discovery — venues, courts, availability, search

Everything a player sees before booking. All read endpoints here are **public**.

## Venues

### `GET /venues` — public
Only venues passing the **visibility filter**: `approved`, not archived,
not `billingPaused`, `moderationStatus: 'none'`, owner `active`, with ≥ 1
active + approved court, and not live-overdue. Filters: `q` (name/address),
`city`, `sport`, `surface` (matches an active court), `sort` (`rating`
default | `price_asc` | `price_desc` | `name` | `distance`), `lat` + `lng`
(must be sent together). Listings are an `OffsetPage`
(`{ items, total, page, limit, totalPages, hasMore }`), and when `lat`+`lng`
are sent every row also carries `distanceKm` (1-decimal, null without
coordinates). `sort=distance` is pure nearest-first — featured venues do
NOT float first under it, and venues without coordinates sort last
(distance sort pages in memory, 500-row cap). A lone `lat` or `lng` is a
400.
```json
// GET /venues?city=Lahore&sport=Football&page=1&limit=20
{
  "total": 8, "page": 1, "limit": 20, "totalPages": 1, "hasMore": false,
  "items": [
    {
      "id": "cm3x...", "name": "Champions Turf", "address": "DHA Phase 5",
      "city": "Lahore", "lat": 31.46, "lng": 74.39,
      "sports": ["Football", "Cricket"], "amenities": ["Floodlights"],
      "images": ["/uploads/venues/cm3x/abc123.jpg"],
      "rating": 4.7, "ratingCount": 132,
      "badges": [{ "badge": { "name": "Top Arena", "tier": 2 } }],
      "_count": { "courts": 3 }
    }
  ]
}
```

### `GET /venues/:id` — public
Full detail: venue + its active + approved courts (cheapest first) +
badges. `404` unless the venue passes the visibility filter above.

## Courts

### `GET /venues/:venueId/courts` — public
Active + approved courts of a visible venue: `id, name, sport, size
("7v7"), surface, indoor, pricePerHour, openMinutes, closeMinutes,
slotMinutes`.

### `GET /courts` — public
Courts as a first-class listing (the player app's Courts tab). Filters:
`q`, `city`, `sport`, `surface`, `sort` (`price_asc` default |
`price_desc` | `distance` | `name` — courts have no rating, so there is
no `rating` sort), `lat` + `lng`. `OffsetPage`; distance behaves exactly
like the venues list. Owner courts start `pending` and are invisible /
unbookable until an admin approves them (rejected courts re-queue on
edit), so only approved courts ever appear here.

## Availability engine

### `GET /courts/:courtId/availability?date=YYYY-MM-DD` — public
The server-side source of truth. Slots are **computed per request**, never stored.

```json
// GET /courts/cm3x/availability?date=2026-10-08
{
  "courtId": "cm3x...", "venueId": "cm3y...", "date": "2026-10-08",
  "currency": "PKR", "slotMinutes": 60,
  "slots": [
    { "startMinutes": 360, "endMinutes": 420, "available": false, "price": 2500, "reason": "booked" },
    { "startMinutes": 1080, "endMinutes": 1140, "available": true, "price": 2500, "peak": true }
  ]
}
```
A slot is `available: false` when it overlaps a `pending`/`confirmed` booking
or an owner slot block, is in the past, is sooner than the venue's
`minAdvanceMinutes`, or the date is beyond `maxAdvanceDays`. `reason` is
one of `booked|past|too_late|not_open_yet|blocked|available`; `peak` marks
a price-window rate above base, `deal` a rate below base.

**Model note.** Courts carry `openMinutes`/`closeMinutes` (default 6 AM–11 PM),
`slotMinutes` (default 60), and `pricePerHour` — but those are the fallback.
The availability manager feeds the engine: per-weekday windows
(`CourtWeeklyWindow`, split shifts; a court with a template is closed on
weekdays with no row), recurring blocks (`RecurringBlock`), full-day
closures, and price windows (`CourtPriceWindow` — a slot is priced by the
window covering its start, else base; overnight courts supported, max
20h/day). `slot_blocks` carve out maintenance/private time. Slots are
computed per request, never stored; prices snapshot onto the booking.

## Slot search

### `GET /search/slots?date=...&sport=&city=&size=&indoor=` — public
Availability-first discovery: *"football tonight near DHA"*.
```json
// GET /search/slots?date=2026-10-08&sport=Football&city=Lahore
{
  "date": "2026-10-08",
  "results": [
    {
      "venue": { "id": "...", "name": "Champions Turf", "address": "...",
                 "city": "Lahore", "rating": 4.7, "images": [...] },
      "courts": [
        { "id": "...", "name": "Turf A", "sport": "Football", "size": "7v7",
          "surface": "artificial_grass", "indoor": false, "pricePerHour": 2500,
          "availableSlots": [{ "startMinutes": 1080, "endMinutes": 1140,
                                "available": true, "price": 2500 }] }
      ]
    }
  ]
}
```
Only courts with ≥1 free slot are returned (max 50 venues scanned), sorted by
most availability first. Courts that fail validation are skipped, not
fatal. Known gap: slot search has no live-overdue guard, so one
live-overdue venue fails the entire request instead of being dropped.

## Banners & deep links

### `GET /banners?city=` — public
Active, scheduled banners for the app home carousel (super-admin managed).

### `GET /v/:id` and `GET /join/:code` — public
Shareable landing pages returning small HTML with an app-link intent
(`areana://v/:id`, `areana://join/:code`) plus a web fallback. Owners paste
these in Instagram bios; players share `/join/:code` links from a booking.
