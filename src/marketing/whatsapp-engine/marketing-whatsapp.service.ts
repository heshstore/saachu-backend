import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as fs from 'fs';
import * as path from 'path';
import { ReplaySubject, Observable, interval, merge } from 'rxjs';
import { map } from 'rxjs/operators';
import { WhatsappNumber } from './entities/whatsapp-number.entity';

const WA_AUTH_DATA_PATH = '.wwebjs_auth_marketing';
const INIT_STAGGER_MS   = 15_000;   // 15s between startup forks — never all at once
const WATCHDOG_MS       = 60_000;   // health check interval per number

// Reconnect backoff schedule: 10s → 30s → 60s → 120s (capped at last value)
const RETRY_DELAYS_MS = [10_000, 30_000, 60_000, 120_000] as const;

const CHROMIUM_LOCK_FILES = [
  'SingletonLock', 'SingletonSocket', 'SingletonCookie', 'DevToolsActivePort',
] as const;

type WaState =
  | 'initializing'
  | 'qr_ready'
  | 'authenticating'
  | 'ready'
  | 'reconnecting'
  | 'disconnected'
  | 'auth_failure';

interface NumberClientState {
  client: any;
  waState: WaState;
  ready: boolean;
  initializing: boolean;
  // True during intentional ops (disconnect/reset) — suppresses auto-reconnect.
  manualDisconnect: boolean;
  // True only during onModuleDestroy — prevents any reconnect after shutdown.
  destroyed: boolean;
  retryCount: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
  watchdogTimer: ReturnType<typeof setInterval> | null;
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
    waState: 'initializing',
    ready: false,
    initializing: false,
    manualDisconnect: false,
    destroyed: false,
    retryCount: 0,
    retryTimer: null,
    watchdogTimer: null,
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

  constructor(
    @InjectRepository(WhatsappNumber)
    private readonly numberRepo: Repository<WhatsappNumber>,
  ) {}

  async onModuleInit() {
    let rows: WhatsappNumber[] = [];
    try {
      rows = await this.numberRepo.find({ where: { is_active: true } });
    } catch (e: any) {
      this.logger.warn(`[MKT_WA] Could not load numbers on init: ${e?.message}`);
      return;
    }
    this.logger.log(`[MKT_WA] Startup — connecting ${rows.length} active number(s), staggered ${INIT_STAGGER_MS / 1000}s apart`);
    rows.forEach((num, idx) => {
      setTimeout(() => {
        this.connectNumber(num.id).catch((e) =>
          this.logger.error(`[MKT_WA] Startup connect failed for ${num.phone}: ${e?.message}`),
        );
      }, idx * INIT_STAGGER_MS);
    });
  }

