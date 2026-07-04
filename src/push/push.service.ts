import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { OnEvent } from '@nestjs/event-emitter';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getMessaging, Messaging } from 'firebase-admin/messaging';
import { PushToken } from './push-token.entity';
import { Notification } from '../notifications/notification.entity';

@Injectable()
export class PushService implements OnModuleInit {
  private readonly logger = new Logger(PushService.name);
  private messaging: Messaging | null = null;

  constructor(
    @InjectRepository(PushToken)
    private readonly tokenRepo: Repository<PushToken>,
  ) {}

  onModuleInit(): void {
    const raw = (process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '').trim();
    if (!raw) {
      this.logger.warn(
        'FIREBASE_SERVICE_ACCOUNT_JSON not set — FCM push disabled',
      );
      return;
    }
    try {
      const serviceAccount = JSON.parse(raw);
      const app = getApps().length
        ? getApps()[0]
        : initializeApp({ credential: cert(serviceAccount) });
      this.messaging = getMessaging(app);
      this.logger.log('Firebase Admin SDK initialized — FCM push enabled');
    } catch (e: any) {
      this.logger.warn(
        `Firebase init failed: ${e?.message} — FCM push disabled`,
      );
    }
  }

  // ── Token management ──────────────────────────────────────────────────────────

  async registerToken(
    userId: number,
    token: string,
    platform = 'web',
  ): Promise<void> {
    await this.tokenRepo.upsert(
      { user_id: userId, token, platform },
      { conflictPaths: ['user_id', 'token'] },
    );
  }

  async removeToken(userId: number, token: string): Promise<void> {
    await this.tokenRepo.delete({ user_id: userId, token });
  }

  // ── Event handler ─────────────────────────────────────────────────────────────

  @OnEvent('notification.created')
  async handleNotificationCreated(payload: {
    userId: number;
    notification: Notification;
  }): Promise<void> {
    if (!this.messaging) return;
    await this.sendToUser(payload.userId, payload.notification);
  }

  // ── FCM send ──────────────────────────────────────────────────────────────────

  async sendToUser(userId: number, notification: Notification): Promise<void> {
    if (!this.messaging) return;

    const rows = await this.tokenRepo.find({
      where: { user_id: userId },
      select: ['token'],
    });
    if (!rows.length) return;

    const tokens = rows.map((r) => r.token);
    const isUrgent =
      notification.priority === 'CRITICAL' || notification.priority === 'HIGH';

    try {
      const response = await this.messaging.sendEachForMulticast({
        tokens,
        notification: {
          title: notification.title,
          body: notification.message,
        },
        data: {
          // action_url passed as data so the SW and app can navigate on click
          link: notification.action_url ?? '/',
          category: notification.category ?? '',
          priority: notification.priority,
        },
        webpush: {
          notification: {
            icon: '/logo192.png',
            badge: '/favicon.ico',
            requireInteraction: isUrgent,
          },
          fcmOptions: notification.action_url
            ? {
                link: `https://${process.env.DOMAIN ?? 'localhost:3000'}${notification.action_url}`,
              }
            : undefined,
        },
        android: {
          priority: isUrgent ? 'high' : 'normal',
          notification: { channelId: notification.category ?? 'default' },
        },
        apns: {
          headers: { 'apns-priority': isUrgent ? '10' : '5' },
          payload: { aps: { sound: isUrgent ? 'default' : '' } },
        },
      });

      // Remove invalid tokens to avoid wasted quota
      const stale: string[] = [];
      response.responses.forEach((r: any, i: number) => {
        if (
          !r.success &&
          r.error?.code === 'messaging/registration-token-not-registered'
        ) {
          stale.push(tokens[i]);
        }
      });

      if (stale.length) {
        await this.tokenRepo
          .createQueryBuilder()
          .delete()
          .where('user_id = :userId AND token IN (:...stale)', {
            userId,
            stale,
          })
          .execute();
        this.logger.debug(
          `Removed ${stale.length} stale FCM token(s) for userId=${userId}`,
        );
      }
    } catch (e: any) {
      this.logger.warn(
        `FCM sendEachForMulticast failed for userId=${userId}: ${e?.message}`,
      );
    }
  }
}
