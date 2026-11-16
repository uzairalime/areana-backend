/**
 * Great-circle distance helpers (Haversine). Used by venue discovery and
 * the games board for nearest-first sorting. Pure math — no PostGIS
 * dependency, and venue/game counts are small enough that in-memory
 * distance sorts stay cheap (same precedent as the price sorts).
 */

/** Distance in km between two points; null when any coordinate is missing. */
export function haversineKm(
  lat1: number | null | undefined,
  lng1: number | null | undefined,
  lat2: number | null | undefined,
  lng2: number | null | undefined,
): number | null {
  if (
    lat1 == null ||
    lng1 == null ||
    lat2 == null ||
    lng2 == null ||
    !Number.isFinite(lat1) ||
    !Number.isFinite(lng1) ||
    !Number.isFinite(lat2) ||
    !Number.isFinite(lng2)
  )
    return null;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  return 2 * 6371 * Math.asin(Math.sqrt(a));
}

/** Round to one decimal for display (2.34 -> 2.3). */
export function roundKm(km: number): number {
  return Math.round(km * 10) / 10;
}