  async onModuleDestroy() {
    this.logger.log('[MKT_WA] Shutdown — destroying all clients');
    const shutdowns: Promise<void>[] = [];
    for (const [, state] of this.clients) {
      state.destroyed = true;
      this._clearTimers(state);
      if (state.client) {
        shutdowns.push(
          state.client.destroy().catch(() => { /* ignore */ }).then(() => { state.client = null; }),
        );
      }
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
    if (state.initializing) {
      this.logger.log(`[MKT_WA:${numberId}] connect skipped — already initializing`);
      return;
    }
    if (state.client) {
      this.logger.log(`[MKT_WA:${numberId}] connect skipped — client already exists`);
      return;
    }

    state.initializing = true;
    state.qrSubject.next(JSON.stringify({ type: 'state_change', state: 'initializing', timestamp: new Date().toISOString() }));

    try {
      await this._initClient(numberId, state);
    } catch (e: any) {
      this.logger.error(`[MKT_WA:${numberId}] Init error: ${e?.message}`);
      state.qrSubject.next(JSON.stringify({ type: 'error', message: `Init failed: ${e?.message}` }));
      // Schedule a reconnect attempt unless this was intentional
      if (!state.manualDisconnect && !state.destroyed) {
        this._scheduleReconnect(numberId, state);
      }
    } finally {
      state.initializing = false;
    }
  }

  async disconnectNumber(numberId: string): Promise<void> {
    const state = this.clients.get(numberId);
    if (!state) return;
    this.logger.log(`[NUMBER_DISCONNECTED] ${numberId}`);
    state.manualDisconnect = true;
    state.ready = false;
    this._clearTimers(state);     // cancel any pending retry
    state.retryCount = 0;         // reset backoff for next user-initiated connect
    if (state.client) {
      try { await state.client.destroy(); } catch { /* ignore */ }
      state.client = null;
    }
    state.qrDataUrl = null;
    state.qrGeneratedAt = null;
    state.manualDisconnect = false;
    this._transitionState(numberId, state, 'disconnected');
    await this._updateNumberWaState(numberId, 'disconnected');
  }

  async resetNumber(numberId: string): Promise<void> {
    const state = this.clients.get(numberId);
    if (state?.initializing) {
      this.logger.log(`[MKT_WA:${numberId}] reset skipped — initializing`);
      return;
    }
    this.logger.log(`[MKT_WA:${numberId}] Session reset — wiping auth`);
    if (state) {
      state.manualDisconnect = true;
      state.ready = false;
      this._clearTimers(state);
      state.retryCount = 0;
      if (state.client) {
        try { await state.client.logout(); } catch { /* already gone */ }
        try { await state.client.destroy(); } catch { /* ignore */ }
        state.client = null;
      }
      state.qrDataUrl = null;
      state.qrGeneratedAt = null;
      state.manualDisconnect = false;
    }
    await this._clearAuthFiles(numberId);
    await this._updateNumberWaState(numberId, 'initializing');
    await new Promise<void>((r) => setTimeout(r, 2_000));
    setImmediate(() => this.connectNumber(numberId).catch((e) =>
      this.logger.error(`[MKT_WA:${numberId}] Post-reset connect failed: ${e?.message}`),
    ));
  }

  /** True if the specific number's WA client is live, browser open, and session ready. */
  isConnected(numberId: string): boolean {
    const state = this.clients.get(numberId);
    if (!state?.ready || !state.client || state.initializing || state.destroyed) return false;
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

    // Hard safety gate — all conditions must pass before attempting send
    if (!state || state.destroyed) {
      throw new Error(`[SEND_SKIPPED] ${numberId} — no client state`);
    }
    if (state.initializing) {
      throw new Error(`[SEND_SKIPPED] ${numberId} — reconnecting`);
    }
    if (!state.ready || !state.client) {
      throw new Error(`[SEND_SKIPPED] ${numberId} — not ready`);
    }

    const page = state.client.pupPage;
    const browserAlive = state.client.pupBrowser?.isConnected?.() ?? false;
    const pageOpen = page != null && !page.isClosed();
    if (!browserAlive || !pageOpen) {
      this.logger.warn(`[SEND_SKIPPED] ${numberId} — browser unhealthy, triggering recovery`);
      state.ready = false;
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
    return {
      active:      qrReady,
      qr:          qrReady ? (state!.qrDataUrl ?? null) : null,
      generatedAt: qrReady ? (state!.qrGeneratedAt?.toISOString() ?? null) : null,
    };
  }

  getNumberWaStatus(numberId: string): {
    waState: WaState;
    connected: boolean;
    initializing: boolean;
    qrActive: boolean;
    retryCount: number;
    lastReadyAt: string | null;
    disconnectedAt: string | null;
  } {
    const state = this.clients.get(numberId);
    if (!state) {
      return {
        waState: 'disconnected', connected: false, initializing: false,
        qrActive: false, retryCount: 0, lastReadyAt: null, disconnectedAt: null,
      };
    }
    return {
      waState:        state.waState,
      connected:      this.isConnected(numberId),
      initializing:   state.initializing,
      qrActive:       state.waState === 'qr_ready',
      retryCount:     state.retryCount,
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

  // ── Reconnect backoff ────────────────────────────────────────────────────────

  private _scheduleReconnect(numberId: string, state: NumberClientState): void {
    if (state.destroyed || state.manualDisconnect) return;
    if (state.retryTimer) return; // already scheduled

    const idx   = Math.min(state.retryCount, RETRY_DELAYS_MS.length - 1);
    const delay = RETRY_DELAYS_MS[idx];
    state.retryCount++;

    this.logger.log(`[NUMBER_RESTARTED] ${numberId} — attempt ${state.retryCount} in ${delay / 1000}s`);
    this._transitionState(numberId, state, 'reconnecting');

    state.retryTimer = setTimeout(async () => {
      state.retryTimer = null;
      if (state.destroyed || state.manualDisconnect) return;

      // Destroy the stale client before re-init
      if (state.client) {
        try { await state.client.destroy(); } catch { /* ignore */ }
        state.client = null;
      }
      state.ready = false;
      state.initializing = true;

      try {
        await this._initClient(numberId, state);
      } catch (e: any) {
        this.logger.error(`[MKT_WA:${numberId}] Reconnect attempt failed: ${e?.message}`);
        state.qrSubject.next(JSON.stringify({ type: 'error', message: `Reconnect failed: ${e?.message}` }));
        this._scheduleReconnect(numberId, state); // next backoff tier
      } finally {
        state.initializing = false;
      }
    }, delay);
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
      // Skip if not connected, already reconnecting, or a reconnect is already queued
      if (!state.ready || !state.client || state.initializing || state.retryTimer) return;

      const page = state.client.pupPage;
      const browserAlive = state.client.pupBrowser?.isConnected?.() ?? false;
      const pageOpen = page != null && !page.isClosed();

      if (!browserAlive || !pageOpen) {
        this.logger.warn(`[CLIENT_RECOVERED] ${numberId} — watchdog detected unhealthy browser`);
        state.ready = false;
        this._scheduleReconnect(numberId, state);
      }
    }, WATCHDOG_MS);
  }

  // ── Core init per number ─────────────────────────────────────────────────────

  private async _initClient(numberId: string, state: NumberClientState): Promise<void> {
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
    this._removeSingletonFiles(numberId);

    state.client = new Client({
      authStrategy: new LocalAuth({
        clientId: `marketing-${numberId}`,
        dataPath: WA_AUTH_DATA_PATH,
      }),
      puppeteer: {
        headless: true,
        ...(executablePath ? { executablePath } : {}),
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      },
      userAgent: false as unknown as string,
      webVersionCache: { type: 'none' },
    });

    // ── Event handlers ──────────────────────────────────────────────────────────

    state.client.on('qr', async (qr: string) => {
      let QRCode: any;
      try { QRCode = (await import('qrcode')).default; } catch { return; }
      const dataUrl = await QRCode.toDataURL(qr, { width: 300 });
      this._transitionState(numberId, state, 'qr_ready');
      state.qrDataUrl = dataUrl;
      state.qrGeneratedAt = new Date();
      state.qrSubject.next(JSON.stringify({ type: 'qr', dataUrl, timestamp: new Date().toISOString() }));
      await this._updateNumberWaState(numberId, 'qr_ready');
    });

    state.client.on('authenticated', () => {
      this._transitionState(numberId, state, 'authenticating');
      state.qrDataUrl = null;
      state.qrGeneratedAt = null;
      state.qrSubject.next(JSON.stringify({ type: 'authenticated', timestamp: new Date().toISOString() }));
    });

    state.client.on('remote_session_saved', () => { /* session persisted to disk */ });

    state.client.on('ready', async () => {
      if (state.ready) return;
      state.ready = true;
      state.qrDataUrl = null;
      state.qrGeneratedAt = null;
      state.retryCount = 0; // reset backoff on successful connect
      if (state.disconnectedAt) state.disconnectedAt = null;
      state.lastReadyAt = new Date();
      this._transitionState(numberId, state, 'ready');
      const phone = state.client?.info?.wid?.user ?? null;
      this.logger.log(`[NUMBER_CONNECTED] ${numberId} (+${phone})`);
      state.qrSubject.next(JSON.stringify({ type: 'ready', phone, timestamp: new Date().toISOString() }));
      await this._updateNumberConnected(numberId);
    });

    state.client.on('disconnected', async (reason: string) => {
      if (reason === 'NAVIGATION') return; // internal WA page transition — ignore
      state.ready = false;
      if (!state.disconnectedAt) state.disconnectedAt = new Date();
      this._transitionState(numberId, state, 'disconnected');
      state.qrSubject.next(JSON.stringify({ type: 'disconnected', reason, timestamp: new Date().toISOString() }));
      await this._updateNumberWaState(numberId, 'disconnected');
      this.logger.log(`[NUMBER_DISCONNECTED] ${numberId} reason=${reason}`);
      // Auto-reconnect unless this disconnect was intentional
      if (!state.manualDisconnect && !state.destroyed) {
        this._scheduleReconnect(numberId, state);
      }
    });

    state.client.on('auth_failure', async (msg: string) => {
      state.ready = false;
      state.qrDataUrl = null;
      state.qrGeneratedAt = null;
      if (!state.disconnectedAt) state.disconnectedAt = new Date();
      this._transitionState(numberId, state, 'auth_failure');
      state.qrSubject.next(JSON.stringify({
        type: 'error',
        message: 'Auth failed — use Reset to re-pair.',
        timestamp: new Date().toISOString(),
      }));
      await this._updateNumberWaState(numberId, 'auth_failure');
      // Do NOT auto-reconnect on auth_failure — user must reset session
      this.logger.warn(`[MKT_WA:${numberId}] Auth failure: ${msg}`);
    });

    // Marketing engine never handles inbound messages.

    await state.client.initialize();
  }

  // ── Private helpers ───────────────────────────────────────────────────────────

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
      process.env.CHROME_PATH,
      process.env.PUPPETEER_EXECUTABLE_PATH,
      '/usr/bin/google-chrome-stable',
      '/usr/bin/google-chrome',
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium',
      '/snap/bin/chromium',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
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

  private async _updateNumberWaState(numberId: string, waState: string): Promise<void> {
    try {
      await this.numberRepo.update(numberId, { wa_state: waState });
    } catch { /* DB unavailable — in-memory state is authoritative */ }
  }

  private async _updateNumberConnected(numberId: string): Promise<void> {
    try {
      await this.numberRepo.update(numberId, { wa_state: 'ready', last_connected_at: new Date() });
    } catch { /* DB unavailable — continue */ }
  }
}
