import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { PerfMonitorController } from './perf-monitor.controller';
import { PerfMonitorInterceptor } from './perf-monitor.interceptor';
import {
  PerfMonitorService,
  perfMonitorInstance,
} from './perf-monitor.service';

// Self-contained module — remove by deleting this directory and its three
// references (app.module.ts import, App.js route, Sidebar.js nav item).
@Module({
  controllers: [PerfMonitorController],
  providers: [
    // Expose the singleton through NestJS DI so other services can inject it if needed.
    { provide: PerfMonitorService, useValue: perfMonitorInstance },
    // Register interceptor globally — wraps every HTTP request to record timing + query count.
    { provide: APP_INTERCEPTOR, useClass: PerfMonitorInterceptor },
  ],
  exports: [PerfMonitorService],
})
export class PerfMonitorModule {}
