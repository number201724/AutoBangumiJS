/**
 * Response helpers — mirrors module/api/response.py + FastAPI error shapes.
 */
import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import type { Response } from 'express';

export interface MsgPair {
  msg_en: string;
  msg_zh: string;
}

/** u_response: ResponseModel -> JSON with matching status code. */
export function uResponse(
  res: Response,
  model: { status_code: number; msg_en: string; msg_zh: string },
): void {
  res.status(model.status_code).json({ msg_en: model.msg_en, msg_zh: model.msg_zh });
}

/**
 * FastAPI HTTPException parity: {"detail": ...}. Also maps unexpected errors
 * to a 500 with the FastAPI default shape.
 */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const response = exception.getResponse();
      let detail: unknown;
      if (typeof response === 'string') {
        detail = response;
      } else if (response && typeof response === 'object') {
        const obj = response as Record<string, unknown>;
        detail = obj.detail ?? obj.message ?? response;
      } else {
        detail = exception.message;
      }
      res.status(status).json({ detail });
      return;
    }
    const message = exception instanceof Error ? exception.message : String(exception);
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ detail: message });
  }
}
