import {
  ArgumentsHost,
  BadRequestException,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

/** error ของระบบ: มี code คงที่ให้ client ใช้ตัดสินใจ */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (what: string) => new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND', `${what} not found`);
export const conflict = (code: string, message: string, details?: unknown) =>
  new AppError(HttpStatus.CONFLICT, code, message, details);

export function requestId(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header('x-request-id');
  const id = incoming && /^[\w-]{1,64}$/.test(incoming) ? incoming : randomBytes(8).toString('hex');
  (req as any).requestId = id;
  res.setHeader('x-request-id', id);
  next();
}

/** ทุก error ตอบรูปแบบเดียว: { code, message, request_id, details? } */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly log = new Logger('Http');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<Request>();
    const res = ctx.getResponse<Response>();
    const request_id = (req as any).requestId;

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let body: Record<string, unknown> = { code: 'INTERNAL_ERROR', message: 'Internal server error' };

    if (exception instanceof AppError) {
      status = exception.status;
      body = { code: exception.code, message: exception.message, details: exception.details };
    } else if (exception instanceof BadRequestException) {
      status = exception.getStatus();
      const r = exception.getResponse() as any;
      body = { code: 'VALIDATION_ERROR', message: 'Request validation failed', details: r?.message ?? r };
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const r = exception.getResponse() as any;
      body = { code: HttpStatus[status] ?? 'HTTP_ERROR', message: typeof r === 'string' ? r : r?.message };
    } else {
      this.log.error({ request_id, err: String(exception), stack: (exception as Error)?.stack });
    }
    if (body.details === undefined) delete body.details;
    res.status(status).json({ ...body, request_id });
  }
}
