import { Module } from '@nestjs/common';
import { BookingsModule } from '../bookings/bookings.module';
import { UsersController } from './users.controller';

@Module({
  imports: [BookingsModule],
  controllers: [UsersController],
})
export class UsersModule {}
