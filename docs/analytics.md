# Analytics

Layered from platform KPIs down to single-user drill-downs. All under
`/admin/analytics/*` (super admin only). Money = `confirmed` + `completed`
bookings; GMV in PKR.

## 1. Platform KPIs — `GET /admin/analytics/overview`

```json
{
  "players": 1240, "owners": 9,
  "venuesByStatus": { "approved": 8, "pending": 2 },
  "bookingsByStatus": {
    "confirmed": { "count": 312, "revenue": 780000 },
    "pending": { "count": 17, "revenue": 42500 }
  },
  "gmv": 1935000,
  "accruedCommission": 193500,
  "pendingApprovals": { "bookings": 17, "owners": 1, "venues": 2 },
  "openDisputes": 3
}
```
`accruedCommission` = GMV × `commissionPct` setting. This is the panel's
top strip.

## 2. Trends — `GET /admin/analytics/trends?days=30&granularity=day|week|month`

```json
[ { "period": "2026-10-01", "bookings": 42, "gmv": 105000 },
  { "period": "2026-10-02", "bookings": 51, "gmv": 127500 } ]
```
Daily groups from the DB, bucketed into weeks/months in code. Powers the
booking-count and GMV graphs.

## 3. Breakdowns — `GET /admin/analytics/breakdown`

```json
{
  "cities": [ { "city": "Lahore", "venues": 8, "bookings": 1240, "gmv": 1935000 } ],
  "sports": [ { "sport": "Football", "courts": 14 } ],
  "venueStatus": { "approved": 8, "pending": 2 }
}
```

## 4. Arena leaderboard — `GET /admin/analytics/venues`

One row per approved arena, sorted by revenue:
```json
[ {
  "venueId": "...", "name": "Champions Turf", "city": "Lahore",
  "rating": 4.7, "ratingCount": 132, "topBadge": "Top Arena",
  "bookings": 412, "revenue": 1030000, "occupancyPct": 64,
  "uniquePlayers": 280, "newPlayers30d": 96, "returningPlayers": 184,
  "noShows": 7
} ]
```
- `occupancyPct` = booked slot-minutes ÷ available court-minutes across active days.
- New vs returning: a player's first booking date at that venue vs the last 30 days.

## 5. Drill-downs

**`GET /admin/analytics/venues/:id`** — venue + owner, courts, badges, staff;
KPIs (bookings, revenue, unique customers, reviews, no-shows); last 200
bookings; last 50 reviews.

**`GET /admin/analytics/owners/:id`** — owner profile, per-venue
`{ bookings, revenue }`, and totals across their arenas.

**`GET /admin/analytics/users/:id`** — user profile and KPIs:
`{ bookings, completed, noShows, cancelled, referralsMade, promoRedemptions, disputes }`
plus last 100 bookings. The support view for "why was this user suspended?".

## Notes for the panel

- All endpoints are read-only aggregates; nothing here mutates data.
- The leaderboard and trends are computed live — fine for 10 venues; add
  caching (or materialized rollups) when venue count grows.
- Commission is *accrued* (computed), not settled — the settlement ledger is
  phase 2.
