import { All, Controller, Inject, Logger, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { request } from 'http';
import { Public } from '../auth/auth.guard';
import { CONSOLE_CONFIG, ConsoleConfig } from '../config';

/**
 * The Mac runners' way in: /api/runner/v1/* is passed to the builder as it is, streamed both
 * ways (a source download, an IPA upload, a long poll), with the builder token added. There is
 * no console session here: each agent carries its own runner token, which the builder checks
 * (and the setup files under files/ need none).
 */
@Public()
@Controller('runner/v1')
export class RunnerGatewayController {
  private readonly logger = new Logger(RunnerGatewayController.name);

  constructor(@Inject(CONSOLE_CONFIG) private readonly config: ConsoleConfig) {}

  @All('{*path}')
  proxy(@Req() req: Request, @Res() res: Response): void {
    if (!this.config.builderUrl || !this.config.builderToken) {
      res.status(503).json({ statusCode: 503, message: 'The console has no builder configured.' });
      return;
    }
    const target = new URL(`${this.config.builderUrl}${req.originalUrl.replace(/^\/api/, '')}`);
    const headers: Record<string, string> = { 'x-builder-token': this.config.builderToken, 'x-runner-address': req.ip ?? '' };
    for (const name of ['authorization', 'content-type', 'content-length', 'user-agent']) {
      const value = req.headers[name];
      if (typeof value === 'string') headers[name] = value;
    }
    // JSON bodies were already read by the API's body parser: send them again as they came.
    let body: Buffer | null = null;
    if (req.is('application/json') && req.body && typeof req.body === 'object') {
      body = Buffer.from(JSON.stringify(req.body));
      headers['content-length'] = String(body.length);
    }
    // A connection of its own, not one from the global pool: BuilderClient's axios (through
    // follow-redirects) leaves `timeout → destroy` on every pooled socket it used, and the pool
    // gives an idle socket the builder's keep-alive hint less a second (4 s), so a long poll
    // that reused one was cut after 4 s of waiting.
    const upstream = request(target, { method: req.method, headers, agent: false }, (up) => {
      res.status(up.statusCode ?? 502);
      for (const name of ['content-type', 'content-length']) {
        const value = up.headers[name];
        if (value) res.setHeader(name, value);
      }
      up.pipe(res);
    });
    upstream.on('error', (e) => {
      if (res.headersSent) return res.destroy();
      this.logger.warn(`runner gateway: ${e.message}`);
      res.status(502).json({ statusCode: 502, message: 'The builder is not answering; the runner tries again.' });
    });
    // An agent that hung up (a long poll it gave up on) must not keep the builder's request open.
    res.on('close', () => {
      if (!res.writableFinished) upstream.destroy();
    });
    if (body) upstream.end(body);
    else if (req.method === 'GET' || req.method === 'HEAD') upstream.end();
    else req.pipe(upstream);
  }
}
