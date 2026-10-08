# Platform — notifications, storage, scheduler, health

Cross-cutting services every feature builds on.

## Notifications (`notifications/`)

One fan-out service (`NotificationsService`, `@Global`). Two channels:

**Email** (SMTP — Mailpit in dev, Resend/SendGrid in prod):
- Owner: new booking request (with slot summary + price).
- OTP codes (via `MailService`).

**Push** (FCM):
- Player: booking accepted / rejected (with reason), 2-hour reminder,
  reschedule decision, game-board joins, broadcasts.
- Token lifecycle: `POST /users/me/device-tokens` registers; invalid tokens
  reported by FCM are deleted automatically.

`FCM_ENABLED=false` (dev default) → push becomes log-only so flows stay
testable without credentials. `true` needs `FCM_SERVICE_ACCOUNT` (JSON).

Events are fired from the services that own them (bookings, game-posts,
scheduler, admin broadcasts) — never from controllers.

## Image storage (`storage/`)

`StorageService.saveVenueImage(venueId, file)`:
- JPEG/PNG/WebP only, ≤ 5 MB, randomized filename.
- `STORAGE_DRIVER=local` (dev): written to `./uploads/venues/:venueId/`,
  served at `/uploads/...` via Express static, URL stored on `venue.images`.
- `STORAGE_DRIVER=s3` (prod): uploaded to the S3-compatible bucket
  (`S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT` for MinIO-style, keys, and
  `S3_PUBLIC_URL`); the public URL is stored instead.
- `deleteImage(url)` removes from whichever backend owns the URL.

Uploads go through `POST /owner/venues/:id/images` (`multipart/form-data`,
field `image`, perm `venues.manage`).

## Scheduler (`scheduler/`)

`@nestjs/schedule` crons — the platform's heartbeat:

| Schedule | Job |
|---|---|
| Every 15 min | **Expire pendings** — `pending` bookings older than `pendingExpiryHours` → `cancelled`; player notified |
| Every 30 min | **Reminders** — `confirmed` bookings starting within 2h (not yet reminded) → push, `reminderSent = true` |
| Nightly 02:00 | **Auto-complete** past `confirmed` → `completed` (unlocks reviews) |
| Nightly 02:00 | **Referral rewards** — pending referrals whose referee completed ≥1 booking → `rewarded` + 10% promo for the referrer |
| Nightly 02:00 | **Badge recompute** — simple v1 rule (rating ≥ 4.5, ≥ 5 reviews → tier-1 badge); thresholds refined later |

All times server-local (`Asia/Karachi`). Jobs are idempotent (flag/status
checks), so overlapping runs are safe.

## Health

### `GET /api/health` — public
```json
{ "ok": true, "db": "up" }
```
Pings Postgres. Use it for uptime monitors and deploy checks.
