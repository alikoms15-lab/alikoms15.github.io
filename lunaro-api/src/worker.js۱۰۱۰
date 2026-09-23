const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Telegram-Init-Data"
};

const CONFIG = {
  BOT_USERNAME: "LunaroGameBot",
  MAX_LEVEL: 1000,
  LEVEL_STEP_LNR: 500,
  BASE_MINING_RATE: 0.70,
  MINING_RATE_STEP: 0.05,
  WITHDRAWAL_MIN: 500,
  WITHDRAWAL_FEE: 70,
  WITHDRAWAL_NET: 430,
  REFERRAL_SUCCESS_BONUS: 500,
  REFERRAL_CLAIM_PERCENT: 0.10,
  DEFAULT_LNR_PRICE: 0.0008,
  DAILY_TASK_REWARD: 3
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json; charset=UTF-8",
      "Cache-Control": "no-store"
    }
  });
}

function nowIso() {
  return new Date().toISOString();
}

function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function levelRequiredLNR(level) {
  const lv = Math.max(1, Math.min(CONFIG.MAX_LEVEL, Math.floor(num(level, 1))));
  return (lv - 1) * CONFIG.LEVEL_STEP_LNR;
}

function miningRateForLevel(level) {
  return CONFIG.BASE_MINING_RATE + Math.max(0, Math.floor(num(level, 1)) - 1) * CONFIG.MINING_RATE_STEP;
}

function safeWallet(wallet) {
  const w = String(wallet || "").trim();
  return w.length >= 20 && w.length <= 128;
}

function referralCodeForTelegramId(id) {
  const s = String(id || "");
  return "LNR" + s.slice(-8) + Math.random().toString(36).slice(2, 7).toUpperCase();
}

