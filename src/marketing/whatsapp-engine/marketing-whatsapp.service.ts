import { Injectable, OnModuleInit, OnModuleDestroy, Logger, Optional } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import * as fs from 'fs';
import * as path from 'path';
import { ReplaySubject, Observable, interval, merge } from 'rxjs';
import { map } from 'rxjs/operators';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { WhatsappNumber } from './entities/whatsapp-number.entity';
import { WhatsappMessageLog } from './entities/whatsapp-message-log.entity';
import { QueueStatus } from './entities/enums';
import { EngineAutoPauseService } from './engine/engine-auto-pause.service';

const WA_AUTH_DATA_PATH = '.wwebjs_auth_marketing';

// Returns true only for real E.164-style mobile numbers (10–15 digits, no internal WA IDs).
function isRealPhone(value?: string | null): boolean {
  if (!value) return false;
  const digits = value.replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 15) return false;
  return /^\+?[1-9]\d{9,14}$/.test(value);
}

// Normalise a verified phone candidate to E.164 ('+' + digits).
function normalizeWhatsAppSender(rawNumber: string): string {
  const digits = rawNumber.replace(/\D/g, '');
  return '+' + digits;
}
const WATCHDOG_MS       = 60_000;
const BOOT_TIMEOUT_MS   = 180_000;
const AUTH_TIMEOUT_MS   = 180_000;

const CHROME_PATH = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const CHROMIUM_LOCK_FILES = [
  'SingletonLock', 'SingletonSocket', 'SingletonCookie', 'DevToolsActivePort',
] as const;

// Strict linear state machine — no cyclic recovery transitions.
// idle → booting → qr_ready → authenticating → ready
// Any failure from any state → failed → idle (via forceInvalidateSession)
type WaState =
  | 'idle'           // Not connected — Connect button visible
  | 'booting'        // Chromium launching
  | 'qr_ready'       // QR displayed, awaiting scan
  | 'authenticating' // QR scanned, WA establishing session
  | 'ready'          // Session active — can send messages
  | 'failed';        // Init or auth failure — auto-resets to idle

interface NumberClientState {
  client: any;
  waState: WaState;
  starting: boolean;
  manualDisconnect: boolean;
  destroyed: boolean;
  terminating: boolean;
  destroying: boolean;
  authTimeoutId: ReturnType<typeof setTimeout> | null;
  watchdogTimer: ReturnType<typeof setInterval> | null;
  lastHeartbeat: Date | null;
  // Lives for the lifetime of the number so SSE subscribers survive invalidations.
  qrSubject: ReplaySubject<string>;
  qrDataUrl: string | null;
  qrGeneratedAt: Date | null;
  lastReadyAt: Date | null;
}

function makeState(): NumberClientState {
  return {
    client: null,
    waState: 'idle',
    starting: false,
    manualDisconnect: false,
    destroyed: false,
    terminating: false,
    destroying: false,
    authTimeoutId: null,
    watchdogTimer: null,
    lastHeartbeat: null,
    qrSubject: new ReplaySubject<string>(1),
    qrDataUrl: null,
    qrGeneratedAt: null,
    lastReadyAt: null,
  };
}

