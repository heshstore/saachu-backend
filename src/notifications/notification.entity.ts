export enum NotificationType {
  ACTION = 'ACTION',
  REMINDER = 'REMINDER',
  INFO = 'INFO',
  MOTIVATION = 'MOTIVATION',
}

export enum NotificationPriority {
  CRITICAL = 'CRITICAL',
  HIGH = 'HIGH',
  MEDIUM = 'MEDIUM',
  LOW = 'LOW',
}

export enum NotificationCategory {
  CRM = 'CRM',
  PRODUCTION = 'PRODUCTION',
  ACCOUNTS = 'ACCOUNTS',
  DISPATCH = 'DISPATCH',
  SYSTEM = 'SYSTEM',
}

export const PRIORITY_RANK: Record<NotificationPriority, number> = {
  [NotificationPriority.CRITICAL]: 4,
  [NotificationPriority.HIGH]: 3,
  [NotificationPriority.MEDIUM]: 2,
  [NotificationPriority.LOW]: 1,
};
