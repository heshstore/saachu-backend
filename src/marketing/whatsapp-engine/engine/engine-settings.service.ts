import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

const KEY_AUTO_AI_MODE = 'whatsapp_auto_ai_mode';

@Injectable()
export class EngineSettingsService {
  private readonly logger = new Logger(EngineSettingsService.name);

  constructor(
    @InjectDataSource()
    private readonly ds: DataSource,
  ) {}

  async getAutoAiMode(): Promise<boolean> {
    const rows: { value: string }[] = await this.ds.query(
      `SELECT value FROM crm_settings WHERE key = $1 LIMIT 1`,
      [KEY_AUTO_AI_MODE],
    );
    if (!rows.length) return false;
    return rows[0].value === 'true';
  }

  async setAutoAiMode(enabled: boolean): Promise<void> {
    await this.ds.query(
      `INSERT INTO crm_settings (key, value, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
      [KEY_AUTO_AI_MODE, enabled ? 'true' : 'false'],
    );
    this.logger.log(`[ENGINE_SETTINGS] whatsapp_auto_ai_mode set to ${enabled}`);
  }
}
