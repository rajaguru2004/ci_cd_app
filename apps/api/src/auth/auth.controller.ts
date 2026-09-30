import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  Post,
  Req,
  Res,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { IsString, MaxLength } from 'class-validator';
import { CONSOLE_CONFIG, ConsoleConfig } from '../config';
import { Public } from './auth.guard';
import { LoginLimiter } from './login-limiter';
import { SESSION_COOKIE, SESSION_TTL_MS, safeEqual, signSession } from './session';

class LoginDto {
  @IsString({ message: 'Enter the console password.' })
  @MaxLength(200)
  password!: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

@Controller('auth')
export class AuthController {
  private readonly limiter = new LoginLimiter();

  constructor(@Inject(CONSOLE_CONFIG) private readonly config: ConsoleConfig) {}

  @Public()
  @Post('login')
  @HttpCode(204)
  async login(@Body() dto: LoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    if (!this.config.consolePassword) {
      throw new ServiceUnavailableException(
        'No console password is set. Add CONSOLE_PASSWORD to ci_cd_app/.env and restart the console.',
      );
    }
    // req.ip is the browser's address: main.ts trusts the private-network proxies in front.
    const who = req.ip ?? 'unknown';
    const wait = this.limiter.retryAfter(who);
    if (wait > 0) {
      throw new HttpException(
        `Too many wrong passwords from this address. Try again in ${Math.ceil(wait / 60_000)} minutes.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    if (!safeEqual(dto.password, this.config.consolePassword)) {
      this.limiter.fail(who);
      // A pause on every miss keeps even the allowed attempts slow.
      await sleep(800);
      throw new UnauthorizedException('That password is not the console password.');
    }
    this.limiter.succeed(who);
    res.cookie(SESSION_COOKIE, signSession(this.config.sessionSecret), {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.config.cookieSecure,
      maxAge: SESSION_TTL_MS,
      path: '/',
    });
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  logout(@Res({ passthrough: true }) res: Response): void {
    res.clearCookie(SESSION_COOKIE, { path: '/' });
  }

  /** 200 when the session cookie is valid (the guard ran), 401 otherwise. */
  @Get('me')
  me(): { signedIn: true } {
    return { signedIn: true };
  }
}
