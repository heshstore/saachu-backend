import {
  Injectable, NestInterceptor, ExecutionContext, CallHandler, Logger,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap, catchError } from 'rxjs/operators';
import { throwError } from 'rxjs';
import { Request, Response } from 'express';

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<any> {
    const http    = ctx.switchToHttp();
    const req     = http.getRequest<Request>();
    const res     = http.getResponse<Response>();
    const { method, url } = req;
    const user    = (req as any).user;
    const userTag = user ? ` uid=${user.id} role=${user.role}` : '';
    const start   = Date.now();

    return next.handle().pipe(
      tap(() => {
        const ms = Date.now() - start;
        this.logger.log(`${method} ${url} ${res.statusCode} ${ms}ms${userTag}`);
      }),
      catchError((err) => {
        const ms     = Date.now() - start;
        const status = err?.status ?? err?.response?.statusCode ?? 500;
        const msg    = err?.message ?? String(err);
        if (status >= 500) {
          this.logger.error(`${method} ${url} ${status} ${ms}ms${userTag} — ${msg}`, err?.stack);
        } else {
          this.logger.warn(`${method} ${url} ${status} ${ms}ms${userTag} — ${msg}`);
        }
        return throwError(() => err);
      }),
    );
  }
}
