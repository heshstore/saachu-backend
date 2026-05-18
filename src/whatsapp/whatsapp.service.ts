import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import * as crypto from 'crypto';
import { ReplaySubject, Observable, interval, merge } from 'rxjs';
import { map } from 'rxjs/operators';
import { WhatsAppSession } from './entities/whatsapp-session.entity';
import { WhatsAppMessage } from './entities/whatsapp-message.entity';
import { appConfig } from '../config/config';
import { LeadSource } from '../crm/entities/lead.entity';
import { normalizePhone } from '../crm/normalizers/lead-normalizer';

/** Pinned stable WA Web build — never fetch alpha/latest from GitHub. */
const PINNED_WA_WEB_VERSION = '2.2412.54';

/** Fixed LocalAuth identity — must not change between restarts. */
const WA_LOCAL_AUTH_CLIENT_ID = 'saachu-main';

/** Persistent auth root (relative to process.cwd()). */
const WA_AUTH_DATA_PATH = '.wwebjs_auth';

/** Minimum interval between published QR SSE events (WA Web expires ~60s). */
const QR_MIN_INTERVAL_MS = 55_000;

/** Max wait for session restore from disk before declaring auth invalid. */
const RESTORE_TIMEOUT_MS = 120_000;

const POST_RESET_DELAY_MS = 2_000;

// All Chromium profile lock files that block a second browser instance from starting.
// These are transient runtime artefacts — safe to delete before every init attempt.
//   SingletonLock     — primary filesystem mutex Chrome uses to enforce single instance
//   SingletonSocket   — Unix domain socket companion written alongside SingletonLock
//   SingletonCookie   — secondary lock companion (created on some platforms / Chrome builds)
//   DevToolsActivePort — DevTools port file; stale copy blocks Puppeteer's CDP attachment
const CHROMIUM_LOCK_FILES = [
  'SingletonLock',
  'SingletonSocket',
  'SingletonCookie',
  'DevToolsActivePort',
] as const;

function isValidWhatsAppPhone(raw: string): boolean {
  if (!/^\d{8,15}$/.test(raw)) return false;
  if (raw.startsWith('0')) return false;
  if (/^(\d)\1+$/.test(raw)) return false;  // all same digit (e.g. 9999999999)
  return true;
}

