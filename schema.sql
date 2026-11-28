CREATE TABLE IF NOT EXISTS radiolink_users (
  hardware_id TEXT PRIMARY KEY,
  callsign TEXT NOT NULL,
  district TEXT NOT NULL DEFAULT 'US',
  role TEXT NOT NULL DEFAULT 'user',
  channel_id INTEGER NOT NULL DEFAULT 1,
  is_private BOOLEAN NOT NULL DEFAULT FALSE,
  report_count INTEGER NOT NULL DEFAULT 0,
  is_banned BOOLEAN NOT NULL DEFAULT FALSE,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS radiolink_reports (
  id BIGSERIAL PRIMARY KEY,
  reported_hardware_id TEXT NOT NULL,
  reported_callsign TEXT NOT NULL,
  reported_district TEXT NOT NULL DEFAULT 'US',
  reporter_hardware_id TEXT NOT NULL,
  reporter_callsign TEXT NOT NULL DEFAULT '',
  channel_id INTEGER NOT NULL DEFAULT 1,
  reason TEXT NOT NULL DEFAULT 'abuse_or_spam',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (reported_hardware_id, reporter_hardware_id)
);

CREATE TABLE IF NOT EXISTS radiolink_servers (
  id SERIAL PRIMARY KEY,
  url TEXT UNIQUE NOT NULL,
  platform_type TEXT NOT NULL DEFAULT 'render',
  label TEXT NOT NULL DEFAULT '',
  priority INTEGER NOT NULL DEFAULT 100,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS radiolink_roles (
  id SERIAL PRIMARY KEY,
  hardware_id TEXT UNIQUE,
  role TEXT NOT NULL DEFAULT 'moderator',
  label TEXT NOT NULL DEFAULT '',
  pin_hash TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT 'super_admin',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_radiolink_users_last_seen
  ON radiolink_users (last_seen_at DESC);

CREATE INDEX IF NOT EXISTS idx_radiolink_users_reports
  ON radiolink_users (report_count DESC, last_seen_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_radiolink_users_unique_callsign
  ON radiolink_users (LOWER(callsign))
  WHERE role = 'user';

CREATE INDEX IF NOT EXISTS idx_radiolink_servers_priority
  ON radiolink_servers (is_active DESC, priority ASC, id ASC);

CREATE TABLE IF NOT EXISTS radiolink_config (
  id INTEGER PRIMARY KEY DEFAULT 1,
  config_json JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
