/**
 * Validated parsing for admin-editable numeric settings. A raw
 * parseInt/parseFloat of a mistyped value used to silently change
 * policy: "three" as the no-show strike limit parsed to NaN, so
 * `count >= NaN` was always false and strike suspension never fired,
 * and a garbage pending-expiry made pending bookings never expire.
 * Every setting read goes through here: unparseable or out-of-range
 * values fall back to the documented default instead of NaN.
 */

/** Integer setting: finite, whole, and >= min, else the fallback. */
export function parseSettingInt(
  raw: string | undefined | null,
  fallback: number,
  min = 0,
): number {
  if (raw == null) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  const v = Math.floor(n);
  return v >= min ? v : fallback;
}

/** Float setting: finite and >= min, else the fallback. */
export function parseSettingFloat(
  raw: string | undefined | null,
  fallback: number,
  min = 0,
): number {
  if (raw == null) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min) return fallback;
  return n;
}
