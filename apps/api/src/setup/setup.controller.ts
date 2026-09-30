import { Body, Controller, Get, Post, Put } from '@nestjs/common';
import { PlayKeyDto } from '../pipeline/pipeline.dto';
import { SetupService } from './setup.service';

@Controller('setup')
export class SetupController {
  constructor(private readonly setup: SetupService) {}

  @Get()
  status() {
    return this.setup.status();
  }

  /** The key goes straight into the GitHub secret; the console never writes it anywhere. */
  @Put('play-key')
  playKey(@Body() dto: PlayKeyDto) {
    return this.setup.storePlayKey(dto.json);
  }

  /** Copies the Play key mounted on the console into the GitHub secret. */
  @Post('play-key/sync')
  syncPlayKey() {
    return this.setup.syncPlayKey();
  }
}
