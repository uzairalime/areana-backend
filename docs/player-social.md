# Player social — favorites, reviews, game board, promos, disputes

Everything that makes Areana social and retentive beyond the booking itself.

## Favorites

### `GET /favorites` · `POST /favorites` · `DELETE /favorites/:venueId` — perm `favorites.manage`
```json
// POST /favorites
{ "venueId": "cm3x..." }
// GET /favorites → [{ venueId, venue: { id, name, city, rating, images } }]
```
Add is idempotent (upsert). Powers the app's "Saved" tab.

## Reviews

### `POST /reviews` — perm `reviews.write`
One review per completed booking — enforced by a unique constraint on `bookingId`.
```json
// request
{ "bookingId": "cm4y...", "rating": 5, "comment": "Great turf, clean washrooms" }
// rules: booking must be yours, status = completed, no existing review
// response 201 → review; venue rating/count recomputed in the same transaction
```
`rating` 1–5. After creation the venue's `rating` (average) and `ratingCount`
are recomputed atomically.

### `GET /venues/:id/reviews` — public
Newest first, with reviewer name and any `ownerReply`.

### Owner replies — `POST /owner/reviews/:id/reply` (perm `reviews.reply`)
```json
{ "reply": "Thanks for playing with us!" }
```
Sets `ownerReply` + `repliedAt`. Super admin can delete any review
(`DELETE /admin/reviews/:id`, rating recomputed).

## Find players / opponents board

### `GET /game-posts?sport=&city=&date=` — public
Open games only, upcoming first, **curated games first**. Includes participant
count. This is the retention engine (Playo-style): *"you can't play sports alone"*.

### `POST /game-posts` — perm `games.manage`
```json
{ "sport": "Football", "city": "Lahore", "venueId": "cm3x...",
  "date": "2026-10-10", "startMinutes": 1080,
  "playersNeeded": 10, "note": "Need a keeper!" }
// venueId optional — street games welcome
```

### `POST /game-posts/:id/join` — perm `games.manage`
```json
{ "name": "Bilal", "phone": "0300..." }   // optional — defaults to your profile
```
Rejects full/closed/past games and double-joins (`409`). Flips the post to
`full` when `playersNeeded` is reached; the creator gets a push notification.
`POST /game-posts/:id/leave` reopens it. `DELETE /game-posts/:id` — creator only.

### Curated games (super admin)
`PATCH /admin/game-posts/:id/curate` marks a post as platform-curated
(`isCurated`, `curatedById`) — the super admin's tool for filling off-peak
hours with guaranteed games.

## Promos & referrals

### Promo codes
`code` (unique, uppercase), `kind` = `percent` | `flat`, `value`,
`maxDiscount` (percent cap), `maxUses`, `perUserLimit`, `validFrom/validTo`,
`isActive`. Applied at booking checkout (`POST /bookings` → `promoCode`);
`GET /bookings/validate-promo` previews the discount. Usage is recorded in
`promo_redemptions` and `usedCount` increments **inside the booking transaction**.

Admin: `GET/POST /admin/promos`, `PATCH /admin/promos/:id` (toggle active).
Code auto-generated (`PROMO-XXXXXX`) if not supplied.

### Referrals — the loop
1. Every player has a `referralCode` (`AREANA-XXXXXX`).
2. Friend signs up with it (`POST /auth/verify-otp` → `referralCode`) →
   `referrals` row (`pending`) + friend gets a 15%-off `WELCOME-XXXXXX` promo
   (single-use, 30 days).
3. Nightly scheduler: friend's first **completed** booking → referral `rewarded`
   + referrer gets a 10%-off `REWARD-XXXXXX` promo.

### `GET /referrals/me` — perm `referrals.read`
`{ referralCode, referredCount, rewards }` — powers the app's "Invite friends" screen.

## Disputes

### `POST /disputes` — perm `bookings.read`
```json
{ "bookingId": "cm4y...", "reason": "Charged for a slot the arena cancelled" }
// one open dispute per booking; booking must be yours
```
### `GET /disputes/me` — your dispute history.
Super admin resolves: `POST /admin/disputes/:id/resolve`
`{ action: "confirm_no_show" | "dismiss" | "credit", resolution }` —
`confirm_no_show` flips the booking and strikes the player in one transaction.

## Suggest a turf

### `POST /venue-suggestions` — authenticated (no special perm)
```json
{ "name": "Green Field", "city": "Lahore", "phone": "0300...", "note": "Near DHA" }
```
Feeds the super-admin lead queue (`new → contacted → converted/dismissed`)
at `GET /admin/suggestions`.
