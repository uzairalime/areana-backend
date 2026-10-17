# Peak / off-peak pricing — design plan

Status: **planned (Phase 2), not built yet.** Added Oct 18, 2026.
This is a design document — there is no peak pricing UI or API in the
app today. Today's pricing is one flat `pricePerHour` per court.

## Goal

Let owners charge more for high-demand hours (evenings, weekends) and
less off-peak, instead of one flat rate per court.

## Model (mirrors the availability manager's shape)

- New table `CourtPriceWindow`:
  - `courtId`
  - `weekdays` — int array, same convention as `RecurringBlock` (0 = Sun … 6 = Sat)
  - `startMinutes`, `endMinutes` — same minutes domain as everything else,
    including the overnight extension (may pass 1440)
  - `pricePerHour` — absolute Rs amount (simpler for owners than multipliers)
  - optional `startsOn` / `endsOn` — seasonal rates (e.g. summer evenings)
- Resolution order for a slot's price: a price window covering the slot
  wins; otherwise the court's base `pricePerHour`.
- At most one price window may cover a given slot — creation validates
  overlap per weekday.

## Engine changes

- The availability service already returns a per-slot `price`; it would
  resolve each slot's price from the covering window.
- Booking creation prices each slot the same way, server-side (never
  trust client totals). A multi-slot booking that spans the peak boundary
  prices each hour at its own rate and sums them.
- The final price is snapshotted onto the booking, exactly as today —
  changing rates later never alters existing bookings.

## Owner UI (planned)

- A "Peak pricing" section inside **Courts → Timings & availability**,
  next to weekly timings and recurring breaks:
  list of price windows (days, time range, Rs/hr) with add/remove.
- Same conflict-protection pattern as the availability manager: saving
  is safe by construction because existing bookings keep their price.

## Player UI (planned)

- Slot chips already show per-slot prices; peak slots get a subtle
  "Peak" tag so a higher price never surprises at checkout.
- Venue cards show "from Rs X/hr" using the day's minimum slot price.

## Edge cases

- Existing bookings keep their booked price (snapshot on `Booking`).
- Promo codes and referrals apply on the summed total, as today.
- Walk-in bookings price identically (same engine path).
- Overnight windows: price windows use the same extended-minutes domain
  and may cross midnight together with the court's overnight window.
- Reporting: owner dashboard revenue already sums booking totals, so
  peak uplift appears with no reporting changes; admin analytics can
  later split peak vs off-peak revenue.
