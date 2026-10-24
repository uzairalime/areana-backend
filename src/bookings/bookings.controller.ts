import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
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
    const court = await this.courts.getActiveCourt(courtId);
    const n = Math.max(1, parseInt(slotCount ?? '1', 10));
    let amount: number;
    if (dateStr && startMinutesRaw !== undefined) {
      // Window-rate preview: the old base-rate-only amount priced peak
      // slots wrong (off by Rs 500 in the reported example) — the
      // preview must match booking creation's per-slot engine,
      // including the morning's weekday windows for overnight slots.
      const date = parseDateOnly(dateStr);
      const start = parseInt(startMinutesRaw, 10);
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
