import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MarketingTemplate } from '../entities/marketing-template.entity';
import { WhatsappMessageLog } from '../entities/whatsapp-message-log.entity';

const GREETINGS = ['Hi', 'Hello', 'Good day', 'Hey there', 'Greetings'];
const CTAS = [
  'Reply with your requirement',
  'Let us know if you are interested',
  'Reply YES to know more',
  'Drop us a message if this interests you',
  'Feel free to reply for more details',
];

@Injectable()
export class MessageAiService {
  private readonly logger = new Logger(MessageAiService.name);

  constructor(
    @InjectRepository(MarketingTemplate)
    private readonly templateRepo: Repository<MarketingTemplate>,
    @InjectRepository(WhatsappMessageLog)
    private readonly logRepo: Repository<WhatsappMessageLog>,
  ) {}

  async generateVariant(
    templateId: string,
    context: Record<string, string>,
  ): Promise<string> {
    const template = await this.templateRepo.findOne({
      where: { id: templateId },
    });
    if (!template) return '';

    const greeting = GREETINGS[Math.floor(Math.random() * GREETINGS.length)];
    const cta = await this._pickFreshCta(context['phone']);

    const vars: Record<string, string> = {
      ...context,
      greeting,
      cta,
    };

    return template.message_body.replace(
      /\{\{(\w+)\}\}/g,
      (_, key: string) => vars[key] ?? `{{${key}}}`,
    );
  }

  // Pick a CTA not used in the last 3 messages to this phone
  private async _pickFreshCta(phone?: string): Promise<string> {
    if (!phone) return CTAS[Math.floor(Math.random() * CTAS.length)];

    const recentLogs = await this.logRepo
      .createQueryBuilder('l')
      .where('l.customer_phone = :phone', { phone })
      .orderBy('l.sent_at', 'DESC')
      .limit(3)
      .getMany();

    const usedCtas = new Set<string>();
    for (const log of recentLogs) {
      for (const cta of CTAS) {
        if (log.message_body?.includes(cta)) usedCtas.add(cta);
      }
    }

    const fresh = CTAS.filter((c) => !usedCtas.has(c));
    const pool = fresh.length > 0 ? fresh : CTAS;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  async selectBestTemplate(phone: string): Promise<string | null> {
    const allActive = await this.templateRepo.find({
      where: { is_active: true },
    });
    if (!allActive.length) return null;

    // Exclude templates whose body prefix matches a send to this phone in the last 3 days
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 3600 * 1000);
    const recentLogs = await this.logRepo
      .createQueryBuilder('l')
      .where('l.customer_phone = :phone', { phone })
      .andWhere('l.sent_at >= :cutoff', { cutoff: threeDaysAgo })
      .orderBy('l.sent_at', 'DESC')
      .getMany();

    const usedPrefixes = new Set(
      recentLogs.map((l) => (l.message_body ?? '').slice(0, 50)),
    );
    const unused = allActive.filter(
      (t) => !usedPrefixes.has(t.message_body.slice(0, 50)),
    );

    if (unused.length > 0) {
      return unused[Math.floor(Math.random() * unused.length)].id;
    }
    // All templates sent recently — rotate to the least-recently-used one
    return allActive[Math.floor(Math.random() * allActive.length)].id;
  }

  isSpammy(body: string): boolean {
    return false;
  }
}
