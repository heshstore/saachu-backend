import { Injectable, OnModuleInit, OnModuleDestroy, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as fs from 'fs';
import * as path from 'path';
import { ReplaySubject, Observable, interval, merge } from 'rxjs';
import { map } from 'rxjs/operators';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { WhatsappNumber } from './entities/whatsapp-number.entity';
import { EngineAutoPauseService } from './engine/engine-auto-pause.service';

const WA_AUTH_DATA_PATH  = '.wwebjs_auth_marketing';
const WATCHDOG_MS        = 60_000;
const BOOT_TIMEOUT_MS    = 60_000;
const AUTH_TIMEOUT_MS    = 120_000;
const RECONNECT_DELAY_MS = 10_000;

const CHROMIUM_LOCK_FILES = [
  'SingletonLock', 'SingletonSocket', 'SingletonCookie', 'DevToolsActivePort',
] as const;

// Telemarketing lifecycle states.
// QR_READY is a WAITING-FOR-HUMAN state — never trigger reconnect while here.
// Auto-reconnect is only allowed for sessions that previously reached READY.
type WaState =
  | 'idle'           // Never connected, or explicitly disconnected by user
  | 'booting'        // Chromium launching — between Connect click and first WA event
  | 'qr_ready'       // QR displayed, waiting for user scan (indefinite wait)
  | 'authenticating' // QR scanned, WhatsApp establishing session
  | 'ready'          // Session active — can send messages
  | 'reconnecting'   // Was ready, lost connection, auto-recovering
  | 'disconnected'   // Was ready, now disconnected — user action needed
  | 'failed';        // auth_failure or Chromium boot failure — Reset required

interface NumberClientState {
  client: any;
  waState: WaState;
  // Hard lock: true exactly while initialize() is running; prevents double-launch.
  starting: boolean;
  manualDisconnect: boolean;
  destroyed: boolean;
  retryTimer: ReturnType<typeof setTimeout> | null;
  // 120s window between authenticated → ready; cleared on ready or auth_failure.
  authTimeoutId: ReturnType<typeof setTimeout> | null;
  watchdogTimer: ReturnType<typeof setInterval> | null;
  // Updated on every WA event — proves Chromium is alive.
  lastHeartbeat: Date | null;
  // Never completed — lives for the lifetime of the number so SSE subscribers survive reconnects.
  qrSubject: ReplaySubject<string>;
  qrDataUrl: string | null;
  qrGeneratedAt: Date | null;
  disconnectedAt: Date | null;
  lastReadyAt: Date | null;
}

function makeState(): NumberClientState {
  return {
    client: null,
    waState: 'idle',
    starting: false,
    manualDisconnect: false,
    destroyed: false,
    retryTimer: null,
    authTimeoutId: null,
    watchdogTimer: null,
    lastHeartbeat: null,
    qrSubject: new ReplaySubject<string>(1),
    qrDataUrl: null,
    qrGeneratedAt: null,
    disconnectedAt: null,
    lastReadyAt: null,
  };
}

@Injectable()
export class MarketingWhatsAppService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MarketingWhatsAppService.name);
  private readonly clients = new Map<string, NumberClientState>();
  // Sequential init lock — only one Chromium launch at a time.
  // Prevents simultaneous initialize() calls from destabilizing Puppeteer + Neon.
  private _initQueue: Promise<void> = Promise.resolve();

  constructor(
    @InjectRepository(WhatsappNumber)
    private readonly numberRepo: Repository<WhatsappNumber>,
    @Optional() private readonly eventEmitter: EventEmitter2,
    @Optional() private readonly _autoPause: EngineAutoPauseService,
  ) {}

  async onModuleInit() {
    console.log('[BUILD_INFO]', {
      file: __filename,
      cwd: process.cwd(),
      pid: process.pid,
      timestamp: new Date().toISOString(),
    });

    // Telemarketing sessions are MANUAL-ONLY — no auto-startup.
    // Sessions are initiated exclusively via the Connect button in the UI.
    // On startup, all DB states are cleared to null so the UI shows idle/Connect for every number.
    let rows: WhatsappNumber[] = [];
    try {
      rows = await this.numberRepo.find();
    } catch (e: any) {
      this.logger.warn(`[MKT_WA] Startup — could not load numbers: ${e?.message}`);
      return;
    }

    const toReset = rows.filter((n) => n.wa_state !== null);
    if (toReset.length > 0) {
      this.logger.warn(`[MKT_WA] Startup — clearing ${toReset.length} stale DB state(s) → null (idle)`);
      for (const num of toReset) {
        this.logger.warn(`[MKT_WA] Stale: ${num.id} (${num.phone}) ${num.wa_state} → null`);
        try { await this.numberRepo.update(num.id, { wa_state: null }); } catch { /* non-fatal */ }
      }
    }

    this.logger.log(`[MKT_WA] Startup complete — ${rows.length} number(s) available. Use Connect in UI to start a session.`);
  }

  async onModuleDestroy() {
    this.logger.log('[MKT_WA] Shutdown — destroying all clients');
    const shutdowns: Promise<void>[] = [];
    for (const [id, state] of this.clients) {
      state.destroyed = true;
      this._clearTimers(state);
      shutdowns.push(this._destroyClient(id, state));
    }
    await Promise.allSettled(shutdowns);
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  async connectNumber(numberId: string): Promise<void> {
    let state = this.clients.get(numberId);
    if (!state) {
      state = makeState();
      this.clients.set(numberId, state);
      this._startWatchdog(numberId, state);
    }
    if (state.destroyed) return;
    if (state.starting || state.client) {
      this.logger.log(`[MKT_WA:${numberId}] connect skipped — already starting or client exists`);
      return;
    }

    state.starting = true;
    this._transitionState(numberId, state, 'booting');
    await this._updateNumberWaState(numberId, 'booting');

    this.logger.log(`[WA_LOCK] ${numberId} — queued for init lock`);
    try {
      await this._withInitLock(numberId, () => this._initClient(numberId, state!));
    } catch (e: any) {
      this.logger.error(`[MKT_WA:${numberId}] Init error: ${e?.message}`);
      state.qrSubject.next(JSON.stringify({ type: 'error', message: `Init failed: ${e?.message}` }));
      this._transitionState(numberId, state, 'failed');
      await this._updateNumberWaState(numberId, 'failed');
    } finally {
      state.starting = false;
    }
  }

  async disconnectNumber(numberId: string): Promise<void> {
    const state = this.clients.get(numberId);
    if (!state) return;
    this.logger.log(`[NUMBER_DISCONNECTED] ${numberId}`);
    state.manualDisconnect = true;
    this._clearTimers(state);
    await this._destroyClient(numberId, state);
    state.qrDataUrl = null;
    state.qrGeneratedAt = null;
    state.lastReadyAt = null; // reset so next connect starts fresh
    state.manualDisconnect = false;
    this._transitionState(numberId, state, 'idle');
    await this._updateNumberWaState(numberId, null);
  }

  /**
   * RECOVERY UTIL — resets volatile wa_state in DB for every number to null.
   * Does NOT destroy running clients. Call disconnect/:id/connect per number to
   * restart cleanly after this.
   */
  async resetAllConnectionStates(): Promise<{ affected: number; skipped: number; ids: string[] }> {
    let rows: WhatsappNumber[] = [];
    try {
      rows = await this.numberRepo.find();
    } catch (e: any) {
      this.logger.error(`[RECOVERY] Could not load numbers: ${e?.message}`);
      throw e;
    }

    this.logger.log(`[RECOVERY] Starting state reset — ${rows.length} number(s) found`);
    for (const num of rows) {
      this.logger.log(`[RECOVERY] Before: id=${num.id} phone=${num.phone} wa_state=${num.wa_state ?? 'null'}`);
    }

    const ids: string[] = [];
    let skipped = 0;
    for (const num of rows) {
      try {
        await this.numberRepo.update(num.id, { wa_state: null });
        ids.push(num.id);
        this.logger.log(`[RECOVERY] Reset: ${num.id} (${num.phone}) ${num.wa_state ?? 'null'} → null`);
      } catch (e: any) {
        this.logger.error(`[RECOVERY] Failed to reset ${num.id}: ${e?.message}`);
        skipped++;
      }
    }

    this.logger.log(`[RECOVERY] Complete — ${ids.length} reset, ${skipped} skipped`);
    return { affected: ids.length, skipped, ids };
  }

  /**
   * HARD RESET — destroys client, removes from memory map, wipes full LocalAuth session dir,
   * and resets DB state to null. Use for corrupted sessions (lock files, bad state).
   * After calling this, use POST /:id/connect to start fresh.
   */
  async hardResetSession(numberId: string): Promise<{ ok: boolean; message: string }> {
    this.logger.log(`[HARD_RESET] Starting hard reset for ${numberId}`);

    const state = this.clients.get(numberId);
    if (state) {
      state.manualDisconnect = true;
      state.starting = false;
      this._clearTimers(state);
      state.qrDataUrl = null;
      state.qrGeneratedAt = null;
      if (state.client) {
        this.logger.log(`[HARD_RESET] Logging out client for ${numberId}`);
        try { await state.client.logout(); } catch { /* already gone */ }
      }
      await this._destroyClient(numberId, state);
    }

    // Remove from map entirely — next connectNumber() gets a brand new state object
    this.clients.delete(numberId);
    this.logger.log(`[HARD_RESET] Removed ${numberId} from clients map`);

    // Wipe full LocalAuth session directory (removes all Chromium profile + WA session data)
    const sessionDir = this._getSessionDir(numberId);
    this.logger.log(`[HARD_RESET] Auth dir: ${sessionDir} exists=${fs.existsSync(sessionDir)}`);
    await this._clearAuthFiles(numberId);
    this.logger.log(`[HARD_RESET] Auth dir wiped for ${numberId}`);

    // Reset DB state to null — clean slate
    try {
      await this.numberRepo.update(numberId, { wa_state: null });
      this.logger.log(`[HARD_RESET] DB wa_state reset to null for ${numberId}`);
    } catch (e: any) {
      this.logger.warn(`[HARD_RESET] DB reset failed (non-fatal): ${e?.message}`);
    }

    this.logger.log(`[HARD_RESET] Complete for ${numberId} — call /connect to re-pair`);
    return { ok: true, message: `Hard reset complete for ${numberId}. Call /connect to generate a fresh QR.` };
  }

  async resetNumber(numberId: string): Promise<void> {
    const state = this.clients.get(numberId);
    if (state?.starting) {
      this.logger.log(`[MKT_WA:${numberId}] reset skipped — starting`);
      return;
    }
    this.logger.log(`[MKT_WA:${numberId}] Session reset — wiping auth`);
    if (state) {
      state.manualDisconnect = true;
      this._clearTimers(state);
      if (state.client) {
        try { await state.client.logout(); } catch { /* already gone */ }
      }
      await this._destroyClient(numberId, state);
      state.qrDataUrl = null;
      state.qrGeneratedAt = null;
      state.manualDisconnect = false;
    }
    await this._clearAuthFiles(numberId);
    await new Promise<void>((r) => setTimeout(r, 2_000));
    setImmediate(() => this.connectNumber(numberId).catch((e) =>
      this.logger.error(`[MKT_WA:${numberId}] Post-reset connect failed: ${e?.message}`),
    ));
  }

  /** True if the specific number's WA client is live, browser open, and session ready. */
  isConnected(numberId: string): boolean {
    const state = this.clients.get(numberId);
    if (state?.waState !== 'ready' || !state.client || state.destroyed) return false;
    const page = state.client.pupPage;
    return page != null && !page.isClosed();
  }

  /** True if at least one number is connected. */
  isAnyConnected(): boolean {
    for (const [id] of this.clients) {
      if (this.isConnected(id)) return true;
    }
    return false;
  }

  /**
   * Send a message via a specific number's WA client.
   * Hard safety: verifies browser + session health before every send.
   */
  async sendViaNumber(numberId: string, phone: string, body: string): Promise<void> {
    const state = this.clients.get(numberId);

    if (!state || state.destroyed) {
      throw new Error(`[SEND_SKIPPED] ${numberId} — no client state`);
    }
    if (state.starting) {
      throw new Error(`[SEND_SKIPPED] ${numberId} — reconnecting`);
    }
    if (state.waState !== 'ready' || !state.client) {
      throw new Error(`[SEND_SKIPPED] ${numberId} — not ready`);
    }

    const page = state.client.pupPage;
    const browserAlive = state.client.pupBrowser?.isConnected?.() ?? false;
    const pageOpen = page != null && !page.isClosed();
    if (!browserAlive || !pageOpen) {
      this.logger.warn(`[SEND_SKIPPED] ${numberId} — browser unhealthy, triggering recovery`);
      this._scheduleReconnect(numberId, state);
      throw new Error(`[SEND_SKIPPED] ${numberId} — browser unhealthy`);
    }

    await this._safeEval(numberId, state, () =>
      state.client.sendMessage(`${phone}@c.us`, body),
    );
  }

  getQrObservable(numberId: string): Observable<any> {
    const state = this._getOrCreateState(numberId);
    return merge(
      state.qrSubject.asObservable().pipe(map((json) => ({ data: JSON.parse(json) }))),
      interval(30_000).pipe(map(() => ({ data: { type: 'ping' } }))),
    );
  }

  getQrData(numberId: string): { active: boolean; qr: string | null; generatedAt: string | null } {
    const state = this.clients.get(numberId);
    const qrReady = state?.waState === 'qr_ready';
    const result = {
      active:      qrReady,
      qr:          qrReady ? (state!.qrDataUrl ?? null) : null,
      generatedAt: qrReady ? (state!.qrGeneratedAt?.toISOString() ?? null) : null,
    };
    this.logger.log(`[QR_PIPELINE] stage=api_response id=${numberId} active=${result.active} qrLength=${result.qr?.length ?? 0}`);
    return result;
  }

  getNumberWaStatus(numberId: string): {
    waState: WaState;
    connected: boolean;
    booting: boolean;
    qrActive: boolean;
    lastHeartbeat: string | null;
    lastReadyAt: string | null;
    disconnectedAt: string | null;
  } {
    const state = this.clients.get(numberId);
    if (!state) {
      return {
        waState: 'idle', connected: false, booting: false,
        qrActive: false, lastHeartbeat: null, lastReadyAt: null, disconnectedAt: null,
      };
    }
    return {
      waState:        state.waState,
      connected:      this.isConnected(numberId),
      booting:        state.waState === 'booting',
      qrActive:       state.waState === 'qr_ready',
      lastHeartbeat:  state.lastHeartbeat?.toISOString() ?? null,
      lastReadyAt:    state.lastReadyAt?.toISOString() ?? null,
      disconnectedAt: state.disconnectedAt?.toISOString() ?? null,
    };
  }

  getOverallStatus(): { connected_count: number; total_clients: number } {
    let connected = 0;
    for (const [id] of this.clients) {
      if (this.isConnected(id)) connected++;
    }
    return { connected_count: connected, total_clients: this.clients.size };
  }

  // ── Reconnect ────────────────────────────────────────────────────────────────

  private _scheduleReconnect(numberId: string, state: NumberClientState): void {
    if (state.destroyed || state.manualDisconnect) return;
    if (state.retryTimer) return; // already scheduled
    // Telemarketing policy: auto-reconnect ONLY for sessions that previously reached ready.
    // Sessions that never authenticated (QR phase, boot failure) return to idle.
    if (state.lastReadyAt === null) {
      this.logger.warn(`[WA_RECONNECT] ${numberId} — skip, session never reached ready → returning to idle`);
      this._transitionState(numberId, state, 'idle');
      this._updateNumberWaState(numberId, null);
      return;
    }

    this.logger.log(`[RECONNECT] ${numberId} — scheduling in ${RECONNECT_DELAY_MS / 1000}s`);
    this._transitionState(numberId, state, 'reconnecting');

    state.retryTimer = setTimeout(async () => {
      state.retryTimer = null;
      if (state.destroyed || state.manualDisconnect) return;

      await this._destroyClient(numberId, state);
      state.starting = true;
      try {
        await this._withInitLock(numberId, () => this._initClient(numberId, state));
      } catch (e: any) {
        this.logger.error(`[RECONNECT] ${numberId} — attempt failed: ${e?.message}`);
        state.qrSubject.next(JSON.stringify({ type: 'error', message: `Reconnect failed: ${e?.message}` }));
        this._transitionState(numberId, state, 'disconnected');
        await this._updateNumberWaState(numberId, 'disconnected');
      } finally {
        state.starting = false;
      }
    }, RECONNECT_DELAY_MS);
  }

  // ── Client health watchdog ───────────────────────────────────────────────────

  private _startWatchdog(numberId: string, state: NumberClientState): void {
    if (state.watchdogTimer) return; // already running

    state.watchdogTimer = setInterval(() => {
      if (state.destroyed) {
        clearInterval(state.watchdogTimer!);
        state.watchdogTimer = null;
        return;
      }
      // Only check browser health when we expect the session to be live
      if (state.waState !== 'ready') return;

      const browserAlive = state.client?.pupBrowser?.isConnected?.() ?? false;
      const page = state.client?.pupPage;
      if (!browserAlive || page == null || page.isClosed()) {
        this.logger.warn(`[WATCHDOG] ${numberId} — unhealthy while ready`);
        this._scheduleReconnect(numberId, state);
      }
    }, WATCHDOG_MS);
  }

  // ── Core init per number ─────────────────────────────────────────────────────

  private async _initClient(numberId: string, state: NumberClientState): Promise<void> {
    // Clean teardown before creating a new client — safe no-op if client is already null
    await this._destroyClient(numberId, state);

    // Wire puppeteer-extra stealth into wwebjs require cache (idempotent)
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const puppeteerExtra = require('puppeteer-extra');
      const stealthKey = `_mktStealth`;
      if (!puppeteerExtra[stealthKey]) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        puppeteerExtra.use(require('puppeteer-extra-plugin-stealth')());
        puppeteerExtra[stealthKey] = true;
      }
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const wwebjsDir = require('path').dirname(require.resolve('whatsapp-web.js'));
      const wwebjsPuppeteerKey = require.resolve('puppeteer', { paths: [wwebjsDir] });
      const cache = (require as any).cache as Record<string, any>;
      const extraModule = cache[require.resolve('puppeteer-extra')];
      if (extraModule) cache[wwebjsPuppeteerKey] = extraModule;
    } catch { /* stealth unavailable — non-fatal */ }

    let Client: any, LocalAuth: any;
    try {
      const wwebjs = await import('whatsapp-web.js');
      Client = wwebjs.Client;
      LocalAuth = wwebjs.LocalAuth;
    } catch (e: any) {
      throw new Error(`whatsapp-web.js unavailable: ${e?.message}`);
    }

    const executablePath = this._findChrome();
    this.logger.log(`[WA_CHROME] executablePath=${executablePath ?? '(none — will use bundled)'}`);
    const chromeExists = executablePath ? fs.existsSync(executablePath) : false;
    this.logger.log(`[WA_CHROME] exists=${executablePath ? chromeExists : 'n/a (bundled)'}`);
    if (executablePath && !chromeExists) {
      throw new Error(`[WA_CHROME] Chrome not found at ${executablePath} — aborting init`);
    }
    this._removeSingletonFiles(numberId);

    this.logger.log(`[WA_AUDIT] before_client_create — ${numberId} chrome=${executablePath ?? 'bundled'}`);
    state.client = new Client({
      authStrategy: new LocalAuth({
        clientId: `marketing-${numberId}`,
        dataPath: WA_AUTH_DATA_PATH,
      }),
      puppeteer: {
        headless: true,
        timeout: 120_000,
        ...(executablePath ? { executablePath } : {}),
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--no-first-run',
          '--no-zygote',
          '--single-process',
        ],
      },
      userAgent: false as unknown as string,
      webVersionCache: { type: 'none' },
    });
    this.logger.log(`[WA_AUDIT] after_client_create — ${numberId}`);

    // ── Event handlers ──────────────────────────────────────────────────────────

    // Heartbeat: updated on every WA event to prove Chromium is alive
    const beat = () => { state.lastHeartbeat = new Date(); };

    // Heartbeat-only listeners — do not alter state machine
    state.client.on('loading_screen', beat);
    state.client.on('change_state',   beat);

    state.client.on('qr', async (qr: string) => {
      beat();
      console.log('[QR_HANDLER_VERSION]', '2026-05-21-v3');
      console.log('[QR_HANDLER_ATTACHED]', numberId);
      console.log('[QR_DEBUG] entered_qr_handler', { id: numberId });
      this.logger.log(`[WA_EVENT] qr — ${numberId} length=${qr.length}`);
      console.log('[WA_QR_RAW]', { id: numberId, type: typeof qr, length: qr?.length, preview: qr?.slice?.(0, 80) });
      this.logger.log(`[QR_PIPELINE] stage=qr_event id=${numberId} rawLength=${qr?.length ?? 0}`);

      // If QR appears while a reconnect attempt is running (session had reached ready before),
      // clear lastReadyAt to prevent a QR-expire → reconnect → QR loop.
      if (state.lastReadyAt !== null) {
        this.logger.warn(`[QR] ${numberId} — QR during reconnect; clearing lastReadyAt to prevent reconnect loop`);
        state.lastReadyAt = null;
      }

      // qrcode@1.5.4 is pure CJS — (await import('qrcode')).default is undefined; require() gives the real module
      console.log('[QR_DEBUG] before_qrcode_import');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const QRCode = require('qrcode');
      console.log('[QR_DEBUG] after_qrcode_import', { type: typeof QRCode, hasToDataURL: typeof QRCode?.toDataURL });

      const qrInput = process.env.WA_QR_TEST_MODE === 'true' ? 'HELLO_TEST_QR' : qr;
      if (process.env.WA_QR_TEST_MODE === 'true') {
        console.log('[QR_DEBUG] test_mode_active — using static test input');
      }

      let dataUrl: string;
      try {
        console.log('[QR_DEBUG] before_toDataURL');
        dataUrl = await QRCode.toDataURL(qrInput, { width: 300 });
        console.log('[QR_DEBUG] after_toDataURL', { length: dataUrl?.length });
      } catch (e: any) {
        this.logger.error(`[QR_PIPELINE] stage=toDataURL_failed id=${numberId}: ${e?.message}`);
        console.log('[QR_DEBUG] toDataURL_error', { message: (e as any)?.message });
        return;
      }
      this.logger.log(`[QR_PIPELINE] stage=toDataURL id=${numberId} dataUrlLength=${dataUrl?.length ?? 0}`);

      this._transitionState(numberId, state, 'qr_ready');
      state.qrDataUrl = dataUrl;
      state.qrGeneratedAt = new Date();
      this.logger.log(`[QR_PIPELINE] stage=state_set id=${numberId} dataUrlLength=${dataUrl?.length ?? 0}`);
      state.qrSubject.next(JSON.stringify({ type: 'qr', dataUrl, timestamp: new Date().toISOString() }));
      this.logger.log(`[QR_PIPELINE] stage=emitted id=${numberId}`);
      await this._updateNumberWaState(numberId, 'qr_ready');
    });

    state.client.on('authenticated', () => {
      beat();
      this.logger.log(`[WA_EVENT] authenticated — ${numberId}`);
      this._transitionState(numberId, state, 'authenticating');
      state.qrDataUrl = null;
      state.qrGeneratedAt = null;
      state.qrSubject.next(JSON.stringify({ type: 'authenticated', timestamp: new Date().toISOString() }));

      // 120s window: if ready doesn't fire within AUTH_TIMEOUT_MS, mark failed
      if (state.authTimeoutId) { clearTimeout(state.authTimeoutId); }
      state.authTimeoutId = setTimeout(() => {
        state.authTimeoutId = null;
        if (state.waState === 'authenticating' && !state.destroyed && !state.manualDisconnect) {
          this.logger.warn(`[AUTH_TIMEOUT] ${numberId} — ${AUTH_TIMEOUT_MS / 1000}s elapsed after authenticated without ready`);
          this._transitionState(numberId, state, 'failed');
          this._updateNumberWaState(numberId, 'failed');
        }
      }, AUTH_TIMEOUT_MS);
    });

    state.client.on('remote_session_saved', () => { /* session persisted to disk */ });

    state.client.on('ready', async () => {
      beat();
      if (state.authTimeoutId) { clearTimeout(state.authTimeoutId); state.authTimeoutId = null; }
      this.logger.log(`[WA_EVENT] ready — ${numberId}`);
      if (state.waState === 'ready') return;
      state.qrDataUrl = null;
      state.qrGeneratedAt = null;
      if (state.disconnectedAt) state.disconnectedAt = null;
      state.lastReadyAt = new Date();
      this._transitionState(numberId, state, 'ready');
      const phone = state.client?.info?.wid?.user ?? null;
      this.logger.log(`[NUMBER_CONNECTED] ${numberId} (+${phone})`);
      state.qrSubject.next(JSON.stringify({ type: 'ready', phone, timestamp: new Date().toISOString() }));
      await this._updateNumberConnected(numberId);
    });

    state.client.on('disconnected', async (reason: string) => {
      beat();
      if (reason === 'NAVIGATION') return; // internal WA page transition — ignore
      if (state.authTimeoutId) { clearTimeout(state.authTimeoutId); state.authTimeoutId = null; }
      if (!state.disconnectedAt) state.disconnectedAt = new Date();
      this.logger.log(`[NUMBER_DISCONNECTED] ${numberId} reason=${reason} hadReady=${state.lastReadyAt !== null}`);

      const hadReadySession = state.lastReadyAt !== null;

      if (!hadReadySession) {
        // Never authenticated — QR expired or boot failed; return to idle, no reconnect
        state.qrDataUrl = null;
        state.qrGeneratedAt = null;
        state.qrSubject.next(JSON.stringify({ type: 'disconnected', reason, timestamp: new Date().toISOString() }));
        this._transitionState(numberId, state, 'idle');
        await this._updateNumberWaState(numberId, null);
        return;
      }

      // Was previously ready — attempt auto-recovery
      this._transitionState(numberId, state, 'disconnected');
      state.qrSubject.next(JSON.stringify({ type: 'disconnected', reason, timestamp: new Date().toISOString() }));
      await this._updateNumberWaState(numberId, 'disconnected');
      if (!state.manualDisconnect && !state.destroyed) {
        this._autoPause?.recordDisconnect();
        this._scheduleReconnect(numberId, state);
      }
    });

    state.client.on('auth_failure', async (msg: string) => {
      beat();
      if (state.authTimeoutId) { clearTimeout(state.authTimeoutId); state.authTimeoutId = null; }
      state.qrDataUrl = null;
      state.qrGeneratedAt = null;
      if (!state.disconnectedAt) state.disconnectedAt = new Date();
      this._transitionState(numberId, state, 'failed');
      state.qrSubject.next(JSON.stringify({
        type: 'error',
        message: 'Auth failed — use Reset to re-pair.',
        timestamp: new Date().toISOString(),
      }));
      await this._updateNumberWaState(numberId, 'failed');
      // Auth failure requires user action (Reset + re-scan) — no auto-reconnect
      this.logger.warn(`[MKT_WA:${numberId}] Auth failure: ${msg}`);
    });

    // Inbound message handler — marketing number recipients replying to campaigns
    state.client.on('message', async (msg: any) => {
      beat();
      if (msg.fromMe) return;
      const from: string = msg.from ?? '';
      if (from.endsWith('@g.us') || from === 'status@broadcast' || from.endsWith('@newsletter')) return;
      const chatId = from.replace(/:\d+(?=@)/, '');
      const phone = chatId.split('@')[0];
      const body: string = msg.body ?? '';
      this.logger.log(`[MKT_WA_INBOUND] ${numberId} from=${phone} len=${body.length}`);
      this.eventEmitter?.emit('marketing.whatsapp.message.received', {
        phone,
        body,
        chatId: from,
        name: (msg as any)?.notifyName ?? undefined,
        numberId,
      });
    });

    // ── initialize() — release init lock on first event, NOT on ready ─────────
    // initialize() stays pending while user scans QR. QR_READY is a valid stable state.
    // We only abort if Chromium fails to produce any event within BOOT_TIMEOUT_MS.
    // After the first event, initialize() runs indefinitely; events drive the state machine.
    const initStart = Date.now();
    this.logger.log(`[WA_INIT] initialize start — ${numberId}`);

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let bootTimeoutId: ReturnType<typeof setTimeout> | null = null;

      const settle = (err?: Error) => {
        if (settled) return;
        settled = true;
        if (bootTimeoutId) { clearTimeout(bootTimeoutId); bootTimeoutId = null; }
        if (err) reject(err); else resolve();
      };

      // Release init lock the moment any WA event fires — client runs autonomously after this
      const onFirstEvent = () => {
        this.logger.log(`[WA_INIT] first event received — init lock releasing — ${numberId} (${Date.now() - initStart}ms)`);
        settle();
      };
      state.client.once('qr', onFirstEvent);
      state.client.once('authenticated', onFirstEvent);
      state.client.once('ready', onFirstEvent);
      state.client.once('auth_failure', onFirstEvent);

      // Hard abort only if Chromium boots but produces no event at all
      bootTimeoutId = setTimeout(() => {
        settle(new Error(`Chromium boot timeout — no WA event in ${BOOT_TIMEOUT_MS / 1000}s`));
      }, BOOT_TIMEOUT_MS);

      // Start Chromium — runs indefinitely in background after init lock releases
      state.client.initialize()
        .then(() => {
          this.logger.log(`[WA_INIT] initialize resolved — ${numberId} (${Date.now() - initStart}ms)`);
          settle();
        })
        .catch((e: any) => {
          this.logger.error(`[WA_INIT] initialize rejected — ${numberId}: ${e?.message}`);
          if (!settled) {
            // No event received yet — Chromium boot genuinely failed
            settle(e instanceof Error ? e : new Error(String(e?.message ?? 'Unknown')));
          } else {
            // First event was already received; post-QR crash — let disconnect events recover
            this.logger.warn(`[WA_INIT] late rejection after first event — ${numberId} — recovery via disconnect events`);
            if (!state.manualDisconnect && !state.destroyed) {
              this._scheduleReconnect(numberId, state);
            }
          }
        });
    });

    this.logger.log(`[WA_INIT] init lock released — ${numberId} — client live, awaiting user action`);

    // ── Chromium disconnect detection ─────────────────────────────────────────
    // pupBrowser is available after first event (Chromium is running at this point)
    const pupBrowser = state.client?.pupBrowser;
    if (pupBrowser) {
      pupBrowser.once('disconnected', () => {
        this.logger.warn(`[WA_CHROME] browser disconnected — ${numberId} — hadReady=${state.lastReadyAt !== null}`);
        const hadReadySession = state.lastReadyAt !== null;
        state.starting = false;
        state.qrDataUrl = null;
        state.qrGeneratedAt = null;
        if (!state.manualDisconnect && !state.destroyed) {
          const staleClient = state.client;
          state.client = null;
          state.lastHeartbeat = null;
          if (staleClient) staleClient.destroy().catch(() => { /* already dead */ });
          if (hadReadySession) {
            this._scheduleReconnect(numberId, state);
          } else {
            this._transitionState(numberId, state, 'idle');
            this._updateNumberWaState(numberId, null);
          }
        }
      });
      this.logger.log(`[WA_CHROME] browser disconnect listener attached — ${numberId}`);
    } else {
      this.logger.warn(`[WA_CHROME] pupBrowser not yet available — ${numberId} — disconnect detection via events only`);
    }
  }

  // ── Private helpers ───────────────────────────────────────────────────────────

  // ── Sequential init lock ─────────────────────────────────────────────────────
  // Ensures only one Chromium process is launching at a time. Additional inits queue
  // and execute in order once the current one resolves or rejects.
  private _withInitLock(numberId: string, fn: () => Promise<void>): Promise<void> {
    let resolveSlot!: () => void;
    const slot = new Promise<void>((r) => { resolveSlot = r; });
    const previous = this._initQueue;
    this._initQueue = slot;
    return previous.then(async () => {
      this.logger.log(`[WA_LOCK] ${numberId} — acquired init lock`);
      try {
        await fn();
      } finally {
        this.logger.log(`[WA_LOCK] ${numberId} — released init lock`);
        resolveSlot();
      }
    });
  }

  // Destroys a client and nulls refs — safe to call when client is already null.
  private async _destroyClient(numberId: string, state: NumberClientState): Promise<void> {
    const client = state.client;
    if (!client) return;
    state.client = null;
    state.lastHeartbeat = null;
    this.logger.log(`[TEARDOWN] ${numberId} — removing listeners and destroying client`);
    try { client.removeAllListeners(); } catch { }
    try { await client.destroy(); } catch { }
  }

  private _getOrCreateState(numberId: string): NumberClientState {
    if (!this.clients.has(numberId)) {
      const state = makeState();
      this.clients.set(numberId, state);
      this._startWatchdog(numberId, state);
    }
    return this.clients.get(numberId)!;
  }

  private _transitionState(numberId: string, state: NumberClientState, next: WaState): void {
    const prev = state.waState;
    if (prev === next) return;
    state.waState = next;
    state.qrSubject.next(JSON.stringify({ type: 'state_change', state: next, prev, timestamp: new Date().toISOString() }));
  }

  private _clearTimers(state: NumberClientState): void {
    if (state.retryTimer) {
      clearTimeout(state.retryTimer);
      state.retryTimer = null;
    }
    if (state.authTimeoutId) {
      clearTimeout(state.authTimeoutId);
      state.authTimeoutId = null;
    }
    // Keep watchdog running — it monitors future reconnects too.
    // Only stop it on full destroy (handled in onModuleDestroy via state.destroyed flag).
  }

  private async _safeEval<T>(numberId: string, state: NumberClientState, fn: () => Promise<T>, retriesLeft = 1): Promise<T> {
    try {
      return await fn();
    } catch (e: any) {
      const msg: string = e?.message ?? '';
      const isContextError =
        msg.includes('Execution context was destroyed') ||
        msg.includes('Cannot find context with specified id');
      if (isContextError && retriesLeft > 0) {
        await new Promise<void>((r) => setTimeout(r, 500));
        return this._safeEval(numberId, state, fn, retriesLeft - 1);
      }
      throw e;
    }
  }

  private _getSessionDir(numberId: string): string {
    return path.join(process.cwd(), WA_AUTH_DATA_PATH, `session-marketing-${numberId}`);
  }

  private _removeSingletonFiles(numberId: string): void {
    const sessionDir = this._getSessionDir(numberId);
    if (!fs.existsSync(sessionDir)) return;
    for (const file of CHROMIUM_LOCK_FILES) {
      try { fs.unlinkSync(path.join(sessionDir, file)); } catch { /* absent — ok */ }
    }
  }

  private async _clearAuthFiles(numberId: string): Promise<void> {
    const sessionDir = this._getSessionDir(numberId);
    if (!fs.existsSync(sessionDir)) return;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await fs.promises.rm(sessionDir, { recursive: true, force: true });
        return;
      } catch (e: any) {
        if (attempt < 3) await new Promise<void>((r) => setTimeout(r, 1_000));
        else this.logger.error(`[MKT_WA:${numberId}] Could not remove auth dir: ${e?.message}`);
      }
    }
  }

  private _findChrome(): string | undefined {
    const candidates = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', // macOS — forced first
      process.env.CHROME_PATH,
      process.env.PUPPETEER_EXECUTABLE_PATH,
      '/usr/bin/google-chrome-stable',
      '/usr/bin/google-chrome',
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium',
      '/snap/bin/chromium',
    ];
    for (const p of candidates) {
      if (p && fs.existsSync(p)) return p;
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const ep: string = require('puppeteer').executablePath();
      if (ep && fs.existsSync(ep)) return ep;
    } catch { /* bundled Chrome not available */ }
    return undefined;
  }

  private async _updateNumberWaState(numberId: string, waState: string | null): Promise<void> {
    try {
      await this.numberRepo.update(numberId, { wa_state: waState });
    } catch (e: any) {
      this.logger.warn(`[DB_TRANSIENT] wa_state update failed for ${numberId}: ${e?.message}`);
    }
  }

  private async _updateNumberConnected(numberId: string): Promise<void> {
    try {
      await this.numberRepo.update(numberId, { wa_state: 'ready', last_connected_at: new Date() });
    } catch (e: any) {
      this.logger.warn(`[DB_TRANSIENT] connected update failed for ${numberId}: ${e?.message}`);
    }
  }
}
