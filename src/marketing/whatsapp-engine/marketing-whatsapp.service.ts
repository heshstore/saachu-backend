import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
  Optional,
} from '@nestjs/common';
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
import {
  NumberConnectionState,
  resolveNumberConnectionState,
} from './shared/number-state';

const WA_AUTH_DATA_PATH = '.wwebjs_auth_marketing';

/**
 * Strict phone resolver — extracts a canonical E.164 phone number from a WhatsApp message.
 *
 * ONLY @c.us JIDs are accepted as phone sources. Every other JID type (@lid, @g.us,
 * @newsletter, status@broadcast) is rejected immediately — no contact lookup fallback.
 *
 * contact.number is NEVER used: for @lid contacts it returns a WhatsApp-internal 15-digit
 * identifier (e.g. 199454170841150) that passes digit-length checks but is not a real phone.
 *
 * Source priority:
 *   1. msg.from             — always @c.us for direct messages in standard mode
 *   2. msg._data.from       — raw protocol field; reliable in some multi-device scenarios
 *   3. contact.id._serialized — @c.us only; fallback when msg.from is @lid but contact resolves to @c.us
 */
function resolveCustomerPhone(
  msg: any,
  contact: any | null,
): { phone: string | null; source: string; reason: string } {
  function tryExtractCusJid(
    raw: unknown,
    label: string,
  ): { phone: string; source: string; reason: string } | null {
    if (typeof raw !== 'string' || !raw.endsWith('@c.us')) return null;
    // Strip multi-device device suffix: "919940172777:3@c.us" → "919940172777"
    const userSeg = raw.replace(/:\d+@c\.us$/, '').replace(/@c\.us$/, '');
    const digits = userSeg.replace(/\D/g, '');
    if (!digits || digits.length < 10 || digits.length > 15) return null;
    // Must start with a non-zero digit (no country code starts with 0)
    if (!/^[1-9]\d{9,14}$/.test(digits)) return null;
    return { phone: `+${digits}`, source: label, reason: 'ok' };
  }

  // P1: msg.from
  const r1 = tryExtractCusJid(msg?.from, 'msg.from');
  if (r1) return r1;

  // P2: msg._data.from (raw WhatsApp protocol value)
  const r2 = tryExtractCusJid(msg?._data?.from, 'msg._data.from');
  if (r2) return r2;

  // P3: contact.id._serialized — accepted only in @c.us format
  const r3 = tryExtractCusJid(
    contact?.id?._serialized,
    'contact.id._serialized',
  );
  if (r3) return r3;

  const from: string = msg?.from ?? '';
  const jidType = from.includes('@') ? from.split('@')[1] : 'unknown';
  return { phone: null, source: from, reason: `no_cus_jid:${jidType}` };
}
const WATCHDOG_MS = 60_000;
const BOOT_TIMEOUT_MS = 180_000;
const AUTH_TIMEOUT_MS = 180_000;
// Max QR codes shown per manual Connect click. After this many WA-issued QR refreshes
// the lifecycle stops and waState→awaiting_manual_reconnect. User must click Connect again.
const MAX_QR_REFRESH_ATTEMPTS = 1;

const CHROME_PATH =
  process.env.CHROME_PATH ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const CHROMIUM_LOCK_FILES = [
  'SingletonLock',
  'SingletonSocket',
  'SingletonCookie',
  'DevToolsActivePort',
] as const;

// Strict linear state machine — no cyclic recovery transitions.
// idle → initializing → awaiting_scan → authenticating → ready
// Any failure from any state → failed → idle (via forceInvalidateSession)
// QR blocked / restore failed → awaiting_manual_reconnect (user must click Connect)
type WaState =
  | 'idle' // Not connected — Connect button visible
  | 'initializing' // Chromium launching
  | 'awaiting_scan' // QR displayed, waiting for user scan
  | 'authenticating' // QR scanned, WA establishing session
  | 'ready' // Session active — can send messages
  | 'failed' // Init or auth failure — auto-resets to idle
  | 'disconnecting' // Manual disconnect or teardown in progress
  | 'awaiting_manual_reconnect'; // Restore failed or QR expired — no Chrome running; user action required

// Monotonic rank for forward-only lifecycle enforcement.
// disconnecting and awaiting_manual_reconnect are teardown/terminal overlays absent from the
// linear chain; both allow _canTransition to exit back to idle/initializing.
const WA_STATE_ORDER: Partial<Record<WaState, number>> = {
  idle: 0,
  initializing: 1,
  awaiting_scan: 2,
  authenticating: 3,
  ready: 4,
  failed: 5,
  awaiting_manual_reconnect: 6,
};

interface NumberClientState {
  client: any;
  waState: WaState;
  starting: boolean;
  // True after _initClient attaches .on() listeners to this client instance.
  // Cleared by _destroyClient when state.client is nulled.
  listenersAttached: boolean;
  // True when connectNumber was called by a user action (HTTP /connect endpoint).
  // False for auto-restore and auto-reconnect paths. QR generation is only permitted
  // when this is true; auto-initiated connections that produce a QR gate to
  // awaiting_manual_reconnect instead.
  isManualConnect: boolean;
  // True only after BOTH initialize() resolved (inject/bridge functions registered in Chrome)
  // AND waState transitioned to 'ready' — meaning listener attached + page alive + receive confirmed.
  // Reset to false on every _destroyClient call (covers all teardown/reconnect paths) and explicitly
  // in forceInvalidateSession. Never set via initialize().then() alone.
  bridgeReady: boolean;
  manualDisconnect: boolean;
  destroyed: boolean;
  terminating: boolean;
  destroying: boolean;
  authTimeoutId: ReturnType<typeof setTimeout> | null;
  // Separate timer from authTimeoutId — fires 60 s after authenticated if ready never fires.
  readyWatchdogTimeoutId: ReturnType<typeof setTimeout> | null;
  // Post-init stuck guard — fires BOOT_TIMEOUT_MS after init lock releases if waState is
  // still 'initializing'. Stored so _clearTimers can cancel it when session advances.
  postInitGuardId: ReturnType<typeof setTimeout> | null;
  // Consecutive auto-reconnect attempts since last stable ready session.
  // Resets to 0 on ready and on forceInvalidateSession. Caps at MAX_AUTO_RECONNECTS.
  autoReconnectAttempts: number;
  // Pending reconnect timer — cleared by _clearTimers on any teardown path.
  reconnectTimerId: ReturnType<typeof setTimeout> | null;
  // Epoch ms when authenticated event fired — used by ready watchdog for diagnostics.
  authenticatedAt: number | null;
  watchdogTimer: ReturnType<typeof setInterval> | null;
  lastHeartbeat: Date | null;
  // Lives for the lifetime of the number so SSE subscribers survive invalidations.
  qrSubject: ReplaySubject<string>;
  qrDataUrl: string | null;
  qrGeneratedAt: Date | null;
  firstQrGeneratedAt: Date | null;
  phoneLinkCode: string | null;
  // Resolve callback for requestPhoneLink — called by the 'code' event handler when
  // the pairing code arrives from WhatsApp Web during phone-link initialization.
  phoneLinkResolve: ((code: string) => void) | null;
  lastReadyAt: Date | null;
  reconnectCount: number;
  qrRefreshCount: number;
  sessionStartedAt: Date | null;
  lastDisconnectedAt: Date | null;
  // Cached result of _hasRestorableSession() — updated at lifecycle events only, never during polling.
  // Eliminates repeated filesystem I/O from health-endpoint calls.
  sessionAvailable: boolean;
  // True when the session dir has leveldb but no blob — the fingerprint of a QR auth that was
  // interrupted (nodemon restart, crash) after Chrome started writing but before auth completed.
  // Set once at boot scan; cleared when the number successfully reaches ready.
  partialSession: boolean;
  // Last composite status key emitted via [WA_STATUS_RESOLVE] — suppresses duplicate log lines.
  _lastStatusKey: string | null;
}

function makeState(): NumberClientState {
  return {
    client: null,
    waState: 'idle',
    starting: false,
    listenersAttached: false,
    isManualConnect: false,
    bridgeReady: false,
    manualDisconnect: false,
    destroyed: false,
    terminating: false,
    destroying: false,
    authTimeoutId: null,
    readyWatchdogTimeoutId: null,
    postInitGuardId: null,
    autoReconnectAttempts: 0,
    reconnectTimerId: null,
    authenticatedAt: null,
    watchdogTimer: null,
    lastHeartbeat: null,
    qrSubject: new ReplaySubject<string>(1),
    qrDataUrl: null,
    qrGeneratedAt: null,
    firstQrGeneratedAt: null,
    phoneLinkCode: null,
    phoneLinkResolve: null,
    lastReadyAt: null,
    reconnectCount: 0,
    qrRefreshCount: 0,
    sessionStartedAt: null,
    lastDisconnectedAt: null,
    sessionAvailable: false,
    partialSession: false,
    _lastStatusKey: null,
  };
}