@Injectable()
export class MarketingWhatsAppService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MarketingWhatsAppService.name);
  private readonly clients = new Map<string, NumberClientState>();
  // Sequential init lock — only one Chromium launch at a time.
  private _initQueue: Promise<void> = Promise.resolve();
  // Idempotency guard for forceInvalidateSession.
  private readonly _invalidatingIds = new Set<string>();
  // Log-only stability counters.
  private readonly _metrics = {
    successfulReadySessions: 0,
    failedBeforeReady:       0,
    authInvalidations:       0,
    qrToReadyAttempts:       0,
    qrToReadySuccesses:      0,
  };

  constructor(
    @InjectRepository(WhatsappNumber)
    private readonly numberRepo: Repository<WhatsappNumber>,
    @InjectRepository(WhatsappMessageLog)
    private readonly logRepo: Repository<WhatsappMessageLog>,
    @InjectDataSource()
    private readonly ds: DataSource,
    @Optional() private readonly eventEmitter: EventEmitter2,
    @Optional() private readonly _autoPause: EngineAutoPauseService,
  ) {
    this.logger.log('[MKT_BOOT] constructor called');
  }

  async onModuleInit() {
    this.logger.log('[MKT_BOOT] onModuleInit entered');
    console.log('[BUILD_INFO]', { file: __filename, cwd: process.cwd(), pid: process.pid, timestamp: new Date().toISOString() });

    // One-time startup: purge historical bad inbox rows (invalid phones / empty bodies)
    await this._cleanupInvalidInboxRows();

    this.logger.log('[WA_RESTORE_START] Scanning active numbers for persisted LocalAuth sessions...');
    try {
      const rows = await this.numberRepo.find();
      let toRestore = 0;

      for (const r of rows) {
        const sessionDir = this._getSessionDir(r.id);
        const sessionExists = fs.existsSync(sessionDir);
        this.logger.log(`[MKT_BOOT] startup id=${r.id} phone=${r.phone} is_active=${r.is_active} wa_state=${JSON.stringify(r.wa_state)} sessionExists=${sessionExists}`);

        if (r.is_active && sessionExists) {
          this.logger.log(`[WA_RESTORE_SESSION_FOUND] id=${r.id} phone=${r.phone} sessionDir=${sessionDir} — queuing auto-restore`);
          toRestore++;
          // Fire-and-forget: don't block module init waiting for Chromium handshake
          this._autoRestoreNumber(r.id).catch((e: any) =>
            this.logger.error(`[WA_RESTORE_ERROR] id=${r.id} phone=${r.phone}: ${e?.message}`),
          );
        } else {
          this.logger.log(`[WA_RESTORE_NO_SESSION] id=${r.id} phone=${r.phone} is_active=${r.is_active} sessionExists=${sessionExists} — resetting to idle`);
          if (r.wa_state !== 'idle') {
            await this.numberRepo.update(r.id, { wa_state: 'idle' });
          }
        }
      }

      this.logger.log(`[MKT_BOOT] ${rows.length} number(s) scanned: ${toRestore} restoring in background, ${rows.length - toRestore} set idle`);
    } catch (e: any) {
      this.logger.warn(`[MKT_BOOT] session restore scan failed: ${e?.message}`);
    }

    this.logger.log('[MKT_BOOT] module fully initialized');
  }

  // Auto-restore a persisted LocalAuth session on startup.
  // Identical to connectNumber() but bypasses the "max 1 active" guard so that
  // all numbers with sessions can be queued through the sequential init lock.
  private async _autoRestoreNumber(numberId: string): Promise<void> {
    let state = this.clients.get(numberId);
    if (!state) {
      state = makeState();
      this.clients.set(numberId, state);
      this._startWatchdog(numberId, state);
    }
    if (state.destroyed || state.terminating || state.destroying) {
      this.logger.warn(`[WA_RESTORE_SESSION_FOUND] ${numberId} — skipped (teardown in progress)`);
      return;
    }
    if (state.starting || state.client) {
      this.logger.warn(`[WA_RESTORE_SESSION_FOUND] ${numberId} — skipped (already starting or client exists)`);
      return;
    }

    this._metrics.qrToReadyAttempts++;
    state.starting = true;
    this._transitionState(numberId, state, 'booting');
    await this._updateNumberWaState(numberId, 'booting');

    this.logger.log(`[WA_CLIENT_INITIALIZE] ${numberId} — queued in init lock for startup restore`);
    try {
      await this._withInitLock(numberId, () => this._initClient(numberId, state!));
    } catch (e: any) {
      this.logger.error(`[WA_RESTORE_ERROR] ${numberId} init failed: ${e?.message}`);
      this._metrics.failedBeforeReady++;
      this._logMetrics();
      state.qrSubject.next(JSON.stringify({ type: 'error', message: `Restore failed: ${e?.message}` }));
      await this.forceInvalidateSession(numberId, 'restore_init_error');
    } finally {
      state.starting = false;
    }
  }

  async onModuleDestroy() {
    this.logger.log('[MKT_WA] Shutdown — destroying all clients');
    const shutdowns: Promise<void>[] = [];
    for (const [id, state] of this.clients) {
      state.terminating = true;
      state.destroyed = true;
      this._clearTimers(state);
      shutdowns.push(this._destroyClient(id, state));
    }
    await Promise.allSettled(shutdowns);
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  async connectNumber(numberId: string): Promise<void> {
    // Stability rule: max 1 active marketing session at a time.
    const activeId = this._getActiveNumberId();
    if (activeId && activeId !== numberId) {
      const msg = `Another number (${activeId}) is already active. Disconnect it first.`;
      this.logger.warn(`[MKT_WA:${numberId}] connect rejected — ${msg}`);
      throw new Error(msg);
    }

    let state = this.clients.get(numberId);
    if (!state) {
      state = makeState();
      this.clients.set(numberId, state);
      this._startWatchdog(numberId, state);
    }
    if (state.destroyed) return;
    if (state.terminating || state.destroying) {
      this.logger.log(`[MKT_WA:${numberId}] connect skipped — teardown in progress`);
      return;
    }
    if (state.starting || state.client) {
      this.logger.log(`[MKT_WA:${numberId}] connect skipped — already starting or client exists`);
      return;
    }

    this._metrics.qrToReadyAttempts++;
    state.starting = true;
    this._transitionState(numberId, state, 'booting');
    await this._updateNumberWaState(numberId, 'booting');

    this.logger.log(`[WA_LOCK] ${numberId} — queued for init lock`);
    try {
      await this._withInitLock(numberId, () => this._initClient(numberId, state!));
    } catch (e: any) {
      // All init failures → invalidate auth and return to idle. No retries, no recovery.
      this.logger.error(`[MKT_WA:${numberId}] Init error: ${e?.message}`);
      this._metrics.failedBeforeReady++;
      this._logMetrics();
      state.qrSubject.next(JSON.stringify({ type: 'error', message: `Init failed: ${e?.message}` }));
      await this.forceInvalidateSession(numberId, `init_error`);
    } finally {
      state.starting = false;
    }
  }

  async disconnectNumber(numberId: string): Promise<void> {
    const state = this.clients.get(numberId);
    if (!state) return;
    this.logger.log(`[NUMBER_DISCONNECTED] ${numberId}`);
    state.terminating = true;
    state.manualDisconnect = true;
    this._clearTimers(state);
    if (state.client) { state.client.removeAllListeners(); }
    await this._destroyClient(numberId, state);
    await new Promise<void>((r) => setTimeout(r, 5_000));
    state.qrDataUrl = null;
    state.qrGeneratedAt = null;
    state.lastReadyAt = null;
    state.manualDisconnect = false;
    this._transitionState(numberId, state, 'idle');
    await this._updateNumberWaState(numberId, 'idle', 'manual_disconnect');
    state.terminating = false;
    state.destroying = false;
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
      state.terminating = true;
      state.manualDisconnect = true;
      state.starting = false;
      this._clearTimers(state);
      state.qrDataUrl = null;
      state.qrGeneratedAt = null;
      if (state.client) {
        state.client.removeAllListeners();
        this.logger.log(`[HARD_RESET] Logging out client for ${numberId}`);
        try { await state.client.logout(); } catch { /* already gone */ }
      }
      await this._destroyClient(numberId, state);
      // Wait for Chromium child processes to fully exit before deleting files
      await new Promise<void>((r) => setTimeout(r, 5_000));
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
    this.logger.log(`[MKT_RESET] Starting reset for ${numberId}`);

    const state = this.clients.get(numberId);
    if (state) {
      state.terminating = true;
      state.manualDisconnect = true;
      this._clearTimers(state);
      if (state.client) { state.client.removeAllListeners(); }
      try { await state.client?.logout(); } catch { /* already gone */ }
      await this._destroyClient(numberId, state);
      // Wait for Chromium child processes to fully exit before deleting files
      await new Promise<void>((r) => setTimeout(r, 5_000));
      state.qrDataUrl = null;
      state.qrGeneratedAt = null;
      state.lastReadyAt = null;
    }

    // Fully wipe LocalAuth — throws if deletion fails
    this.logger.warn('[MKT_AUTH_DELETE_REASON] ' + JSON.stringify({ id: numberId, reason: 'manual_hard_reset' }));
    await this._clearAuthFiles(numberId);

    // Only update DB after verified deletion
    try {
      await this.numberRepo.update(numberId, {
        wa_state: null,
        last_connected_at: null,
        qr_code: null,
      } as any);
    } catch (e: any) {
      this.logger.warn(`[MKT_RESET] DB update failed (non-fatal): ${e?.message}`);
    }

    if (state) {
      this._transitionState(numberId, state, 'idle');
      state.terminating = false;
      state.destroying = false;
    }

    this.logger.log(`[MKT_RESET] true reset complete — phone must re-scan QR — ${numberId}`);
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
   * Hard safety: verifies browser + session health, normalizes phone, checks WA registration.
   * Returns the raw WA Message object so callers can verify result.id exists.
   */
  async sendViaNumber(numberId: string, phone: string, body: string): Promise<any> {
    const state = this.clients.get(numberId);

    if (!state || state.destroyed) {
      throw new Error(`[SEND_SKIPPED] ${numberId} — no client state`);
    }
    if (state.starting) {
      throw new Error(`[SEND_SKIPPED] ${numberId} — reconnecting`);
    }
    if (state.waState !== 'ready' || !state.client) {
      throw new Error(`[SEND_SKIPPED] ${numberId} — not ready (waState=${state.waState})`);
    }

    const page = state.client.pupPage;
    const browserAlive = state.client.pupBrowser?.isConnected?.() ?? false;
    const pageOpen = page != null && !page.isClosed();
    if (!browserAlive || !pageOpen) {
      this.logger.warn(`[SEND_SKIPPED] ${numberId} — browser unhealthy, invalidating session`);
      this.forceInvalidateSession(numberId, 'send_browser_unhealthy').catch(() => {});
      throw new Error(`[SEND_SKIPPED] ${numberId} — browser unhealthy`);
    }

    // Normalize phone: strip leading + and all whitespace before appending @c.us
    const normalized = phone.replace(/^\+/, '').replace(/\s+/g, '').replace(/-/g, '');
    const target = `${normalized}@c.us`;

    this.logger.log(
      `[MKT_WA_TARGET] raw_phone=${phone} normalized=${normalized} target=${target}`,
    );
    this.logger.log(
      `[MKT_WA_CLIENT_STATE] numberId=${numberId} waState=${state.waState} ` +
      `clientExists=${!!state.client} browserAlive=${browserAlive} pageOpen=${pageOpen} ` +
      `pushname=${state.client?.info?.pushname ?? 'unknown'} wid=${state.client?.info?.wid?.user ?? 'unknown'}`,
    );

    // Registration check — abort with FAILED if phone is not on WhatsApp
    if (typeof state.client.isRegisteredUser === 'function') {
      let registered = false;
      try {
        registered = await state.client.isRegisteredUser(target);
        this.logger.log(`[MKT_WA_REGISTERED] target=${target} registered=${registered}`);
      } catch (regErr: any) {
        this.logger.warn(
          `[MKT_WA_REGISTERED] target=${target} check_threw="${regErr?.message}" — proceeding with send`,
        );
        registered = true; // let the send attempt surface the real error
      }
      if (!registered) {
        throw new Error(`INVALID_WA_NUMBER: ${target} is not registered on WhatsApp`);
      }
    } else {
      this.logger.warn(`[MKT_WA_REGISTERED] isRegisteredUser not available on this client — skipping check`);
    }

    const result: any = await this._safeEval(numberId, state, () =>
      state.client.sendMessage(target, body),
    );

    const resultId = result?.id?._serialized ?? result?.id ?? null;
    this.logger.log(
      `[MKT_WA_SEND_RESULT] target=${target} ` +
      `result_id=${resultId} ` +
      `result_keys=${Object.keys(result ?? {}).join(',') || 'null'}`,
    );

    return result;
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
    browserConnected: boolean;
    clientExists: boolean;
  } {
    const state = this.clients.get(numberId);

    // clientExists: the WA client object is alive in memory (not destroyed/null).
    // browserConnected: the Chrome DevTools WebSocket is open (browser process running).
    const clientExists     = !!(state?.client);
    const browserConnected = clientExists
      ? (state!.client?.pupBrowser?.isConnected?.() ?? false)
      : false;

    if (!state) {
      this.logger.log(`[WA_STATUS_RESOLVE] ${JSON.stringify({ id: numberId, memoryState: 'none', browserConnected: false, clientExists: false, finalState: 'idle' })}`);
      return { waState: 'idle', connected: false, booting: false, qrActive: false, lastHeartbeat: null, lastReadyAt: null, browserConnected: false, clientExists: false };
    }

    const memoryState = state.waState;

    // Memory is authoritative: if the client and browser are live and memory says ready,
    // return connected=true regardless of any transient intermediate state. This prevents
    // a brief in-flight state write or a page.isClosed() transient from causing a phantom
    // disconnect on the frontend.
    const liveAndReady = clientExists && browserConnected &&
      (memoryState === 'ready' || memoryState === 'authenticating');
    const connected = liveAndReady || (memoryState === 'ready' && !state.destroyed);

    // Only log when something non-trivial is happening (avoids 15s-interval log spam).
    if (memoryState !== 'idle') {
      this.logger.log(`[WA_STATUS_RESOLVE] ${JSON.stringify({
        id: numberId, memoryState, browserConnected, clientExists,
        destroyed: state.destroyed, liveAndReady, connected,
      })}`);
    }

    return {
      waState:         memoryState,
      connected,
      booting:         memoryState === 'booting',
      qrActive:        memoryState === 'qr_ready',
      lastHeartbeat:   state.lastHeartbeat?.toISOString() ?? null,
      lastReadyAt:     state.lastReadyAt?.toISOString() ?? null,
      browserConnected,
      clientExists,
    };
  }

  getOverallStatus(): { connected_count: number; total_clients: number } {
    let connected = 0;
    for (const [id] of this.clients) {
      if (this.isConnected(id)) connected++;
    }
    return { connected_count: connected, total_clients: this.clients.size };
  }

  // ── Client health watchdog ───────────────────────────────────────────────────

  private _startWatchdog(numberId: string, state: NumberClientState): void {
    if (state.watchdogTimer) return;

    state.watchdogTimer = setInterval(async () => {
      if (state.destroyed || state.terminating || state.destroying) {
        clearInterval(state.watchdogTimer!);
        state.watchdogTimer = null;
        return;
      }
      if (state.waState !== 'ready') return;

      const browserAlive = state.client?.pupBrowser?.isConnected?.() ?? false;
      const page = state.client?.pupPage;
      const pageOpen = page != null && !page.isClosed();

      if (!browserAlive || !pageOpen) {
        // Stability rule: browser unhealthy while ready → invalidate, no auto-reconnect.
        this.logger.warn(`[WATCHDOG] ${numberId} — browser unhealthy while ready — invalidating`);
        await this.forceInvalidateSession(numberId, 'watchdog_browser_unhealthy');
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

    this.logger.log(`[WA_CHROME] executablePath=${CHROME_PATH}`);
    this.logger.log(`[WA_CHROME] exists=${fs.existsSync(CHROME_PATH)}`);
    this.logger.log(`[WA_CHROME] protocolTimeout=180000`);
    if (!fs.existsSync(CHROME_PATH)) {
      throw new Error(`[WA_CHROME] Chrome not found at ${CHROME_PATH} — aborting init`);
    }
    this._removeSingletonFiles(numberId);

    this.logger.log(`[WA_AUDIT] before_client_create — ${numberId} chrome=${CHROME_PATH}`);
    state.client = new Client({
      authStrategy: new LocalAuth({
        clientId: `marketing-${numberId}`,
        dataPath: WA_AUTH_DATA_PATH,
      }),
      puppeteer: {
        headless: true,
        timeout: 180_000,
        protocolTimeout: 180_000,
        executablePath: CHROME_PATH,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
        ],
      },
      authTimeoutMs: 0,
      qrMaxRetries: 0,
      userAgent: false as unknown as string,
      webVersionCache: { type: 'none' },
    });
    this.logger.log(`[WA_AUDIT] after_client_create — ${numberId}`);

    // ── Event handlers ──────────────────────────────────────────────────────────

    // Heartbeat: updated on every WA event to prove Chromium is alive
    const beat = () => { state.lastHeartbeat = new Date(); };

    // Heartbeat-only listeners — do not alter state machine
    state.client.on('loading_screen', () => { beat(); if (state.terminating) return; this.logger.log(`[WA_EVENT_ORDER] loading_screen — ${numberId} waState=${state.waState}`); });
    state.client.on('change_state',   (s: string) => { beat(); this.logger.log(`[WA_EVENT_ORDER] change_state — ${numberId} s=${s} waState=${state.waState}`); });

    state.client.on('qr', async (qr: string) => {
      beat();
      if (state.terminating) return;
      console.log('[QR_HANDLER_VERSION]', '2026-05-22-v1');
      console.log('[QR_HANDLER_ATTACHED]', numberId);
      console.log('[QR_DEBUG] entered_qr_handler', { id: numberId });
      this.logger.log(`[WA_EVENT] qr — ${numberId} length=${qr.length}`);
      console.log('[WA_QR_RAW]', { id: numberId, type: typeof qr, length: qr?.length, preview: qr?.slice?.(0, 80) });
      this.logger.log(`[QR_PIPELINE] stage=qr_event id=${numberId} rawLength=${qr?.length ?? 0}`);

      if (state.lastReadyAt !== null) { state.lastReadyAt = null; }

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

      // RACE GUARD — toDataURL is async. authenticated/ready can fire and complete
      // while it executes, advancing state beyond qr_ready. Without this guard the QR
      // handler resumes and blindly overwrites the ready state with qr_ready in both
      // memory and DB, causing the frontend to stay stuck showing "View QR" forever.
      if (state.terminating || (['authenticating', 'ready'] as WaState[]).includes(state.waState)) {
        this.logger.warn(`[QR_PIPELINE] stage=qr_post_async_discarded id=${numberId} waState=${state.waState} — session advanced during toDataURL`);
        return;
      }

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
      if (state.terminating) return;
      this.logger.log(`[WA_EVENT_ORDER] authenticated — ${numberId} waState=${state.waState}`);
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
      if (state.terminating) return;
      if (state.authTimeoutId) { clearTimeout(state.authTimeoutId); state.authTimeoutId = null; }
      this.logger.log(`[WA_EVENT_ORDER] ready — ${numberId} waState=${state.waState}`);
      this.logger.log(`[WA_READY_ENTER] ${JSON.stringify({ id: numberId, waState: state.waState, ts: new Date().toISOString() })}`);
      if (state.waState === 'ready') {
        this.logger.warn(`[WA_READY_ENTER] skipped — already ready — ${numberId}`);
        return;
      }
      const phone = state.client?.info?.wid?.user ?? null;

      // Persist to DB FIRST — session is only authoritative after the write lands.
      // _updateNumberConnected throws on final failure (after one retry).
      this.logger.log(`[WA_READY_DB_WRITE] ${numberId} — starting`);
      try {
        await this._updateNumberConnected(numberId);
        this.logger.log(`[WA_READY_DB_WRITE] ${numberId} — success`);
      } catch {
        // DB write failed after retry — invalidate session, return to idle.
        this.logger.error(`[WA_READY_ERROR] ${JSON.stringify({ id: numberId, stage: 'db_write', waState: state.waState, ts: new Date().toISOString() })}`);
        state.qrSubject.next(JSON.stringify({ type: 'error', reason: 'db_sync_failed', timestamp: new Date().toISOString() }));
        await this.forceInvalidateSession(numberId, 'ready_db_write_failed');
        return;
      }

      // DB committed — now safe to commit memory state and emit SSE.
      this.logger.log(`[WA_READY_STATE_TRANSITION] ${numberId} — transitioning memory state to ready`);
      state.qrDataUrl = null;
      state.qrGeneratedAt = null;
      state.lastReadyAt = new Date();
      this._transitionState(numberId, state, 'ready');
      this._metrics.qrToReadySuccesses++;
      this._metrics.successfulReadySessions++;
      this._logMetrics();
      this.logger.log(`[WA_READY_COMPLETE] ${JSON.stringify({ id: numberId, phone, waState: state.waState, ts: new Date().toISOString() })}`);
      state.qrSubject.next(JSON.stringify({ type: 'ready', phone, timestamp: new Date().toISOString() }));
    });

    state.client.on('disconnected', async (reason: string) => {
      beat();
      if (state.terminating) return;
      if (reason === 'NAVIGATION') return;
      if (state.authTimeoutId) { clearTimeout(state.authTimeoutId); state.authTimeoutId = null; }
      this.logger.log(`[NUMBER_DISCONNECTED] ${numberId} reason=${reason}`);
      this._autoPause?.recordDisconnect();
      state.qrSubject.next(JSON.stringify({ type: 'disconnected', reason, timestamp: new Date().toISOString() }));
      // Stability rule: any unexpected disconnect → invalidate session, no auto-reconnect.
      await this.forceInvalidateSession(numberId, `wa_disconnected`);
    });

    state.client.on('auth_failure', async (msg: string) => {
      beat();
      if (state.terminating) return;
      if (state.authTimeoutId) { clearTimeout(state.authTimeoutId); state.authTimeoutId = null; }
      state.qrDataUrl = null;
      state.qrGeneratedAt = null;
      this.logger.warn(`[MKT_WA:${numberId}] Auth failure: ${msg}`);
      state.qrSubject.next(JSON.stringify({
        type: 'error',
        message: 'Auth failed — device was unlinked. Reconnect to re-pair.',
        timestamp: new Date().toISOString(),
      }));
      // Device permanently unlinked — wipe session, auth files, and reset to idle
      this.forceInvalidateSession(numberId, 'auth_failure').catch(() => {});
    });

    // Inbound message handler — marketing number recipients replying to campaigns
    state.client.on('message', async (msg: any) => {
      beat();
      if (state.terminating) return;
      if (msg.fromMe) return;

      const from: string = msg.from ?? '';

      // Drop group, broadcast, and newsletter messages — only handle 1-to-1 replies
      if (
        from.endsWith('@g.us') ||
        from === 'status@broadcast' ||
        from.endsWith('@newsletter')
      ) return;

      const notifyName: string | undefined = (msg as any)?.notifyName ?? undefined;

      // ── Phone resolution with E.164 validation ──────────────────────────────
      // IMPORTANT: @lid user segments are WhatsApp internal identifiers, NOT phones.
      // They happen to be 15-digit numbers and will pass digit-length checks, so
      // fromUser is NEVER used as a phone candidate for @lid sources.
      // Priority:
      //   A) from_field  (only for @c.us, never @lid)
      //   B) contact.number
      //   C) contact.id.user
      const isLid = from.includes('@lid');
      let contactNumber: string | undefined;
      let contactUser: string | undefined;

      // Always attempt contact resolution; @lid requires it, @c.us uses it as fallback
      try {
        const contact = await msg.getContact();
        contactNumber = contact?.number   ?? undefined;
        contactUser   = contact?.id?.user ?? undefined;
      } catch (contactErr: any) {
        this.logger.warn(
          `[MKT_INBOX_MESSAGE] getContact() failed for from=${from}: ${contactErr?.message}`,
        );
      }

      // fromUser is only a valid phone candidate when coming from @c.us (not @lid)
      const fromUser: string | null = isLid
        ? null  // LID segment is never a real phone — suppress entirely
        : from.replace(/:\d+(?=@)/, '').split('@')[0];

      // Walk priority chain — first valid E.164 wins
      let resolved: string | null = null;
      let resolutionSource = 'none';
      if (!isLid && isRealPhone(fromUser))   { resolved = fromUser!;      resolutionSource = 'from_field'; }
      else if (isRealPhone(contactNumber))   { resolved = contactNumber!; resolutionSource = 'contact.number'; }
      else if (isRealPhone(contactUser))     { resolved = contactUser!;   resolutionSource = 'contact.id.user'; }

      this.logger.log(
        `[MKT_INBOX_TRACE] numberId=${numberId} raw_from=${from} is_lid=${isLid} ` +
        `from_me=${msg.fromMe ?? false} type=${(msg as any)?.type ?? 'unknown'} ` +
        `from_user=${fromUser ?? 'suppressed'} contact_number=${contactNumber ?? 'n/a'} ` +
        `contact_user=${contactUser ?? 'n/a'} resolved=${resolved ?? 'NONE'} ` +
        `resolution_source=${resolutionSource} is_valid=${resolved !== null} ` +
        `message_body="${String(msg.body ?? '').slice(0, 60)}"`,
      );

      if (!resolved) {
        this.logger.warn(
          `[MKT_INBOX_SKIP_INVALID_PHONE] numberId=${numberId} raw_from=${from} is_lid=${isLid} ` +
          `from_user=${fromUser ?? 'n/a'} contact_number=${contactNumber ?? 'n/a'} ` +
          `contact_user=${contactUser ?? 'n/a'} — no valid E.164 candidate; dropping`,
        );
        return;
      }

      const phone = normalizeWhatsAppSender(resolved);

      // ── Body extraction ──────────────────────────────────────────────────────
      const messageBody = this._extractMessageBody(msg);

      this.logger.log(
        `[MKT_INBOX_BODY] numberId=${numberId} type=${msg.type ?? 'unknown'} ` +
        `body="${String(msg.body ?? '').slice(0, 60)}" caption="${String(msg.caption ?? '').slice(0, 60)}" ` +
        `resolved="${(messageBody ?? '').slice(0, 60)}"`,
      );

      if (!messageBody) {
        this.logger.warn(
          `[MKT_INBOX_SKIP_EMPTY_BODY] numberId=${numberId} raw_from=${from} phone=${phone} ` +
          `type=${msg.type ?? 'unknown'} — no extractable text; dropping message`,
        );
        return;
      }

      this.logger.log(
        `[MKT_INBOX_MESSAGE] numberId=${numberId} raw_from=${from} normalized_phone=${phone} ` +
        `message_id=${(msg as any)?.id?._serialized ?? 'none'} body="${messageBody.slice(0, 60)}"`,
      );

      this.eventEmitter?.emit('marketing.whatsapp.message.received', {
        phone,
        body: messageBody,
        chatId: from,
        name: notifyName,
        numberId,
      });
    });

    // Delivery + read receipt handler
    // ack: 1=server_received, 2=device_delivered, 3=read (blue ticks), 4=played (voice)
    state.client.on('message_ack', async (msg: any, ack: number) => {
      if (state.terminating) return;
      const waMessageId: string = msg?.id?._serialized ?? msg?.id ?? '';
      if (!waMessageId) return;
      this.logger.log(`[MKT_WA_ACK] numberId=${numberId} waMessageId=${waMessageId} ack=${ack}`);
      try {
        if (ack === 2 || ack >= 3) {
          const newStatus = ack >= 3 ? QueueStatus.READ : QueueStatus.DELIVERED;
          const updatePayload: Partial<{ status: QueueStatus; delivered_at: Date; read_at: Date }> =
            ack >= 3
              ? { status: QueueStatus.READ, read_at: new Date() }
              : { status: QueueStatus.DELIVERED, delivered_at: new Date() };

          // Verify row exists before updating — ACK can arrive extremely fast
          const existing = await this.logRepo.findOne({ where: { wa_message_id: waMessageId } });
          if (!existing) {
            this.logger.warn(`[MKT_ACK_MISSING_ROW] waMessageId=${waMessageId} ack=${ack} — no log row found, ACK dropped`);
            return;
          }

          const result = await this.logRepo.update({ wa_message_id: waMessageId }, updatePayload);
          this.logger.log(
            `[MKT_ACK_UPDATE] waMessageId=${waMessageId} ack=${ack} new_status=${newStatus} ` +
            `log_id=${existing.id} rows_affected=${(result as any)?.affected ?? 'unknown'}`,
          );
        }
      } catch (ackErr: any) {
        this.logger.warn(`[MKT_WA_ACK_ERROR] waMessageId=${waMessageId} ack=${ack} error="${ackErr?.message}"`);
      }
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
      let deadBrowserId: ReturnType<typeof setTimeout> | null = null;

      const settle = (err?: Error) => {
        if (settled) return;
        settled = true;
        if (bootTimeoutId) { clearTimeout(bootTimeoutId); bootTimeoutId = null; }
        if (deadBrowserId) { clearTimeout(deadBrowserId); deadBrowserId = null; }
        if (err) reject(err); else resolve();
      };

      // Release init lock on the first WA event — client runs autonomously after this.
      // loading_screen is included so that a session-restore navigation happening between
      // Chrome boot and the first auth event doesn't leave settled=false when initialize()
      // rejects with "Execution context was destroyed" (a normal WhatsApp navigation artifact).
      const onFirstEvent = (evtName: string) => () => {
        this.logger.log(`[WA_INIT_STAGE] first_event=${evtName} numberId=${numberId} elapsed=${Date.now() - initStart}ms — releasing init lock`);
        settle();
      };
      state.client.once('loading_screen', onFirstEvent('loading_screen'));
      state.client.once('qr',             onFirstEvent('qr'));
      state.client.once('authenticated',  onFirstEvent('authenticated'));
      state.client.once('ready',          onFirstEvent('ready'));
      state.client.once('auth_failure',   onFirstEvent('auth_failure'));

      // 90s early abort: if Chromium launched but the browser process died before any WA event
      deadBrowserId = setTimeout(() => {
        if (settled) return;
        const browser = state.client?.pupBrowser;
        if (!browser) return; // Chromium not yet attached — too early to judge
        if (!browser.isConnected()) {
          this.logger.error(`[WA_BOOT] 90s dead-browser checkpoint — process died — ${numberId}`);
          settle(new Error('Browser dead at 90s checkpoint'));
        }
      }, 90_000);

      // Hard abort only if Chromium boots but produces no event at all
      this.logger.log(`[WA_BOOT] timeout=${BOOT_TIMEOUT_MS}`);
      bootTimeoutId = setTimeout(() => {
        settle(new Error(`Chromium boot timeout — no WA event in ${BOOT_TIMEOUT_MS / 1000}s`));
      }, BOOT_TIMEOUT_MS);

      // Start Chromium — runs indefinitely in background after init lock releases
      this.logger.log(`[WA_INIT_STAGE] initialize_called numberId=${numberId}`);
      state.client.initialize()
        .then(() => {
          this.logger.log(`[WA_INIT_STAGE] initialize_resolved numberId=${numberId} elapsed=${Date.now() - initStart}ms`);
          settle();
        })
        .catch((e: any) => {
          const msg: string = e?.message ?? '';

          // "Execution context was destroyed" / "Cannot find context" = WhatsApp Web page
          // navigated during initialization. This is EXPECTED during a session restore:
          // WhatsApp loads → navigates to chat view → Puppeteer's internal eval is interrupted.
          // The browser and WA event listeners are still alive; authenticated+ready will fire
          // normally. Release the init lock without error and let the event flow complete.
          const isNavigationArtifact =
            msg.includes('Execution context was destroyed') ||
            msg.includes('Cannot find context with specified id');

          if (isNavigationArtifact) {
            this.logger.warn(
              `[WA_RESTORE_RECOVER] numberId=${numberId} — navigation artifact: "${msg}" ` +
              `— releasing init lock; WA events will complete the session`,
            );
            if (!settled) settle(); // resolve: no error, event flow continues
            return;
          }

          if (state.terminating && (
            msg.includes('Target closed') || msg.includes('Session closed') ||
            msg.includes('Protocol error')
          )) {
            this.logger.log(`[WA_CLEANUP] ${numberId} — expected browser shutdown during teardown`);
            if (!settled) settle();
            return;
          }

          this.logger.error(`[WA_INIT_STAGE] initialize_rejected numberId=${numberId} error="${msg}"`);
          if (!settled) {
            // No event received yet — Chromium boot genuinely failed
            settle(e instanceof Error ? e : new Error(String(e?.message ?? 'Unknown')));
          } else {
            // Late rejection after session was running — invalidate, no auto-reconnect.
            this.logger.warn(`[WA_INIT_STAGE] late_rejection_after_first_event numberId=${numberId} error="${msg}"`);
            if (!state.manualDisconnect && !state.destroyed && !state.terminating) {
              this.forceInvalidateSession(numberId, 'late_initialize_rejection').catch(() => {});
            }
          }
        });
    });

    if (state.terminating) {
      this.logger.log(`[WA_CLEANUP] ${numberId} — init aborted due to teardown`);
      return;
    }
    this.logger.log(`[WA_INIT] init lock released — ${numberId} — client live, awaiting user action`);

    // ── Chromium disconnect detection ─────────────────────────────────────────
    // pupBrowser is available after first event (Chromium is running at this point)
    const pupBrowser = state.client?.pupBrowser;
    if (pupBrowser) {
      pupBrowser.once('disconnected', () => {
        this.logger.log(
          `[WA_BROWSER_DISCONNECT] numberId=${numberId} terminating=${state.terminating} ` +
          `destroying=${state.destroying} manualDisconnect=${state.manualDisconnect} ` +
          `destroyed=${state.destroyed} waState=${state.waState}`,
        );
        if (state.terminating || state.destroying) {
          this.logger.log(`[WA_BROWSER_DISCONNECT] ${numberId} — expected during teardown, ignoring`);
          return;
        }
        if (state.manualDisconnect || state.destroyed) return;
        this.logger.warn(`[WA_BROWSER_DISCONNECT] ${numberId} — unexpected disconnect, invalidating session`);
        // Stability rule: browser gone → invalidate session, no auto-reconnect.
        this.forceInvalidateSession(numberId, 'browser_disconnected').catch(() => {});
      });
      this.logger.log(`[WA_INIT_STAGE] browser_disconnect_listener_attached numberId=${numberId}`);
    } else {
      this.logger.warn(`[WA_INIT_STAGE] pupBrowser_unavailable_post_init numberId=${numberId} — disconnect detection via events only`);
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
  // destroying flag prevents concurrent calls from racing.
  private async _destroyClient(numberId: string, state: NumberClientState): Promise<void> {
    const client = state.client;
    if (!client) { this.logger.log(`[WA_DESTROY_STAGE] ${numberId} — no client, skip`); return; }
    if (state.destroying) { this.logger.log(`[WA_DESTROY_STAGE] ${numberId} — already destroying, skip`); return; }
    state.destroying = true;
    state.client = null;
    state.lastHeartbeat = null;
    this.logger.log(`[WA_DESTROY_STAGE] ${numberId} — removing listeners`);
    try { client.removeAllListeners(); } catch { }
    this.logger.log(`[WA_DESTROY_STAGE] ${numberId} — calling client.destroy()`);
    try { await client.destroy(); } catch { }
    this.logger.log(`[WA_DESTROY_STAGE] ${numberId} — done`);
    state.destroying = false;
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
    if (state.authTimeoutId) {
      clearTimeout(state.authTimeoutId);
      state.authTimeoutId = null;
    }
    // Watchdog continues across invalidations — stopped only on full destroy.
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

  private async _cleanupInvalidInboxRows(): Promise<void> {
    this.logger.log(
      '[MKT_INBOX_CLEANUP_START] entity=WhatsappReply table=whatsapp_replies — ' +
      'removing invalid phone + empty message rows',
    );
    try {
      // Delete rows with invalid customer_phone:
      //   - contains '@lid' or '@'
      //   - digit count < 10 or > 15
      //   - null / empty
      const phoneResult = await this.ds.query<{ deleted: string }[]>(`
        WITH deleted AS (
          DELETE FROM whatsapp_replies
          WHERE
            customer_phone IS NULL
            OR customer_phone = ''
            OR customer_phone LIKE '%@%'
            OR customer_phone NOT LIKE '+%'
            OR LENGTH(REGEXP_REPLACE(customer_phone, '[^0-9]', '', 'g')) < 10
            OR LENGTH(REGEXP_REPLACE(customer_phone, '[^0-9]', '', 'g')) > 15
          RETURNING id
        )
        SELECT COUNT(*)::text AS deleted FROM deleted
      `);
      const deletedPhones = parseInt(phoneResult[0]?.deleted ?? '0', 10);

      // Delete rows with null/empty message body
      const bodyResult = await this.ds.query<{ deleted: string }[]>(`
        WITH deleted AS (
          DELETE FROM whatsapp_replies
          WHERE message IS NULL OR TRIM(message) = ''
          RETURNING id
        )
        SELECT COUNT(*)::text AS deleted FROM deleted
      `);
      const deletedBodies = parseInt(bodyResult[0]?.deleted ?? '0', 10);

      this.logger.log(
        `[MKT_INBOX_CLEANUP_RESULT] deleted_invalid_phones=${deletedPhones} deleted_empty_messages=${deletedBodies}`,
      );
    } catch (err: any) {
      this.logger.error(`[MKT_INBOX_CLEANUP_ERROR] cleanup failed (non-fatal): ${err?.message}`);
    }
  }

  private _extractMessageBody(msg: any): string | null {
    return (
      msg.body ||
      msg.caption ||
      msg.selectedButtonId ||
      msg.selectedRowId ||
      msg.title ||
      msg.description ||
      msg.listResponse?.title ||
      msg.listResponse?.description ||
      null
    );
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
    if (!fs.existsSync(sessionDir)) {
      this.logger.log(`[MKT_RESET] LocalAuth dir not found — nothing to delete for ${numberId}`);
      return;
    }
    await fs.promises.rm(sessionDir, { recursive: true, force: true });
    const exists = fs.existsSync(sessionDir);
    if (exists) {
      this.logger.error(`[MKT_RESET] LocalAuth delete failed — session still exists for ${numberId}`);
      throw new Error(`LocalAuth delete failed — session still exists at ${sessionDir}`);
    }
    this.logger.log(`[MKT_RESET] LocalAuth deleted successfully — ${numberId}`);
  }

  private async _updateNumberWaState(numberId: string, waState: string | null, reason?: string): Promise<void> {
    this.logger.log(`[WA_STATE_WRITE] ${JSON.stringify({ id: numberId, next: waState, reason: reason ?? 'unspecified', ts: new Date().toISOString() })}`);
    try {
      await this.numberRepo.update(numberId, { wa_state: waState });
    } catch (e: any) {
      this.logger.warn(`[DB_TRANSIENT] wa_state update failed for ${numberId}: ${e?.message}`);
    }
  }

  // ── Terminal session invalidation ────────────────────────────────────────────
  // Idempotent cleanup for permanently dead sessions (auth_failure, recovery_session_lost,
  // stale sweeper). Always finishes DB normalization even if browser/auth steps fail.

  async forceInvalidateSession(numberId: string, reason: string): Promise<void> {
    if (this._invalidatingIds.has(numberId)) {
      this.logger.log(`[WA_FORCE_INVALIDATE] ${numberId} — already invalidating, skipping`);
      return;
    }
    this._invalidatingIds.add(numberId);
    this.logger.warn(`[WA_FORCE_INVALIDATE] ${JSON.stringify({ id: numberId, reason, ts: new Date().toISOString() })}`);

    this._metrics.authInvalidations++;
    this._logMetrics();
    try {
      const state = this.clients.get(numberId);
      if (state) {
        state.terminating = true;
        this._clearTimers(state);
        await this._destroyClient(numberId, state);
      }

      try {
        await this._clearAuthFiles(numberId);
      } catch (err: any) {
        this.logger.warn(`[WA_FORCE_INVALIDATE] auth delete failed (non-fatal) — ${numberId}: ${err?.message}`);
      }

      // DB normalization — always runs even if prior steps partially failed
      await this._updateNumberWaState(numberId, 'idle', reason);

      if (state) {
        this._transitionState(numberId, state, 'idle');
        state.qrDataUrl = null;
        state.qrGeneratedAt = null;
        state.terminating = false;
        state.destroying = false;
        state.starting = false;
      }

      this.logger.log(`[WA_FORCE_INVALIDATE_DONE] ${JSON.stringify({ id: numberId, reason, ts: new Date().toISOString() })}`);
    } catch (err: any) {
      this.logger.error(`[WA_FORCE_INVALIDATE_ERROR] ${JSON.stringify({ id: numberId, reason, error: err?.message, ts: new Date().toISOString() })}`);
    } finally {
      this._invalidatingIds.delete(numberId);
    }
  }

  // Returns the number ID that currently holds the active session slot, or null.
  // ── Deep runtime diagnostics ────────────────────────────────────────────────
  // Read-only inspection of live in-memory state. Never trusts DB — always reads
  // directly from the in-process client map, Puppeteer objects, and disk.
  async getDebugSnapshot(numberId: string): Promise<Record<string, unknown>> {
    const state   = this.clients.get(numberId);
    const client  = state?.client ?? null;
    const browser = client?.pupBrowser ?? null;
    const page    = client?.pupPage    ?? null;

    const clientExists     = client  !== null;
    const browserExists    = browser !== null;
    const browserConnected = browser?.isConnected?.() ?? false;
    const pageExists       = page    !== null;
    const pageClosed       = page ? (page.isClosed?.() ?? true) : true;

    let currentUrl:      string | null = null;
    let whatsappTitle:   string | null = null;
    let navigatorOnline: unknown       = null;
    let visibilityState: unknown       = null;

    if (page && !pageClosed) {
      try { currentUrl    = page.url(); }           catch { currentUrl    = 'sync_error'; }
      try { whatsappTitle = await page.title(); }   catch { whatsappTitle = 'async_error'; }
      try { navigatorOnline  = await page.evaluate(() => navigator.onLine); }          catch { navigatorOnline  = 'eval_error'; }
      try { visibilityState  = await page.evaluate(() => document.visibilityState); }  catch { visibilityState  = 'eval_error'; }
    }

    const authFolderExists = fs.existsSync(this._getSessionDir(numberId));

    const listeners = clientExists ? {
      qr:            client.listenerCount?.('qr')            ?? null,
      ready:         client.listenerCount?.('ready')         ?? null,
      authenticated: client.listenerCount?.('authenticated') ?? null,
      disconnected:  client.listenerCount?.('disconnected')  ?? null,
      auth_failure:  client.listenerCount?.('auth_failure')  ?? null,
    } : null;

    const snapshot = {
      waState:         state?.waState         ?? 'not_in_map',
      clientExists,
      browserExists,
      browserConnected,
      pageExists,
      pageClosed,
      currentUrl,
      whatsappTitle,
      navigatorOnline,
      visibilityState,
      qrActive:        state?.waState === 'qr_ready',
      lastReadyAt:     state?.lastReadyAt?.toISOString()   ?? null,
      lastHeartbeatAt: state?.lastHeartbeat?.toISOString() ?? null,
      authFolderExists,
      flags: {
        terminating: state?.terminating ?? null,
        destroying:  state?.destroying  ?? null,
        starting:    state?.starting    ?? null,
        destroyed:   state?.destroyed   ?? null,
      },
      listeners,
      ts: new Date().toISOString(),
    };

    this.logger.log(`[WA_DEBUG_SNAPSHOT] ${JSON.stringify(snapshot)}`);
    return snapshot;
  }

  private _getActiveNumberId(): string | null {
    const ACTIVE: WaState[] = ['booting', 'qr_ready', 'authenticating', 'ready'];
    for (const [id, s] of this.clients) {
      if (ACTIVE.includes(s.waState)) return id;
    }
    return null;
  }

  private _logMetrics(): void {
    this.logger.log(`[STABILITY_METRIC] ${JSON.stringify({ ...this._metrics, ts: new Date().toISOString() })}`);
  }

  private async _updateNumberConnected(numberId: string): Promise<void> {
    this.logger.log(`[WA_STATE_WRITE] ${JSON.stringify({ id: numberId, next: 'ready', reason: 'ready_event', ts: new Date().toISOString() })}`);
    this.logger.log(`[WA_DB_SYNC] attempting READY persistence → ${numberId}`);
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const result = await this.numberRepo.update(numberId, { wa_state: 'ready', last_connected_at: new Date() });
        const rowsAffected = (result as any)?.affected ?? 'unknown';
        this.logger.log(`[WA_DB_SYNC] READY persisted → ${numberId} rowsAffected=${rowsAffected}`);

        // Hard verify: read back the stored value. If it's not 'ready', something is wrong.
        let verify: any;
        try {
          verify = await this.numberRepo.findOne({ where: { id: numberId as any } });
        } catch (readErr: any) {
          this.logger.warn(`[WA_DB_SYNC] read-back failed (non-fatal) → ${numberId}: ${readErr?.message}`);
          return; // write succeeded, read-back is diagnostic — proceed
        }
        this.logger.log(`[WA_DB_SYNC] verify → id=${numberId} wa_state=${JSON.stringify(verify?.wa_state)} last_connected_at=${verify?.last_connected_at?.toISOString?.() ?? null}`);
        if (verify?.wa_state !== 'ready') {
          const msg = `[WA_DB_SYNC] HARD FAILURE — verify wa_state=${JSON.stringify(verify?.wa_state)} expected='ready' — ${numberId}`;
          this.logger.error(msg);
          throw new Error(msg);
        }
        return;
      } catch (e: any) {
        if (attempt < 2) {
          this.logger.warn(`[WA_DB_SYNC] READY write failed (attempt ${attempt}) → ${numberId}: ${e?.message} — retrying in 3s`);
          await new Promise<void>((r) => setTimeout(r, 3_000));
        } else {
          this.logger.error(`[WA_DB_SYNC] READY persistence failed → ${numberId}: ${e?.message}`);
          throw e;
        }
      }
    }
  }
}
