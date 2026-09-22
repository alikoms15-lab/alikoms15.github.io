/**
 * LUNARO / LNR — Comprehensive Cloudflare Worker
 * ------------------------------------------------
 * Backend for the LUNARO Telegram Mini App.
 *
 * FRONTEND BASIS:
 * - LNR / LUNARO
 * - Telegram Mini App + TON Connect
 * - Pool Wallet = claimed LNR inside the app
 * - Holding Wallet = LNR held in the user's connected TON wallet
 * - Total Assets = Pool Wallet + Holding Wallet
 * - Unclaimed mining is NOT part of Total Assets until Claim
 * - Level 1 is the starting level
 * - Level 2 requires 500 LNR
 * - Required LNR = (Level - 1) * 500
 * - Maximum level = 1000
 * - Level 1000 requires 499,500 LNR
 * - Level unlock is based on Total Assets, not USD
 * - Reference price is used only to display approximate USDT value
 * - Real swap quote is separate from reference price
 * - Referral success: referred user enters with a referral link AND verifies a TON wallet
 * - Successful referral reward: 500 LNR to the referrer
 * - Referral claim reward: 10% of every referred user's actual claimed amount
 * - Withdrawal: minimum 500 LNR, fee 70 LNR, net payout 430 LNR
 *
 * IMPORTANT:
 * This file deliberately does NOT contain a private key.
 * A real on-chain automatic payout signer must be connected separately through
 * a secure secret/service. Never put a TON private key in index.html or GitHub.
 *
 * CLOUDFLARE:
 * - Runtime: Cloudflare Workers
 * - Database: D1
 *
 * Recommended environment variables:
 *   TELEGRAM_BOT_TOKEN        = Telegram bot token
 *   TONAPI_BASE               = https://tonapi.io
 *   TONAPI_KEY                = optional TonAPI key
 *   LNR_JETTON_MASTER         = LNR Jetton Master address
 *   TREASURY_ADDRESS          = UQD1PoPAxzSz4FgPz2HuuwrLhvPqOTQQT4u1VgzwqGgfNO5q
 *   ADMIN_SECRET              = long random secret for admin endpoints
 *   REFERENCE_LNR_USDT        = optional starting reference price, e.g. 0.0008
 *   ALLOW_UNVERIFIED_REQUESTS = false in production
 *
 * D1 binding:
 *   DB
 *
 * Routes:
 *   GET  /health
 *   GET  /config
 *   GET  /user?telegram_id=...
 *   POST /user
 *   POST /mine
 *   POST /claim
 *   POST /withdraw
 *   GET  /withdrawals?telegram_id=...
 *   GET  /miners
 *   GET  /referral?telegram_id=...
 *   GET  /price
 *   POST /admin/price
 *   POST /admin/holding-refresh
 *   GET  /admin/withdrawals
 *
 * The Worker is authoritative for balances.
 * Frontend localStorage values must never be trusted for money operations.
 */

const CONFIG = Object.freeze({
  BOT_USERNAME: "LunaroGameBot",
  API_VERSION: "3.0.0",

  MAX_LEVEL: 1000,
  LEVEL_STEP_LNR: 500,

  BASE_MINING_RATE: 0.70,
  MINING_RATE_STEP: 0.05,

  WITHDRAW_MIN: 500,
  WITHDRAW_FEE: 70,
  WITHDRAW_NET: 430,

  REFERRAL_SUCCESS_BONUS: 500,
  REFERRAL_CLAIM_PERCENT: 0.10,

  DEFAULT_REFERENCE_PRICE: 0.0008,

  // Public treasury address supplied for the project.
  // The private key MUST NOT be stored here.
  TREASURY_ADDRESS:
    "UQD1PoPAxzSz4FgPz2HuuwrLhvPqOTQQT4u1VgzwqGgfNO5q",

  // Used only as a safety cap for mining calculations.
  MAX_CATCHUP_HOURS: 24,

  // Wallet balance cache duration.
  HOLDING_CACHE_SECONDS: 45,

  // Telegram initData is expected in production.
  TELEGRAM_AUTH_MAX_AGE_SECONDS: 86400
});

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store"
};

export default {
  async fetch(request, env, ctx) {
    try {
      await ensureSchema(env);

      const url = new URL(request.url);
      const method = request.method.toUpperCase();
      const path = normalizePath(url.pathname);

      if (method === "OPTIONS") {
        return cors(new Response(null, { status: 204 }));
      }

      if (path === "/health" && method === "GET") {
        return json({
          success: true,
          service: "LUNARO Worker",
          version: CONFIG.API_VERSION,
          database: !!env.DB,
          time: new Date().toISOString()
        });
      }

      if (path === "/config" && method === "GET") {
        return json({
          success: true,
          bot_username: CONFIG.BOT_USERNAME,
          max_level: CONFIG.MAX_LEVEL,
          level_step_lnr: CONFIG.LEVEL_STEP_LNR,
          level_2_required_lnr: requiredLnrForLevel(2),
          level_1000_required_lnr: requiredLnrForLevel(1000),
          withdrawal_min: CONFIG.WITHDRAW_MIN,
          withdrawal_fee: CONFIG.WITHDRAW_FEE,
          withdrawal_net: CONFIG.WITHDRAW_NET,
          referral_success_bonus: CONFIG.REFERRAL_SUCCESS_BONUS,
          referral_claim_percent: CONFIG.REFERRAL_CLAIM_PERCENT,
          treasury_address: CONFIG.TREASURY_ADDRESS
        });
      }

      if (path === "/price" && method === "GET") {
        return handleGetPrice(env);
      }

      if (path === "/user" && method === "POST") {
        return handleUserPost(request, env);
      }

      if (path === "/user" && method === "GET") {
        return handleUserGet(request, env);
      }

      if (path === "/mine" && method === "POST") {
        return handleMine(request, env);
      }

      if (path === "/claim" && method === "POST") {
        return handleClaim(request, env);
      }

      if (path === "/withdraw" && method === "POST") {
        return handleWithdraw(request, env);
      }

      if (path === "/withdrawals" && method === "GET") {
        return handleWithdrawals(request, env);
      }

      if (path === "/miners" && method === "GET") {
        return handleMiners(request, env);
      }

      if (path === "/referral" && method === "GET") {
        return handleReferral(request, env);
      }

      if (path === "/admin/price" && method === "POST") {
        return handleAdminPrice(request, env);
      }

      if (path === "/admin/holding-refresh" && method === "POST") {
        return handleAdminHoldingRefresh(request, env);
      }

      if (path === "/admin/withdrawals" && method === "GET") {
        return handleAdminWithdrawals(request, env);
      }

      return json({ success: false, error: "Not found" }, 404);
    } catch (error) {
      console.error("UNHANDLED_WORKER_ERROR", error);
      return json({
        success: false,
        error: "Internal server error"
      }, 500);
    }
  }
};

/* =========================================================
   RESPONSE / CORS
   ========================================================= */