async function bestEffortSchema(env) {
  // IMPORTANT: This migration is intentionally best-effort.
  // The original /claim path must not become dependent on referral migrations.
  if (!env.DB) return;

  const statements = [
    `CREATE TABLE IF NOT EXISTS claims (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id TEXT NOT NULL,
      amount REAL NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS withdrawals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id TEXT NOT NULL,
      wallet TEXT NOT NULL,
      requested_amount REAL NOT NULL,
      fee REAL NOT NULL DEFAULT 70,
      payout_amount REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      tx_hash TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      completed_at TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS daily_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id TEXT NOT NULL,
      task_key TEXT NOT NULL,
      task_date TEXT NOT NULL,
      reward REAL NOT NULL DEFAULT 3,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(telegram_id, task_key, task_date)
    )`,
    `CREATE TABLE IF NOT EXISTS referral_bonus_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      referrer_telegram_id TEXT NOT NULL,
      referred_telegram_id TEXT NOT NULL UNIQUE,
      amount REAL NOT NULL DEFAULT 500,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS referral_claim_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      referrer_telegram_id TEXT NOT NULL,
      referred_telegram_id TEXT NOT NULL,
      claim_id INTEGER,
      claim_key TEXT NOT NULL UNIQUE,
      amount REAL NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`
  ];

  for (const sql of statements) {
    try { await env.DB.prepare(sql).run(); } catch (_) {}
  }

  const columns = [
    ["users", "referred_by", "TEXT"],
    ["users", "referral_success", "INTEGER DEFAULT 0"],
    ["users", "referral_success_at", "TEXT"],
    ["users", "referral_bonus_credited", "REAL DEFAULT 0"],
    ["users", "referral_earnings", "REAL DEFAULT 0"],
    ["users", "holding_wallet", "REAL DEFAULT 0"],
    ["users", "last_task_date", "TEXT"]
  ];

  for (const [table, column, type] of columns) {
    try {
      await env.DB.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`).run();
    } catch (_) {}
  }
}

async function getUser(env, telegramId) {
  return env.DB.prepare("SELECT * FROM users WHERE telegram_id = ?")
    .bind(String(telegramId)).first();
}

async function ensureUser(env, data) {
  const telegramId = String(data.telegram_id || "");
  if (!telegramId) throw new Error("telegram_id is required");

  let user = await getUser(env, telegramId);

  if (!user) {
    const referralCode = referralCodeForTelegramId(telegramId);
    await env.DB.prepare(`
      INSERT INTO users
      (telegram_id, username, first_name, wallet, balance, mined, mining_rate, level, referral_code, last_mining_at)
      VALUES (?, ?, ?, NULL, 0, 0, ?, 1, ?, ?)
    `).bind(
      telegramId,
      data.username || null,
      data.first_name || "User",
      CONFIG.BASE_MINING_RATE,
      referralCode,
      nowIso()
    ).run();
    user = await getUser(env, telegramId);
  } else {
    await env.DB.prepare(`
      UPDATE users
      SET username = ?, first_name = ?, updated_at = CURRENT_TIMESTAMP
      WHERE telegram_id = ?
    `).bind(data.username || null, data.first_name || "User", telegramId).run();
    user = await getUser(env, telegramId);
  }

  return user;
}

async function settleMining(env, user, wallet = null) {
  const now = Date.now();
  const last = user.last_mining_at ? new Date(user.last_mining_at).getTime() : now;
  let elapsed = (now - last) / 1000;
  if (!Number.isFinite(elapsed) || elapsed < 0) elapsed = 0;
  elapsed = Math.min(elapsed, 86400);

  const rate = Math.max(0, num(user.mining_rate, CONFIG.BASE_MINING_RATE));
  const earned = (elapsed / 3600) * rate;
  const currentMined = Math.max(0, num(user.mined));
  const mined = currentMined + earned;

  await env.DB.prepare(`
    UPDATE users
    SET wallet = COALESCE(?, wallet),
        mined = ?,
        last_mining_at = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE telegram_id = ?
  `).bind(wallet || null, mined, nowIso(), String(user.telegram_id)).run();

  return await getUser(env, user.telegram_id);
}

async function attachReferral(env, user, referralCode) {
  const code = String(referralCode || "").trim();
  if (!code || user.referred_by) return user;

  const referrer = await env.DB.prepare(
    "SELECT telegram_id FROM users WHERE referral_code = ?"
  ).bind(code).first();

  if (!referrer || String(referrer.telegram_id) === String(user.telegram_id)) return user;

  try {
    await env.DB.prepare(`
      UPDATE users SET referred_by = ?, updated_at = CURRENT_TIMESTAMP
      WHERE telegram_id = ? AND (referred_by IS NULL OR referred_by = '')
    `).bind(String(referrer.telegram_id), String(user.telegram_id)).run();
  } catch (_) {}

  return await getUser(env, user.telegram_id);
}

async function markSuccessfulReferral(env, user) {
  if (!user || !user.referred_by || Number(user.referral_success || 0) === 1) return;

  try {
    const refId = String(user.referred_by);
    const existing = await env.DB.prepare(
      "SELECT id FROM referral_bonus_ledger WHERE referred_telegram_id = ?"
    ).bind(String(user.telegram_id)).first();

    if (existing) {
      await env.DB.prepare(`
        UPDATE users SET referral_success = 1 WHERE telegram_id = ?
      `).bind(String(user.telegram_id)).run();
      return;
    }

    const referrer = await getUser(env, refId);
    if (!referrer) return;

    await env.DB.prepare(`
      UPDATE users
      SET balance = COALESCE(balance,0) + ?,
          referral_earnings = COALESCE(referral_earnings,0) + ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE telegram_id = ?
    `).bind(CONFIG.REFERRAL_SUCCESS_BONUS, CONFIG.REFERRAL_SUCCESS_BONUS, refId).run();

    await env.DB.prepare(`
      INSERT INTO referral_bonus_ledger
      (referrer_telegram_id, referred_telegram_id, amount)
      VALUES (?, ?, ?)
    `).bind(refId, String(user.telegram_id), CONFIG.REFERRAL_SUCCESS_BONUS).run();

    await env.DB.prepare(`
      UPDATE users
      SET referral_success = 1,
          referral_success_at = ?,
          referral_bonus_credited = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE telegram_id = ?
    `).bind(nowIso(), CONFIG.REFERRAL_SUCCESS_BONUS, String(user.telegram_id)).run();
  } catch (_) {
    // Referral must never break wallet verification or Claim.
  }
}

async function creditReferralClaimReward(env, referredUser, claimAmount, claimId) {
  if (!referredUser || !referredUser.referred_by || claimAmount <= 0) return;

  try {
    const reward = claimAmount * CONFIG.REFERRAL_CLAIM_PERCENT;
    if (reward <= 0) return;

    const claimKey = String(claimId || `${referredUser.telegram_id}:${Date.now()}:${claimAmount}`);
    const exists = await env.DB.prepare(
      "SELECT id FROM referral_claim_ledger WHERE claim_key = ?"
    ).bind(claimKey).first();
    if (exists) return;

    await env.DB.prepare(`
      UPDATE users
      SET balance = COALESCE(balance,0) + ?,
          referral_earnings = COALESCE(referral_earnings,0) + ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE telegram_id = ?
    `).bind(reward, reward, String(referredUser.referred_by)).run();

    await env.DB.prepare(`
      INSERT INTO referral_claim_ledger
      (referrer_telegram_id, referred_telegram_id, claim_id, claim_key, amount)
      VALUES (?, ?, ?, ?, ?)
    `).bind(
      String(referredUser.referred_by),
      String(referredUser.telegram_id),
      claimId || null,
      claimKey,
      reward
    ).run();
  } catch (_) {}
}

async function holdingWalletBalance(env, wallet) {
  // Optional TONAPI integration. If TONAPI_KEY is not configured, return 0
  // instead of making the app fail.
  if (!safeWallet(wallet) || !env.TONAPI_KEY) return 0;

  try {
    const url = `https://tonapi.io/v2/accounts/${encodeURIComponent(wallet)}/jettons`;
    const r = await fetch(url, {
      headers: { "Authorization": `Bearer ${env.TONAPI_KEY}` }
    });
    if (!r.ok) return 0;

    const data = await r.json();
    const target = String(env.LNR_JETTON_MASTER || "EQArZiLoiwGQVFXf-xypL_3qBg6DYuOQTHNJhOmEju-LNPuk").trim().toLowerCase();
    if (!target) return 0;

    const item = (data.balances || []).find(x =>
      String(x.jetton?.address || "").toLowerCase() === target
    );
    if (!item) return 0;

    const decimals = num(item.jetton?.decimals, 9);
    return num(item.balance) / Math.pow(10, decimals);
  } catch (_) {
    return 0;
  }
}

async function buildUserPayload(env, user) {
  const wallet = String(user?.wallet || "");
  let holding = num(user?.holding_wallet, 0);

  const chainHolding = await holdingWalletBalance(env, wallet);
  if (chainHolding > 0) holding = chainHolding;

  const pool = num(user?.balance, 0);
  const mined = num(user?.mined, 0);
  const totalAssets = pool + holding;
  const level = Math.min(
    CONFIG.MAX_LEVEL,
    Math.max(1, Math.floor(totalAssets / CONFIG.LEVEL_STEP_LNR) + 1)
  );

  // Keep backend mining rate aligned with level, but do not let this
  // invalidate existing user data.
  const rate = miningRateForLevel(level);

  return {
    ...user,
    balance: pool,
    pool: pool,
    mined: mined,
    holding: holding,
    holding_wallet: holding,
    total_assets: totalAssets,
    level: level,
    mining_rate: Math.max(num(user?.mining_rate, CONFIG.BASE_MINING_RATE), rate),
    next_level_required: level < CONFIG.MAX_LEVEL ? levelRequiredLNR(level + 1) : null,
    referral_success: Number(user?.referral_success || 0),
    referral_earnings: num(user?.referral_earnings, 0),
    successful_referrals: Number(user?.referral_success || 0)
  };
}

async function handleUserPost(request, env) {
  const data = await request.json();
  let user = await ensureUser(env, data);

  if (data.referral_code) {
    user = await attachReferral(env, user, data.referral_code);
  }

  if (String(data.referral_action || "").toLowerCase() === "wallet_verified") {
    await markSuccessfulReferral(env, user);
    user = await getUser(env, user.telegram_id);
  }

  return json({
    success: true,
    user: await buildUserPayload(env, user)
  });
}

async function handleMine(request, env) {
  const data = await request.json();
  const telegramId = String(data.telegram_id || "");
  const wallet = String(data.wallet || "");

  if (!telegramId) return json({ success: false, error: "telegram_id is required" }, 400);
  if (!wallet) return json({ success: false, error: "wallet is required" }, 400);

  const user = await getUser(env, telegramId);
  if (!user) return json({ success: false, error: "User not found" }, 404);

  const updated = await settleMining(env, user, wallet);

  // Wallet connection is the successful-referral event.
  if (updated.referred_by && Number(updated.referral_success || 0) !== 1) {
    await markSuccessfulReferral(env, updated);
  }

  const finalUser = await getUser(env, telegramId);
  return json({
    success: true,
    earned: Math.max(0, num(finalUser.mined) - num(user.mined)),
    user: await buildUserPayload(env, finalUser)
  });
}

async function handleClaim(request, env) {
  // This core intentionally follows the proven v2 Claim architecture:
  // telegram_id + wallet -> read user -> accrue -> balance += claim -> mined=0
  // Referral processing is best-effort AFTER the successful claim.
  const data = await request.json();
  const telegramId = String(data.telegram_id || "");
  const wallet = String(data.wallet || "");

  if (!telegramId) return json({ success: false, error: "telegram_id is required" }, 400);
  if (!wallet) return json({ success: false, error: "wallet is required" }, 400);

  const user = await getUser(env, telegramId);
  if (!user) return json({ success: false, error: "User not found" }, 404);

  const now = Date.now();
  const last = user.last_mining_at ? new Date(user.last_mining_at).getTime() : now;
  let elapsed = (now - last) / 1000;
  if (!Number.isFinite(elapsed) || elapsed < 0) elapsed = 0;
  elapsed = Math.min(elapsed, 86400);

  const rate = Number(user.mining_rate || CONFIG.BASE_MINING_RATE);
  const accrued = (elapsed / 3600) * rate;
  const claimAmount = Number(user.mined || 0) + accrued;

  if (claimAmount <= 0) {
    return json({ success: false, error: "Nothing to claim" }, 400);
  }

  const newBalance = Number(user.balance || 0) + claimAmount;

  // Same simple update pattern as the proven Worker.
  await env.DB.prepare(`
    UPDATE users
    SET wallet = ?, balance = ?, mined = 0, last_mining_at = ?, updated_at = CURRENT_TIMESTAMP
    WHERE telegram_id = ?
  `).bind(wallet, newBalance, nowIso(), telegramId).run();

  let claimId = null;
  try {
    const inserted = await env.DB.prepare(`
      INSERT INTO claims (telegram_id, amount) VALUES (?, ?)
    `).bind(telegramId, claimAmount).run();
    claimId = inserted?.meta?.last_row_id ?? null;
  } catch (_) {
    // Claim balance has already been completed. Missing claims table/ledger
    // must not turn a successful Claim into a frontend fetch failure.
  }

  const updatedUser = await getUser(env, telegramId);

  // Referral reward is deliberately isolated so it cannot break Claim.
  try {
    await creditReferralClaimReward(env, user, claimAmount, claimId);
  } catch (_) {}

  const finalUser = await getUser(env, telegramId);

  return json({
    success: true,
    claimed: claimAmount,
    user: await buildUserPayload(env, finalUser)
  });
}

async function handleTask(request, env) {
  const data = await request.json();
  const telegramId = String(data.telegram_id || "");
  const taskKey = String(data.task_key || "daily");

  if (!telegramId) return json({ success: false, error: "telegram_id is required" }, 400);

  const user = await getUser(env, telegramId);
  if (!user) return json({ success: false, error: "User not found" }, 404);

  const today = new Date().toISOString().slice(0, 10);

  try {
    const existing = await env.DB.prepare(`
      SELECT id FROM daily_tasks
      WHERE telegram_id = ? AND task_key = ? AND task_date = ?
    `).bind(telegramId, taskKey, today).first();

    if (existing) {
      return json({ success: false, error: "Task already claimed", user: await buildUserPayload(env, user) }, 400);
    }

    await env.DB.prepare(`
      UPDATE users
      SET balance = COALESCE(balance,0) + ?,
          last_task_date = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE telegram_id = ?
    `).bind(CONFIG.DAILY_TASK_REWARD, today, telegramId).run();

    await env.DB.prepare(`
      INSERT INTO daily_tasks (telegram_id, task_key, task_date, reward)
      VALUES (?, ?, ?, ?)
    `).bind(telegramId, taskKey, today, CONFIG.DAILY_TASK_REWARD).run();
  } catch (e) {
    return json({ success: false, error: e.message || "Task failed" }, 500);
  }

  const updated = await getUser(env, telegramId);
  return json({
    success: true,
    reward: CONFIG.DAILY_TASK_REWARD,
    user: await buildUserPayload(env, updated)
  });
}

async function handleWithdraw(request, env) {
  const data = await request.json();
  const telegramId = String(data.telegram_id || "");
  const wallet = String(data.wallet || "");

  if (!telegramId) return json({ success: false, error: "telegram_id is required" }, 400);
  if (!wallet) return json({ success: false, error: "wallet is required" }, 400);

  const user = await getUser(env, telegramId);
  if (!user) return json({ success: false, error: "User not found" }, 404);

  const amount = num(data.amount);
  if (amount < CONFIG.WITHDRAWAL_MIN) {
    return json({
      success: false,
      error: `Minimum withdrawal is ${CONFIG.WITHDRAWAL_MIN} LNR`
    }, 400);
  }

  const balance = num(user.balance);
  if (balance < amount) {
    return json({ success: false, error: "Insufficient balance" }, 400);
  }

  const net = Math.max(0, amount - CONFIG.WITHDRAWAL_FEE);

  try {
    await env.DB.prepare(`
      UPDATE users
      SET balance = balance - ?, updated_at = CURRENT_TIMESTAMP
      WHERE telegram_id = ? AND balance >= ?
    `).bind(amount, telegramId, amount).run();

    await env.DB.prepare(`
      INSERT INTO withdrawals
      (telegram_id, wallet, requested_amount, fee, payout_amount, status)
      VALUES (?, ?, ?, ?, ?, 'pending')
    `).bind(
      telegramId, wallet, amount, CONFIG.WITHDRAWAL_FEE, net
    ).run();
  } catch (e) {
    return json({ success: false, error: e.message || "Withdrawal failed" }, 500);
  }

  const updated = await getUser(env, telegramId);

  return json({
    success: true,
    withdrawal: {
      amount,
      requested_amount: amount,
      fee: CONFIG.WITHDRAWAL_FEE,
      net_amount: net,
      payout_amount: net,
      status: "pending",
      wallet
    },
    user: await buildUserPayload(env, updated)
  });
}

async function handleReferral(request, env) {
  const url = new URL(request.url);
  const telegramId = String(
    url.searchParams.get("telegram_id") ||
    (request.method === "POST" ? "" : "")
  );

  if (!telegramId) return json({ success: false, error: "telegram_id is required" }, 400);

  const user = await getUser(env, telegramId);
  if (!user) return json({ success: false, error: "User not found" }, 404);

  const successful = Number(user.referral_success || 0);
  const earnings = num(user.referral_earnings, 0);

  return json({
    success: true,
    referral_code: user.referral_code,
    referral_link: `https://t.me/${CONFIG.BOT_USERNAME}?start=${encodeURIComponent(user.referral_code || "")}`,
    successful_referrals: successful,
    referral_earnings: earnings,
    success_bonus: CONFIG.REFERRAL_SUCCESS_BONUS,
    claim_percent: CONFIG.REFERRAL_CLAIM_PERCENT
  });
}

async function handleWithdrawals(request, env) {
  const url = new URL(request.url);
  const telegramId = url.searchParams.get("telegram_id");
  if (!telegramId) return json({ success: false, error: "telegram_id is required" }, 400);

  try {
    const result = await env.DB.prepare(`
      SELECT id, wallet, requested_amount, requested_amount AS amount, fee, payout_amount, payout_amount AS net_amount, status, tx_hash, created_at, completed_at, completed_at AS processed_at
      FROM withdrawals
      WHERE telegram_id = ?
      ORDER BY id DESC
      LIMIT 100
    `).bind(telegramId).all();

    return json({ success: true, withdrawals: result.results || [] });
  } catch (e) {
    return json({ success: false, error: e.message || "Unable to load withdrawals" }, 500);
  }
}

async function handleMiners(env) {
  const levels = [];
  for (let level = 1; level <= CONFIG.MAX_LEVEL; level++) {
    levels.push({
      level,
      required_lnr: levelRequiredLNR(level),
      mining_rate: miningRateForLevel(level)
    });
  }

  return json({
    success: true,
    max_level: CONFIG.MAX_LEVEL,
    level_step_lnr: CONFIG.LEVEL_STEP_LNR,
    levels
  });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // Keep health/config endpoints independent from D1 so they remain useful
    // for deployment diagnostics.
    if (path === "/" && request.method === "GET") {
      return json({ success: true, app: "LUNARO", api: "running", version: "stable-v2-compatible" });
    }

    if (path === "/health" && request.method === "GET") {
      return json({
        success: true,
        service: "LUNARO API",
        version: "stable-v2-compatible",
        time: nowIso()
      });
    }

    if (path === "/config" && request.method === "GET") {
      return json({
        success: true,
        bot_username: CONFIG.BOT_USERNAME,
        max_level: CONFIG.MAX_LEVEL,
        level_step_lnr: CONFIG.LEVEL_STEP_LNR,
        withdrawal_min: CONFIG.WITHDRAWAL_MIN,
        withdrawal_fee: CONFIG.WITHDRAWAL_FEE,
        withdrawal_net: CONFIG.WITHDRAWAL_NET,
        referral_success_bonus: CONFIG.REFERRAL_SUCCESS_BONUS,
        referral_claim_percent: CONFIG.REFERRAL_CLAIM_PERCENT
      });
    }

    if (path === "/price" && request.method === "GET") {
      return json({
        success: true,
        symbol: "LNR",
        reference_price_usdt: num(env.LNR_REFERENCE_PRICE, CONFIG.DEFAULT_LNR_PRICE),
        source: env.LNR_REFERENCE_PRICE ? "env" : "reference"
      });
    }

    // D1 schema is best-effort and never runs before health/config.
    try {
      await bestEffortSchema(env);
    } catch (_) {}

    try {
      if (path === "/user" && request.method === "POST") {
        return await handleUserPost(request, env);
      }

      if (path === "/user" && request.method === "GET") {
        const telegramId = url.searchParams.get("telegram_id");
        if (!telegramId) return json({ success: false, error: "telegram_id is required" }, 400);
        const user = await getUser(env, telegramId);
        if (!user) return json({ success: false, error: "User not found" }, 404);
        return json({ success: true, user: await buildUserPayload(env, user) });
      }

      if (path === "/mine" && request.method === "POST") {
        return await handleMine(request, env);
      }

      if (path === "/claim" && request.method === "POST") {
        return await handleClaim(request, env);
      }

      if (path === "/task" && request.method === "POST") {
        return await handleTask(request, env);
      }

      if (path === "/withdraw" && request.method === "POST") {
        return await handleWithdraw(request, env);
      }

      if (path === "/referral" && (request.method === "GET" || request.method === "POST")) {
        return await handleReferral(request, env);
      }

      if (path === "/withdrawals" && request.method === "GET") {
        return await handleWithdrawals(request, env);
      }

      if (path === "/miners" && request.method === "GET") {
        return await handleMiners(env);
      }

      return json({ success: false, error: "Not Found" }, 404);
    } catch (error) {
      return json({
        success: false,
        error: error?.message || "Internal Server Error"
      }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    // Reserved for future withdrawal queue processing.
    // We intentionally do not move tokens on-chain from a Worker without
    // an explicitly configured signer/transfer system.
  }
};
