/**
 * Request validation helpers — mirrors the pydantic Field constraints on the
 * user/token models (FastAPI returns 422 on violations).
 */
import { HttpException } from '@nestjs/common';

const USERNAME_RE = /^[a-zA-Z0-9_]+$/;

export function validateUsername(username: string): void {
  if (
    typeof username !== 'string' ||
    username.length < 4 ||
    username.length > 20 ||
    !USERNAME_RE.test(username)
  ) {
    throw new HttpException(
      'username must be 4-20 chars of [a-zA-Z0-9_]',
      422,
    );
  }
}

export function validatePassword(password: string): void {
  if (typeof password !== 'string' || password.length < 8) {
    throw new HttpException('password must be at least 8 characters', 422);
  }
}

export function validateTokenName(name: string): void {
  if (typeof name !== 'string' || name.length < 1 || name.length > 64) {
    throw new HttpException('name must be 1-64 characters', 422);
  }
}

export function validateTokenScope(scope: string): void {
  if (scope !== 'api' && scope !== 'mcp') {
    throw new HttpException('scope must be api or mcp', 422);
  }
}