function cors(response) {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  headers.set(
    "Access-Control-Allow-Headers",
    "Content-Type, X-Telegram-Init-Data, X-Admin-Secret"
  );
  headers.set("Access-Control-Max-Age", "86400");

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function json(data, status = 200) {
  return cors(
    new Response(JSON.stringify(data), {
      status,
      headers: JSON_HEADERS
    })
  );
}

function normalizePath(pathname) {
  const p = String(pathname || "/").replace(/\/+/g, "/");
  if (p.length > 1 && p.endsWith("/")) return p.slice(0, -1);
  return p;
}

/* =========================================================
   GENERAL HELPERS
   ========================================================= */

function nowIso() {
  return new Date().toISOString();
}

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function nonNegative(value) {
  return Math.max(0, num(value));
}

function round8(value) {
  return Math.round(num(value) * 1e8) / 1e8;
}

function round6(value) {
  return Math.round(num(value) * 1e6) / 1e6;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, num(value)));
}

function randomHex(length = 16) {
  const bytes = new Uint8Array(Math.ceil(length / 2));
  crypto.getRandomValues(bytes);
  return [...bytes].map(b => b.toString(16).padStart(2, "0")).join("").slice(0, length);
}

function referralCodeForTelegramId(telegramId) {
  const raw = String(telegramId || "");
  const suffix = raw.replace(/\D/g, "").slice(-8).padStart(8, "0");
  return `LNR${suffix}`;
}

function claimKey(telegramId, claimId) {
  return `${String(telegramId)}:${String(claimId)}`;
}

function requiredLnrForLevel(level) {
  const n = clamp(Math.floor(num(level, 1)), 1, CONFIG.MAX_LEVEL);
  if (n <= 1) return 0;
  return (n - 1) * CONFIG.LEVEL_STEP_LNR;
}

function miningRateForLevel(level) {
  const n = clamp(Math.floor(num(level, 1)), 1, CONFIG.MAX_LEVEL);
  return round8(CONFIG.BASE_MINING_RATE + (n - 1) * CONFIG.MINING_RATE_STEP);
}

function getLevelFromTotalAssets(totalAssets) {
  const assets = nonNegative(totalAssets);
  let level = Math.floor(assets / CONFIG.LEVEL_STEP_LNR) + 1;
  return clamp(level, 1, CONFIG.MAX_LEVEL);
}

function getNextLevelRequired(level) {
  if (level >= CONFIG.MAX_LEVEL) return requiredLnrForLevel(CONFIG.MAX_LEVEL);
  return requiredLnrForLevel(level + 1);
}

function getLevelProgress(totalAssets, level) {
  const current = clamp(Math.floor(num(level, 1)), 1, CONFIG.MAX_LEVEL);

  if (current >= CONFIG.MAX_LEVEL) return 100;

  const nextRequired = requiredLnrForLevel(current + 1);
  if (nextRequired <= 0) return 100;

  return round6(clamp((nonNegative(totalAssets) / nextRequired) * 100, 0, 100));
}

function getMissingForNextLevel(totalAssets, level) {
  if (level >= CONFIG.MAX_LEVEL) return 0;
  return round8(
    Math.max(0, requiredLnrForLevel(level + 1) - nonNegative(totalAssets))
  );
}

/* =========================================================
   REQUEST / BODY HELPERS
   ========================================================= */

async function readJson(request) {
  try {
    const text = await request.text();
    if (!text) return {};
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function getTelegramInitData(request) {
  return (
    request.headers.get("X-Telegram-Init-Data") ||
    request.headers.get("x-telegram-init-data") ||
    ""
  );
}

async function requireTelegramIdentity(request, env, body = {}) {
  const initData = getTelegramInitData(request);

  // During early testing, the frontend may not yet send initData.
  // Set ALLOW_UNVERIFIED_REQUESTS=false for production.
  const allowUnverified =
    String(env.ALLOW_UNVERIFIED_REQUESTS || "true").toLowerCase() === "true";

  if (initData && env.TELEGRAM_BOT_TOKEN) {
    const verified = await verifyTelegramInitData(
      initData,
      env.TELEGRAM_BOT_TOKEN
    );

    if (!verified.ok) {
      throw httpError(401, verified.error || "Invalid Telegram session");
    }

    const telegramUser = verified.user || {};
    const verifiedId = String(telegramUser.id || "");

    if (!verifiedId) {
      throw httpError(401, "Telegram user not found");
    }

    if (body.telegram_id != null && String(body.telegram_id) !== verifiedId) {
      throw httpError(403, "Telegram user mismatch");
    }

    return {
      telegramId: verifiedId,
      telegramUser,
      verified: true
    };
  }

  if (!allowUnverified) {
    throw httpError(401, "Telegram authentication required");
  }

  const telegramId = String(body.telegram_id || "").trim();

  if (!telegramId) {
    throw httpError(400, "telegram_id is required");
  }

  return {
    telegramId,
    telegramUser: {
      id: telegramId,
      username: body.username || "",
      first_name: body.first_name || ""
    },
    verified: false
  };
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function handleError(error) {
  if (error && error.status) {
    return json({ success: false, error: error.message }, error.status);
  }

  console.error(error);
  return json({ success: false, error: "Internal server error" }, 500);
}

/* =========================================================
   TELEGRAM INIT DATA VERIFICATION
   =========================================================
   Telegram Web Apps use:
   HMAC-SHA256(key = HMAC-SHA256("WebAppData", bot_token), data_check_string)
   */

async function verifyTelegramInitData(initData, botToken) {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get("hash");

    if (!hash) {
      return { ok: false, error: "Telegram hash missing" };
    }

    params.delete("hash");

    const pairs = [];
    for (const [key, value] of [...params.entries()].sort()) {
      pairs.push(`${key}=${value}`);
    }

    const dataCheckString = pairs.join("\n");

    const secretKey = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode("WebAppData"),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );

    const secretSignature = await crypto.subtle.sign(
      "HMAC",
      secretKey,
      new TextEncoder().encode(botToken)
    );

    const derivedKey = await crypto.subtle.importKey(
      "raw",
      secretSignature,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );

    const calculated = new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        derivedKey,
        new TextEncoder().encode(dataCheckString)
      )
    );

    const calculatedHex = [...calculated]
      .map(b => b.toString(16).padStart(2, "0"))
      .join("");

    if (!timingSafeEqual(calculatedHex, hash)) {
      return { ok: false, error: "Telegram signature invalid" };
    }

    const authDate = num(params.get("auth_date"), 0);
    const age = Math.floor(Date.now() / 1000) - authDate;

    if (
      authDate &&
      age > CONFIG.TELEGRAM_AUTH_MAX_AGE_SECONDS
    ) {
      return { ok: false, error: "Telegram session expired" };
    }

    let user = {};
    try {
      user = JSON.parse(params.get("user") || "{}");
    } catch {}

    return { ok: true, user, authDate };
  } catch (error) {
    console.error("verifyTelegramInitData", error);
    return { ok: false, error: "Telegram verification failed" };
  }
}

