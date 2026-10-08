# Permissions & RBAC

Roles are **data, not code**. The `roles` table holds each role's name, scope,
and permission keys; the API guards check permission keys, never role names.
The super admin creates and remixes roles from the panel — no migration, no
redeploy.

## The permission catalog

Keys are defined in code (`src/common/permissions.ts`); assignment happens in
the DB. `GET /admin/permissions` returns this list for the panel UI.

| Key | Meaning |
|---|---|
| `bookings.create` | Create bookings (player) |
| `bookings.read` | View own bookings |
| `bookings.review` | Accept / reject booking requests |
| `bookings.manage` | Walk-ins, cancel, check-in, no-show |
| `blocks.manage` | Create / remove slot blocks |
| `reviews.write` | Write reviews |
| `reviews.reply` | Reply to reviews |
| `favorites.manage` | Save / unsave favorite venues |
| `games.manage` | Post and join player games |
| `referrals.read` | View own referral info |
| `venues.manage` | Create and manage own venues |
| `courts.manage` | Manage courts of own venues |
| `schedule.manage` | Opening hours and slot blocks |
| `customers.read` | View customer list |
| `staff.manage` | Create and manage team logins |
| `*` | All permissions (super_admin only) |

## Seeded roles

| Role | Scope | Permissions |
|---|---|---|
| `super_admin` | platform | `*` |
| `owner` | arena | venues/courts manage, bookings review+manage, blocks+schedule manage, customers read, staff manage, reviews reply |
| `staff` | arena | bookings review+manage, blocks manage, customers read |
| `player` | arena | bookings create+read, reviews write, favorites+games manage, referrals read |

System roles can't be deleted; `super_admin` can't be edited. New roles are
created with `POST /admin/roles { name, scope, description, permissions[] }`.

## How guards work

Every request passes two global guards:

1. **`JwtAuthGuard`** — skips routes marked `@Public()`; otherwise validates the
   JWT and loads `{ id, email, roleId, roleName, permissions }` via `JwtStrategy`
   (one indexed query per request).
2. **`PermGuard`** — reads the route's required permissions:
   - `@RequirePerm('a', 'b')` — needs **all** listed keys.
   - `@RequireAnyPerm('a', 'b')` — needs **at least one**.
   - No decorator — any authenticated user.
   - `'*'` in the user's permissions passes everything.

Data scoping (which *venues* a user may touch) is separate from permissions and
lives in the services: owners see venues they own (`ownerId`), staff see venues
in their `venue_staff` links. A staff member with `bookings.manage` still gets
`403 Not your venue` outside their assigned arenas.

## Staff governance (the key flow)

The super admin decides **per arena** how much power its owner may delegate:

1. Super admin designs arena-scope roles (e.g. `Manager`, `Front desk`) —
   `POST /admin/roles` with `scope: "arena"`.
2. During (or after) onboarding, super admin sets which roles an arena may use:
   `PATCH /admin/venues/:id/staff-roles { "roleIds": [...] }`
   → rows in `venue_allowed_roles`. Sensible defaults (all arena roles) are
   attached when a venue is created.
3. The owner creates team logins only from those roles:
   `POST /owner/venues/:venueId/staff { email, name, password, roleId }`.
   A `roleId` outside the arena's allowed list → `403`. The `owner` role itself
   can never be assigned to team members.
4. Staff log in with `POST /auth/staff/login` and are scoped to their assigned
   venues via `venue_staff`.

Removing a team member = `DELETE /owner/staff/:id` (deletes the venue link;
the user row stays for audit).
