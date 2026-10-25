import { BadRequestException, Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiQuery, ApiTags } from '@nestjs/swagger';
import { AuthUser, CurrentUser, Public, RequirePerm } from '../common/auth';
import { BookingsService } from './bookings.service';
import { PromosService } from '../promos/promos.service';
import { CourtsService } from '../courts/courts.service';
import { parseDateOnly } from '../common/date.util';
import {
  CreateBookingDto,
  CreateRecurringDto,
  JoinSharedDto,
  MyBookingsQueryDto,
  RequestRescheduleDto,
} from './dto';

@ApiTags('bookings')
@Controller('bookings')
export class BookingsController {
  constructor(
    private bookings: BookingsService,
    private promos: PromosService,
    private courts: CourtsService,
  ) {}

  @ApiBearerAuth()
  @RequirePerm('bookings.create')
  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateBookingDto) {
    return this.bookings.create({ ...dto, userId: user.id });
  }

  @ApiBearerAuth()
  @RequirePerm('bookings.create')
  @Post('recurring')
  createRecurring(@CurrentUser() user: AuthUser, @Body() dto: CreateRecurringDto) {
    return this.bookings.createRecurring(user.id, dto);
  }

  @ApiBearerAuth()
  @RequirePerm('bookings.read')
  @Get('me')
  listMine(@CurrentUser() user: AuthUser, @Query() query: MyBookingsQueryDto) {
    return this.bookings.listMine(user.id, query);
  }

  @ApiBearerAuth()
  @RequirePerm('bookings.read')
  @Patch(':id/cancel')
  cancelMine(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.bookings.cancelMine(user.id, id);
  }

  @ApiBearerAuth()
  @RequirePerm('bookings.read')
  @Patch('recurring/:recurrenceId/cancel')
  cancelSeries(@CurrentUser() user: AuthUser, @Param('recurrenceId') recurrenceId: string) {
    return this.bookings.cancelRecurringSeries(user.id, recurrenceId);
  }

  @ApiBearerAuth()
  @RequirePerm('bookings.read')
  @Post(':id/reschedule')
  requestReschedule(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: RequestRescheduleDto,
  ) {
    return this.bookings.requestReschedule(user.id, id, dto.date, dto.startMinutes);
  }

  @ApiBearerAuth()
  @RequirePerm('bookings.read')
  @Post(':id/reschedule/withdraw')
  withdrawReschedule(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.bookings.withdrawReschedule(user.id, id);
  }

  // --- promo preview (before booking) ---
  @ApiBearerAuth()
  @RequirePerm('bookings.create')
  @Get('validate-promo')
  @ApiQuery({ name: 'code', required: true })
  @ApiQuery({ name: 'courtId', required: true })
  @ApiQuery({ name: 'slotCount', required: false })
  @ApiQuery({ name: 'date', required: false })
  @ApiQuery({ name: 'startMinutes', required: false })
  async validatePromo(
    @CurrentUser() user: AuthUser,
    @Query('code') code: string,
    @Query('courtId') courtId: string,
    @Query('slotCount') slotCount?: string,
    @Query('date') dateStr?: string,
    @Query('startMinutes') startMinutesRaw?: string,
  ) {
    // Round 4, L-S6: a stored "" code used to be FOUND by preview
    // (lookup trims; booking creation skips falsy codes), so a player
    // saw a discount a booking could never apply. Preview rejects
    // empty codes exactly like booking creation does.
    if (!code || !code.trim()) {
      throw new BadRequestException('Promo code must not be empty');
    }
    const court = await this.courts.getActiveCourt(courtId);
    // Garbage slot inputs must not reach the pricing loop (Round 4
    // trivial): parseInt('abc') is NaN, and Math.max(1, NaN) is NaN,
    // so a garbage slotCount used to price the preview at NaN; an
    // absurd count looped millions of times. A booking fits one day:
    // at the 15-minute minimum slot length a 20-hour court holds at
    // most 80 slots.
    const parsedCount = slotCount === undefined ? 1 : Number(slotCount);
    if (!Number.isInteger(parsedCount) || parsedCount < 1 || parsedCount > 80) {
      throw new BadRequestException('slotCount must be a whole number between 1 and 80');
    }
    const n = parsedCount;
    let amount: number;
    if (dateStr && startMinutesRaw !== undefined) {
      const parsedStart = Number(startMinutesRaw);
      if (!Number.isInteger(parsedStart) || parsedStart < 0 || parsedStart >= 1800) {
        throw new BadRequestException('startMinutes must be a whole number between 0 and 1799');
      }
      const start = parsedStart;
      // Window-rate preview: the preview must match booking
      // creation's per-slot engine, including the morning's weekday
      // windows for overnight slots.
      const date = parseDateOnly(dateStr);
      const windows = await this.courts.priceWindowsForDateRange(court.id, date);
      const baseRate = Number(court.pricePerHour);
      amount = 0;
      for (let i = 0; i < n; i++) {
        amount +=
          this.courts.rateForSlotPair(windows, baseRate, start + i * court.slotMinutes) *
          (court.slotMinutes / 60);
      }
      amount = Math.round(amount * 100) / 100;
    } else {
      // Back-compat: callers without a slot context still get the base
      // rate preview (the panel passes date + startMinutes).
      amount = Number(court.pricePerHour) * ((court.slotMinutes * n) / 60);
    }
    return this.promos.validatePromo(code, user.id, amount, court.venueId);
  }

  // --- group booking share links ---
  @ApiBearerAuth()
  @RequirePerm('bookings.read')
  @Post(':id/share')
  share(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.bookings.shareBooking(user.id, id);
  }

  @Public()
  @Get('shared/:shareCode')
  getShared(@Param('shareCode') shareCode: string) {
    return this.bookings.getShared(shareCode);
  }

  @Public()
  @Post('shared/:shareCode/join')
  joinShared(@Param('shareCode') shareCode: string, @Body() dto: JoinSharedDto) {
    return this.bookings.joinShared(shareCode, dto);
  }
}
