/**
 * LUNARO / LNR — Worker API
 * Index-compatible backend
 *
 * IMPORTANT:
 * - Put secrets in Cloudflare Worker Variables/Secrets, NOT in index.html.
 * - Required D1 binding: DB
 * - Optional secrets/config:
 *   TELEGRAM_BOT_TOKEN
 *   TONAPI_KEY
 *   LNR_JETTON_MASTER
 *   TONAPI_BASE
 *   REFERENCE_PRICE_USDT
 *   ALLOW_UNVERIFIED_REQUESTS ("true" only for local testing)
 *
 * Frontend contract taken from the supplied LUNARO Index:
 * POST /user
 * POST /mine
 * POST /claim
 * POST /withdraw
 *
 * Additional backend endpoints:
 * GET  /health
 * GET  /config
 * GET  /price
 * GET  /miners
 * GET  /referral
 * GET  /withdrawals
 * POST /task
 *
 * Level rule:
 * Level 1 = 0 LNR
 * Required LNR = (level - 1) * 500
 * Level 1000 = 499,500 LNR
 *
 * Mining:
 * - Unclaimed mining never increases balance until /claim.
 * - Pool balance is the claimable/account balance.
 * - Total Assets = pool balance + on-chain holding.
 *
 * Withdrawal:
 * - Request = 500 LNR
 * - Fee = 70 LNR
 * - Net payout = 430 LNR
 *
 * Referral:
 * - A referred user is attached once.
 * - Successful referral occurs when the referred user verifies a wallet.
 * - Referrer gets 500 LNR once.
 * - Referrer gets 10% of each referred user's successful claim once per claim.
 *
 * NOTE:
 * Actual on-chain payout is deliberately NOT performed by this Worker unless
 * a separate secure signer/relayer is implemented. /withdraw creates a queue.
 */

const CONFIG = {
  BOT_USERNAME: "LunaroGameBot",
  API_VERSION: "lunaro-worker-index-compatible-v1",

  MAX_LEVEL: 1000,
  LEVEL_STEP_LNR: 500,

  BASE_MINING_RATE: 0.70,
  MINING_RATE_STEP: 0.05,

  WITHDRAW_AMOUNT: 500,
  WITHDRAW_FEE: 70,
  WITHDRAW_NET: 430,

  REFERRAL_SUCCESS_BONUS: 500,
  REFERRAL_CLAIM_PERCENT: 0.10,

  DEFAULT_REFERENCE_PRICE: 0.0008,

  TONAPI_BASE: "https://tonapi.io",
  TONAPI_TIMEOUT_MS: 8000,
};

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin") || "*";

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(origin),
      });
    }

    try {
      await ensureSchema(env);

      const url = new URL(request.url);
      const path = normalizePath(url.pathname);

      if (request.method === "GET" && path === "/health") {
        return json({
          success: true,
          service: "LUNARO API",
          version: CONFIG.API_VERSION,
          time: new Date().toISOString(),
        }, 200, origin);
      }

      if (request.method === "GET" && path === "/config") {
        return json({
          success: true,
          bot_username: CONFIG.BOT_USERNAME,
          max_level: CONFIG.MAX_LEVEL,
          level_step_lnr: CONFIG.LEVEL_STEP_LNR,
          withdrawal_min: CONFIG.WITHDRAW_AMOUNT,
          withdrawal_fee: CONFIG.WITHDRAW_FEE,
          withdrawal_net: CONFIG.WITHDRAW_NET,
          referral_success_bonus: CONFIG.REFERRAL_SUCCESS_BONUS,
          referral_claim_percent: CONFIG.REFERRAL_CLAIM_PERCENT,
        }, 200, origin);
      }

      if (request.method === "GET" && path === "/price") {
        const price = await getReferencePrice(env);
        return json({
          success: true,
          reference_price_usdt: price,
          source: env.REFERENCE_PRICE_USDT ? "worker_config" : "preview_default",
        }, 200, origin);
      }

      if (request.method === "GET" && path === "/miners") {
        const price = await getReferencePrice(env);
        return json({
          success: true,
          max_level: CONFIG.MAX_LEVEL,
          level_step_lnr: CONFIG.LEVEL_STEP_LNR,
          reference_price_usdt: price,
          levels: Array.from(
            { length: CONFIG.MAX_LEVEL },
            (_, i) => {
              const level = i + 1;
              return {
                level,
                required_lnr: requiredLnr(level),
                mining_rate: miningRate(level),
              };
            }
          ),
        }, 200, origin);
      }

      const body = await readJson(request);

      // Optional Telegram validation. The current supplied Index does not send
      // initData to these endpoints, so validation stays opt-in.
      if (shouldVerifyTelegram(env, path)) {
        const initData = request.headers.get("X-Telegram-Init-Data") || body.telegram_init_data || "";
        const verified = await verifyTelegramInitData(initData, env.TELEGRAM_BOT_TOKEN);
        if (!verified.ok) {
          return json({ success: false, error: verified.error }, 401, origin);
        }
        body.__telegram_user = verified.user;
      }

      if (request.method === "POST" && path === "/user") {
        return handleUser(body, env, origin);
      }

      if (request.method === "POST" && path === "/mine") {
        return handleMine(body, env, origin);
      }

      if (request.method === "POST" && path === "/claim") {
        return handleClaim(body, env, origin);
      }

      if (request.method === "POST" && path === "/withdraw") {
        return handleWithdraw(body, env, origin);
      }

      if (request.method === "POST" && path === "/task") {
        return handleTask(body, env, origin);
      }

      if (request.method === "GET" && path === "/referral") {
        return handleReferralGet(url, env, origin);
      }

      if (request.method === "GET" && path === "/withdrawals") {
        return handleWithdrawalsGet(url, env, origin);
      }

      return json({
        success: false,
        error: "Endpoint not found",
        path,
      }, 404, origin);

    } catch (error) {
      console.error("LUNARO Worker error", error);
      return json({
        success: false,
        error: safeError(error),
      }, 500, origin);
    }
  },
};

