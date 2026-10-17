import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../../users/entities/user.entity';
import { RunnerProfile } from '../../users/entities/runner-profile.entity';
import { AuthModule } from '../auth.module';
import { OauthLoginCode } from './entities/oauth-login-code.entity';
import { GoogleAuthConfig } from './google.config';
import { GoogleOAuthClient } from './google-oauth.client';
import { GoogleAuthService } from './google-auth.service';
import { GoogleAuthController } from './google-auth.controller';

/** Register in AppModule. Needs AuthModule to export AuthService (it does). */
@Module({
  imports: [TypeOrmModule.forFeature([User, RunnerProfile, OauthLoginCode]), AuthModule],
  controllers: [GoogleAuthController],
  providers: [GoogleAuthConfig, GoogleOAuthClient, GoogleAuthService],
})
export class GoogleAuthModule {}
