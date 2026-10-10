import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { BuilderClient } from '../builder/builder.client';

class CreateKeyDto {
  @IsString({ message: 'Enter the email of your git account.' })
  @MaxLength(200)
  email!: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  name?: string;
}

class CheckDto {
  @IsString({ message: "Paste the repository's SSH URL." })
  @MaxLength(300)
  url!: string;

  @IsString({ message: 'Pick the SSH key that reaches this repository.' })
  @MaxLength(40)
  keyId!: string;
}

class InspectDto extends CheckDto {
  @IsString({ message: 'Pick a branch.' })
  @MaxLength(200)
  branch!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  path?: string;
}

/**
 * SSH keys the console generates for people's git accounts, the hosts it has met, and the
 * checks that prove a key reaches a repository. The private half of a key never leaves the
 * builder's vault.
 */
@Controller()
export class KeysController {
  constructor(private readonly builder: BuilderClient) {}

  @Get('keys')
  list() {
    return this.builder.keys();
  }

  @Post('keys')
  create(@Body() dto: CreateKeyDto) {
    return this.builder.createKey(dto.email, dto.name ?? null);
  }

  @Delete('keys/:id')
  remove(@Param('id') id: string) {
    return this.builder.deleteKey(id);
  }

  @Get('known-hosts')
  knownHosts() {
    return this.builder.knownHosts();
  }

  /** Forget a host's key (it changed on purpose); the next connection accepts the new one. */
  @Delete('known-hosts/:host')
  forget(@Param('host') host: string) {
    return this.builder.forgetHost(host);
  }

  /** git ls-remote with the key: proves access, lists the branches. */
  @Post('git/check')
  check(@Body() dto: CheckDto) {
    return this.builder.checkAccess(dto.url, dto.keyId);
  }

  /** Reads the app off a branch (pubspec, applicationId, label) without keeping the repository. */
  @Post('git/inspect')
  inspect(@Body() dto: InspectDto) {
    return this.builder.inspect(dto.url, dto.keyId, dto.branch, dto.path);
  }
}
