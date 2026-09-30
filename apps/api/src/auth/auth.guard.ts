import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { CONSOLE_CONFIG, ConsoleConfig } from '../config';
import { SESSION_COOKIE, verifySession } from './session';

const PUBLIC_KEY = 'mci:public';
/** Routes reachable without a session: sign-in and the container health check. */
export const Public = () => SetMetadata(PUBLIC_KEY, true);

/** Every route needs the signed session cookie unless it is marked @Public(). */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(CONSOLE_CONFIG) private readonly config: ConsoleConfig,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;
    const req = context.switchToHttp().getRequest<Request>();
    const token = (req.cookies as Record<string, string> | undefined)?.[SESSION_COOKIE];
    if (!verifySession(this.config.sessionSecret, token)) {
      throw new UnauthorizedException('Sign in to use the pipeline console.');
    }
    return true;
  }
}
