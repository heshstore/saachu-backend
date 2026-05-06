import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import { execSync } from 'child_process';
import * as crypto from 'crypto';
import { ReplaySubject, Observable, interval, merge } from 'rxjs';
import { map } from 'rxjs/operators';
import { WhatsAppSession } from './entities/whatsapp-session.entity';
import { WhatsAppMessage } from './entities/whatsapp-message.entity';
import { appConfig } from '../config/config';
import { LeadSource } from '../crm/entities/lead.entity';
import { normalizePhone } from '../crm/normalizers/lead-normalizer';

// Fallback: a known-good recent WA Web version.
// Updated whenever the dynamic fetch below succeeds — change this string only if the
// GitHub API is consistently unreachable AND the current fallback starts causing failures.
const WA_VERSION_FALLBACK =
  'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.3000.1021303286-alpha.html';

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

  constructor(
    @InjectRepository(WhatsAppSession)
    private sessionRepo: Repository<WhatsAppSession>,
    @InjectRepository(WhatsAppMessage)
    private messageRepo: Repository<WhatsAppMessage>,
    private eventEmitter: EventEmitter2,
  ) {}

  async onModuleInit() {
    this.logger.log('WhatsApp module init — starting Chromium in background');
    this.qrSubject.next(JSON.stringify({ type: 'initializing' }));
    setImmediate(() => this.initClient().catch((e) => {
      this.logger.error('WhatsApp init failed', e?.stack ?? e?.message);
      this.qrSubject.next(JSON.stringify({ type: 'error', message: e?.message }));
    }));
  }

  async onModuleDestroy() {
    this.stopHealthMonitor();
    this._ready = false;
    if (this.client) {
      try { await this.client.destroy(); } catch { /* ignore */ }
      this.client = null;
    }
  }

  // ── Core init ────────────────────────────────────────────────────────────────

  private async initClient() {
    // Guard: prevent two Chromium instances racing on the same LocalAuth directory.
    // This is the root cause of "browser is already running for session ..." errors.
    if (this._initializing) {
      this.logger.warn('[WhatsApp] initClient() called while already initializing — skipping duplicate');
      return;
    }
    if (this.client) {
      this.logger.warn('[WhatsApp] initClient() called but client already exists — skipping');
      return;
    }

    this._initializing = true;
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
            this.logger.log(`[WhatsApp] Retrying in 5 s... (next: attempt ${attempt + 1}/${MAX_ATTEMPTS})`);
            this.qrSubject.next(JSON.stringify({
              type: 'retrying',
              attempt: attempt + 1,
              maxAttempts: MAX_ATTEMPTS,
              message: `Init failed — retrying (${attempt + 1}/${MAX_ATTEMPTS})`,
            }));
            await new Promise<void>((r) => setTimeout(r, 5_000));
          } else {
            // Final attempt failed — nuke the entire session folder so the next
            // initClient() starts completely fresh (forces QR re-login but guarantees recovery).
            this.logger.warn('[WhatsApp] All attempts exhausted — wiping session folder for clean recovery');
            this.clearAuthFiles();
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
    this.logger.log(`Launching Chromium${executablePath ? ` at ${executablePath}` : ' (bundled/auto)'}`);

    // Fetch the latest WA Web version dynamically — prevents "Couldn't link device"
    // caused by running an outdated version that WhatsApp has deprecated.
    const waVersionUrl = await this.fetchLatestWaVersionUrl();
    this.logger.log(`WA Web version URL: ${waVersionUrl}`);

    this.qrCount = 0;

    this.client = new Client({
      authStrategy: new LocalAuth({ clientId: this.sessionName }),
      webVersionCache: {
        type: 'remote',
        remotePath: waVersionUrl,
      },
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

    this.client.on('qr', async (qr: string) => {
      this.qrCount++;
      this.qrGenerated = true;
      this.logger.log(`[WhatsApp] QR #${this.qrCount} generated — awaiting scan`);

      let QRCode: any;
      try { QRCode = (await import('qrcode')).default; } catch { return; }
      const dataUrl = await QRCode.toDataURL(qr, { width: 300 });

      const payload: Record<string, any> = { type: 'qr', dataUrl, qrIndex: this.qrCount };

      // After 3 consecutive QRs without a successful scan, the session files are likely
      // corrupt or there's a version mismatch — prompt the user to force-reconnect.
      if (this.qrCount >= 3) {
        payload.warning =
          'QR scanned multiple times without connecting. ' +
          'Click "Force Reconnect" to clear the session and try again.';
        this.logger.warn(`[WhatsApp] QR failure streak: ${this.qrCount} QRs shown without connection`);
      }

      this.qrSubject.next(JSON.stringify(payload));
      await this.updateSession({ status: 'CONNECTING', qr_code: dataUrl });
    });

    this.client.on('ready', async () => {
      this._ready = true;
      this.qrCount = 0;
      this.qrGenerated = false;
      const info = this.client.info;
      const phone = info?.wid?.user ?? null;
      await this.updateSession({ status: 'CONNECTED', qr_code: null, phone_number: phone, connected_at: new Date() });
      this.qrSubject.next(JSON.stringify({ type: 'ready', phone }));
      this.logger.log(`[WhatsApp] Connected as +${phone}`);
      this.startHealthMonitor();
      this.eventEmitter.emit('whatsapp.up');

      // Attach Puppeteer page-level listeners to detect navigation events that
      // temporarily destroy the JS execution context inside the WA Web frame.
      // These are informational — the 'disconnected' handler with reason='NAVIGATION'
      // already handles the session-level recovery; these add finer visibility.
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
      this.stopHealthMonitor();
      await this.updateSession({ status: 'DISCONNECTED' });
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
        this.clearAuthFiles();
      }

      setTimeout(() => this.reinitClient().catch((e) => this.logger.error('[WhatsApp] Reconnect failed', e?.message)), 10_000);
    });

    this.client.on('auth_failure', async (msg: string) => {
      this._ready = false;
      this.logger.error(`[WhatsApp] Auth failure: ${msg} — clearing session and restarting`);
      await this.updateSession({ status: 'DISCONNECTED' });
      this.qrSubject.next(JSON.stringify({
        type: 'error',
        message: 'Authentication failed. Clearing session — a fresh QR will appear shortly.',
      }));
      await this.clearSessionFiles();
      setTimeout(() => this.reinitClient().catch((e) => this.logger.error('[WhatsApp] Reinit after auth_failure failed', e?.message)), 3_000);
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

    this.client.on('message', onMsg);
    this.client.on('message_create', onMsg);

    this.logger.log('[WhatsApp] Calling client.initialize()...');
    await this.client.initialize();
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
        // Use setTimeout (not setImmediate) so the guard check in reinitClient() sees
        // any in-flight _initializing = true that was set by a concurrent reinit path
        setTimeout(() => this.reinitClient().catch((e) => this.logger.warn('[WhatsApp] Reconnect failed:', e?.message)), 1_000);
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
    this.logger.log('[WhatsApp] Manual disconnect requested — clearing session');
    this._ready = false;
    this.qrCount = 0;
    this.qrGenerated = false;

    // Suppress the 'disconnected' event handler's auto-reinit: logout() will fire it,
    // but we're already managing the reinit below via setTimeout.
    this._manualDisconnect = true;

    if (this.client) {
      try { await this.client.logout(); } catch { /* already disconnected */ }
      try { await this.client.destroy(); } catch { /* ignore */ }
      this.client = null;
    }

    this._manualDisconnect = false;

    // Only clear auth credentials — keep the version cache to avoid re-fetching WA Web
    this.clearAuthFiles();
    await this.updateSession({ status: 'DISCONNECTED', phone_number: null, connected_at: null });
    this.qrSubject.next(JSON.stringify({ type: 'disconnected' }));

    // Single reinit — not racing with the disconnected event handler
    setTimeout(() => this.reinitClient().catch((e) => this.logger.error('[WhatsApp] Reinit failed', e?.message)), 2_000);
  }

  // ── Private helpers ───────────────────────────────────────────────────────────

  /**
   * Fetches the latest WhatsApp Web version HTML URL from the wppconnect-team repo.
   * Using an outdated version is the primary cause of "Couldn't link device" — WhatsApp
   * enforces a minimum version and rejects deprecated clients after QR scan completes.
   *
   * Falls back to WA_VERSION_FALLBACK if the GitHub API is unreachable.
   */
  private async fetchLatestWaVersionUrl(): Promise<string> {
    return new Promise((resolve) => {
      const req = https.get(
        'https://api.github.com/repos/wppconnect-team/wa-version/contents/html',
        {
          headers: {
            'User-Agent': 'saachu-crm/1.0',
            'Accept': 'application/vnd.github+json',
          },
        },
        (res) => {
          let body = '';
          res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
          res.on('end', () => {
            try {
              const files: any[] = JSON.parse(body);
              const names = files
                .filter((f: any) => typeof f.name === 'string' && f.name.endsWith('.html'))
                .map((f: any) => f.name as string)
                .sort();
              const latest = names[names.length - 1];
              if (latest) {
                const url = `https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/${latest}`;
                this.logger.log(`Auto-detected latest WA Web version: ${latest}`);
                return resolve(url);
              }
            } catch { /* fall through */ }
            this.logger.warn('Could not parse version list — using fallback');
            resolve(WA_VERSION_FALLBACK);
          });
        },
      );
      req.on('error', (e: Error) => {
        this.logger.warn(`Version fetch failed: ${e.message} — using fallback`);
        resolve(WA_VERSION_FALLBACK);
      });
      req.setTimeout(6_000, () => {
        req.destroy();
        this.logger.warn('Version fetch timed out — using fallback');
        resolve(WA_VERSION_FALLBACK);
      });
    });
  }

  /**
   * Kills any lingering Chrome/Chromium process and removes all Chromium session
   * lock files. Safe to call on every init attempt — none of these are auth data.
   *
   * Files removed:
   *   SingletonLock       — Chrome's filesystem mutex; blocks a second instance
   *   SingletonCookie     — companion lock created alongside SingletonLock
   *   DevToolsActivePort  — written while DevTools is open; stale copy blocks init
   */
  private async cleanSessionLocks(): Promise<void> {
    const sessionDir = path.join(process.cwd(), `.wwebjs_auth/session-${this.sessionName}`);

    // Destroy the existing client gracefully first — this is the safest way to
    // release Puppeteer's browser handle without touching the user's own Chrome.
    if (this.client) {
      try { await this.client.destroy(); } catch { /* already gone */ }
      this.client = null;
      this.logger.log('[WhatsApp] cleanSessionLocks: destroyed existing client');
    }

    // Kill orphaned Puppeteer/Chromium processes that survived client.destroy().
    // Chromium must be dead before its SingletonLock can be safely removed.
    const killCmds = [
      "pkill -f 'puppeteer' || true",
      "pkill -f 'whatsapp-web.js' || true",
      // Kill Chromium instances launched by Puppeteer (identified by --remote-debugging-port
      // flag that Puppeteer always passes — avoids hitting the user's own browser).
      "pkill -f 'remote-debugging-port' || true",
    ];
    for (const cmd of killCmds) {
      try { execSync(cmd, { stdio: 'ignore' }); } catch { /* no match — safe */ }
    }
    this.logger.log('[WhatsApp] cleanSessionLocks: cleaned up orphan processes');

    // Give the OS 2 s to fully release file handles before Puppeteer touches them
    await new Promise<void>((r) => setTimeout(r, 2_000));

    const LOCK_FILES = ['SingletonLock', 'SingletonCookie', 'DevToolsActivePort'];
    for (const file of LOCK_FILES) {
      const filePath = path.join(sessionDir, file);
      if (fs.existsSync(filePath)) {
        try {
          fs.rmSync(filePath, { force: true });
          this.logger.log(`[WhatsApp] cleanSessionLocks: removed ${file}`);
        } catch (e: any) {
          this.logger.warn(`[WhatsApp] cleanSessionLocks: could not remove ${file}: ${e?.message}`);
        }
      }
    }
  }

  /**
   * Clears only the LocalAuth credentials (session folder).
   * Used by disconnectAndReset() and terminal disconnect reasons.
   * Preserves the version cache so the next init doesn't need to re-fetch WA Web.
   */
  private clearAuthFiles(): void {
    const sessionDir = path.join(process.cwd(), `.wwebjs_auth/session-${this.sessionName}`);
    if (fs.existsSync(sessionDir)) {
      fs.rmSync(sessionDir, { recursive: true, force: true });
      this.logger.log(`[WhatsApp] Auth files cleared: ${sessionDir}`);
    }
  }

  /**
   * Full wipe: auth credentials + version cache.
   * Only used after auth_failure where stale credentials + a stale WA version
   * could both be causing the problem.
   */
  private async clearSessionFiles(): Promise<void> {
    this.clearAuthFiles();
    const versionCacheDir = path.join(process.cwd(), '.wwebjs_cache');
    if (fs.existsSync(versionCacheDir)) {
      fs.rmSync(versionCacheDir, { recursive: true, force: true });
      this.logger.log('[WhatsApp] Version cache cleared');
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
        await this.updateSession({ status: 'DISCONNECTED' });
        this.qrSubject.next(JSON.stringify({ type: 'disconnected', reason: 'SILENT' }));
        // Raise a WHATSAPP_DOWN alert — this path bypasses the 'disconnected' event handler
        this.eventEmitter.emit('whatsapp.down', { reason: 'SILENT' });
        this.stopHealthMonitor();
        this.reinitClient().catch((e) => this.logger.error('[WhatsApp] Health reinit failed', e?.message));
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

  private async reinitClient(): Promise<void> {
    // Don't start a new reinit if one is already in progress
    if (this._initializing) {
      this.logger.warn('[WhatsApp] reinitClient() skipped — already initializing');
      return;
    }

    this.logger.log('[WhatsApp] Reinitializing client...');
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
    console.log('EMITTING LEAD EVENT:', { phone, messageId });

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

  private async updateSession(data: Partial<WhatsAppSession>): Promise<void> {
    let row = await this.sessionRepo.findOne({ where: { session_name: this.sessionName } });
    if (!row) row = this.sessionRepo.create({ session_name: this.sessionName });
    Object.assign(row, data, { last_active_at: new Date() });
    await this.sessionRepo.save(row).catch(() => { /* ignore concurrent update race */ });
  }
}
