# Discovery — venues, courts, availability, search

Everything a player sees before booking. All read endpoints here are **public**.

## Venues

### `GET /venues` — public
Only `approved` venues. Filters: `q` (name/address), `city`, `sport`.
```json
// GET /venues?city=Lahore&sport=Football&page=1&limit=20
{
  "total": 8, "page": 1, "limit": 20,
  "data": [
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
Full detail: venue + its active courts (cheapest first) + badges.
`404` if the venue isn't approved.

## Courts

### `GET /venues/:venueId/courts` — public
Active courts of an approved venue: `id, name, sport, size ("7v7"),
surface, indoor, pricePerHour, openMinutes, closeMinutes, slotMinutes`.

## Availability engine

### `GET /courts/:courtId/availability?date=YYYY-MM-DD` — public
The server-side source of truth. Slots are **computed per request**, never stored.

```json
// GET /courts/cm3x/availability?date=2026-10-08
{
  "courtId": "cm3x...", "venueId": "cm3y...", "date": "2026-10-08",
  "currency": "PKR", "slotMinutes": 60,
  "slots": [
    { "startMinutes": 360, "endMinutes": 420, "available": false, "price": 2500 },
    { "startMinutes": 1080, "endMinutes": 1140, "available": true, "price": 2500 }
  ]
}
```
A slot is `available: false` when it overlaps a `pending`/`confirmed` booking
or an owner slot block, is in the past, is sooner than the venue's
`minAdvanceMinutes`, or the date is beyond `maxAdvanceDays`.

**Model note.** Courts carry `openMinutes`/`closeMinutes` (default 6 AM–11 PM),
`slotMinutes` (default 60), and `pricePerHour`. `slot_blocks` carve out
maintenance/private time. Nothing else is needed — no stored slot rows.

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
most availability first.

## Banners & deep links

### `GET /banners?city=` — public
Active, scheduled banners for the app home carousel (super-admin managed).

### `GET /v/:id` and `GET /join/:code` — public
Shareable landing pages returning small HTML with an app-link intent
(`areana://v/:id`, `areana://join/:code`) plus a web fallback. Owners paste
these in Instagram bios; players share `/join/:code` links from a booking.