/* -------------------------------------------------------------------------- */
/* HTTP helpers                                                               */
/* -------------------------------------------------------------------------- */

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin === "null" ? "*" : origin,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Telegram-Init-Data",
    "Access-Control-Max-Age": "86400",
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  };
}

function json(data, status = 200, origin = "*") {
  return new Response(JSON.stringify(data), {
    status,
    headers: corsHeaders(origin),
  });
}

function normalizePath(pathname) {
  const p = String(pathname || "/").replace(/\/+/g, "/");
  if (p.length > 1 && p.endsWith("/")) return p.slice(0, -1);
  return p;
}

async function readJson(request) {
  if (!request.body) return {};
  const text = await request.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Invalid JSON body");
  }
}

function safeError(error) {
  const msg = String(error?.message || error || "Internal server error");
  return msg.length > 500 ? msg.slice(0, 500) : msg;
}

function telegramIdOf(body) {
  const id = body?.telegram_id ?? body?.__telegram_user?.id ?? "";
  return String(id).trim();
}

function walletOf(body) {
  return String(body?.wallet || "").trim();
}

function validTelegramId(id) {
  return id.length > 0 && id.length <= 64;
}

function validWallet(wallet) {
  return wallet.length >= 20 && wallet.length <= 150;
}

function nowIso() {
  return new Date().toISOString();
}

function shouldVerifyTelegram(env, path) {
  if (String(env.ALLOW_UNVERIFIED_REQUESTS || "").toLowerCase() === "true") return false;
  return Boolean(env.TELEGRAM_BOT_TOKEN);
}

/* -------------------------------------------------------------------------- */
/* Level / mining rules                                                       */
/* -------------------------------------------------------------------------- */

function requiredLnr(level) {
  const n = Math.max(1, Math.min(CONFIG.MAX_LEVEL, Math.floor(Number(level) || 1)));
  return n <= 1 ? 0 : (n - 1) * CONFIG.LEVEL_STEP_LNR;
}

function miningRate(level) {
  const n = Math.max(1, Math.min(CONFIG.MAX_LEVEL, Math.floor(Number(level) || 1)));
  return CONFIG.BASE_MINING_RATE + (n - 1) * CONFIG.MINING_RATE_STEP;
}

function calculateLevel(totalAssets) {
  const assets = Math.max(0, Number(totalAssets) || 0);
  let level = 1;

  for (let i = 2; i <= CONFIG.MAX_LEVEL; i++) {
    if (assets >= requiredLnr(i)) level = i;
    else break;
  }

  return level;
}

function levelProgress(totalAssets, currentLevel) {
  const level = Math.max(1, Math.min(CONFIG.MAX_LEVEL, Number(currentLevel) || 1));
  if (level >= CONFIG.MAX_LEVEL) return 100;

  const nextRequired = requiredLnr(level + 1);
  if (nextRequired <= 0) return 0;

  return Math.min(100, Math.max(0, (Number(totalAssets || 0) / nextRequired) * 100));
}

/* -------------------------------------------------------------------------- */
/* D1 schema                                                                 */
/* -------------------------------------------------------------------------- */

