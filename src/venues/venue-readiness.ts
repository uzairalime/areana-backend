import { BadRequestException } from '@nestjs/common';
/**
 * Venue go-live readiness — the requirements a venue must meet before it
 * can be submitted / approved (set by the super admin, Oct 2026):
 *   - at least 4 photos
 *   - amenities added
 *   - map coordinates set
 *   - at least one photo tagged for EVERY sport the venue offers
 *   - at least one active court
 * Enforced at owner submit and at admin approve; shown as a checklist in
 * both panels so gaps are fixed before they block anyone.
 */
export const MIN_VENUE_PHOTOS = 4;

export type PhotoEntry = {
  url: string;
  blurhash?: string;
  width?: number;
  height?: number;
  sport?: string | null;
};

/** Rich photo entries aligned to `venue.images` order. */
export function photoEntriesOf(venue: {
  images: string[];
  photos: unknown;
}): PhotoEntry[] {
  const stored = Array.isArray(venue.photos)
    ? (venue.photos as PhotoEntry[])
    : [];
  const byUrl = new Map(stored.map((x) => [x.url, x]));
  return venue.images.map((url) => byUrl.get(url) ?? { url });
}

export interface ReadinessCheck {
  key: string;
  label: string;
  ok: boolean;
  detail: string;
}

export interface VenueReadiness {
  ready: boolean;
  checks: ReadinessCheck[];
  /** Human-readable gaps, for error messages. */
  missing: string[];
}

export function venueReadiness(
  venue: {
    images: string[];
    photos: unknown;
    amenities: string[];
    lat: number | null;
    lng: number | null;
    sports: string[];
  },
  activeCourts: number,
): VenueReadiness {
  const entries = photoEntriesOf(venue);
  const checks: ReadinessCheck[] = [];

  checks.push({
    key: 'photos',
    label: 'Photos',
    ok: entries.length >= MIN_VENUE_PHOTOS,
    detail: `${entries.length}/${MIN_VENUE_PHOTOS} photos added`,
  });

  const amenities = (venue.amenities ?? []).filter((a) => a && a.trim());
  checks.push({
    key: 'amenities',
    label: 'Amenities',
    ok: amenities.length >= 1,
    detail:
      amenities.length >= 1
        ? `${amenities.length} amenities listed`
        : 'No amenities added yet',
  });

  const hasCoords = venue.lat !== null && venue.lng !== null;
  checks.push({
    key: 'coordinates',
    label: 'Map coordinates',
    ok: hasCoords,
    detail: hasCoords
      ? `${venue.lat}, ${venue.lng}`
      : 'Latitude / longitude not set',
  });

  for (const sport of venue.sports ?? []) {
    const tagged = entries.some(
      (e) => (e.sport ?? '').toLowerCase() === sport.toLowerCase(),
    );
    checks.push({
      key: `sport_image:${sport}`,
      label: `${sport} photo`,
      ok: tagged,
      detail: tagged
        ? `A photo is tagged "${sport}"`
        : `Add a photo and tag it "${sport}"`,
    });
  }

  checks.push({
    key: 'courts',
    label: 'Courts',
    ok: activeCourts >= 1,
    detail:
      activeCourts >= 1
        ? `${activeCourts} active court(s)`
        : 'Add at least one court',
  });

  const missing = checks.filter((c) => !c.ok).map((c) => c.detail);
  return { ready: missing.length === 0, checks, missing };
}

/** Set (or clear, with null/empty) the sport tag of one photo. */
export function withSportTag(
  entries: PhotoEntry[],
  url: string,
  sport: string | null,
): PhotoEntry[] {
  return entries.map((e) =>
    e.url === url ? { ...e, sport: sport && sport.trim() ? sport.trim() : null } : e,
  );
}

/**
 * The booking window must be able to contain at least one slot: the
 * minimum advance notice has to be shorter than the whole max-advance
 * horizon. A pair like min 2 days + max 1 day makes EVERY slot
 * unbookable (too near for one rule, too far for the other) — reject it
 * wherever the pair is set instead of letting an arena silently die.
 */

/**
 * Launch is Pakistan-only. Coordinates outside the country's bounding
 * box are almost always a swapped lat/lng (a swap keeps both numbers
 * inside the global ±90/±180 ranges, so plain range checks miss it).
 */
export function assertPakistanCoords(lat?: number | null, lng?: number | null) {
  if (lat == null || lng == null) return;
  if (lat < 23 || lat > 37.2 || lng < 60.8 || lng > 78) {
    throw new BadRequestException(
      'These coordinates fall outside Pakistan — check that latitude and longitude are not swapped.',
    );
  }
}

export function assertBookingWindow(
  minAdvanceMinutes: number,
  maxAdvanceDays: number,
) {
  if (minAdvanceMinutes < 0) {
    throw new BadRequestException('Min. advance cannot be negative');
  }
  if (maxAdvanceDays < 1) {
    throw new BadRequestException('Max. advance must be at least 1 day');
  }
  if (minAdvanceMinutes >= maxAdvanceDays * 1440) {
    throw new BadRequestException(
      `Min. advance (${minAdvanceMinutes} min) must be shorter than the max. advance window (${maxAdvanceDays} day${maxAdvanceDays === 1 ? '' : 's'}) — with these settings no slot could ever be booked`,
    );
  }
}
