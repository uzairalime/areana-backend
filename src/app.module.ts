import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import configuration, { validationSchema } from './config';
import { PrismaModule } from './common/prisma';
import { JwtAuthGuard, PermGuard } from './common/auth';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { VenuesModule } from './venues/venues.module';
import { CourtsModule } from './courts/courts.module';
import { AvailabilityModule } from './availability/availability.module';
import { BookingsModule } from './bookings/bookings.module';
import { SearchModule } from './search/search.module';
import { DeeplinkModule } from './deeplink/deeplink.module';
import { GamePostsModule } from './game-posts/game-posts.module';
import { WaitlistModule } from './waitlist/waitlist.module';
import { PromosModule } from './promos/promos.module';
import { FavoritesModule } from './favorites/favorites.module';
import { ReviewsModule } from './reviews/reviews.module';
import { BadgesModule } from './badges/badges.module';
import { DisputesModule } from './disputes/disputes.module';
import { BroadcastsModule } from './broadcasts/broadcasts.module';
import { SuggestionsModule } from './suggestions/suggestions.module';
import { OwnerModule } from './owner/owner.module';
import { AdminModule } from './admin/admin.module';
import { NotificationsModule } from './notifications/notifications.module';
import { StorageModule } from './storage/storage.module';
import { SchedulerModule } from './scheduler/scheduler.module';
import { HealthModule } from './health/health.module';

@Module({
  imports: [
    // NOTE (scaling): the default throttler store is in-memory per
    // process — correct for the single-container VPS deployment. If the
    // API ever runs 2+ instances, swap in a shared (Redis) store or the
    // limits multiply per instance. THROTTLE_LIMIT tunes without a deploy.
    ThrottlerModule.forRoot([
      { ttl: 60000, limit: parseInt(process.env.THROTTLE_LIMIT ?? '300', 10) },
    ]),
    ConfigModule.forRoot({ isGlobal: true, load: [configuration], validationSchema }),
    PrismaModule, // @Global
    NotificationsModule, // @Global (email + push)
    AuthModule,
    UsersModule,
    VenuesModule,
    CourtsModule,
    AvailabilityModule,
    BookingsModule,
    SearchModule,
    DeeplinkModule,
    GamePostsModule,
    WaitlistModule,
    PromosModule,
    FavoritesModule,
    ReviewsModule,
    BadgesModule,
    DisputesModule,
    BroadcastsModule,
    SuggestionsModule,
    OwnerModule,
    AdminModule,
    StorageModule,
    SchedulerModule,
    HealthModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermGuard },
  ],
})
export class AppModule {}
