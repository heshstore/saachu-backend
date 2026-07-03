import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { requestContext, perfMonitorInstance } from './perf-monitor.service';

// Express request shape — only what we read
interface ExpressRequest {
  method: string;
  path: string;
  route?: { path: string };
}

@Injectable()
export class PerfMonitorInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (ctx.getType() !== 'http') return next.handle();

    const req = ctx.switchToHttp().getRequest<ExpressRequest>();
    const method = req.method ?? 'UNK';
    const start = Date.now();

    // ALS store — endpoint is updated to the route template in the tap callback
    // once req.route is populated by Express after handler resolution.
    const store = { endpoint: `${method} ${req.path ?? '/'}`, queryCount: 0 };

    return new Observable((subscriber) => {
      requestContext.run(store, () => {
        next
          .handle()
          .pipe(
            tap({
              next: () => {
                // req.route?.path is the route template (e.g. /orders/:id).
                // It is only set after Express matches the handler — safe to read here.
                const routeKey = `${method} ${req.route?.path ?? req.path ?? '/'}`;
                store.endpoint = routeKey; // keep ALS label accurate for slow query records
                perfMonitorInstance.recordRequest(
                  routeKey,
                  Date.now() - start,
                  store.queryCount,
                );
              },
              error: () => {
                const routeKey = `${method} ${req.route?.path ?? req.path ?? '/'}`;
                store.endpoint = routeKey;
                perfMonitorInstance.recordRequest(
                  routeKey,
                  Date.now() - start,
                  store.queryCount,
                );
              },
            }),
          )
          .subscribe(subscriber);
      });
    });
  }
}
