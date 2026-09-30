import { Injectable, Logger } from '@nestjs/common';
import { PlayClient } from '../play/play.client';

/**
 * Hands out Android version codes for the runs the console starts — on GitHub Actions and on
 * this server alike — so the two never collide and every upload is above what Google Play has.
 *
 * next = max(Play's highest + 1, the highest code handed out or seen here + 1, 1001)
 *
 * Runs started by a `release:` commit or a tag on GitHub keep run number + offset; Fastlane
 * refuses before uploading if one of those ever falls below what Play has.
 */
@Injectable()
export class VersionCodes {
  private readonly logger = new Logger(VersionCodes.name);
  private last = 0;

  constructor(private readonly play: PlayClient) {}

  /** Codes already known locally (e.g. every run on this server), so a restart forgets nothing. */
  async next(known: number[] = []): Promise<number> {
    let playHighest = 0;
    if (this.play.keyState().kind === 'ready') {
      try {
        // Always fresh: the previous upload may have landed seconds ago.
        playHighest = (await this.play.snapshot(true)).highestVersionCode ?? 0;
      } catch (e) {
        this.logger.warn(`Google Play not readable for the version code: ${(e as Error).message}`);
      }
    }
    const code = this.peek(playHighest, known);
    this.last = code;
    return code;
  }

  /** What next() would hand out, given Play's highest code; reserves nothing. */
  peek(playHighest: number, known: number[] = []): number {
    return Math.max(playHighest + 1, this.last + 1, ...known.map((k) => k + 1), 1001);
  }
}
