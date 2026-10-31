# Data models

Every table, field by field. Enums first, then models grouped by domain.
(Prisma schema: `prisma/schema.prisma`.)

## Enums

| Enum | Values |
|---|---|
| `RoleScope` | `platform`, `arena` |
| `UserStatus` | `pending` (owner awaiting approval), `active`, `suspended` |
| `VenueStatus` | `draft`, `pending`, `approved`, `rejected`, `suspended` |
| `BookingStatus` | `pending`, `confirmed`, `cancelled`, `completed`, `no_show` |

## Identity & access

**`roles`** — permission sets as data.
`id`, `name`, `scope` (`RoleScope`), `description`, `permissions` (text array of keys),
`isSystem`, `ownerId` (nullable — owner-created roles are scoped to one
owner), `isActive` (a disabled owner role grants zero permissions),
`createdAt`. Name is unique **per owner** (`@@unique([ownerId, name])`);
system role names are kept unique by the partial index
`Role_system_name_key` (`name` WHERE `ownerId` IS NULL) plus a
case-insensitive twin — Postgres treats NULLs as distinct in `@@unique`,
so the index is the real backstop.

**`users`**
`id`, `email` (unique), `name`, `phone`, `city`, `passwordHash` (staff only —
players are OTP-only, null), `roleId` → roles, `referralCode` (unique,
`AREANA-XXXXXX`), `noShowCount`, `status` (`UserStatus`), `createdAt`, `updatedAt`.

**`otp_codes`** — `id`, `email`, `codeHash` (bcrypt), `expiresAt` (10 min),
`attempts`, `consumedAt`, `createdAt`. Indexed on `email`.

**`device_tokens`** — `id`, `userId` → users, `token` (unique), `platform`,
`createdAt`.

**`refresh_sessions`** — `id`, `userId` → users (cascade), `tokenHash`,
`expiresAt`, `revokedAt` (nullable), `replacedById` (nullable — set only
when revoked by rotation, pointing at the successor session, so a
lost-response retry proves it is a retry, not theft), `createdAt`.
Indexed `(userId)`.

## Venues & courts

**`venues`**
`id`, `ownerId` → users, `name`, `address`, `city`, `phone` (nullable),
`lat`, `lng`, `sports` (text array), `amenities` (text array),
`images` (text array of URLs, legacy), `photos` (Json
`[{ url, blurhash, width?, height?, sport? }]` — kept in lockstep with
`images`; `sport` tags a photo to a sport for go-live readiness),
`rating` (avg), `ratingCount`, `autoAccept` (skip approval queue),
`minAdvanceMinutes` (default 120), `maxAdvanceDays` (default 14),
`archivedAt` (nullable — archived venues are hidden everywhere),
`planId` → plans (nullable — null = platform default plan),
`billingStartAt`, `billingPaidUntil`, `freeUntilOverride` /
`freeUntilOverridePrev` (stacked extend-free), `billingPaused` (overdue
venues vanish publicly like suspended ones), `billingDueNotifiedFor`,
`billingPeriodStart` / `billingPeriodEnd` / `billingPeriodPrice`,
`frozenPlanId` → plans (plan changes freeze the venue onto its old plan
until the period ends), `createdById` (nullable — admin-onboarded venues),
`courtLimitOverride` / `staffLimitOverride` (nullable — per-arena caps,
override wins),
`moderationStatus` (string: `none|paused|blocked|disabled`, default
`none`) + `moderationReason`, `rejectionReason`, `moderatedAt`,
`moderatedById`, `status` (`VenueStatus`), `createdAt`, `updatedAt`.
Indexed: `(status)`, `(city, status)`.

**`venue_allowed_roles`** — which staff roles an arena's owner may hand out.
Composite PK `(venueId, roleId)`.

**`venue_staff`** — staff assignments. `id`, `venueId`, `userId`,
unique `(venueId, userId)`.

**`courts`**
`id`, `venueId` → venues, `name` ("Turf A"), `sport` ("Football"),
`size` ("7v7", nullable), `surface` (nullable), `indoor` (bool),
`pricePerHour` (decimal), `openMinutes` / `closeMinutes` (default 360/1380),
`slotMinutes` (default 60), `weeklyHoursVersion` (optimistic concurrency
for weekly-hours saves — stale version → `409`), `isActive`,
`status` (string: `approved|pending|rejected`, default `approved` for
onboard courts — owner-created courts start `pending`),
`rejectionReason` (nullable), `photos` (Json `[{ url, blurhash }]` only),
`createdAt`, `updatedAt`.

