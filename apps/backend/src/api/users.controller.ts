/**
 * /api/v1/users — 1:1 port of module/api/users.py (session-guarded multi-user CRUD).
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpException,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { StrictIntPipe } from './pipes';

import { authService } from '../composition';
import { ConflictError, NotFoundError } from '../application/auth';
import { SessionGuard } from '../security/api';
import { toApiIso } from '../utils/time';
import { validatePassword, validateUsername } from './validators';
import type { UserRow } from '../database/schema';

function toPublic(u: UserRow) {
  return {
    id: u.id,
    username: u.username,
    enabled: u.enabled,
    created_at: toApiIso(u.created_at),
    updated_at: toApiIso(u.updated_at),
  };
}

@Controller('/api/v1/users')
@UseGuards(SessionGuard)
export class UsersController {
  @Get('')
  listUsers() {
    return authService.listUsers().map(toPublic);
  }

  @Post('')
  @HttpCode(201)
  createUser(@Body() data: { username: string; password: string }) {
    validateUsername(data.username);
    validatePassword(data.password);
    try {
      return toPublic(authService.createUser(data));
    } catch (e) {
      if (e instanceof ConflictError) throw new HttpException(e.message, 409);
      throw e;
    }
  }

  @Patch('/:user_id')
  updateUser(
    @Param('user_id', StrictIntPipe) userId: number,
    @Body() data: { username?: string | null; password?: string | null; enabled?: boolean | null },
  ) {
    if (data.username !== undefined && data.username !== null) validateUsername(data.username);
    if (data.password !== undefined && data.password !== null) validatePassword(data.password);
    try {
      return toPublic(authService.updateUser(userId, data));
    } catch (e) {
      if (e instanceof NotFoundError) throw new HttpException(e.message, 404);
      if (e instanceof ConflictError) throw new HttpException(e.message, 409);
      throw e;
    }
  }

  @Delete('/:user_id')
  @HttpCode(204)
  deleteUser(@Param('user_id', StrictIntPipe) userId: number) {
    try {
      authService.deleteUser(userId);
    } catch (e) {
      if (e instanceof NotFoundError) throw new HttpException(e.message, 404);
      if (e instanceof ConflictError) throw new HttpException(e.message, 409);
      throw e;
    }
  }
}
