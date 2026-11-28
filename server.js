const express = require('express');
const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { Pool } = require('pg');
const url = require('url');

const PORT = Number(process.env.PORT || 10000);
const ADMIN_PIN = String(process.env.ADMIN_PIN || '7788').trim();
const DATABASE_URL = (process.env.DATABASE_URL || '').trim();
const PLATFORM_HINT = String(
  process.env.RAILWAY_ENVIRONMENT ? 'railway'
    : process.env.KOYEB_APP_NAME ? 'koyeb'
    : process.env.RENDER ? 'render'
    : 'vps'
);
const PIN_SALT = 'RL_GNGTEC_ROLE_V2#';

const TACTICAL_CALLSIGNS = [
  'Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel',
  'India', 'Kilo', 'Lima', 'Mike', 'Oscar', 'Papa', 'Romeo', 'Sierra',
  'Tango', 'Victor', 'Whiskey', 'Yankee', 'Zulu', 'Falcon', 'Eagle', 'Viper',
  'Ranger', 'Hawk', 'Cobra', 'Titan', 'Ghost', 'Spark', 'Apex', 'Nova'
];
const TACTICAL_CALLSIGN_REGEX = /^[A-Za-z]+-\d{3,5}$/;

function isValidTacticalCallsign(cs) {
  const trimmed = String(cs || '').trim();
  if (!trimmed) return false;
  const lower = trimmed.toLowerCase();
  if (lower === 'admin' || lower === 'moderator') return false;
  return TACTICAL_CALLSIGN_REGEX.test(trimmed);
}

function computeTacticalCallsign(hwId, attempt = 0) {
  let num = 0n;
  try {
    num = BigInt(String(hwId || '0').replace(/[^0-9]/g, '') || '0');
  } catch (_) {
    num = 0n;
  }
  if (num <= 0n && attempt === 0) return 'Alpha-101';
  const prefixCount = BigInt(TACTICAL_CALLSIGNS.length);
  const safeAttempt = BigInt(Math.max(0, Number(attempt) || 0));
  if (safeAttempt < 28800n) {
    const shifted = num + safeAttempt * 7919n;
    const wIdx = Number(shifted % prefixCount);
    const unit = 100 + Number((shifted / prefixCount) % 900n);
    return `${TACTICAL_CALLSIGNS[wIdx]}-${unit}`;
  }
  const extraOffset = safeAttempt - 28800n;
  const shifted = num + extraOffset * 7919n;
  const wIdx = Number(shifted % prefixCount);
  const unit = 1000 + Number((shifted / prefixCount) % 9000n);
  return `${TACTICAL_CALLSIGNS[wIdx]}-${unit}`;
}

function hashRolePin(pin) {
  const clean = String(pin || '').trim();
  if (!clean) return '';
  return crypto.createHash('sha256').update(`${PIN_SALT}${clean}`).digest('hex');
}

function normalizeUrl(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return '';
  if (!/^https?:\/\//i.test(trimmed) && !/^wss?:\/\//i.test(trimmed)) return '';
  return trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
}

function detectPlatform(rawUrl) {
  const lower = String(rawUrl || '').toLowerCase();
  if (lower.includes('onrender.com')) return 'render';
  if (lower.includes('railway.app')) return 'railway';
  if (lower.includes('koyeb.app')) return 'koyeb';
  return 'vps';
}

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Pin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  return next();
});

function buildPgPool(rawUrl) {
  if (!rawUrl) return null;
  let cleaned = rawUrl;
  try {
    const u = new URL(rawUrl);
    u.searchParams.delete('channel_binding');
    if (u.searchParams.get('sslmode') === 'require') {
      u.searchParams.delete('sslmode');
    }
    cleaned = u.toString();
  } catch (_) {}
  return new Pool({
    connectionString: cleaned,
    ssl: { rejectUnauthorized: false },
    max: 10,
    idleTimeoutMillis: 30000,
  });
}

const pool = buildPgPool(DATABASE_URL);

const memoryUsers = new Map();
const memoryRoles = new Map(); // id -> roleObj
let nextMemoryRoleId = 1;
const memoryServers = [
  {
    id: 1,
    url: 'https://radiolink-c5fe.onrender.com/',
    platform_type: 'render',
    label: 'Primary Relay',
    priority: 1,
    is_active: true
  }
];

let memoryConfig = {
  min_version_code: 1,
  latest_version_code: 2,
  latest_version_name: '2.1.0',
  force_update: false,
  block_offline_after_notice: true,
  apk_download_url: '',
  title_bn: 'নতুন আপডেট এসেছে! (Update Available)',
  message_bn: 'নতুন ফিচার এবং বাগ ফিক্স পেতে এখনই আপডেট করে নিন।',
  primary_relay_url: 'https://radiolink-c5fe.onrender.com/',
  backup_relay_urls: [],
  banned_hardware_ids: [],
  role_overrides: {},
  callsign_overrides: {},
  neon_db_connected: Boolean(pool),
  system_shutdown: false,
  shutdown_message_bn: 'জরুরি রক্ষণাবেক্ষণের জন্য রেডিওলিংক সার্ভিস সাময়িকভাবে বন্ধ রাখা হয়েছে।',
  radio_default_ad_url: '',
  radio_default_ad_text: 'আপনি শুনছেন রেডিওলিংক। বর্তমান অনুষ্ঠান শেষ হয়েছে, পরবর্তী শো শুরু না হওয়া পর্যন্ত সাথেই থাকুন!'
};

let memoryFmStations = [
  { id: 1, name: 'Bangladesh Betar (বাংলাদেশ বেতার)', frequency: '100.0 FM', city: 'Dhaka', category: 'News & National', stream_url: 'http://stream.radio.gov.bd:8000/betardhaka', is_active: true, sort_order: 1 },
  { id: 2, name: 'Radio Today (রেডিও টুডে)', frequency: '89.6 FM', city: 'Dhaka', category: 'Music & News', stream_url: 'https://stream.radiotodaybd.fm/radiotoday', is_active: true, sort_order: 2 },
  { id: 3, name: 'Radio Foorti (রেডিও ফূর্তি)', frequency: '88.0 FM', city: 'Dhaka', category: 'Hits & Youth', stream_url: 'https://stream.radiofoorti.fm/foorti', is_active: true, sort_order: 3 },
  { id: 4, name: 'Dhaka FM (ঢাকা এফএম)', frequency: '90.4 FM', city: 'Dhaka', category: 'Music & Talk', stream_url: 'https://stream.dhakafm904.com/dhakafm', is_active: true, sort_order: 4 },
  { id: 5, name: 'Shadhin FM (স্বাধীন এফএম)', frequency: '92.4 FM', city: 'Dhaka', category: 'Bangla Music', stream_url: 'https://stream.shadhin.fm/live', is_active: true, sort_order: 5 },
  { id: 6, name: 'Jago FM (জাগো এফএম)', frequency: '94.4 FM', city: 'Dhaka', category: 'Youth & Hits', stream_url: 'https://streaming.jagofm.com/jagofm', is_active: true, sort_order: 6 },
  { id: 7, name: 'Peoples Radio (পিপলস রেডিও)', frequency: '91.6 FM', city: 'Dhaka', category: 'Talk & Music', stream_url: 'https://stream.peoplesradio.fm/live', is_active: true, sort_order: 7 },
  { id: 8, name: 'Radio Bhumi (রেডিও ভূমি)', frequency: '92.8 FM', city: 'Dhaka', category: 'Folk & News', stream_url: 'https://stream.radiobhumi.fm/live', is_active: true, sort_order: 8 }
];
let memoryCustomChannels = [
  { id: 1, name: 'RadioLink Hit Studio', frequency_tag: 'CH-101.8 RL', category: 'Music & Show', description: 'রেডিওলিংক অফিসিয়াল মিউজিক ও লাইভ শো চ্যানেল', loop_queue: true, auto_ad_enabled: true, ad_announce_bn: 'আপনি শুনছেন রেডিওলিংক স্টুডিও। সাথেই থাকুন!', is_active: true, sort_order: 1 }
];
let memoryRadioPrograms = [];
const memoryRadioMedia = new Map();
let nextMemoryFmId = 9;
let nextMemoryChannelId = 2;
let nextMemoryProgramId = 1;
let nextMemoryMediaId = 1;

