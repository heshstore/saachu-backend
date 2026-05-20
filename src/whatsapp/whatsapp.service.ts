import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { ReplaySubject, Observable, interval, merge } from 'rxjs';
import { map } from 'rxjs/operators';
import { WhatsAppSession } from './entities/whatsapp-session.entity';
import { WhatsAppMessage } from './entities/whatsapp-message.entity';
import { appConfig } from '../config/config';
import { LeadSource } from '../crm/entities/lead.entity';
import { normalizePhone } from '../crm/normalizers/lead-normalizer';

/** Fixed LocalAuth identity — must not change between restarts. */
const WA_LOCAL_AUTH_CLIENT_ID = 'saachu-main';

/** Persistent auth root (relative to process.cwd()). */
const WA_AUTH_DATA_PATH = '.wwebjs_auth';

/** Brief pause after logout/destroy so the OS releases file handles before reinit. */
const POST_RESET_DELAY_MS = 2_000;

// Chromium profile lock files — runtime artefacts left behind by an unclean shutdown.
// Safe to remove before every init attempt; they are NOT auth data.
const CHROMIUM_LOCK_FILES = [
  'SingletonLock',
  'SingletonSocket',
  'SingletonCookie',
  'DevToolsActivePort',
] as const;

function isValidWhatsAppPhone(raw: string): boolean {
  if (!/^\d{8,15}$/.test(raw)) return false;
  if (raw.startsWith('0')) return false;
  if (/^(\d)\1+$/.test(raw)) return false;
  return true;
}

type WaState =
  | 'initializing'
  | 'qr_ready'
  | 'authenticating'
  | 'ready'
  | 'reconnecting'
  | 'disconnected'
  | 'auth_failure';