function timingSafeEqual(a, b) {
  const aa = String(a || "");
  const bb = String(b || "");

  if (aa.length !== bb.length) return false;

  let result = 0;
  for (let i = 0; i < aa.length; i++) {
    result |= aa.charCodeAt(i) ^ bb.charCodeAt(i);
  }

  return result === 0;
}

/* =========================================================
   DATABASE SCHEMA
   ========================================================= */

async function ensureSchema(env) {
  if (!env.DB) throw new Error("D1 binding DB is missing");

  const statements = [
    `
    CREATE TABLE IF NOT EXISTS users (
      telegram_id TEXT PRIMARY KEY,
      username TEXT DEFAULT '',
      first_name TEXT DEFAULT '',
      wallet TEXT DEFAULT '',
      balance REAL NOT NULL DEFAULT 0,
      mined REAL NOT NULL DEFAULT 0,
      mining_rate REAL NOT NULL DEFAULT 0.7,
      level INTEGER NOT NULL DEFAULT 1,
      referred_by TEXT DEFAULT '',
      referral_code TEXT UNIQUE,
      referral_success INTEGER NOT NULL DEFAULT 0,
      referral_success_at TEXT DEFAULT '',
      referral_bonus_credited REAL NOT NULL DEFAULT 0,
      referral_earnings REAL NOT NULL DEFAULT 0,
      holding REAL DEFAULT 0,
      holding_updated_at TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
    `,
    `
    CREATE TABLE IF NOT EXISTS claims (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id TEXT NOT NULL,
      wallet TEXT DEFAULT '',
      amount REAL NOT NULL,
      claim_key TEXT UNIQUE,
      created_at TEXT NOT NULL
    )
    `,
    `
    CREATE TABLE IF NOT EXISTS referral_bonus_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      referred_telegram_id TEXT UNIQUE NOT NULL,
      referrer_telegram_id TEXT NOT NULL,
      amount REAL NOT NULL,
      created_at TEXT NOT NULL
    )
    `,
    `
    CREATE TABLE IF NOT EXISTS referral_claim_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      claim_key TEXT UNIQUE NOT NULL,
      referred_telegram_id TEXT NOT NULL,
      referrer_telegram_id TEXT NOT NULL,
      claim_amount REAL NOT NULL,
      reward_amount REAL NOT NULL,
      created_at TEXT NOT NULL
    )
    `,
    `
    CREATE TABLE IF NOT EXISTS withdrawals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id TEXT NOT NULL,
      wallet TEXT NOT NULL,
      amount REAL NOT NULL,
      fee REAL NOT NULL,
      net_amount REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      tx_hash TEXT DEFAULT '',
      error TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
    `,
    `
    CREATE TABLE IF NOT EXISTS daily_tasks (
      telegram_id TEXT NOT NULL,
      task_date TEXT NOT NULL,
      reward REAL NOT NULL DEFAULT 3,
      created_at TEXT NOT NULL,
      PRIMARY KEY (telegram_id, task_date)
    )
    `,
    `
    CREATE TABLE IF NOT EXISTS price_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      price_usdt REAL NOT NULL,
      source TEXT DEFAULT 'admin',
      created_at TEXT NOT NULL
    )
    `,
    `
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
    `,
    `
    CREATE INDEX IF NOT EXISTS idx_users_wallet
    ON users(wallet)
    `,
    `
    CREATE INDEX IF NOT EXISTS idx_users_referred_by
    ON users(referred_by)
    `,
    `
    CREATE INDEX IF NOT EXISTS idx_claims_telegram
    ON claims(telegram_id)
    `,
    `
    CREATE INDEX IF NOT EXISTS idx_withdrawals_telegram
    ON withdrawals(telegram_id)
    `,
    `
    CREATE INDEX IF NOT EXISTS idx_withdrawals_status
    ON withdrawals(status)
    `
  ];

  for (const sql of statements) {
    await env.DB.prepare(sql).run();
  }

  const defaultPrice = num(
    env.REFERENCE_LNR_USDT,
    CONFIG.DEFAULT_REFERENCE_PRICE
  );

  await env.DB.prepare(`
    INSERT INTO app_settings(key, value, updated_at)
    VALUES ('reference_lnr_usdt', ?, ?)
    ON CONFLICT(key) DO NOTHING
  `).bind(String(defaultPrice), nowIso()).run();
}

/* =========================================================
   USER LOOKUP / SERIALIZATION
   ========================================================= */

async function getUserRow(env, telegramId) {
  return await env.DB.prepare(`
    SELECT *
    FROM users
    WHERE telegram_id = ?
  `).bind(String(telegramId)).first();
}

async function ensureUser(env, data) {
  const telegramId = String(data.telegramId || "").trim();

  if (!telegramId) {
    throw httpError(400, "telegram_id is required");
  }

  let user = await getUserRow(env, telegramId);

  if (!user) {
    const now = nowIso();
    const referralCode = referralCodeForTelegramId(telegramId);

    await env.DB.prepare(`
      INSERT INTO users (
        telegram_id,
        username,
        first_name,
        wallet,
        balance,
        mined,
        mining_rate,
        level,
        referred_by,
        referral_code,
        referral_success,
        referral_success_at,
        referral_bonus_credited,
        referral_earnings,
        holding,
        holding_updated_at,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, 0, 0, ?, 1, '', ?, 0, '', 0, 0, NULL, '', ?, ?)
    `).bind(
      telegramId,
      String(data.username || ""),
      String(data.firstName || ""),
      String(data.wallet || ""),
      CONFIG.BASE_MINING_RATE,
      referralCode,
      now,
      now
    ).run();

    user = await getUserRow(env, telegramId);
  } else {
    await env.DB.prepare(`
      UPDATE users
      SET
        username = COALESCE(NULLIF(?, ''), username),
        first_name = COALESCE(NULLIF(?, ''), first_name),
        wallet = CASE WHEN ? <> '' THEN ? ELSE wallet END,
        updated_at = ?
      WHERE telegram_id = ?
    `).bind(
      String(data.username || ""),
      String(data.firstName || ""),
      String(data.wallet || ""),
      String(data.wallet || ""),
      nowIso(),
      telegramId
    ).run();

    user = await getUserRow(env, telegramId);
  }

  return user;
}

async function getReferralCount(env, telegramId) {
  const row = await env.DB.prepare(`
    SELECT COUNT(*) AS count
    FROM users
    WHERE referred_by = ?
  `).bind(String(telegramId)).first();

  return num(row?.count, 0);
}

async function getSuccessfulReferralCount(env, telegramId) {
  const row = await env.DB.prepare(`
    SELECT COUNT(*) AS count
    FROM users
    WHERE referred_by = ?
      AND referral_success = 1
  `).bind(String(telegramId)).first();

  return num(row?.count, 0);
}

async function getWithdrawalHistory(env, telegramId, limit = 10) {
  const safeLimit = clamp(Math.floor(num(limit, 10)), 1, 50);

  const result = await env.DB.prepare(`
    SELECT
      id,
      amount,
      fee,
      net_amount,
      status,
      tx_hash,
      error,
      created_at,
      updated_at
    FROM withdrawals
    WHERE telegram_id = ?
    ORDER BY id DESC
    LIMIT ${safeLimit}
  `).bind(String(telegramId)).all();

  return result.results || [];
}

