import { Controller, Get, Post, Body, Query } from '@nestjs/common';
import { EngineHealthService } from './engine-health.service';
import { StabilityReportService } from './stability-report.service';
import { ScaleReadinessService } from './scale-readiness.service';
import { EngineAuditService, AuditEvent } from './engine-audit.service';

@Controller('marketing/whatsapp-engine')
export class EngineHealthController {
  constructor(
    private readonly healthService: EngineHealthService,
    private readonly stabilityService: StabilityReportService,
    private readonly scaleService: ScaleReadinessService,
    private readonly auditService: EngineAuditService,
  ) {}

  // Real-time health snapshot
  @Get('health')
  getHealth() {
    return this.healthService.getHealth();
  }

  // 14/30-day stability report for daily review (Step 2 + Step 3 + Step 7)
  @Get('stability-report')
  getStabilityReport(@Query('days') days?: string) {
    return this.stabilityService.getReport(days ? parseInt(days, 10) : 14);
  }

  // 8-condition GO/NO-GO scale readiness check (Step 8)
  @Get('scale-readiness')
  checkScaleReadiness() {
    return this.scaleService.checkReadiness();
  }

  // Controlled scale-up — only executes if all 8 conditions pass (Step 9)
  @Post('scale-up')
  scaleUp() {
    return this.scaleService.scaleUp();
  }

  // Safe re-enable after AUTO_PAUSE — requires investigator to supply a reason (Step 3)
  @Post('re-enable')
  async reEnable(@Body('reason') reason?: string) {
    const currentState = process.env.WHATSAPP_ENGINE_ENABLED;
    if (currentState !== 'false') {
      return { success: false, message: 'Engine is already enabled — no action taken.' };
    }
    if (!reason || reason.trim().length < 5) {
      return {
        success: false,
        message: 'Re-enable refused: provide a "reason" in the request body (min 5 chars) explaining the investigation outcome.',
      };
    }

    process.env.WHATSAPP_ENGINE_ENABLED = 'true';

    await this.auditService.log({
      event: AuditEvent.MANUAL_REENABLE,
      reason: reason.trim(),
    });

    return {
      success: true,
      message: `Engine re-enabled. Reason logged: "${reason.trim()}". Update WHATSAPP_ENGINE_ENABLED=true in .env to persist across restarts.`,
    };
  }
}
