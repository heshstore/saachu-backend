import { NotificationType, NotificationPriority } from './notification.entity';

export interface NotificationRule {
  type:             NotificationType;
  priority:         NotificationPriority;
  sendWhatsApp:     boolean;
  cooldownMinutes:  number;
  expiresInHours?:  number;
}

export const NOTIFICATION_RULES: Record<string, NotificationRule> = {
  'job.delayed': {
    type:            NotificationType.ACTION,
    priority:        NotificationPriority.HIGH,
    sendWhatsApp:    true,
    cooldownMinutes: 60,
    expiresInHours:  24,
  },
  'job.assigned': {
    type:            NotificationType.ACTION,
    priority:        NotificationPriority.MEDIUM,
    sendWhatsApp:    false,
    cooldownMinutes: 30,
    expiresInHours:  48,
  },
  'job.completed': {
    type:            NotificationType.INFO,
    priority:        NotificationPriority.LOW,
    sendWhatsApp:    false,
    cooldownMinutes: 0,
    expiresInHours:  24,
  },
  'order.created': {
    type:            NotificationType.ACTION,
    priority:        NotificationPriority.MEDIUM,
    sendWhatsApp:    false,
    cooldownMinutes: 30,
    expiresInHours:  72,
  },
  'order.completed': {
    type:            NotificationType.INFO,
    priority:        NotificationPriority.MEDIUM,
    sendWhatsApp:    false,
    cooldownMinutes: 0,
    expiresInHours:  24,
  },
  'payment.received': {
    type:            NotificationType.INFO,
    priority:        NotificationPriority.MEDIUM,
    sendWhatsApp:    false,
    cooldownMinutes: 0,
    expiresInHours:  48,
  },
  'idle_user': {
    type:            NotificationType.REMINDER,
    priority:        NotificationPriority.MEDIUM,
    sendWhatsApp:    false,
    cooldownMinutes: 120,
    expiresInHours:  8,
  },
  'end_of_day': {
    type:            NotificationType.MOTIVATION,
    priority:        NotificationPriority.LOW,
    sendWhatsApp:    true,
    cooldownMinutes: 0,
    expiresInHours:  12,
  },
};
