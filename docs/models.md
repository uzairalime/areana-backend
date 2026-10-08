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
`id`, `name` (unique: `super_admin`, `owner`, `staff`, `player`, …),
`scope` (`RoleScope`), `description`, `permissions` (text array of keys),
`isSystem`, `createdAt`.

**`users`**
`id`, `email` (unique), `name`, `phone`, `city`, `passwordHash` (staff only —
players are OTP-only, null), `roleId` → roles, `referralCode` (unique,
`AREANA-XXXXXX`), `noShowCount`, `status` (`UserStatus`), `createdAt`, `updatedAt`.

**`otp_codes`** — `id`, `email`, `codeHash` (bcrypt), `expiresAt` (10 min),
`attempts`, `consumedAt`, `createdAt`. Indexed on `email`.

**`device_tokens`** — `id`, `userId` → users, `token` (unique), `platform`,
`createdAt`.

## Venues & courts

**`venues`**
`id`, `ownerId` → users, `name`, `address`, `city`, `lat`, `lng`,
`sports` (text array), `amenities` (text array), `images` (text array of URLs),
`rating` (avg), `ratingCount`, `autoAccept` (skip approval queue),
`minAdvanceMinutes` (default 120), `maxAdvanceDays` (default 14),
`status` (`VenueStatus`), `createdAt`, `updatedAt`.
Indexed: `(status)`, `(city, status)`.

**`venue_allowed_roles`** — which staff roles an arena's owner may hand out.
Composite PK `(venueId, roleId)`.

**`venue_staff`** — staff assignments. `id`, `venueId`, `userId`,
unique `(venueId, userId)`.

**`courts`**
`id`, `venueId` → venues, `name` ("Turf A"), `sport` ("Football"),
`size` ("7v7", nullable), `surface` (nullable), `indoor` (bool),
`pricePerHour` (decimal), `openMinutes` / `closeMinutes` (default 360/1380),
`slotMinutes` (default 60), `isActive`, `createdAt`, `updatedAt`.

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

**`booking_participants`** — group join-ins. `id`, `bookingId`, `name`,
`phone` (nullable), `joinedAt`.

**`reschedule_requests`** — `id`, `bookingId`, `requestedDate` (DATE),
`requestedStartMinutes`, `requestedEndMinutes`, `status`
(`pending|approved|rejected`), `reason` (nullable), `createdAt`, `decidedAt`.

## Player social

**`favorites`** — composite PK `(userId, venueId)`, `createdAt`.

**`reviews`** — `id`, `venueId`, `userId`, `bookingId` (unique — one per booking),
`rating` (1–5), `comment` (nullable), `ownerReply` (nullable), `repliedAt`
(nullable), `createdAt`.

**`game_posts`** — `id`, `creatorId` → users, `venueId` → venues (nullable),
`sport`, `city`, `date` (DATE), `startMinutes`, `playersNeeded`, `note`
(nullable), `status` (`open|full|closed`), `isCurated` (bool),
`curatedById` → users (nullable), `createdAt`. Indexed `(city, date, status)`.

**`game_participants`** — `id`, `postId`, `userId` (nullable), `name`, `phone`
(nullable), `joinedAt`.

**`promo_codes`** — `id`, `code` (unique), `kind` (`percent|flat`), `value`
(decimal), `maxDiscount` (decimal, nullable), `maxUses` (nullable), `usedCount`,
`perUserLimit`, `validFrom`, `validTo`, `isActive`, `createdAt`.

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

**`banners`** — `id`, `title`, `imageUrl`, `linkUrl` (nullable), `city`
(nullable — null = all cities), `isActive`, `startsAt`, `endsAt` (nullable),
`createdAt`.

**`venue_suggestions`** — `id`, `suggestedById` → users (nullable), `name`,
`city`, `phone` (nullable), `note` (nullable), `status`
(`new|contacted|converted|dismissed`), `createdAt`.

**`audit_logs`** — `id`, `actorId` → users, `action` (`venue.approve`,
`user.suspend`, …), `entity`, `entityId`, `createdAt`. Indexed `(entity, entityId)`.

**`settings`** — `key` (PK: `commissionPct`, `pendingExpiryHours`,
`noShowStrikeLimit`, `referralWelcomePct`, `referralRewardPct`), `value`
(string), `updatedAt`.

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
```
