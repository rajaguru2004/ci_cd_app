import { Controller, Get } from '@nestjs/common';
import { BuilderClient } from './builder/builder.client';

/** The console itself: its builder, its default Google Play key, the hosts and keys it holds. */
@Controller()
export class SetupController {
  constructor(private readonly builder: BuilderClient) {}

  /** What the builder is doing now (the top bar's status line). */
  @Get('builder')
  async status() {
    const health = await this.builder.health();
    return health ?? { ok: false, busy: false, queued: 0, current: null, defaultPlayKey: null, toolchain: { flutter: null, java: null } };
  }

  @Get('setup')
  async setup() {
    const health = await this.builder.health();
    if (!health) {
      return { builder: null, apps: [], keys: [], knownHosts: [], error: 'The builder is not answering. Check it with: docker compose ps builder' };
    }
    const [apps, keys, knownHosts] = await Promise.all([this.builder.apps(), this.builder.keys(), this.builder.knownHosts()]);
    return { builder: health, apps, keys, knownHosts, error: null };
  }
}
