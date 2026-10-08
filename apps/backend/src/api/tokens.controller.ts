/**
 * /api/v1/tokens — 1:1 port of module/api/tokens.py.
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpException,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { StrictIntPipe } from './pipes';
import type { Request } from 'express';

import { authService } from '../composition';
import { AuthenticationError, NotFoundError } from '../application/auth';
import { SessionGuard } from '../security/api';
import type { ApiTokenRow } from '../database/schema';
import { toApiIso, toStoredTime, parseStoredTime } from '../utils/time';
import { validateTokenName, validateTokenScope } from './validators';

function toPublic(t: ApiTokenRow) {
  return {
    id: t.id,
    user_id: t.user_id,
    name: t.name,
    scope: t.scope as 'api' | 'mcp',
    prefix: t.prefix,
    created_at: toApiIso(t.created_at),
    last_used_at: toApiIso(t.last_used_at),
    expires_at: toApiIso(t.expires_at),
    revoked_at: toApiIso(t.revoked_at),
  };
}

@Controller('/api/v1/tokens')
@UseGuards(SessionGuard)
export class TokensController {
  @Get('')
  listTokens() {
    return authService.listApiTokens().map(toPublic);
  }

  @Post('')
  @HttpCode(201)
  createToken(
    @Body() data: { name: string; scope?: string; expires_at?: string | null },
    @Req() req: Request,
  ) {
    const user = req.principal?.user;
    if (!user) {
      throw new HttpException('A browser session is required', 403);
    }
    validateTokenName(data.name);
    const scope = data.scope ?? 'api';
    validateTokenScope(scope);
    // FastAPI 解析 ISO datetime（非法输入 422）；存成 DB TIMESTAMP 格式
    let expiresAt: string | null = null;
    if (data.expires_at) {
      const parsed = parseStoredTime(data.expires_at);
      if (!parsed) {
        throw new HttpException(
          {
            detail: [
              {
                loc: ['body', 'expires_at'],
                msg: 'Input should be a valid datetime',
                type: 'datetime_parsing',
              },
            ],
          },
          422,
        );
      }
      expiresAt = toStoredTime(parsed);
    }
    try {
      const { token, rawToken } = authService.createApiTokenForUserId(user.id, {
        name: data.name,
        scope,
        expiresAt,
      });
      return { ...toPublic(token), token: rawToken };
    } catch (e) {
      if (e instanceof AuthenticationError) throw new HttpException('Unauthorized', 401);
      throw e;
    }
  }

  @Delete('/:token_id')
  @HttpCode(204)
  revokeToken(@Param('token_id', StrictIntPipe) tokenId: number) {
    try {
      authService.revokeApiToken(tokenId);
    } catch (e) {
      if (e instanceof NotFoundError) throw new HttpException(e.message, 404);
      throw e;
    }
  }
}