@Injectable()
export class WhatsAppService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WhatsAppService.name);
  private client: any = null;
  private _ready = false;
  private _waState: WaState = 'initializing';
  // Guards against two concurrent initClient() calls racing on the same LocalAuth directory.
  private _initializing = false;
  // Set true by user-initiated resets so the 'disconnected' event they trigger does not
  // emit a whatsapp.down alert or interfere with the reinit the reset manages itself.
  private _manualDisconnect = false;
  // ReplaySubject(1): new SSE subscribers receive the last event immediately on connect.
  private qrSubject = new ReplaySubject<string>(1);
  private _adminEventSubject = new ReplaySubject<string>(1);
  private sessionName = appConfig.whatsappSessionName;
  private seenMsgIds = new Set<string>();
  private _disconnectedAt: Date | null = null;
  private _lastDisconnectReason: string | null = null;
  private _lastReadyAt: Date | null = null;
  private _qrDataUrl: string | null = null;
  private _qrGeneratedAt: Date | null = null;
  private _recovering = false;

  constructor(
    @InjectRepository(WhatsAppSession)
    private sessionRepo: Repository<WhatsAppSession>,
    @InjectRepository(WhatsAppMessage)
    private messageRepo: Repository<WhatsAppMessage>,
    private eventEmitter: EventEmitter2,
  ) {}

  async onModuleInit() {
    this.logger.log('[WA_INIT] Module init');
    // Seed ReplaySubject so the first SSE subscriber gets the initializing state immediately.
    this.qrSubject.next(JSON.stringify({
      type: 'state_change', state: 'initializing', prev: null, timestamp: new Date().toISOString(),
    }));
    this._adminEventSubject.next(JSON.stringify({
      type: 'initializing', timestamp: new Date().toISOString(),
    }));
    setImmediate(() => this.initClient().catch((e) => {
      this.logger.error('[WA_INIT] Bootstrap failed', e?.stack ?? e?.message);
    }));
  }

  async onModuleDestroy() {
    this.logger.log('[WA_DESTROY] Module shutting down');
    this._ready = false;
    this._manualDisconnect = true;
    if (this.client) {
      try { await this.client.destroy(); } catch { /* ignore */ }
      this.client = null;
    }
  }

  // ── Core init ────────────────────────────────────────────────────────────────

  private async initClient() {
    if (this._initializing) {
      this.logger.warn('[WA_INIT] initClient() skipped — already initializing');
      return;
    }
    if (this.client) {
      this.logger.warn('[WA_INIT] initClient() skipped — client already exists');
      return;
    }

    this._initializing = true;
    this.logger.log(`[WA_INIT] Starting (clientId=${WA_LOCAL_AUTH_CLIENT_ID} pid=${process.pid})`);

    try {
      await this._initClientInner();
    } catch (e: any) {
      this.logger.error(`[WA_INIT_FATAL] initialize() threw: ${e?.stack ?? e?.message ?? String(e)}`);
      this.qrSubject.next(JSON.stringify({
        type: 'error',
        message: 'WhatsApp failed to start. Use "Reset Session" to try again.',
      }));
      this._adminEventSubject.next(JSON.stringify({
        type: 'error',
        message: `WhatsApp init failed: ${e?.message ?? 'unknown'}`,
        timestamp: new Date().toISOString(),
      }));
    } finally {
      this._initializing = false;
    }
  }

  private async _initClientInner() {
    // ── puppeteer-extra stealth setup ────────────────────────────────────────────
    // whatsapp-web.js hardcodes `require('puppeteer')` at the top of Client.js.
    // We redirect that require() to puppeteer-extra (with StealthPlugin) by patching
    // Node's module cache BEFORE the first import of whatsapp-web.js.
    // This must run on every call in case wwebjs was evicted and re-loaded.
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const puppeteerExtra = require('puppeteer-extra');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const StealthPlugin = require('puppeteer-extra-plugin-stealth');
      if (!puppeteerExtra._stealthRegistered) {
        puppeteerExtra.use(StealthPlugin());
        puppeteerExtra._stealthRegistered = true;
        this.logger.log('[WA_STEALTH] StealthPlugin registered on puppeteer-extra');
      }
      // Determine the exact path Node resolves when wwebjs does require('puppeteer').
      // wwebjs has its own puppeteer in its local node_modules, so the path differs from ours.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const wwebjsDir = require('path').dirname(require.resolve('whatsapp-web.js'));
      const wwebjsPuppeteerKey = require.resolve('puppeteer', { paths: [wwebjsDir] });
      const cache = (require as any).cache as Record<string, any>;
      const puppeteerExtraModule = cache[require.resolve('puppeteer-extra')];
      if (puppeteerExtraModule) {
        cache[wwebjsPuppeteerKey] = puppeteerExtraModule;
        this.logger.log('[WA_STEALTH] puppeteer-extra wired into wwebjs require cache');
      }
    } catch (e: any) {
      this.logger.warn(`[WA_STEALTH] Setup failed (non-fatal): ${e?.message}`);
    }

    let Client: any, LocalAuth: any;
    try {
      const wwebjs = await import('whatsapp-web.js');
      Client = wwebjs.Client;
      LocalAuth = wwebjs.LocalAuth;
    } catch (e: any) {
      this.logger.warn('[WA_INIT] whatsapp-web.js not available:', e?.message);
      return;
    }

    const executablePath = this.findChrome();
    this.logger.log(`[WA_INIT] Chrome: ${executablePath ?? '(bundled/auto)'}`);

    // Remove stale Chromium lock files left by an unclean prior shutdown.
    // These are runtime artefacts — NOT auth data. Safe to remove unconditionally.
    this.removeSingletonFiles(this.getSessionDir());

    this.client = new Client({
      authStrategy: new LocalAuth({
        clientId: WA_LOCAL_AUTH_CLIENT_ID,
        dataPath: WA_AUTH_DATA_PATH,
      }),
      puppeteer: {
        // DEBUG: headless: false — watch Chrome visually during QR scan to confirm pairing.
        // Set back to true once pairing is confirmed stable in production.
        headless: false,
        ...(executablePath ? { executablePath } : {}),
        // Minimal args only. Extra flags (--no-zygote, --disable-gpu etc.) can interfere
        // with Chrome's process model and break the WebSocket pairing handshake.
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
        ],
      },
      // wwebjs defaults to a fake Chrome 101 user agent on macOS 10.14.
      // Running Chrome 148 with a Chrome 101 UA is a textbook automation fingerprint mismatch.
      // false tells wwebjs to skip page.setUserAgent() so the real Chrome UA is used.
      userAgent: false as unknown as string,
      // type: 'none' means WebCache.resolve() always returns null → browser fetches the
      // CURRENT WhatsApp Web directly from CDN on every start, never serving a pinned version.
      webVersionCache: { type: 'none' },
    });

    // ── Event handlers ──────────────────────────────────────────────────────────

    this.client.on('qr', async (qr: string) => {
      this.logger.log('[WA_EVENT] event=qr');
      this.logger.log('[WA_DEBUG] QR GENERATED');
      let QRCode: any;
      try { QRCode = (await import('qrcode')).default; } catch { return; }
      const dataUrl = await QRCode.toDataURL(qr, { width: 300 });
      this.transitionState('qr_ready');
      this._qrDataUrl = dataUrl;
      this._qrGeneratedAt = new Date();
      this._adminEventSubject.next(JSON.stringify({ type: 'qr', timestamp: new Date().toISOString() }));
      // Emit QR image as the last qrSubject value — ReplaySubject(1) ensures reconnecting
      // SSE subscribers get the QR immediately. Frontend sets waState='qr_ready' on this event.
      this.qrSubject.next(JSON.stringify({ type: 'qr', dataUrl }));
      await this.updateSession({ status: 'CONNECTING', qr_code: dataUrl });
    });

    this.client.on('authenticated', () => {
      this.logger.log('[WA_EVENT] event=authenticated — QR scanned, cryptographic pairing approved');
      this.logger.log('[WA_DEBUG] PHONE ACCEPTED QR');
      this.transitionState('authenticating');
      this._qrDataUrl = null;
      this._qrGeneratedAt = null;
      this.qrSubject.next(JSON.stringify({ type: 'authenticated' }));
      this._adminEventSubject.next(JSON.stringify({ type: 'authenticated', timestamp: new Date().toISOString() }));
    });

    this.client.on('remote_session_saved', () => {
      this.logger.log('[WA_EVENT] event=remote_session_saved — LocalAuth persisted to disk');
      this._adminEventSubject.next(JSON.stringify({ type: 'session_saved', timestamp: new Date().toISOString() }));
    });

    this.client.on('ready', async () => {
      this.logger.log('[WA_EVENT] event=ready');
      if (this._ready) {
        this.logger.log('[WA_READY] Duplicate ready — skipping');
        return;
      }
      this._ready = true;
      this.transitionState('ready');
      this._qrDataUrl = null;
      this._qrGeneratedAt = null;

      if (this._disconnectedAt) {
        const mins = Math.round((Date.now() - this._disconnectedAt.getTime()) / 60_000);
        this.logger.log(`[WA_READY] Session recovered after ${mins} min`);
        this._disconnectedAt = null;
      }

      const phone = this.client?.info?.wid?.user ?? null;
      this.logger.log(`[WA_READY] Connected as +${phone}`);
      this._lastReadyAt = new Date();

      await this.updateSession({
        status: 'CONNECTED',
        qr_code: null,
        phone_number: phone,
        connected_at: new Date(),
        disconnected_at: null,
      });

      // Emit ready LAST so it wins the ReplaySubject(1) race against transitionState's
      // state_change emission, ensuring any reconnecting SSE subscriber gets the phone number.
      this.qrSubject.next(JSON.stringify({ type: 'ready', phone }));
      this._adminEventSubject.next(JSON.stringify({ type: 'ready', phone, timestamp: new Date().toISOString() }));

      this.eventEmitter.emit('whatsapp.up');
      setTimeout(() => this.recoverMissedMessages().catch((e) =>
        this.logger.warn(`[WA_RECOVERY] ${e?.message}`),
      ), 3_000);
    });

    this.client.on('disconnected', async (reason: string) => {
      this.logger.log(`[WA_EVENT] event=disconnected reason=${reason}`);
      // NAVIGATION fires during internal WA Web page transitions — not a real disconnect.
      if (reason === 'NAVIGATION') {
        this.logger.log('[WA_DISCONNECTED] Ignoring NAVIGATION — internal page transition');
        return;
      }
      this._ready = false;
      if (!this._disconnectedAt) this._disconnectedAt = new Date();
      this._lastDisconnectReason = reason;
      this.transitionState('disconnected');
      this._adminEventSubject.next(JSON.stringify({ type: 'disconnected', reason, timestamp: new Date().toISOString() }));
      this.qrSubject.next(JSON.stringify({ type: 'disconnected', reason }));
      await this.updateSession({ status: 'DISCONNECTED', disconnected_at: this._disconnectedAt });
      if (!this._manualDisconnect) {
        this.eventEmitter.emit('whatsapp.down', { reason });
      }
    });

    this.client.on('auth_failure', async (msg: string) => {
      this.logger.error(`[WA_AUTH_FAILURE] ${msg}`);
      this._ready = false;
      this._qrDataUrl = null;
      this._qrGeneratedAt = null;
      if (!this._disconnectedAt) this._disconnectedAt = new Date();
      this.transitionState('auth_failure');
      this._adminEventSubject.next(JSON.stringify({ type: 'auth_failure', message: msg, timestamp: new Date().toISOString() }));
      this.qrSubject.next(JSON.stringify({
        type: 'error',
        message: 'Authentication failed. Use "Reset Session" to pair again.',
      }));
      await this.updateSession({ status: 'DISCONNECTED', disconnected_at: this._disconnectedAt });
      this.eventEmitter.emit('whatsapp.down', { reason: 'AUTH_FAILURE' });
    });

    this.client.on('loading_screen', (percent: number, message: string) => {
      this.logger.log(`[WA_EVENT] loading_screen ${percent}% — ${message}`);
      this._adminEventSubject.next(JSON.stringify({ type: 'loading', percent, message, timestamp: new Date().toISOString() }));
    });

    // Logging only — WA Web internal state machine (UNPAIRED → OPENING → PAIRING → CONNECTED).
    // Do NOT drive our WaState from this; it fires before authentication is complete.
    this.client.on('change_state', (state: string) => {
      this.logger.log(`[WA_CHANGE_STATE] ${state}`);
      this._adminEventSubject.next(JSON.stringify({ type: 'change_state', state, timestamp: new Date().toISOString() }));
    });

    const onMsg = async (msg: any) => {
      if (msg.fromMe) return;
      const msgId = msg.id?._serialized ?? `${msg.from}-${msg.timestamp}`;
      if (this.seenMsgIds.has(msgId)) return;
      this.seenMsgIds.add(msgId);
      if (this.seenMsgIds.size > 500) {
        const first = this.seenMsgIds.values().next().value;
        this.seenMsgIds.delete(first);
      }
      this.logger.log(`[WA_MSG] Inbound from=${msg.from} id=${msgId}`);
      await this.handleInbound(msg);
    };

    this.client.on('message', onMsg);
    this.client.on('message_create', onMsg);

    this.logger.log('[WA_INIT] Listeners attached — calling initialize()');
    await this.client.initialize();
    this.logger.log('[WA_INIT] initialize() resolved');

    // ── Post-init page + network audit ───────────────────────────────────────────
    // Runs once after the browser is confirmed up. Captures low-level signals
    // during the QR scan → pairing handshake that wwebjs events do not surface.

    try {
      const pages: any[] = await (this.client.pupBrowser as any)?.pages() ?? [];
      this.logger.log(`[WA_DEBUG] Open pages count: ${pages.length}`);
    } catch (e: any) {
      this.logger.warn(`[WA_DEBUG] Could not list pages: ${e?.message}`);
    }

    const pupPage = this.client.pupPage as any;
    if (pupPage && !pupPage.isClosed()) {
      this.logger.log('[WA_DEBUG] pupPage available — attaching diagnostic listeners');

      // ── Browser console / JS errors ─────────────────────────────────────────
      pupPage.on('console', (msg: any) => {
        try {
          const t = typeof msg.type === 'function' ? msg.type() : String(msg.type);
          const m = typeof msg.text === 'function' ? msg.text() : String(msg);
          this.logger.log(`[PAGE_CONSOLE] ${t} ${m.slice(0, 300)}`);
        } catch { /* ignore */ }
      });

      pupPage.on('pageerror', (err: Error) => {
        this.logger.error(`[PAGE_ERROR] ${err?.message?.slice(0, 300)}`);
      });

      // ── Failed HTTP requests ────────────────────────────────────────────────
      pupPage.on('requestfailed', (req: any) => {
        try {
          this.logger.warn(`[REQUEST_FAILED] ${req.url()?.slice(0, 200)} — ${req.failure()?.errorText ?? '?'}`);
        } catch { /* ignore */ }
      });

      // ── HTTP responses (WA endpoints + errors) ──────────────────────────────
      pupPage.on('response', (res: any) => {
        try {
          const url: string = res.url() ?? '';
          const status: number = res.status();
          if (status >= 400 || url.includes('web.whatsapp.com') || url.includes('socket') || url.includes('wss')) {
            this.logger.log(`[NETWORK] ${status} ${url.slice(0, 200)}`);
          }
        } catch { /* ignore */ }
      });

      // ── CDP WebSocket frame inspection ──────────────────────────────────────
      // This is the only way to see WA's wss:// pairing socket from outside WA Web JS.
      // If WS_CREATED fires but WS_CLOSED fires immediately after scan → network/firewall.
      // If WS_CREATED fires but no WS_RECEIVED after scan → server rejected the session.
      try {
        const cdp = await pupPage.createCDPSession();
        await cdp.send('Network.enable');

        cdp.on('Network.webSocketCreated', ({ requestId, url }: any) => {
          this.logger.log(`[WS_CREATED] id=${requestId} url=${String(url ?? '').slice(0, 150)}`);
        });
        cdp.on('Network.webSocketFrameSent', ({ requestId }: any) => {
          this.logger.log(`[WS_SENT] id=${requestId}`);
        });
        cdp.on('Network.webSocketFrameReceived', ({ requestId }: any) => {
          this.logger.log(`[WS_RECEIVED] id=${requestId}`);
        });
        cdp.on('Network.webSocketClosed', ({ requestId }: any) => {
          this.logger.warn(`[WS_CLOSED] id=${requestId}`);
        });

        this.logger.log('[WA_DEBUG] CDP WebSocket monitoring active');
      } catch (e: any) {
        this.logger.warn(`[WA_DEBUG] CDP session failed: ${e?.message}`);
      }
    } else {
      this.logger.warn('[WA_DEBUG] pupPage not available after initialize() — browser may have exited');
    }
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  getQrObservable(): Observable<any> {
    return merge(
      this.qrSubject.asObservable().pipe(map((json) => ({ data: JSON.parse(json) }))),
      interval(30_000).pipe(map(() => ({ data: { type: 'ping' } }))),
    );
  }

  async sendMessage(chatId: string, body: string, sentBy?: number): Promise<void> {
    if (!this.client || !this.isConnected()) {
      throw new Error('WhatsApp not connected. Please scan the QR code first.');
    }
    try {
      await this.safeEval(() => this.client.sendMessage(chatId, body));
    } catch (err: any) {
      const msg = err?.message ?? '';
      const isContextError =
        msg.includes('Execution context was destroyed') ||
        msg.includes('detached Frame') ||
        msg.includes('Session closed') ||
        msg.includes('Target closed');
      if (isContextError) {
        this._ready = false;
        throw new Error('WhatsApp session expired. Please reconnect and try again.');
      }
      throw err;
    }
    await this.messageRepo.save(
      this.messageRepo.create({
        chat_id: chatId,
        direction: 'OUTBOUND',
        body,
        timestamp: new Date(),
        sent_by: sentBy ?? null,
      }),
    );
    // Only stamp last_salesman_reply_at for real user replies — not automated system messages.
    if (sentBy) {
      await this.messageRepo.manager.query(
        `UPDATE leads SET last_salesman_reply_at = NOW() WHERE whatsapp_chat_id = $1`,
        [this.normalizeChatId(chatId)],
      ).catch(() => { /* non-critical */ });
    }
  }

  async sendToPhone(phone: string, body: string, sentBy?: number): Promise<void> {
    await this.sendMessage(`${phone}@c.us`, body, sentBy);
  }

  async sendToAssignee(userId: number, body: string): Promise<void> {
    const rows: any[] = await this.messageRepo.manager.query(
      `SELECT mobile FROM "user" WHERE id = $1`,
      [userId],
    );
    if (!rows.length || !rows[0].mobile) return;
    const phone = rows[0].mobile.replace(/\D/g, '').slice(-10);
    if (phone.length !== 10) return;
    await this.sendToPhone(`91${phone}`, body);
  }

  async getSessionStatus(): Promise<{ status: string; phone: string | null; waState: WaState }> {
    const row = await this.sessionRepo.findOne({ where: { session_name: this.sessionName } });
    return {
      status:  row?.status ?? 'DISCONNECTED',
      phone:   row?.phone_number ?? null,
      waState: this._waState,
    };
  }

  async getChatMessages(chatId: string, leadId?: number): Promise<WhatsAppMessage[]> {
    const normalized = this.normalizeChatId(chatId);
    const q = this.messageRepo.createQueryBuilder('m')
      .where('m.chat_id = :chatId', { chatId: normalized })
      .orWhere('m.chat_id = :raw', { raw: chatId });
    if (leadId) q.orWhere('m.lead_id = :leadId', { leadId });
    return q.orderBy('m.timestamp', 'ASC').getMany();
  }

  isConnected(): boolean {
    if (!this._ready || !this.client) return false;
    const page = this.client.pupPage;
    return page != null && !page.isClosed();
  }

  /** User-initiated "Disconnect & Change Number" — wipes auth, generates fresh QR. */
  async disconnectAndReset(): Promise<void> {
    this.logger.log('[WA_RESET] User disconnect & reset');
    this._ready = false;
    this._manualDisconnect = true;
    if (this.client) {
      try { await this.client.logout(); } catch { /* already gone */ }
      try { await this.client.destroy(); } catch { /* ignore */ }
      this.client = null;
    }
    this._manualDisconnect = false;
    await this.clearAuthFiles();
    await this.updateSession({ status: 'DISCONNECTED', phone_number: null, connected_at: null });
    this.qrSubject.next(JSON.stringify({ type: 'disconnected' }));
    await new Promise<void>((r) => setTimeout(r, POST_RESET_DELAY_MS));
    setImmediate(() => this.initClient().catch((e) =>
      this.logger.error('[WA_INIT] Post-disconnect init failed', e?.message),
    ));
  }

  // ── Admin API ────────────────────────────────────────────────────────────────

  getAdminStatus() {
    const connected = this._ready && this.isConnected();
    return {
      connected,
      state:                this._initializing ? 'INITIALIZING' : connected ? 'CONNECTED' : 'DISCONNECTED',
      waState:              this._waState,
      lastDisconnectReason: this._lastDisconnectReason,
      disconnectedAt:       this._disconnectedAt?.toISOString() ?? null,
      downtimeMinutes:      this._disconnectedAt
        ? Math.round((Date.now() - this._disconnectedAt.getTime()) / 60_000)
        : null,
      lastReadyAt:        this._lastReadyAt?.toISOString() ?? null,
      qrActive:           this._waState === 'qr_ready',
      recoveringMessages: this._recovering,
      appVersion:         process.env.APP_VERSION ?? 'unknown',
    };
  }

  getQrData() {
    const qrReady = this._waState === 'qr_ready';
    return {
      active:      qrReady,
      qr:          qrReady ? this._qrDataUrl : null,
      generatedAt: qrReady ? (this._qrGeneratedAt?.toISOString() ?? null) : null,
    };
  }

  getAdminEventObservable(): Observable<any> {
    return merge(
      this._adminEventSubject.asObservable().pipe(map((json) => ({ data: JSON.parse(json) }))),
      interval(30_000).pipe(map(() => ({ data: { type: 'ping' } }))),
    );
  }

  /** Admin: restart client without clearing auth (use after a brief connection drop). */
  async safeRestart(): Promise<void> {
    if (this._initializing) {
      this.logger.warn('[WA_RESTART] Skipped — already initializing');
      return;
    }
    this.logger.log('[WA_RESTART] Restarting client — preserving auth session');
    this._adminEventSubject.next(JSON.stringify({ type: 'restart_initiated', timestamp: new Date().toISOString() }));
    this._ready = false;
    this._manualDisconnect = true;
    if (this.client) {
      try { await this.client.destroy(); } catch { /* ignore */ }
      this.client = null;
    }
    this._manualDisconnect = false;
    this.transitionState('reconnecting');
    await this.initClient();
  }

  /** Admin: alias for safeRestart — preserves auth, generates new QR if session expired. */
  async manualReconnect(): Promise<void> {
    this._adminEventSubject.next(JSON.stringify({ type: 'reconnect_initiated', timestamp: new Date().toISOString() }));
    await this.safeRestart();
  }

  /** Admin / user "Reset Session" — wipes auth and generates a fresh QR. */
  async resetWhatsAppSession(): Promise<void> {
    if (this._initializing) {
      this.logger.warn('[WA_RESET] Skipped — already initializing');
      return;
    }
    this.logger.log('[WA_RESET] Full session reset — wiping auth');
    this._adminEventSubject.next(JSON.stringify({ type: 'reset_initiated', timestamp: new Date().toISOString() }));
    this._ready = false;
    this._manualDisconnect = true;
    if (this.client) {
      try { await this.client.logout(); } catch { /* already gone */ }
      try { await this.client.destroy(); } catch { /* ignore */ }
      this.client = null;
    }
    this._manualDisconnect = false;
    await this.clearAuthFiles();
    await this.updateSession({ status: 'DISCONNECTED', phone_number: null, connected_at: null });
    this.qrSubject.next(JSON.stringify({ type: 'initializing' }));
    this._adminEventSubject.next(JSON.stringify({ type: 'reset_complete', timestamp: new Date().toISOString() }));
    await new Promise<void>((r) => setTimeout(r, POST_RESET_DELAY_MS));
    setImmediate(() => this.initClient().catch((e) =>
      this.logger.error('[WA_INIT] Post-reset init failed', e?.message),
    ));
  }

  // ── Private helpers ───────────────────────────────────────────────────────────

  /** Single authoritative state transition. Logs and broadcasts on both SSE channels. */
  private transitionState(next: WaState): void {
    const prev = this._waState;
    if (prev === next) return;
    this._waState = next;
    this.logger.log(`[WA_STATE] ${prev} → ${next}`);
    const payload = JSON.stringify({ type: 'state_change', state: next, prev, timestamp: new Date().toISOString() });
    this.qrSubject.next(payload);
    this._adminEventSubject.next(payload);
  }

  private getAuthRootDir(): string {
    return path.join(process.cwd(), WA_AUTH_DATA_PATH);
  }

  private getSessionDir(): string {
    return path.join(this.getAuthRootDir(), `session-${WA_LOCAL_AUTH_CLIENT_ID}`);
  }

  private removeSingletonFiles(sessionDir: string): void {
    if (!fs.existsSync(sessionDir)) return;
    for (const file of CHROMIUM_LOCK_FILES) {
      const filePath = path.join(sessionDir, file);
      try {
        fs.unlinkSync(filePath);
        this.logger.log(`[WA_INIT] Removed stale lock file: ${file}`);
      } catch { /* file absent — ok */ }
    }
  }

  /** Clears LocalAuth credentials. Called ONLY by user-initiated reset actions — NEVER automatically. */
  private async clearAuthFiles(): Promise<void> {
    const sessionDir = this.getSessionDir();
    if (fs.existsSync(sessionDir)) {
      this.logger.log('[WA_RESET] Removing auth directory');
      await this.rmWithRetry(sessionDir);
    }
  }

  private async rmWithRetry(dirPath: string, maxAttempts = 3): Promise<void> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await fs.promises.rm(dirPath, { recursive: true, force: true });
        this.logger.log(`[WA_RESET] Removed: ${path.basename(dirPath)}`);
        return;
      } catch (e: any) {
        if (attempt < maxAttempts) {
          await new Promise<void>((r) => setTimeout(r, 1_000));
        } else {
          this.logger.error(`[WA_RESET] Failed to remove ${dirPath}: ${e?.message}`);
        }
      }
    }
  }

  private async safeEval<T>(fn: () => Promise<T>, retriesLeft = 1): Promise<T> {
    try {
      return await fn();
    } catch (e: any) {
      const msg: string = e?.message ?? '';
      const isContextError =
        msg.includes('Execution context was destroyed') ||
        msg.includes('Cannot find context with specified id');
      if (isContextError && retriesLeft > 0) {
        this.logger.warn('[WA_EVAL] Execution context destroyed — retrying in 500ms');
        await new Promise<void>((r) => setTimeout(r, 500));
        return this.safeEval(fn, retriesLeft - 1);
      }
      throw e;
    }
  }

  private findChrome(): string | undefined {
    const CANDIDATES = [
      process.env.CHROME_PATH,                // explicit override — set in prod .env
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
    } catch { /* no bundled puppeteer Chrome */ }
    return undefined;
  }

  // Normalize multi-device chatIds: "919999999999:1@c.us" → "919999999999@c.us"
  private normalizeChatId(chatId: string): string {
    return chatId.replace(/:\d+(?=@)/, '');
  }

  private extractPhone(body: string): string | undefined {
    const matches = body.match(/\+?\d[\d\s-]{8,20}\d/g);
    if (!matches || matches.length === 0) return undefined;
    const validNumbers = matches
      .map(raw => raw.replace(/\D/g, ''))
      .filter(isValidWhatsAppPhone);
    if (validNumbers.length === 0) return undefined;
    validNumbers.sort((a, b) => b.length - a.length);
    const selected = validNumbers[0];
    const normalized = normalizePhone(selected);
    return normalized && normalized !== 'unknown' ? normalized : undefined;
  }

  private detectSource(body: string): LeadSource {
    const u = (body || '').toUpperCase();
    if (u.includes('META_LEAD') || u.includes('FB_LEAD') || u.includes('FACEBOOK')) return LeadSource.META;
    if (u.includes('GOOGLE_LEAD') || u.includes('GADS')) return LeadSource.GOOGLE;
    if (u.includes('INDIAMART')) return LeadSource.INDIAMART;
    return LeadSource.WHATSAPP;
  }

  private async handleInbound(msg: any): Promise<void> {
    const from: string = msg.from ?? '';
    if (from.endsWith('@g.us') || from === 'status@broadcast' || from.endsWith('@newsletter')) return;

    const chatId = this.normalizeChatId(from);
    const body: string = msg.body ?? '';
    const raw = chatId.split('@')[0];
    const phone = isValidWhatsAppPhone(raw) ? normalizePhone(raw) : undefined;
    this.logger.log(`Inbound chatId=${chatId} phone=${phone ?? 'unknown'} body="${body.slice(0, 50)}"`);

    const savedMsg = await this.messageRepo.save(
      this.messageRepo.create({
        chat_id: chatId,
        direction: 'INBOUND',
        body,
        timestamp: new Date(msg.timestamp * 1000),
        is_read: false,
      }),
    );

    // Production command intercept: DONE/ISSUE/HOLD <jobId>
    if (phone && /^(DONE|ISSUE|HOLD) \d+$/i.test(body.trim())) {
      this.eventEmitter.emit('whatsapp.command', { phone, body: body.trim().toUpperCase() });
      return;
    }

    const existing = await this.messageRepo.manager.query(
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
          this.logger.log({ action: 'PHONE_EXTRACTED_FROM_CHAT', leadId: existing[0].id, phone: extracted });
        }
      }

      const trimmedBody = body.trim();
      await this.messageRepo.manager.query(
        `UPDATE leads SET last_customer_reply_at = NOW() WHERE id = $1`,
        [existing[0].id],
      );

      // STOP opt-out: add automation_off tag
      if (/^(stop|unsubscribe|opt.?out)$/i.test(trimmedBody)) {
        await this.messageRepo.manager.query(
          `UPDATE leads
           SET tags = COALESCE(tags, '[]'::jsonb) || '["automation_off"]'::jsonb
           WHERE id = $1
             AND NOT ('automation_off' = ANY(COALESCE(tags, '[]'::jsonb)))`,
          [existing[0].id],
        );
        this.logger.log({ action: 'OPT_OUT', leadId: existing[0].id });
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

    const contact = await msg.getContact().catch(() => null);
    const name = contact?.pushname || contact?.name || raw || 'Unknown';
    const hash = crypto.createHash('sha256').update(`${from}-${body || ''}`).digest('hex');
    const hasSerializedId = !!msg.id?._serialized;
    const messageId: string = msg.id?._serialized || hash;
    this.logger.log({ action: 'WHATSAPP_EVENT_RECEIVED', phone, messageId, hasSerializedId });

    this.eventEmitter.emit('whatsapp.message.received', {
      phone: phone ?? raw,
      body: body.slice(0, 1000),
      chatId: from,
      name: (msg as any)?.notifyName ?? undefined,
    });

    this.eventEmitter.emit('lead.incoming', {
      phone,
      name,
      source: LeadSource.WHATSAPP,
      whatsapp_chat_id: chatId,
      messageId,
      hasSerializedId,
      product_interest: body || '',
      context: 'WHATSAPP – Inbound',
      raw_payload: { chatId, body, timestamp: msg.timestamp },
    });
  }

  private async recoverMissedMessages(): Promise<void> {
    if (this._recovering || !this.isConnected()) return;
    this._recovering = true;
    try {
      this.logger.log('[WA_RECOVERY] Starting missed-message scan');
      const cutoff = Date.now() - 30 * 60 * 1000;
      const chats: any[] = await this.client.getChats();
      const dmChats = chats.filter((c: any) => !c.isGroup).slice(0, 20);
      for (const chat of dmChats) {
        if (!this.isConnected()) break;
        let msgs: any[];
        try {
          msgs = await chat.fetchMessages({ limit: 10 });
        } catch (e: any) {
          this.logger.warn(`[WA_RECOVERY] Could not fetch ${chat.id?._serialized}: ${e?.message}`);
          continue;
        }
        for (const msg of msgs) {
          if (msg.fromMe || (msg.timestamp * 1000) < cutoff) continue;
          const msgId: string = msg.id?._serialized ?? `${msg.from}-${msg.timestamp}`;
          if (this.seenMsgIds.has(msgId)) continue;
          this.seenMsgIds.add(msgId);
          if (this.seenMsgIds.size > 500) {
            const first = this.seenMsgIds.values().next().value;
            this.seenMsgIds.delete(first);
          }
          try { await this.handleInbound(msg); } catch (e: any) {
            this.logger.warn(`[WA_RECOVERY] handleInbound failed for ${msgId}: ${e?.message}`);
          }
        }
      }
      this.logger.log('[WA_RECOVERY] Scan complete');
    } catch (e: any) {
      this.logger.warn(`[WA_RECOVERY] Scan failed: ${e?.message}`);
    } finally {
      this._recovering = false;
    }
  }

  private async updateSession(data: Partial<WhatsAppSession>): Promise<void> {
    try {
      let row = await this.sessionRepo.findOne({ where: { session_name: this.sessionName } });
      if (!row) row = this.sessionRepo.create({ session_name: this.sessionName });
      Object.assign(row, data, { last_active_at: new Date() });
      await this.sessionRepo.save(row);
    } catch (e: any) {
      // DB unavailable — WA session continues in memory; DB will catch up on next call.
      this.logger.warn(`[WA_DB_WARN] updateSession failed — WA stays running: ${e?.message}`);
    }
  }
}
