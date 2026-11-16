/**
 * Permission catalog. Keys are defined here in code; the actual assignment
 * of keys → roles lives in the DB (`roles.permissions`) and is managed
 * from the super admin panel. Guards check these keys, never role names.
 */
export const PERMISSIONS = {
  // player
  'bookings.create': 'Create bookings',
  'bookings.read': 'View own bookings',
  'reviews.write': 'Write reviews',
  'favorites.manage': 'Save / unsave favorite venues',
  'games.manage': 'Post and join player games',
  'referrals.read': 'View own referral info',
  // owner
  'venues.manage': 'Create and manage own venues',
  'courts.manage': 'Manage courts of own venues',
  'bookings.review': 'Accept / reject booking requests',
  'bookings.manage': 'Walk-ins, cancel, check-in, no-show',
  'blocks.manage': 'Create and remove slot blocks',
  'schedule.manage': 'Opening hours and slot blocks',
  'customers.read': 'View customer list',
  'staff.manage': 'Create and manage team logins',
  'reviews.reply': 'Reply to reviews',
  // Billing and revenue figures (owner Billing page + the revenue
  // lines of the owner dashboard). Staff without this key still see
  // bookings and occupancy, just not money.
  'billing.view': 'View billing and revenue',
  // platform operations
  'venues.onboard': 'Onboard arenas from the admin panel (create owner, venue and courts) and view all venues',
  // super admin (wildcard)
  '*': 'All permissions',
} as const;

export type PermissionKey = keyof typeof PERMISSIONS;

/**
 * Permissions an arena owner may grant through roles they create for
 * their own team (Manager, Salesperson, …). Arena-scope only — platform
 * keys and '*' are never owner-grantable.
 */
export const ARENA_ROLE_PERMISSIONS = [
  'venues.manage',
  'courts.manage',
  'bookings.review',
  'bookings.manage',
  'blocks.manage',
  'schedule.manage',
  'customers.read',
  'staff.manage',
  'reviews.reply',
  'billing.view',
] as const;

export const PERMISSION_LIST = Object.entries(PERMISSIONS).map(([key, description]) => ({
  key,
  description,
}));
