import { BadRequestException } from '@nestjs/common';

/**
 * All date handling assumes the server runs with TZ=Asia/Karachi.
 * Days are stored as DATE + minutes-since-midnight — no timezone math on clients.
 */

export function parseDateOnly(s: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new BadRequestException('date must be YYYY-MM-DD');
  }
  return new Date(`${s}T00:00:00`);
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
