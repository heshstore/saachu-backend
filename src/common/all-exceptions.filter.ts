import {
  ExceptionFilter, Catch, ArgumentsHost, HttpException, HttpStatus, Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exception');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx    = host.switchToHttp();
    const req    = ctx.getRequest<Request>();
    const res    = ctx.getResponse<Response>();
    const user   = (req as any).user;
    const userTag = user ? ` uid=${user.id} role=${user.role}` : '';

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    const message =
      exception instanceof HttpException
        ? exception.message
        : String((exception as any)?.message ?? exception);

    if (status >= 500) {
      this.logger.error(
        `${req.method} ${req.url}${userTag} → ${status}: ${message}`,
        (exception as any)?.stack,
      );
    } else if (status >= 400) {
      this.logger.warn(`${req.method} ${req.url}${userTag} → ${status}: ${message}`);
    }

    if (res.headersSent) return;

    res.status(status).json({
      statusCode: status,
      message,
      path: req.url,
      timestamp: new Date().toISOString(),
    });
  }
}
