import { Body, Controller, Delete, Get, Put } from '@nestjs/common';
import { IsString, MaxLength } from 'class-validator';
import { BuilderClient } from './builder/builder.client';

class GithubTokenDto {
  @IsString({ message: 'Paste the GitHub token.' })
  @MaxLength(255)
  token!: string;
}

/**
 * The console's default GitHub token: what an app uses to build on GitHub Actions unless it
 * has a token of its own (the app's settings → Where builds run).
 */
@Controller('github')
export class GithubController {
  constructor(private readonly builder: BuilderClient) {}

  @Get()
  status() {
    return this.builder.defaultGithubToken();
  }

  @Put('token')
  setToken(@Body() dto: GithubTokenDto) {
    return this.builder.setDefaultGithubToken(dto.token);
  }

  @Delete('token')
  clearToken() {
    return this.builder.clearDefaultGithubToken();
  }
}
