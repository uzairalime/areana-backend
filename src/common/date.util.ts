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

/**
 * Month arithmetic clamped to the target month's last day: raw
 * setMonth() overflows (31 Jan + 3 months lands on 1 May, not 30 Apr).
 * ONE shared implementation — plans billing and the courts/booking-gate
 * path used to carry separate copies, one clamped and one not, so a 31
 * Jan approval billed to 30 Apr while the booking gate said 1 May.
 */
export function addMonths(d: Date, months: number): Date {
  const day = d.getDate();
  const out = new Date(d);
  out.setDate(1);
  out.setMonth(out.getMonth() + months);
  const last = new Date(out.getFullYear(), out.getMonth() + 1, 0).getDate();
  out.setDate(Math.min(day, last));
  return out;
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

/**
 * Slot start as an instant. Built from local midnight of the play day —
 * not from the stored Date, which is UTC midnight (05:00 PKT) and would
 * shift every instant by five hours — and setMinutes rolls values past
 * 1440 across midnight, so an overnight spill slot (startMinutes 1500
 * on Friday = Saturday 01:00) gets its true instant. Every "already
 * started" check must use this, never `date < today`: a spill-start
 * booking is NOT started at midnight, it starts at its instant
 * (Round 5, P5-S46). Mirrors BookingsService.slotStartAt.
 */
export function slotStartAt(b: { date: Date; startMinutes: number }): Date {
  const d = new Date(b.date.getFullYear(), b.date.getMonth(), b.date.getDate());
  d.setMinutes(b.startMinutes);
  return d;
}
