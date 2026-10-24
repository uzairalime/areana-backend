import { BadRequestException } from '@nestjs/common';

/**
 * All date handling assumes the server runs with TZ=Asia/Karachi.
 * Days are stored as DATE + minutes-since-midnight — no timezone math on clients.
 */

export function parseDateOnly(s: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new BadRequestException('date must be YYYY-MM-DD');
  }
  // JS Date silently rolls impossible dates over (2026-02-30 -> Mar 2) and yields
  // Invalid Date for month 13 / day 00. Reject anything that does not round-trip
  // to the exact Y/M/D requested, so callers get a 400 instead of a booking for a
  // day nobody asked for or a 500 deep in Prisma.
  const [y, m, d] = s.split('-').map(Number);
  const date = new Date(`${s}T00:00:00`);
  if (
    date.getFullYear() !== y ||
    date.getMonth() + 1 !== m ||
    date.getDate() !== d
  ) {
    throw new BadRequestException(`invalid calendar date: ${s}`);
  }
  return date;
}

export function startOfToday(): Date {
  const n = new Date();
  return new Date(n.getFullYear(), n.getMonth(), n.getDate());
}

export function minutesSinceMidnight(d = new Date()): number {
  return d.getHours() * 60 + d.getMinutes();
}

export function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}
