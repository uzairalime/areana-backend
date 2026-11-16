import { BadRequestException } from '@nestjs/common';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

/**
 * THE common pagination schema for every listing endpoint in the API.
 *
 * Two families, one shape each — clients never guess:
 *
 * Cursor (queues, feeds, "load more" lists ordered by a datetime + id):
 *   query:  ?cursor=<opaque>&limit=<n>
 *   reply:  { items: T[], nextCursor: string | null, total?: number }
 *
 * Offset (directories and reports with page numbers / computed sorts):
 *   query:  ?page=<n>&limit=<n>
 *   reply:  { items: T[], total, page, limit, totalPages, hasMore }
 *
 * A cursor is `${isoDate}|${id}` of the last row of the previous page.
 * The (datetime, id) pair is unique and stable, so keyset pages never
 * drift when rows are inserted or removed between requests — and a
 * cursor whose row was deleted still works, unlike Prisma's
 * record-based cursor.
 */

export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
  total?: number;
}

export interface OffsetPage<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  hasMore: boolean;
}

export class CursorQueryDto {
  @ApiPropertyOptional({ description: 'Opaque cursor from a previous page' })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiPropertyOptional({ default: 30, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class OffsetQueryDto {
  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

/** Clamp a requested limit into [1, max], falling back to `def`. */
export function pageLimit(raw: number | undefined, def: number, max = 100): number {
  if (!raw || Number.isNaN(raw) || raw < 1) return def;
  return Math.min(Math.floor(raw), max);
}

/** Decode a cursor into its (date, id) keyset parts, or null if invalid. */
export function decodeCursor(
  cursor?: string | null,
): { date: Date; id: string } | null {
  if (!cursor) return null;
  const [iso, id] = cursor.split('|');
  const date = new Date(iso);
  if (!id || Number.isNaN(date.getTime())) return null;
  return { date, id };
}

/** Encode a row's (datetime field, id) as the next cursor. */
export function encodeCursor(date: Date, id: string): string {
  return `${date.toISOString()}|${id}`;
}

/**
 * Prisma OR condition selecting rows strictly AFTER the cursor in a
 * (field, id) ordering. `field` is the datetime column the list orders
 * by ('createdAt' for most lists); direction follows the list's sort.
 * A cursor that is present but malformed is a 400, not a silent reset
 * to page 1 — a corrupted/bookmarked cursor must fail visibly.
 */
export function keysetWhere(
  cursor: string | undefined | null,
  field: string,
  dir: 'asc' | 'desc',
  tieField = 'id',
):
  | { OR: Record<string, unknown>[] }
  | Record<string, never> {
  if (cursor) {
    const ks = decodeCursor(cursor);
    if (!ks) throw new BadRequestException('Malformed pagination cursor');
  }
  const ks = decodeCursor(cursor);
  if (!ks) return {};
  const cmp = dir === 'asc' ? 'gt' : 'lt';
  return {
    OR: [
      { [field]: { [cmp]: ks.date } },
      { [field]: ks.date, [tieField]: { [cmp]: ks.id } },
    ],
  };
}

/**
 * Build a CursorPage from probe rows: fetch `limit + 1` rows ordered by
 * the keyset field, pass them here — the extra row only signals "more".
 * `dateOf` extracts the row's ordering datetime (defaults to createdAt).
 */
export function cursorPage<T>(
  probeRows: T[],
  limit: number,
  dateOf: (row: T) => Date = (row) =>
    (row as unknown as { createdAt: Date }).createdAt,
  total?: number,
  idOf: (row: T) => string = (row) => (row as unknown as { id: string }).id,
): CursorPage<T> {
  const items = probeRows.slice(0, limit);
  const last = items[items.length - 1];
  return {
    items,
    nextCursor:
      probeRows.length > limit && last
        ? encodeCursor(dateOf(last), idOf(last))
        : null,
    ...(total !== undefined ? { total } : {}),
  };
}

/**
 * Build an OffsetPage from an in-memory (already sorted) full list.
 * One contract everywhere (matching offsetPageFromDb): the requested
 * page is echoed back, and an out-of-range page returns empty items
 * with hasMore: false — never silently clamped to the last page, so a
 * client asking for page 99 can't mistake last-page data for page 99.
 */
export function offsetPage<T>(
  all: T[],
  page: number,
  limit: number,
): OffsetPage<T> {
  const total = all.length;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const p = Math.max(1, page);
  return {
    items: p > totalPages ? [] : all.slice((p - 1) * limit, p * limit),
    total,
    page: p,
    limit,
    totalPages,
    hasMore: p < totalPages,
  };
}

/** Build an OffsetPage when the database already paged (total known). */
export function offsetPageFromDb<T>(
  items: T[],
  total: number,
  page: number,
  limit: number,
): OffsetPage<T> {
  const totalPages = Math.max(1, Math.ceil(total / limit));
  return {
    items,
    total,
    page,
    limit,
    totalPages,
    hasMore: page < totalPages,
  };
}

/** Wrap a small bounded list (catalogs, lookups) in the OffsetPage shape. */
export function wrapList<T>(items: T[]): OffsetPage<T> {
  return {
    items,
    total: items.length,
    page: 1,
    limit: items.length,
    totalPages: 1,
    hasMore: false,
  };
}