function getBdTimeHhMm() {
  try {
    const now = new Date(Date.now() + 6 * 3600 * 1000);
    const hh = String(now.getUTCHours()).padStart(2, '0');
    const mm = String(now.getUTCMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
  } catch (_) {
    return '12:00';
  }
}

async function initDatabase() {
  if (!pool) {
    console.log('[DB] No DATABASE_URL provided; running in memory-only mode.');
    return;
  }
  await pool.query(`
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
    ALTER TABLE radiolink_users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'user';

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

    CREATE INDEX IF NOT EXISTS idx_radiolink_servers_priority
      ON radiolink_servers (is_active DESC, priority ASC, id ASC);

    CREATE TABLE IF NOT EXISTS radiolink_config (
      id INTEGER PRIMARY KEY DEFAULT 1,
      config_json JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS radiolink_fm_stations (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      frequency TEXT NOT NULL DEFAULT 'FM',
      city TEXT NOT NULL DEFAULT 'Dhaka',
      category TEXT NOT NULL DEFAULT 'Music',
      stream_url TEXT NOT NULL,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      sort_order INTEGER NOT NULL DEFAULT 10,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS radiolink_custom_channels (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      frequency_tag TEXT NOT NULL DEFAULT 'RL-CH1',
      category TEXT NOT NULL DEFAULT 'Music & Show',
      description TEXT NOT NULL DEFAULT '',
      loop_queue BOOLEAN NOT NULL DEFAULT TRUE,
      auto_ad_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      ad_announce_bn TEXT NOT NULL DEFAULT 'আপনি শুনছেন রেডিওলিংক। সাথেই থাকুন!',
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      sort_order INTEGER NOT NULL DEFAULT 10,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS radiolink_radio_media (
      id SERIAL PRIMARY KEY,
      filename TEXT NOT NULL,
      mime_type TEXT NOT NULL DEFAULT 'audio/mpeg',
      size_bytes INTEGER NOT NULL DEFAULT 0,
      data_bytea BYTEA NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS radiolink_radio_programs (
      id SERIAL PRIMARY KEY,
      channel_id INTEGER NOT NULL REFERENCES radiolink_custom_channels(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      item_type TEXT NOT NULL DEFAULT 'music',
      category TEXT NOT NULL DEFAULT 'Music',
      media_id INTEGER REFERENCES radiolink_radio_media(id) ON DELETE SET NULL,
      media_url TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 1,
      schedule_mode TEXT NOT NULL DEFAULT 'serial',
      start_time_hhmm TEXT NOT NULL DEFAULT '',
      end_time_hhmm TEXT NOT NULL DEFAULT '',
      duration_sec INTEGER NOT NULL DEFAULT 0,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_radiolink_programs_order
      ON radiolink_radio_programs (channel_id ASC, sort_order ASC, id ASC);
  `);

  // Normalize existing staff callsigns and migrate non-tactical / duplicate user callsigns before enforcing unique index
  await pool.query(`UPDATE radiolink_users SET callsign = 'Admin' WHERE role = 'admin' AND callsign <> 'Admin'`);
  await pool.query(`UPDATE radiolink_users SET callsign = 'Moderator' WHERE role = 'moderator' AND callsign <> 'Moderator'`);

  const existingUsersRes = await pool.query(
    `SELECT hardware_id, callsign FROM radiolink_users WHERE role = 'user' ORDER BY first_seen_at ASC, hardware_id ASC`
  );
  const usedCallsignsLower = new Set();
  for (const row of existingUsersRes.rows) {
    const hw = String(row.hardware_id || '').trim();
    const cur = String(row.callsign || '').trim();
    if (isValidTacticalCallsign(cur) && !usedCallsignsLower.has(cur.toLowerCase())) {
      usedCallsignsLower.add(cur.toLowerCase());
      continue;
    }
    let attempt = 0;
    let candidate = computeTacticalCallsign(hw, attempt);
    while (usedCallsignsLower.has(candidate.toLowerCase())) {
      attempt++;
      candidate = computeTacticalCallsign(hw, attempt);
    }
    usedCallsignsLower.add(candidate.toLowerCase());
    await pool.query('UPDATE radiolink_users SET callsign = $2 WHERE hardware_id = $1', [hw, candidate]);
  }

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_radiolink_users_unique_callsign
      ON radiolink_users (LOWER(callsign))
      WHERE role = 'user';
  `);

  const res = await pool.query('SELECT config_json FROM radiolink_config WHERE id = 1');
  if (res.rows.length > 0 && res.rows[0].config_json) {
    memoryConfig = { ...memoryConfig, ...res.rows[0].config_json };
  } else {
    await pool.query(
      'INSERT INTO radiolink_config (id, config_json) VALUES (1, $1::jsonb) ON CONFLICT (id) DO NOTHING',
      [JSON.stringify(memoryConfig)]
    );
  }

  const srvCount = await pool.query('SELECT COUNT(*)::int AS cnt FROM radiolink_servers');
  if ((srvCount.rows[0]?.cnt || 0) === 0) {
    const seedUrls = [memoryConfig.primary_relay_url, ...(memoryConfig.backup_relay_urls || [])]
      .map(normalizeUrl)
      .filter(Boolean);
    const uniqueSeeds = Array.from(new Set(seedUrls));
    for (let i = 0; i < uniqueSeeds.length; i++) {
      await pool.query(
        `INSERT INTO radiolink_servers (url, platform_type, label, priority, is_active)
         VALUES ($1, $2, $3, $4, TRUE)
         ON CONFLICT (url) DO NOTHING`,
        [uniqueSeeds[i], detectPlatform(uniqueSeeds[i]), i === 0 ? 'Primary Relay' : `Backup ${i}`, i + 1]
      );
    }
  }

  const fmCount = await pool.query('SELECT COUNT(*)::int AS cnt FROM radiolink_fm_stations');
  if ((fmCount.rows[0]?.cnt || 0) === 0) {
    for (const st of memoryFmStations) {
      await pool.query(
        `INSERT INTO radiolink_fm_stations (name, frequency, city, category, stream_url, is_active, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [st.name, st.frequency, st.city, st.category, st.stream_url, st.is_active, st.sort_order]
      );
    }
  }

  const chCount = await pool.query('SELECT COUNT(*)::int AS cnt FROM radiolink_custom_channels');
  if ((chCount.rows[0]?.cnt || 0) === 0) {
    for (const ch of memoryCustomChannels) {
      await pool.query(
        `INSERT INTO radiolink_custom_channels (name, frequency_tag, category, description, loop_queue, auto_ad_enabled, ad_announce_bn, is_active, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [ch.name, ch.frequency_tag, ch.category, ch.description, ch.loop_queue, ch.auto_ad_enabled, ch.ad_announce_bn, ch.is_active, ch.sort_order]
      );
    }
  }
  console.log('[DB] Neon PostgreSQL tables verified (users, reports, servers, roles, config, radio).');
}

async function getRoleForHardwareId(hardwareId) {
  const hw = String(hardwareId || '').trim();
  if (!hw || hw === '0') return 'user';
  if (pool) {
    const res = await pool.query(
      'SELECT role FROM radiolink_roles WHERE hardware_id = $1 AND is_active = TRUE LIMIT 1',
      [hw]
    );
    if (res.rows.length > 0) {
      const r = String(res.rows[0].role || '').toLowerCase();
      if (r === 'admin' || r === 'moderator') return r;
    }
    return 'user';
  }
  for (const r of memoryRoles.values()) {
    if (r.is_active && r.hardware_id === hw) return r.role;
  }
  return 'user';
}

async function getActiveRoleOverridesMap() {
  const overrides = {};
  if (pool) {
    const res = await pool.query(
      'SELECT hardware_id, role FROM radiolink_roles WHERE is_active = TRUE AND hardware_id IS NOT NULL'
    );
    for (const row of res.rows) {
      const hw = String(row.hardware_id || '').trim();
      const role = String(row.role || '').toLowerCase();
      if (hw && (role === 'admin' || role === 'moderator')) {
        overrides[hw] = role;
      }
    }
  } else {
    for (const r of memoryRoles.values()) {
      if (r.is_active && r.hardware_id) {
        overrides[r.hardware_id] = r.role;
      }
    }
  }
  return overrides;
}

async function getActiveCallsignOverridesMap() {
  const overrides = {};
  if (pool) {
    const res = await pool.query(
      `SELECT hardware_id, callsign
       FROM radiolink_users
       WHERE role = 'user'
       ORDER BY last_seen_at DESC
       LIMIT 1000`
    );
    for (const row of res.rows) {
      const hw = String(row.hardware_id || '').trim();
      const cs = String(row.callsign || '').trim();
      if (hw && isValidTacticalCallsign(cs)) {
        overrides[hw] = cs;
      }
    }
  } else {
    for (const u of memoryUsers.values()) {
      if ((u.role || 'user') === 'user' && u.hardware_id && isValidTacticalCallsign(u.callsign)) {
        overrides[u.hardware_id] = u.callsign;
      }
    }
  }
  return overrides;
}

async function allocateUniqueTacticalCallsign(hwId) {
  const hw = String(hwId || '').trim();
  if (!hw || hw === '0') return 'Alpha-101';

  if (pool) {
    const existing = await pool.query(
      'SELECT callsign, role FROM radiolink_users WHERE hardware_id = $1 LIMIT 1',
      [hw]
    );
    if (existing.rows.length > 0 && existing.rows[0].role === 'user') {
      const prevCs = String(existing.rows[0].callsign || '').trim();
      if (isValidTacticalCallsign(prevCs)) {
        const conflict = await pool.query(
          `SELECT 1 FROM radiolink_users WHERE LOWER(callsign) = LOWER($1) AND role = 'user' AND hardware_id <> $2 LIMIT 1`,
          [prevCs, hw]
        );
        if (conflict.rows.length === 0) return prevCs;
      }
    }
    for (let attempt = 0; attempt < 500; attempt++) {
      const candidate = computeTacticalCallsign(hw, attempt);
      const conflict = await pool.query(
        `SELECT 1 FROM radiolink_users WHERE LOWER(callsign) = LOWER($1) AND role = 'user' AND hardware_id <> $2 LIMIT 1`,
        [candidate, hw]
      );
      if (conflict.rows.length === 0) return candidate;
    }
    return computeTacticalCallsign(hw, Date.now() % 100000);
  }

  const memExisting = memoryUsers.get(hw);
  if (memExisting && (memExisting.role || 'user') === 'user' && isValidTacticalCallsign(memExisting.callsign)) {
    return memExisting.callsign;
  }
  const takenLower = new Set();
  for (const [k, u] of memoryUsers.entries()) {
    if (k !== hw && (u.role || 'user') === 'user' && u.callsign) {
      takenLower.add(String(u.callsign).toLowerCase());
    }
  }
  for (let attempt = 0; attempt < 500; attempt++) {
    const candidate = computeTacticalCallsign(hw, attempt);
    if (!takenLower.has(candidate.toLowerCase())) return candidate;
  }
  return computeTacticalCallsign(hw, 0);
}

async function getActiveServerPoolUrls() {
  if (pool) {
    const res = await pool.query(
      'SELECT url FROM radiolink_servers WHERE is_active = TRUE ORDER BY priority ASC, id ASC'
    );
    return res.rows.map((r) => normalizeUrl(r.url)).filter(Boolean);
  }
  return memoryServers
    .filter((s) => s.is_active)
    .sort((a, b) => a.priority - b.priority || a.id - b.id)
    .map((s) => normalizeUrl(s.url))
    .filter(Boolean);
}

async function upsertUserPresence({ hardwareId, district, channelId, isPrivate }) {
  const hw = String(hardwareId || '').trim();
  if (!hw || hw === '0') return { role: 'user', callsign: 'Alpha-101' };

  const verifiedRole = await getRoleForHardwareId(hw);
  const dist = String(district || 'US').trim() || 'US';
  const ch = Number.isFinite(Number(channelId)) ? Number(channelId) : 1;
  const priv = Boolean(isPrivate);

  if (verifiedRole === 'admin' || verifiedRole === 'moderator') {
    const staffCallsign = verifiedRole === 'admin' ? 'Admin' : 'Moderator';
    if (pool) {
      await pool.query(
        `INSERT INTO radiolink_users (hardware_id, callsign, district, role, channel_id, is_private, first_seen_at, last_seen_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
         ON CONFLICT (hardware_id) DO UPDATE SET
           callsign = EXCLUDED.callsign,
           district = EXCLUDED.district,
           role = EXCLUDED.role,
           channel_id = EXCLUDED.channel_id,
           is_private = EXCLUDED.is_private,
           last_seen_at = NOW()`,
        [hw, staffCallsign, dist, verifiedRole, ch, priv]
      );
    } else {
      const prev = memoryUsers.get(hw);
      memoryUsers.set(hw, {
        hardware_id: hw,
        callsign: staffCallsign,
        district: dist,
        role: verifiedRole,
        channel_id: ch,
        is_private: priv,
        report_count: prev ? prev.report_count : 0,
        is_banned: prev ? prev.is_banned : false,
        first_seen_ms: prev ? prev.first_seen_ms : Date.now(),
        last_seen_ms: Date.now()
      });
    }
    return { role: verifiedRole, callsign: staffCallsign };
  }

  // Regular user: guarantee strictly unique tactical callsign in Neon DB / memory
  if (pool) {
    let resolvedCallsign = await allocateUniqueTacticalCallsign(hw);
    for (let retry = 0; retry < 40; retry++) {
      try {
        await pool.query(
          `INSERT INTO radiolink_users (hardware_id, callsign, district, role, channel_id, is_private, first_seen_at, last_seen_at)
           VALUES ($1, $2, $3, 'user', $4, $5, NOW(), NOW())
           ON CONFLICT (hardware_id) DO UPDATE SET
             callsign = CASE
               WHEN radiolink_users.role = 'user' AND radiolink_users.callsign ~ '^[A-Za-z]+-[0-9]{3,5}$'
                 THEN radiolink_users.callsign
               ELSE EXCLUDED.callsign
             END,
             district = EXCLUDED.district,
             role = 'user',
             channel_id = EXCLUDED.channel_id,
             is_private = EXCLUDED.is_private,
             last_seen_at = NOW()`,
          [hw, resolvedCallsign, dist, ch, priv]
        );
        const checkRow = await pool.query('SELECT callsign FROM radiolink_users WHERE hardware_id = $1 LIMIT 1', [hw]);
        const finalCs = checkRow.rows[0]?.callsign || resolvedCallsign;
        return { role: 'user', callsign: finalCs };
      } catch (err) {
        if (err && err.code === '23505') {
          resolvedCallsign = computeTacticalCallsign(hw, retry + 1 + Math.floor(Math.random() * 50));
          continue;
        }
        throw err;
      }
    }
    return { role: 'user', callsign: resolvedCallsign };
  }

  const memCs = await allocateUniqueTacticalCallsign(hw);
  const prev = memoryUsers.get(hw);
  memoryUsers.set(hw, {
    hardware_id: hw,
    callsign: memCs,
    district: dist,
    role: 'user',
    channel_id: ch,
    is_private: priv,
    report_count: prev ? prev.report_count : 0,
    is_banned: prev ? prev.is_banned : false,
    first_seen_ms: prev ? prev.first_seen_ms : Date.now(),
    last_seen_ms: Date.now()
  });
  return { role: 'user', callsign: memCs };
}

async function recordUserReport({
  reportedHardwareId,
  reportedCallsign,
  reportedDistrict,
  reporterHardwareId,
  reporterCallsign,
  channelId,
  reason
}) {
  const targetHw = String(reportedHardwareId || '').trim();
  const reporterHw = String(reporterHardwareId || '').trim();
  if (!targetHw || targetHw === '0' || !reporterHw || targetHw === reporterHw) return null;

  const targetDist = String(reportedDistrict || 'US').trim() || 'US';
  const repCs = String(reporterCallsign || '').trim();
  const ch = Number.isFinite(Number(channelId)) ? Number(channelId) : 1;
  const cleanReason = String(reason || 'abuse_or_spam').trim().slice(0, 120);
  const targetCs = await allocateUniqueTacticalCallsign(targetHw);

  if (pool) {
    try {
      await pool.query(
        `INSERT INTO radiolink_users (hardware_id, callsign, district, role, channel_id, first_seen_at, last_seen_at)
         VALUES ($1, $2, $3, 'user', $4, NOW(), NOW())
         ON CONFLICT (hardware_id) DO NOTHING`,
        [targetHw, targetCs, targetDist, ch]
      );
    } catch (err) {
      if (!err || err.code !== '23505') throw err;
    }
    await pool.query(
      `INSERT INTO radiolink_reports (
         reported_hardware_id, reported_callsign, reported_district,
         reporter_hardware_id, reporter_callsign, channel_id, reason
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (reported_hardware_id, reporter_hardware_id) DO UPDATE SET
         created_at = NOW(),
         reason = EXCLUDED.reason`,
      [targetHw, isValidTacticalCallsign(reportedCallsign) ? String(reportedCallsign).trim() : targetCs, targetDist, reporterHw, repCs, ch, cleanReason]
    );
    const countRes = await pool.query(
      'SELECT COUNT(*)::int AS cnt FROM radiolink_reports WHERE reported_hardware_id = $1',
      [targetHw]
    );
    const cnt = countRes.rows[0]?.cnt || 1;
    await pool.query(
      'UPDATE radiolink_users SET report_count = $2 WHERE hardware_id = $1',
      [targetHw, cnt]
    );
    return cnt;
  } else {
    const prev = memoryUsers.get(targetHw) || {
      hardware_id: targetHw,
      callsign: targetCs,
      district: targetDist,
      role: 'user',
      channel_id: ch,
      is_private: false,
      report_count: 0,
      is_banned: false,
      first_seen_ms: Date.now(),
      last_seen_ms: Date.now(),
      reporters: new Set()
    };
    prev.reporters = prev.reporters || new Set();
    prev.reporters.add(reporterHw);
    prev.report_count = prev.reporters.size;
    memoryUsers.set(targetHw, prev);
    return prev.report_count;
  }
}

async function getMergedAppConfig() {
  let cfg = { ...memoryConfig };
  if (pool) {
    const cfgRes = await pool.query('SELECT config_json FROM radiolink_config WHERE id = 1');
    if (cfgRes.rows.length > 0 && cfgRes.rows[0].config_json) {
      cfg = { ...cfg, ...cfgRes.rows[0].config_json };
    }
    const banRes = await pool.query('SELECT hardware_id FROM radiolink_users WHERE is_banned = TRUE');
    const dbBanned = banRes.rows.map((r) => String(r.hardware_id));
    const existing = Array.isArray(cfg.banned_hardware_ids) ? cfg.banned_hardware_ids.map(String) : [];
    cfg.banned_hardware_ids = Array.from(new Set([...existing, ...dbBanned]));
  }
  const servers = await getActiveServerPoolUrls();
  if (servers.length > 0) {
    cfg.primary_relay_url = servers[0];
    cfg.backup_relay_urls = servers.slice(1);
  }
  cfg.role_overrides = await getActiveRoleOverridesMap();
  cfg.callsign_overrides = await getActiveCallsignOverridesMap();
  cfg.neon_db_connected = Boolean(pool);
  return cfg;
}

async function syncServersListToDb(urls) {
  const cleanUrls = Array.from(new Set((urls || []).map(normalizeUrl).filter(Boolean)));
  if (cleanUrls.length === 0) return;

  if (pool) {
    await pool.query('UPDATE radiolink_servers SET is_active = FALSE');
    for (let i = 0; i < cleanUrls.length; i++) {
      const u = cleanUrls[i];
      await pool.query(
        `INSERT INTO radiolink_servers (url, platform_type, label, priority, is_active, updated_at)
         VALUES ($1, $2, $3, $4, TRUE, NOW())
         ON CONFLICT (url) DO UPDATE SET
           priority = EXCLUDED.priority,
           is_active = TRUE,
           updated_at = NOW()`,
        [u, detectPlatform(u), i === 0 ? 'Primary Relay' : `Backup ${i}`, i + 1]
      );
    }
  } else {
    memoryServers.length = 0;
    cleanUrls.forEach((u, i) => {
      memoryServers.push({
        id: i + 1,
        url: u,
        platform_type: detectPlatform(u),
        label: i === 0 ? 'Primary Relay' : `Backup ${i}`,
        priority: i + 1,
        is_active: true
      });
    });
  }
}

async function saveConfigAndBroadcast(newConfig) {
  const merged = { ...memoryConfig, ...newConfig };
  const bannedList = Array.isArray(merged.banned_hardware_ids)
    ? merged.banned_hardware_ids.map((x) => String(x).trim()).filter(Boolean)
    : [];
  merged.banned_hardware_ids = Array.from(new Set(bannedList));

  // If caller provided relay URLs in policy push, keep radiolink_servers synchronized
  if (typeof newConfig.primary_relay_url === 'string' && newConfig.primary_relay_url.trim()) {
    const poolList = [
      newConfig.primary_relay_url,
      ...(Array.isArray(newConfig.backup_relay_urls) ? newConfig.backup_relay_urls : [])
    ];
    await syncServersListToDb(poolList);
  }

  merged.role_overrides = await getActiveRoleOverridesMap();
  merged.callsign_overrides = await getActiveCallsignOverridesMap();
  merged.neon_db_connected = Boolean(pool);
  memoryConfig = merged;

  if (pool) {
    await pool.query(
      `INSERT INTO radiolink_config (id, config_json, updated_at)
       VALUES (1, $1::jsonb, NOW())
       ON CONFLICT (id) DO UPDATE SET config_json = EXCLUDED.config_json, updated_at = NOW()`,
      [JSON.stringify(memoryConfig)]
    );
    await pool.query(
      'UPDATE radiolink_users SET is_banned = (hardware_id = ANY($1::text[]))',
      [memoryConfig.banned_hardware_ids]
    );
  }
  const latestCfg = await getMergedAppConfig();
  broadcastTextToAllUsers({
    type: 'admin_update_broadcast',
    payload: latestCfg
  });
}

async function resolveAdminSession(pin) {
  const provided = String(pin || '').trim();
  if (!provided) return null;
  if (provided === ADMIN_PIN) {
    return {
      role: 'super_admin',
      label: 'Master Admin',
      hardware_id: null
    };
  }
  const hash = hashRolePin(provided);
  if (pool) {
    const res = await pool.query(
      `SELECT id, hardware_id, role, label
       FROM radiolink_roles
       WHERE pin_hash = $1 AND pin_hash <> '' AND is_active = TRUE
       LIMIT 1`,
      [hash]
    );
    if (res.rows.length > 0) {
      const row = res.rows[0];
      return {
        role: String(row.role || 'moderator').toLowerCase(),
        label: row.label || (row.role === 'admin' ? 'Admin' : 'Moderator'),
        hardware_id: row.hardware_id || null
      };
    }
  } else {
    for (const r of memoryRoles.values()) {
      if (r.is_active && r.pin_hash && r.pin_hash === hash) {
        return { role: r.role, label: r.label, hardware_id: r.hardware_id };
      }
    }
  }
  return null;
}

function permissionsForRole(role) {
  const isFullAdmin = role === 'super_admin' || role === 'admin';
  return {
    manage_servers: isFullAdmin,
    manage_roles: isFullAdmin,
    manage_updates: isFullAdmin,
    manage_lockdown: isFullAdmin,
    ban_users: isFullAdmin || role === 'moderator'
  };
}

async function requireAnyStaffAuth(req, res, next) {
  try {
    const provided = String(req.headers['x-admin-pin'] || req.query.pin || req.body?.pin || '').trim();
    const session = await resolveAdminSession(provided);
    if (!session) {
      return res.status(401).json({ ok: false, error: 'Unauthorized: Invalid PIN' });
    }
    req.adminSession = session;
    return next();
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}

async function requireAdminOnlyAuth(req, res, next) {
  await requireAnyStaffAuth(req, res, () => {
    const r = req.adminSession?.role;
    if (r !== 'super_admin' && r !== 'admin') {
      return res.status(403).json({ ok: false, error: 'Forbidden: Admin access required' });
    }
    return next();
  });
}

// Public Endpoints
app.get('/', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'RadioLink Universal Relay',
    platform: PLATFORM_HINT,
    neon_db: Boolean(pool),
    connected_clients: clients.size
  });
});

app.get('/health', async (_req, res) => {
  const t0 = Date.now();
  let dbOk = false;
  if (pool) {
    try {
      await pool.query('SELECT 1');
      dbOk = true;
    } catch (_) {
      dbOk = false;
    }
  }
  res.json({
    ok: true,
    service: 'RadioLink Universal Relay',
    platform: PLATFORM_HINT,
    neon_db: Boolean(pool),
    db_ok: dbOk,
    online_sockets: clients.size,
    latency_ms: Date.now() - t0
  });
});

app.get('/app-config.json', async (_req, res) => {
  try {
    const cfg = await getMergedAppConfig();
    res.setHeader('Cache-Control', 'no-store');
    res.json(cfg);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/presence', async (req, res) => {
  try {
    const info = await upsertUserPresence({
      hardwareId: req.body?.hardware_id,
      callsign: req.body?.callsign,
      district: req.body?.district,
      channelId: req.body?.channel,
      isPrivate: req.body?.is_private
    });
    res.json({
      ok: true,
      role: info.role,
      callsign: info.callsign,
      neon_db: Boolean(pool),
      db_ok: Boolean(pool)
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/report', async (req, res) => {
  try {
    const cnt = await recordUserReport({
      reportedHardwareId: req.body?.reported_hardware_id,
      reportedCallsign: req.body?.reported_callsign,
      reportedDistrict: req.body?.reported_district,
      reporterHardwareId: req.body?.reporter_hardware_id,
      reporterCallsign: req.body?.reporter_callsign,
      channelId: req.body?.channel,
      reason: req.body?.reason
    });
    res.json({ ok: true, report_count: cnt });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ==================== RADIO & BD FM STUDIO ENDPOINTS ====================
async function fetchRadioDirectoryData(includeInactive = false) {
  let fmStations = [];
  let channels = [];
  let programs = [];
  if (pool) {
    const fmRes = await pool.query(
      includeInactive
        ? 'SELECT id, name, frequency, city, category, stream_url, is_active, sort_order FROM radiolink_fm_stations ORDER BY sort_order ASC, id ASC'
        : 'SELECT id, name, frequency, city, category, stream_url, is_active, sort_order FROM radiolink_fm_stations WHERE is_active = TRUE ORDER BY sort_order ASC, id ASC'
    );
    fmStations = fmRes.rows;

    const chRes = await pool.query(
      includeInactive
        ? 'SELECT id, name, frequency_tag, category, description, loop_queue, auto_ad_enabled, ad_announce_bn, is_active, sort_order FROM radiolink_custom_channels ORDER BY sort_order ASC, id ASC'
        : 'SELECT id, name, frequency_tag, category, description, loop_queue, auto_ad_enabled, ad_announce_bn, is_active, sort_order FROM radiolink_custom_channels WHERE is_active = TRUE ORDER BY sort_order ASC, id ASC'
    );
    channels = chRes.rows;

    const progRes = await pool.query(
      includeInactive
        ? 'SELECT id, channel_id, title, item_type, category, media_id, media_url, sort_order, schedule_mode, start_time_hhmm, end_time_hhmm, duration_sec, is_active FROM radiolink_radio_programs ORDER BY channel_id ASC, sort_order ASC, id ASC'
        : 'SELECT id, channel_id, title, item_type, category, media_id, media_url, sort_order, schedule_mode, start_time_hhmm, end_time_hhmm, duration_sec, is_active FROM radiolink_radio_programs WHERE is_active = TRUE ORDER BY channel_id ASC, sort_order ASC, id ASC'
    );
    programs = progRes.rows;
  } else {
    fmStations = memoryFmStations
      .filter((s) => includeInactive || s.is_active)
      .sort((a, b) => a.sort_order - b.sort_order || a.id - b.id);
    channels = memoryCustomChannels
      .filter((c) => includeInactive || c.is_active)
      .sort((a, b) => a.sort_order - b.sort_order || a.id - b.id);
    programs = memoryRadioPrograms
      .filter((p) => includeInactive || p.is_active)
      .sort((a, b) => a.channel_id - b.channel_id || a.sort_order - b.sort_order || a.id - b.id);
  }

  const cfg = await getMergedAppConfig();
  return {
    ok: true,
    db_ok: Boolean(pool),
    server_time_bd_hhmm: getBdTimeHhMm(),
    fm_stations: fmStations,
    custom_channels: channels,
    programs,
    default_ad: {
      url: String(cfg.radio_default_ad_url || ''),
      announce_bn: String(cfg.radio_default_ad_text || 'আপনি শুনছেন রেডিওলিংক। বর্তমান অনুষ্ঠান শেষ হয়েছে, সাথেই থাকুন!')
    }
  };
}

app.get('/radio/directory', async (_req, res) => {
  try {
    const data = await fetchRadioDirectoryData(false);
    res.setHeader('Cache-Control', 'no-store');
    res.json(data);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/radio/media/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).send('Invalid media id');
    let row = null;
    if (pool) {
      const q = await pool.query(
        'SELECT filename, mime_type, data_bytea FROM radiolink_radio_media WHERE id = $1 LIMIT 1',
        [id]
      );
      row = q.rows[0] || null;
    } else {
      row = memoryRadioMedia.get(id) || null;
    }
    if (!row || !row.data_bytea) return res.status(404).send('Audio not found');
    const buf = Buffer.isBuffer(row.data_bytea) ? row.data_bytea : Buffer.from(row.data_bytea);
    const total = buf.length;
    const mime = String(row.mime_type || 'audio/mpeg');
    res.setHeader('Content-Type', mime);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'public, max-age=86400');

    const range = req.headers.range;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
      if (m) {
        const start = m[1] ? Number(m[1]) : 0;
        const end = m[2] ? Math.min(Number(m[2]), total - 1) : total - 1;
        if (start >= 0 && start <= end && end < total) {
          res.status(206);
          res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
          res.setHeader('Content-Length', String(end - start + 1));
          return res.end(buf.subarray(start, end + 1));
        }
      }
    }
    res.setHeader('Content-Length', String(total));
    return res.end(buf);
  } catch (err) {
    return res.status(500).send(err.message);
  }
});

// HTTPS stream proxy restricted exclusively to registered active FM stations (no open SSRF)
app.get('/radio/fm-proxy/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).send('Invalid station id');
    let streamUrl = '';
    if (pool) {
      const q = await pool.query('SELECT stream_url FROM radiolink_fm_stations WHERE id = $1 AND is_active = TRUE LIMIT 1', [id]);
      streamUrl = q.rows[0]?.stream_url || '';
    } else {
      streamUrl = memoryFmStations.find((s) => s.id === id && s.is_active)?.stream_url || '';
    }
    if (!streamUrl) return res.status(404).send('Station not found');

    const controller = new AbortController();
    req.on('close', () => controller.abort());
    const upstream = await fetch(streamUrl, {
      signal: controller.signal,
      headers: { 'User-Agent': 'RadioLink-AudioRelay/2.1', 'Icy-MetaData': '0' }
    });
    if (!upstream.ok || !upstream.body) {
      return res.status(502).send('FM upstream offline');
    }
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store');
    const reader = upstream.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (res.writableEnded) break;
      res.write(Buffer.from(value));
    }
    return res.end();
  } catch (_) {
    if (!res.headersSent) return res.status(502).send('FM stream unreachable');
    return res.end();
  }
});

app.get('/admin/radio/overview', requireAnyStaffAuth, async (_req, res) => {
  try {
    const data = await fetchRadioDirectoryData(true);
    let mediaFiles = [];
    if (pool) {
      const mRes = await pool.query(
        'SELECT id, filename, mime_type, size_bytes, EXTRACT(EPOCH FROM created_at) * 1000 AS created_ms FROM radiolink_radio_media ORDER BY id DESC LIMIT 100'
      );
      mediaFiles = mRes.rows;
    } else {
      mediaFiles = Array.from(memoryRadioMedia.values()).map((m) => ({
        id: m.id, filename: m.filename, mime_type: m.mime_type, size_bytes: m.size_bytes, created_ms: m.created_ms
      }));
    }
    res.json({ ...data, media_files: mediaFiles });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/admin/radio/fm', requireAdminOnlyAuth, async (req, res) => {
  try {
    const id = Number(req.body?.id || 0);
    const name = String(req.body?.name || '').trim().slice(0, 80);
    const frequency = String(req.body?.frequency || 'FM').trim().slice(0, 24);
    const city = String(req.body?.city || 'Dhaka').trim().slice(0, 40);
    const category = String(req.body?.category || 'Music').trim().slice(0, 40);
    const streamUrl = String(req.body?.stream_url || '').trim();
    const isActive = req.body?.is_active !== false;
    const sortOrder = Number.isFinite(Number(req.body?.sort_order)) ? Number(req.body.sort_order) : 10;
    if (!name || !/^https?:\/\//i.test(streamUrl)) {
      return res.status(400).json({ ok: false, error: 'Valid station name and http/https stream_url required' });
    }
    let savedId = id;
    if (pool) {
      if (id > 0) {
        await pool.query(
          `UPDATE radiolink_fm_stations SET name=$2, frequency=$3, city=$4, category=$5, stream_url=$6, is_active=$7, sort_order=$8, updated_at=NOW() WHERE id=$1`,
          [id, name, frequency, city, category, streamUrl, isActive, sortOrder]
        );
      } else {
        const ins = await pool.query(
          `INSERT INTO radiolink_fm_stations (name, frequency, city, category, stream_url, is_active, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
          [name, frequency, city, category, streamUrl, isActive, sortOrder]
        );
        savedId = ins.rows[0].id;
      }
    } else {
      const idx = memoryFmStations.findIndex((s) => s.id === id);
      const item = { id: idx >= 0 ? id : nextMemoryFmId++, name, frequency, city, category, stream_url: streamUrl, is_active: isActive, sort_order: sortOrder };
      if (idx >= 0) memoryFmStations[idx] = item; else memoryFmStations.push(item);
      savedId = item.id;
    }
    broadcastTextToAllUsers({ type: 'radio_directory_updated' });
    res.json({ ok: true, id: savedId });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete('/admin/radio/fm', requireAdminOnlyAuth, async (req, res) => {
  try {
    const id = Number(req.query.id || req.body?.id || 0);
    if (id <= 0) return res.status(400).json({ ok: false, error: 'id required' });
    if (pool) {
      await pool.query('DELETE FROM radiolink_fm_stations WHERE id = $1', [id]);
    } else {
      memoryFmStations = memoryFmStations.filter((s) => s.id !== id);
    }
    broadcastTextToAllUsers({ type: 'radio_directory_updated' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/admin/radio/channel', requireAdminOnlyAuth, async (req, res) => {
  try {
    const id = Number(req.body?.id || 0);
    const name = String(req.body?.name || '').trim().slice(0, 80);
    const frequencyTag = String(req.body?.frequency_tag || 'RL-CH').trim().slice(0, 24);
    const category = String(req.body?.category || 'Music & Show').trim().slice(0, 40);
    const description = String(req.body?.description || '').trim().slice(0, 180);
    const loopQueue = req.body?.loop_queue !== false;
    const autoAdEnabled = req.body?.auto_ad_enabled !== false;
    const adAnnounceBn = String(req.body?.ad_announce_bn || 'আপনি শুনছেন রেডিওলিংক। সাথেই থাকুন!').trim().slice(0, 220);
    const isActive = req.body?.is_active !== false;
    const sortOrder = Number.isFinite(Number(req.body?.sort_order)) ? Number(req.body.sort_order) : 10;
    if (!name) return res.status(400).json({ ok: false, error: 'Channel name required' });

    let savedId = id;
    if (pool) {
      if (id > 0) {
        await pool.query(
          `UPDATE radiolink_custom_channels SET name=$2, frequency_tag=$3, category=$4, description=$5, loop_queue=$6, auto_ad_enabled=$7, ad_announce_bn=$8, is_active=$9, sort_order=$10, updated_at=NOW() WHERE id=$1`,
          [id, name, frequencyTag, category, description, loopQueue, autoAdEnabled, adAnnounceBn, isActive, sortOrder]
        );
      } else {
        const ins = await pool.query(
          `INSERT INTO radiolink_custom_channels (name, frequency_tag, category, description, loop_queue, auto_ad_enabled, ad_announce_bn, is_active, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
          [name, frequencyTag, category, description, loopQueue, autoAdEnabled, adAnnounceBn, isActive, sortOrder]
        );
        savedId = ins.rows[0].id;
      }
    } else {
      const idx = memoryCustomChannels.findIndex((c) => c.id === id);
      const item = { id: idx >= 0 ? id : nextMemoryChannelId++, name, frequency_tag: frequencyTag, category, description, loop_queue: loopQueue, auto_ad_enabled: autoAdEnabled, ad_announce_bn: adAnnounceBn, is_active: isActive, sort_order: sortOrder };
      if (idx >= 0) memoryCustomChannels[idx] = item; else memoryCustomChannels.push(item);
      savedId = item.id;
    }
    broadcastTextToAllUsers({ type: 'radio_directory_updated' });
    res.json({ ok: true, id: savedId });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete('/admin/radio/channel', requireAdminOnlyAuth, async (req, res) => {
  try {
    const id = Number(req.query.id || req.body?.id || 0);
    if (id <= 0) return res.status(400).json({ ok: false, error: 'id required' });
    if (pool) {
      await pool.query('DELETE FROM radiolink_custom_channels WHERE id = $1', [id]);
    } else {
      memoryCustomChannels = memoryCustomChannels.filter((c) => c.id !== id);
      memoryRadioPrograms = memoryRadioPrograms.filter((p) => p.channel_id !== id);
    }
    broadcastTextToAllUsers({ type: 'radio_directory_updated' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post(
  '/admin/radio/upload',
  express.raw({ type: ['audio/*', 'application/octet-stream'], limit: '16mb' }),
  requireAdminOnlyAuth,
  async (req, res) => {
    try {
      const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (buf.length === 0) {
        return res.status(400).json({ ok: false, error: 'Empty audio payload' });
      }
      if (buf.length > 15 * 1024 * 1024) {
        return res.status(413).json({ ok: false, error: 'Audio file must be <= 15 MB for database hosting (use HTTPS URL for larger files)' });
      }
      const filename = String(req.headers['x-filename'] || req.query.filename || 'track.mp3').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
      const mimeType = String(req.headers['content-type'] || 'audio/mpeg').split(';')[0].trim() || 'audio/mpeg';
      let mediaId = 0;
      if (pool) {
        const ins = await pool.query(
          `INSERT INTO radiolink_radio_media (filename, mime_type, size_bytes, data_bytea) VALUES ($1, $2, $3, $4) RETURNING id`,
          [filename, mimeType, buf.length, buf]
        );
        mediaId = ins.rows[0].id;
      } else {
        mediaId = nextMemoryMediaId++;
        memoryRadioMedia.set(mediaId, { id: mediaId, filename, mime_type: mimeType, size_bytes: buf.length, data_bytea: buf, created_ms: Date.now() });
      }
      const mediaUrl = `/radio/media/${mediaId}`;
      res.json({ ok: true, media_id: mediaId, media_url: mediaUrl, filename, mime_type: mimeType, size_bytes: buf.length });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  }
);

app.post('/admin/radio/program', requireAdminOnlyAuth, async (req, res) => {
  try {
    const id = Number(req.body?.id || 0);
    const channelId = Number(req.body?.channel_id || 0);
    const title = String(req.body?.title || '').trim().slice(0, 100);
    const itemTypeRaw = String(req.body?.item_type || 'music').toLowerCase();
    const itemType = (itemTypeRaw === 'show' || itemTypeRaw === 'ad') ? itemTypeRaw : 'music';
    const category = String(req.body?.category || (itemType === 'ad' ? 'Promo Ad' : 'Music')).trim().slice(0, 40);
    const mediaId = Number(req.body?.media_id || 0) > 0 ? Number(req.body.media_id) : null;
    const mediaUrl = String(req.body?.media_url || '').trim();
    const scheduleMode = String(req.body?.schedule_mode || 'serial').toLowerCase() === 'timed' ? 'timed' : 'serial';
    const startTime = String(req.body?.start_time_hhmm || '').trim().slice(0, 5);
    const endTime = String(req.body?.end_time_hhmm || '').trim().slice(0, 5);
    const durationSec = Math.max(0, Number(req.body?.duration_sec || 0) || 0);
    const sortOrder = Number.isFinite(Number(req.body?.sort_order)) ? Number(req.body.sort_order) : 10;
    const isActive = req.body?.is_active !== false;

    if (channelId <= 0 || !title || !mediaUrl) {
      return res.status(400).json({ ok: false, error: 'channel_id, title, and media_url are required' });
    }
    let savedId = id;
    if (pool) {
      if (id > 0) {
        await pool.query(
          `UPDATE radiolink_radio_programs SET title=$2, item_type=$3, category=$4, media_id=$5, media_url=$6, sort_order=$7, schedule_mode=$8, start_time_hhmm=$9, end_time_hhmm=$10, duration_sec=$11, is_active=$12 WHERE id=$1`,
          [id, title, itemType, category, mediaId, mediaUrl, sortOrder, scheduleMode, startTime, endTime, durationSec, isActive]
        );
      } else {
        const ins = await pool.query(
          `INSERT INTO radiolink_radio_programs (channel_id, title, item_type, category, media_id, media_url, sort_order, schedule_mode, start_time_hhmm, end_time_hhmm, duration_sec, is_active) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
          [channelId, title, itemType, category, mediaId, mediaUrl, sortOrder, scheduleMode, startTime, endTime, durationSec, isActive]
        );
        savedId = ins.rows[0].id;
      }
    } else {
      const idx = memoryRadioPrograms.findIndex((p) => p.id === id);
      const item = { id: idx >= 0 ? id : nextMemoryProgramId++, channel_id: channelId, title, item_type: itemType, category, media_id: mediaId, media_url: mediaUrl, sort_order: sortOrder, schedule_mode: scheduleMode, start_time_hhmm: startTime, end_time_hhmm: endTime, duration_sec: durationSec, is_active: isActive };
      if (idx >= 0) memoryRadioPrograms[idx] = item; else memoryRadioPrograms.push(item);
      savedId = item.id;
    }
    broadcastTextToAllUsers({ type: 'radio_directory_updated' });
    res.json({ ok: true, id: savedId });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/admin/radio/program/reorder', requireAdminOnlyAuth, async (req, res) => {
  try {
    const channelId = Number(req.body?.channel_id || 0);
    const orderedIds = Array.isArray(req.body?.ordered_ids) ? req.body.ordered_ids.map(Number).filter((x) => x > 0) : [];
    if (channelId <= 0 || orderedIds.length === 0) {
      return res.status(400).json({ ok: false, error: 'channel_id and ordered_ids required' });
    }
    if (pool) {
      for (let i = 0; i < orderedIds.length; i++) {
        await pool.query('UPDATE radiolink_radio_programs SET sort_order = $1 WHERE id = $2 AND channel_id = $3', [i + 1, orderedIds[i], channelId]);
      }
    } else {
      orderedIds.forEach((pid, idx) => {
        const p = memoryRadioPrograms.find((x) => x.id === pid && x.channel_id === channelId);
        if (p) p.sort_order = idx + 1;
      });
    }
    broadcastTextToAllUsers({ type: 'radio_directory_updated' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete('/admin/radio/program', requireAdminOnlyAuth, async (req, res) => {
  try {
    const id = Number(req.query.id || req.body?.id || 0);
    if (id <= 0) return res.status(400).json({ ok: false, error: 'id required' });
    if (pool) {
      await pool.query('DELETE FROM radiolink_radio_programs WHERE id = $1', [id]);
    } else {
      memoryRadioPrograms = memoryRadioPrograms.filter((p) => p.id !== id);
    }
    broadcastTextToAllUsers({ type: 'radio_directory_updated' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/admin/radio/default-ad', requireAdminOnlyAuth, async (req, res) => {
  try {
    const adUrl = String(req.body?.url || '').trim();
    const announceBn = String(req.body?.announce_bn || memoryConfig.radio_default_ad_text).trim().slice(0, 240);
    await saveConfigAndBroadcast({
      radio_default_ad_url: adUrl,
      radio_default_ad_text: announceBn
    });
    broadcastTextToAllUsers({ type: 'radio_directory_updated' });
    res.json({ ok: true, radio_default_ad_url: adUrl, radio_default_ad_text: announceBn });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Staff Auth Endpoint
app.post('/admin/login', async (req, res) => {
  try {
    const pin = String(req.body?.pin || req.headers['x-admin-pin'] || '').trim();
    const session = await resolveAdminSession(pin);
    if (!session) {
      return res.status(401).json({ ok: false, error: 'Invalid Admin/Moderator PIN' });
    }
    res.json({
      ok: true,
      role: session.role,
      label: session.label,
      hardware_id: session.hardware_id,
      permissions: permissionsForRole(session.role),
      neon_db: Boolean(pool)
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Server Pool Management Endpoints (Neon DB backed)
app.get('/admin/servers', requireAnyStaffAuth, async (_req, res) => {
  try {
    if (pool) {
      const result = await pool.query(
        'SELECT id, url, platform_type, label, priority, is_active FROM radiolink_servers ORDER BY is_active DESC, priority ASC, id ASC'
      );
      return res.json({ ok: true, db_connected: true, servers: result.rows });
    }
    return res.json({ ok: true, db_connected: false, servers: memoryServers });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/admin/servers', requireAdminOnlyAuth, async (req, res) => {
  try {
    const cleanUrl = normalizeUrl(req.body?.url);
    if (!cleanUrl) return res.status(400).json({ ok: false, error: 'Valid http/https URL required' });
    const platformType = String(req.body?.platform_type || detectPlatform(cleanUrl)).toLowerCase();
    const label = String(req.body?.label || '').trim().slice(0, 64);
    const priority = Number.isFinite(Number(req.body?.priority)) ? Number(req.body.priority) : 10;
    const isActive = req.body?.is_active !== false;

    if (pool) {
      await pool.query(
        `INSERT INTO radiolink_servers (url, platform_type, label, priority, is_active, updated_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT (url) DO UPDATE SET
           platform_type = EXCLUDED.platform_type,
           label = EXCLUDED.label,
           priority = EXCLUDED.priority,
           is_active = EXCLUDED.is_active,
           updated_at = NOW()`,
        [cleanUrl, platformType, label, priority, isActive]
      );
    } else {
      const idx = memoryServers.findIndex((s) => s.url === cleanUrl);
      const item = { id: idx >= 0 ? memoryServers[idx].id : memoryServers.length + 1, url: cleanUrl, platform_type: platformType, label, priority, is_active: isActive };
      if (idx >= 0) memoryServers[idx] = item; else memoryServers.push(item);
    }
    const cfg = await getMergedAppConfig();
    await saveConfigAndBroadcast(cfg);
    res.json({ ok: true, url: cleanUrl });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/admin/servers/sync', requireAdminOnlyAuth, async (req, res) => {
  try {
    const list = Array.isArray(req.body?.servers) ? req.body.servers : [];
    const urls = list.map((item) => (typeof item === 'string' ? item : item?.url)).filter(Boolean);
    if (urls.length === 0) return res.status(400).json({ ok: false, error: 'servers array required' });
    await syncServersListToDb(urls);
    const cfg = await getMergedAppConfig();
    await saveConfigAndBroadcast(cfg);
    res.json({ ok: true, count: urls.length, primary_relay_url: cfg.primary_relay_url });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete('/admin/servers', requireAdminOnlyAuth, async (req, res) => {
  try {
    const cleanUrl = normalizeUrl(req.query.url || req.body?.url);
    if (!cleanUrl) return res.status(400).json({ ok: false, error: 'url required' });
    if (pool) {
      await pool.query('DELETE FROM radiolink_servers WHERE url = $1', [cleanUrl]);
    } else {
      const idx = memoryServers.findIndex((s) => s.url === cleanUrl);
      if (idx >= 0) memoryServers.splice(idx, 1);
    }
    const cfg = await getMergedAppConfig();
    await saveConfigAndBroadcast(cfg);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Role Management Endpoints (Create/List/Revoke Admin & Moderator)
app.get('/admin/roles', requireAnyStaffAuth, async (_req, res) => {
  try {
    if (pool) {
      const result = await pool.query(
        `SELECT id, hardware_id, role, label, (pin_hash <> '') AS has_pin, created_by, is_active,
                EXTRACT(EPOCH FROM created_at) * 1000 AS created_ms
         FROM radiolink_roles
         WHERE is_active = TRUE
         ORDER BY CASE WHEN role = 'admin' THEN 0 ELSE 1 END, id DESC`
      );
      return res.json({
        ok: true,
        db_connected: true,
        roles: result.rows.map((r) => ({
          id: r.id,
          hardware_id: r.hardware_id || '',
          role: r.role,
          label: r.label || '',
          has_pin: Boolean(r.has_pin),
          created_by: r.created_by || 'super_admin',
          created_ms: Math.round(Number(r.created_ms || 0))
        }))
      });
    }
    const list = Array.from(memoryRoles.values())
      .filter((r) => r.is_active)
      .map((r) => ({
        id: r.id,
        hardware_id: r.hardware_id || '',
        role: r.role,
        label: r.label,
        has_pin: Boolean(r.pin_hash),
        created_by: r.created_by,
        created_ms: r.created_ms
      }));
    return res.json({ ok: true, db_connected: false, roles: list });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/admin/roles', requireAdminOnlyAuth, async (req, res) => {
  try {
    const hwId = String(req.body?.hardware_id || '').trim() || null;
    const roleRaw = String(req.body?.role || 'moderator').trim().toLowerCase();
    const role = roleRaw === 'admin' ? 'admin' : 'moderator';
    const label = String(req.body?.label || (role === 'admin' ? 'Admin' : 'Moderator')).trim().slice(0, 64);
    const rawPin = String(req.body?.pin || '').trim();
    const pinHash = rawPin ? hashRolePin(rawPin) : '';

    if (!hwId && !pinHash) {
      return res.status(400).json({ ok: false, error: 'Either hardware_id or pin is required' });
    }
    if (rawPin && rawPin === ADMIN_PIN) {
      return res.status(400).json({ ok: false, error: 'Cannot reuse Master Admin PIN for role entry' });
    }

    if (pool) {
      if (hwId) {
        await pool.query(
          `INSERT INTO radiolink_roles (hardware_id, role, label, pin_hash, created_by, is_active, updated_at)
           VALUES ($1, $2, $3, $4, $5, TRUE, NOW())
           ON CONFLICT (hardware_id) DO UPDATE SET
             role = EXCLUDED.role,
             label = EXCLUDED.label,
             pin_hash = CASE WHEN EXCLUDED.pin_hash <> '' THEN EXCLUDED.pin_hash ELSE radiolink_roles.pin_hash END,
             is_active = TRUE,
             updated_at = NOW()`,
          [hwId, role, label, pinHash, req.adminSession.role]
        );
        const cs = role === 'admin' ? 'Admin' : 'Moderator';
        await pool.query(
          `UPDATE radiolink_users SET role = $2, callsign = $3 WHERE hardware_id = $1`,
          [hwId, role, cs]
        );
      } else {
        await pool.query(
          `INSERT INTO radiolink_roles (hardware_id, role, label, pin_hash, created_by, is_active)
           VALUES (NULL, $1, $2, $3, $4, TRUE)`,
          [role, label, pinHash, req.adminSession.role]
        );
      }
    } else {
      let existing = hwId ? Array.from(memoryRoles.values()).find((r) => r.hardware_id === hwId) : null;
      if (existing) {
        existing.role = role;
        existing.label = label;
        if (pinHash) existing.pin_hash = pinHash;
        existing.is_active = true;
      } else {
        const id = nextMemoryRoleId++;
        memoryRoles.set(id, {
          id,
          hardware_id: hwId,
          role,
          label,
          pin_hash: pinHash,
          created_by: req.adminSession.role,
          is_active: true,
          created_ms: Date.now()
        });
      }
    }

    const overrides = await getActiveRoleOverridesMap();
    const callsigns = await getActiveCallsignOverridesMap();
    broadcastTextToAllUsers({ type: 'channel_roles', roles: overrides, callsigns });
    if (hwId) {
      notifyUserRoleChange(hwId, role, role === 'admin' ? 'Admin' : 'Moderator');
    }
    const cfg = await getMergedAppConfig();
    await saveConfigAndBroadcast(cfg);
    res.json({ ok: true, hardware_id: hwId || '', role, label });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete('/admin/roles', requireAdminOnlyAuth, async (req, res) => {
  try {
    const id = Number(req.query.id || req.body?.id || 0);
    const hwId = String(req.query.hardware_id || req.body?.hardware_id || '').trim();
    if (!id && !hwId) return res.status(400).json({ ok: false, error: 'id or hardware_id required' });

    let affectedHw = hwId;
    let restoredCallsign = '';
    if (pool) {
      if (id > 0) {
        const found = await pool.query('SELECT hardware_id FROM radiolink_roles WHERE id = $1', [id]);
        if (!affectedHw && found.rows[0]?.hardware_id) affectedHw = found.rows[0].hardware_id;
        await pool.query('DELETE FROM radiolink_roles WHERE id = $1', [id]);
      } else {
        await pool.query('DELETE FROM radiolink_roles WHERE hardware_id = $1', [hwId]);
      }
      if (affectedHw) {
        restoredCallsign = await allocateUniqueTacticalCallsign(affectedHw);
        await pool.query(
          `UPDATE radiolink_users SET role = 'user', callsign = $2 WHERE hardware_id = $1`,
          [affectedHw, restoredCallsign]
        );
      }
    } else {
      if (id > 0) {
        const row = memoryRoles.get(id);
        if (row && !affectedHw) affectedHw = row.hardware_id || '';
        memoryRoles.delete(id);
      } else {
        for (const [k, v] of memoryRoles.entries()) {
          if (v.hardware_id === hwId) memoryRoles.delete(k);
        }
      }
      if (affectedHw) {
        restoredCallsign = await allocateUniqueTacticalCallsign(affectedHw);
        const memUser = memoryUsers.get(affectedHw);
        if (memUser) {
          memUser.role = 'user';
          memUser.callsign = restoredCallsign;
        }
      }
    }

    const overrides = await getActiveRoleOverridesMap();
    const callsigns = await getActiveCallsignOverridesMap();
    broadcastTextToAllUsers({ type: 'channel_roles', roles: overrides, callsigns });
    if (affectedHw) {
      notifyUserRoleChange(affectedHw, 'user', restoredCallsign || computeTacticalCallsign(affectedHw));
    }
    const cfg = await getMergedAppConfig();
    await saveConfigAndBroadcast(cfg);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// User Directory & Ban Endpoints
app.get('/admin/users', requireAnyStaffAuth, async (_req, res) => {
  try {
    const onlineHwIds = new Set();
    for (const meta of clients.values()) {
      if (meta.hardwareId) onlineHwIds.add(String(meta.hardwareId));
    }
    const roleMap = await getActiveRoleOverridesMap();
    if (pool) {
      const result = await pool.query(`
        SELECT hardware_id, callsign, district, role, channel_id, is_private,
               report_count, is_banned,
               EXTRACT(EPOCH FROM first_seen_at) * 1000 AS first_seen_ms,
               EXTRACT(EPOCH FROM last_seen_at) * 1000 AS last_seen_ms
        FROM radiolink_users
        ORDER BY last_seen_at DESC
        LIMIT 500
      `);
      const users = result.rows.map((r) => {
        const hw = String(r.hardware_id);
        const effRole = roleMap[hw] || r.role || 'user';
        const displayCallsign =
          effRole === 'admin' ? 'Admin'
            : effRole === 'moderator' ? 'Moderator'
            : (isValidTacticalCallsign(r.callsign) ? r.callsign : computeTacticalCallsign(hw));
        return {
          hardware_id: hw,
          callsign: displayCallsign,
          district: r.district || 'US',
          role: effRole,
          channel_id: Number(r.channel_id || 1),
          is_private: Boolean(r.is_private),
          report_count: Number(r.report_count || 0),
          is_banned: Boolean(r.is_banned),
          first_seen_ms: Math.round(Number(r.first_seen_ms || 0)),
          last_seen_ms: Math.round(Number(r.last_seen_ms || 0)),
          is_online: onlineHwIds.has(hw)
        };
      });
      return res.json({ ok: true, db_connected: true, users });
    } else {
      const users = Array.from(memoryUsers.values())
        .map((u) => {
          const effRole = roleMap[u.hardware_id] || u.role || 'user';
          return {
            ...u,
            role: effRole,
            callsign: effRole === 'admin' ? 'Admin' : effRole === 'moderator' ? 'Moderator' : u.callsign,
            is_online: onlineHwIds.has(String(u.hardware_id))
          };
        })
        .sort((a, b) => b.last_seen_ms - a.last_seen_ms);
      return res.json({ ok: true, db_connected: false, users });
    }
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/admin/ban', requireAnyStaffAuth, async (req, res) => {
  try {
    const hwId = String(req.body?.hardware_id || '').trim();
    const shouldBan = req.body?.ban !== false;
    if (!hwId) return res.status(400).json({ ok: false, error: 'hardware_id required' });

    const targetRole = await getRoleForHardwareId(hwId);
    if (shouldBan && targetRole === 'admin' && req.adminSession.role !== 'super_admin') {
      return res.status(403).json({ ok: false, error: 'Moderators cannot ban an Admin' });
    }

    const cfg = await getMergedAppConfig();
    const set = new Set((cfg.banned_hardware_ids || []).map(String));
    if (shouldBan) {
      set.add(hwId);
    } else {
      set.delete(hwId);
    }

    if (pool) {
      await pool.query(
        'UPDATE radiolink_users SET is_banned = $2 WHERE hardware_id = $1',
        [hwId, shouldBan]
      );
    } else if (memoryUsers.has(hwId)) {
      memoryUsers.get(hwId).is_banned = shouldBan;
    }

    cfg.banned_hardware_ids = Array.from(set);
    await saveConfigAndBroadcast(cfg);
    res.json({ ok: true, hardware_id: hwId, is_banned: shouldBan });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/admin/policy', requireAdminOnlyAuth, async (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object') {
      return res.status(400).json({ ok: false, error: 'JSON body required' });
    }
    await saveConfigAndBroadcast(req.body);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// WebSocket Relay Server
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const clients = new Map(); // ws -> { channel, isAdmin, isAdminAuthenticated, adminRole, hardwareId }

function broadcastTextToAllUsers(obj) {
  const payload = JSON.stringify(obj);
  for (const [client] of clients.entries()) {
    if (client.readyState === 1) {
      try {
        client.send(payload);
      } catch (_) {}
    }
  }
}

function notifyUserRoleChange(hwId, role, customCallsign = '') {
  const callsign = role === 'admin'
    ? 'Admin'
    : role === 'moderator'
    ? 'Moderator'
    : (isValidTacticalCallsign(customCallsign) ? customCallsign : computeTacticalCallsign(hwId));
  const payload = JSON.stringify({
    type: 'self_role',
    hardware_id: hwId,
    role,
    callsign,
    db_ok: Boolean(pool)
  });
  for (const [client, meta] of clients.entries()) {
    if (meta.hardwareId === hwId && client.readyState === 1) {
      try {
        client.send(payload);
      } catch (_) {}
    }
  }
}

function broadcastChannelPeerCount(channelId) {
  let count = 0;
  for (const [, meta] of clients.entries()) {
    if (!meta.isAdmin && meta.channel === channelId) count++;
  }
  const msg = JSON.stringify({ type: 'peers', channel: channelId, count: Math.max(count, 1) });
  for (const [client, meta] of clients.entries()) {
    if (meta.channel === channelId && client.readyState === 1) {
      try {
        client.send(msg);
      } catch (_) {}
    }
  }
}

wss.on('connection', async (ws, req) => {
  const parsed = url.parse(req.url || '/', true);
  const initialCh = Number(parsed.query.ch || 1) || 1;
  const isAdmin = parsed.query.admin === '1';
  const providedPin = String(req.headers['x-admin-pin'] || parsed.query.pin || '').trim();
  const session = isAdmin && providedPin ? await resolveAdminSession(providedPin) : null;
  const isAdminAuthenticated = Boolean(session);

  clients.set(ws, {
    channel: initialCh,
    isAdmin,
    isAdminAuthenticated,
    adminRole: session?.role || null,
    hardwareId: null
  });
  broadcastChannelPeerCount(initialCh);

  try {
    const [roles, callsigns] = await Promise.all([
      getActiveRoleOverridesMap(),
      getActiveCallsignOverridesMap()
    ]);
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'channel_roles', roles, callsigns, db_ok: Boolean(pool) }));
    }
  } catch (_) {}

  ws.on('message', async (data, isBinary) => {
    const meta = clients.get(ws);
    if (!meta) return;

    if (!isBinary) {
      try {
        const msg = JSON.parse(data.toString('utf8'));
        if (msg.type === 'switch') {
          const oldCh = meta.channel;
          const nextCh = Number(msg.channel || 1) || 1;
          meta.channel = nextCh;
          broadcastChannelPeerCount(oldCh);
          broadcastChannelPeerCount(nextCh);
          const [roles, callsigns] = await Promise.all([
            getActiveRoleOverridesMap(),
            getActiveCallsignOverridesMap()
          ]);
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({ type: 'channel_roles', roles, callsigns, db_ok: Boolean(pool) }));
          }
        } else if (msg.type === 'register_presence') {
          meta.hardwareId = msg.hardware_id ? String(msg.hardware_id) : meta.hardwareId;
          const info = await upsertUserPresence({
            hardwareId: msg.hardware_id,
            callsign: msg.callsign,
            district: msg.district,
            channelId: msg.channel || meta.channel,
            isPrivate: msg.is_private
          });
          const [roles, callsigns] = await Promise.all([
            getActiveRoleOverridesMap(),
            getActiveCallsignOverridesMap()
          ]);
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({
              type: 'self_role',
              hardware_id: meta.hardwareId,
              role: info.role,
              callsign: info.callsign,
              db_ok: Boolean(pool)
            }));
            ws.send(JSON.stringify({ type: 'channel_roles', roles, callsigns, db_ok: Boolean(pool) }));
          }
          // Notify peers on the same channel about updated unique Neon callsigns
          if (info.role === 'user' && meta.hardwareId && info.callsign) {
            broadcastTextToAllUsers({
              type: 'channel_roles',
              roles,
              callsigns: { [meta.hardwareId]: info.callsign },
              db_ok: Boolean(pool)
            });
          }
        } else if (msg.type === 'user_report') {
          await recordUserReport({
            reportedHardwareId: msg.reported_hardware_id,
            reportedCallsign: msg.reported_callsign,
            reportedDistrict: msg.reported_district,
            reporterHardwareId: msg.reporter_hardware_id,
            reporterCallsign: msg.reporter_callsign,
            channelId: msg.channel || meta.channel,
            reason: msg.reason
          });
        } else if (msg.type === 'admin_update_broadcast' && msg.payload) {
          const msgPin = String(msg.pin || '').trim();
          const msgSession = msgPin ? await resolveAdminSession(msgPin) : null;
          const effectiveRole = meta.adminRole || msgSession?.role;
          if (effectiveRole !== 'super_admin' && effectiveRole !== 'admin') {
            return;
          }
          await saveConfigAndBroadcast(msg.payload);
        }
      } catch (e) {
        console.warn('[WS] Text message error:', e.message);
      }
      return;
    }

    // Relay binary voice/control packet to peers on the same channel (plus admin listeners on that channel)
    for (const [peer, peerMeta] of clients.entries()) {
      if (peer !== ws && peer.readyState === 1 && peerMeta.channel === meta.channel) {
        try {
          peer.send(data, { binary: true });
        } catch (_) {}
      }
    }
  });

  ws.on('close', () => {
    const meta = clients.get(ws);
    clients.delete(ws);
    if (meta) {
      broadcastChannelPeerCount(meta.channel);
    }
  });
});

initDatabase()
  .then(() => {
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`RadioLink Universal Relay (${PLATFORM_HINT}) + Neon DB listening on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Database initialization failed:', err);
    process.exit(1);
  });
