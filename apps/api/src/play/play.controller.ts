import { Controller, Get, Query } from '@nestjs/common';
import { PlayClient } from './play.client';

@Controller('play')
export class PlayController {
  constructor(private readonly play: PlayClient) {}

  /** What is on every Google Play track right now, read with the console's key. */
  @Get()
  async status(@Query('refresh') refresh?: string) {
    const key = this.play.keyState();
    if (key.kind !== 'ready') {
      return { configured: false, packageName: this.play.packageName, reason: key.reason };
    }
    return { configured: true, ...(await this.play.snapshot(refresh === '1')) };
  }
}
