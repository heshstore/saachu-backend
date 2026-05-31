import { Controller, Get, Post, Body, Query, Param } from '@nestjs/common';
import { EngineHealthService } from './engine-health.service';
import { StabilityReportService } from './stability-report.service';
import { ScaleReadinessService } from './scale-readiness.service';
import { EngineAuditService, AuditEvent } from './engine-audit.service';
import { EngineSettingsService } from './engine-settings.service';
import { MarketingWhatsAppService } from '../marketing-whatsapp.service';
import { ValidateService } from '../validate/validate.service';

@Controller('marketing/whatsapp-engine')
export class EngineHealthController {
  constructor(
    private readonly healthService: EngineHealthService,
    private readonly stabilityService: StabilityReportService,
    private readonly scaleService: ScaleReadinessService,
    private readonly auditService: EngineAuditService,
    private readonly engineSettings: EngineSettingsService,
    private readonly marketingWa: MarketingWhatsAppService,
    private readonly validateService: ValidateService,
  ) {}

  // Audience pipeline diagnostics: exact DB rows, per-contact filter verdict, queue/number/template status
  @Get('debug/test-audience')
  getTestAudienceDiagnostics() {
    return this.validateService.getTestAudienceDiagnostics();
  }

  /**
   * Deep runtime diagnostics for a single number.
   * Reads ONLY live in-memory state — never trusts DB.
   * Use this to determine whether the browser/page/session are truly alive
   * before deciding to rescan QR.
   *
   * Decision matrix:
   *   CASE A — browserConnected=true, pageClosed=false, currentUrl contains whatsapp
   *     → session is alive → DO NOT rescan QR → fix state reconciliation only
   *   CASE B — browserConnected=false, clientExists=false, pageClosed=true
   *     → session is truly dead → THEN rescan QR
   *   CASE C — browserExists=true but waState=idle
   *     → memory transition bug → check flags.terminating / flags.destroyed
   */
  @Get('debug/:id')
  getDebugSnapshot(@Param('id') id: string) {
    return this.marketingWa.getDebugSnapshot(id);
  }

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

  // Get current auto AI mode setting
  @Get('auto-mode')
  async getAutoMode() {
    const enabled = await this.engineSettings.getAutoAiMode();
    return { enabled };
  }

  // Toggle auto AI mode — persisted in crm_settings
  @Post('auto-mode')
  async setAutoMode(@Body('enabled') enabled: unknown) {
    if (typeof enabled !== 'boolean') {
      return { success: false, message: '"enabled" must be a boolean' };
    }
    await this.engineSettings.setAutoAiMode(enabled);
    return { success: true, enabled };
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
