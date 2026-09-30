import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { createReadStream, promises as fs } from 'fs';
import { LocalRunsService } from '../local/local-runs.service';
import { UploadRunDto } from '../local/upload.dto';
import { StartRunDto } from './pipeline.dto';
import { PipelineService } from './pipeline.service';

/**
 * Runs on GitHub Actions have positive ids (GitHub's); runs of uploaded ZIPs on this server's
 * builder have negative ones. Every route below serves both.
 */
@Controller()
export class PipelineController {
  constructor(
    private readonly pipeline: PipelineService,
    private readonly local: LocalRunsService,
  ) {}

  /** The branch's recent commits, each with its pipeline runs (GitHub and uploaded). */
  @Get('stream')
  stream(@Query('branch') branch?: string) {
    return this.pipeline.stream(branch?.trim() || undefined);
  }

  /** Runs of uploaded ZIPs on this server, newest first (works without a GitHub token). */
  @Get('local-runs')
  localRuns() {
    return this.local.list();
  }

  @Get('branches')
  branches() {
    return this.pipeline.branches();
  }

  @Get('runs/:id')
  run(@Param('id', ParseIntPipe) id: number) {
    return id < 0 ? this.local.detail(-id) : this.pipeline.run(id);
  }

  @Get('runs/:id/jobs/:jobId/log')
  log(@Param('id', ParseIntPipe) id: number, @Param('jobId', ParseIntPipe) jobId: number) {
    return id < 0 ? this.local.log(-id, jobId) : this.pipeline.log(id, jobId);
  }

  @Get('runs/:id/aab')
  async aab(@Param('id', ParseIntPipe) id: number, @Query('file') file: string | undefined, @Res() res: Response): Promise<void> {
    const which = file === 'mapping' ? 'mapping' : 'aab';
    res.setHeader('Content-Type', which === 'mapping' ? 'text/plain; charset=utf-8' : 'application/octet-stream');
    if (id < 0) {
      const out = await this.local.bundle(-id, which);
      res.setHeader('Content-Disposition', `attachment; filename="${out.name}"`);
      res.setHeader('Content-Length', String(out.size));
      createReadStream(out.path).pipe(res);
      return;
    }
    const out = await this.pipeline.bundle(id, which);
    res.setHeader('Content-Disposition', `attachment; filename="${out.name}"`);
    res.setHeader('Content-Length', String(out.data.length));
    res.end(out.data);
  }

  /** Starts release.yml on GitHub Actions on a branch: build, release, or Play access check. */
  @Post('runs')
  @HttpCode(202)
  start(@Body() dto: StartRunDto) {
    return this.pipeline.start(dto);
  }

  /**
   * Starts the same pipeline on this server for a source ZIP (GitHub → Code → Download ZIP).
   * The file lands in the volume the builder reads; the builder unpacks and checks it.
   */
  @Post('runs/upload')
  @HttpCode(202)
  @UseInterceptors(FileInterceptor('source'))
  async upload(@UploadedFile() file: Express.Multer.File | undefined, @Body() dto: UploadRunDto) {
    if (!file) throw new BadRequestException('Choose the source ZIP to upload.');
    const head = Buffer.alloc(4);
    const fd = await fs.open(file.path, 'r');
    try {
      await fd.read(head, 0, 4, 0);
    } finally {
      await fd.close();
    }
    // PK\x03\x04 (a ZIP with files) or PK\x05\x06 (an empty one): anything else is not a ZIP.
    if (head[0] !== 0x50 || head[1] !== 0x4b || !((head[2] === 3 && head[3] === 4) || (head[2] === 5 && head[3] === 6))) {
      await fs.rm(file.path, { force: true });
      throw new BadRequestException('That file is not a ZIP. On GitHub use Code → Download ZIP and upload that file.');
    }
    return this.local.start(file, dto);
  }

  @Post('runs/:id/cancel')
  @HttpCode(202)
  cancel(@Param('id', ParseIntPipe) id: number) {
    return id < 0 ? this.local.cancel(-id) : this.pipeline.cancel(id);
  }

  /** On this server every re-run is a whole run: the jobs share one unpacked source. */
  @Post('runs/:id/rerun-failed')
  @HttpCode(202)
  rerunFailed(@Param('id', ParseIntPipe) id: number) {
    return id < 0 ? this.local.rerun(-id) : this.pipeline.rerunFailed(id);
  }

  @Post('runs/:id/rerun')
  @HttpCode(202)
  rerun(@Param('id', ParseIntPipe) id: number) {
    return id < 0 ? this.local.rerun(-id) : this.pipeline.rerun(id);
  }
}
