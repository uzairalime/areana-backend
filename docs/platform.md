# Platform — notifications, storage, scheduler, health

Cross-cutting services every feature builds on.

## Notifications (`notifications/`)

One fan-out service (`NotificationsService`, `@Global`). Two channels plus
an inbox:

**Inbox + fan-out** — `pushToUser(userId, { title, body, data })` writes
an inbox row and fans out to FCM + email, and never throws.
`notifyPlayerEvent` is the same fan-out for player events.

**Email** (SMTP — Mailpit in dev, Resend/SendGrid in prod):
- Owner: new booking request (with slot summary + price).
- OTP codes (via `MailService`).

**Push** (FCM):
- Player: booking accepted / rejected (with reason), 2-hour reminder,
  reschedule decision, game-board joins, broadcasts, waitlist frees.
- Token lifecycle: `POST /users/me/device-tokens` registers; invalid tokens
  reported by FCM are deleted automatically; tokens are revocable on
  logout and password change.

`FCM_ENABLED=false` (dev default) → push becomes log-only so flows stay
testable without credentials. `true` needs `FCM_SERVICE_ACCOUNT` (JSON).

Events are fired from the services that own them (bookings, game-posts,
scheduler, admin broadcasts) — never from controllers.

## Image storage (`storage/`)

`StorageService.saveVenueImage(venueId, file)`:
- JPEG/PNG/WebP only, ≤ 5 MB, randomized filename. The declared type is
  not trusted: every upload is decoded with sharp (non-images rejected),
  EXIF-rotated, capped at 1920px wide, and recompressed (JPEG/WebP q80) —
  originals are never stored or served.
- Each processed image also yields a **BlurHash** + final dimensions,
  stored on `venue.photos` as `[{ url, blurhash, width, height }]`, kept
  in lockstep with the plain-URL `venue.images` (legacy consumers). The
  player web decodes the hash into a blurred placeholder while the real
  photo loads. Photos uploaded before this pipeline have no entry and
  fall back to the brand-gradient placeholder. Photo entries also carry
  an optional `sport` tag (upload accepts it; `PATCH
  /owner/venues/:id/images/tag` sets it later) — go-live readiness
  requires ≥ 1 tagged photo per sport in `venue.sports`. Court photos
  are Json-only (`[{ url, blurhash }]`).
- `STORAGE_DRIVER=local` (dev): written to `./uploads/venues/:venueId/`,
  served at `/uploads/...` via Express static, URL stored on `venue.images`.
- `STORAGE_DRIVER=s3` (prod): uploaded to the S3-compatible bucket
  (`S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT` for MinIO-style, keys, and
  `S3_PUBLIC_URL`); the public URL is stored instead.
- `deleteImage(url)` removes from whichever backend owns the URL.

Uploads go through `POST /owner/venues/:id/images` (`multipart/form-data`,
field `image`, perm `venues.manage`). Photo order (first = cover) is
managed via `PATCH /owner/venues/:id/images/order` with `{ urls }` — the
exact current set in the new order. Banner images upload through
`POST /admin/banners/upload` (same pipeline; the returned `blurhash` is
saved on the banner via the normal create/update calls).

## Scheduler (`scheduler/`)

`@nestjs/schedule` crons — the platform's heartbeat (6 jobs, all
Asia/Karachi; single-flight + startup catch-up so a restart spanning a
tick still runs the missed work):

| Schedule | Job |
|---|---|
| Every 15 min | **Expire pendings** — `pending` bookings past their slot-relative expiry → `cancelled`; player notified |
| Every 15 min | **Close expired game posts** — posts past their slot → `closed` |
| Every 30 min | **Reminders** — `confirmed` bookings starting within 2h (not yet reminded) → push, `reminderSent = true` |
| Nightly 00:30 | **Billing sweep** — overdue venues → `billingPaused` + owner notified (pause-only; never auto-resumes) |
| Nightly 02:00 | **Nightly** — auto-complete past `confirmed` → `completed` (unlocks reviews); referral rewards (pending referrals whose referee completed ≥1 booking → `rewarded` + 10% promo for the referrer); badge recompute (simple v1 rule: rating ≥ 4.5, ≥ 5 reviews → tier-1 badge; thresholds refined later) |
| Nightly 03:00 | **Prune auth data** — expired OTP codes, revoked/expired refresh sessions |

All times server-local (`Asia/Karachi`). Jobs are idempotent (flag/status
checks), so overlapping runs are safe.

## Health

### `GET /api/health` — public
```json
{ "ok": true, "db": "up", "dbTimezone": "Asia/Karachi",
  "fcm": { "enabled": false, "configured": false },
  "push": { "healthy": true }, "degraded": [],
  "migrations": { "status": "ok", "pending": [], "failed": [] } }
```
Pings Postgres. Use it for uptime monitors and deploy checks. `ok` flips
to `false` and the endpoint returns **503** when `degraded` is non-empty
(DB down, DB timezone ≠ Asia/Karachi, FCM enabled-but-unconfigured,
failed/pending migrations, missing columns) — so the Docker healthcheck
gate can actually fail. Note the boot asymmetry: a DB that is down **at
boot** crashes the process (`PrismaService.onModuleInit` connects eagerly
→ P1001 → exit; the orchestrator restarts it), while a DB that dies
**after** boot surfaces here as 503.
