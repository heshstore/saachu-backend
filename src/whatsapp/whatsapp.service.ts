import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import * as fs from 'fs';
import { ReplaySubject, Observable, interval, merge } from 'rxjs';
import { map } from 'rxjs/operators';
import { WhatsAppSession } from './entities/whatsapp-session.entity';
import { WhatsAppMessage } from './entities/whatsapp-message.entity';
import { appConfig } from '../config/config';
import { LeadSource } from '../crm/entities/lead.entity';

@Injectable()
export class WhatsAppService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WhatsAppService.name);
  private client: any = null;
  private _ready = false;
  // ReplaySubject(1): new SSE subscribers immediately receive the last QR/status event
  private qrSubject = new ReplaySubject<string>(1);
  private sessionName = appConfig.whatsappSessionName;
  private seenMsgIds = new Set<string>();

  constructor(
    @InjectRepository(WhatsAppSession)
    private sessionRepo: Repository<WhatsAppSession>,
    @InjectRepository(WhatsAppMessage)
    private messageRepo: Repository<WhatsAppMessage>,
    private eventEmitter: EventEmitter2,
  ) {}

  async onModuleInit() {
    this.logger.log('WhatsApp module init — starting Chromium in background');
    // Emit initializing so the SSE page shows status immediately
    this.qrSubject.next(JSON.stringify({ type: 'initializing' }));
    setImmediate(() => this.initClient().catch((e) => {
      this.logger.error('WhatsApp init failed', e?.stack ?? e?.message);
      this.qrSubject.next(JSON.stringify({ type: 'error', message: e?.message }));
    }));
  }

  async onModuleDestroy() {
    this._ready = false;
    if (this.client) {
      try { await this.client.destroy(); } catch { /* ignore */ }
      this.client = null;
    }
  }

  private async initClient() {
    let Client: any, LocalAuth: any;
    try {
      const wwebjs = await import('whatsapp-web.js');
      Client = wwebjs.Client;
      LocalAuth = wwebjs.LocalAuth;
    } catch (e) {
      console.warn('[WhatsApp] whatsapp-web.js not available:', e?.message);
      return;
    }

    const executablePath = this.findChrome();
    this.logger.log(`Launching Chromium${executablePath ? ` at ${executablePath}` : ' (bundled/auto)'}`);

    this.client = new Client({
      authStrategy: new LocalAuth({ clientId: this.sessionName }),
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
          '--single-process',          // required on Render — prevents forking
          '--disable-extensions',
          '--disable-background-networking',
          '--disable-default-apps',
          '--mute-audio',
        ],
      },
    });

    this.client.on('qr', async (qr: string) => {
      this.logger.log('QR code received — waiting for scan');
      let QRCode: any;
      try { QRCode = (await import('qrcode')).default; } catch { return; }
      const dataUrl = await QRCode.toDataURL(qr);
      this.qrSubject.next(JSON.stringify({ type: 'qr', dataUrl }));
      await this.updateSession({ status: 'CONNECTING', qr_code: dataUrl });
    });

    this.client.on('ready', async () => {
      this._ready = true;
      const info = this.client.info;
      const phone = info?.wid?.user ?? null;
      await this.updateSession({ status: 'CONNECTED', qr_code: null, phone_number: phone, connected_at: new Date() });
      this.qrSubject.next(JSON.stringify({ type: 'ready', phone }));
      this.logger.log(`Connected as ${phone}`);
    });

    this.client.on('disconnected', async (reason: string) => {
      this._ready = false;
      await this.updateSession({ status: 'DISCONNECTED' });
      this.logger.warn(`Disconnected: ${reason}`);
      this.qrSubject.next(JSON.stringify({ type: 'disconnected', reason }));
      setTimeout(() => this.reinitClient().catch((e) => this.logger.error('Reconnect failed', e?.message)), 10000);
    });

    this.client.on('auth_failure', async (msg: string) => {
      this._ready = false;
      await this.updateSession({ status: 'DISCONNECTED' });
      this.logger.error(`Auth failure: ${msg}`);
      this.qrSubject.next(JSON.stringify({ type: 'error', message: `Auth failure: ${msg}` }));
    });

    const onMsg = async (msg: any) => {
      if (msg.fromMe) return;
      const msgId = msg.id?._serialized ?? `${msg.from}-${msg.timestamp}`;
      if (this.seenMsgIds.has(msgId)) return;
      this.seenMsgIds.add(msgId);
      if (this.seenMsgIds.size > 500) {
        // Prevent unbounded growth — drop oldest entries
        const first = this.seenMsgIds.values().next().value;
        this.seenMsgIds.delete(first);
      }
      this.logger.log(`Incoming from=${msg.from} id=${msgId}`);
      await this.handleInbound(msg);
    };

    this.client.on('message', onMsg);
    this.client.on('message_create', onMsg);

    await this.client.initialize();
  }

  // SSE observable — always JSON, replays last event to new subscribers
  getQrObservable(): Observable<any> {
    return merge(
      this.qrSubject.asObservable().pipe(
        map((json) => ({ data: JSON.parse(json) })),
      ),
      interval(30000).pipe(map(() => ({ data: { type: 'ping' } }))),
    );
  }

  async sendMessage(chatId: string, body: string, sentBy?: number): Promise<void> {
    if (!this.client || !this.isConnected()) {
      throw new Error('WhatsApp not connected. Please scan the QR code first.');
    }
    try {
      await this.client.sendMessage(chatId, body);
    } catch (err: any) {
      const msg = err?.message ?? '';
      if (msg.includes('detached Frame') || msg.includes('Session closed') || msg.includes('Target closed')) {
        this._ready = false;
        setImmediate(() => this.reinitClient().catch((e) => console.warn('[WhatsApp] Reconnect failed:', e?.message)));
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
  }

  async sendToPhone(phone: string, body: string, sentBy?: number): Promise<void> {
    const chatId = `${phone}@c.us`;
    await this.sendMessage(chatId, body, sentBy);
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
    return {
      status: row?.status ?? 'DISCONNECTED',
      phone: row?.phone_number ?? null,
    };
  }

  async getChatMessages(chatId: string, leadId?: number): Promise<WhatsAppMessage[]> {
    const normalized = this.normalizeChatId(chatId);
    const q = this.messageRepo.createQueryBuilder('m')
      .where('m.chat_id = :chatId', { chatId: normalized })
      .orWhere('m.chat_id = :raw', { raw: chatId }); // also match un-normalized legacy rows
    if (leadId) q.orWhere('m.lead_id = :leadId', { leadId });
    return q.orderBy('m.timestamp', 'ASC').getMany();
  }

  isConnected(): boolean {
    return this._ready && this.client?.pupPage != null;
  }

  private findChrome(): string | undefined {
    const CANDIDATES = [
      process.env.PUPPETEER_EXECUTABLE_PATH,
      // Render / Ubuntu common paths
      '/usr/bin/google-chrome-stable',
      '/usr/bin/google-chrome',
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium',
      '/snap/bin/chromium',
      // macOS (local dev)
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ];
    for (const p of CANDIDATES) {
      if (p && fs.existsSync(p)) {
        return p;
      }
    }
    return undefined; // let puppeteer use its own bundled Chromium
  }

  private async reinitClient(): Promise<void> {
    this.logger.log('Reinitializing client...');
    this.qrSubject.next(JSON.stringify({ type: 'initializing' }));
    if (this.client) {
      try { await this.client.destroy(); } catch { /* ignore */ }
      this.client = null;
    }
    await this.initClient();
  }

  // Normalize multi-device chatIds: "919999999999:1@c.us" → "919999999999@c.us"
  private normalizeChatId(chatId: string): string {
    return chatId.replace(/:\d+(?=@)/, '');
  }

  private detectSource(body: string): LeadSource {
    const u = (body || '').toUpperCase();
    if (u.includes('META_LEAD') || u.includes('FB_LEAD')) return LeadSource.META_ADS;
    if (u.includes('GOOGLE_LEAD') || u.includes('GADS')) return LeadSource.GOOGLE_ADS;
    if (u.includes('INDIAMART')) return LeadSource.INDIAMART;
    return LeadSource.WHATSAPP;
  }

  private async handleInbound(msg: any): Promise<void> {
    // Skip group chats, broadcasts, and newsletters — keep only individual chats
    const from: string = msg.from ?? '';
    if (from.endsWith('@g.us') || from === 'status@broadcast' || from.endsWith('@newsletter')) return;

    const chatId: string = this.normalizeChatId(from);
    const body: string = msg.body ?? '';
    const phone = chatId.split('@')[0].replace(/\D/g, '').slice(-10);
    this.logger.log(`Inbound chatId=${chatId} phone=${phone} body="${body.slice(0, 50)}"`);


    // Save message
    const savedMsg = await this.messageRepo.save(
      this.messageRepo.create({
        chat_id: chatId,
        direction: 'INBOUND',
        body,
        timestamp: new Date(msg.timestamp * 1000),
        is_read: false,
      }),
    );

    // Check if this chat_id already linked to a lead
    const existing = await this.messageRepo.manager.query(
      `SELECT id, assigned_to FROM leads WHERE whatsapp_chat_id = $1 AND is_active = true LIMIT 1`,
      [chatId],
    );
    if (existing.length > 0) {
      // Link message to existing lead
      savedMsg.lead_id = existing[0].id;
      await this.messageRepo.save(savedMsg);
      return;
    }

    // New contact — create lead via event emitter
    const contact = await msg.getContact().catch(() => null);
    const name = contact?.pushname || contact?.name || phone;
    const source = this.detectSource(body);

    this.eventEmitter.emit('lead.incoming', {
      phone,
      name,
      source,
      whatsapp_chat_id: chatId,
      raw_payload: { chatId, body, timestamp: msg.timestamp },
    });
  }

  private async updateSession(data: Partial<WhatsAppSession>): Promise<void> {
    let row = await this.sessionRepo.findOne({ where: { session_name: this.sessionName } });
    if (!row) {
      row = this.sessionRepo.create({ session_name: this.sessionName });
    }
    Object.assign(row, data, { last_active_at: new Date() });
    await this.sessionRepo.save(row).catch(() => { /* ignore concurrent update errors */ });
  }
}
