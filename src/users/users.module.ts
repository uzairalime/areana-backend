import { Module } from '@nestjs/common';
import { BookingsModule } from '../bookings/bookings.module';
import { StorageModule } from '../storage/storage.module';
import { UsersController } from './users.controller';

@Module({
  imports: [BookingsModule, StorageModule],
  controllers: [UsersController],
})
export class UsersModule {}
