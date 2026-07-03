-- Phase 19: Push Notification Infrastructure
-- Additive only. No DROP, no renames, no data loss.
-- Run once against Neon. Safe to re-run (IF NOT EXISTS everywhere).

BEGIN;

-- 1. FCM device tokens — one row per (user, device).
--    Written once per login/session; read only when sending FCM push.
CREATE TABLE IF NOT EXISTS user_push_tokens (
  id            SERIAL       PRIMARY KEY,
  user_id       INTEGER      NOT NULL,
  token         TEXT         NOT NULL,
  platform      VARCHAR(20)  NOT NULL DEFAULT 'web',   -- 'web' | 'android' | 'ios'
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  last_seen_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, token)
);

CREATE INDEX IF NOT EXISTS idx_push_token_user
  ON user_push_tokens(user_id);

-- 2. Notification history — append-only audit log.
--    Written once per business event. Never polled.
--    Read only when user explicitly opens history view.
CREATE TABLE IF NOT EXISTS notification_history (
  id           BIGSERIAL    PRIMARY KEY,
  user_id      INTEGER      NOT NULL,
  title        VARCHAR(255) NOT NULL,
  message      TEXT         NOT NULL,
  type         VARCHAR(12)  NOT NULL DEFAULT 'INFO',
  category     VARCHAR(20),
  entity_type  VARCHAR(30),
  entity_id    INTEGER,
  action_url   VARCHAR(500),
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  read_at      TIMESTAMPTZ            -- NULL = unread; set on first open
);

CREATE INDEX IF NOT EXISTS idx_notif_hist_user
  ON notification_history(user_id, created_at DESC);

COMMIT;
