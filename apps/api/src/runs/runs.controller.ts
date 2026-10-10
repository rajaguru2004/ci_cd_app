import {
  ArgumentsHost,
  BadRequestException,
  Body,
  Catch,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Res,
  UploadedFile,
  UseFilters,
  UseInterceptors,
} from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import { createReadStream, promises as fs, rmSync } from 'fs';
import { BuilderClient, BuilderError } from '../builder/builder.client';
import { params, runner, StartRunDto, UploadRunDto } from './runs.dto';
import { RunsService } from './runs.service';

/**
 * A refused upload leaves nothing behind: whatever stopped it (the fields, the file, the
 * builder), the stored ZIP is removed before the refusal goes out.
 */
@Catch()
class RemoveRefusedUpload extends BaseExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const file = host.switchToHttp().getRequest<Request & { file?: Express.Multer.File }>().file;
    // Removed before the answer goes out, so a retry never finds the refused file.
    if (file?.path) rmSync(file.path, { force: true });
    if (error instanceof BuilderError) {
      host.switchToHttp().getResponse<Response>().status(error.status).json({ statusCode: error.status, message: error.message });
      return;
    }
    super.catch(error, host);
  }
}

/** Starting, reading and steering runs: on this server's builder, or on the app's GitHub Actions. */
@Controller()
export class RunsController {
  constructor(
    private readonly runs: RunsService,
    private readonly builder: BuilderClient,
  ) {}

  /** The apps page: every app with its latest run, and the most recent runs across apps. */
  @Get('overview')
  overview() {
    return this.runs.overview();
  }

  @Get('runs')
  list(@Query('app') app?: string) {
    return this.runs.list(app?.trim() || undefined);
  }

  /** An app's branch, commit by commit, each with its runs. */
  @Get('apps/:id/stream')
  stream(@Param('id') id: string, @Query('branch') branch?: string, @Query('refresh') refresh?: string) {
    return this.runs.stream(id, branch?.trim() || undefined, refresh === '1');
  }

  /** Build or Release: git pull → tests → signed AAB (→ Google Play), from the branch tip or one commit. */
  @Post('apps/:id/runs')
  @HttpCode(202)
  async start(@Param('id') id: string, @Body() dto: StartRunDto) {
    if (dto.mode === 'release' && !dto.releaseNotes) {
      throw new BadRequestException('Release notes are required: they are the "What\'s new" text on Google Play.');
    }
    const run = await this.builder.startRun({ app: id, source: { kind: 'git', branch: dto.branch, sha: dto.sha }, params: params(dto), startedBy: 'console', runner: runner(dto) });
    return { runId: run.id, number: run.number };
  }

  /**
   * The same pipeline for a source ZIP (GitHub → Code → Download ZIP). The file lands in the
   * volume the builder reads; the builder unpacks and checks it.
   */
  @Post('runs/upload')
  @HttpCode(202)
  @UseInterceptors(FileInterceptor('source'))
  @UseFilters(RemoveRefusedUpload)
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
      throw new BadRequestException('That file is not a ZIP. On GitHub use Code → Download ZIP and upload that file.');
    }
    if (dto.mode === 'release' && !dto.releaseNotes) {
      throw new BadRequestException('Release notes are required: they are the "What\'s new" text on Google Play.');
    }
    const run = await this.builder.startRun({
      app: dto.app,
      source: { kind: 'zip', upload: file.filename, fileName: file.originalname, sizeBytes: file.size },
      params: params(dto),
      startedBy: 'console',
    });
    return { runId: run.id, number: run.number };
  }

  @Get('runs/:id')
  run(@Param('id', ParseIntPipe) id: number) {
    return this.runs.detail(id);
  }

  @Get('runs/:id/jobs/:jobId/log')
  log(@Param('id', ParseIntPipe) id: number, @Param('jobId', ParseIntPipe) jobId: number) {
    return this.runs.log(id, jobId);
  }

  @Get('runs/:id/aab')
  async aab(@Param('id', ParseIntPipe) id: number, @Query('file') file: string | undefined, @Res() res: Response): Promise<void> {
    const which = file === 'mapping' ? 'mapping' : 'aab';
    const out = await this.runs.bundle(id, which);
    res.setHeader('Content-Type', which === 'mapping' ? 'text/plain; charset=utf-8' : 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${out.name}"`);
    res.setHeader('Content-Length', String(out.size));
    createReadStream(out.path).pipe(res);
  }

  @Post('runs/:id/cancel')
  @HttpCode(202)
  cancel(@Param('id', ParseIntPipe) id: number) {
    return this.builder.cancel(id);
  }

  /** The same source and settings again, with a fresh version code. */
  @Post('runs/:id/rerun')
  @HttpCode(202)
  async rerun(@Param('id', ParseIntPipe) id: number) {
    const run = await this.builder.rerun(id);
    return { runId: run.id, number: run.number };
  }
}
