import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { StartRunDto } from './pipeline.dto';
import { PipelineService } from './pipeline.service';

@Controller()
export class PipelineController {
  constructor(private readonly pipeline: PipelineService) {}

  /** The branch's recent commits, each with its pipeline runs. */
  @Get('stream')
  stream(@Query('branch') branch?: string) {
    return this.pipeline.stream(branch?.trim() || undefined);
  }

  @Get('branches')
  branches() {
    return this.pipeline.branches();
  }

  @Get('runs/:id')
  run(@Param('id', ParseIntPipe) id: number) {
    return this.pipeline.run(id);
  }

  @Get('runs/:id/jobs/:jobId/log')
  log(@Param('id', ParseIntPipe) id: number, @Param('jobId', ParseIntPipe) jobId: number) {
    return this.pipeline.log(id, jobId);
  }

  @Get('runs/:id/aab')
  async aab(
    @Param('id', ParseIntPipe) id: number,
    @Query('file') file: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const out = await this.pipeline.bundle(id, file === 'mapping' ? 'mapping' : 'aab');
    res.setHeader('Content-Type', file === 'mapping' ? 'text/plain; charset=utf-8' : 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${out.name}"`);
    res.setHeader('Content-Length', String(out.data.length));
    res.end(out.data);
  }

  /** Starts release.yml on a branch: build, release, or Play access check. */
  @Post('runs')
  @HttpCode(202)
  start(@Body() dto: StartRunDto) {
    return this.pipeline.start(dto);
  }

  @Post('runs/:id/cancel')
  @HttpCode(202)
  cancel(@Param('id', ParseIntPipe) id: number) {
    return this.pipeline.cancel(id);
  }

  @Post('runs/:id/rerun-failed')
  @HttpCode(202)
  rerunFailed(@Param('id', ParseIntPipe) id: number) {
    return this.pipeline.rerunFailed(id);
  }

  @Post('runs/:id/rerun')
  @HttpCode(202)
  rerun(@Param('id', ParseIntPipe) id: number) {
    return this.pipeline.rerun(id);
  }
}
