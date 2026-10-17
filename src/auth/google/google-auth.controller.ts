import { Body, Controller, Get, HttpCode, Logger, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { GoogleAuthConfig } from './google.config';
import { GoogleAuthService } from './google-auth.service';
import { GoogleExchangeDto, GoogleStartQueryDto } from './dto/google.dto';
import { GoogleLoginError, STATE_COOKIE, STATE_TTL_MS } from './google.constants';

/**
 * Browser-facing OAuth endpoints. They are intentionally public: they start/finish a login.
 * GET  /auth/google            -> 302 to Google (sets the signed, HttpOnly state cookie)
 * GET  /auth/google/callback   -> 302 to the Nuxt app with a one-time code (or ?googleError=…)
 * POST /auth/google/exchange   -> { accessToken, refreshToken, returnTo } for that code
 */
@Controller('auth/google')
export class GoogleAuthController {
  private readonly logger = new Logger(GoogleAuthController.name);

  constructor(private readonly service: GoogleAuthService, private readonly cfg: GoogleAuthConfig) {}

  private basePath(req: Request): string {
    return req.originalUrl.split('?')[0].replace(/\/(callback|exchange)\/?$/, '').replace(/\/$/, '');
  }

  private cookieOptions(req: Request) {
    return { httpOnly: true, sameSite: 'lax' as const, secure: this.cfg.secureCookies, path: this.basePath(req) };
  }

  private fail(res: Response, code: string) {
    res.setHeader('Cache-Control', 'no-store');
    return res.redirect(302, `${this.cfg.frontendUrl}/login?googleError=${encodeURIComponent(code)}`);
  }

  @Get()
  start(@Query() q: GoogleStartQueryDto, @Req() req: Request, @Res() res: Response) {
    try {
      const { url, cookie } = this.service.begin(q.role, q.redirect);
      res.cookie(STATE_COOKIE, cookie, { ...this.cookieOptions(req), maxAge: STATE_TTL_MS });
      res.setHeader('Cache-Control', 'no-store');
      return res.redirect(302, url);
    } catch (err) {
      return this.fail(res, err instanceof GoogleLoginError ? err.code : 'exchange_failed');
    }
  }

  // NOTE: no DTO here on purpose. Google appends extra params (scope, authuser, prompt, hd…) and the
  // app-wide ValidationPipe (forbidNonWhitelisted) would reject a legitimate redirect with a 400.
  @Get('callback')
  async callback(@Req() req: Request, @Res() res: Response) {
    const opts = this.cookieOptions(req);
    const cookieHeader = req.headers.cookie;
    res.clearCookie(STATE_COOKIE, opts); // single use, whatever happens next
    try {
      const target = await this.service.complete(req.query as Record<string, unknown>, cookieHeader);
      res.setHeader('Cache-Control', 'no-store');
      return res.redirect(302, target);
    } catch (err) {
      if (!(err instanceof GoogleLoginError)) this.logger.error(`Google callback failed: ${(err as Error).message}`);
      return this.fail(res, err instanceof GoogleLoginError ? err.code : 'exchange_failed');
    }
  }

  @Post('exchange')
  @HttpCode(200)
  exchange(@Body() dto: GoogleExchangeDto) {
    return this.service.exchangeCode(dto.code);
  }
}