async function ensureSchema(env) {
  if (!env.DB) throw new Error("D1 binding DB is missing");

  await env.DB.batch([
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS users (
        telegram_id TEXT PRIMARY KEY,
        username TEXT DEFAULT '',
        first_name TEXT DEFAULT '',
        wallet TEXT DEFAULT '',
        balance REAL NOT NULL DEFAULT 0,
        mined REAL NOT NULL DEFAULT 0,
        last_mined_at TEXT,
        level INTEGER NOT NULL DEFAULT 1,
        mining_rate REAL NOT NULL DEFAULT 0.7,
        referral_code TEXT UNIQUE,
        referred_by TEXT DEFAULT '',
        referral_success INTEGER NOT NULL DEFAULT 0,
        referral_success_at TEXT,
        referral_bonus_credited REAL NOT NULL DEFAULT 0,
        referral_earnings REAL NOT NULL DEFAULT 0,
        holding REAL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `),
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS claims (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_id TEXT NOT NULL,
        wallet TEXT DEFAULT '',
        amount REAL NOT NULL,
        claim_key TEXT UNIQUE,
        created_at TEXT NOT NULL
      )
    `),
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS referral_bonus_ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        referred_telegram_id TEXT NOT NULL UNIQUE,
        referrer_telegram_id TEXT NOT NULL,
        amount REAL NOT NULL,
        created_at TEXT NOT NULL
      )
    `),
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS referral_claim_ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        claim_key TEXT NOT NULL UNIQUE,
        referred_telegram_id TEXT NOT NULL,
        referrer_telegram_id TEXT NOT NULL,
        amount REAL NOT NULL,
        created_at TEXT NOT NULL
      )
    `),
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS withdrawals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_id TEXT NOT NULL,
        wallet TEXT NOT NULL,
        requested_amount REAL NOT NULL,
        fee REAL NOT NULL,
        net_amount REAL NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        tx_hash TEXT DEFAULT '',
        error TEXT DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `),
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS daily_tasks (
        telegram_id TEXT NOT NULL,
        task_key TEXT NOT NULL,
        claim_date TEXT NOT NULL,
        reward REAL NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (telegram_id, task_key, claim_date)
      )
    `),
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS app_settings (
        setting_key TEXT PRIMARY KEY,
        setting_value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `),
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS price_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        price_usdt REAL NOT NULL,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `),
  ]);

  // Safe migrations for older D1 installations.
  const migrations = [
    `ALTER TABLE users ADD COLUMN referred_by TEXT DEFAULT ''`,
    `ALTER TABLE users ADD COLUMN referral_success INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN referral_success_at TEXT`,
    `ALTER TABLE users ADD COLUMN referral_bonus_credited REAL NOT NULL DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN referral_earnings REAL NOT NULL DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN holding REAL`,
    `ALTER TABLE users ADD COLUMN last_mined_at TEXT`,
    `ALTER TABLE users ADD COLUMN mining_rate REAL NOT NULL DEFAULT 0.7`,
    `ALTER TABLE users ADD COLUMN referral_code TEXT`,
    `ALTER TABLE users ADD COLUMN level INTEGER NOT NULL DEFAULT 1`,
    `ALTER TABLE users ADD COLUMN balance REAL NOT NULL DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN mined REAL NOT NULL DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN wallet TEXT DEFAULT ''`,
    `ALTER TABLE users ADD COLUMN username TEXT DEFAULT ''`,
    `ALTER TABLE users ADD COLUMN first_name TEXT DEFAULT ''`,
    `ALTER TABLE users ADD COLUMN updated_at TEXT`,
  ];

  for (const sql of migrations) {
    try {
      await env.DB.prepare(sql).run();
    } catch {
      // Column already exists or migration is not applicable.
    }
  }

  try {
    await env.DB.prepare(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_referral_code ON users(referral_code)`
    ).run();
  } catch {}

  try {
    await env.DB.prepare(
      `CREATE INDEX IF NOT EXISTS idx_withdrawals_user ON withdrawals(telegram_id, created_at DESC)`
    ).run();
  } catch {}

  try {
    await env.DB.prepare(
      `CREATE INDEX IF NOT EXISTS idx_claims_user ON claims(telegram_id, created_at DESC)`
    ).run();
  } catch {}
}

/* -------------------------------------------------------------------------- */
/* User creation / serialization                                             */
/* -------------------------------------------------------------------------- */

async function findUser(env, telegramId) {
  return env.DB.prepare(
    `SELECT * FROM users WHERE telegram_id = ?`
  ).bind(telegramId).first();
}

async function ensureUser(env, telegramId, username = "", firstName = "") {
  const id = String(telegramId);
  let user = await findUser(env, id);

  if (user) {
    return user;
  }

  const now = nowIso();
  const code = await generateReferralCode(env, id);

  await env.DB.prepare(`
    INSERT INTO users (
      telegram_id, username, first_name, wallet,
      balance, mined, last_mined_at, level, mining_rate,
      referral_code, referred_by, referral_success,
      referral_bonus_credited, referral_earnings,
      holding, created_at, updated_at
    )
    VALUES (?, ?, ?, '', 0, 0, ?, 1, ?, ?, '', 0, 0, 0, NULL, ?, ?)
  `).bind(
    id,
    String(username || "").slice(0, 100),
    String(firstName || "").slice(0, 150),
    now,
    miningRate(1),
    code,
    now,
    now
  ).run();

  user = await findUser(env, id);
  if (!user) throw new Error("Could not create user");
  return user;
}

async function generateReferralCode(env, telegramId) {
  const raw = String(telegramId);
  const tail = raw.replace(/\D/g, "").slice(-8).padStart(8, "0");
  let code = `LNR${tail}`;

  const existing = await env.DB.prepare(
    `SELECT telegram_id FROM users WHERE referral_code = ?`
  ).bind(code).first();

  if (!existing || String(existing.telegram_id) === raw) {
    return code;
  }

  const randomPart = crypto.randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();
  return `LNR${randomPart}`;
}

async function userPayload(env, user) {
  const fresh = await findUser(env, String(user.telegram_id));
  const u = fresh || user;

  const totalAssets = Number(u.balance || 0) + (Number.isFinite(Number(u.holding)) ? Number(u.holding) : 0);
  const level = calculateLevel(totalAssets);
  const rate = miningRate(level);

  // Keep server's derived level/rate authoritative.
  if (Number(u.level) !== level || Number(u.mining_rate) !== rate) {
    try {
      await env.DB.prepare(`
        UPDATE users
        SET level = ?, mining_rate = ?, updated_at = ?
        WHERE telegram_id = ?
      `).bind(level, rate, nowIso(), String(u.telegram_id)).run();
    } catch {}
  }

  const referralCount = await scalar(
    env.DB,
    `SELECT COUNT(*) AS n FROM users WHERE referred_by = ?`,
    [String(u.telegram_id)]
  );

  const successfulReferrals = await scalar(
    env.DB,
    `SELECT COUNT(*) AS n FROM users WHERE referred_by = ? AND referral_success = 1`,
    [String(u.telegram_id)]
  );

  const withdrawalHistory = await env.DB.prepare(`
    SELECT id, wallet, requested_amount AS amount, fee, net_amount,
           status, tx_hash, error, created_at, updated_at
    FROM withdrawals
    WHERE telegram_id = ?
    ORDER BY id DESC
    LIMIT 20
  `).bind(String(u.telegram_id)).all();

  return {
    telegram_id: String(u.telegram_id),
    username: u.username || "",
    first_name: u.first_name || "",
    wallet: u.wallet || "",
    balance: Number(u.balance || 0),
    mined: Number(u.mined || 0),
    level,
    mining_rate: rate,
    holding: Number.isFinite(Number(u.holding)) ? Number(u.holding) : null,

    referral_code: u.referral_code || "",
    referral_count: Number(referralCount || 0),
    successful_referrals: Number(successfulReferrals || 0),
    referral_earnings: Number(u.referral_earnings || 0),
    referral_bonuses: Number(u.referral_bonus_credited || 0),

    total_assets: totalAssets,
    level_progress: levelProgress(totalAssets, level),

    withdrawal_history: withdrawalHistory.results || [],
  };
}

/* -------------------------------------------------------------------------- */
/* /user                                                                      */
/* -------------------------------------------------------------------------- */

async function handleUser(body, env, origin) {
  const telegramId = telegramIdOf(body);
  if (!validTelegramId(telegramId)) {
    return json({ success: false, error: "telegram_id is required" }, 400, origin);
  }

  const username = String(body.username || "").slice(0, 100);
  const firstName = String(body.first_name || "").slice(0, 150);
  const wallet = walletOf(body);
  const referralCode = String(body.referral_code || "").trim();
  const referralAction = String(body.referral_action || "enter").trim();

  const user = await ensureUser(env, telegramId, username, firstName);

  await env.DB.prepare(`
    UPDATE users
    SET username = ?, first_name = ?,
        wallet = CASE WHEN ? <> '' THEN ? ELSE wallet END,
        updated_at = ?
    WHERE telegram_id = ?
  `).bind(
    username,
    firstName,
    wallet,
    wallet,
    nowIso(),
    telegramId
  ).run();

  if (referralCode) {
    await processReferralEntry(env, telegramId, referralCode);
  }

  if (referralAction === "wallet_verified" && wallet) {
    await processSuccessfulReferral(env, telegramId, wallet);
  }

  const result = await userPayload(env, await findUser(env, telegramId));

  return json({ success: true, user: result }, 200, origin);
}

/* -------------------------------------------------------------------------- */
/* /mine                                                                      */
/* -------------------------------------------------------------------------- */

async function handleMine(body, env, origin) {
  const telegramId = telegramIdOf(body);
  const wallet = walletOf(body);

  if (!validTelegramId(telegramId)) {
    return json({ success: false, error: "telegram_id is required" }, 400, origin);
  }

  if (!validWallet(wallet)) {
    return json({ success: false, error: "Valid TON wallet is required before mining" }, 400, origin);
  }

  let user = await ensureUser(env, telegramId, body.username || "", body.first_name || "");

  const now = Date.now();
  const last = user.last_mined_at ? Date.parse(user.last_mined_at) : now;

  // Prevent negative/absurd time jumps.
  const elapsedMs = Math.max(0, Math.min(now - last, 24 * 60 * 60 * 1000));
  const elapsedHours = elapsedMs / 3600000;

  // Level/rate are based on already claimed pool + holding.
  const totalAssets =
    Number(user.balance || 0) +
    (Number.isFinite(Number(user.holding)) ? Number(user.holding) : 0);

  const level = calculateLevel(totalAssets);
  const rate = miningRate(level);

  const minedAdd = elapsedHours * rate;
  const newMined = Number(user.mined || 0) + minedAdd;
  const iso = new Date(now).toISOString();

  await env.DB.prepare(`
    UPDATE users
    SET wallet = ?,
        mined = ?,
        last_mined_at = ?,
        level = ?,
        mining_rate = ?,
        updated_at = ?
    WHERE telegram_id = ?
  `).bind(
    wallet,
    newMined,
    iso,
    level,
    rate,
    iso,
    telegramId
  ).run();

  user = await findUser(env, telegramId);
  const payload = await userPayload(env, user);

  return json({
    success: true,
    mined_added: minedAdd,
    user: payload,
  }, 200, origin);
}

/* -------------------------------------------------------------------------- */
/* /claim                                                                     */
/* -------------------------------------------------------------------------- */

async function handleClaim(body, env, origin) {
  const telegramId = telegramIdOf(body);
  const wallet = walletOf(body);

  if (!validTelegramId(telegramId)) {
    return json({ success: false, error: "telegram_id is required" }, 400, origin);
  }

  if (!validWallet(wallet)) {
    return json({ success: false, error: "Valid TON wallet is required" }, 400, origin);
  }

  const user = await ensureUser(env, telegramId, "", "");

  // First settle mining to server time so the claim is not based on a stale value.
  const settled = await settleMining(env, user, wallet);
  const current = await findUser(env, telegramId);
  const claimAmount = Number(current?.mined || 0);

  if (claimAmount <= 0) {
    return json({
      success: false,
      error: "No mined LNR available to claim",
      user: await userPayload(env, current),
    }, 400, origin);
  }

  const claimKey = `claim:${telegramId}:${Date.now()}:${crypto.randomUUID()}`;
  const now = nowIso();

  // Atomic-ish D1 transaction batch: zero mined + add balance + ledger.
  await env.DB.batch([
    env.DB.prepare(`
      UPDATE users
      SET balance = balance + ?,
          mined = 0,
          wallet = ?,
          last_mined_at = ?,
          updated_at = ?
      WHERE telegram_id = ? AND mined > 0
    `).bind(claimAmount, wallet, now, now, telegramId),

    env.DB.prepare(`
      INSERT INTO claims (telegram_id, wallet, amount, claim_key, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).bind(telegramId, wallet, claimAmount, claimKey, now),
  ]);

  await processClaimReferralReward(env, telegramId, claimAmount, claimKey);

  const updated = await findUser(env, telegramId);

  return json({
    success: true,
    claimed: claimAmount,
    user: await userPayload(env, updated),
  }, 200, origin);
}

