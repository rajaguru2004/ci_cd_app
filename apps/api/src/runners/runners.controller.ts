import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { IsString, MaxLength } from 'class-validator';
import { BuilderClient } from '../builder/builder.client';

class MacNameDto {
  @IsString({ message: 'Give the Mac a name.' })
  @MaxLength(60, { message: 'Keep the name under 60 characters.' })
  name!: string;
}

/**
 * The Macs that build and release the apps' iOS side. Adding one makes its token, shown once;
 * the console keeps only a hash of it. The Mac's agent then connects with it (runner-gateway).
 */
@Controller('runners')
export class RunnersController {
  constructor(private readonly builder: BuilderClient) {}

  @Get()
  list() {
    return this.builder.macs();
  }

  @Post()
  create(@Body() dto: MacNameDto) {
    return this.builder.createMac(dto.name);
  }

  @Patch(':id')
  rename(@Param('id') id: string, @Body() dto: MacNameDto) {
    return this.builder.renameMac(id, dto.name);
  }

  /** A new token: the old one stops working at once (the Mac's .env needs the new one). */
  @Post(':id/token')
  rotate(@Param('id') id: string) {
    return this.builder.rotateMacToken(id);
  }

  /** Forgets the agent key the console pinned, so a reinstalled runner can connect again. */
  @Post(':id/reset-key')
  resetKey(@Param('id') id: string) {
    return this.builder.resetMacKey(id);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.builder.removeMac(id);
  }
}