**`court_weekly_windows`** — per-weekday availability template.
`id`, `courtId`, `weekday` (0 = Sunday … 6 = Saturday), `startMinutes`,
`endMinutes` (split shifts = multiple rows per weekday; a court with a
template is closed on weekdays with no row).

**`recurring_blocks`** — recurring unavailability.
`id`, `courtId`, `weekdays` (int array), `startMinutes`, `endMinutes`,
`reason` (nullable), `startsOn` / `endsOn` (DATE, nullable).

**`court_price_windows`** — special rates.
`id`, `courtId`, `weekdays` (int array), `startMinutes`, `endMinutes`,
`pricePerHour`, `startsOn` / `endsOn` (nullable). No-overlap per weekday;
a slot is priced by the window covering its start, else base.

**`slot_blocks`** — owner-carved unavailable ranges.
`id`, `courtId`, `date` (DATE), `startMinutes`, `endMinutes`, `reason`,
`createdAt`. Indexed `(courtId, date)`.

## Bookings

**`bookings`**
`id`, `userId` → users (nullable — walk-ins), `guestName` (walk-ins),
`venueId`, `courtId`, `date` (DATE), `startMinutes`, `endMinutes`,
`totalPrice` (decimal, after discount), `discountAmount` (decimal),
`promoCodeId` → promo_codes (nullable), `status` (`BookingStatus`),
`shareCode` (unique, nullable — group join links), `checkInCode` (unique — QR),
`checkedInAt` (nullable), `reminderSent` (bool), `recurrenceId` (nullable —
series grouping), `createdAt`, `updatedAt`.
Constraints: `@@unique(courtId, date, startMinutes)` — the double-booking guard.
Indexed: `(userId, date)`, `(courtId, date)`, `(recurrenceId)`, `(status, date)`.

**`booking_participants`** — group join-ins. `id`, `bookingId`, `userId`
(nullable — guest joiners), `name`, `phone` (nullable), `joinedAt`.
Partial unique `(bookingId, phone)` WHERE `phone` IS NOT NULL.

**`reschedule_requests`** — `id`, `bookingId`, `requestedDate` (DATE),
`requestedStartMinutes`, `requestedEndMinutes`, `status`
(`pending|approved|rejected`), `reason` (nullable), `createdAt`, `decidedAt`.
Partial unique `(bookingId)` WHERE `status = 'pending'` — one pending
request per booking.

**`slot_waitlists`** — waitlist entries. `id`, `courtId`, `date`,
`startMinutes`, `slotMinutes`, player, `createdAt`. Joining too soon
(before the slot is bookable) is refused, not queued.

## Player social

**`favorites`** — composite PK `(userId, venueId)`, `createdAt`.

**`reviews`** — `id`, `venueId`, `userId`, `bookingId` (unique — one per booking),
`rating` (1–5), `comment` (nullable), `ownerReply` (nullable),
`ownerReplyHistory` (reply edit trail), `repliedAt`
(nullable), `createdAt`. Court reviews filter through `booking.courtId` —
reviews carry no court column.

**`game_posts`** — `id`, `creatorId` → users, `venueId` → venues (nullable),
`sport`, `city`, `date` (DATE), `startMinutes`, `playersNeeded`, `note`
(nullable), `status` (`open|full|closed`), `isCurated` (bool),
`curatedById` → users (nullable), `createdAt`. Indexed `(city, date, status)`.

**`game_participants`** — `id`, `postId`, `userId` (nullable), `name`, `phone`
(nullable), `joinedAt`.

**`promo_codes`** — `id`, `code` (unique, max 24 chars), `kind` (`percent|flat`), `value`
(decimal), `maxDiscount` (decimal, nullable — `0` is rejected),
`maxUses` (nullable), `usedCount`,
`perUserLimit`, `validFrom`, `validTo`, `isActive`, `venueId` (nullable —
owner promos are venue-scoped; null = platform-wide), `createdById`
(nullable — the owner/admin who created it), `createdAt`.

**`promo_redemptions`** — `id`, `promoCodeId`, `userId`, `bookingId` (nullable),
`createdAt`. Indexed `(promoCodeId, userId)` for per-user limits.

**`referrals`** — `id`, `referrerId` → users, `refereeId` → users (unique),
`status` (`pending|rewarded`), `createdAt`.

## Platform

**`badges`** — `id`, `name`, `tier` (int, ordering), `criteriaDescription`,
`iconUrl` (nullable), `createdAt`.

**`venue_badges`** — composite PK `(venueId, badgeId)`, `grantedAt`,
`grantedById` → users (nullable — null = auto-granted by scheduler).

