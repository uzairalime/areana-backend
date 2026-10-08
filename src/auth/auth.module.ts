import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { PromosModule } from '../promos/promos.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './jwt.strategy';
import { MailService } from './mail.service';

@Module({
  imports: [PassportModule, JwtModule.register({}), PromosModule],
  controllers: [AuthController],
  providers: [AuthService, MailService, JwtStrategy],
  exports: [MailService],
})
export class AuthModule {}