async function serializeUser(env, user, options = {}) {
  if (!user) return null;

  const holding = num(user.holding, 0);
  const pool = num(user.balance, 0);
  const mined = num(user.mined, 0);

  const totalAssets = round8(pool + holding);
  const level = getLevelFromTotalAssets(totalAssets);
  const miningRate = miningRateForLevel(level);

  // Keep the server's level/rate authoritative.
  if (
    num(user.level, 1) !== level ||
    Math.abs(num(user.mining_rate, CONFIG.BASE_MINING_RATE) - miningRate) > 1e-9
  ) {
    await env.DB.prepare(`
      UPDATE users
      SET level = ?, mining_rate = ?, updated_at = ?
      WHERE telegram_id = ?
    `).bind(
      level,
      miningRate,
      nowIso(),
      user.telegram_id
    ).run();

    user = {
      ...user,
      level,
      mining_rate: miningRate
    };
  }

  const referralCount = await getReferralCount(env, user.telegram_id);
  const successfulReferrals = await getSuccessfulReferralCount(
    env,
    user.telegram_id
  );

  const withdrawalHistory = await getWithdrawalHistory(
    env,
    user.telegram_id,
    10
  );

  const nextRequired = getNextLevelRequired(level);
  const progress = getLevelProgress(totalAssets, level);
  const missing = getMissingForNextLevel(totalAssets, level);

  return {
    telegram_id: String(user.telegram_id),
    username: user.username || "",
    first_name: user.first_name || "",
    wallet: user.wallet || "",

    balance: round8(pool),
    pool: round8(pool),

    mined: round8(mined),

    holding: round8(holding),

    total_assets: totalAssets,
    totalBalance: totalAssets,

    level,
    mining_rate: miningRate,
    mining_rate_per_hour: miningRate,

    next_level: level >= CONFIG.MAX_LEVEL ? level : level + 1,
    next_level_required_lnr: nextRequired,
    level_progress: progress,
    level_missing_lnr: missing,

    referral_code: user.referral_code || referralCodeForTelegramId(user.telegram_id),
    referral_count: referralCount,
    successful_referrals: successfulReferrals,
    referral_earnings: round8(user.referral_earnings),
    referral_bonuses: round8(user.referral_bonus_credited),

    withdrawal_history: withdrawalHistory,

    treasury_address: CONFIG.TREASURY_ADDRESS,
    updated_at: user.updated_at || nowIso()
  };
}

/* =========================================================
   REFERRAL SYSTEM
   ========================================================= */

async function processReferralEntry(env, referredUserId, referralCode) {
  const code = String(referralCode || "").trim();

  if (!code) return;

  const user = await getUserRow(env, referredUserId);

  if (!user) return;

  // A successful/attached referral is immutable.
  if (user.referred_by) return;

  const referrer = await env.DB.prepare(`
    SELECT *
    FROM users
    WHERE referral_code = ?
  `).bind(code).first();

  if (!referrer) return;

  if (String(referrer.telegram_id) === String(referredUserId)) {
    return;
  }

  await env.DB.prepare(`
    UPDATE users
    SET referred_by = ?, updated_at = ?
    WHERE telegram_id = ?
      AND (referred_by IS NULL OR referred_by = '')
  `).bind(
    String(referrer.telegram_id),
    nowIso(),
    String(referredUserId)
  ).run();
}

async function processSuccessfulReferral(env, referredTelegramId) {
  const referred = await getUserRow(env, referredTelegramId);

  if (!referred) {
    return { credited: false, reason: "user_not_found" };
  }

  if (!referred.referred_by) {
    return { credited: false, reason: "no_referrer" };
  }

  if (num(referred.referral_success, 0) === 1) {
    return { credited: false, reason: "already_successful" };
  }

  const referrerId = String(referred.referred_by);

  const referrer = await getUserRow(env, referrerId);

  if (!referrer) {
    return { credited: false, reason: "referrer_not_found" };
  }

  // The ledger's UNIQUE referred_telegram_id makes this idempotent.
  const amount = CONFIG.REFERRAL_SUCCESS_BONUS;
  const now = nowIso();

  try {
    await env.DB.prepare(`
      INSERT INTO referral_bonus_ledger (
        referred_telegram_id,
        referrer_telegram_id,
        amount,
        created_at
      )
      VALUES (?, ?, ?, ?)
    `).bind(
      String(referredTelegramId),
      referrerId,
      amount,
      now
    ).run();
  } catch (error) {
    // If the row already exists, do not pay again.
    const existing = await env.DB.prepare(`
      SELECT id
      FROM referral_bonus_ledger
      WHERE referred_telegram_id = ?
    `).bind(String(referredTelegramId)).first();

    if (existing) {
      await env.DB.prepare(`
        UPDATE users
        SET referral_success = 1,
            referral_success_at = COALESCE(NULLIF(referral_success_at, ''), ?),
            updated_at = ?
        WHERE telegram_id = ?
      `).bind(now, now, String(referredTelegramId)).run();

      return { credited: false, reason: "already_ledgered" };
    }

    throw error;
  }

  await env.DB.batch([
    env.DB.prepare(`
      UPDATE users
      SET
        balance = balance + ?,
        referral_earnings = referral_earnings + ?,
        updated_at = ?
      WHERE telegram_id = ?
    `).bind(amount, amount, now, referrerId),

    env.DB.prepare(`
      UPDATE users
      SET
        referral_success = 1,
        referral_success_at = ?,
        referral_bonus_credited = referral_bonus_credited + ?,
        updated_at = ?
      WHERE telegram_id = ?
    `).bind(now, amount, now, String(referredTelegramId))
  ]);

  return {
    credited: true,
    amount,
    referrer_telegram_id: referrerId
  };
}