**`disputes`** — `id`, `bookingId`, `raisedById` → users, `reason`,
`status` (`open|resolved|dismissed`), `resolution` (nullable),
`resolvedById` → users (nullable), `createdAt`, `resolvedAt` (nullable).
One dispute per booking ever after a terminal resolution.

**`venue_reports`** — player reports on an arena. `id`, `venueId`,
`playerId`, `reason` (`fake_listing|wrong_info|closed|misconduct|unsafe|other`),
`status` (`open|reviewed|actioned|dismissed`), `createdAt`, `resolvedAt`.
One open report per player per arena (`409` otherwise); reports are
anonymous to the owner. An `actioned` `fake_listing`/`unsafe` report
auto-pauses the venue.

**`banners`** — `id`, `title`, `imageUrl`, `linkUrl` (nullable), `city`
(nullable — null = all cities), `isActive`, `startsAt`, `endsAt` (nullable),
`createdAt`.

**`broadcasts`** — admin push history. `id`, `title`, `body`, `city`
(nullable), `targeted` (device-token count at send), `delivered` /
`failed` (delivery counts, chunked sends at 500), `countsReliable`
(whether the counts can be trusted), `createdAt`. Recorded at send, not
at read.

**`plans`** — yearly venue subscriptions (the launch model, not
commission). `id`, `name`, `priceYearly`, `freeMonths`, `features`
(text array), `maxVenues` / `maxCourts` / `maxStaff` (null = unlimited),
`isDefault`, `isCustom`, `createdAt`. Seed: Basic Rs 18,000/yr (1 venue,
2 courts, no staff), Normal Rs 36,000/yr DEFAULT (3 venues, 3 staff,
peak pricing, advanced availability, staff accounts, customer insights),
Premium Rs 60,000/yr (unlimited + featured placement). Re-seeding never
overwrites admin edits.

**`venue_payments`** — the subscription ledger. One row per period:
`venueId`, `planId`, period start/end, `amount` (= the period's plan
price; mark-paid rejects any other amount), `method` (`paid|void|…`),
`note` (void rows require one — partial unique `note` WHERE
`method = 'void'`), `createdAt`. Due at a venue = `totalPrice` (already
net). Zero-price periods auto-settle. Billing freezes at the first
unpaid period — no auto-resume.

**`venue_events`** — discovery traffic. `id`, `venueId`, `courtId`
(nullable — `court_view`), `userId` (nullable — guests carry a
`visitorId`), `type` (`view|click|court_view`), `day` (DATE, the PKT
day), `createdAt`. Deduped 1/identity/venue/day; the venue's owner is
excluded.

**`notifications`** — player inbox rows backing `pushToUser` (inbox +
FCM + email fan-out, never throws).

**`idempotency_keys`** — `id`, `scope` (method + path + actor +
SHA-256(body)), `actorId`, `key`, `response`, `createdAt`. 24h replay,
only while the post-condition still holds, else re-executed. Covers 7
destructive admin mutations (incl. extend-free).

**`audit_logs`** — `id`, `actorId` → users (nullable — `ON DELETE SET
NULL`, so deleting a user keeps the trail), `action` (`venue.approve`,
`user.suspend`, …), `entity`, `entityId`, `createdAt`. Indexed `(entity, entityId)`.

**`settings`** — `key` (PK: `commissionPct`, `pendingExpiryHours`,
`noShowStrikeLimit`, `referralWelcomePct`, `referralRewardPct`,
`graceDays`), `value`
(string), `updatedAt`. Parsed validate-or-fallback (strike limit 3/min 1,
pending expiry 2h, grace 14d) — a garbage value never becomes `NaN`.

**`venue_suggestions`** — `id`, `suggestedById` → users (nullable), `name`,
`city`, `phone` (nullable), `note` (nullable), `status`
(`new|contacted|converted|dismissed`), `createdAt`.

## Relationship map

```
roles 1───* users
users 1───* venues (as owner) · bookings · reviews · favorites · game_posts
venues 1───* courts 1───* bookings
venues *───* roles (venue_allowed_roles) · users (venue_staff)
venues 1───* bookings · reviews · favorites · game_posts
bookings 1───* booking_participants · reschedule_requests · disputes
bookings 1───* reviews (one, unique) · promo_redemptions
promo_codes 1───* promo_redemptions · bookings
users 1───* referrals (as referrer & referee) · disputes · audit_logs
venues *───* badges (venue_badges)
venues 1───* plans (planId, frozenPlanId) · venue_payments · venue_events · venue_reports
courts 1───* weekly_windows · recurring_blocks · price_windows · slot_blocks · waitlists
users 1───* refresh_sessions · device_tokens · notifications
```