@Injectable()
export class MarketingWhatsAppService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MarketingWhatsAppService.name);
  private readonly clients = new Map<string, NumberClientState>();
  // Per-number init locks — prevents concurrent Chromium launches for the same number.
  private readonly _initLocks = new Map<string, Promise<void>>();
  // Idempotency guard for forceInvalidateSession.
  private readonly _invalidatingIds = new Set<string>();
  // ACK race bridge: waMessageId → logRowId, set synchronously in sender before DB write.
  private readonly _pendingAckMap = new Map<string, string>();
  // Log-only stability counters.
  private readonly _metrics = {
    successfulReadySessions: 0,
    failedBeforeReady: 0,
    authInvalidations: 0,
    qrToReadyAttempts: 0,
    qrToReadySuccesses: 0,
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

    // Bulk-reset all stale non-idle wa_states before any client activity begins.
    // Prevents the frontend from briefly seeing a stale 'ready' or 'authenticating'
    // during boot, before the per-number scan and restore queue run.
    try {
      const { affected } = await this.numberRepo
        .createQueryBuilder()
        .update()
        .set({ wa_state: 'idle' } as any)
        .where('wa_state IN (:...states)', {
          states: ['ready', 'authenticating', 'initializing', 'disconnecting'],
        })
        .execute();
      this.logger.log(`[WA_BOOT_PRE_RESET] affectedRows=${affected ?? 0}`);
    } catch (e: any) {
      this.logger.warn(
        `[WA_BOOT_PRE_RESET] bulk reset failed (non-fatal): ${e?.message}`,
      );
    }

    // One-time startup: purge historical bad inbox rows (invalid phones / empty bodies)
    await this._cleanupInvalidInboxRows();

    this.logger.log('[WA_STARTUP_SCAN] Scanning numbers for startup restore');
    try {
      const rows = await this.numberRepo.find();

      for (const r of rows) {
        const folderExists = fs.existsSync(this._getSessionDir(r.id));
        const restorableSession = this._hasRestorableSession(r.id);
        this.logger.log(
          `[MKT_BOOT] startup id=${r.id} phone=${r.phone} is_active=${r.is_active} ` +
            `wa_state=${JSON.stringify(r.wa_state)} folderExists=${folderExists} restorableSession=${restorableSession}`,
        );
      }

      const restoreTargets = rows.filter(
        (r) => r.is_active && this._hasRestorableSession(r.id),
      );

      if (restoreTargets.length === 0) {
        this.logger.log(
          `[MKT_BOOT] ${rows.length} number(s) set idle — no saved sessions found`,
        );
      } else {
        this.logger.log(
          `[MKT_BOOT] ${rows.length} total; ${restoreTargets.length} will auto-restore — sequential`,
        );
        for (let i = 0; i < restoreTargets.length; i++) {
          const r = restoreTargets[i];
          this.logger.log(
            `[WA_AUTO_RESTORE_QUEUE] position=${i + 1}/${restoreTargets.length} numberId=${r.id} phone=${r.phone}`,
          );
          await this._autoRestoreNumber(r.id, r.phone);
          if (i < restoreTargets.length - 1) {
            this.logger.log(
              `[WA_RESTORE_QUEUE_NEXT] completed=${i + 1}/${restoreTargets.length} ` +
                `numberId=${r.id} — no active client; advancing to next`,
            );
          }
        }
      }
      // Active numbers with no restorable session → await_manual_reconnect.
      // QR generation at boot is forbidden — it generates unattended QR loops that
      // burn Meta trust signals. The user must explicitly press Connect.
      const noSessionTargets = rows.filter(
        (r) => r.is_active && !this._hasRestorableSession(r.id),
      );
      if (noSessionTargets.length) {
        this.logger.log(
          `[MKT_BOOT] ${noSessionTargets.length} active number(s) have no restorable session ` +
            `— setting awaiting_manual_reconnect (NO automatic QR)`,
        );
        for (const r of noSessionTargets) {
          let st = this.clients.get(r.id);
          if (!st) {
            st = makeState();
            this.clients.set(r.id, st);
            this._startWatchdog(r.id, st);
          } else {
            // Clean any partial state from a previous lifecycle without launching Chrome.
            st.client = null;
            st.listenersAttached = false;
            st.bridgeReady = false;
            st.destroyed = false;
          }
          st.sessionAvailable = false;

          // Detect the partial-session fingerprint: leveldb exists but blob is missing.
          // This is left behind when a previous QR auth was interrupted (nodemon restart /
          // process crash) after Chrome started writing but before auth completed.
          const isPartial = this._isPartialSession(r.id);
          st.partialSession = isPartial;
          if (isPartial) {
            this.logger.warn(
              `[PARTIAL_SESSION_DETECTED] numberId=${r.id} phone=${r.phone} ` +
                `— leveldb exists but blob missing; previous QR auth was interrupted. ` +
                `Click Connect → scan QR to complete auth. Session dir is preserved.`,
            );
          } else {
            this.logger.log(
              `[RESTORE_FAILED_MANUAL_REQUIRED] numberId=${r.id} phone=${r.phone} ` +
                `reason=no_restorable_session_at_boot — user must click Connect`,
            );
          }
          this._transitionState(
            r.id,
            st,
            'awaiting_manual_reconnect',
            'no_session_at_boot',
          );
          await this._updateNumberWaState(r.id, 'awaiting_manual_reconnect');
        }
      }
    } catch (e: any) {
      this.logger.warn(`[MKT_BOOT] startup scan failed: ${e?.message}`);
    }

    this.logger.log('[MKT_BOOT] module fully initialized');
  }

  async onModuleDestroy() {
    this.logger.log('[MKT_WA] Shutdown — destroying all clients');

    // Warn clearly when a shutdown interrupts an in-flight QR auth.
    // These numbers will have partial session files (leveldb written, blob not yet created)
    // and will need manual Connect + QR scan on next boot.
    const midAuthStates: WaState[] = [
      'initializing',
      'awaiting_scan',
      'authenticating',
    ];
    for (const [id, state] of this.clients) {
      if (midAuthStates.includes(state.waState)) {
        this.logger.warn(
          `[QR_AUTH_INTERRUPTED] numberId=${id} waState=${state.waState} — ` +
            `process shutting down during QR auth; session dir will have leveldb but no blob. ` +
            `Next boot: click Connect and scan QR again to complete auth.`,
        );
      }
    }

    const shutdowns: Promise<void>[] = [];
    for (const [id, state] of this.clients) {
      state.terminating = true;
      state.destroyed = true;
      this._clearTimers(state, true);
      shutdowns.push(this._destroyClient(id, state));
    }
    await Promise.allSettled(shutdowns);
  }

  private async _autoRestoreNumber(
    numberId: string,
    phone: string,
  ): Promise<void> {
    const RESTORE_TIMEOUT_MS = 90_000;
    this.logger.log(
      `[RESTORE_ATTEMPT] numberId=${numberId} phone=${phone} sessionExists=true — attempting silent restore`,
    );

    // connectNumber() is synchronous up to its first await — state is in clients Map before we yield.
    // isManual=false: auto-restore must NEVER generate a QR. The qr gate handles that.
    this.connectNumber(numberId, false).catch(() => {});

    const state = this.clients.get(numberId);
    if (!state) {
      this.logger.warn(
        `[WA_AUTO_RESTORE_FAILED] numberId=${numberId} phone=${phone} reason=no_state_created`,
      );
      return;
    }

    const result = await new Promise<'success' | 'failed'>((resolve) => {
      if (state.waState === 'ready') {
        resolve('success');
        return;
      }

      const subRef: { current: { unsubscribe(): void } | null } = {
        current: null,
      };

      const timer = setTimeout(() => {
        subRef.current?.unsubscribe();
        resolve('failed');
      }, RESTORE_TIMEOUT_MS);

      subRef.current = state.qrSubject.subscribe((json: string) => {
        try {
          const msg = JSON.parse(json) as { type: string; state?: string };
          if (msg.type === 'ready') {
            clearTimeout(timer);
            subRef.current?.unsubscribe();
            resolve('success');
          } else if (
            msg.type === 'error' ||
            (msg.type === 'state_change' &&
              (msg.state === 'idle' ||
                msg.state === 'failed' ||
                msg.state === 'awaiting_manual_reconnect'))
          ) {
            // awaiting_manual_reconnect means the QR gate fired (session expired server-side)
            // or a hard error occurred — either way, manual action is required.
            clearTimeout(timer);
            subRef.current?.unsubscribe();
            resolve('failed');
          }
        } catch {}
      });
    });

    if (result === 'success') {
      this.logger.log(
        `[WA_AUTO_RESTORE_SUCCESS] numberId=${numberId} phone=${phone} waState=${state.waState}`,
      );
      return;
    }

    // 'failed': session expired server-side (QR gate fired → already awaiting_manual_reconnect),
    // restore timeout, or hard error. Auth files are PRESERVED — the session may be recoverable
    // on the next attempt. Chrome is already torn down by the QR gate; if not, tear down here.
    this.logger.warn(
      `[RESTORE_FAILED_MANUAL_REQUIRED] numberId=${numberId} phone=${phone} ` +
        `waState=${state.waState} — restore failed; manual reconnect required`,
    );

    if (state.waState !== 'awaiting_manual_reconnect') {
      // QR gate did not fire (e.g. timeout before any QR) — clean up Chrome and set state.
      try {
        state.terminating = true;
        this._clearTimers(state);
        await this._destroyClient(numberId, state);
        this._transitionState(
          numberId,
          state,
          'awaiting_manual_reconnect',
          'auto_restore_failed',
        );
        await this._updateNumberWaState(numberId, 'awaiting_manual_reconnect');
        state.terminating = false;
      } catch (e: any) {
        this.logger.warn(
          `[WA_RESTORE_CLEANUP] numberId=${numberId} error: ${e?.message}`,
        );
        state.terminating = false;
      }
    }
    this.logger.log(
      `[WA_RESTORE_CLEANUP_COMPLETE] numberId=${numberId} phone=${phone} ` +
        `waState=${state.waState} — Chrome stopped; awaiting manual Connect click`,
    );
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  async connectNumber(numberId: string, isManual = false): Promise<void> {
    this.logger.log(
      `[WA_OPERATOR_CONNECT] numberId=${numberId} isManual=${isManual} ts=${new Date().toISOString()}`,
    );

    const activeId = this._getActiveNumberId();
    if (activeId && activeId !== numberId) {
      this.logger.warn(
        `[MKT_WA:${numberId}] connect — another number (${activeId}) is also active`,
      );
    }

    let state = this.clients.get(numberId);
    if (!state) {
      state = makeState();
      this.clients.set(numberId, state);
      this._startWatchdog(numberId, state);
      // Cache session availability once at state creation — avoids repeated filesystem reads during
      // health polls. Updated again at ready, forceInvalidateSession, and reset flows.
      state.sessionAvailable = this._hasRestorableSession(numberId);
    } else if (!state.watchdogTimer) {
      // Watchdog may have self-cleared: its setInterval callback sets watchdogTimer=null and
      // returns when it detects state.terminating=true (set by forceInvalidateSession).
      // forceInvalidateSession resets terminating=false at the end, but the watchdog is gone.
      // connectNumber only calls _startWatchdog for new states, so without this guard the
      // reconnected session runs permanently without browser-crash detection.
      this.logger.log(
        `[WA_WATCHDOG_RESTART] numberId=${numberId} — watchdog was missing after prior invalidation; restarting`,
      );
      this._startWatchdog(numberId, state);
    }
    if (state.destroyed) {
      this.logger.warn(`[WA_INIT_SKIPPED] ${numberId} — state destroyed`);
      return;
    }
    if (state.terminating || state.destroying) {
      this.logger.warn(
        `[WA_DUPLICATE_BLOCKED] ${numberId} — teardown in progress (waState=${state.waState})`,
      );
      return;
    }
    // Never recreate a client while authentication is in progress — QR has been scanned.
    if (state.waState === 'authenticating') {
      this.logger.warn(
        `[WA_DUPLICATE_BLOCKED] ${numberId} — waState=authenticating, QR scan in progress`,
      );
      return;
    }
    if (state.starting) {
      this.logger.warn(
        `[WA_INIT_SKIPPED] ${numberId} — already starting (waState=${state.waState})`,
      );
      return;
    }
    if (state.client) {
      this.logger.warn(
        `[WA_CLIENT_EXISTS] ${numberId} — client already exists (waState=${state.waState})`,
      );
      return;
    }

    this._metrics.qrToReadyAttempts++;
    state.starting = true;
    // Record whether this connect was triggered manually (user action) or automatically
    // (restore/reconnect). The qr event handler uses this to gate QR generation.
    state.isManualConnect = isManual;
    if (isManual) {
      // Manual click resets the auto-reconnect chain and starts fresh.
      state.autoReconnectAttempts = 0;
    }
    state.qrRefreshCount = 0;
    state.firstQrGeneratedAt = null;
    this._transitionState(numberId, state, 'initializing', 'connect_requested');
    await this._updateNumberWaState(numberId, 'initializing');

    this.logger.log(
      `[WA_INIT_LOCK_ACQUIRED] numberId=${numberId} — queued, waiting for init lock`,
    );
    try {
      await this._withInitLock(numberId, () =>
        this._initClient(numberId, state),
      );
    } catch (e: any) {
      // Init failure — preserve auth files, stop Chrome, wait for operator.
      // Auth files may still be valid; the failure could be a Chromium crash or
      // network issue, not a WA session expiry.
      this.logger.error(
        `[MKT_WA:${numberId}] Init error: ${e?.message} — preserving auth, operator action required`,
      );
      this._metrics.failedBeforeReady++;
      this._logMetrics();
      state.qrSubject.next(
        JSON.stringify({
          type: 'error',
          message: `Init failed: ${e?.message}`,
        }),
      );
      this._stopAndWaitForOperator(numberId, `init_error`);
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
    this._transitionState(
      numberId,
      state,
      'disconnecting',
      'manual_disconnect',
    );
    this._clearTimers(state);
    if (state.client) {
      state.client.removeAllListeners();
    }
    await this._destroyClient(numberId, state);
    await new Promise<void>((r) => setTimeout(r, 5_000));
    state.qrDataUrl = null;
    state.qrGeneratedAt = null;
    state.firstQrGeneratedAt = null;
    state.lastReadyAt = null;
    state.sessionStartedAt = null;
    state.lastDisconnectedAt = new Date();
    state.manualDisconnect = false;
    this._transitionState(numberId, state, 'idle', 'disconnect_complete');
    await this._updateNumberWaState(numberId, 'idle', 'manual_disconnect');
    state.terminating = false;
    state.destroying = false;
  }

  /**
   * RECOVERY UTIL — resets volatile wa_state in DB for every number to null.
   * Does NOT destroy running clients. Call disconnect/:id/connect per number to
   * restart cleanly after this.
   */
  async resetAllConnectionStates(): Promise<{
    affected: number;
    skipped: number;
    ids: string[];
  }> {
    let rows: WhatsappNumber[] = [];
    try {
      rows = await this.numberRepo.find();
    } catch (e: any) {
      this.logger.error(`[RECOVERY] Could not load numbers: ${e?.message}`);
      throw e;
    }

    this.logger.log(
      `[RECOVERY] Starting state reset — ${rows.length} number(s) found`,
    );
    for (const num of rows) {
      this.logger.log(
        `[RECOVERY] Before: id=${num.id} phone=${num.phone} wa_state=${num.wa_state ?? 'null'}`,
      );
    }

    const ids: string[] = [];
    let skipped = 0;
    for (const num of rows) {
      try {
        await this.numberRepo.update(num.id, { wa_state: null });
        ids.push(num.id);
        this.logger.log(
          `[RECOVERY] Reset: ${num.id} (${num.phone}) ${num.wa_state ?? 'null'} → null`,
        );
      } catch (e: any) {
        this.logger.error(
          `[RECOVERY] Failed to reset ${num.id}: ${e?.message}`,
        );
        skipped++;
      }
    }

    this.logger.log(
      `[RECOVERY] Complete — ${ids.length} reset, ${skipped} skipped`,
    );
    return { affected: ids.length, skipped, ids };
  }

  /**
   * HARD RESET — destroys client, removes from memory map, wipes full LocalAuth session dir,
   * and resets DB state to null. Use for corrupted sessions (lock files, bad state).
   * After calling this, use POST /:id/connect to start fresh.
   */
  async hardResetSession(
    numberId: string,
  ): Promise<{ ok: boolean; message: string }> {
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
        try {
          await state.client.logout();
        } catch {
          /* already gone */
        }
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
    this.logger.log(
      `[HARD_RESET] Auth dir: ${sessionDir} exists=${fs.existsSync(sessionDir)}`,
    );
    await this._clearAuthFiles(numberId);
    this.logger.log(`[HARD_RESET] Auth dir wiped for ${numberId}`);

    // Reset DB state to null — clean slate
    try {
      await this.numberRepo.update(numberId, { wa_state: null });
      this.logger.log(`[HARD_RESET] DB wa_state reset to null for ${numberId}`);
    } catch (e: any) {
      this.logger.warn(
        `[HARD_RESET] DB reset failed (non-fatal): ${e?.message}`,
      );
    }

    this.logger.log(
      `[HARD_RESET] Complete for ${numberId} — call /connect to re-pair`,
    );
    return {
      ok: true,
      message: `Hard reset complete for ${numberId}. Call /connect to generate a fresh QR.`,
    };
  }

  async resetNumber(numberId: string): Promise<void> {
    this.logger.log(`[MKT_RESET] Starting reset for ${numberId}`);

    const state = this.clients.get(numberId);
    if (state) {
      state.terminating = true;
      state.manualDisconnect = true;
      this._clearTimers(state);
      if (state.client) {
        state.client.removeAllListeners();
      }
      try {
        await state.client?.logout();
      } catch {
        /* already gone */
      }
      await this._destroyClient(numberId, state);
      // Wait for Chromium child processes to fully exit before deleting files
      await new Promise<void>((r) => setTimeout(r, 5_000));
      state.qrDataUrl = null;
      state.qrGeneratedAt = null;
      state.lastReadyAt = null;
    }

    // Fully wipe LocalAuth — throws if deletion fails
    this.logger.warn(
      '[MKT_AUTH_DELETE_REASON] ' +
        JSON.stringify({ id: numberId, reason: 'manual_hard_reset' }),
    );
    await this._clearAuthFiles(numberId);

    // Only update DB after verified deletion
    try {
      await this.numberRepo.update(numberId, {
        wa_state: null,
        last_connected_at: null,
      });
    } catch (e: any) {
      this.logger.warn(
        `[MKT_RESET] DB update failed (non-fatal): ${e?.message}`,
      );
    }

    if (state) {
      this._transitionState(numberId, state, 'idle', 'manual_hard_reset');
      state.terminating = false;
      state.destroying = false;
      state.sessionAvailable = false;
      state._lastStatusKey = null;
    }

    this.logger.log(
      `[MKT_RESET] true reset complete — phone must re-scan QR — ${numberId}`,
    );
  }

  /** True if the specific number's WA client is live, browser open, and session ready. */
  isConnected(numberId: string): boolean {
    return this.getNumberState(numberId) === NumberConnectionState.CONNECTED;
  }

  getNumberState(numberId: string): NumberConnectionState {
    const status = this.getNumberWaStatus(numberId);
    return status.number_state;
  }

  /** Temporary diagnostic helper — exposes every sub-condition of isConnected() for pool-stage logging. */
  getConnectionDiagnostics(numberId: string): {
    inClientsMap: boolean;
    hasClient: boolean;
    destroyed: boolean;
    waState: string;
    pageExists: boolean;
    pageOpen: boolean;
    browserConnected: boolean;
    isConnectedResult: boolean;
    numberState: NumberConnectionState;
  } {
    const state = this.clients.get(numberId);
    if (!state) {
      return {
        inClientsMap: false,
        hasClient: false,
        destroyed: false,
        waState: 'none',
        pageExists: false,
        pageOpen: false,
        browserConnected: false,
        isConnectedResult: false,
        numberState: NumberConnectionState.DISCONNECTED,
      };
    }
    const page = state.client?.pupPage;
    const browser = state.client?.pupBrowser;
    const pageExists = page != null;
    const pageOpen = pageExists && !(page.isClosed() as boolean);
    return {
      inClientsMap: true,
      hasClient: !!state.client,
      destroyed: !!state.destroyed,
      waState: state.waState,
      pageExists,
      pageOpen,
      browserConnected: !!browser?.isConnected?.(),
      isConnectedResult:
        this.getNumberState(numberId) === NumberConnectionState.CONNECTED,
      numberState: this.getNumberState(numberId),
    };
  }

  /** Called by SenderService/InboxService synchronously after extracting waMessageId, before DB write. */
  registerPendingAck(waMessageId: string, logRowId: string): void {
    this._pendingAckMap.set(waMessageId, logRowId);
  }

  /** Called after DB write commits wa_message_id — prunes map entry if final ACK hasn't already. */
  deregisterPendingAck(waMessageId: string): void {
    if (this._pendingAckMap.has(waMessageId)) {
      this._pendingAckMap.delete(waMessageId);
      this.logger.log(
        `[MKT_ACK_MAP_DELETE] waMessageId=${waMessageId} reason=db_committed`,
      );
    }
  }

  /** True if at least one number is connected. */
  isAnyConnected(): boolean {
    for (const [id] of this.clients) {
      if (this.isConnected(id)) return true;
    }
    return false;
  }

  // Races `promise` against a hard timeout. Logs [MKT_PROTOCOL_TIMEOUT] and throws
  // `<label>_TIMEOUT` if the deadline is exceeded. Cleans up the timer on success.
  private async _withTimeout<T>(
    promise: Promise<T>,
    ms: number,
    label: string,
    numberId?: string,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        this.logger.warn(
          `[MKT_PROTOCOL_TIMEOUT] numberId=${numberId ?? 'unknown'} operation=${label} elapsedMs=${ms}`,
        );
        reject(new Error(`${label}_TIMEOUT`));
      }, ms);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Pre-send health guard — read-only validation, no side effects on failure.
   * Checks: client presence, page liveness, client.info/wid, WA protocol state (getState).
   * On failure: logs [WA_HEALTH_FAIL] and throws. Never mutates waState, never calls
   * forceInvalidateSession. Session lifecycle is owned by the watchdog and event handlers
   * (pupBrowser disconnected, WA disconnected event) — not by a per-send probe.
   * On success: logs [WA_HEALTH_PASS] with wid + wa_state.
   *
   * window.Store and getChats probes are intentionally absent:
   *   - sendMessage() uses window.WWebJS (injected by wwebjs), not window.Store
   *   - window.WWebJS presence is guaranteed by the time waState=ready (wwebjs fires 'ready'
   *     only after confirming WWebJS injection in Client.js:308)
   *   - getChats (10s probe) adds latency to every send with no benefit for plain text sends
   */
  async assertHealthyClient(numberId: string): Promise<void> {
    const state = this.clients.get(numberId);

    // Check 1: client state + client object.
    // A missing client is NOT corruption — the number is simply offline (disconnected,
    // never connected this run, or after a server restart). Never wipe the session here:
    // forceInvalidateSession → _clearAuthFiles would delete valid LocalAuth files and
    // force a full QR re-scan even though the session on disk is perfectly healthy.
    if (!state || !state.client) {
      this.logger.error(
        `[WA_HEALTH_FAIL] numberId=${numberId} reason=no_client`,
      );
      throw new Error('WhatsApp client unhealthy');
    }

    // Checks 2–7: log the failure reason and throw so the caller (send path) receives
    // a clean error. Do NOT mutate waState, do NOT call forceInvalidateSession.
    // Rationale: health checks run on every send attempt. Transient conditions
    // (Store reloading, brief IPC lag, page mid-navigation) must not permanently destroy
    // the session. The watchdog (WATCHDOG_MS interval) and pupBrowser/WA disconnect
    // event handlers are the correct owners of session invalidation.
    const fail = (reason: string): never => {
      this.logger.error(
        `[WA_HEALTH_FAIL] numberId=${numberId} reason=${reason}`,
      );
      throw new Error('WhatsApp client unhealthy');
    };

    const client = state.client;

    // Check 2: pupPage exists and is open
    const page = client.pupPage;
    if (!page || page.isClosed()) return fail('no_page_or_closed');

    // Check 3: client.info populated
    if (!client.info) return fail('no_client_info');

    // Check 4: wid present (confirms session is authenticated)
    if (!client.info.wid) return fail('no_wid');

    // Check 5: WA-layer session state via getState()
    let waState: string | null = null;
    try {
      waState = await this._withTimeout(
        client.getState(),
        8_000,
        'GET_STATE',
        numberId,
      );
    } catch (e: any) {
      return fail(`getState_threw:${(e?.message ?? '').slice(0, 80)}`);
    }
    const validWaStates = ['CONNECTED', 'OPENING', 'PAIRING'];
    if (!waState || !validWaStates.includes(waState)) {
      return fail(`bad_wa_state:${waState ?? 'null'}`);
    }

    this.logger.log(
      `[WA_HEALTH_PASS] numberId=${numberId} wid=${client.info?.wid?.user ?? 'unknown'} ` +
        `wa_state=${waState}`,
    );
  }

  /**
   * Send a message via a specific number's WA client.
   * Hard safety: verifies browser + session health, normalizes phone, checks WA registration.
   * Returns the raw WA Message object so callers can verify result.id exists.
   */
  async sendViaNumber(
    numberId: string,
    phone: string,
    body: string,
  ): Promise<any> {
    const state = this.clients.get(numberId);
    this.logger.log(
      `[MKT_SEND_START] numberId=${numberId} phone=${phone} bodyLength=${body.length}`,
    );

    if (!state || state.destroyed) {
      throw new Error(`[SEND_SKIPPED] ${numberId} — no client state`);
    }
    if (state.starting) {
      throw new Error(`[SEND_SKIPPED] ${numberId} — reconnecting`);
    }
    if (state.waState !== 'ready' || !state.client) {
      throw new Error(
        `[SEND_SKIPPED] ${numberId} — not ready (waState=${state.waState})`,
      );
    }

    const page = state.client.pupPage;
    const browserAlive = state.client.pupBrowser?.isConnected?.() ?? false;
    const pageOpen = page != null && !page.isClosed();
    if (!browserAlive || !pageOpen) {
      // Browser unhealthy at send time — stop cleanly, preserve auth, do not wipe session.
      this.logger.warn(
        `[WA_SESSION_PRESERVED] ${numberId} — browser unhealthy at send time; preserving auth for restore`,
      );
      this._stopAndWaitForOperator(numberId, 'send_browser_unhealthy');
      throw new Error(`[SEND_SKIPPED] ${numberId} — browser unhealthy`);
    }

    // Normalize phone: strip leading + and all whitespace before appending @c.us
    const normalized = phone
      .replace(/^\+/, '')
      .replace(/\s+/g, '')
      .replace(/-/g, '');
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
        registered = await this._withTimeout(
          state.client.isRegisteredUser(target),
          10_000,
          'REGISTER_CHECK',
          numberId,
        );
        this.logger.log(
          `[MKT_WA_REGISTERED] target=${target} registered=${registered}`,
        );
      } catch (regErr: any) {
        this.logger.warn(
          `[MKT_WA_REGISTERED] target=${target} check_threw="${regErr?.message}" — proceeding with send`,
        );
        registered = true; // let the send attempt surface the real error
      }
      if (!registered) {
        throw new Error(
          `INVALID_WA_NUMBER: ${target} is not registered on WhatsApp`,
        );
      }
    } else {
      this.logger.warn(
        `[MKT_WA_REGISTERED] isRegisteredUser not available on this client — skipping check`,
      );
    }

    // Deep health validation — confirms browser, page, WA session, Store, and IPC are all live
    await this.assertHealthyClient(numberId);

    this.logger.log(
      `[MKT_WA_SEND_CALL] numberId=${numberId} chatId=${target} messageLength=${body.length}`,
    );

    let result: any;
    try {
      result = await this._safeEval(numberId, state, () =>
        state.client.sendMessage(target, body),
      );
    } catch (sendErr: any) {
      this.logger.error(
        `[MKT_WA_SEND_FAIL] numberId=${numberId} chatId=${target} error="${sendErr?.message}"`,
      );
      throw sendErr;
    }

    const resultId = result?.id?._serialized ?? result?.id ?? null;
    this.logger.log(
      `[MKT_WA_SEND_SUCCESS] numberId=${numberId} chatId=${target} ` +
        `messageId=${resultId} timestamp=${new Date().toISOString()}`,
    );

    return result;
  }

  /**
   * Send a product image with promotional caption.
   * Uses MessageMedia.fromUrl() to fetch the Shopify CDN image.
   * Falls back to text-only via sendViaNumber() if image fetch fails or times out.
   * Returns { sentAsImage: boolean } so the caller can log the send path.
   */
  async sendViaNumberWithImage(
    numberId: string,
    phone: string,
    imageUrl: string,
    caption: string,
  ): Promise<{
    result: any;
    sentAsImage: boolean;
    imageFetchMs: number;
    imageSizeKb: number | null;
  }> {
    let media: any;
    let imageFetchMs = 0;
    let imageSizeKb: number | null = null;

    try {
      const { MessageMedia } = require('whatsapp-web.js');
      const fetchStart = Date.now();
      media = await Promise.race([
        MessageMedia.fromUrl(imageUrl, { unsafeMime: true }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('IMAGE_FETCH_TIMEOUT')), 12_000),
        ),
      ]);
      imageFetchMs = Date.now() - fetchStart;
      // Estimate decoded size from base64 string length (base64 ≈ 4/3 of raw bytes)
      if (media?.data) {
        imageSizeKb = Math.round((media.data.length * 0.75) / 1024);
      }
    } catch (err: any) {
      this.logger.warn(
        `[MKT_IMG_FETCH_FAIL] numberId=${numberId} imageUrl=${imageUrl} err="${err?.message}" — falling back to text`,
      );
      const result = await this.sendViaNumber(numberId, phone, caption);
      return { result, sentAsImage: false, imageFetchMs, imageSizeKb: null };
    }

    const state = this.clients.get(numberId);
    if (!state?.client || state.waState !== 'ready') {
      throw new Error(`[SEND_SKIPPED] ${numberId} — not ready for image send`);
    }

    const normalized = phone
      .replace(/^\+/, '')
      .replace(/\s+/g, '')
      .replace(/-/g, '');
    const target = `${normalized}@c.us`;

    let result: any;
    try {
      result = await this._safeEval(numberId, state, () =>
        state.client.sendMessage(target, media, { caption }),
      );
      this.logger.log(
        `[MKT_IMG_SEND_OK] numberId=${numberId} phone=${phone} ` +
          `messageId=${result?.id?._serialized ?? 'null'} fetchMs=${imageFetchMs} sizeKb=${imageSizeKb ?? 'unknown'}`,
      );
    } catch (sendErr: any) {
      this.logger.warn(
        `[MKT_IMG_SEND_FAIL] numberId=${numberId} phone=${phone} err="${sendErr?.message}" — falling back to text`,
      );
      const fallback = await this.sendViaNumber(numberId, phone, caption);
      return {
        result: fallback,
        sentAsImage: false,
        imageFetchMs,
        imageSizeKb: null,
      };
    }

    return { result, sentAsImage: true, imageFetchMs, imageSizeKb };
  }

  /**
   * Request a phone-number pairing code instead of a QR code.
   *
   * Architecture: Destroys any existing QR-mode client and reinitializes with the
   * pairWithPhoneNumber option set in the wwebjs Client constructor. This is required
   * because WhatsApp Web's startAltLinkingFlow() rejects calls made on a page that was
   * already initialized in QR mode (error "t"). The correct approach is to initialize
   * the WhatsApp Web page in phone-link mode from the start.
   *
   * The 'authenticated' and 'ready' events fire normally after the operator enters the
   * pairing code in their WhatsApp app.
   *
   * Phone number must include country code with no '+' (e.g. 919381852555 for India).
   */
  async requestPhoneLink(
    numberId: string,
    phoneNumber: string,
  ): Promise<{ code: string }> {
    // ── Pre-flight snapshot ─────────────────────────────────────────────────
    const existingState = this.clients.get(numberId);
    const page = existingState?.client?.pupPage ?? null;
    const browser = existingState?.client?.pupBrowser ?? null;
    const pageOpen = page ? !page.isClosed?.() : false;
    const browserOk = browser ? browser.isConnected?.() : false;

    this.logger.log(
      `[WA_PHONE_LINK_PREFLIGHT] numberId=${numberId}` +
        ` waState=${existingState?.waState ?? 'no_state'}` +
        ` clientExists=${!!existingState?.client}` +
        ` pageExists=${!!page}` +
        ` pageOpen=${pageOpen}` +
        ` browserConnected=${browserOk}` +
        ` rawPhone="${phoneNumber}"`,
    );

    // ── State guard ─────────────────────────────────────────────────────────
    // Block if auth is in progress (QR scan was accepted, do not interrupt).
    if (existingState?.waState === 'authenticating') {
      throw new Error(
        `[WA_PHONE_LINK] ${numberId} — waState=authenticating; QR scan is in progress. ` +
          `Wait for the current authentication to complete or reset the number first.`,
      );
    }
    if (existingState?.waState === 'ready') {
      throw new Error(
        `[WA_PHONE_LINK] ${numberId} — waState=ready; number is already connected.`,
      );
    }
    if (existingState?.starting) {
      throw new Error(
        `[WA_PHONE_LINK] ${numberId} — client is already starting (waState=${existingState.waState}). Wait and retry.`,
      );
    }

    // ── Phone normalization ─────────────────────────────────────────────────
    const normalized = phoneNumber.replace(/\D/g, '');
    if (normalized.length < 11) {
      throw new Error(
        `[WA_PHONE_LINK] Invalid phone number "${phoneNumber}" — must include country code ` +
          `(e.g. 919381852555 for India, not 9381852555). ` +
          `Got ${normalized.length} digits after stripping — need at least 11.`,
      );
    }

    // ── Get or create state ─────────────────────────────────────────────────
    let state = existingState;
    if (!state) {
      state = makeState();
      this.clients.set(numberId, state);
      this._startWatchdog(numberId, state);
      state.sessionAvailable = this._hasRestorableSession(numberId);
    }

    this.logger.log(
      `[WA_PHONE_LINK_REINIT] numberId=${numberId} normalizedPhone="${normalized}" ` +
        `prevWaState=${state.waState} — destroying QR-mode client and reinitializing in phone-link mode`,
    );

    // ── Clear partial session dir so Chromium starts fresh ─────────────────
    // The partial session (LevelDB without blob) is left on disk by _destroyClient.
    // When a new Client reuses the same userDataDir, WA Web loads with stale IndexedDB
    // data from the old QR-mode flow. This causes requestPairingCode()'s pupPage.evaluate()
    // to hang (PairingCodeLinkUtils null) or throw new t("t") — either way the code event
    // never fires. Deleting the directory forces a completely clean Chromium profile.
    if (!this._hasRestorableSession(numberId)) {
      const sessionDir = this._getSessionDir(numberId);
      if (fs.existsSync(sessionDir)) {
        this.logger.log(
          `[WA_PHONE_LINK_SESSION_CLEAR] numberId=${numberId} ` +
            `removing partial session at ${sessionDir} — no blob, LevelDB only`,
        );
        try {
          fs.rmSync(sessionDir, { recursive: true, force: true });
        } catch (e: any) {
          this.logger.warn(
            `[WA_PHONE_LINK_SESSION_CLEAR] numberId=${numberId} failed to remove session dir: ${e?.message}`,
          );
        }
      }
    } else {
      this.logger.log(
        `[WA_PHONE_LINK_SESSION_SKIP_CLEAR] numberId=${numberId} ` +
          `restorable session present (blob exists) — keeping session dir`,
      );
    }

    // ── Promise resolved by the 'code' event handler in _initClient ────────
    const codePromise = new Promise<string>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        state.phoneLinkResolve = null;
        reject(
          new Error(
            `[WA_PHONE_LINK] 120s timeout — no pairing code received for ${numberId} phone="${normalized}". ` +
              `Verify the phone number is registered on WhatsApp.`,
          ),
        );
      }, 120_000);

      state.phoneLinkResolve = (code: string) => {
        clearTimeout(timeoutId);
        resolve(code);
      };
    });

    // ── Reinitialize in phone-link mode ─────────────────────────────────────
    state.starting = true;
    state.isManualConnect = true;
    state.autoReconnectAttempts = 0;
    state.qrRefreshCount = 0;
    state.firstQrGeneratedAt = null;
    state.qrDataUrl = null;
    // Reset to idle first — forward-only state machine blocks awaiting_scan → initializing
    // (regression). Going via idle (always allowed) lets us then move forward cleanly.
    this._transitionState(numberId, state, 'idle', 'phone_link_reinit_reset');
    this._transitionState(numberId, state, 'initializing', 'phone_link_reinit');
    await this._updateNumberWaState(numberId, 'initializing');

    try {
      await this._withInitLock(numberId, () =>
        this._initClient(numberId, state, 0, normalized),
      );
    } catch (initErr: any) {
      state.phoneLinkResolve = null;
      state.starting = false;
      this.logger.error(
        `[WA_PHONE_LINK_INIT_FAIL] numberId=${numberId} phone="${normalized}" ` +
          `initError="${initErr?.message}"`,
      );
      throw new Error(
        `[WA_PHONE_LINK] Chromium init failed for ${numberId}: ${initErr?.message}`,
      );
    } finally {
      state.starting = false;
    }

    this.logger.log(
      `[WA_PHONE_LINK_WAITING] numberId=${numberId} phone="${normalized}" ` +
        `— Chromium up, waiting for WhatsApp Web to generate pairing code (120s timeout)`,
    );

    const code = await codePromise;
    this.logger.log(
      `[WA_PHONE_LINK_CODE] numberId=${numberId} code=${code} — operator should enter this in WhatsApp → Linked Devices → Link with phone number`,
    );
    return { code };
  }

  getQrObservable(numberId: string): Observable<any> {
    const state = this._getOrCreateState(numberId);
    return merge(
      state.qrSubject
        .asObservable()
        .pipe(map((json) => ({ data: JSON.parse(json) }))),
      interval(30_000).pipe(map(() => ({ data: { type: 'ping' } }))),
    );
  }

  getQrData(numberId: string): {
    active: boolean;
    qr: string | null;
    generatedAt: string | null;
  } {
    const state = this.clients.get(numberId);
    const qrReady = state?.waState === 'awaiting_scan';
    const result = {
      active: qrReady,
      qr: qrReady ? (state.qrDataUrl ?? null) : null,
      generatedAt: qrReady
        ? (state.qrGeneratedAt?.toISOString() ?? null)
        : null,
    };
    this.logger.log(
      `[QR_PIPELINE] stage=api_response id=${numberId} active=${result.active} qrLength=${result.qr?.length ?? 0}`,
    );
    return result;
  }

  getNumberWaStatus(numberId: string): {
    waState: WaState;
    effectiveState: WaState;
    connected: boolean;
    booting: boolean;
    qrActive: boolean;
    lastHeartbeat: string | null;
    lastReadyAt: string | null;
    browserConnected: boolean;
    clientExists: boolean;
    reconnectCount: number;
    qrRefreshCount: number;
    sessionStartedAt: string | null;
    lastDisconnectedAt: string | null;
    firstQrGeneratedAt: string | null;
    sessionAvailable: boolean;
    liveAndReady: boolean;
    bridgeReady: boolean;
    sendCapable: boolean;
    fullyOperational: boolean;
    phoneLinkCode: string | null;
    partial_session: boolean;
    number_state: NumberConnectionState;
  } {
    const state = this.clients.get(numberId);

    // clientExists: the WA client object is alive in memory (not destroyed/null).
    // browserConnected: the Chrome DevTools WebSocket is open (browser process running).
    const clientExists = !!state?.client;
    const browserConnected = clientExists
      ? (state.client?.pupBrowser?.isConnected?.() ?? false)
      : false;

    if (!state) {
      return {
        waState: 'idle',
        effectiveState: 'idle',
        connected: false,
        booting: false,
        qrActive: false,
        lastHeartbeat: null,
        lastReadyAt: null,
        browserConnected: false,
        clientExists: false,
        reconnectCount: 0,
        qrRefreshCount: 0,
        sessionStartedAt: null,
        lastDisconnectedAt: null,
        firstQrGeneratedAt: null,
        sessionAvailable: false,
        liveAndReady: false,
        bridgeReady: false,
        sendCapable: false,
        fullyOperational: false,
        phoneLinkCode: null,
        partial_session: false,
        number_state: NumberConnectionState.DISCONNECTED,
      };
    }

    // Read cached session availability — populated at state creation, ready event, and auth wipes.
    // Never calls _hasRestorableSession() here to avoid filesystem I/O on every health poll.
    const sessionAvailable = state.sessionAvailable;

    const memoryState: WaState = state.waState;

    // Memory is authoritative: if the client and browser are live and memory says ready,
    // return connected=true regardless of any transient intermediate state. This prevents
    // a brief in-flight state write or a page.isClosed() transient from causing a phantom
    // disconnect on the frontend.
    const liveAndReady =
      clientExists &&
      browserConnected &&
      (memoryState === 'ready' || memoryState === 'authenticating');
    const connected =
      liveAndReady || (memoryState === 'ready' && !state.destroyed);

    // effectiveState: what the UI should display.
    // Promotes 'authenticating' → 'ready' when all live-connection signals agree the session
    // is actually up. This covers the 60s window between saved-session restore (wwebjs emits
    // authenticated, browser is live) and the ready-watchdog forcing the ready transition.
    // Raw memoryState is preserved separately for debugging and internal logic.
    const effectiveState: WaState =
      liveAndReady && connected && clientExists && browserConnected
        ? 'ready'
        : memoryState;

    // sendCapable: session is ready and the client can send messages.
    // fullyOperational: send capable AND receive bridge confirmed (initialize() resolved + ready).
    const bridgeReady = state.bridgeReady;
    const sendCapable =
      effectiveState === 'ready' &&
      !state.destroyed &&
      clientExists &&
      browserConnected;
    const fullyOperational = sendCapable && bridgeReady;
    const numberState = resolveNumberConnectionState({
      waState: memoryState,
      effectiveState,
      connected,
      browserConnected,
      clientExists,
    });

    // Only log when the combined status actually changed — prevents identical lines on every
    // health poll. The key encodes every value visible in the log so any real change is captured.
    const statusKey = `${memoryState}:${String(connected)}:${String(liveAndReady)}:${String(browserConnected)}:${String(bridgeReady)}`;
    if (memoryState !== 'idle' && state._lastStatusKey !== statusKey) {
      state._lastStatusKey = statusKey;
      this.logger.log(
        `[WA_STATUS_RESOLVE] ${JSON.stringify({
          id: numberId,
          memoryState,
          browserConnected,
          clientExists,
          destroyed: state.destroyed,
          liveAndReady,
          connected,
        })}`,
      );
      if (effectiveState !== memoryState) {
        this.logger.log(
          `[WA_EFFECTIVE_STATE] ${JSON.stringify({
            numberId,
            memoryState,
            effectiveState,
            connected,
            browserConnected,
            liveAndReady,
            ts: new Date().toISOString(),
          })}`,
        );
      }
    }
    return {
      waState: memoryState,
      effectiveState,
      connected,
      booting: effectiveState === 'initializing',
      qrActive: effectiveState === 'awaiting_scan',
      lastHeartbeat: state.lastHeartbeat?.toISOString() ?? null,
      lastReadyAt: state.lastReadyAt?.toISOString() ?? null,
      browserConnected,
      clientExists,
      reconnectCount: state.reconnectCount,
      qrRefreshCount: state.qrRefreshCount,
      sessionStartedAt: state.sessionStartedAt?.toISOString() ?? null,
      lastDisconnectedAt: state.lastDisconnectedAt?.toISOString() ?? null,
      firstQrGeneratedAt: state.firstQrGeneratedAt?.toISOString() ?? null,
      sessionAvailable,
      liveAndReady,
      bridgeReady,
      sendCapable,
      fullyOperational,
      phoneLinkCode: state.phoneLinkCode ?? null,
      partial_session: state.partialSession,
      number_state: numberState,
    };
  }

  /** In-memory state counts for dashboard observability. */
  getStateBreakdown(): Record<string, number> {
    const counts: Record<string, number> = {
      idle: 0,
      initializing: 0,
      awaiting_scan: 0,
      authenticating: 0,
      ready: 0,
      failed: 0,
      disconnecting: 0,
      awaiting_manual_reconnect: 0,
    };
    for (const [, s] of this.clients) {
      counts[s.waState] = (counts[s.waState] ?? 0) + 1;
    }
    return counts;
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
        clearInterval(state.watchdogTimer);
        state.watchdogTimer = null;
        return;
      }
      if (state.waState !== 'ready') return;

      const browserAlive = state.client?.pupBrowser?.isConnected?.() ?? false;
      const page = state.client?.pupPage;
      const pageOpen = page != null && !page.isClosed();

      if (!browserAlive || !pageOpen) {
        // Browser crashed or page closed — stop cleanly and preserve auth files.
        // A Chromium crash does not mean the WA session is expired. Auth files survive
        // a browser restart and can restore the session silently on next Connect.
        this.logger.warn(
          `[WATCHDOG] ${numberId} — browser unhealthy while ready — stopping and preserving session`,
        );
        this._stopAndWaitForOperator(numberId, 'watchdog_browser_unhealthy');
      }
    }, WATCHDOG_MS);
  }

  // ── Core init per number ─────────────────────────────────────────────────────

  private async _initClient(
    numberId: string,
    state: NumberClientState,
    _restoreRetry = 0,
    phoneLinkNumber?: string,
  ): Promise<void> {
    this.logger.log(
      `[WA_INIT_ENTER] numberId=${numberId} waState=${state.waState} ts=${new Date().toISOString()}`,
    );

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
      const wwebjsDir = require('path').dirname(
        require.resolve('whatsapp-web.js'),
      );
      const wwebjsPuppeteerKey = require.resolve('puppeteer', {
        paths: [wwebjsDir],
      });
      const cache = (require as any).cache as Record<string, any>;
      const extraModule = cache[require.resolve('puppeteer-extra')];
      if (extraModule) cache[wwebjsPuppeteerKey] = extraModule;
    } catch {
      /* stealth unavailable — non-fatal */
    }

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
      throw new Error(
        `[WA_CHROME] Chrome not found at ${CHROME_PATH} — aborting init`,
      );
    }
    const _sessionDir = this._getSessionDir(numberId);
    this._removeSingletonFiles(numberId);

    this.logger.log(
      `[WA_AUDIT] before_client_create — ${numberId} chrome=${CHROME_PATH}`,
    );
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
      // When phone linking is requested: initialize in phone-link mode so WhatsApp Web
      // sets up ALT_DEVICE_LINKING internally from the start. Calling requestPairingCode()
      // externally on a QR-mode client fails (WA Web error "t") because the page was already
      // committed to QR mode. The pairWithPhoneNumber option makes wwebjs call
      // requestPairingCode() during initialize() before any QR mode is established.
      ...(phoneLinkNumber
        ? {
            pairWithPhoneNumber: {
              phoneNumber: phoneLinkNumber,
              showNotification: true,
            },
          }
        : {}),
    });
    this.logger.log(
      `[WA_CLIENT_CREATED] ${numberId} — new wwebjs Client instantiated (waState=${state.waState})`,
    );

    // ── Event handlers ──────────────────────────────────────────────────────────

    // Heartbeat: updated on every WA event to prove Chromium is alive
    const beat = () => {
      state.lastHeartbeat = new Date();
    };

    // Pre-attach diagnostics: all counts must be 0 on a fresh client.
    // Non-zero means something attached listeners before _initClient — a bug.
    const WA_TRACKED_EVENTS = [
      'qr',
      'authenticated',
      'ready',
      'disconnected',
      'auth_failure',
      'message',
      'message_ack',
    ];
    const preCounts: Record<string, number> = {};
    for (const e of WA_TRACKED_EVENTS) {
      preCounts[e] = state.client.listenerCount(e) ?? 0;
    }
    this.logger.log(
      `[WA_LISTENER_ATTACH] pre numberId=${numberId} counts=${JSON.stringify(preCounts)}`,
    );

    if (state.listenersAttached) {
      // Should never happen: _destroyClient clears this flag before new Client is created.
      // Log the anomaly and reset — we MUST attach to the fresh client regardless.
      this.logger.warn(
        `[WA_LISTENER_ATTACH] WARN numberId=${numberId} — listenersAttached=true on a fresh client ` +
          `(flag not cleared by _destroyClient). Resetting and continuing.`,
      );
      state.listenersAttached = false;
    }

    // Heartbeat-only listeners — do not alter state machine
    state.client.on('loading_screen', () => {
      beat();
    });
    state.client.on('change_state', () => {
      beat();
    });

    state.client.on('qr', async (qr: string) => {
      beat();
      this.logger.log(
        `[WA_EVENT_ORDER] qr — ${numberId} prevState=${state.waState} length=${qr?.length ?? 0} ts=${new Date().toISOString()}`,
      );
      if (state.terminating) return;

      // Hard gate: ready → awaiting_scan is a state machine violation. Once the session is
      // ready, all future QR events are ignored unconditionally. wid may be absent transiently
      // after a browser/inject cycle, so the state check is the only reliable signal here.
      if (state.waState === 'ready') {
        this.logger.warn(
          `[WA_QR_IGNORED_READY] numberId=${numberId} qrRefreshCount=${state.qrRefreshCount} — QR event suppressed: session already ready`,
        );
        return;
      }

      // FREEZE QR: suppress once wid is present (session authenticated) or authenticating is in progress.
      if (!!state.client?.info?.wid || state.waState === 'authenticating') {
        this.logger.warn(
          `[WA_QR_SUPPRESSED] ${numberId} waState=${state.waState} wid=${state.client?.info?.wid?.user ?? 'none'} — QR frozen: auth evidence present`,
        );
        return;
      }

      // ── GATE 1: Auto-connect QR block ──────────────────────────────────────────
      // QR generation is only allowed when the user explicitly clicked Connect.
      // Auto-restore and auto-reconnect paths must NEVER generate a QR — session
      // failure on those paths means the user must intervene manually.
      if (!state.isManualConnect) {
        this.logger.warn(
          `[RESTORE_FAILED_MANUAL_REQUIRED] numberId=${numberId} qrRefreshCount=${state.qrRefreshCount} ` +
            `waState=${state.waState} — QR blocked on auto-connect; transitioning to awaiting_manual_reconnect`,
        );
        if (!state.terminating && !state.destroyed) {
          this._transitionState(
            numberId,
            state,
            'awaiting_manual_reconnect',
            'auto_connect_qr_blocked',
          );
          this._updateNumberWaState(
            numberId,
            'awaiting_manual_reconnect',
          ).catch(() => {});
          state.terminating = true;
          this._clearTimers(state);
          this._destroyClient(numberId, state)
            .then(() => {
              state.terminating = false;
            })
            .catch(() => {
              state.terminating = false;
            });
          state.qrSubject.next(
            JSON.stringify({
              type: 'state_change',
              state: 'awaiting_manual_reconnect',
              reason: 'auto_connect_qr_blocked',
              timestamp: new Date().toISOString(),
            }),
          );
        }
        return;
      }

      // ── GATE 2: QR refresh hard limit ──────────────────────────────────────────
      // Each manual Connect generates at most MAX_QR_REFRESH_ATTEMPTS QR codes.
      // Once the limit is reached the lifecycle stops completely — user must click
      // Connect again to get a fresh session attempt.
      if (state.qrRefreshCount >= MAX_QR_REFRESH_ATTEMPTS) {
        this.logger.warn(
          `[QR_LIMIT_REACHED_STOPPING] numberId=${numberId} qrRefreshCount=${state.qrRefreshCount} ` +
            `limit=${MAX_QR_REFRESH_ATTEMPTS} — hard limit exceeded; stopping lifecycle`,
        );
        if (!state.terminating && !state.destroyed) {
          this._transitionState(
            numberId,
            state,
            'awaiting_manual_reconnect',
            'qr_limit_reached',
          );
          this._updateNumberWaState(
            numberId,
            'awaiting_manual_reconnect',
          ).catch(() => {});
          state.terminating = true;
          this._clearTimers(state);
          this._destroyClient(numberId, state)
            .then(() => {
              state.terminating = false;
            })
            .catch(() => {
              state.terminating = false;
            });
          state.qrSubject.next(
            JSON.stringify({
              type: 'qr_limit_reached',
              timestamp: new Date().toISOString(),
            }),
          );
        }
        return;
      }

      state.lastReadyAt = null;

      // qrcode@1.5.4 is pure CJS — (await import('qrcode')).default is undefined; require() gives the real module
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const QRCode = require('qrcode');
      const qrInput =
        process.env.WA_QR_TEST_MODE === 'true' ? 'HELLO_TEST_QR' : qr;

      let dataUrl: string;
      try {
        dataUrl = await QRCode.toDataURL(qrInput, { width: 300 });
      } catch (e: any) {
        this.logger.error(
          `[QR_PIPELINE] toDataURL_failed id=${numberId}: ${e?.message}`,
        );
        return;
      }

      // RACE GUARD — toDataURL is async. authenticated can fire and complete while it
      // executes. wid presence is the authoritative signal that auth occurred during the await.
      if (state.terminating || !!state.client?.info?.wid) {
        this.logger.warn(
          `[WA_QR_SUPPRESSED] ${numberId} waState=${state.waState} wid=${state.client?.info?.wid?.user ?? 'none'} — QR discarded: session advanced during async toDataURL`,
        );
        return;
      }

      this._transitionState(numberId, state, 'awaiting_scan', 'qr_received');
      state.qrGeneratedAt = new Date();
      state.qrRefreshCount++;
      // Always update stored QR and push to subscribers — WA codes expire every ~20s.
      // The post-scan suppression guard above (wid present || authenticating) handles
      // the case where the user has already scanned; this path only runs pre-scan.
      state.qrDataUrl = dataUrl;
      state.qrSubject.next(
        JSON.stringify({
          type: 'qr',
          dataUrl,
          timestamp: new Date().toISOString(),
        }),
      );
      if (state.qrRefreshCount === 1) {
        state.firstQrGeneratedAt = new Date();
        this.logger.log(
          `[WA_QR_CREATED] ${numberId} — first QR generated and ready for scan`,
        );
        this.logger.log(
          `[QR_GENERATED_MANUAL] numberId=${numberId} isManualConnect=${state.isManualConnect} qrRefreshCount=${state.qrRefreshCount} limit=${MAX_QR_REFRESH_ATTEMPTS}`,
        );
        await this._updateNumberWaState(numberId, 'awaiting_scan');
      } else {
        this.logger.log(
          `[WA_QR_REFRESH] ${numberId} — QR refresh #${state.qrRefreshCount} waState=${state.waState} — display updated`,
        );
      }
    });

    state.client.on('authenticated', () => {
      beat();
      if (state.terminating) return;
      this.logger.log(
        `[WA_EVENT_ORDER] authenticated — ${numberId} waState=${state.waState}`,
      );

      // Guard: wwebjs can emit 'authenticated' multiple times per session.
      //   Case 1: waState=ready  — late event after session is fully up. Ignoring prevents a
      //           ready→authenticating regression that arms a fresh 180s auth timeout and destroys
      //           the healthy session.
      //   Case 2: waState=authenticating — duplicate event during session restore. Ignoring prevents
      //           the authTimeout (180s) and readyWatchdog (60s) from being reset, which would defer
      //           or permanently suppress the watchdog recovery path.
      if (state.waState === 'ready' || state.waState === 'authenticating') {
        this.logger.warn(
          `[WA_AUTH_EVENT_IGNORED] ${JSON.stringify({
            id: numberId,
            reason:
              state.waState === 'ready'
                ? 'late_authenticated_after_ready'
                : 'duplicate_authenticated_while_authenticating',
            ts: new Date().toISOString(),
          })}`,
        );
        return;
      }

      this._transitionState(
        numberId,
        state,
        'authenticating',
        'authenticated_event',
      );
      state.authenticatedAt = Date.now();
      state.qrDataUrl = null;
      state.qrGeneratedAt = null;
      this.logger.log(
        `[WA_QR_LOOP_STOPPED] numberId=${numberId} trigger=authenticated qrRefreshCount=${state.qrRefreshCount}`,
      );
      state.qrSubject.next(
        JSON.stringify({
          type: 'authenticated',
          timestamp: new Date().toISOString(),
        }),
      );
      if (state.authTimeoutId) {
        clearTimeout(state.authTimeoutId);
      }
      // Auth watchdog: safe to arm unconditionally here — the waState===ready early-return above
      // guarantees we only reach this line when state is genuinely entering authenticating.
      state.authTimeoutId = setTimeout(() => {
        state.authTimeoutId = null;
        if (
          state.waState === 'authenticating' &&
          !state.destroyed &&
          !state.manualDisconnect
        ) {
          this.logger.warn(
            `[AUTH_TIMEOUT] ${numberId} — ${AUTH_TIMEOUT_MS / 1000}s elapsed after authenticated without ready`,
          );
          this._transitionState(numberId, state, 'failed', 'auth_timeout');
          this._updateNumberWaState(numberId, 'failed');
        }
      }, AUTH_TIMEOUT_MS);

      // Ready watchdog — fires 10 s after authenticated if 'ready' never arrived.
      // Covers restored sessions where wwebjs skips emitting 'ready' after re-establishing
      // the session (client.info is populated, browser alive, but ready event never fires).
      // 10 s is sufficient: wid + browser alive at the time authenticated fires means the
      // session is already established — ready is missing only because wwebjs skipped it.
      if (state.readyWatchdogTimeoutId) {
        clearTimeout(state.readyWatchdogTimeoutId);
      }
      state.readyWatchdogTimeoutId = setTimeout(() => {
        state.readyWatchdogTimeoutId = null;
        if (
          state.waState !== 'authenticating' ||
          !state.client ||
          state.destroyed ||
          state.terminating
        )
          return;

        const browserAlive = state.client.pupBrowser?.isConnected?.() ?? false;
        const widExists = !!state.client.info?.wid;
        this.logger.log(
          `[WA_READY_RECOVERY_CHECK] ${JSON.stringify({
            id: numberId,
            waState: state.waState,
            widExists,
            browserConnected: browserAlive,
            ts: new Date().toISOString(),
          })}`,
        );

        // Fast-path: if all recovery signals are present, execute immediately without
        // waiting for the watchdog's full trigger/fallback flow below.
        if (widExists && browserAlive) {
          this.logger.warn(
            `[WA_READY_WATCHDOG_TRIGGER] ${JSON.stringify({ id: numberId, waState: state.waState, authenticatedAt: state.authenticatedAt, fast_path: true, ts: new Date().toISOString() })}`,
          );
        } else {
          if (!browserAlive) return;
          this.logger.warn(
            `[WA_READY_WATCHDOG_TRIGGER] ${JSON.stringify({ id: numberId, waState: state.waState, authenticatedAt: state.authenticatedAt, ts: new Date().toISOString() })}`,
          );
        }

        const info = state.client.info;
        if (info) {
          this.logger.warn(
            `[WA_READY_WATCHDOG_RECOVERY] ${JSON.stringify({ id: numberId, wid: info?.wid?.user ?? 'unknown', ts: new Date().toISOString() })}`,
          );
          (async () => {
            try {
              await this._updateNumberConnected(numberId);
              state.qrDataUrl = null;
              state.qrGeneratedAt = null;
              this.logger.log(
                `[WA_QR_LOOP_STOPPED] numberId=${numberId} trigger=ready_watchdog qrRefreshCount=${state.qrRefreshCount}`,
              );
              state.lastReadyAt = new Date();
              state.sessionStartedAt = state.sessionStartedAt ?? new Date();
              this._transitionState(
                numberId,
                state,
                'ready',
                'ready_watchdog_recovery',
              );
              if (bridgeEstablished && state.listenersAttached) {
                const _rwp = state.client?.pupPage;
                if (_rwp && !_rwp.isClosed()) {
                  state.bridgeReady = true;
                  this.logger.log(
                    `[WA_BRIDGE_CONFIRMED] numberId=${numberId} — bridgeReady=true via ready_watchdog`,
                  );
                }
              }
              this.logger.log(
                `[WA_READY_LOCK] numberId=${numberId} — session ready (watchdog); future QR events will be suppressed`,
              );
              this._metrics.qrToReadySuccesses++;
              this._metrics.successfulReadySessions++;
              this._logMetrics();
              const phone = info?.wid?.user ?? null;
              state.qrSubject.next(
                JSON.stringify({
                  type: 'ready',
                  phone,
                  timestamp: new Date().toISOString(),
                }),
              );
              this.logger.log(
                `[WA_READY_COMPLETE] ${JSON.stringify({ id: numberId, phone, waState: state.waState, ts: new Date().toISOString() })}`,
              );
            } catch (err: any) {
              this.logger.error(
                `[WA_READY_WATCHDOG_RECOVERY_FAIL] ${JSON.stringify({ id: numberId, error: err?.message, ts: new Date().toISOString() })}`,
              );
              this._transitionState(
                numberId,
                state,
                'failed',
                'ready_watchdog_db_failed',
              );
              this._updateNumberWaState(numberId, 'failed').catch(() => {});
            }
          })().catch((e: any) => {
            this.logger.error(
              `[WA_READY_WATCHDOG_ERROR] ${numberId}: ${e?.message}`,
            );
          });
        } else {
          this.logger.warn(
            `[WA_READY_WATCHDOG_FAILED] ${JSON.stringify({ id: numberId, reason: 'client_info_missing', ts: new Date().toISOString() })}`,
          );
          this._transitionState(
            numberId,
            state,
            'failed',
            'ready_watchdog_no_info',
          );
          this._updateNumberWaState(numberId, 'failed').catch(() => {});
        }
      }, 10_000);
    });

    state.client.on('remote_session_saved', () => {
      /* session persisted to disk */
    });

    state.client.on('ready', async () => {
      beat();
      this.logger.log(
        `[WA_READY_DEBUG] event_fired — ${numberId} waState=${state.waState} terminating=${state.terminating} ts=${new Date().toISOString()}`,
      );
      if (state.terminating) return;
      if (state.authTimeoutId) {
        clearTimeout(state.authTimeoutId);
        state.authTimeoutId = null;
      }
      if (state.readyWatchdogTimeoutId) {
        clearTimeout(state.readyWatchdogTimeoutId);
        state.readyWatchdogTimeoutId = null;
      }
      if (state.postInitGuardId) {
        clearTimeout(state.postInitGuardId);
        state.postInitGuardId = null;
      }
      this.logger.log(
        `[WA_EVENT_ORDER] ready — ${numberId} waState=${state.waState}`,
      );
      this.logger.log(
        `[WA_READY_ENTER] ${JSON.stringify({ id: numberId, waState: state.waState, ts: new Date().toISOString() })}`,
      );
      this.logger.log(
        `[WA_READY_DEBUG] pre_state_check — ${numberId} waState=${state.waState} authTimeoutCleared=${!state.authTimeoutId}`,
      );
      if (state.waState === 'ready') {
        this.logger.warn(
          `[WA_READY_ENTER] skipped — already ready — ${numberId}`,
        );
        return;
      }
      const phone = state.client?.info?.wid?.user ?? null;
      this.logger.log(
        `[WA_READY_DEBUG] pre_db_write — ${numberId} phone=${phone} waState=${state.waState}`,
      );
      try {
        await this._updateNumberConnected(numberId);
        this.logger.log(`[WA_READY_DEBUG] db_write_success — ${numberId}`);
      } catch (err: any) {
        this.logger.error(
          `[WA_READY_DEBUG] db_write_failed — ${numberId} reason=${err?.message}`,
        );
        this.logger.error(
          `[WA_READY_ERROR] ${JSON.stringify({ id: numberId, stage: 'db_write', waState: state.waState, ts: new Date().toISOString() })}`,
        );
        state.qrSubject.next(
          JSON.stringify({
            type: 'error',
            reason: 'db_sync_failed',
            timestamp: new Date().toISOString(),
          }),
        );
        this._stopAndWaitForOperator(numberId, 'ready_db_write_failed');
        return;
      }
      state.qrDataUrl = null;
      state.qrGeneratedAt = null;
      this.logger.log(
        `[WA_QR_LOOP_STOPPED] numberId=${numberId} trigger=ready qrRefreshCount=${state.qrRefreshCount}`,
      );
      state.lastReadyAt = new Date();
      state.sessionStartedAt = state.sessionStartedAt ?? new Date();
      state.sessionAvailable = true;
      state.partialSession = false;
      this._transitionState(numberId, state, 'ready', 'ready_event');
      // Bridge confirmation: both conditions required — bridge functions registered in Chrome
      // (bridgeEstablished) AND listeners attached. Page liveness is an extra safety check.
      if (bridgeEstablished && state.listenersAttached) {
        const _rp = state.client?.pupPage;
        if (_rp && !_rp.isClosed()) {
          state.bridgeReady = true;
          this.logger.log(
            `[WA_BRIDGE_CONFIRMED] numberId=${numberId} — bridgeReady=true via ready_event`,
          );
        }
      }
      this.logger.log(
        `[WA_READY_LOCK] numberId=${numberId} — session ready; future QR events will be suppressed`,
      );
      this.logger.log(
        `[WA_READY_DEBUG] state_transitioned — ${numberId} waState=${state.waState}`,
      );
      this._metrics.qrToReadySuccesses++;
      this._metrics.successfulReadySessions++;
      this._logMetrics();
      state.autoReconnectAttempts = 0;
      state.qrSubject.next(
        JSON.stringify({
          type: 'ready',
          phone,
          timestamp: new Date().toISOString(),
        }),
      );
      this.logger.log(
        `[WA_READY_DEBUG] complete — ${numberId} phone=${phone} waState=${state.waState}`,
      );
      this.logger.log(
        `[WA_READY_COMPLETE] ${JSON.stringify({ id: numberId, phone, waState: state.waState, ts: new Date().toISOString() })}`,
      );
    });

    state.client.on('disconnected', async (reason: string) => {
      beat();
      this.logger.warn(
        `[WA_EVENT_ORDER] disconnected — ${numberId} reason="${reason}" waState=${state.waState}`,
      );
      if (state.terminating) return;
      if (reason === 'NAVIGATION') return;

      // During session establishment (QR scanned, WA handshake in progress), WhatsApp Web
      // emits 'disconnected' with empty string or other transient reasons before 'ready' fires.
      // Invalidating here wipes the just-authenticated session and forces a fresh QR scan.
      // Instead, defer to the authTimeoutId which will fire after AUTH_TIMEOUT_MS if ready never comes.
      if (state.waState === 'authenticating') {
        this.logger.warn(
          `[WA_DISCONNECTED_DEFERRED] ${numberId} reason="${reason}" waState=authenticating ` +
            `— deferring to authTimeout, NOT invalidating session`,
        );
        return;
      }

      // During session-restore: wwebjs emits 'disconnected'('') during the internal page navigation
      // from the WhatsApp loading screen to the chat view. This happens BEFORE 'authenticated' fires,
      // so state is still 'initializing'. Chrome and the WA socket are still alive — 'authenticated'
      // and 'ready' will follow shortly. Invalidating here wipes the restored session unnecessarily.
      if (state.waState === 'initializing' && !reason) {
        this.logger.warn(
          `[WA_DISCONNECTED_DEFERRED] ${numberId} reason="" waState=initializing ` +
            `— session-restore navigation artifact; 'authenticated' expected shortly, NOT invalidating`,
        );
        return;
      }

      // During QR display: wwebjs emits 'disconnected'('') when a QR code expires on WhatsApp's
      // servers and it is about to generate the next one. The browser and WA socket are still alive.
      // Invalidating here would destroy the Chromium process and force the user to press Connect
      // again every ~20s. Defer: the next 'qr' event will refresh the displayed code automatically.
      if (state.waState === 'awaiting_scan' && !reason) {
        this.logger.warn(
          `[WA_DISCONNECTED_DEFERRED] ${numberId} reason="" waState=awaiting_scan ` +
            `— QR rotation artifact from wwebjs, ignoring; next 'qr' event will refresh the code`,
        );
        return;
      }

      // Post-ready artifact: wwebjs emits disconnected(reason='') during its internal session-sync
      // sequence immediately after ready fires. This is NOT a real disconnect — Chrome and the WA
      // socket are still alive. Invalidating here would wipe a healthy session.
      // Guard: only suppress within 10 s of ready; beyond that, treat as a real disconnect.
      if (state.waState === 'ready' && !reason && state.lastReadyAt) {
        const msSinceReady = Date.now() - state.lastReadyAt.getTime();
        if (msSinceReady < 10_000) {
          this.logger.warn(
            `[WA_DISCONNECTED_DEFERRED] ${numberId} reason="" waState=ready msSinceReady=${msSinceReady} ` +
              `— post-ready session-sync artifact, ignoring`,
          );
          return;
        }
      }

      if (state.authTimeoutId) {
        clearTimeout(state.authTimeoutId);
        state.authTimeoutId = null;
      }
      this._autoPause?.recordDisconnect(numberId);
      state.qrSubject.next(
        JSON.stringify({
          type: 'disconnected',
          reason,
          timestamp: new Date().toISOString(),
        }),
      );
      // Session disconnected — stop Chrome, preserve auth files, wait for operator.
      // Auth files survive a disconnect and can restore silently on next Connect click.
      this._stopAndWaitForOperator(
        numberId,
        `wa_disconnected_${reason || 'empty'}`,
      );
    });

    state.client.on('auth_failure', async (msg: string) => {
      beat();
      this.logger.warn(
        `[WA_EVENT_ORDER] auth_failure — ${numberId} prevState=${state.waState} msg="${msg}" ts=${new Date().toISOString()}`,
      );
      if (state.terminating) return;
      if (state.authTimeoutId) {
        clearTimeout(state.authTimeoutId);
        state.authTimeoutId = null;
      }
      state.qrDataUrl = null;
      state.qrGeneratedAt = null;
      this.logger.warn(`[MKT_WA:${numberId}] Auth failure: ${msg}`);
      state.qrSubject.next(
        JSON.stringify({
          type: 'error',
          message: 'Auth failed — device was unlinked. Reconnect to re-pair.',
          timestamp: new Date().toISOString(),
        }),
      );
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
      )
        return;

      // ── Strict phone resolution — only @c.us JIDs accepted ─────────────────
      // contact is fetched for name resolution and as a @c.us fallback.
      // contact.number is logged for diagnostics but NEVER used as a phone source.
      let contact: any = null;
      try {
        contact = await msg.getContact();
      } catch (contactErr: any) {
        this.logger.warn(
          `[MKT_INBOX_MESSAGE] getContact() failed for from=${from}: ${contactErr?.message}`,
        );
      }

      const {
        phone,
        source: phoneSource,
        reason: phoneReason,
      } = resolveCustomerPhone(msg, contact);

      this.logger.log(
        `[MKT_PHONE_RESOLVE] numberId=${numberId} rawFrom=${from} ` +
          `contactId=${contact?.id?._serialized ?? 'n/a'} contactNumber=${contact?.number ?? 'n/a'} ` +
          `resolvedPhone=${phone ?? 'NONE'} source=${phoneSource} reason=${phoneReason}`,
      );

      if (!phone) {
        this.logger.warn(
          `[MKT_INBOX_SKIP_INVALID_PHONE] numberId=${numberId} rawFrom=${from} ` +
            `reason=${phoneReason} — dropping`,
        );
        return;
      }

      const notifyName: string | undefined =
        contact?.pushname ??
        msg?._data?.notifyName ??
        msg?.notifyName ??
        undefined;

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
          `message_id=${msg?.id?._serialized ?? 'none'} body="${messageBody.slice(0, 60)}"`,
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
      this.logger.log(
        `[MKT_WA_ACK] numberId=${numberId} waMessageId=${waMessageId} ack=${ack}`,
      );
      this.logger.log(
        `[ACK_AUDIT] received: numberId=${numberId} waMessageId=${waMessageId} ack=${ack} ack_meaning=${ack === 1 ? 'server_queued' : ack === 2 ? 'device_delivered' : ack === 3 ? 'read' : ack === 4 ? 'played' : 'unknown'}`,
      );
      try {
        if (ack === 2 || ack >= 3) {
          const newStatus = ack >= 3 ? QueueStatus.READ : QueueStatus.DELIVERED;
          const updatePayload: Partial<{
            status: QueueStatus;
            delivered_at: Date;
            read_at: Date;
          }> =
            ack >= 3
              ? { status: QueueStatus.READ, read_at: new Date() }
              : { status: QueueStatus.DELIVERED, delivered_at: new Date() };

          // Fast path: map entry registered synchronously by sender/inbox before DB write commits.
          // Entry is kept alive across ack=2 so that ack=3 can also use the map.
          // Only removed here on final ACK (>=3); sender/inbox deregisters after DB commit.
          const mappedLogId = this._pendingAckMap.get(waMessageId);
          this.logger.log(
            `[MKT_ACK_LOOKUP] waMessageId=${waMessageId} ack=${ack} via=map found=${!!mappedLogId}`,
          );
          if (mappedLogId) {
            if (ack >= 3) {
              this._pendingAckMap.delete(waMessageId);
              this.logger.log(
                `[MKT_ACK_MAP_DELETE] waMessageId=${waMessageId} reason=final_ack ack=${ack}`,
              );
            }
            await this.logRepo.update(mappedLogId, updatePayload);
            this.logger.log(
              `[MKT_ACK_UPDATE] waMessageId=${waMessageId} ack=${ack} new_status=${newStatus} ` +
                `log_id=${mappedLogId} via=map`,
            );
            this.logger.log(
              `[ACK_AUDIT] status_updated: waMessageId=${waMessageId} ack=${ack} new_status=${newStatus} log_id=${mappedLogId} via=map`,
            );
            return;
          }

          // DB fallback: map entry already deregistered (DB committed) or was never registered.
          const existing = await this.logRepo.findOne({
            where: { wa_message_id: waMessageId },
          });
          this.logger.log(
            `[MKT_ACK_LOOKUP] waMessageId=${waMessageId} ack=${ack} via=db found=${!!existing}`,
          );
          if (!existing) {
            this.logger.debug(
              `[MKT_ACK_IGNORED] waMessageId=${waMessageId} ack=${ack} reason=no_matching_outbound_message`,
            );
            this.logger.warn(
              `[ACK_AUDIT] ack_ignored: waMessageId=${waMessageId} ack=${ack} reason=no_matching_log_row — message not in map or DB; may be a non-campaign message`,
            );
            return;
          }

          const result = await this.logRepo.update(
            { wa_message_id: waMessageId },
            updatePayload,
          );
          this.logger.log(
            `[MKT_ACK_UPDATE] waMessageId=${waMessageId} ack=${ack} new_status=${newStatus} ` +
              `log_id=${existing.id} rows_affected=${(result as any)?.affected ?? 'unknown'} via=db`,
          );
          this.logger.log(
            `[ACK_AUDIT] status_updated: waMessageId=${waMessageId} ack=${ack} new_status=${newStatus} log_id=${existing.id} rows_affected=${(result as any)?.affected ?? 'unknown'} via=db`,
          );
        }
      } catch (ackErr: any) {
        this.logger.warn(
          `[MKT_WA_ACK_ERROR] waMessageId=${waMessageId} ack=${ack} error="${ackErr?.message}"`,
        );
        this.logger.error(
          `[ACK_AUDIT] ack_handler_exception: waMessageId=${waMessageId} ack=${ack} error="${ackErr?.message}"`,
        );
      }
    });

    state.listenersAttached = true;

    // ── Phone-link mode: code event handler ─────────────────────────────────────
    // When the client was created with pairWithPhoneNumber, wwebjs calls requestPairingCode()
    // internally during initialize(). When WhatsApp Web generates the pairing code, wwebjs
    // emits 'code'. We store it and resolve any pending requestPhoneLink() call.
    if (phoneLinkNumber) {
      state.client.on('code', (code: string) => {
        beat();
        this.logger.log(
          `[WA_PHONE_LINK_CODE_EVENT] numberId=${numberId} code=${code} — pairing code received from WhatsApp Web`,
        );
        state.phoneLinkCode = code;
        if (state.phoneLinkResolve) {
          const resolve = state.phoneLinkResolve;
          state.phoneLinkResolve = null;
          resolve(code);
        }
      });
    }

    // ── initialize() — release init lock on first event, NOT on ready ─────────
    // initialize() stays pending while user scans QR. QR_READY is a valid stable state.
    // We only abort if Chromium fails to produce any event within BOOT_TIMEOUT_MS.
    // After the first event, initialize() runs indefinitely; events drive the state machine.
    const initStart = Date.now();
    this.logger.log(`[WA_INIT] initialize start — ${numberId}`);

    // True only when initialize() resolves — proving inject() completed and all three bridge
    // functions (onQRChangedEvent, onAppStateHasSyncedEvent, onOfflineProgressUpdateEvent) and
    // the framenavigated re-injection listener are registered in Chrome. Used by the stuck guard
    // to decide whether to preserve or delete auth files on timeout.
    let bridgeEstablished = false;

    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        let bootTimeoutId: ReturnType<typeof setTimeout> | null = null;
        let deadBrowserId: ReturnType<typeof setTimeout> | null = null;

        const settle = (err?: Error) => {
          if (settled) return;
          settled = true;
          if (bootTimeoutId) {
            clearTimeout(bootTimeoutId);
            bootTimeoutId = null;
          }
          if (deadBrowserId) {
            clearTimeout(deadBrowserId);
            deadBrowserId = null;
          }
          if (err) reject(err);
          else resolve();
        };

        // Release init lock on the first WA event — client runs autonomously after this.
        // settled=false when navigate artifact fires → bridge NOT established → retry.
        // settled=true when navigate artifact fires → event fired first → bridge established → continue.
        let navListenerAttached = false;
        const onFirstEvent = (evtName: string) => () => {
          this.logger.log(
            `[WA_INIT_STAGE] first_event=${evtName} numberId=${numberId} elapsed=${Date.now() - initStart}ms — releasing init lock`,
          );
          // Attach framenavigated diagnostic the moment pupPage is confirmed live.
          // Captures every navigation that occurs after the first WA event fires —
          // the critical window for inject() context-destruction race conditions.
          if (!navListenerAttached) {
            navListenerAttached = true;
            const page = state.client?.pupPage;
            if (page) {
              page.on('framenavigated', (frame: any) => {
                this.logger.log(
                  `[WA_NAVIGATION] numberId=${numberId} url="${frame.url()}" duringState=${state.waState}`,
                );
              });
            } else {
              this.logger.warn(
                `[WA_NAVIGATION] numberId=${numberId} pupPage unavailable at first_event=${evtName} — navigation logging skipped`,
              );
            }
          }
          settle();
        };
        state.client.once('loading_screen', onFirstEvent('loading_screen'));
        state.client.once('qr', onFirstEvent('qr'));
        state.client.once('code', onFirstEvent('code')); // phone-link mode: qr never fires
        state.client.once('authenticated', onFirstEvent('authenticated'));
        state.client.once('ready', onFirstEvent('ready'));
        state.client.once('auth_failure', onFirstEvent('auth_failure'));

        // 90s early abort: if Chromium launched but the browser process died before any WA event
        deadBrowserId = setTimeout(() => {
          if (settled) return;
          const browser = state.client?.pupBrowser;
          if (!browser) return; // Chromium not yet attached — too early to judge
          if (!browser.isConnected()) {
            this.logger.error(
              `[WA_BOOT] 90s dead-browser checkpoint — process died — ${numberId}`,
            );
            settle(new Error('Browser dead at 90s checkpoint'));
          }
        }, 90_000);

        // Hard abort only if Chromium boots but produces no event at all
        this.logger.log(`[WA_BOOT] timeout=${BOOT_TIMEOUT_MS}`);
        bootTimeoutId = setTimeout(() => {
          settle(
            new Error(
              `Chromium boot timeout — no WA event in ${BOOT_TIMEOUT_MS / 1000}s`,
            ),
          );
        }, BOOT_TIMEOUT_MS);

        // [WA_AUTH_PATH] — session directory state immediately before Chromium launch
        {
          const authPath = this._getSessionDir(numberId);
          const authExists = fs.existsSync(authPath);
          let rootFiles: string[] = [];
          if (authExists) {
            try {
              rootFiles = fs.readdirSync(authPath);
            } catch {
              /* unreadable */
            }
          }
          const waBase = path.join(
            authPath,
            'Default',
            'IndexedDB',
            'https_web.whatsapp.com_0.indexeddb',
          );
          const blobExists = fs.existsSync(`${waBase}.blob`);
          const leveldbDir = `${waBase}.leveldb`;
          const leveldbExists = fs.existsSync(leveldbDir);
          let ldbFiles: string[] = [];
          if (leveldbExists) {
            try {
              ldbFiles = fs
                .readdirSync(leveldbDir)
                .filter(
                  (f: string) => f.endsWith('.ldb') || f.endsWith('.log'),
                );
            } catch {
              /* unreadable */
            }
          }
          this.logger.log(
            `[WA_AUTH_PATH] numberId=${numberId} path=${authPath} exists=${authExists} ` +
              `root_files=${JSON.stringify(rootFiles)} ` +
              `has_blob=${blobExists} leveldb_exists=${leveldbExists} ` +
              `ldb_files=${JSON.stringify(ldbFiles)} ` +
              `hasRestorableSession=${this._hasRestorableSession(numberId)}`,
          );
        }

        // Start Chromium — runs indefinitely in background after init lock releases
        this.logger.log(
          `[WA_INIT_STAGE] initialize_called numberId=${numberId}`,
        );
        state.client
          .initialize()
          .then(() => {
            // initialize() resolved → inject() completed → bridge fully established.
            bridgeEstablished = true;
            this.logger.log(
              `[WA_BRIDGE_READY] numberId=${numberId} — initialize() resolved; bridge fully established` +
                (_restoreRetry > 0 ? ` after retry ${_restoreRetry}` : ''),
            );
            if (_restoreRetry > 0) {
              this.logger.log(
                `[WA_INIT_SUCCESS_AFTER_RETRY] numberId=${numberId} attempt=${_restoreRetry}`,
              );
            }
            // Fallback: if ready event fired before initialize() resolved, confirm bridge now.
            if (
              state.waState === 'ready' &&
              state.listenersAttached &&
              !state.destroyed &&
              !state.bridgeReady
            ) {
              const _bp = state.client?.pupPage;
              if (_bp && !_bp.isClosed()) {
                state.bridgeReady = true;
                this.logger.log(
                  `[WA_BRIDGE_CONFIRMED] numberId=${numberId} — bridgeReady=true via init_resolved_after_ready`,
                );
              }
            }
            settle();
          })
          .catch((e: any) => {
            const msg: string = e?.message ?? '';

            // "Execution context was destroyed" / "Cannot find context" = Puppeteer threw because
            // WhatsApp's internal page navigated during inject()'s needAuthentication evaluate.
            //
            // Whether this is recoverable depends on settled:
            //   settled=false → inject() threw before ANY WA event fired → bridge NOT established.
            //     onQRChangedEvent / onAppStateHasSyncedEvent / onOfflineProgressUpdateEvent were
            //     never exposed in Chrome. No WA event can reach Node.js. Retry initialization.
            //   settled=true → a WA event (loading_screen/qr/authenticated) fired before the throw.
            //     All three bridge functions must exist for loading_screen/qr to fire (Steps 5-7 of
            //     inject()). Bridge IS established. Late nav cleanup noise — release and continue.
            const isNavigationArtifact =
              msg.includes('Execution context was destroyed') ||
              msg.includes('Cannot find context with specified id');

            if (isNavigationArtifact) {
              if (!settled) {
                // Bridge never established — reject with a sentinel so the outer catch block
                // can destroy the partial Chromium process and retry initialization cleanly.
                const MAX_RESTORE_RETRIES = 2;
                if (_restoreRetry < MAX_RESTORE_RETRIES) {
                  this.logger.warn(
                    `[WA_RESTORE_RETRY] numberId=${numberId} attempt=${_restoreRetry + 1}/${MAX_RESTORE_RETRIES} ` +
                      `— inject() failed before bridge registration: "${msg.slice(0, 80)}" — scheduling retry`,
                  );
                  settle(new Error('__WA_RESTORE_RETRY__'));
                } else {
                  this.logger.error(
                    `[WA_RESTORE_RETRY_LIMIT] numberId=${numberId} — bridge never established after ` +
                      `${MAX_RESTORE_RETRIES} retries: "${msg.slice(0, 80)}" — marking failed, preserving auth`,
                  );
                  settle(new Error('__WA_RESTORE_LIMIT__'));
                }
              } else {
                // Bridge established (event fired first) — late navigation cleanup noise.
                // Release and let the authenticated/ready event flow complete normally.
                this.logger.warn(
                  `[WA_RESTORE_RECOVER] numberId=${numberId} — navigation artifact after first event: ` +
                    `"${msg.slice(0, 80)}" — bridge established, event flow continues`,
                );
                // settled is already true — Promise already resolved, no settle() call needed.
              }
              return;
            }

            if (
              state.terminating &&
              (msg.includes('Target closed') ||
                msg.includes('Session closed') ||
                msg.includes('Protocol error'))
            ) {
              this.logger.log(
                `[WA_CLEANUP] ${numberId} — expected browser shutdown during teardown`,
              );
              if (!settled) settle();
              return;
            }

            this.logger.error(
              `[WA_INIT_STAGE] initialize_rejected numberId=${numberId} error="${msg}"`,
            );
            if (!settled) {
              // No event received yet — Chromium boot genuinely failed
              settle(
                e instanceof Error
                  ? e
                  : new Error(String(e?.message ?? 'Unknown')),
              );
            } else {
              // Late rejection after session was running — stop and preserve auth files.
              this.logger.warn(
                `[WA_INIT_STAGE] late_rejection_after_first_event numberId=${numberId} error="${msg}"`,
              );
              if (
                !state.manualDisconnect &&
                !state.destroyed &&
                !state.terminating
              ) {
                this._stopAndWaitForOperator(
                  numberId,
                  'late_initialize_rejection',
                );
              }
            }
          });
      });
    } catch (promiseErr: any) {
      const errMsg: string = promiseErr?.message ?? '';

      if (errMsg === '__WA_RESTORE_RETRY__') {
        this.logger.log(
          `[WA_RETRY_REASON] numberId=${numberId} attempt=${_restoreRetry + 1}/3 ` +
            `duringState=${state.waState} ` +
            `browserConnected=${!!state.client?.pupBrowser?.isConnected?.()} ` +
            `pageExists=${!!state.client?.pupPage} ` +
            `pageOpen=${state.client?.pupPage ? !(state.client.pupPage.isClosed() as boolean) : false}`,
        );
        this.logger.log(
          `[WA_RESTORE_RETRY] numberId=${numberId} — destroying partial client; ` +
            `waiting 3s before attempt ${_restoreRetry + 1}`,
        );
        // Retry-safe teardown: close browser only — never call client.destroy() or
        // authStrategy.destroy() which could delegate to auth-file operations.
        // Session files (blob, leveldb) must survive across retries.
        {
          const retryClient = state.client;
          if (retryClient && !state.destroying) {
            state.destroying = true;
            try {
              retryClient.removeAllListeners();
            } catch {}
            state.client = null;
            state.listenersAttached = false;
            state.lastHeartbeat = null;
            try {
              const browser = retryClient.pupBrowser;
              if (browser?.isConnected?.()) {
                await browser.close();
              }
            } catch {}
            state.destroying = false;
          }
        }
        this.logger.log(
          `[WA_RETRY_SAFE_DESTROY] numberId=${numberId} retry=${_restoreRetry + 1} ` +
            `logoutSkipped=true sessionDeletionSkipped=true`,
        );
        await new Promise<void>((r) => setTimeout(r, 3_000));
        return this._initClient(numberId, state, _restoreRetry + 1);
      }

      if (errMsg === '__WA_RESTORE_LIMIT__') {
        this.logger.error(
          `[WA_INIT_FAILED_BEFORE_BRIDGE] numberId=${numberId} — restore retry limit exhausted; ` +
            `marking failed, preserving auth files`,
        );
        await this._destroyClient(numberId, state);
        this._transitionState(
          numberId,
          state,
          'failed',
          'restore_retry_exhausted',
        );
        await this._updateNumberWaState(numberId, 'failed');
        state.qrSubject.next(
          JSON.stringify({
            type: 'error',
            reason: 'restore_retry_exhausted',
            timestamp: new Date().toISOString(),
          }),
        );
        return;
      }

      throw promiseErr;
    }

    if (state.terminating) {
      this.logger.log(
        `[WA_CLEANUP] ${numberId} — init aborted due to teardown`,
      );
      return;
    }
    this.logger.log(
      `[WA_INIT] init lock released — ${numberId} — client live, awaiting user action`,
    );
    this.logger.log(
      `[WA_INIT_EXIT] numberId=${numberId} waState=${state.waState} elapsed=${Date.now() - initStart}ms ts=${new Date().toISOString()}`,
    );

    // Post-init stuck guard: loading_screen (the most common first event during a session
    // restore) releases the init lock and clears the boot timeout, but does NOT advance
    // waState. If no subsequent WA event (qr / authenticated / ready) fires, the number
    // stays 'initializing' indefinitely — the watchdog skips non-ready states and the
    // disconnected('') handler defers when waState=initializing. This guard is the only
    // safety net once the boot timeout has been cleared.
    if (state.waState === 'initializing' && !state.destroyed) {
      const postInitGuardMs = BOOT_TIMEOUT_MS;
      this.logger.warn(
        `[WA_INIT_STUCK] numberId=${numberId} — still initializing after init lock released; ` +
          `arming ${postInitGuardMs / 1000}s post-init stuck-guard bridgeEstablished=${bridgeEstablished}`,
      );
      state.postInitGuardId = setTimeout(() => {
        state.postInitGuardId = null;
        if (
          state.waState === 'initializing' &&
          !state.destroyed &&
          !state.terminating
        ) {
          if (!bridgeEstablished) {
            // Bridge was never established — Chrome event bridge does not exist.
            // Preserve auth files: credentials may still be valid; failure was a navigation
            // race during inject(), not a server-side session invalidation.
            this.logger.error(
              `[WA_INIT_FAILED_BEFORE_BRIDGE] numberId=${numberId} — stuck in initializing; ` +
                `bridge never established — marking failed, preserving auth`,
            );
            this._transitionState(
              numberId,
              state,
              'failed',
              'post_init_stuck_no_bridge',
            );
            this._updateNumberWaState(numberId, 'failed').catch(() => {});
            state.qrSubject.next(
              JSON.stringify({
                type: 'error',
                reason: 'post_init_stuck_no_bridge',
                timestamp: new Date().toISOString(),
              }),
            );
          } else {
            this.logger.error(
              `[WA_INIT_STUCK] numberId=${numberId} — stuck in initializing for ` +
                `${postInitGuardMs / 1000}s after first event — stopping and preserving auth`,
            );
            this._stopAndWaitForOperator(
              numberId,
              'post_init_stuck_initializing',
            );
          }
        }
      }, postInitGuardMs);
    }

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
          this.logger.log(
            `[WA_BROWSER_DISCONNECT] ${numberId} — expected during teardown, ignoring`,
          );
          return;
        }
        if (state.manualDisconnect || state.destroyed) return;
        this.logger.warn(
          `[WA_BROWSER_DISCONNECT] ${numberId} — unexpected disconnect; preserving session`,
        );
        this._stopAndWaitForOperator(numberId, 'browser_disconnected');
      });
      this.logger.log(
        `[WA_INIT_STAGE] browser_disconnect_listener_attached numberId=${numberId}`,
      );
    } else {
      this.logger.warn(
        `[WA_INIT_STAGE] pupBrowser_unavailable_post_init numberId=${numberId} — disconnect detection via events only`,
      );
    }
  }

  // ── Private helpers ───────────────────────────────────────────────────────────

  // ── Stop and preserve — the ONLY response to unexpected disconnects ──────────
  // Stops Chrome cleanly. Auth files are NEVER deleted here. State transitions to
  // awaiting_manual_reconnect. Next connectNumber() (manual operator action) will
  // find the auth files and attempt a silent restore — no QR scan needed if the
  // WA server session is still valid.
  //
  // This replaces all auto-reconnect and auto-invalidation logic. The system never
  // takes destructive actions on its own — it stops, preserves, and waits.
  private _stopAndWaitForOperator(numberId: string, reason: string): void {
    if (this._invalidatingIds.has(numberId)) {
      this.logger.log(
        `[WA_SESSION_PRESERVED] numberId=${numberId} — already stopping (${reason})`,
      );
      return;
    }

    const state = this.clients.get(numberId);
    if (!state) return;
    if (state.terminating || state.destroying) return;

    this.logger.warn(
      `[WA_MANUAL_RECONNECT_REQUIRED] numberId=${numberId} reason="${reason}" ` +
        `— stopping Chrome, preserving auth files, waiting for operator`,
    );

    state.terminating = true;
    this._clearTimers(state);

    (async () => {
      this._invalidatingIds.add(numberId);
      try {
        await this._destroyClient(numberId, state);
        // In-memory transition first — UI sees awaiting_manual_reconnect immediately.
        this._transitionState(
          numberId,
          state,
          'awaiting_manual_reconnect',
          reason,
        );
        state.lastDisconnectedAt = new Date();
        state.terminating = false;
        state.destroying = false;
        state.starting = false;
        // Auth files are preserved — _clearAuthFiles is NOT called.
        // connectNumber(isManual=true) will find them and attempt silent restore.
        await this._updateNumberWaState(
          numberId,
          'awaiting_manual_reconnect',
          reason,
        );
        this.logger.log(
          `[WA_SESSION_PRESERVED] numberId=${numberId} reason="${reason}" ` +
            `— auth files preserved; click Connect to restore`,
        );
      } catch (err: any) {
        this.logger.error(
          `[WA_SESSION_PRESERVED_ERROR] numberId=${numberId} error="${err?.message}"`,
        );
        state.terminating = false;
      } finally {
        this._invalidatingIds.delete(numberId);
      }
    })();
  }

  // ── Per-number init lock ─────────────────────────────────────────────────────
  // Ensures only one Chromium process is launching per number at a time.
  // Different numbers can launch concurrently — they hold independent locks.
  private _withInitLock(
    numberId: string,
    fn: () => Promise<void>,
  ): Promise<void> {
    let resolveSlot!: () => void;
    const slot = new Promise<void>((r) => {
      resolveSlot = r;
    });
    const previous = this._initLocks.get(numberId) ?? Promise.resolve();
    this._initLocks.set(numberId, slot);
    return previous.then(async () => {
      this.logger.log(
        `[WA_INIT_LOCK_ACQUIRED] numberId=${numberId} — lock acquired, starting init`,
      );
      try {
        await fn();
      } finally {
        this.logger.log(
          `[WA_INIT_LOCK_RELEASED] numberId=${numberId} — init lock released`,
        );
        resolveSlot();
      }
    });
  }

  // Destroys a client and nulls refs — safe to call when client is already null.
  // destroying flag prevents concurrent calls from racing.
  private async _destroyClient(
    numberId: string,
    state: NumberClientState,
  ): Promise<void> {
    const client = state.client;
    if (!client) {
      this.logger.log(`[WA_DESTROY_STAGE] ${numberId} — no client, skip`);
      return;
    }
    if (state.destroying) {
      this.logger.log(
        `[WA_DESTROY_STAGE] ${numberId} — already destroying, skip`,
      );
      return;
    }
    state.destroying = true;
    state.client = null;
    state.listenersAttached = false;
    state.bridgeReady = false;
    state.lastHeartbeat = null;
    state.phoneLinkCode = null;
    state.qrDataUrl = null;
    try {
      client.removeAllListeners();
    } catch {}
    try {
      await client.destroy();
    } catch {}
    this.logger.log(`[WA_DESTROY_STAGE] ${numberId} — done`);
    state.destroying = false;
  }

  private _getOrCreateState(numberId: string): NumberClientState {
    if (!this.clients.has(numberId)) {
      const state = makeState();
      this.clients.set(numberId, state);
      this._startWatchdog(numberId, state);
    }
    return this.clients.get(numberId);
  }

  // Returns true when the transition current → next is a valid forward move.
  // Rules (in priority order):
  //   1. Same state → false (no-op).
  //   2. → disconnecting: always allowed — teardown can be triggered from any state.
  //   3. → idle: always allowed — only teardown paths ever call _transitionState(idle).
  //   4. disconnecting → anything except idle: blocked (teardown overlay exits only to idle).
  //   5. failed → anything except idle: blocked (failed is terminal; reset/invalidate → idle).
  //   6. awaiting_manual_reconnect → anything: allowed — user manually broke the deadlock.
  //   7. Monotonic rank check: next rank must be strictly greater than current rank.
  private _canTransition(current: WaState, next: WaState): boolean {
    if (current === next) return false;
    if (next === 'disconnecting') return true;
    if (next === 'idle') return true;
    if (current === 'disconnecting') return false;
    if (current === 'failed') return false;
    if (current === 'awaiting_manual_reconnect') return true;
    const currentRank = WA_STATE_ORDER[current] ?? -1;
    const nextRank = WA_STATE_ORDER[next] ?? -1;
    return nextRank > currentRank;
  }

  private _transitionState(
    numberId: string,
    state: NumberClientState,
    next: WaState,
    reason = 'unspecified',
  ): void {
    const prev = state.waState;
    if (prev === next) return;

    if (!this._canTransition(prev, next)) {
      this.logger.warn(
        `[WA_STATE_REGRESSION_BLOCKED] ${JSON.stringify({ id: numberId, prev, attempted: next, reason, ts: new Date().toISOString() })}`,
      );
      return;
    }

    // Session-restore note: some wwebjs versions skip 'authenticated' for saved sessions and emit
    // 'ready' directly from 'initializing'. Log the unusual path — transition is valid (forward move).
    if (next === 'ready' && prev === 'initializing') {
      this.logger.warn(
        `[WA_READY_FROM_INITIALIZING] ${numberId} — ready fired without prior authenticated event ` +
          `(session-restore shortcut) reason=${reason} ts=${new Date().toISOString()}`,
      );
    }

    state.waState = next;
    this.logger.log(
      `[WA_STATE_TRANSITION] ${JSON.stringify({ id: numberId, prev, next, reason, timestamp: new Date().toISOString() })}`,
    );
    state.qrSubject.next(
      JSON.stringify({
        type: 'state_change',
        state: next,
        prev,
        reason,
        timestamp: new Date().toISOString(),
      }),
    );
  }

  private _clearTimers(state: NumberClientState, stopWatchdog = false): void {
    if (state.authTimeoutId) {
      clearTimeout(state.authTimeoutId);
      state.authTimeoutId = null;
    }
    if (state.readyWatchdogTimeoutId) {
      clearTimeout(state.readyWatchdogTimeoutId);
      state.readyWatchdogTimeoutId = null;
    }
    if (state.postInitGuardId) {
      clearTimeout(state.postInitGuardId);
      state.postInitGuardId = null;
    }
    if (state.reconnectTimerId) {
      clearTimeout(state.reconnectTimerId);
      state.reconnectTimerId = null;
    }
    if (stopWatchdog && state.watchdogTimer) {
      clearInterval(state.watchdogTimer);
      state.watchdogTimer = null;
    }
  }

  private async _safeEval<T>(
    numberId: string,
    state: NumberClientState,
    fn: () => Promise<T>,
    retriesLeft = 1,
  ): Promise<T> {
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
    return path.join(
      process.cwd(),
      WA_AUTH_DATA_PATH,
      `session-marketing-${numberId}`,
    );
  }

  /**
   * Returns true when the session folder has leveldb data but NO blob directory.
   * This is the exact fingerprint of a QR auth interrupted mid-flight (nodemon restart,
   * process crash after Chrome started writing but before auth completed).
   * Used only for diagnostics and the partialSession flag — never for routing decisions.
   */
  private _isPartialSession(numberId: string): boolean {
    const sessionDir = this._getSessionDir(numberId);
    if (!fs.existsSync(sessionDir)) return false;
    const waBase = path.join(
      sessionDir,
      'Default',
      'IndexedDB',
      'https_web.whatsapp.com_0.indexeddb',
    );
    if (fs.existsSync(`${waBase}.blob`)) return false;
    const leveldbDir = `${waBase}.leveldb`;
    if (!fs.existsSync(leveldbDir)) return false;
    try {
      return fs.readdirSync(leveldbDir).some((f) => f.endsWith('.ldb'));
    } catch {
      return false;
    }
  }

  /**
   * Returns true only when the LocalAuth directory contains evidence that WhatsApp Web
   * actually authenticated in this Chrome profile. Folder existence alone is NOT sufficient:
   * Chromium creates the full profile directory on its very first launch, even during a
   * QR-scan flow that the user never completed. That leaves a bare Chrome profile on disk
   * which is mistaken for a restorable session.
   *
   * Two authoritative signals (either is sufficient):
   *   1. blob dir — created by WA when it stores encrypted credential blobs (WANoiseInfo,
   *      media keys). Written only after successful authentication; never present for an
   *      unauthenticated Chrome profile.
   *   2. .ldb files — leveldb compacts write-ahead .log files into .ldb sstable files once
   *      real data is committed. An unauthenticated profile's WA leveldb contains only the
   *      initial .log file (0 .ldb). Multiple .ldb files indicate actual WA session data.
   */
  private _hasRestorableSession(numberId: string): boolean {
    const sessionDir = this._getSessionDir(numberId);
    if (!fs.existsSync(sessionDir)) {
      this.logger.warn(
        `[WA_SESSION_DIAG] numberId=${numberId} blobExists=false ldbExists=false ` +
          `leveldbDir=n/a waBase=n/a`,
      );
      return false;
    }

    const waBase = path.join(
      sessionDir,
      'Default',
      'IndexedDB',
      'https_web.whatsapp.com_0.indexeddb',
    );

    // Signal 1: blob directory — authoritative WA auth credential storage
    const blobExists = fs.existsSync(`${waBase}.blob`);

    // Signal 2: compacted leveldb .ldb files — real WA session data was written
    const leveldbDir = `${waBase}.leveldb`;
    let ldbExists = false;
    if (fs.existsSync(leveldbDir)) {
      try {
        ldbExists = fs.readdirSync(leveldbDir).some((f) => f.endsWith('.ldb'));
      } catch {
        ldbExists = false;
      }
    }

    // Both signals required — either alone indicates a partial/corrupted profile.
    // blob-only: leveldb was wiped; ldb-only: blob dir never written (session incomplete).
    if (!blobExists || !ldbExists) {
      this.logger.warn(
        `[WA_SESSION_INVALID] numberId=${numberId} reason=missing_blob_storage ` +
          `blobExists=${blobExists} ldbExists=${ldbExists} — treating as non-restorable`,
      );
      this.logger.warn(
        `[WA_SESSION_DIAG] numberId=${numberId} blobExists=${blobExists} ldbExists=${ldbExists} ` +
          `leveldbDir=${leveldbDir} waBase=${waBase}`,
      );
      return false;
    }

    this.logger.warn(
      `[WA_SESSION_DIAG] numberId=${numberId} blobExists=${blobExists} ldbExists=${ldbExists} ` +
        `leveldbDir=${leveldbDir} waBase=${waBase}`,
    );
    return true;
  }

  private async _cleanupInvalidInboxRows(): Promise<void> {
    this.logger.log(
      '[MKT_INBOX_CLEANUP_START] entity=WhatsappReply table=whatsapp_replies — ' +
        'removing invalid phone + empty message rows',
    );
    try {
      // Delete rows with invalid customer_phone:
      //   - contains '@' (raw JID identifiers)
      //   - digit count outside 10–15
      //   - null / empty
      //   - "+1..." longer than 12 chars (WA @lid numeric IDs stored as US numbers)
      //   - "+20..." longer than 13 chars (WA @lid numeric IDs stored as Egypt numbers)
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
            OR (customer_phone LIKE '+1%'  AND LENGTH(customer_phone) > 12)
            OR (customer_phone LIKE '+20%' AND LENGTH(customer_phone) > 13)
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
      this.logger.error(
        `[MKT_INBOX_CLEANUP_ERROR] cleanup failed (non-fatal): ${err?.message}`,
      );
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
      try {
        fs.unlinkSync(path.join(sessionDir, file));
      } catch {
        /* absent — ok */
      }
    }
  }

  private async _clearAuthFiles(numberId: string): Promise<void> {
    const sessionDir = this._getSessionDir(numberId);
    if (!fs.existsSync(sessionDir)) {
      this.logger.log(
        `[MKT_RESET] LocalAuth dir not found — nothing to delete for ${numberId}`,
      );
      return;
    }
    await fs.promises.rm(sessionDir, { recursive: true, force: true });
    const exists = fs.existsSync(sessionDir);
    if (exists) {
      this.logger.error(
        `[MKT_RESET] LocalAuth delete failed — session still exists for ${numberId}`,
      );
      throw new Error(
        `LocalAuth delete failed — session still exists at ${sessionDir}`,
      );
    }
    this.logger.log(`[MKT_RESET] LocalAuth deleted successfully — ${numberId}`);
  }

  private async _updateNumberWaState(
    numberId: string,
    waState: string | null,
    reason?: string,
  ): Promise<void> {
    this.logger.log(
      `[WA_STATE_WRITE] ${JSON.stringify({ id: numberId, next: waState, reason: reason ?? 'unspecified', ts: new Date().toISOString() })}`,
    );
    try {
      await this.numberRepo.update(numberId, { wa_state: waState });
    } catch (e: any) {
      this.logger.warn(
        `[DB_TRANSIENT] wa_state update failed for ${numberId}: ${e?.message}`,
      );
    }
  }

  // ── Terminal session invalidation ────────────────────────────────────────────
  // Idempotent cleanup for permanently dead sessions (auth_failure, recovery_session_lost,
  // stale sweeper). Always finishes DB normalization even if browser/auth steps fail.

  async forceInvalidateSession(
    numberId: string,
    reason: string,
  ): Promise<void> {
    if (this._invalidatingIds.has(numberId)) {
      this.logger.log(
        `[WA_FORCE_INVALIDATE] ${numberId} — already invalidating, skipping`,
      );
      return;
    }
    this._invalidatingIds.add(numberId);
    this.logger.warn(
      `[WA_FORCE_INVALIDATE] ${JSON.stringify({ id: numberId, reason, ts: new Date().toISOString() })}`,
    );

    this._metrics.authInvalidations++;
    this._logMetrics();
    try {
      const state = this.clients.get(numberId);
      if (state) {
        if (!['idle', 'disconnecting'].includes(state.waState)) {
          state.reconnectCount++;
          state.lastDisconnectedAt = new Date();
          state.sessionStartedAt = null;
        }
        state.terminating = true;
        this._clearTimers(state);
        await this._destroyClient(numberId, state);
      }

      try {
        await this._clearAuthFiles(numberId);
      } catch (err: any) {
        this.logger.warn(
          `[WA_FORCE_INVALIDATE] auth delete failed (non-fatal) — ${numberId}: ${err?.message}`,
        );
      }

      // DB normalization — always runs even if prior steps partially failed
      await this._updateNumberWaState(numberId, 'idle', reason);

      if (state) {
        this._transitionState(numberId, state, 'idle', reason);
        state.qrDataUrl = null;
        state.qrGeneratedAt = null;
        state.firstQrGeneratedAt = null;
        state.terminating = false;
        state.destroying = false;
        state.starting = false;
        state.autoReconnectAttempts = 0;
        state.sessionAvailable = false;
        state.bridgeReady = false;
        state._lastStatusKey = null;
      }

      this.logger.log(
        `[WA_FORCE_INVALIDATE_DONE] ${JSON.stringify({ id: numberId, reason, ts: new Date().toISOString() })}`,
      );
    } catch (err: any) {
      this.logger.error(
        `[WA_FORCE_INVALIDATE_ERROR] ${JSON.stringify({ id: numberId, reason, error: err?.message, ts: new Date().toISOString() })}`,
      );
    } finally {
      this._invalidatingIds.delete(numberId);
    }
  }

  // Returns the number ID that currently holds the active session slot, or null.
  // ── Deep runtime diagnostics ────────────────────────────────────────────────
  // Read-only inspection of live in-memory state. Never trusts DB — always reads
  // directly from the in-process client map, Puppeteer objects, and disk.
  async getDebugSnapshot(numberId: string): Promise<Record<string, unknown>> {
    const state = this.clients.get(numberId);
    const client = state?.client ?? null;
    const browser = client?.pupBrowser ?? null;
    const page = client?.pupPage ?? null;

    const clientExists = client !== null;
    const browserExists = browser !== null;
    const browserConnected = browser?.isConnected?.() ?? false;
    const pageExists = page !== null;
    const pageClosed = page ? (page.isClosed?.() ?? true) : true;

    let currentUrl: string | null = null;
    let whatsappTitle: string | null = null;
    let navigatorOnline: unknown = null;
    let visibilityState: unknown = null;

    if (page && !pageClosed) {
      try {
        currentUrl = page.url();
      } catch {
        currentUrl = 'sync_error';
      }
      try {
        whatsappTitle = await page.title();
      } catch {
        whatsappTitle = 'async_error';
      }
      try {
        navigatorOnline = await page.evaluate(() => navigator.onLine);
      } catch {
        navigatorOnline = 'eval_error';
      }
      try {
        visibilityState = await page.evaluate(() => document.visibilityState);
      } catch {
        visibilityState = 'eval_error';
      }
    }

    const authFolderExists = fs.existsSync(this._getSessionDir(numberId));

    const listeners = clientExists
      ? {
          qr: client.listenerCount?.('qr') ?? null,
          ready: client.listenerCount?.('ready') ?? null,
          authenticated: client.listenerCount?.('authenticated') ?? null,
          disconnected: client.listenerCount?.('disconnected') ?? null,
          auth_failure: client.listenerCount?.('auth_failure') ?? null,
        }
      : null;

    const snapshot = {
      waState: state?.waState ?? 'not_in_map',
      clientExists,
      browserExists,
      browserConnected,
      pageExists,
      pageClosed,
      currentUrl,
      whatsappTitle,
      navigatorOnline,
      visibilityState,
      qrActive: state?.waState === 'awaiting_scan',
      lastReadyAt: state?.lastReadyAt?.toISOString() ?? null,
      lastHeartbeatAt: state?.lastHeartbeat?.toISOString() ?? null,
      authFolderExists,
      flags: {
        terminating: state?.terminating ?? null,
        destroying: state?.destroying ?? null,
        starting: state?.starting ?? null,
        destroyed: state?.destroyed ?? null,
      },
      listeners,
      ts: new Date().toISOString(),
    };

    this.logger.log(`[WA_DEBUG_SNAPSHOT] ${JSON.stringify(snapshot)}`);
    return snapshot;
  }

  private _getActiveNumberId(): string | null {
    const ACTIVE: WaState[] = [
      'initializing',
      'awaiting_scan',
      'authenticating',
      'ready',
    ];
    for (const [id, s] of this.clients) {
      if (ACTIVE.includes(s.waState)) return id;
    }
    return null;
  }

  private _logMetrics(): void {
    this.logger.log(
      `[STABILITY_METRIC] ${JSON.stringify({ ...this._metrics, ts: new Date().toISOString() })}`,
    );
  }

  private async _updateNumberConnected(numberId: string): Promise<void> {
    this.logger.log(
      `[WA_STATE_WRITE] ${JSON.stringify({ id: numberId, next: 'ready', reason: 'ready_event', ts: new Date().toISOString() })}`,
    );
    this.logger.log(`[WA_DB_SYNC] attempting READY persistence → ${numberId}`);
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const result = await this.numberRepo.update(numberId, {
          wa_state: 'ready',
          last_connected_at: new Date(),
        });
        const rowsAffected = (result as any)?.affected ?? 'unknown';
        this.logger.log(
          `[WA_DB_SYNC] READY persisted → ${numberId} rowsAffected=${rowsAffected}`,
        );

        // Hard verify: read back the stored value. If it's not 'ready', something is wrong.
        let verify: any;
        try {
          verify = await this.numberRepo.findOne({
            where: { id: numberId as any },
          });
        } catch (readErr: any) {
          this.logger.warn(
            `[WA_DB_SYNC] read-back failed (non-fatal) → ${numberId}: ${readErr?.message}`,
          );
          return; // write succeeded, read-back is diagnostic — proceed
        }
        this.logger.log(
          `[WA_DB_SYNC] verify → id=${numberId} wa_state=${JSON.stringify(verify?.wa_state)} last_connected_at=${verify?.last_connected_at?.toISOString?.() ?? null}`,
        );
        if (verify?.wa_state !== 'ready') {
          const msg = `[WA_DB_SYNC] HARD FAILURE — verify wa_state=${JSON.stringify(verify?.wa_state)} expected='ready' — ${numberId}`;
          this.logger.error(msg);
          throw new Error(msg);
        }
        return;
      } catch (e: any) {
        if (attempt < 2) {
          this.logger.warn(
            `[WA_DB_SYNC] READY write failed (attempt ${attempt}) → ${numberId}: ${e?.message} — retrying in 3s`,
          );
          await new Promise<void>((r) => setTimeout(r, 3_000));
        } else {
          this.logger.error(
            `[WA_DB_SYNC] READY persistence failed → ${numberId}: ${e?.message}`,
          );
          throw e;
        }
      }
    }
  }
}