async function processReferralClaimReward(
  env,
  referredTelegramId,
  claimId,
  claimAmount
) {
  const referred = await getUserRow(env, referredTelegramId);

  if (!referred || !referred.referred_by) {
    return { credited: false, amount: 0 };
  }

  const referrerId = String(referred.referred_by);
  const reward = round8(
    nonNegative(claimAmount) * CONFIG.REFERRAL_CLAIM_PERCENT
  );

  if (reward <= 0) {
    return { credited: false, amount: 0 };
  }

  const key = claimKey(referredTelegramId, claimId);
  const now = nowIso();

  try {
    await env.DB.prepare(`
      INSERT INTO referral_claim_ledger (
        claim_key,
        referred_telegram_id,
        referrer_telegram_id,
        claim_amount,
        reward_amount,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(
      key,
      String(referredTelegramId),
      referrerId,
      nonNegative(claimAmount),
      reward,
      now
    ).run();
  } catch (error) {
    const existing = await env.DB.prepare(`
      SELECT id
      FROM referral_claim_ledger
      WHERE claim_key = ?
    `).bind(key).first();

    if (existing) {
      return { credited: false, amount: 0, reason: "already_ledgered" };
    }

    throw error;
  }

  await env.DB.batch([
    env.DB.prepare(`
      UPDATE users
      SET
        balance = balance + ?,
        referral_earnings = referral_earnings + ?,
        updated_at = ?
      WHERE telegram_id = ?
    `).bind(reward, reward, now, referrerId),

    env.DB.prepare(`
      UPDATE users
      SET updated_at = ?
      WHERE telegram_id = ?
    `).bind(now, String(referredTelegramId))
  ]);

  return {
    credited: true,
    amount: reward,
    referrer_telegram_id: referrerId
  };
}

/* =========================================================
   USER ENDPOINTS
   ========================================================= */

async function handleUserPost(request, env) {
  try {
    const body = await readJson(request);
    const identity = await requireTelegramIdentity(request, env, body);

    const telegramId = identity.telegramId;
    const wallet = String(body.wallet || "").trim();

    const user = await ensureUser(env, {
      telegramId,
      username: body.username || identity.telegramUser.username || "",
      firstName: body.first_name || identity.telegramUser.first_name || "",
      wallet
    });

    const referralCode = String(body.referral_code || "").trim();

    if (referralCode) {
      await processReferralEntry(env, telegramId, referralCode);
    }

    // "wallet_verified" is the successful referral event.
    if (
      String(body.referral_action || "").toLowerCase() === "wallet_verified" &&
      wallet
    ) {
      await processSuccessfulReferral(env, telegramId);
    }

    // Refresh holding from blockchain when a wallet is supplied.
    if (wallet) {
      await refreshHoldingIfNeeded(env, telegramId, wallet, true);
    }

    const fresh = await getUserRow(env, telegramId);
    const serialized = await serializeUser(env, fresh);

    return json({
      success: true,
      user: serialized
    });
  } catch (error) {
    return handleError(error);
  }
}

async function handleUserGet(request, env) {
  try {
    const url = new URL(request.url);
    const telegramId = String(
      url.searchParams.get("telegram_id") || ""
    ).trim();

    if (!telegramId) {
      throw httpError(400, "telegram_id is required");
    }

    const user = await getUserRow(env, telegramId);

    if (!user) {
      throw httpError(404, "User not found");
    }

    if (user.wallet) {
      await refreshHoldingIfNeeded(
        env,
        telegramId,
        user.wallet,
        false
      );
    }

    const fresh = await getUserRow(env, telegramId);

    return json({
      success: true,
      user: await serializeUser(env, fresh)
    });
  } catch (error) {
    return handleError(error);
  }
}

/* =========================================================
   MINING
   =========================================================
   Mining creates unclaimed "mined" LNR.
   It is NOT added to pool/Total Assets until Claim.
   */

async function handleMine(request, env) {
  try {
    const body = await readJson(request);
    const identity = await requireTelegramIdentity(request, env, body);

    const telegramId = identity.telegramId;
    const wallet = String(body.wallet || "").trim();

    if (!wallet) {
      throw httpError(400, "Wallet connection is required before mining");
    }

    const user = await ensureUser(env, {
      telegramId,
      username: body.username || identity.telegramUser.username || "",
      firstName: body.first_name || identity.telegramUser.first_name || "",
      wallet
    });

    // Save the wallet.
    await env.DB.prepare(`
      UPDATE users
      SET wallet = ?, updated_at = ?
      WHERE telegram_id = ?
    `).bind(wallet, nowIso(), telegramId).run();

    await refreshHoldingIfNeeded(env, telegramId, wallet, true);

    const current = await getUserRow(env, telegramId);

    // Level is determined by Total Assets = Pool + Holding.
    const totalAssets =
      nonNegative(current.balance) + nonNegative(current.holding);

    const level = getLevelFromTotalAssets(totalAssets);
    const rate = miningRateForLevel(level);

    const previousUpdated =
      Date.parse(current.updated_at || "") || Date.now();

    const elapsedSeconds = Math.max(
      0,
      Math.min(
        CONFIG.MAX_CATCHUP_HOURS * 3600,
        (Date.now() - previousUpdated) / 1000
      )
    );

    // The frontend calls /mine frequently. We accumulate elapsed time
    // between authoritative server updates.
    const minedAdded = round8(
      (elapsedSeconds / 3600) * rate
    );

    const now = nowIso();

    if (minedAdded > 0) {
      await env.DB.prepare(`
        UPDATE users
        SET
          mined = mined + ?,
          level = ?,
          mining_rate = ?,
          updated_at = ?
        WHERE telegram_id = ?
      `).bind(
        minedAdded,
        level,
        rate,
        now,
        telegramId
      ).run();
    } else {
      await env.DB.prepare(`
        UPDATE users
        SET
          level = ?,
          mining_rate = ?,
          updated_at = ?
        WHERE telegram_id = ?
      `).bind(level, rate, now, telegramId).run();
    }

    const fresh = await getUserRow(env, telegramId);

    return json({
      success: true,
      mined_added: minedAdded,
      user: await serializeUser(env, fresh)
    });
  } catch (error) {
    return handleError(error);
  }
}

/* =========================================================
   CLAIM
   =========================================================
   Claim transfers all currently mined/unclaimed LNR into Pool Wallet.
   Referral reward is exactly 10% of this actual claim.
   */

async function handleClaim(request, env) {
  try {
    const body = await readJson(request);
    const identity = await requireTelegramIdentity(request, env, body);

    const telegramId = identity.telegramId;
    const wallet = String(body.wallet || "").trim();

    if (!wallet) {
      throw httpError(400, "Wallet connection is required");
    }

    const user = await ensureUser(env, {
      telegramId,
      username: body.username || identity.telegramUser.username || "",
      firstName: body.first_name || identity.telegramUser.first_name || "",
      wallet
    });

    await refreshHoldingIfNeeded(env, telegramId, wallet, true);

    const current = await getUserRow(env, telegramId);
    const amount = round8(nonNegative(current.mined));

    if (amount <= 0) {
      throw httpError(400, "No mined LNR available to claim");
    }

    const now = nowIso();

    // Generate a deterministic-enough claim identifier before writing.
    const claimId = randomHex(24);
    const cKey = claimKey(telegramId, claimId);

    // Atomic-ish D1 transaction pattern:
    // condition the update on mined > 0 so a second request cannot
    // simply claim the same value after it has been zeroed.
    const updateResult = await env.DB.prepare(`
      UPDATE users
      SET
        balance = balance + mined,
        mined = 0,
        updated_at = ?
      WHERE telegram_id = ?
        AND mined > 0
    `).bind(now, telegramId).run();

    if (!updateResult.meta || updateResult.meta.changes !== 1) {
      throw httpError(
        409,
        "Claim changed before completion. Please try again."
      );
    }

    try {
      await env.DB.prepare(`
        INSERT INTO claims (
          telegram_id,
          wallet,
          amount,
          claim_key,
          created_at
        )
        VALUES (?, ?, ?, ?, ?)
      `).bind(
        telegramId,
        wallet,
        amount,
        cKey,
        now
      ).run();
    } catch (error) {
      // Restore the balance if the claim ledger write fails.
      await env.DB.prepare(`
        UPDATE users
        SET
          balance = MAX(0, balance - ?),
          mined = mined + ?,
          updated_at = ?
        WHERE telegram_id = ?
      `).bind(
        amount,
        amount,
        nowIso(),
        telegramId
      ).run();

      throw error;
    }

    const claimRow = await env.DB.prepare(`
      SELECT id
      FROM claims
      WHERE claim_key = ?
    `).bind(cKey).first();

    const referralReward = await processReferralClaimReward(
      env,
      telegramId,
      claimRow?.id || cKey,
      amount
    );

    const fresh = await getUserRow(env, telegramId);

    return json({
      success: true,
      claimed: amount,
      referral_reward_created: round8(referralReward.amount || 0),
      user: await serializeUser(env, fresh)
    });
  } catch (error) {
    return handleError(error);
  }
}

/* =========================================================
   WITHDRAWAL
   =========================================================
   User requests exactly 500 LNR.
   Fee = 70 LNR.
   Net payout = 430 LNR.
   The 500 LNR is removed from Pool Wallet immediately and a
   pending payout record is created.
   */

async function handleWithdraw(request, env) {
  try {
    const body = await readJson(request);
    const identity = await requireTelegramIdentity(request, env, body);

    const telegramId = identity.telegramId;
    const wallet = String(body.wallet || "").trim();
    const requestedAmount = num(body.amount, CONFIG.WITHDRAW_MIN);

    if (!wallet) {
      throw httpError(400, "Wallet is required");
    }

    if (requestedAmount !== CONFIG.WITHDRAW_MIN) {
      throw httpError(
        400,
        `Withdrawal amount must be exactly ${CONFIG.WITHDRAW_MIN} LNR`
      );
    }

    const user = await ensureUser(env, {
      telegramId,
      username: body.username || identity.telegramUser.username || "",
      firstName: body.first_name || identity.telegramUser.first_name || "",
      wallet
    });

    const current = await getUserRow(env, telegramId);
    const balance = nonNegative(current.balance);

    if (balance < CONFIG.WITHDRAW_MIN) {
      throw httpError(
        400,
        `Minimum withdrawal is ${CONFIG.WITHDRAW_MIN} LNR`
      );
    }

    // Prevent duplicate pending requests from the same user.
    const pending = await env.DB.prepare(`
      SELECT id
      FROM withdrawals
      WHERE telegram_id = ?
        AND status IN ('pending', 'processing')
      LIMIT 1
    `).bind(telegramId).first();

    if (pending) {
      throw httpError(
        409,
        "You already have a pending withdrawal"
      );
    }

    const now = nowIso();

    // Deduct the full 500 from Pool Wallet.
    const deducted = await env.DB.prepare(`
      UPDATE users
      SET
        balance = balance - ?,
        updated_at = ?
      WHERE telegram_id = ?
        AND balance >= ?
    `).bind(
      CONFIG.WITHDRAW_MIN,
      now,
      telegramId,
      CONFIG.WITHDRAW_MIN
    ).run();

    if (!deducted.meta || deducted.meta.changes !== 1) {
      throw httpError(
        409,
        "Withdrawal balance changed. Please try again."
      );
    }

    let withdrawalId;

    try {
      const inserted = await env.DB.prepare(`
        INSERT INTO withdrawals (
          telegram_id,
          wallet,
          amount,
          fee,
          net_amount,
          status,
          tx_hash,
          error,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, 'pending', '', '', ?, ?)
      `).bind(
        telegramId,
        wallet,
        CONFIG.WITHDRAW_MIN,
        CONFIG.WITHDRAW_FEE,
        CONFIG.WITHDRAW_NET,
        now,
        now
      ).run();

      withdrawalId = inserted.meta?.last_row_id || null;
    } catch (error) {
      // Refund the 500 if queue creation fails.
      await env.DB.prepare(`
        UPDATE users
        SET balance = balance + ?, updated_at = ?
        WHERE telegram_id = ?
      `).bind(
        CONFIG.WITHDRAW_MIN,
        nowIso(),
        telegramId
      ).run();

      throw error;
    }

    const fresh = await getUserRow(env, telegramId);

    return json({
      success: true,
      withdrawal_id: withdrawalId,
      amount: CONFIG.WITHDRAW_MIN,
      fee: CONFIG.WITHDRAW_FEE,
      net_amount: CONFIG.WITHDRAW_NET,
      status: "pending",
      treasury_address: CONFIG.TREASURY_ADDRESS,
      message:
        "Withdrawal queued. On-chain transfer must be completed by the secure payout worker.",
      user: await serializeUser(env, fresh)
    });
  } catch (error) {
    return handleError(error);
  }
}

async function handleWithdrawals(request, env) {
  try {
    const url = new URL(request.url);
    const telegramId = String(
      url.searchParams.get("telegram_id") || ""
    ).trim();

    if (!telegramId) {
      throw httpError(400, "telegram_id is required");
    }

    const rows = await getWithdrawalHistory(env, telegramId, 20);

    return json({
      success: true,
      withdrawals: rows
    });
  } catch (error) {
    return handleError(error);
  }
}

/* =========================================================
   MINERS / LEVELS
   =========================================================
   Backend source of truth for all 1000 levels.
   Past levels are not needed by the frontend.
   */

async function handleMiners(request, env) {
  try {
    const url = new URL(request.url);
    const telegramId = String(
      url.searchParams.get("telegram_id") || ""
    ).trim();

    let user = null;

    if (telegramId) {
      user = await getUserRow(env, telegramId);

      if (user?.wallet) {
        await refreshHoldingIfNeeded(
          env,
          telegramId,
          user.wallet,
          false
        );
        user = await getUserRow(env, telegramId);
      }
    }

    const pool = nonNegative(user?.balance);
    const holding = nonNegative(user?.holding);
    const totalAssets = round8(pool + holding);
    const currentLevel = getLevelFromTotalAssets(totalAssets);

    const start = currentLevel;
    const levels = [];

    for (let level = start; level <= CONFIG.MAX_LEVEL; level++) {
      const required = requiredLnrForLevel(level);
      const missing = Math.max(0, required - totalAssets);
      const unlocked = totalAssets >= required;
      const active = level === currentLevel;

      levels.push({
        level,
        required_lnr: required,
        approximate_usdt: null,
        missing_lnr: round8(missing),
        missing_usdt: null,
        mining_rate_per_hour: miningRateForLevel(level),
        status: active
          ? "active"
          : unlocked
          ? "unlocked"
          : "locked"
      });
    }

    const price = await getReferencePrice(env);

    for (const item of levels) {
      item.approximate_usdt = round8(item.required_lnr * price);
      item.missing_usdt = round8(item.missing_lnr * price);
    }

    return json({
      success: true,
      max_level: CONFIG.MAX_LEVEL,
      level_step_lnr: CONFIG.LEVEL_STEP_LNR,
      reference_price_usdt: price,
      total_assets: totalAssets,
      pool,
      holding,
      current_level: currentLevel,
      levels
    });
  } catch (error) {
    return handleError(error);
  }
}

/* =========================================================
   REFERRAL ENDPOINT
   ========================================================= */

async function handleReferral(request, env) {
  try {
    const url = new URL(request.url);
    const telegramId = String(
      url.searchParams.get("telegram_id") || ""
    ).trim();

    if (!telegramId) {
      throw httpError(400, "telegram_id is required");
    }

    const user = await getUserRow(env, telegramId);

    if (!user) {
      throw httpError(404, "User not found");
    }

    const referralCount = await getReferralCount(env, telegramId);
    const successful = await getSuccessfulReferralCount(env, telegramId);

    return json({
      success: true,
      referral_code: user.referral_code,
      referral_link:
        `https://t.me/${CONFIG.BOT_USERNAME}?start=${encodeURIComponent(
          user.referral_code
        )}`,
      referral_count: referralCount,
      successful_referrals: successful,
      successful_referral_reward: CONFIG.REFERRAL_SUCCESS_BONUS,
      claim_reward_percent: CONFIG.REFERRAL_CLAIM_PERCENT * 100,
      referral_earnings: round8(user.referral_earnings),
      referral_bonuses: round8(user.referral_bonus_credited)
    });
  } catch (error) {
    return handleError(error);
  }
}

/* =========================================================
   REFERENCE PRICE
   =========================================================
   Reference price is NOT the actual swap price.
   It is only for approximate USD/USDT display in Miners.
   */

async function getReferencePrice(env) {
  const row = await env.DB.prepare(`
    SELECT value
    FROM app_settings
    WHERE key = 'reference_lnr_usdt'
  `).first();

  const value = num(
    row?.value,
    num(env.REFERENCE_LNR_USDT, CONFIG.DEFAULT_REFERENCE_PRICE)
  );

  return value > 0 ? value : CONFIG.DEFAULT_REFERENCE_PRICE;
}

async function handleGetPrice(env) {
  const price = await getReferencePrice(env);

  return json({
    success: true,
    symbol: "LNR",
    reference_price_usdt: price,
    source: "reference_price",
    note:
      "This is a reference display price, not a guaranteed swap execution price."
  });
}

async function handleAdminPrice(request, env) {
  try {
    requireAdmin(request, env);

    const body = await readJson(request);
    const price = num(body.price_usdt, 0);
    const source = String(body.source || "admin").slice(0, 80);

    if (!(price > 0)) {
      throw httpError(400, "price_usdt must be greater than zero");
    }

    const now = nowIso();

    await env.DB.batch([
      env.DB.prepare(`
        INSERT INTO app_settings(key, value, updated_at)
        VALUES ('reference_lnr_usdt', ?, ?)
        ON CONFLICT(key)
        DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `).bind(String(price), now),

      env.DB.prepare(`
        INSERT INTO price_history(price_usdt, source, created_at)
        VALUES (?, ?, ?)
      `).bind(price, source, now)
    ]);

    return json({
      success: true,
      reference_price_usdt: price,
      source
    });
  } catch (error) {
    return handleError(error);
  }
}

/* =========================================================
   HOLDING WALLET
   =========================================================
   Reads the LNR Jetton balance of the connected user's wallet.

   This is deliberately separate from Pool Wallet.
   Holding Wallet is NOT deducted when a level unlocks.
   It only proves the user holds enough LNR.

   Required env:
     LNR_JETTON_MASTER
     TONAPI_BASE (optional, defaults to https://tonapi.io)
     TONAPI_KEY  (optional)
   */

async function refreshHoldingIfNeeded(
  env,
  telegramId,
  wallet,
  force = false
) {
  const user = await getUserRow(env, telegramId);

  if (!user || !wallet) return 0;

  const last = Date.parse(user.holding_updated_at || "");
  const ageSeconds = last
    ? (Date.now() - last) / 1000
    : Infinity;

  if (
    !force &&
    Number.isFinite(ageSeconds) &&
    ageSeconds < CONFIG.HOLDING_CACHE_SECONDS
  ) {
    return nonNegative(user.holding);
  }

  const balance = await fetchLnrHoldingBalance(env, wallet);

  await env.DB.prepare(`
    UPDATE users
    SET
      holding = ?,
      holding_updated_at = ?,
      updated_at = ?
    WHERE telegram_id = ?
  `).bind(
    round8(balance),
    nowIso(),
    nowIso(),
    telegramId
  ).run();

  return balance;
}

async function fetchLnrHoldingBalance(env, ownerAddress) {
  const jettonMaster = String(env.LNR_JETTON_MASTER || "").trim();

  if (!jettonMaster) {
    // Until the real Mainnet LNR Jetton Master is configured,
    // return the cached value rather than inventing a blockchain balance.
    return 0;
  }

  const base = String(
    env.TONAPI_BASE || "https://tonapi.io"
  ).replace(/\/+$/, "");

  const endpoint =
    `${base}/v2/accounts/${encodeURIComponent(ownerAddress)}/jettons`;

  const headers = {
    Accept: "application/json"
  };

  if (env.TONAPI_KEY) {
    headers.Authorization = `Bearer ${env.TONAPI_KEY}`;
  }

  const response = await fetch(endpoint, {
    method: "GET",
    headers
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    console.error(
      "TONAPI holding error",
      response.status,
      text.slice(0, 500)
    );

    // Do not overwrite a previously known holding balance with zero
    // when the provider is temporarily unavailable.
    throw httpError(
      502,
      "Holding Wallet provider is temporarily unavailable"
    );
  }

  const data = await response.json();

  const item = findJettonByMaster(data, jettonMaster);

  if (!item) {
    return 0;
  }

  const rawBalance =
    item.balance ??
    item.amount ??
    item.raw_balance ??
    item.rawBalance ??
    0;

  const decimals =
    num(
      item.jetton?.decimals ??
      item.jetton_info?.decimals ??
      item.decimals,
      9
    );

  return round8(
    nonNegative(rawBalance) / Math.pow(10, clamp(decimals, 0, 18))
  );
}

function findJettonByMaster(data, masterAddress) {
  const list =
    Array.isArray(data?.balances)
      ? data.balances
      : Array.isArray(data?.jettons)
      ? data.jettons
      : Array.isArray(data?.items)
      ? data.items
      : [];

  const target = normalizeAddress(masterAddress);

  return (
    list.find(item => {
      const candidates = [
        item.jetton?.address,
        item.jetton?.master,
        item.jetton_info?.address,
        item.jetton_info?.master,
        item.address,
        item.master
      ].filter(Boolean);

      return candidates.some(
        address => normalizeAddress(address) === target
      );
    }) || null
  );
}

function normalizeAddress(address) {
  return String(address || "")
    .trim()
    .replace(/^0x/i, "")
    .toLowerCase();
}

async function handleAdminHoldingRefresh(request, env) {
  try {
    requireAdmin(request, env);

    const body = await readJson(request);
    const telegramId = String(body.telegram_id || "").trim();

    if (!telegramId) {
      throw httpError(400, "telegram_id is required");
    }

    const user = await getUserRow(env, telegramId);

    if (!user || !user.wallet) {
      throw httpError(404, "User or wallet not found");
    }

    const holding = await refreshHoldingIfNeeded(
      env,
      telegramId,
      user.wallet,
      true
    );

    const fresh = await getUserRow(env, telegramId);

    return json({
      success: true,
      holding,
      user: await serializeUser(env, fresh)
    });
  } catch (error) {
    return handleError(error);
  }
}

/* =========================================================
   ADMIN AUTH
   ========================================================= */

function requireAdmin(request, env) {
  const configured = String(env.ADMIN_SECRET || "").trim();

  if (!configured) {
    throw httpError(
      503,
      "ADMIN_SECRET is not configured"
    );
  }

  const supplied = String(
    request.headers.get("X-Admin-Secret") || ""
  );

  if (!timingSafeEqual(supplied, configured)) {
    throw httpError(403, "Forbidden");
  }
}

async function handleAdminWithdrawals(request, env) {
  try {
    requireAdmin(request, env);

    const url = new URL(request.url);
    const status = String(
      url.searchParams.get("status") || ""
    ).trim();

    const limit = clamp(
      Math.floor(num(url.searchParams.get("limit"), 50)),
      1,
      200
    );

    let result;

    if (status) {
      result = await env.DB.prepare(`
        SELECT *
        FROM withdrawals
        WHERE status = ?
        ORDER BY id ASC
        LIMIT ${limit}
      `).bind(status).all();
    } else {
      result = await env.DB.prepare(`
        SELECT *
        FROM withdrawals
        ORDER BY id ASC
        LIMIT ${limit}
      `).all();
    }

    return json({
      success: true,
      withdrawals: result.results || []
    });
  } catch (error) {
    return handleError(error);
  }
}

/* =========================================================
   OPTIONAL ADMIN HELPERS FOR PAYOUT SERVICE
   =========================================================
   The following functions are not public HTTP routes yet.
   A secure payout service can call D1 directly or a future
   protected route to:
     1. take pending withdrawal
     2. send 430 LNR from treasury
     3. write tx_hash
     4. set status = paid

   We intentionally do not implement private-key signing here.
   ========================================================= */

export async function markWithdrawalPaid(env, withdrawalId, txHash) {
  const id = num(withdrawalId, 0);
  const hash = String(txHash || "").trim();

  if (!id || !hash) {
    throw new Error("withdrawalId and txHash are required");
  }

  const now = nowIso();

  await env.DB.prepare(`
    UPDATE withdrawals
    SET
      status = 'paid',
      tx_hash = ?,
      error = '',
      updated_at = ?
    WHERE id = ?
      AND status IN ('pending', 'processing')
  `).bind(hash, now, id).run();

  return true;
}

export async function markWithdrawalFailed(
  env,
  withdrawalId,
  errorMessage
) {
  const id = num(withdrawalId, 0);
  const message = String(errorMessage || "Payout failed").slice(0, 1000);

  if (!id) {
    throw new Error("withdrawalId is required");
  }

  const now = nowIso();

  const withdrawal = await env.DB.prepare(`
    SELECT telegram_id, amount
    FROM withdrawals
    WHERE id = ?
      AND status IN ('pending', 'processing')
  `).bind(id).first();

  if (!withdrawal) {
    return false;
  }

  // Refund the full 500 to Pool Wallet when a queued payout fails.
  await env.DB.batch([
    env.DB.prepare(`
      UPDATE users
      SET balance = balance + ?, updated_at = ?
      WHERE telegram_id = ?
    `).bind(
      CONFIG.WITHDRAW_MIN,
      now,
      withdrawal.telegram_id
    ),

    env.DB.prepare(`
      UPDATE withdrawals
      SET
        status = 'failed',
        error = ?,
        updated_at = ?
      WHERE id = ?
    `).bind(message, now, id)
  ]);

  return true;
}

/* =========================================================
   DAILY TASK SUPPORT
   =========================================================
   The current frontend's Daily Task is local-only in the supplied
   reference UI. This endpoint is included so it can later become
   server-authoritative without changing the database design.
   */

export async function claimDailyTask(env, telegramId) {
  const id = String(telegramId || "").trim();

  if (!id) {
    throw new Error("telegramId required");
  }

  const today = new Date().toISOString().slice(0, 10);
  const reward = 3;
  const now = nowIso();

  try {
    await env.DB.prepare(`
      INSERT INTO daily_tasks(
        telegram_id,
        task_date,
        reward,
        created_at
      )
      VALUES (?, ?, ?, ?)
    `).bind(id, today, reward, now).run();
  } catch {
    return {
      success: false,
      reason: "already_claimed"
    };
  }

  await env.DB.prepare(`
    UPDATE users
    SET balance = balance + ?, updated_at = ?
    WHERE telegram_id = ?
  `).bind(reward, now, id).run();

  return {
    success: true,
    reward
  };
}

/* =========================================================
   SWAP DESIGN
   =========================================================
   The current frontend has a Swap placeholder.

   Important distinction:
   - Reference price: used only for approximate USDT display.
   - Actual swap price: comes from the live DEX quote.
   - Required LNR for a level never changes because of USD price.
   - If a user swaps USDT -> LNR, the resulting LNR must arrive in
     the user's Holding Wallet. The blockchain holding reader above
     then sees it.
   - When Holding + Pool reaches the next level requirement, the
     backend automatically reports the level as unlocked.

   No fake swap is performed by this Worker.
   A production swap should use TON Connect + a real DEX router
   (for example STON.fi) from the frontend, with the user's wallet
   signing the transaction.
   ========================================================= */

/* =========================================================
   LEVEL EXAMPLES
   =========================================================
   Level 1     = 0 LNR
   Level 2     = 500 LNR
   Level 3     = 1,000 LNR
   Level 4     = 1,500 LNR
   Level 5     = 2,000 LNR
   Level 10    = 4,500 LNR
   Level 100   = 49,500 LNR
   Level 500   = 249,500 LNR
   Level 1000  = 499,500 LNR

   This is deliberately linear:
     required = (level - 1) * 500
   ========================================================= */

/* =========================================================
   SECURITY NOTES
   =========================================================
   1. Never trust balance, mined, level or holding values sent by
      the browser.
   2. Holding must come from the blockchain provider.
   3. Pool balance must come from D1.
   4. Mined balance must be server-side.
   5. Referral rewards are ledgered and idempotent.
   6. Withdrawal requests are ledgered and idempotent.
   7. Telegram initData should be enforced in production.
   8. Treasury private key must never be exposed to the frontend.
   9. A separate payout signer/service is required for actual
      on-chain LNR withdrawals.
   10. Reference price must not be presented as a guaranteed
       execution price.
   ========================================================= */
