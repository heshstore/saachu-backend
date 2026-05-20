export enum WhatsAppNumberStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
  BANNED = 'banned',
  WARMING = 'warming',
}

export enum CampaignStatus {
  DRAFT = 'draft',
  SCHEDULED = 'scheduled',
  RUNNING = 'running',
  PAUSED = 'paused',
  COMPLETED = 'completed',
  CANCELLED = 'cancelled',
}

export enum QueueStatus {
  PENDING = 'pending',
  PROCESSING = 'processing',
  SENT = 'sent',
  DELIVERED = 'delivered',
  READ = 'read',
  REPLIED = 'replied',
  FAILED = 'failed',
  SKIPPED = 'skipped',
}

export enum MessageType {
  TEXT = 'text',
  IMAGE = 'image',
  VIDEO = 'video',
  DOCUMENT = 'document',
  TEMPLATE = 'template',
}

export enum CTAType {
  NONE = 'none',
  URL = 'url',
  PHONE = 'phone',
  QUICK_REPLY = 'quick_reply',
}

export enum ReplyStatus {
  NONE = 'none',
  REPLIED = 'replied',
  LEAD_CREATED = 'lead_created',
  OPTED_OUT = 'opted_out',
}

export enum WarmupLevel {
  COLD = 1,
  WARM = 2,
  HOT = 3,
  SEASONED = 4,
}
