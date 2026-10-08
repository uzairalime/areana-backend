# Auth

Two login worlds: **passwordless email OTP** for players (mobile app),
**email + password** for owners, staff, and super admins (web panels).

## Player: email OTP

### `POST /auth/request-otp` — public
Sends a 6-digit code. Rate limited: 5 codes/hour per email, 5 attempts per code.

```json
// request
{ "email": "player@example.com" }
// response 201
{ "message": "Login code sent to your email" }
```
The code is bcrypt-hashed in the DB, expires in 10 minutes. In dev it's also
logged to the console and visible in Mailpit (`:8025`).

### `POST /auth/verify-otp` — public
Verifies the code and returns tokens. **First verification = signup**: `name`
and `phone` are required only when the account doesn't exist yet.

```json
// request (returning user)
{ "email": "player@example.com", "code": "482913" }

// request (first time — signup)
{
  "email": "new@example.com", "code": "482913",
  "name": "Ahmed Khan", "phone": "03001234567",
  "city": "Lahore",                       // optional
  "referralCode": "AREANA-X7K2P9"          // optional — referrer's code
}

// response 201
{
  "accessToken": "eyJ...",
  "refreshToken": "eyJ...",
  "user": {
    "id": "cm3x...", "email": "new@example.com",
    "name": "Ahmed Khan", "role": "player",
    "permissions": ["bookings.create", "bookings.read", "reviews.write",
                    "favorites.manage", "games.manage", "referrals.read"]
  },
  "welcomePromoCode": "WELCOME-AB12CD"     // only on signup WITH a referral code
}
```
A new player gets a unique `referralCode` (`AREANA-XXXXXX`) for inviting friends.
If they signed up with someone's code, a pending referral is recorded and a
15%-off welcome promo is minted for them (code returned once, here).

Errors: `401` wrong/expired code, `400` missing name/phone on signup,
`403` account suspended.

### `POST /auth/refresh` — public
```json
// request
{ "refreshToken": "eyJ..." }
// response — same shape as verify-otp (without welcomePromoCode)
```

## Owner & staff: password login

### `POST /auth/owner/register` — public
Arena owners self-register; the account starts as `pending` and needs
super-admin approval before it can log in.
```json
// request
{ "email": "owner@arena.pk", "password": "secret123", "name": "Ali", "phone": "03001112233" }
// response 201
{ "message": "Owner account created. Waiting for admin approval.", "userId": "cm3x..." }
```

### `POST /auth/staff/login` — public
One login for owners, staff, and super admins (any role with a password).
Players are rejected here (`403` — they use the app).
```json
// request
{ "email": "owner@arena.pk", "password": "secret123" }
// response — same token shape as verify-otp
```

### `GET /auth/me` — authenticated
Returns the current user with their role (no password hash).

## Current user & devices

### `GET /users/me` — authenticated
Full profile with role name.

### `PATCH /users/me` — authenticated
```json
{ "name": "Ahmed", "phone": "03001234567", "city": "Karachi" }
```

### `POST /users/me/device-tokens` — authenticated
Registers an FCM token so the user receives push notifications.
```json
{ "token": "fcm:APA91...", "platform": "android" }
```
Upserts by token (re-installs don't duplicate). Dead tokens are pruned
automatically when FCM reports them invalid.

## Token model

| Field | Value |
|---|---|
| Access TTL | 15 min (`JWT_ACCESS_TTL`) |
| Refresh TTL | 7 days (`JWT_REFRESH_TTL`) |
| Payload | `{ sub, email, roleId, roleName }` |

Permissions are **not** baked into the token — the `JwtStrategy` loads the
user's role and its current permission keys from the DB on every request, so
panel-made role changes take effect immediately. See [permissions.md](permissions.md).