@Injectable()
export class WhatsAppService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WhatsAppService.name);
  private client: any = null;
  private _ready = false;
  // Prevents two Chromium instances from racing to open the same LocalAuth directory.
  private _initializing = false;
  // Set true by disconnectAndReset() so the 'disconnected' event it triggers doesn't
  // schedule a second reinit on top of the one disconnectAndReset() already manages.
  private _manualDisconnect = false;
  // Detects silent disconnects: Puppeteer page dies without firing 'disconnected'.
  private _healthTimer: NodeJS.Timeout | null = null;
  // ReplaySubject(1): new SSE subscribers immediately receive the last QR/status event
  private qrSubject = new ReplaySubject<string>(1);
  private sessionName = appConfig.whatsappSessionName;
  private seenMsgIds = new Set<string>();
  private qrCount = 0;
  // True once a QR is displayed and the user hasn't scanned yet.
  // Prevents the retry loop from tearing down the client mid-scan.
  private qrGenerated = false;
  // Timestamp of the most recent unplanned disconnect — used to log recovery duration.
  private _disconnectedAt: Date | null = null;
  // Tracks a pending reinit timer so we can cancel it before scheduling a new one,
  // preventing multiple concurrent timers from stacking up after rapid disconnect/reconnect.
  private _retryTimer: NodeJS.Timeout | null = null;
  // Prevents concurrent post-reconnect recovery scans if ready fires multiple times rapidly.
  private _recovering = false;
  // Admin monitoring state — read-only from outside; mutated only by event handlers below.
  private _lastDisconnectReason: string | null = null;
  private _lastReadyAt: Date | null = null;
  private _qrDataUrl: string | null = null;
  private _qrGeneratedAt: Date | null = null;
  private _adminEventSubject = new ReplaySubject<string>(1);
  // QR retry limit — after this many QR codes without a scan, enter PAUSED state
  // and stop the infinite regeneration loop. Manual reconnect required after this.
  private readonly MAX_QR_RETRIES = 5;
  private _qrPaused = false;
  /** True when persisted LocalAuth data existed before the current init cycle. */
  private _authExistedBeforeInit = false;
  /** True if a QR was emitted during the current init cycle (not a silent restore). */
  private _qrShownThisInit = false;
  private _instanceLockHeld = false;
  private _lastQrPublishedAt: number | null = null;
  private _authInvalid = false;
  private _restoreWatchdog: NodeJS.Timeout | null = null;
  private _preLiveHealthTimer: NodeJS.Timeout | null = null;

  constructor(
    @InjectRepository(WhatsAppSession)
    private sessionRepo: Repository<WhatsAppSession>,
    @InjectRepository(WhatsAppMessage)
    private messageRepo: Repository<WhatsAppMessage>,
    private eventEmitter: EventEmitter2,
  ) {}

  async onModuleInit() {
    this.logger.log('[WA_INIT] Module init — scheduling client bootstrap');
    this.qrSubject.next(JSON.stringify({ type: 'initializing' }));
    setImmediate(() => this.initClient().catch((e) => {
      this.logger.error('[WA_INIT] Bootstrap failed', e?.stack ?? e?.message);
      this.qrSubject.next(JSON.stringify({ type: 'error', message: e?.message }));
    }));
  }

  async onModuleDestroy() {
    this.logger.log('[WA_DESTROY] Module shutting down');
    if (this._retryTimer) {
      clearTimeout(this._retryTimer);
      this._retryTimer = null;
    }
    this.clearRestoreWatchdog();
    this.stopHealthMonitor();
    this.stopPreLiveHealthSnapshot();
    this._ready = false;
    this._manualDisconnect = true;
    if (this.client) {
      try { await this.client.destroy(); } catch { /* ignore */ }
      this.client = null;
    }
    this._manualDisconnect = false;
    this.releaseInstanceLock();
  }

  // ── Core init ────────────────────────────────────────────────────────────────

  private async initClient() {
    // Guard: prevent two Chromium instances racing on the same LocalAuth directory.
    // This is the root cause of "browser is already running for session ..." errors.
    if (this._initializing) {
      this.logger.warn('[WA_INIT] initClient() skipped — already initializing');
      return;
    }
    if (this.client) {
      this.logger.warn('[WA_INIT] initClient() skipped — client already exists');
      return;
    }
    await this.ensureNoOrphanChromium();

    if (!this.tryAcquireInstanceLock()) {
      this.qrSubject.next(JSON.stringify({
        type: 'error',
        message: 'Another backend instance is already running WhatsApp. Stop the duplicate process and refresh.',
      }));
      return;
    }

    if (this.sessionName !== WA_LOCAL_AUTH_CLIENT_ID) {
      this.logger.warn(
        `[WA_INIT] WHATSAPP_SESSION=${this.sessionName} differs from pinned clientId ${WA_LOCAL_AUTH_CLIENT_ID}`,
      );
    }

    this._initializing = true;
    this._authInvalid = false;
    this.logger.log(
      `[WA_INIT] Starting client (clientId=${WA_LOCAL_AUTH_CLIENT_ID}, webVersion=${PINNED_WA_WEB_VERSION}, pid=${process.pid}, authDir=${this.getSessionDir()})`,
    );
    const MAX_ATTEMPTS = 3;

    try {
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        this.logger.log(`[WhatsApp] Init attempt ${attempt}/${MAX_ATTEMPTS} (session=${this.sessionName})`);

        // Destroy any partial client from a previous failed attempt
        if (this.client) {
          try { await this.client.destroy(); } catch { /* ignore */ }
          this.client = null;
        }

        // Kill stale Chrome processes and remove ALL lock files before every attempt
        await this.cleanSessionLocks();
        // Give the OS 1 s to release file handles before Puppeteer opens them again
        await new Promise<void>((r) => setTimeout(r, 1_000));

        try {
          await this._initClientInner();
          this.logger.log(`[WhatsApp] Init succeeded on attempt ${attempt}`);
          return;
        } catch (e: any) {
          this.logger.error(
            `[WhatsApp] Init attempt ${attempt}/${MAX_ATTEMPTS} failed: ${e?.message}`,
            e?.stack,
          );

          // QR was shown before the error — the user may be mid-scan.
          // Abort the retry loop and leave the client alive so the scan can complete.
          if (this.qrGenerated) {
            this.logger.warn('[WhatsApp] QR already shown — aborting retries to let user scan');
            return;
          }

          if (attempt < MAX_ATTEMPTS) {
            this.logger.log(`[WhatsApp] Retrying in 15 s... (next: attempt ${attempt + 1}/${MAX_ATTEMPTS}) — waiting for Chrome to fully exit`);
            this.qrSubject.next(JSON.stringify({
              type: 'retrying',
              attempt: attempt + 1,
              maxAttempts: MAX_ATTEMPTS,
              message: `Init failed — retrying (${attempt + 1}/${MAX_ATTEMPTS})`,
            }));
            await new Promise<void>((r) => setTimeout(r, 15_000));
          } else {
            // Final attempt failed — remove only lock files so the next initClient()
            // can reuse the saved auth session (avoids forced QR re-login on transient failures).
            this.logger.warn('[WhatsApp] All attempts exhausted — removing lock files only (preserving auth session)');
            const sessionDir = this.getSessionDir();
            const lockFiles = ['SingletonLock', 'SingletonSocket', 'SingletonCookie'];
            for (const f of lockFiles) {
              const p = path.join(sessionDir, f);
              try { fs.unlinkSync(p); } catch { /* file absent — safe to ignore */ }
            }
          }
        }
      }

      // All attempts exhausted
      this.logger.error(`[WhatsApp] All ${MAX_ATTEMPTS} init attempts failed — giving up`);
      this.qrSubject.next(JSON.stringify({
        type: 'error',
        message: `WhatsApp failed to start after ${MAX_ATTEMPTS} attempts. Check server logs.`,
      }));
    } finally {
      // Always release the lock so reinitClient() can try again later
      this._initializing = false;
    }
  }

  private async _initClientInner() {
    let Client: any, LocalAuth: any;
    try {
      const wwebjs = await import('whatsapp-web.js');
      Client = wwebjs.Client;
      LocalAuth = wwebjs.LocalAuth;
    } catch (e) {
      this.logger.warn('[WhatsApp] whatsapp-web.js not available:', e?.message);
      return;
    }

    const executablePath = this.findChrome();
    this.logger.log(`[WA_INIT] Launching Chromium${executablePath ? ` at ${executablePath}` : ' (bundled/auto)'}`);

    this.qrCount = 0;
    this._qrShownThisInit = false;
    this._lastQrPublishedAt = null;
    this._authExistedBeforeInit = this.hasPersistedAuth();
    if (this._authExistedBeforeInit) {
      this.logger.log('[WA_INIT] Persisted auth found — expecting session restore without QR');
      this.startRestoreWatchdog();
    }

    this.logger.log('[WA_DEBUG] creating client');
    this.client = new Client({
      authStrategy: new LocalAuth({
        clientId: WA_LOCAL_AUTH_CLIENT_ID,
        dataPath: WA_AUTH_DATA_PATH,
      }),
      webVersion: PINNED_WA_WEB_VERSION,
      // 'none' uses the no-op WebCache base class — resolve() returns null and persist()
      // does nothing. Prevents LocalWebCache.persist() from crashing on the changed WA
      // HTML bundle format (regex no longer matches → null[1] → TypeError).
      webVersionCache: { type: 'none' },
      puppeteer: {
        headless: true,
        ...(executablePath ? { executablePath } : {}),
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--disable-gpu',
          '--no-first-run',
          '--no-zygote',
          // '--single-process' intentionally removed: causes Chromium to crash mid-handshake,
          // which interrupts the WebSocket pairing after QR scan → "Couldn't link device"
          '--disable-extensions',
          '--disable-background-networking',
          '--disable-default-apps',
          '--mute-audio',
          // Prevents WA Web from detecting navigator.webdriver = true
          '--disable-blink-features=AutomationControlled',
        ],
      },
    });

    // ── Event handlers ──────────────────────────────────────────────────────────
    this.logger.log('[WA_DEBUG] attaching listeners');

    this.client.on('qr', async (qr: string) => {
      this.clearRestoreWatchdog();

      const now = Date.now();
      if (this._lastQrPublishedAt && now - this._lastQrPublishedAt < QR_MIN_INTERVAL_MS) {
        return;
      }

      if (this._authExistedBeforeInit) {
        // WA servers rejected the stored session and are requesting a new QR.
        // Clear the stale auth files so the user can re-pair without a manual Reset Session.
        // Do NOT destroy the client here — fall through to normal QR display.
        this.logger.warn('[WA_QR] Stored session rejected by WA — clearing stale auth, showing fresh QR');
        this._authExistedBeforeInit = false;
        await this.clearAuthFiles();
      }

      if (this.qrCount > 0) {
        this.logger.log(`[WA_QR_EXPIRED] QR #${this.qrCount} expired without scan`);
      }

      this.qrCount++;

      if (this.qrCount > this.MAX_QR_RETRIES) {
        this.logger.warn(`[WA_QR_SCAN_TIMEOUT] ${this.MAX_QR_RETRIES} QR cycles without pairing — manual reset required`);
        this._qrPaused = true;
        this._qrDataUrl = null;
        this._qrGeneratedAt = null;
        this.qrSubject.next(JSON.stringify({
          type: 'paused',
          message: 'WhatsApp disconnected — QR retry limit reached. Click "Reset Session" to try again.',
        }));
        this._adminEventSubject.next(JSON.stringify({ type: 'paused', qrCount: this.qrCount, timestamp: new Date().toISOString() }));
        await this.updateSession({ status: 'DISCONNECTED' });
        setImmediate(async () => {
          this._manualDisconnect = true;
          if (this.client) {
            try { await this.client.destroy(); } catch { /* ignore */ }
            this.client = null;
          }
          this._manualDisconnect = false;
        });
        return;
      }

      this.qrGenerated = true;
      this._qrShownThisInit = true;
      this._lastQrPublishedAt = now;
      this.logger.log(`[WA_QR_GENERATED] QR #${this.qrCount} published (~60s WA Web expiry)`);

      let QRCode: any;
      try { QRCode = (await import('qrcode')).default; } catch { return; }
      const dataUrl = await QRCode.toDataURL(qr, { width: 300 });

      const payload: Record<string, any> = {
        type:     'qr',
        dataUrl,
        qrIndex:  this.qrCount,
        expired:  this.qrCount > 1,
      };

      if (this.qrCount >= 3) {
        payload.warning =
          'QR has expired multiple times without a successful scan. ' +
          'Click "Reset Session" to start fresh, or wait for auto-pause after ' +
          `${this.MAX_QR_RETRIES} attempts.`;
      }

      this._qrDataUrl = dataUrl;
      this._qrGeneratedAt = new Date();
      this._adminEventSubject.next(JSON.stringify({ type: 'qr', qrIndex: this.qrCount, expired: this.qrCount > 1, timestamp: new Date().toISOString() }));
      this.qrSubject.next(JSON.stringify(payload));
      await this.updateSession({ status: 'CONNECTING', qr_code: dataUrl });
    });

    // Fires after the QR is scanned and the cryptographic handshake succeeds,
    // but before the WA Web session is fully loaded. Logs WHERE in the pairing
    // flow we are — if we see 'authenticated' but never 'ready', the issue is
    // in session loading (likely a WA version mismatch or network timeout).
    this.client.on('authenticated', () => {
      this.logger.log('[WA_DEBUG] authenticated fired');
      this.clearRestoreWatchdog();
      this.logger.log('[WA_QR_SCAN_SUCCESS] QR scanned — cryptographic pairing approved');
      this.logger.log('[WA_AUTH] Waiting for session load — ready watchdog starts (45s)');
      this.qrSubject.next(JSON.stringify({ type: 'authenticated' }));
      this._adminEventSubject.next(JSON.stringify({ type: 'authenticated', timestamp: new Date().toISOString() }));

      // Watchdog: if ready doesn't fire within 45s, diagnose exact WA state.
      // If waState=CONNECTED and wid exists, the session IS live but 'ready' was silently
      // dropped (happens on some WA Web builds) — invoke finalizeReadyState as fallback.
      const watchdog = setTimeout(async () => {
        if (this._ready) return;
        const waState = await this.client?.getState?.().catch(() => null);
        const wid     = this.client?.info?.wid;
        this.logger.error(
          `[WA_READY_WATCHDOG] ready not received 45s after authenticated — ` +
          `waState=${waState ?? 'unknown'} wid=${wid ? JSON.stringify(wid) : 'null'}`,
        );
        if (waState === 'CONNECTED' && wid) {
          this.logger.warn('[WA_READY_WATCHDOG] session IS live — invoking finalizeReadyState (authenticated_watchdog)');
          await this.finalizeReadyState('authenticated_watchdog');
          return;
        }
        this._adminEventSubject.next(JSON.stringify({
          type: 'error',
          message: `Session load stalled after QR scan (45s). waState=${waState ?? '?'}. Click Reset Session.`,
          timestamp: new Date().toISOString(),
        }));
        this.qrSubject.next(JSON.stringify({
          type: 'error',
          message: 'WhatsApp session is taking too long to load. Click "Reset Session" to try again.',
        }));
      }, 45_000);
      watchdog.unref?.();
    });

    this.client.on('remote_session_saved', () => {
      this.logger.log('[WA_SESSION_SAVED] LocalAuth session persisted to disk');
      this._adminEventSubject.next(JSON.stringify({ type: 'session_saved', timestamp: new Date().toISOString() }));
    });

    // Fires on internal WA Web state machine transitions:
    // UNPAIRED → OPENING → PAIRING → PAIRED → (ready event)
    // Logging these lets us see exactly where a stalled pairing is stuck.
    this.client.on('change_state', async (state: string) => {
      this.logger.log(`[WhatsApp] State → ${state}`);
      this.qrSubject.next(JSON.stringify({ type: 'change_state', state }));
      this._adminEventSubject.next(JSON.stringify({ type: 'change_state', state, timestamp: new Date().toISOString() }));

      // Fallback: some WA Web builds transition to CONNECTED state without ever firing 'ready'.
      // If we have a wid, the session is live — finalize it here.
      if (state === 'CONNECTED' && !this._ready) {
        const wid = this.client?.info?.wid;
        if (wid) {
          this.logger.warn(`[WA_CHANGE_STATE_FALLBACK] CONNECTED state with wid but ready not fired — invoking finalizeReadyState`);
          await this.finalizeReadyState('change_state_fallback');
        }
      }
    });

    this.client.on('ready', async () => {
      this.logger.log('[WA_DEBUG] ready fired');
      await this.finalizeReadyState('ready_event');

      // Attach Puppeteer page-level listeners. Only possible here where pupPage exists.
      const page = this.client?.pupPage;
      if (page && !page.isClosed()) {
        page.on('framenavigated', (frame: any) => {
          if (frame === page.mainFrame()) {
            this.logger.log('[WhatsApp] Main frame navigated — transient execution context loss expected');
          }
        });
        page.on('load', () => {
          this.logger.log('[WhatsApp] Page load event — WA Web context reattaching');
        });
        page.on('error', (err: Error) => {
          this.logger.error(`[WA_PAGE_ERROR] Chromium page error: ${err?.message}`);
        });
        page.on('pageerror', (err: Error) => {
          this.logger.warn(`[WA_PAGE_JS_ERROR] WA Web JS error: ${err?.message}`);
        });
        page.on('close', () => {
          this.logger.warn('[WA_PAGE_CLOSED] Puppeteer page closed unexpectedly');
          if (this._ready && !this._manualDisconnect) {
            this._ready = false;
            this.stopHealthMonitor();
            this.qrSubject.next(JSON.stringify({ type: 'disconnected', reason: 'PAGE_CLOSED' }));
            this.scheduleReinit(5_000);
          }
        });

        const browser = (page as any).browser?.();
        if (browser) {
          browser.on('disconnected', () => {
            this.logger.error('[WA_BROWSER_CRASH] Puppeteer browser process disconnected');
            if (this._ready && !this._manualDisconnect) {
              this._ready = false;
              this.stopHealthMonitor();
              this.client = null;
              this.qrSubject.next(JSON.stringify({ type: 'disconnected', reason: 'BROWSER_CRASH' }));
              this.scheduleReinit(8_000);
            }
          });
        }
      }
    });

    this.client.on('disconnected', async (reason: string) => {
      this.logger.warn(`[WhatsApp] Disconnected: ${reason}`);

      // NAVIGATION fires during normal WA Web page transitions — NOT a real disconnect.
      // Do NOT set _ready = false; the session is still alive.
      if (reason === 'NAVIGATION') {
        this.logger.log('[WhatsApp] Ignoring NAVIGATION — internal page transition');
        return;
      }

      this._ready = false;
      this._lastDisconnectReason = reason;
      this.stopHealthMonitor();
      if (!this._disconnectedAt) {
        this._disconnectedAt = new Date();
        this.logger.log('[WhatsApp] Session downtime started');
      }
      this._adminEventSubject.next(JSON.stringify({ type: 'disconnected', reason, timestamp: new Date().toISOString() }));
      await this.updateSession({ status: 'DISCONNECTED', disconnected_at: this._disconnectedAt });
      this.qrSubject.next(JSON.stringify({ type: 'disconnected', reason }));

      // disconnectAndReset() sets _manualDisconnect before calling logout() to prevent
      // this event from scheduling a parallel reinit — it handles reinit itself.
      if (this._manualDisconnect) {
        this.logger.log('[WhatsApp] Disconnected event from manual reset — reinit handled separately');
        return;
      }

      // Raise a system-level alert. LeadAlertService handles dedup (only one open alert at a time).
      this.eventEmitter.emit('whatsapp.down', { reason });

      if (reason === 'CONFLICT') {
        // Another session is active — reiniting immediately just loops forever.
        this.eventEmitter.emit('whatsapp.down', { reason: 'CONFLICT' });
        this.qrSubject.next(JSON.stringify({
          type: 'error',
          message: 'WhatsApp conflict: another session is using this account. Close web.whatsapp.com or other linked devices, then click "Force Reconnect".',
        }));
        this.logger.warn('[WhatsApp] CONFLICT — waiting for user to resolve via Force Reconnect');
        return;
      }

      // Terminal reasons: wipe auth files so the next init generates a fresh QR.
      // Keep the version cache — no need to re-fetch WA Web for a simple re-auth.
      const terminalReasons = ['LOGOUT', 'UNPAIRED', 'UNPAIRED_IDLE'];
      if (terminalReasons.includes(reason)) {
        this.logger.log(`[WhatsApp] Terminal disconnect (${reason}) — clearing auth files`);
        await this.clearAuthFiles();
      }

      if (!this._authInvalid) {
        this.logger.log(`[WA_RECONNECT] Scheduling reconnect in 10s (reason=${reason})`);
        this.scheduleReinit(10_000);
      }
    });

    this.client.on('auth_failure', async (msg: string) => {
      this._ready = false;
      this._adminEventSubject.next(JSON.stringify({ type: 'auth_failure', message: msg, timestamp: new Date().toISOString() }));
      this.logger.error(`[WA_AUTH_FAILURE] ${msg}`);
      if (!this._disconnectedAt) {
        this._disconnectedAt = new Date();
      }
      await this.updateSession({ status: 'DISCONNECTED', disconnected_at: this._disconnectedAt });
      this.qrSubject.next(JSON.stringify({
        type: 'error',
        message: 'Authentication failed. Use "Reset Session" to pair again.',
      }));
      this.eventEmitter.emit('whatsapp.down', { reason: 'AUTH_FAILURE' });
      await this.handleAuthInvalid(`auth_failure: ${msg}`);
    });

    // ── Inbound message handler ─────────────────────────────────────────────────

    const onMsg = async (msg: any) => {
      if (msg.fromMe) return;
      const msgId = msg.id?._serialized ?? `${msg.from}-${msg.timestamp}`;
      if (this.seenMsgIds.has(msgId)) return;
      this.seenMsgIds.add(msgId);
      // Prevent unbounded growth
      if (this.seenMsgIds.size > 500) {
        const first = this.seenMsgIds.values().next().value;
        this.seenMsgIds.delete(first);
      }
      this.logger.log(`[WhatsApp] Inbound from=${msg.from} id=${msgId}`);
      await this.handleInbound(msg);
    };

    this.client.on('loading_screen', (percent: number, message: string) => {
      this.logger.log(`[WhatsApp] Loading ${percent}% — ${message}`);
      this._adminEventSubject.next(JSON.stringify({ type: 'loading', percent, message, timestamp: new Date().toISOString() }));
    });

    this.client.on('message', onMsg);
    this.client.on('message_create', onMsg);
    this.logger.log('[WA_DEBUG] listeners attached');

    // ── Pre-init diagnostics ────────────────────────────────────────────────────
    // Log session directory state and lock file presence so startup failures
    // leave an auditable trail without requiring a second run to diagnose.
    const _diagSessionDir = this.getSessionDir();
    const _diagDirExists  = fs.existsSync(_diagSessionDir);
    this.logger.log(`[WhatsApp] Pre-init: sessionDir=${_diagSessionDir} exists=${_diagDirExists}`);
    if (_diagDirExists) {
      const presentLocks = CHROMIUM_LOCK_FILES.filter((f) => fs.existsSync(path.join(_diagSessionDir, f)));
      if (presentLocks.length > 0) {
        this.logger.warn(`[WhatsApp] Pre-init: lock files still present — ${presentLocks.join(', ')}`);
      } else {
        this.logger.log('[WhatsApp] Pre-init: no lock files found — session directory is clean');
      }
    }
    try {
      const chromeCount = execSync("pgrep -c -f 'Google Chrome' 2>/dev/null || echo 0", { encoding: 'utf8' }).trim();
      this.logger.log(`[WhatsApp] Pre-init: Google Chrome helper processes running = ${chromeCount}`);
    } catch {
      this.logger.debug('[WhatsApp] Pre-init: could not count Chrome processes (non-critical)');
    }
    // ───────────────────────────────────────────────────────────────────────────

    this.logger.log('[WA_DEBUG] calling initialize');
    try {
      await this.client.initialize();
      this.logger.log('[WA_DEBUG] initialize resolved');
      this.startPreLiveHealthSnapshot();
    } catch (err: any) {
      this.logger.error(`[WA_INIT_FATAL] initialize() threw: ${err?.stack ?? err?.message ?? String(err)}`);
      this._adminEventSubject.next(JSON.stringify({
        type: 'error',
        message: `WhatsApp init failed: ${err?.message ?? 'unknown error'}`,
        timestamp: new Date().toISOString(),
      }));
      this.qrSubject.next(JSON.stringify({
        type: 'error',
        message: 'WhatsApp failed to start. Will retry automatically.',
      }));
      // Re-throw so the retry loop in initClient() can attempt subsequent attempts.
      // If all attempts are exhausted, initClient() emits the final error to SSE.
      throw err;
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
        // Use scheduleReinit (not setImmediate) so any pending timer is cancelled first
        // and the guard check in reinitClient() sees any in-flight _initializing = true.
        this.scheduleReinit(5_000);
        throw new Error('WhatsApp session expired. Reconnecting — please try again in a moment.');
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

    // Only stamp last_salesman_reply_at when a real user sent the message.
    // Automated system messages (sentBy = null) must NOT clear the WAITING badge —
    // the customer is still waiting for a human response.
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

  async getSessionStatus(): Promise<{ status: string; phone: string | null }> {
    const row = await this.sessionRepo.findOne({ where: { session_name: this.sessionName } });
    return { status: row?.status ?? 'DISCONNECTED', phone: row?.phone_number ?? null };
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

  /** Logout, clear auth files, and restart — generates a fresh QR. */
  async disconnectAndReset(): Promise<void> {
    await this.resetSession(true);
    await this.updateSession({ status: 'DISCONNECTED', phone_number: null, connected_at: null });
    this.qrSubject.next(JSON.stringify({ type: 'disconnected' }));
    this.scheduleReinit(5_000);
  }

  // ── Private helpers ───────────────────────────────────────────────────────────

  /**
   * Schedule a single reinit attempt after delayMs. Cancels any pending timer
   * first so rapid disconnect/reconnect cycles never stack multiple reinits.
   */
  private scheduleReinit(delayMs: number): void {
    if (this._authInvalid || this._qrPaused) {
      this.logger.warn('[WA_RECONNECT] Skipped — auth invalid or QR paused (manual reset required)');
      return;
    }
    if (this._retryTimer) {
      clearTimeout(this._retryTimer);
      this._retryTimer = null;
      this.logger.debug('[WA_RECONNECT] Cancelled pending retry timer');
    }
    this._retryTimer = setTimeout(() => {
      this._retryTimer = null;
      this.reinitClient().catch((e) => this.logger.error('[WA_RECONNECT] Reinit failed', e?.message));
    }, delayMs);
  }

  // ── Instance lock + auth paths ──────────────────────────────────────────────

  private getAuthRootDir(): string {
    return path.join(process.cwd(), WA_AUTH_DATA_PATH);
  }

  private getSessionDir(): string {
    return path.join(this.getAuthRootDir(), `session-${WA_LOCAL_AUTH_CLIENT_ID}`);
  }

  private getInstanceLockPath(): string {
    return path.join(this.getAuthRootDir(), '.wa-instance.lock');
  }

  /** Returns true if another live process already owns the WhatsApp instance lock. */
  private tryAcquireInstanceLock(): boolean {
    const lockPath = this.getInstanceLockPath();
    fs.mkdirSync(this.getAuthRootDir(), { recursive: true });
    const myPid = process.pid;

    if (fs.existsSync(lockPath)) {
      try {
        const existing = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as {
          pid?: number;
          startedAt?: string;
          sessionName?: string;
        };
        if (existing.pid === myPid) {
          this._instanceLockHeld = true;
          return true;
        }
        if (existing.pid && this.isProcessAlive(existing.pid)) {
          this.logger.error(
            `[WA_DUPLICATE_INSTANCE] Blocked init — pid=${existing.pid} started=${existing.startedAt ?? '?'} session=${existing.sessionName ?? '?'}`,
          );
          return false;
        }
        this.logger.warn(`[WA_INIT] Stale lock from dead pid=${existing.pid} — reclaiming`);
      } catch {
        this.logger.warn('[WA_INIT] Corrupt instance lock — overwriting');
      }
    }

    fs.writeFileSync(
      lockPath,
      JSON.stringify({
        pid: myPid,
        startedAt: new Date().toISOString(),
        sessionName: this.sessionName,
      }),
    );
    this._instanceLockHeld = true;
    return true;
  }

  private releaseInstanceLock(): void {
    if (!this._instanceLockHeld) return;
    const lockPath = this.getInstanceLockPath();
    try {
      if (fs.existsSync(lockPath)) {
        const existing = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as { pid?: number };
        if (existing.pid === process.pid) {
          fs.unlinkSync(lockPath);
        }
      }
    } catch { /* non-fatal on shutdown */ }
    this._instanceLockHeld = false;
  }

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /** True when LocalAuth credentials exist on disk (not just Chromium lock files). */
  private hasPersistedAuth(): boolean {
    const sessionDir = this.getSessionDir();
    if (!fs.existsSync(sessionDir)) return false;
    try {
      return fs.readdirSync(sessionDir).some(
        (name) => !CHROMIUM_LOCK_FILES.includes(name as typeof CHROMIUM_LOCK_FILES[number]),
      );
    } catch {
      return false;
    }
  }

  /** Kill orphan Puppeteer Chromium before init to prevent profile lock races. */
  private async ensureNoOrphanChromium(): Promise<void> {
    try {
      const count = execSync("pgrep -c -f 'remote-debugging-port' 2>/dev/null || echo 0", { encoding: 'utf8' }).trim();
      const n = parseInt(count, 10) || 0;
      if (n > 0) {
        this.logger.warn(`[WA_DUPLICATE_INSTANCE] Orphan Chromium (${n}) — terminating before init`);
        await this.killChromeProcesses();
      }
    } catch { /* non-critical */ }
  }

  private startRestoreWatchdog(): void {
    this.clearRestoreWatchdog();
    this._restoreWatchdog = setTimeout(() => {
      this._restoreWatchdog = null;
      if (!this._ready && this._authExistedBeforeInit && !this._qrShownThisInit) {
        void this.handleAuthInvalid('session restore timed out');
      }
    }, RESTORE_TIMEOUT_MS);
  }

  private clearRestoreWatchdog(): void {
    if (this._restoreWatchdog) {
      clearTimeout(this._restoreWatchdog);
      this._restoreWatchdog = null;
    }
  }

  /**
   * Persisted auth is unusable — stop auto-reconnect; user must call Reset Session.
   */
  private async handleAuthInvalid(reason: string): Promise<void> {
    if (this._authInvalid) return;
    this._authInvalid = true;
    this._qrPaused = true;
    this.clearRestoreWatchdog();
    this.stopHealthMonitor();
    this.stopPreLiveHealthSnapshot();
    this.logger.error(`[WA_AUTH_INVALID] ${reason} — manual Reset Session required`);
    this.qrSubject.next(JSON.stringify({
      type: 'error',
      message: 'Saved WhatsApp session is invalid. Click "Reset Session" to pair again.',
    }));
    this._adminEventSubject.next(JSON.stringify({ type: 'auth_invalid', reason, timestamp: new Date().toISOString() }));
    await this.updateSession({ status: 'DISCONNECTED' });
    this._manualDisconnect = true;
    if (this.client) {
      try { await this.client.destroy(); } catch { /* ignore */ }
      this.client = null;
    }
    this._manualDisconnect = false;
    this._ready = false;
  }

  /**
   * Controlled teardown: destroy client, kill browser, clear locks, optionally wipe auth.
   */
  private async resetSession(clearAuth: boolean): Promise<void> {
    this.logger.log('[WA_RESET_BEGIN]');
    this._ready = false;
    this._authInvalid = false;
    this.qrCount = 0;
    this.qrGenerated = false;
    this._qrPaused = false;
    this._lastQrPublishedAt = null;
    this.clearRestoreWatchdog();
    this.stopHealthMonitor();
    this.stopPreLiveHealthSnapshot();
    if (this._retryTimer) {
      clearTimeout(this._retryTimer);
      this._retryTimer = null;
    }

    this._manualDisconnect = true;
    if (this.client) {
      try { await this.client.logout(); } catch { /* already disconnected */ }
      try { await this.client.destroy(); } catch { /* ignore */ }
      this.client = null;
    }
    this._manualDisconnect = false;

    this.logger.log('[WA_RESET_CLEANUP] Killing browser, clearing lock files');
    await this.killChromeProcesses();
    await this.removeSingletonFiles(this.getSessionDir());

    if (clearAuth) {
      await this.clearAuthFiles();
      const versionCacheDir = path.join(process.cwd(), '.wwebjs_cache');
      if (fs.existsSync(versionCacheDir)) {
        await this.rmWithRetry(versionCacheDir);
      }
    }

    await new Promise<void>((r) => setTimeout(r, POST_RESET_DELAY_MS));
    this.logger.log('[WA_RESET_COMPLETE]');
  }

  /**
   * Kills any lingering Chrome/Chromium process and surgically removes all
   * Chromium profile lock files. Safe on every init attempt — these files are
   * transient runtime artefacts, never user auth data.
   *
   * Lock files removed (all live at the Chrome user-data-dir root):
   *   SingletonLock       — filesystem mutex; Chrome refuses to start if present
   *   SingletonSocket     — Unix domain socket companion to SingletonLock
   *   SingletonCookie     — written alongside SingletonLock on some platforms
   *   DevToolsActivePort  — stale DevTools port file left after unclean shutdown
   *
   * Order matters: processes must be dead BEFORE we touch the files, otherwise
   * the running process will immediately recreate them.
   */
  private async cleanSessionLocks(): Promise<void> {
    const sessionDir = this.getSessionDir();

    // 1. Gracefully destroy the NestJS client object — releases Puppeteer's handle.
    if (this.client) {
      try { await this.client.destroy(); } catch { /* already gone */ }
      this.client = null;
      this.logger.log('[WA_DESTROY] Destroyed existing client before lock cleanup');
    }

    // 2. Kill any orphaned Chromium process that survived client.destroy().
    //    A live process will immediately re-create Singleton files after we remove them.
    await this.killChromeProcesses();

    // 3. Wait for the OS to fully release file handles after SIGTERM.
    await new Promise<void>((r) => setTimeout(r, 2_000));

    // 4. First removal pass.
    await this.removeSingletonFiles(sessionDir);

    // 5. Retry once if any lock files survived the first pass.
    //    Edge case: on some macOS versions a SIGTERM'd Chromium briefly re-opens
    //    its profile directory before fully exiting.
    if (this.hasSingletonFiles(sessionDir)) {
      this.logger.warn('[WhatsApp] Singleton files still present — retrying cleanup in 1 s');
      await new Promise<void>((r) => setTimeout(r, 1_000));
      await this.removeSingletonFiles(sessionDir);
    }
  }

  /** Returns true if any Chromium lock file still exists in sessionDir. */
  private hasSingletonFiles(sessionDir: string): boolean {
    return CHROMIUM_LOCK_FILES.some((f) => fs.existsSync(path.join(sessionDir, f)));
  }

  /**
   * Surgically unlinks each Chromium lock file if present.
   * Uses fs.unlinkSync (correct for individual files, not directories).
   * Logs every removal so the startup sequence is auditable.
   */
  private async removeSingletonFiles(sessionDir: string): Promise<void> {
    for (const file of CHROMIUM_LOCK_FILES) {
      const filePath = path.join(sessionDir, file);
      if (!fs.existsSync(filePath)) continue;
      try {
        fs.unlinkSync(filePath);
        this.logger.log(`[WhatsApp] Removed stale ${file}`);
      } catch (e: any) {
        this.logger.warn(`[WhatsApp] Could not remove ${file}: ${e?.message}`);
      }
    }
  }

  /**
   * Kills only Chromium processes launched by Puppeteer, identified by the
   * --remote-debugging-port flag that Puppeteer always passes. Does NOT kill
   * the user's own Chrome browser (which never runs with that flag).
   */
  private async killChromeProcesses(): Promise<void> {
    this.logger.log('[WhatsApp] Killing orphan browser processes...');
    const cmds = [
      // Primary target: any Chrome/Chromium with Puppeteer's debugging flag
      "pkill -f 'remote-debugging-port' 2>/dev/null || true",
      // Secondary: Chromium app bundle on macOS (safe — user's Chrome is "Google Chrome", not "Chromium")
      "pkill -f 'Chromium.app' 2>/dev/null || true",
    ];
    for (const cmd of cmds) {
      try { execSync(cmd, { stdio: 'ignore', timeout: 3_000 }); } catch { /* no match — safe */ }
    }
    // Give OS time to release file handles after processes die
    await new Promise<void>((r) => setTimeout(r, 1_500));
  }

  /**
   * Async recursive directory removal with retry. Retries up to `maxAttempts`
   * times with 1 s delay — necessary because Chromium may still hold file
   * handles for a short window after the process is killed (ENOTEMPTY / EBUSY).
   */
  private async rmWithRetry(dirPath: string, maxAttempts = 5): Promise<void> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await fs.promises.rm(dirPath, { recursive: true, force: true });
        this.logger.log(`[WhatsApp] Removed: ${path.basename(dirPath)}`);
        return;
      } catch (e: any) {
        if (attempt < maxAttempts) {
          this.logger.warn(`[WhatsApp] Retry cleanup attempt ${attempt}/${maxAttempts}: ${e?.message}`);
          await new Promise<void>((r) => setTimeout(r, 1_000));
        } else {
          this.logger.error(`[WhatsApp] Failed to remove ${dirPath} after ${maxAttempts} attempts: ${e?.message}`);
        }
      }
    }
  }

  /**
   * Clears only the LocalAuth credentials (session folder).
   * Used by disconnectAndReset() and terminal disconnect reasons.
   * Preserves the version cache so the next init doesn't need to re-fetch WA Web.
   */
  private async clearAuthFiles(): Promise<void> {
    const sessionDir = this.getSessionDir();
    if (fs.existsSync(sessionDir)) {
      this.logger.log('[WA_RESET_CLEANUP] Removing auth directory');
      await this.rmWithRetry(sessionDir);
    }
  }

  // ── Health monitor ────────────────────────────────────────────────────────────

  /**
   * Runs every 90 seconds once connected.
   * Detects silent disconnects: Puppeteer's browser process dies (OOM, SIGKILL) without
   * firing the 'disconnected' event. In that case _ready stays true but pupPage is
   * null/closed — we catch it here and trigger a controlled reinit.
   */
  private startHealthMonitor(): void {
    this.stopHealthMonitor(); // ensure only one timer runs
    this._healthTimer = setInterval(async () => {
      if (this._initializing || this._manualDisconnect) return;

      if (this._ready && !this.isConnected()) {
        this.logger.warn('[WhatsApp] Health check: _ready=true but page is gone — silent disconnect, reiniting');
        this._ready = false;
        if (!this._disconnectedAt) {
          this._disconnectedAt = new Date();
          this.logger.log('[WhatsApp] Session downtime started');
        }
        await this.updateSession({ status: 'DISCONNECTED', disconnected_at: this._disconnectedAt });
        this.qrSubject.next(JSON.stringify({ type: 'disconnected', reason: 'SILENT' }));
        // Raise a WHATSAPP_DOWN alert — this path bypasses the 'disconnected' event handler
        this.eventEmitter.emit('whatsapp.down', { reason: 'SILENT' });
        this.stopHealthMonitor();
        this.logger.log('[WA_RECONNECT] Health monitor detected silent disconnect');
        this.reinitClient().catch((e) => this.logger.error('[WA_RECONNECT] Health reinit failed', e?.message));
        return;
      }

      if (this._ready) {
        const phone = this.client?.info?.wid?.user ?? '?';
        this.logger.log(`[WhatsApp] Health OK — connected as +${phone}`);
      }
    }, 90_000);
  }

  private stopHealthMonitor(): void {
    if (this._healthTimer) {
      clearInterval(this._healthTimer);
      this._healthTimer = null;
    }
  }

  /**
   * Single authoritative path that transitions the service to READY state.
   * Called from three sources: the 'ready' event, the authenticated watchdog fallback,
   * and the change_state CONNECTED fallback. Guards against double invocation.
   */
  private async finalizeReadyState(source: string): Promise<void> {
    if (this._ready) {
      this.logger.log(`[WA_FINALIZE_READY] Already ready — skipping duplicate from source=${source}`);
      return;
    }
    this._ready = true;
    this.stopPreLiveHealthSnapshot();
    this.clearRestoreWatchdog();
    this.qrCount = 0;
    this.qrGenerated = false;
    this._qrPaused = false;
    this._lastQrPublishedAt = null;
    this._qrDataUrl = null;
    this._qrGeneratedAt = null;

    const phone = this.client?.info?.wid?.user ?? null;

    if (this._disconnectedAt) {
      const mins = Math.round((Date.now() - this._disconnectedAt.getTime()) / 60_000);
      this.logger.log(`[WhatsApp] Session recovered after ${mins} minute(s)`);
      this._disconnectedAt = null;
    }

    if (this._authExistedBeforeInit && !this._qrShownThisInit) {
      this.logger.log(`[WA_SESSION_RESTORED] Session restored from disk as +${phone} (no QR required)`);
    }

    this.logger.log(`[WA_READY] Connected as +${phone} (source=${source})`);
    this._lastReadyAt = new Date();

    await this.updateSession({
      status: 'CONNECTED',
      qr_code: null,
      phone_number: phone,
      connected_at: new Date(),
      disconnected_at: null,
    });

    this.qrSubject.next(JSON.stringify({ type: 'ready', phone }));
    this._adminEventSubject.next(JSON.stringify({ type: 'ready', phone, source, timestamp: new Date().toISOString() }));

    this.startHealthMonitor();
    this.eventEmitter.emit('whatsapp.up');
    setTimeout(() => this.recoverMissedMessages().catch((e) =>
      this.logger.warn(`[WhatsApp] Recovery scan failed: ${e?.message}`),
    ), 3_000);
  }

  /** Poll every 15s while not ready — surfaces hidden deadlocks in the pairing flow. */
  private startPreLiveHealthSnapshot(): void {
    this.stopPreLiveHealthSnapshot();
    this._preLiveHealthTimer = setInterval(async () => {
      if (this._ready) {
        this.stopPreLiveHealthSnapshot();
        return;
      }
      const waState = await this.client?.getState?.().catch(() => null);
      const page    = this.client?.pupPage as any;
      this.logger.log(
        `[WA_HEALTH] status=not-ready waState=${waState ?? '?'} ` +
        `hasInfo=${!!this.client?.info?.wid} qrShown=${this._qrShownThisInit} ` +
        `qrGenerated=${this.qrGenerated} authExisted=${this._authExistedBeforeInit} ` +
        `pageClosed=${page ? page.isClosed() : 'no-page'}`,
      );
    }, 15_000);
    (this._preLiveHealthTimer as any).unref?.();
  }

  private stopPreLiveHealthSnapshot(): void {
    if (this._preLiveHealthTimer) {
      clearInterval(this._preLiveHealthTimer);
      this._preLiveHealthTimer = null;
    }
  }

  private async reinitClient(): Promise<void> {
    if (this._initializing) {
      this.logger.warn('[WA_RECONNECT] reinitClient() skipped — already initializing');
      return;
    }
    if (this._authInvalid) {
      this.logger.warn('[WA_RECONNECT] reinitClient() skipped — auth invalid');
      return;
    }

    this.logger.log('[WA_RECONNECT] Reinitializing client');
    this.qrSubject.next(JSON.stringify({ type: 'initializing' }));

    if (this.client) {
      try { await this.client.destroy(); } catch { /* ignore */ }
      this.client = null;
    }

    await this.initClient();
  }

  /**
   * Executes `fn` and retries once if Puppeteer throws an execution-context error.
   * These errors occur when WhatsApp Web internally navigates (e.g. QR → chat view),
   * destroying the current JS context mid-evaluate. A single 500 ms delay + retry
   * is sufficient because the new context is ready almost immediately after load.
   */
  private async safeEval<T>(fn: () => Promise<T>, retriesLeft = 1): Promise<T> {
    try {
      return await fn();
    } catch (e: any) {
      const msg: string = e?.message ?? '';
      const isContextError =
        msg.includes('Execution context was destroyed') ||
        msg.includes('Cannot find context with specified id');
      if (isContextError && retriesLeft > 0) {
        this.logger.warn(`[WhatsApp] safeEval: execution context destroyed — retrying once in 500 ms`);
        await new Promise<void>((r) => setTimeout(r, 500));
        return this.safeEval(fn, retriesLeft - 1);
      }
      throw e;
    }
  }

  private findChrome(): string | undefined {
    const CANDIDATES = [
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
    // Last resort: ask puppeteer where it downloaded Chrome (respects PUPPETEER_CACHE_DIR)
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const ep: string = require('puppeteer').executablePath();
      if (ep && fs.existsSync(ep)) return ep;
      this.logger.warn(`[WhatsApp] puppeteer.executablePath() returned "${ep}" but file not found`);
    } catch (e: any) {
      this.logger.warn(`[WhatsApp] Could not resolve puppeteer executablePath: ${e?.message}`);
    }
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
    // Handled by ProductionCommandService via event — return early to skip lead flow.
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

      // Stamp last_customer_reply_at so crons don't need repeated subqueries
      await this.messageRepo.manager.query(
        `UPDATE leads SET last_customer_reply_at = NOW() WHERE id = $1`,
        [existing[0].id],
      );

      // STOP opt-out: customer asked to stop receiving messages — add automation_off tag
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

      // Notify the assigned salesman whenever a customer sends a message
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
    const source = this.detectSource(body);
    const hash = crypto.createHash('sha256').update(`${from}-${body || ''}`).digest('hex');
    const hasSerializedId = !!msg.id?._serialized;
    const messageId: string = msg.id?._serialized || hash;
    this.logger.log({ action: 'WHATSAPP_EVENT_RECEIVED', phone, messageId, hasSerializedId });

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

  // ── Admin monitoring API ──────────────────────────────────────────────────────

  getAdminStatus() {
    const connected = this._ready && this.isConnected();
    const state = this._initializing ? 'INITIALIZING'
      : connected          ? 'CONNECTED'
      : this._qrPaused     ? 'PAUSED'
      : this.qrGenerated   ? 'QR_ACTIVE'
      : 'DISCONNECTED';
    return {
      connected,
      state,
      lastDisconnectReason: this._lastDisconnectReason,
      disconnectedAt:       this._disconnectedAt?.toISOString() ?? null,
      downtimeMinutes:      this._disconnectedAt
        ? Math.round((Date.now() - this._disconnectedAt.getTime()) / 60_000)
        : null,
      lastReadyAt:        this._lastReadyAt?.toISOString() ?? null,
      qrActive:           this.qrGenerated,
      qrCount:            this.qrCount,
      qrPaused:           this._qrPaused,
      maxQrRetries:       this.MAX_QR_RETRIES,
      recoveringMessages: this._recovering,
      appVersion:         process.env.APP_VERSION ?? 'unknown',
    };
  }

  getQrData() {
    return {
      active:      this.qrGenerated,
      qr:          this.qrGenerated ? this._qrDataUrl : null,
      generatedAt: this._qrGeneratedAt?.toISOString() ?? null,
    };
  }

  getAdminEventObservable(): Observable<any> {
    return merge(
      this._adminEventSubject.asObservable().pipe(map((json) => ({ data: JSON.parse(json) }))),
      interval(30_000).pipe(map(() => ({ data: { type: 'ping' } }))),
    );
  }

  async safeRestart(): Promise<void> {
    if (this._initializing) {
      this.logger.warn('[WhatsApp Admin] safeRestart() skipped — already initializing');
      return;
    }
    this.logger.log('[WhatsApp Admin] Controlled restart — preserving auth session');
    this._adminEventSubject.next(JSON.stringify({ type: 'restart_initiated', timestamp: new Date().toISOString() }));
    await this.reinitClient();
  }

  /**
   * Manual reconnect after QR retry limit is hit.
   * Resets all pause/QR counters and starts a fresh client init cycle.
   * This is the recovery path when the system enters PAUSED state.
   */
  async manualReconnect(): Promise<void> {
    if (this._initializing) {
      this.logger.warn('[WA_RECONNECT] manualReconnect() skipped — already initializing');
      return;
    }
    this.logger.log('[WA_RECONNECT] Manual reconnect — resetting QR counters');
    this._authInvalid = false;
    this._qrPaused   = false;
    this.qrCount     = 0;
    this.qrGenerated = false;
    this._lastQrPublishedAt = null;
    this.stopHealthMonitor();
    this._adminEventSubject.next(JSON.stringify({ type: 'reconnect_initiated', timestamp: new Date().toISOString() }));
    this.qrSubject.next(JSON.stringify({ type: 'initializing' }));

    // Ensure any lingering client is gone (the setImmediate in the qr handler may not have fired yet)
    if (this.client) {
      this._manualDisconnect = true;
      try { await this.client.destroy(); } catch { /* ignore */ }
      this.client = null;
      this._manualDisconnect = false;
    }

    await this.initClient();
  }

  /**
   * Full session reset — the official recovery path when the authentication
   * handshake never completes despite a QR being shown.
   *
   * Flow: logout → destroy → kill Chrome → clear auth → fresh init → new QR.
   * Unlike safeRestart() this wipes credentials, forcing a fresh QR login.
   */
  async resetWhatsAppSession(): Promise<void> {
    if (this._initializing) {
      this.logger.warn('[WA_RESET_BEGIN] resetWhatsAppSession() skipped — already initializing');
      return;
    }
    this._adminEventSubject.next(JSON.stringify({ type: 'reset_initiated', timestamp: new Date().toISOString() }));
    await this.resetSession(true);
    await this.updateSession({ status: 'DISCONNECTED', phone_number: null, connected_at: null });
    this.qrSubject.next(JSON.stringify({ type: 'initializing' }));
    this._adminEventSubject.next(JSON.stringify({ type: 'reset_complete', timestamp: new Date().toISOString() }));
    setImmediate(() => this.initClient().catch((e) =>
      this.logger.error('[WA_INIT] Post-reset init failed', e?.message),
    ));
  }

  private async recoverMissedMessages(): Promise<void> {
    if (this._recovering) {
      this.logger.warn('[WhatsApp] Recovery scan already in progress — skipping');
      return;
    }
    if (!this.isConnected()) return;

    this._recovering = true;
    try {
      this.logger.log('[WhatsApp] Starting reconnect recovery scan');
      const cutoff = Date.now() - 30 * 60 * 1000;

      const chats: any[] = await this.client.getChats();
      const dmChats = chats.filter((c: any) => !c.isGroup).slice(0, 20);

      for (const chat of dmChats) {
        if (!this.isConnected()) break;

        let msgs: any[];
        try {
          msgs = await chat.fetchMessages({ limit: 10 });
        } catch (e: any) {
          this.logger.warn(`[WhatsApp] Recovery scan: could not fetch messages for chat ${chat.id?._serialized}: ${e?.message}`);
          continue;
        }

        for (const msg of msgs) {
          if (msg.fromMe) continue;
          if ((msg.timestamp * 1000) < cutoff) continue;

          const msgId: string = msg.id?._serialized ?? `${msg.from}-${msg.timestamp}`;
          if (this.seenMsgIds.has(msgId)) continue;

          // Mirror seenMsgIds bookkeeping from onMsg so a concurrent 'message' event
          // for the same msg doesn't process it a second time.
          this.seenMsgIds.add(msgId);
          if (this.seenMsgIds.size > 500) {
            const first = this.seenMsgIds.values().next().value;
            this.seenMsgIds.delete(first);
          }

          this.logger.log(`[WhatsApp] Recovered missed message: ${msgId}`);
          try {
            await this.handleInbound(msg);
          } catch (e: any) {
            this.logger.warn(`[WhatsApp] Recovery scan: handleInbound failed for msg ${msgId}: ${e?.message}`);
          }
        }
      }

      this.logger.log('[WhatsApp] Recovery scan complete');
    } catch (e: any) {
      this.logger.warn(`[WhatsApp] Recovery scan failed: ${e?.message}`);
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
      // DB unavailable (ENOTFOUND, ECONNREFUSED, pool timeout) — WA continues running.
      // Session state is in memory; DB will catch up on the next successful call.
      this.logger.warn(`[WA_DB_WARN] updateSession failed — WA stays READY: ${e?.message}`);
    }
  }
}
