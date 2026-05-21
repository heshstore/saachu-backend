import { Injectable, OnModuleDestroy, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { WhatsAppSession } from './entities/whatsapp-session.entity';
import { WhatsAppMessage } from './entities/whatsapp-message.entity';
import { LeadSource } from '../crm/entities/lead.entity';
import { normalizePhone } from '../crm/normalizers/lead-normalizer';

const CLIENT_ID      = 'crm-whatsapp';
const AUTH_DATA_PATH = '.wwebjs_auth_crm';
const SESSION_NAME   = 'crm-main';

const LOCK_FILES = ['SingletonLock', 'SingletonSocket', 'SingletonCookie', 'DevToolsActivePort'] as const;

function isValidWAPhone(raw: string): boolean {
  if (!/^\d{8,15}$/.test(raw)) return false;
  if (raw.startsWith('0')) return false;
  if (/^(\d)\1+$/.test(raw)) return false;
  return true;
}

type WaState = 'idle' | 'initializing' | 'qr_ready' | 'authenticating' | 'ready' | 'disconnected' | 'auth_failure';

@Injectable()
export class CrmWhatsAppService implements OnModuleDestroy {
  private readonly logger = new Logger(CrmWhatsAppService.name);

  private client: any       = null;
  private _ready            = false;
  private _waState: WaState = 'idle';
  private _initializing     = false;
  private _manualDisconnect = false;
  private _qrDataUrl: string | null  = null;
  private _qrGeneratedAt: Date | null = null;
  private _recovering = false;
  private seenMsgIds  = new Set<string>();

  constructor(
    @InjectRepository(WhatsAppSession)
    private sessionRepo: Repository<WhatsAppSession>,
    @InjectRepository(WhatsAppMessage)
    private messageRepo: Repository<WhatsAppMessage>,
    private eventEmitter: EventEmitter2,
  ) {}

  async onModuleDestroy() {
    this._ready = false;
    this._manualDisconnect = true;
    if (this.client) {
      try { await this.client.destroy(); } catch { /* ignore */ }
      this.client = null;
    }
  }

  // ── Init ─────────────────────────────────────────────────────────────────────

  async initClient(): Promise<void> {
    if (this._initializing) {
      this.logger.warn('[CRM_WA] initClient skipped — already initializing');
      return;
    }
    if (this.client) {
      this.logger.warn('[CRM_WA] initClient skipped — client already exists');
      return;
    }
    this._initializing = true;
    this._waState = 'initializing';
    this.logger.log(`[CRM_WA_INIT] Starting (clientId=${CLIENT_ID} pid=${process.pid})`);

    try {
      await this._startClient();
    } catch (e: any) {
      this.logger.error(`[CRM_WA_INIT] Failed: ${e?.message}`);
      this._waState = 'disconnected';
    } finally {
      this._initializing = false;
    }
  }

  private async _startClient(): Promise<void> {
    let Client: any, LocalAuth: any;
    try {
      const wwebjs = await import('whatsapp-web.js');
      Client    = wwebjs.Client;
      LocalAuth = wwebjs.LocalAuth;
    } catch (e: any) {
      this.logger.warn('[CRM_WA_INIT] whatsapp-web.js not available:', e?.message);
      return;
    }

    const executablePath = this.findChrome();
    this.logger.log(`[CRM_WA_INIT] Chrome: ${executablePath ?? '(bundled)'}`);
    this.removeLockFiles();

    this.client = new Client({
      authStrategy: new LocalAuth({ clientId: CLIENT_ID, dataPath: AUTH_DATA_PATH }),
      puppeteer: {
        headless: true,
        ...(executablePath ? { executablePath } : {}),
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--disable-gpu',
          '--disable-extensions',
          '--disable-background-networking',
          '--disable-background-timer-throttling',
          '--disable-renderer-backgrounding',
          '--disable-sync',
          '--disable-translate',
          '--mute-audio',
          '--no-first-run',
          '--no-zygote',
          '--single-process',
        ],
      },
      webVersionCache: { type: 'none' },
    });

    this.client.on('qr', async (qr: string) => {
      // qrcode@1.5.4 is pure CJS — (await import('qrcode')).default is undefined
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const QRCode = require('qrcode');
      let dataUrl: string;
      try {
        dataUrl = await QRCode.toDataURL(qr, { width: 300 });
      } catch (e: any) {
        this.logger.error(`[CRM_WA_EVENT] QR toDataURL failed: ${e?.message}`);
        return;
      }
      this._waState        = 'qr_ready';
      this._qrDataUrl      = dataUrl;
      this._qrGeneratedAt  = new Date();
      this.logger.log('[CRM_WA_EVENT] QR ready');
      await this.updateSession({ status: 'CONNECTING', qr_code: dataUrl });
    });

    this.client.on('authenticated', () => {
      this.logger.log('[CRM_WA_EVENT] Authenticated');
      this._waState       = 'authenticating';
      this._qrDataUrl     = null;
      this._qrGeneratedAt = null;
    });

    this.client.on('ready', async () => {
      if (this._ready) return;
      this._ready         = true;
      this._waState       = 'ready';
      this._qrDataUrl     = null;
      this._qrGeneratedAt = null;
      const phone = this.client?.info?.wid?.user ?? null;
      this.logger.log(`[WA_READY] Connected as +${phone}`);
      await this.updateSession({
        status:         'CONNECTED',
        qr_code:        null,
        phone_number:   phone,
        connected_at:   new Date(),
        disconnected_at: null,
      });
      this.eventEmitter.emit('crm.whatsapp.up');
      setTimeout(() => this.recoverMissedMessages().catch(() => {}), 3_000);
    });

    this.client.on('disconnected', async (reason: string) => {
      if (reason === 'NAVIGATION') return;
      this.logger.log(`[WA_DISCONNECT] Session disconnected: ${reason}`);
      this._ready   = false;
      this._waState = 'disconnected';
      await this.updateSession({ status: 'DISCONNECTED', disconnected_at: new Date() });
      if (!this._manualDisconnect) {
        this.eventEmitter.emit('crm.whatsapp.down', { reason });
      }
      // No auto-reconnect — wait for manual Connect press.
    });

    this.client.on('auth_failure', async (msg: string) => {
      this.logger.error(`[CRM_WA_EVENT] Auth failure: ${msg}`);
      this._ready         = false;
      this._waState       = 'auth_failure';
      this._qrDataUrl     = null;
      this._qrGeneratedAt = null;
      await this.updateSession({ status: 'DISCONNECTED', disconnected_at: new Date() });
      this.eventEmitter.emit('crm.whatsapp.down', { reason: 'AUTH_FAILURE' });
    });

    const onMsg = async (msg: any) => {
      if (msg.fromMe) return;
      const msgId = msg.id?._serialized ?? `${msg.from}-${msg.timestamp}`;
      if (this.seenMsgIds.has(msgId)) return;
      this.seenMsgIds.add(msgId);
      if (this.seenMsgIds.size > 500) {
        const first = this.seenMsgIds.values().next().value;
        this.seenMsgIds.delete(first!);
      }
      await this.handleInbound(msg);
    };
    this.client.on('message', onMsg);
    this.client.on('message_create', onMsg);

    // Release init lock on first WA event — not on ready.
    // initialize() stays pending while user scans QR; a timeout here would destroy the session.
    // Only abort if Chromium produces no event at all within 60s (genuine boot failure).
    const BOOT_TIMEOUT_MS = 60_000;
    const initStart = Date.now();
    this.logger.log('[WA_CONNECT] Calling initialize()');

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let bootTimeoutId: ReturnType<typeof setTimeout> | null = null;

      const settle = (err?: Error) => {
        if (settled) return;
        settled = true;
        if (bootTimeoutId) { clearTimeout(bootTimeoutId); bootTimeoutId = null; }
        if (err) reject(err); else resolve();
      };

      const onFirstEvent = () => {
        this.logger.log(`[CRM_WA_INIT] First event — init lock releasing (${Date.now() - initStart}ms)`);
        settle();
      };
      this.client.once('qr', onFirstEvent);
      this.client.once('authenticated', onFirstEvent);
      this.client.once('ready', onFirstEvent);
      this.client.once('auth_failure', onFirstEvent);

      bootTimeoutId = setTimeout(() => {
        settle(new Error(`Chromium boot timeout — no WA event in ${BOOT_TIMEOUT_MS / 1000}s`));
      }, BOOT_TIMEOUT_MS);

      this.client.initialize()
        .then(() => { settle(); })
        .catch((e: any) => {
          if (!settled) {
            settle(e instanceof Error ? e : new Error(String(e?.message ?? 'Unknown')));
          } else {
            this.logger.warn(`[CRM_WA_INIT] Late rejection after first event — waiting for disconnect events`);
          }
        });
    });

    this.logger.log('[CRM_WA_INIT] Init lock released — client live, awaiting scan or ready');
  }

  // ── Public control API ────────────────────────────────────────────────────────

  /** Trigger a connect. No-op if already initializing or connected. */
  async connect(): Promise<void> {
    if (this._initializing) {
      this.logger.warn('[WA_CONNECT] Already initializing — skipped');
      return;
    }
    if (this.client) {
      this.logger.warn('[WA_CONNECT] Already connected — skipped');
      return;
    }
    this.logger.log('[WA_CONNECT] User triggered connect');
    await this.initClient();
  }

  /** Destroy client and clear auth. Manual reconnect required after this. */
  async disconnect(): Promise<void> {
    this.logger.log('[WA_DISCONNECT] User triggered disconnect');
    this._ready            = false;
    this._manualDisconnect = true;
    if (this.client) {
      try { this.client.removeAllListeners(); } catch { /* ignore */ }
      try { await this.client.logout(); } catch { /* already gone */ }
      try { await this.client.destroy(); } catch { /* ignore */ }
    }
    this.client            = null;
    this._ready            = false;
    this._initializing     = false;
    this._manualDisconnect = false;
    this._waState          = 'idle';
    this._qrDataUrl        = null;
    this._qrGeneratedAt    = null;
    await this.clearAuthFiles();
    await this.updateSession({ status: 'DISCONNECTED', phone_number: null, connected_at: null });
    this.logger.log('[WA_DISCONNECT] Done — client destroyed, auth cleared');
  }

  /** Full session wipe: destroy + delete auth + fresh start (shows new QR). */
  async reset(): Promise<void> {
    if (this._initializing) {
      this.logger.warn('[WA_RESET] Already initializing — skipped');
      return;
    }
    this.logger.log('[WA_RESET] User triggered full session reset');
    this._ready            = false;
    this._manualDisconnect = true;
    if (this.client) {
      try { this.client.removeAllListeners(); } catch { /* ignore */ }
      try { await this.client.logout(); } catch { /* already gone */ }
      try { await this.client.destroy(); } catch { /* ignore */ }
    }
    this.client            = null;
    this._ready            = false;
    this._initializing     = false;
    this._manualDisconnect = false;
    this._waState          = 'idle';
    this._qrDataUrl        = null;
    this._qrGeneratedAt    = null;
    await this.clearAuthFiles();
    await this.updateSession({ status: 'DISCONNECTED', phone_number: null, connected_at: null });
    this.logger.log('[WA_RESET] Done — auth cleared, starting fresh client');
    await new Promise<void>((r) => setTimeout(r, 2_000));
    setImmediate(() => this.initClient().catch((e) =>
      this.logger.error('[WA_RESET] Post-reset init failed', e?.message),
    ));
  }

  // ── Status / QR getters ───────────────────────────────────────────────────────

  /** Combined status for the polling endpoint — DB row + in-memory state + QR. */
  async getFullStatus() {
    const row = await this.sessionRepo
      .findOne({ where: { session_name: SESSION_NAME } })
      .catch(() => null);
    const qrReady = this._waState === 'qr_ready';
    return {
      status:      row?.status      ?? 'DISCONNECTED',
      phone:       row?.phone_number ?? null,
      waState:     this._waState,
      initializing: this._initializing,
      qr: {
        active:      qrReady,
        qr:          qrReady ? this._qrDataUrl      : null,
        generatedAt: qrReady ? (this._qrGeneratedAt?.toISOString() ?? null) : null,
      },
    };
  }

  /** Lightweight in-memory-only QR getter (no DB hit). */
  getQrData() {
    const qrReady = this._waState === 'qr_ready';
    return {
      active:      qrReady,
      qr:          qrReady ? this._qrDataUrl      : null,
      generatedAt: qrReady ? (this._qrGeneratedAt?.toISOString() ?? null) : null,
    };
  }

  /** Legacy getter kept for backward compat with CRM module callers. */
  async getSessionStatus(): Promise<{ status: string; phone: string | null; waState: WaState }> {
    const row = await this.sessionRepo
      .findOne({ where: { session_name: SESSION_NAME } })
      .catch(() => null);
    return {
      status:  row?.status      ?? 'DISCONNECTED',
      phone:   row?.phone_number ?? null,
      waState: this._waState,
    };
  }

  isConnected(): boolean {
    if (!this._ready || !this.client) return false;
    const page = this.client.pupPage;
    return page != null && !page.isClosed();
  }

  // ── Messaging ─────────────────────────────────────────────────────────────────

  async sendMessage(chatId: string, body: string, sentBy?: number): Promise<void> {
    if (!this.client || !this.isConnected()) {
      throw new Error('WhatsApp not connected.');
    }
    try {
      await this.client.sendMessage(chatId, body);
    } catch (err: any) {
      const msg = err?.message ?? '';
      if (
        msg.includes('Execution context was destroyed') ||
        msg.includes('Session closed') ||
        msg.includes('Target closed')
      ) {
        this._ready = false;
        throw new Error('WhatsApp session expired. Please reconnect.');
      }
      throw err;
    }
    await this.messageRepo.save(
      this.messageRepo.create({
        chat_id:   chatId,
        direction: 'OUTBOUND',
        body,
        timestamp: new Date(),
        sent_by:   sentBy ?? null,
      }),
    );
    if (sentBy) {
      await this.messageRepo.manager
        .query(
          `UPDATE leads SET last_salesman_reply_at = NOW() WHERE whatsapp_chat_id = $1`,
          [this.normalizeChatId(chatId)],
        )
        .catch(() => {});
    }
  }

  async sendToPhone(phone: string, body: string, sentBy?: number): Promise<void> {
    await this.sendMessage(`${phone}@c.us`, body, sentBy);
  }

  async sendToAssignee(userId: number, body: string): Promise<void> {
    const rows: any[] = await this.messageRepo.manager
      .query(`SELECT mobile FROM "user" WHERE id = $1`, [userId]);
    if (!rows.length || !rows[0].mobile) return;
    const phone = rows[0].mobile.replace(/\D/g, '').slice(-10);
    if (phone.length !== 10) return;
    await this.sendToPhone(`91${phone}`, body);
  }

  async getChatMessages(chatId: string, leadId?: number): Promise<WhatsAppMessage[]> {
    const normalized = this.normalizeChatId(chatId);
    const q = this.messageRepo
      .createQueryBuilder('m')
      .where('m.chat_id = :chatId', { chatId: normalized })
      .orWhere('m.chat_id = :raw', { raw: chatId });
    if (leadId) q.orWhere('m.lead_id = :leadId', { leadId });
    return q.orderBy('m.timestamp', 'ASC').getMany();
  }

  // ── Private helpers ───────────────────────────────────────────────────────────

  private getSessionDir(): string {
    return path.join(process.cwd(), AUTH_DATA_PATH, `session-${CLIENT_ID}`);
  }

  private removeLockFiles(): void {
    const dir = this.getSessionDir();
    if (!fs.existsSync(dir)) return;
    for (const f of LOCK_FILES) {
      try { fs.unlinkSync(path.join(dir, f)); } catch { /* absent — ok */ }
    }
  }

  private async clearAuthFiles(): Promise<void> {
    const dir = this.getSessionDir();
    if (fs.existsSync(dir)) {
      await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
      this.logger.log('[CRM_WA] Auth directory removed');
    }
  }

  private findChrome(): string | undefined {
    const CANDIDATES = [
      process.env.CHROME_PATH,
      process.env.PUPPETEER_EXECUTABLE_PATH,
      '/usr/bin/google-chrome-stable',
      '/usr/bin/google-chrome',
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium',
      '/snap/bin/chromium',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ];
    for (const p of CANDIDATES) {
      if (p && fs.existsSync(p)) return p;
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const ep: string = require('puppeteer').executablePath();
      if (ep && fs.existsSync(ep)) return ep;
    } catch { /* no bundled puppeteer */ }
    return undefined;
  }

  private normalizeChatId(chatId: string): string {
    return chatId.replace(/:\d+(?=@)/, '');
  }

  private extractPhone(body: string): string | undefined {
    const matches = body.match(/\+?\d[\d\s-]{8,20}\d/g);
    if (!matches) return undefined;
    const valid = matches
      .map(r => r.replace(/\D/g, ''))
      .filter(isValidWAPhone)
      .sort((a, b) => b.length - a.length);
    if (!valid.length) return undefined;
    const normalized = normalizePhone(valid[0]);
    return normalized && normalized !== 'unknown' ? normalized : undefined;
  }

  private async handleInbound(msg: any): Promise<void> {
    const from: string = msg.from ?? '';
    if (from.endsWith('@g.us') || from === 'status@broadcast' || from.endsWith('@newsletter')) return;

    const chatId = this.normalizeChatId(from);
    const body: string = msg.body ?? '';
    const raw   = chatId.split('@')[0];
    const phone = isValidWAPhone(raw) ? normalizePhone(raw) : undefined;
    this.logger.log(`Inbound chatId=${chatId} phone=${phone ?? 'unknown'}`);

    const savedMsg = await this.messageRepo.save(
      this.messageRepo.create({
        chat_id:   chatId,
        direction: 'INBOUND',
        body,
        timestamp: new Date(msg.timestamp * 1000),
        is_read:   false,
      }),
    );

    if (phone && /^(DONE|ISSUE|HOLD) \d+$/i.test(body.trim())) {
      this.eventEmitter.emit('whatsapp.command', { phone, body: body.trim().toUpperCase() });
      return;
    }

    const existing: any[] = await this.messageRepo.manager.query(
      `SELECT id, assigned_to, phone, name FROM leads WHERE whatsapp_chat_id = $1 AND is_active = true LIMIT 1`,
      [chatId],
    );

    if (existing.length > 0) {
      savedMsg.lead_id = existing[0].id;
      await this.messageRepo.save(savedMsg);

      if (!existing[0].phone && body) {
        const extracted = this.extractPhone(body);
        if (extracted) {
          await this.messageRepo.manager.query(
            `UPDATE leads SET phone = $1 WHERE id = $2`,
            [extracted, existing[0].id],
          );
        }
      }

      await this.messageRepo.manager.query(
        `UPDATE leads SET last_customer_reply_at = NOW() WHERE id = $1`,
        [existing[0].id],
      );

      const trimmedBody = body.trim();
      if (/^(stop|unsubscribe|opt.?out)$/i.test(trimmedBody)) {
        await this.messageRepo.manager.query(
          `UPDATE leads
           SET tags = COALESCE(tags, '[]'::jsonb) || '["automation_off"]'::jsonb
           WHERE id = $1
             AND NOT (COALESCE(tags, '[]'::jsonb) ? 'automation_off')`,
          [existing[0].id],
        );
        return;
      }

      if (existing[0].assigned_to && trimmedBody) {
        this.eventEmitter.emit('whatsapp.customer_replied', {
          leadId:      existing[0].id,
          leadName:    existing[0].name ?? 'Customer',
          assignedTo:  existing[0].assigned_to,
          messageBody: trimmedBody.slice(0, 200),
        });
      }
      return;
    }

    // Unknown sender — create a new lead
    const contact   = await msg.getContact().catch(() => null);
    const name      = contact?.pushname || contact?.name || raw || 'Unknown';
    const hash      = crypto.createHash('sha256').update(`${from}-${body || ''}`).digest('hex');
    const messageId = msg.id?._serialized || hash;

    this.eventEmitter.emit('crm.whatsapp.message.received', {
      phone: phone ?? raw,
      body:  body.slice(0, 1000),
      chatId: from,
      name:  (msg as any)?.notifyName ?? undefined,
    });

    this.eventEmitter.emit('lead.incoming', {
      phone,
      name,
      source:           LeadSource.WHATSAPP,
      whatsapp_chat_id: chatId,
      messageId,
      hasSerializedId:  !!msg.id?._serialized,
      product_interest: body || '',
      context:          'WHATSAPP – Inbound',
      raw_payload:      { chatId, body, timestamp: msg.timestamp },
    });
  }

  private async recoverMissedMessages(): Promise<void> {
    if (this._recovering || !this.isConnected()) return;
    this._recovering = true;
    try {
      this.logger.log('[CRM_WA_RECOVERY] Scanning for missed messages');
      const cutoff = Date.now() - 30 * 60 * 1000;
      const chats: any[] = await this.client.getChats();
      for (const chat of chats.filter((c: any) => !c.isGroup).slice(0, 20)) {
        if (!this.isConnected()) break;
        let msgs: any[];
        try { msgs = await chat.fetchMessages({ limit: 10 }); } catch { continue; }
        for (const msg of msgs) {
          if (msg.fromMe || (msg.timestamp * 1000) < cutoff) continue;
          const msgId: string = msg.id?._serialized ?? `${msg.from}-${msg.timestamp}`;
          if (this.seenMsgIds.has(msgId)) continue;
          this.seenMsgIds.add(msgId);
          try { await this.handleInbound(msg); } catch { /* non-fatal */ }
        }
      }
      this.logger.log('[CRM_WA_RECOVERY] Done');
    } catch { /* non-fatal */ } finally {
      this._recovering = false;
    }
  }

  private async updateSession(data: Partial<WhatsAppSession>): Promise<void> {
    try {
      let row = await this.sessionRepo.findOne({ where: { session_name: SESSION_NAME } });
      if (!row) row = this.sessionRepo.create({ session_name: SESSION_NAME });
      Object.assign(row, data, { last_active_at: new Date() });
      await this.sessionRepo.save(row);
    } catch (e: any) {
      this.logger.warn(`[CRM_WA_DB] updateSession failed — WA stays running: ${e?.message}`);
    }
  }
}
