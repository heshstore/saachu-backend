import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

const KEY_AUTO_AI_MODE = 'whatsapp_auto_ai_mode';
const SETTING_TTL_MS = 300_000;

@Injectable()
export class EngineSettingsService {
  private readonly logger = new Logger(EngineSettingsService.name);

  private readonly _settingCache = new Map<
    string,
    { value: boolean; expiresAt: number }
  >();

  constructor(
    @InjectDataSource()
    private readonly ds: DataSource,
  ) {}

  async getAutoAiMode(): Promise<boolean> {
    const cached = this._settingCache.get(KEY_AUTO_AI_MODE);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const rows: { value: string }[] = await this.ds.query(
      `SELECT value FROM crm_settings WHERE key = $1 LIMIT 1`,
      [KEY_AUTO_AI_MODE],
    );
    const value = rows.length ? rows[0].value === 'true' : false;
    this._settingCache.set(KEY_AUTO_AI_MODE, {
      value,
      expiresAt: Date.now() + SETTING_TTL_MS,
    });
    return value;
  }

  async setAutoAiMode(enabled: boolean): Promise<void> {
    const cached = this._settingCache.get(KEY_AUTO_AI_MODE);
    if (cached && cached.expiresAt > Date.now() && cached.value === enabled) {
      return;
    }
    await this.ds.query(
      `INSERT INTO crm_settings (key, value, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
      [KEY_AUTO_AI_MODE, enabled ? 'true' : 'false'],
    );
    this._settingCache.set(KEY_AUTO_AI_MODE, {
      value: enabled,
      expiresAt: Date.now() + SETTING_TTL_MS,
    });
    this.logger.log(
      `[ENGINE_SETTINGS] whatsapp_auto_ai_mode set to ${enabled}`,
    );
  }
}
