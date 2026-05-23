import { Injectable, Logger } from '@nestjs/common';

const WINDOW_START_HOUR = 10;   // 10:00 AM
const WINDOW_END_HOUR = 17;     // 17:30 (5:30 PM)
const WINDOW_END_MINUTE = 30;
const WINDOW_MINUTES = 450;     // 7.5 hours = 450 min

@Injectable()
export class TimingAiService {
  private readonly logger = new Logger(TimingAiService.name);
  async getOptimalSendTime(phone: string): Promise<Date> {
    if (
      process.env.MARKETING_TEST_BYPASS_SEND_WINDOW === 'true' &&
      process.env.WHATSAPP_ENGINE_TEST_ONLY === 'true'
    ) {
      this.logger.log(`[MKT_WINDOW_CHECK] getOptimalSendTime bypass → scheduling ${phone} for immediate send`);
      return new Date();
    }
    const now = new Date();
    const offsetMinutes = Math.floor(Math.random() * WINDOW_MINUTES);

    const candidate = new Date(now);
    candidate.setHours(WINDOW_START_HOUR, offsetMinutes % 60, 0, 0);
    // Adjust hours: WINDOW_START_HOUR + floor(offsetMinutes / 60)
    candidate.setHours(WINDOW_START_HOUR + Math.floor(offsetMinutes / 60), offsetMinutes % 60, 0, 0);

    if (candidate <= now) {
      // Schedule for tomorrow at 10am + same random offset
      candidate.setDate(candidate.getDate() + 1);
      candidate.setHours(WINDOW_START_HOUR + Math.floor(offsetMinutes / 60), offsetMinutes % 60, 0, 0);
    }

    return candidate;
  }

  isWithinSendWindow(): boolean {
    if (
      process.env.MARKETING_TEST_BYPASS_SEND_WINDOW === 'true' &&
      process.env.WHATSAPP_ENGINE_TEST_ONLY === 'true'
    ) {
      this.logger.log('[MKT_WINDOW_CHECK] bypass=true → returning true (TEST_ONLY+BYPASS mode)');
      return true;
    }
    const now = new Date();
    const hours = now.getHours();
    const minutes = now.getMinutes();
    const totalMinutes = hours * 60 + minutes;
    const startMinutes = WINDOW_START_HOUR * 60;
    const endMinutes = WINDOW_END_HOUR * 60 + WINDOW_END_MINUTE;
    const result = totalMinutes >= startMinutes && totalMinutes <= endMinutes;
    this.logger.log(`[MKT_WINDOW_CHECK] bypass=false time=${hours}:${String(minutes).padStart(2, '0')} window=10:00–17:30 result=${result}`);
    return result;
  }

  getNextWindowStart(): Date {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(WINDOW_START_HOUR, 0, 0, 0);
    return tomorrow;
  }

  randomizeDelay(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }
}