/* -------------------------------------------------------------------------- */
/* /withdraw                                                                  */
/* -------------------------------------------------------------------------- */

async function handleWithdraw(body, env, origin) {
  const telegramId = telegramIdOf(body);
  const wallet = walletOf(body);
  const requested = Number(body.amount || CONFIG.WITHDRAW_AMOUNT);

  if (!validTelegramId(telegramId)) {
    return json({ success: false, error: "telegram_id is required" }, 400, origin);
  }

  if (!validWallet(wallet)) {
    return json({ success: false, error: "Valid TON wallet is required" }, 400, origin);
  }

  if (requested !== CONFIG.WITHDRAW_AMOUNT) {
    return json({
      success: false,
      error: `Withdrawal amount must be exactly ${CONFIG.WITHDRAW_AMOUNT} LNR`,
    }, 400, origin);
  }

  const user = await findUser(env, telegramId);
  if (!user) {
    return json({ success: false, error: "User not found" }, 404, origin);
  }

  const balance = Number(user.balance || 0);

  if (balance < CONFIG.WITHDRAW_AMOUNT) {
    return json({
      success: false,
      error: `Minimum withdrawal is ${CONFIG.WITHDRAW_AMOUNT} LNR`,
    }, 400, origin);
  }

  const now = nowIso();

  // Reserve 500 LNR from Pool Wallet. Holding is not spent.
  const update = await env.DB.prepare(`
    UPDATE users
    SET balance = balance - ?,
        updated_at = ?
    WHERE telegram_id = ?
      AND balance >= ?
  `).bind(
    CONFIG.WITHDRAW_AMOUNT,
    now,
    telegramId,
    CONFIG.WITHDRAW_AMOUNT
  ).run();

  if (!update.success || Number(update.meta?.changes || 0) !== 1) {
    return json({
      success: false,
      error: "Withdrawal balance changed; please try again",
    }, 409, origin);
  }

  const insert = await env.DB.prepare(`
    INSERT INTO withdrawals (
      telegram_id, wallet, requested_amount, fee, net_amount,
      status, tx_hash, error, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, 'pending', '', '', ?, ?)
  `).bind(
    telegramId,
    wallet,
    CONFIG.WITHDRAW_AMOUNT,
    CONFIG.WITHDRAW_FEE,
    CONFIG.WITHDRAW_NET,
    now,
    now
  ).run();

  if (!insert.success) {
    // Compensate reservation if queue insert fails.
    await env.DB.prepare(`
      UPDATE users SET balance = balance + ?, updated_at = ?
      WHERE telegram_id = ?
    `).bind(CONFIG.WITHDRAW_AMOUNT, now, telegramId).run();

    throw new Error("Could not create withdrawal request");
  }

  const updated = await findUser(env, telegramId);

  return json({
    success: true,
    withdrawal: {
      id: insert.meta?.last_row_id || null,
      requested_amount: CONFIG.WITHDRAW_AMOUNT,
      fee: CONFIG.WITHDRAW_FEE,
      net_amount: CONFIG.WITHDRAW_NET,
      status: "pending",
    },
    user: await userPayload(env, updated),
  }, 200, origin);
}

/* -------------------------------------------------------------------------- */
/* Daily Task                                                                 */
/* -------------------------------------------------------------------------- */

async function handleTask(body, env, origin) {
  const telegramId = telegramIdOf(body);
  const taskKey = String(body.task_key || "daily").trim() || "daily";

  if (!validTelegramId(telegramId)) {
    return json({ success: false, error: "telegram_id is required" }, 400, origin);
  }

  await ensureUser(env, telegramId, "", "");

  const today = new Date().toISOString().slice(0, 10);
  const reward = taskKey === "daily" ? 3 : 0;

  if (reward <= 0) {
    return json({ success: false, error: "Unknown task" }, 400, origin);
  }

  const exists = await env.DB.prepare(`
    SELECT 1 FROM daily_tasks
    WHERE telegram_id = ? AND task_key = ? AND claim_date = ?
  `).bind(telegramId, taskKey, today).first();

  if (exists) {
    return json({
      success: false,
      error: "Today's task already claimed",
      user: await userPayload(env, await findUser(env, telegramId)),
    }, 409, origin);
  }

  const now = nowIso();

  await env.DB.batch([
    env.DB.prepare(`
      UPDATE users
      SET balance = balance + ?, updated_at = ?
      WHERE telegram_id = ?
    `).bind(reward, now, telegramId),

    env.DB.prepare(`
      INSERT INTO daily_tasks
      (telegram_id, task_key, claim_date, reward, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).bind(telegramId, taskKey, today, reward, now),
  ]);

  return json({
    success: true,
    task_key: taskKey,
    reward,
    user: await userPayload(env, await findUser(env, telegramId)),
  }, 200, origin);
}

/* -------------------------------------------------------------------------- */
/* Referral                                                                    */
/* -------------------------------------------------------------------------- */

async function processReferralEntry(env, referredId, referralCode) {
  const user = await findUser(env, referredId);
  if (!user) return;

  // Never overwrite an already assigned referrer.
  if (String(user.referred_by || "").trim()) return;

  const referrer = await env.DB.prepare(`
    SELECT telegram_id FROM users WHERE referral_code = ?
  `).bind(referralCode).first();

  if (!referrer) return;

  const referrerId = String(referrer.telegram_id);

  // Self-referral is rejected.
  if (referrerId === String(referredId)) return;

  await env.DB.prepare(`
    UPDATE users
    SET referred_by = ?, updated_at = ?
    WHERE telegram_id = ?
      AND (referred_by IS NULL OR referred_by = '')
  `).bind(referrerId, nowIso(), referredId).run();
}

async function processSuccessfulReferral(env, referredId, wallet) {
  const referred = await findUser(env, referredId);
  if (!referred) return;

  const referrerId = String(referred.referred_by || "").trim();

  if (!referrerId || Number(referred.referral_success || 0) === 1) {
    return;
  }

  if (!validWallet(wallet)) return;

  const referrer = await findUser(env, referrerId);
  if (!referrer) return;

  const now = nowIso();

  // Unique ledger prevents duplicate +500 rewards.
  const existing = await env.DB.prepare(`
    SELECT 1 FROM referral_bonus_ledger
    WHERE referred_telegram_id = ?
  `).bind(referredId).first();

  if (existing) {
    await env.DB.prepare(`
      UPDATE users
      SET referral_success = 1,
          referral_success_at = ?,
          updated_at = ?
      WHERE telegram_id = ?
    `).bind(now, now, referredId).run();
    return;
  }

  await env.DB.batch([
    env.DB.prepare(`
      UPDATE users
      SET balance = balance + ?,
          referral_bonus_credited = referral_bonus_credited + ?,
          updated_at = ?
      WHERE telegram_id = ?
    `).bind(
      CONFIG.REFERRAL_SUCCESS_BONUS,
      CONFIG.REFERRAL_SUCCESS_BONUS,
      now,
      referrerId
    ),

    env.DB.prepare(`
      UPDATE users
      SET wallet = ?,
          referral_success = 1,
          referral_success_at = ?,
          updated_at = ?
      WHERE telegram_id = ?
    `).bind(wallet, now, now, referredId),

    env.DB.prepare(`
      INSERT INTO referral_bonus_ledger
      (referred_telegram_id, referrer_telegram_id, amount, created_at)
      VALUES (?, ?, ?, ?)
    `).bind(
      referredId,
      referrerId,
      CONFIG.REFERRAL_SUCCESS_BONUS,
      now
    ),
  ]);
}

async function processClaimReferralReward(env, referredId, claimAmount, claimKey) {
  if (!(claimAmount > 0)) return;

  const referred = await findUser(env, referredId);
  if (!referred) return;

  const referrerId = String(referred.referred_by || "").trim();
  if (!referrerId) return;

  const referrer = await findUser(env, referrerId);
  if (!referrer) return;

  const reward = claimAmount * CONFIG.REFERRAL_CLAIM_PERCENT;
  if (!(reward > 0)) return;

  const existing = await env.DB.prepare(`
    SELECT 1 FROM referral_claim_ledger WHERE claim_key = ?
  `).bind(claimKey).first();

  if (existing) return;

  const now = nowIso();

  await env.DB.batch([
    env.DB.prepare(`
      UPDATE users
      SET balance = balance + ?,
          referral_earnings = referral_earnings + ?,
          updated_at = ?
      WHERE telegram_id = ?
    `).bind(reward, reward, now, referrerId),

    env.DB.prepare(`
      INSERT INTO referral_claim_ledger
      (claim_key, referred_telegram_id, referrer_telegram_id, amount, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).bind(
      claimKey,
      referredId,
      referrerId,
      reward,
      now
    ),
  ]);
}

async function handleReferralGet(url, env, origin) {
  const telegramId = String(url.searchParams.get("telegram_id") || "").trim();

  if (!validTelegramId(telegramId)) {
    return json({ success: false, error: "telegram_id is required" }, 400, origin);
  }

  const user = await findUser(env, telegramId);
  if (!user) {
    return json({ success: false, error: "User not found" }, 404, origin);
  }

  const payload = await userPayload(env, user);

  return json({
    success: true,
    referral: {
      code: payload.referral_code,
      link: `https://t.me/${CONFIG.BOT_USERNAME}?start=${encodeURIComponent(payload.referral_code || "")}`,
      invited_users: payload.referral_count,
      successful_referrals: payload.successful_referrals,
      success_bonus_lnr: payload.referral_bonuses,
      claim_rewards_lnr: payload.referral_earnings,
    },
  }, 200, origin);
}

/* -------------------------------------------------------------------------- */
/* Withdrawals read                                                           */
/* -------------------------------------------------------------------------- */

async function handleWithdrawalsGet(url, env, origin) {
  const telegramId = String(url.searchParams.get("telegram_id") || "").trim();

  if (!validTelegramId(telegramId)) {
    return json({ success: false, error: "telegram_id is required" }, 400, origin);
  }

  const rows = await env.DB.prepare(`
    SELECT id, wallet, requested_amount AS amount, fee, net_amount,
           status, tx_hash, error, created_at, updated_at
    FROM withdrawals
    WHERE telegram_id = ?
    ORDER BY id DESC
    LIMIT 50
  `).bind(telegramId).all();

  return json({
    success: true,
    withdrawals: rows.results || [],
  }, 200, origin);
}

/* -------------------------------------------------------------------------- */
/* Mining settlement                                                          */
/* -------------------------------------------------------------------------- */

async function settleMining(env, user, wallet) {
  const now = Date.now();
  const last = user.last_mined_at ? Date.parse(user.last_mined_at) : now;
  const elapsedMs = Math.max(0, Math.min(now - last, 24 * 60 * 60 * 1000));
  const elapsedHours = elapsedMs / 3600000;

  const totalAssets =
    Number(user.balance || 0) +
    (Number.isFinite(Number(user.holding)) ? Number(user.holding) : 0);

  const level = calculateLevel(totalAssets);
  const rate = miningRate(level);
  const added = elapsedHours * rate;
  const mined = Number(user.mined || 0) + added;
  const iso = new Date(now).toISOString();

  await env.DB.prepare(`
    UPDATE users
    SET wallet = ?,
        mined = ?,
        last_mined_at = ?,
        level = ?,
        mining_rate = ?,
        updated_at = ?
    WHERE telegram_id = ?
  `).bind(
    wallet,
    mined,
    iso,
    level,
    rate,
    iso,
    String(user.telegram_id)
  ).run();

  return {
    added,
    mined,
    level,
    rate,
  };
}

/* -------------------------------------------------------------------------- */
/* Holding Wallet — TONAPI                                                    */
/* -------------------------------------------------------------------------- */

async function refreshHolding(env, telegramId, wallet) {
  if (!wallet || !env.LNR_JETTON_MASTER) return null;

  try {
    const base = String(env.TONAPI_BASE || CONFIG.TONAPI_BASE).replace(/\/+$/, "");
    const master = encodeURIComponent(String(env.LNR_JETTON_MASTER));
    const address = encodeURIComponent(wallet);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CONFIG.TONAPI_TIMEOUT_MS);

    const response = await fetch(
      `${base}/v2/accounts/${address}/jettons/${master}`,
      {
        method: "GET",
        headers: env.TONAPI_KEY ? { Authorization: `Bearer ${env.TONAPI_KEY}` } : {},
        signal: controller.signal,
      }
    );

    clearTimeout(timeout);

    if (!response.ok) return null;

    const data = await response.json();

    const raw =
      data?.balance ??
      data?.jetton_wallet?.balance ??
      data?.amount ??
      null;

    if (raw == null) return null;

    // TONAPI jetton balances are integer strings. Decimals default to 9 for
    // LNR unless LNR_DECIMALS is explicitly configured.
    const decimals = Number(env.LNR_DECIMALS ?? 9);
    const amount = Number(raw) / Math.pow(10, decimals);

    if (!Number.isFinite(amount)) return null;

    await env.DB.prepare(`
      UPDATE users
      SET holding = ?, updated_at = ?
      WHERE telegram_id = ?
    `).bind(amount, nowIso(), telegramId).run();

    return amount;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Reference price                                                            */
/* -------------------------------------------------------------------------- */

async function getReferencePrice(env) {
  const configured = Number(env.REFERENCE_PRICE_USDT);

  if (Number.isFinite(configured) && configured > 0) {
    return configured;
  }

  try {
    const row = await env.DB.prepare(`
      SELECT price_usdt
      FROM price_history
      ORDER BY id DESC
      LIMIT 1
    `).first();

    const stored = Number(row?.price_usdt);
    if (Number.isFinite(stored) && stored > 0) return stored;
  } catch {}

  return CONFIG.DEFAULT_REFERENCE_PRICE;
}

/* -------------------------------------------------------------------------- */
/* Telegram initData verification                                             */
/* -------------------------------------------------------------------------- */

async function verifyTelegramInitData(initData, botToken) {
  if (!initData) {
    return { ok: false, error: "Telegram initData is required" };
  }

  if (!botToken) {
    return { ok: false, error: "TELEGRAM_BOT_TOKEN is not configured" };
  }

  try {
    const params = new URLSearchParams(initData);
    const hash = params.get("hash");

    if (!hash) return { ok: false, error: "Telegram initData hash missing" };

    params.delete("hash");

    const dataCheckString = Array.from(params.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join("\n");

    const secretKey = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode("WebAppData"),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );

    const secret = await crypto.subtle.sign(
      "HMAC",
      secretKey,
      new TextEncoder().encode(botToken)
    );

    const validationKey = await crypto.subtle.importKey(
      "raw",
      new Uint8Array(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );

    const signature = await crypto.subtle.sign(
      "HMAC",
      validationKey,
      new TextEncoder().encode(dataCheckString)
    );

    const calculated = [...new Uint8Array(signature)]
      .map(b => b.toString(16).padStart(2, "0"))
      .join("");

    if (!constantTimeEqual(calculated, hash)) {
      return { ok: false, error: "Invalid Telegram initData" };
    }

    const authDate = Number(params.get("auth_date") || 0);
    if (authDate && Math.abs(Date.now() / 1000 - authDate) > 86400) {
      return { ok: false, error: "Telegram initData expired" };
    }

    let user = null;
    try {
      user = JSON.parse(params.get("user") || "null");
    } catch {}

    return { ok: true, user };
  } catch {
    return { ok: false, error: "Telegram initData verification failed" };
  }
}

function constantTimeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;

  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

/* -------------------------------------------------------------------------- */
/* Generic D1 scalar                                                          */
/* -------------------------------------------------------------------------- */

async function scalar(db, sql, binds = []) {
  const row = await db.prepare(sql).bind(...binds).first();
  return Number(row?.n || 0);
}

/* -------------------------------------------------------------------------- */
/* Admin/maintenance helpers                                                 */
/* These are exported for future Worker-internal jobs/tests.                 */
/* They are NOT public HTTP endpoints.                                       */
/* -------------------------------------------------------------------------- */

export async function markWithdrawalPaid(env, withdrawalId, txHash = "") {
  const id = Number(withdrawalId);
  if (!Number.isFinite(id)) throw new Error("Invalid withdrawal id");

  const row = await env.DB.prepare(`
    SELECT * FROM withdrawals WHERE id = ?
  `).bind(id).first();

  if (!row) throw new Error("Withdrawal not found");
  if (row.status === "paid") return row;

  await env.DB.prepare(`
    UPDATE withdrawals
    SET status = 'paid', tx_hash = ?, updated_at = ?
    WHERE id = ?
  `).bind(String(txHash || ""), nowIso(), id).run();

  return env.DB.prepare(`
    SELECT * FROM withdrawals WHERE id = ?
  `).bind(id).first();
}

export async function markWithdrawalFailed(env, withdrawalId, errorText = "") {
  const id = Number(withdrawalId);
  if (!Number.isFinite(id)) throw new Error("Invalid withdrawal id");

  const row = await env.DB.prepare(`
    SELECT * FROM withdrawals WHERE id = ?
  `).bind(id).first();

  if (!row) throw new Error("Withdrawal not found");
  if (row.status === "paid") throw new Error("Paid withdrawal cannot be failed");

  const now = nowIso();

  await env.DB.batch([
    env.DB.prepare(`
      UPDATE withdrawals
      SET status = 'failed', error = ?, updated_at = ?
      WHERE id = ?
    `).bind(String(errorText || "Payout failed"), now, id),

    env.DB.prepare(`
      UPDATE users
      SET balance = balance + ?, updated_at = ?
      WHERE telegram_id = ?
    `).bind(
      Number(row.requested_amount || CONFIG.WITHDRAW_AMOUNT),
      now,
      String(row.telegram_id)
    ),
  ]);

  return env.DB.prepare(`
    SELECT * FROM withdrawals WHERE id = ?
  `).bind(id).first();
}

export async function refreshAllHoldingWallets(env, limit = 50) {
  const rows = await env.DB.prepare(`
    SELECT telegram_id, wallet
    FROM users
    WHERE wallet <> ''
    ORDER BY updated_at DESC
    LIMIT ?
  `).bind(Math.min(200, Math.max(1, Number(limit) || 50))).all();

  const results = [];

  for (const row of rows.results || []) {
    const holding = await refreshHolding(
      env,
      String(row.telegram_id),
      String(row.wallet)
    );

    results.push({
      telegram_id: String(row.telegram_id),
      holding,
    });
  }

  return results;
}
