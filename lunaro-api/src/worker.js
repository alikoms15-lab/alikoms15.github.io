/* Cloudflare Workers compatibility for TON crypto libraries.
   Some versions expect a browser-like global `window` at runtime. */
if (typeof globalThis.window === "undefined") {
  globalThis.window = globalThis;
}
if (typeof globalThis.self === "undefined") {
  globalThis.self = globalThis;
}

/* Cloudflare Workers rejects Request cache: "default".
   Axios 1.20+ may explicitly set this value before calling fetch.
   Normalize it at the Request constructor boundary so the TON stack
   remains compatible even if a transitive dependency resolves a newer Axios. */
if (typeof globalThis.Request === "function" && !globalThis.__LUNARO_REQUEST_PATCHED__) {
  const NativeRequest = globalThis.Request;
  class LunaroRequest extends NativeRequest {
    constructor(input, init) {
      if (init && init.cache === "default") {
        init = { ...init, cache: "no-store" };
      }
      super(input, init);
    }
  }
  globalThis.Request = LunaroRequest;
  globalThis.__LUNARO_REQUEST_PATCHED__ = true;
}

// IMPORTANT: load TON packages only AFTER the Worker-compatible window shim.
// Some bundled TON crypto code can touch browser globals during module evaluation.
const { Address, beginCell, SendMode } = await import("@ton/core");
const { mnemonicToPrivateKey } = await import("@ton/crypto");
const { TonClient, WalletContractV4, JettonMaster, JettonWallet } =
  await import("@ton/ton");


/* =========================================================
   LUNARO CONFIG
   ========================================================= */

const LNR_MASTER =
  "EQArZiLoiwGQVFXf-xypL_3qBg6DYuOQTHNJhOmEju-LNPuk";

const TREASURY_OWNER =
  "UQCNobW-3Kzoku_up0oV0yD3pUegqj0q3S2ptCfp2yhKilD7";

const TONCENTER_URL =
  "https://toncenter.com/api/v2/jsonRPC";

const TONCENTER_V3 =
  "https://toncenter.com/api/v3";

const LNR_DECIMALS = 9;


/* =========================================================
   BASIC HELPERS
   ========================================================= */

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function round6(n) {
  return Math.round(Number(n) * 1000000) / 1000000;
}

function isValidTonAddress(value) {
  try {
    Address.parse(String(value));
    return true;
  } catch {
    return false;
  }
}

function rawFromHuman(amount, decimals) {
  const n = Number(amount);

  if (!Number.isFinite(n) || n <= 0) {
    throw new Error("Invalid token amount");
  }

  return BigInt(
    Math.round(
      n * (10 ** decimals)
    )
  );
}


/* =========================================================
   TON CLIENT
   ========================================================= */

async function createTonClient(env) {
  return new TonClient({
    endpoint: TONCENTER_URL,
    apiKey: env.TONCENTER_API_KEY || undefined
  });
}


/* =========================================================
   TREASURY
   ========================================================= */

async function getTreasury(env) {

  const mnemonic =
    env.LNR_TREASURY_MNEMONIC;

  if (!mnemonic) {
    throw new Error(
      "LNR_TREASURY_MNEMONIC secret is missing"
    );
  }

  const words =
    String(mnemonic)
      .trim()
      .split(/\s+/)
      .filter(Boolean);

  if (words.length < 12) {
    throw new Error(
      "Invalid treasury mnemonic"
    );
  }

  const keyPair =
    await mnemonicToPrivateKey(words);

  const wallet =
    WalletContractV4.create({
      workchain: 0,
      publicKey: keyPair.publicKey
    });

  const expected =
    Address.parse(TREASURY_OWNER);

  // Compare the underlying raw TON account, not the friendly address
  // string. UQ/EQ (bounceable/non-bounceable) forms can represent the
  // same account and must not be treated as different wallets.
  if (wallet.address.toRawString() !== expected.toRawString()) {
    throw new Error(
      "Treasury mnemonic does not match configured treasury wallet"
    );
  }

  return {
    keyPair,
    wallet
  };
}


/* =========================================================
   LNR JETTON
   ========================================================= */

async function getLnrJetton(env) {

  const client =
    await createTonClient(env);

  const master =
    client.open(
      JettonMaster.create(
        Address.parse(LNR_MASTER)
      )
    );

  return {
    client,
    master,
    decimals: LNR_DECIMALS
  };
}


/* =========================================================
   TREASURY JETTON WALLET
   ========================================================= */

async function getTreasuryJettonWallet(env) {

  const treasury =
    await getTreasury(env);

  const {
    client,
    master,
    decimals
  } =
    await getLnrJetton(env);

  const jettonWalletAddress =
    await master.getWalletAddress(
      treasury.wallet.address
    );

  const jettonWallet =
    client.open(
      JettonWallet.create(
        jettonWalletAddress
      )
    );

  return {
    client,
    treasury,
    master,
    jettonWallet,
    jettonWalletAddress,
    decimals
  };
}


/* =========================================================
   SEND LNR
   ========================================================= */

async function sendLnr(
  env,
  destination,
  amount
) {

  if (!isValidTonAddress(destination)) {
    throw new Error(
      "Invalid destination wallet"
    );
  }

  const {
    client,
    treasury,
    jettonWallet,
    decimals
  } =
    await getTreasuryJettonWallet(env);

  const destinationAddress =
    Address.parse(destination);

  const jettonAmount =
    rawFromHuman(
      amount,
      decimals
    );

  if (jettonAmount <= 0n) {
    throw new Error(
      "Invalid Jetton amount"
    );
  }

  const treasuryContract =
    client.open(
      treasury.wallet
    );

  const seqno =
    await treasuryContract.getSeqno();

  const sender =
    treasuryContract.sender(
      treasury.keyPair.secretKey
    );

  /*
   * 0.08 TON for Jetton transfer gas.
   * The treasury wallet must have TON.
   */

  await jettonWallet.sendTransfer(
    sender,
    {
      seqno,

      sendMode:
        SendMode.PAY_GAS_SEPARATELY,

      value:
        80000000n,

      jettonAmount,

      toAddress:
        destinationAddress,

      responseAddress:
        treasury.wallet.address,

      forwardAmount:
        1000000n,

      forwardPayload:
        beginCell().endCell()
    }
  );

  return {
    seqno,
    amount,
    decimals,
    destination,
    treasuryWallet:
      treasury.wallet.address.toString(),
    jettonWallet:
      jettonWallet.address.toString()
  };
}


/* =========================================================
   SEQNO
   ========================================================= */

async function getWalletSeqno(
  client,
  wallet
) {

  const contract =
    client.open(wallet);

  try {
    return await contract.getSeqno();
  } catch {
    return null;
  }
}


async function waitForSeqnoAdvance(
  client,
  wallet,
  oldSeqno,
  timeoutMs = 120000
) {

  const started =
    Date.now();

  while (
    Date.now() - started <
    timeoutMs
  ) {

    const current =
      await getWalletSeqno(
        client,
        wallet
      );

    if (
      current !== null &&
      Number(current) >
      Number(oldSeqno)
    ) {
      return current;
    }

    await sleep(5000);
  }

  throw new Error(
    "Treasury transaction confirmation timeout"
  );
}


/* =========================================================
   TRANSACTION LOOKUP
   ========================================================= */

async function findRecentTransactionHash(
  env,
  walletAddress
) {

  const apiKey =
    env.TONCENTER_API_KEY;

  const base =
    "https://toncenter.com/api/v2/getTransactions";

  const params =
    new URLSearchParams();

  params.set(
    "address",
    walletAddress.toString()
  );

  params.set(
    "limit",
    "10"
  );

  if (apiKey) {
    params.set(
      "api_key",
      apiKey
    );
  }

  const response =
    await fetch(
      `${base}?${params.toString()}`
    );

  if (!response.ok) {
    return null;
  }

  const data =
    await response.json();

  if (
    !data.ok ||
    !Array.isArray(data.result)
  ) {
    return null;
  }

  const tx =
    data.result[0];

  if (!tx) {
    return null;
  }

  if (
    tx.transaction_id &&
    tx.transaction_id.hash
  ) {
    return tx.transaction_id.hash;
  }

  return null;
}


/* =========================================================
   CORS
   ========================================================= */

const corsHeaders = {

  "Access-Control-Allow-Origin": "*",

  "Access-Control-Allow-Methods":
    "GET,POST,OPTIONS",

  "Access-Control-Allow-Headers":
    "Content-Type, X-Telegram-Init-Data"
};


/* =========================================================
   APP CONFIG
   ========================================================= */

const CONFIG = {

  BOT_USERNAME:
    "LunaroGameBot",

  MAX_LEVEL:
    1000,

  LEVEL_STEP_LNR:
    5000,

  BASE_MINING_RATE:
    7.5,

  MINING_RATE_STEP:
    499 / 999,

  WITHDRAWAL_MIN:
    500,

  WITHDRAWAL_FEE:
    70,

  WITHDRAWAL_NET:
    430,

  REFERRAL_SUCCESS_BONUS:
    500,

  REFERRAL_CLAIM_PERCENT:
    0.10,

  DEFAULT_LNR_PRICE:
    0.0008,

  DAILY_TASK_REWARD:
    3
};


/* =========================================================
   RESPONSE
   ========================================================= */

function json(
  data,
  status = 200
) {

  return new Response(
    JSON.stringify(data),
    {
      status,

      headers: {
        ...corsHeaders,

        "Content-Type":
          "application/json; charset=UTF-8",

        "Cache-Control":
          "no-store"
      }
    }
  );
}


function nowIso() {
  return new Date().toISOString();
}


function num(
  value,
  defaultValue = 0
) {

  const n =
    Number(value);

  return Number.isFinite(n)
    ? n
    : defaultValue;
}


function levelRequiredLNR(level) {

  const lv =
    Math.max(
      1,
      Math.min(
        CONFIG.MAX_LEVEL,
        Math.floor(
          num(level, 1)
        )
      )
    );

  return (
    (lv - 1) *
    CONFIG.LEVEL_STEP_LNR
  );
}


function miningRateForLevel(level) {

  return (
    CONFIG.BASE_MINING_RATE +
    Math.max(
      0,
      Math.floor(
        num(level, 1)
      ) - 1
    ) *
    CONFIG.MINING_RATE_STEP
  );
}


function safeWallet(wallet) {

  const w =
    String(wallet || "")
      .trim();

  return (
    w.length >= 20 &&
    w.length <= 128
  );
}


function referralCodeForTelegramId(id) {

  const s =
    String(id || "");

  return (
    "LNR" +
    s.slice(-8) +
    Math.random()
      .toString(36)
      .slice(2, 7)
      .toUpperCase()
  );
}


/* =========================================================
   D1 SCHEMA
   ========================================================= */

async function bestEffortSchema(env) {

  if (!env.DB) {
    return;
  }

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
      UNIQUE(
        telegram_id,
        task_key,
        task_date
      )
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
    try {
      await env.DB
        .prepare(sql)
        .run();
    } catch (_) {}
  }

  const columns = [

    [
      "users",
      "referred_by",
      "TEXT"
    ],

    [
      "users",
      "referral_success",
      "INTEGER DEFAULT 0"
    ],

    [
      "users",
      "referral_success_at",
      "TEXT"
    ],

    [
      "users",
      "referral_bonus_credited",
      "REAL DEFAULT 0"
    ],

    [
      "users",
      "referral_earnings",
      "REAL DEFAULT 0"
    ],

    [
      "users",
      "holding_wallet",
      "REAL DEFAULT 0"
    ],

    [
      "users",
      "last_task_date",
      "TEXT"
    ],

    /*
     * Withdrawal diagnostics
     */

    [
      "withdrawals",
      "error_stage",
      "TEXT"
    ],

    [
      "withdrawals",
      "error_message",
      "TEXT"
    ],

    [
      "withdrawals",
      "error_details",
      "TEXT"
    ]
  ];

  for (
    const [
      table,
      column,
      type
    ] of columns
  ) {

    try {

      await env.DB
        .prepare(
          `ALTER TABLE ${table}
           ADD COLUMN ${column} ${type}`
        )
        .run();

    } catch (_) {}
  }
}


/* =========================================================
   USER
   ========================================================= */

async function getUser(
  env,
  telegramId
) {

  return env.DB
    .prepare(
      "SELECT * FROM users WHERE telegram_id = ?"
    )
    .bind(
      String(telegramId)
    )
    .first();
}


async function ensureUser(
  env,
  data
) {

  const telegramId =
    String(
      data.telegram_id || ""
    );

  if (!telegramId) {
    throw new Error(
      "telegram_id is required"
    );
  }

  let user =
    await getUser(
      env,
      telegramId
    );

  if (!user) {

    const referralCode =
      referralCodeForTelegramId(
        telegramId
      );

    await env.DB
      .prepare(`
        INSERT INTO users
        (
          telegram_id,
          username,
          first_name,
          wallet,
          balance,
          mined,
          mining_rate,
          level,
          referral_code,
          last_mining_at
        )
        VALUES (
          ?,
          ?,
          ?,
          NULL,
          0,
          0,
          ?,
          1,
          ?,
          ?
        )
      `)
      .bind(

        telegramId,

        data.username ||
          null,

        data.first_name ||
          "User",

        CONFIG.BASE_MINING_RATE,

        referralCode,

        nowIso()

      )
      .run();

    user =
      await getUser(
        env,
        telegramId
      );

  } else {

    await env.DB
      .prepare(`
        UPDATE users
        SET
          username = ?,
          first_name = ?,
          updated_at =
            CURRENT_TIMESTAMP
        WHERE telegram_id = ?
      `)
      .bind(

        data.username ||
          null,

        data.first_name ||
          "User",

        telegramId

      )
      .run();

    user =
      await getUser(
        env,
        telegramId
      );
  }

  return user;
}


/* =========================================================
   MINING
   ========================================================= */

async function settleMining(
  env,
  user,
  wallet = null
) {

  const now =
    Date.now();

  const last =
    user.last_mining_at
      ? new Date(
          user.last_mining_at
        ).getTime()
      : now;

  let elapsed =
    (now - last) /
    1000;

  if (
    !Number.isFinite(elapsed) ||
    elapsed < 0
  ) {
    elapsed = 0;
  }

  elapsed =
    Math.min(
      elapsed,
      86400
    );

  const pool =
    Math.max(
      0,
      num(user.balance)
    );

  const holding =
    Math.max(
      0,
      num(user.holding_wallet)
    );

  const totalAssets =
    pool + holding;

  const level =
    Math.min(
      CONFIG.MAX_LEVEL,
      Math.max(
        1,
        Math.floor(
          totalAssets /
          CONFIG.LEVEL_STEP_LNR
        ) + 1
      )
    );

  const rate =
    Math.max(
      0,
      miningRateForLevel(level)
    );

  const earned =
    (elapsed / 3600) *
    rate;

  const currentMined =
    Math.max(
      0,
      num(user.mined)
    );

  const mined =
    currentMined +
    earned;

  await env.DB
    .prepare(`
      UPDATE users
      SET
        wallet =
          COALESCE(?, wallet),

        mined = ?,

        mining_rate = ?,

        level = ?,

        last_mining_at = ?,

        updated_at =
          CURRENT_TIMESTAMP

      WHERE telegram_id = ?
    `)
    .bind(

      wallet ||
        null,

      mined,

      rate,

      level,

      nowIso(),

      String(
        user.telegram_id
      )

    )
    .run();

  return await getUser(
    env,
    user.telegram_id
  );
}


/* =========================================================
   REFERRAL
   ========================================================= */

async function attachReferral(
  env,
  user,
  referralCode
) {

  const code =
    String(
      referralCode || ""
    ).trim();

  if (
    !code ||
    user.referred_by
  ) {
    return user;
  }

  const referrer =
    await env.DB
      .prepare(
        "SELECT telegram_id FROM users WHERE referral_code = ?"
      )
      .bind(code)
      .first();

  if (
    !referrer ||
    String(
      referrer.telegram_id
    ) ===
    String(
      user.telegram_id
    )
  ) {
    return user;
  }

  try {

    await env.DB
      .prepare(`
        UPDATE users
        SET
          referred_by = ?,
          updated_at =
            CURRENT_TIMESTAMP
        WHERE telegram_id = ?
          AND (
            referred_by IS NULL
            OR referred_by = ''
          )
      `)
      .bind(

        String(
          referrer.telegram_id
        ),

        String(
          user.telegram_id
        )

      )
      .run();

  } catch (_) {}

  return await getUser(
    env,
    user.telegram_id
  );
}


async function markSuccessfulReferral(
  env,
  user
) {

  if (
    !user ||
    !user.referred_by ||
    Number(
      user.referral_success || 0
    ) === 1
  ) {
    return;
  }

  try {

    const refId =
      String(
        user.referred_by
      );

    const existing =
      await env.DB
        .prepare(`
          SELECT id
          FROM referral_bonus_ledger
          WHERE referred_telegram_id = ?
        `)
        .bind(
          String(
            user.telegram_id
          )
        )
        .first();

    if (existing) {

      await env.DB
        .prepare(`
          UPDATE users
          SET referral_success = 1
          WHERE telegram_id = ?
        `)
        .bind(
          String(
            user.telegram_id
          )
        )
        .run();

      return;
    }

    const referrer =
      await getUser(
        env,
        refId
      );

    if (!referrer) {
      return;
    }

    await env.DB
      .prepare(`
        UPDATE users
        SET
          balance =
            COALESCE(balance,0)
            + ?,

          referral_earnings =
            COALESCE(referral_earnings,0)
            + ?,

          updated_at =
            CURRENT_TIMESTAMP

        WHERE telegram_id = ?
      `)
      .bind(

        CONFIG.REFERRAL_SUCCESS_BONUS,

        CONFIG.REFERRAL_SUCCESS_BONUS,

        refId

      )
      .run();

    await env.DB
      .prepare(`
        INSERT INTO referral_bonus_ledger
        (
          referrer_telegram_id,
          referred_telegram_id,
          amount
        )
        VALUES (?, ?, ?)
      `)
      .bind(

        refId,

        String(
          user.telegram_id
        ),

        CONFIG.REFERRAL_SUCCESS_BONUS

      )
      .run();

    await env.DB
      .prepare(`
        UPDATE users
        SET
          referral_success = 1,
          referral_success_at = ?,
          referral_bonus_credited = ?,
          updated_at =
            CURRENT_TIMESTAMP
        WHERE telegram_id = ?
      `)
      .bind(

        nowIso(),

        CONFIG.REFERRAL_SUCCESS_BONUS,

        String(
          user.telegram_id
        )

      )
      .run();

  } catch (_) {

    /*
     * Referral must never break
     * wallet verification or Claim.
     */

  }
}


async function creditReferralClaimReward(
  env,
  referredUser,
  claimAmount,
  claimId
) {

  if (
    !referredUser ||
    !referredUser.referred_by ||
    claimAmount <= 0
  ) {
    return;
  }

  try {

    const reward =
      claimAmount *
      CONFIG.REFERRAL_CLAIM_PERCENT;

    if (reward <= 0) {
      return;
    }

    const claimKey =
      String(
        claimId ||
        `${referredUser.telegram_id}:${Date.now()}:${claimAmount}`
      );

    const exists =
      await env.DB
        .prepare(`
          SELECT id
          FROM referral_claim_ledger
          WHERE claim_key = ?
        `)
        .bind(claimKey)
        .first();

    if (exists) {
      return;
    }

    await env.DB
      .prepare(`
        UPDATE users
        SET
          balance =
            COALESCE(balance,0)
            + ?,

          referral_earnings =
            COALESCE(referral_earnings,0)
            + ?,

          updated_at =
            CURRENT_TIMESTAMP

        WHERE telegram_id = ?
      `)
      .bind(

        reward,

        reward,

        String(
          referredUser.referred_by
        )

      )
      .run();

    await env.DB
      .prepare(`
        INSERT INTO referral_claim_ledger
        (
          referrer_telegram_id,
          referred_telegram_id,
          claim_id,
          claim_key,
          amount
        )
        VALUES (?, ?, ?, ?, ?)
      `)
      .bind(

        String(
          referredUser.referred_by
        ),

        String(
          referredUser.telegram_id
        ),

        claimId ||
          null,

        claimKey,

        reward

      )
      .run();

  } catch (_) {}
}


/* =========================================================
   HOLDING WALLET
   ========================================================= */

async function holdingWalletBalance(
  env,
  wallet
) {

  if (
    !safeWallet(wallet)
  ) {
    return {
      ok: false,
      balance: 0
    };
  }

  const master =
    String(
      env.LNR_JETTON_MASTER ||
      LNR_MASTER
    ).trim();

  const base =
    String(
      env.TONCENTER_API_URL ||
      "https://toncenter.com"
    )
      .replace(
        /\/+$/,
        ""
      );

  const apiKey =
    String(
      env.TONCENTER_API_KEY ||
      env.TON_API_KEY ||
      ""
    ).trim();

  try {

    const url =
      `${base}/api/v3/jetton/wallets` +
      `?owner_address=${encodeURIComponent(wallet)}` +
      `&jetton_address=${encodeURIComponent(master)}` +
      `&exclude_zero_balance=true` +
      `&limit=1`;

    const headers = {
      "Accept":
        "application/json"
    };

    if (apiKey) {
      headers["X-API-Key"] =
        apiKey;
    }

    const response =
      await fetch(
        url,
        {
          method: "GET",
          headers
        }
      );

    if (!response.ok) {

      return {
        ok: false,
        balance: 0
      };
    }

    const data =
      await response.json();

    if (
      !data ||
      !Array.isArray(
        data.jetton_wallets
      )
    ) {

      return {
        ok: false,
        balance: 0
      };
    }

    const item =
      data.jetton_wallets[0];

    if (!item) {

      return {
        ok: true,
        balance: 0
      };
    }

    const raw =
      String(
        item.balance ?? "0"
      );

    const value =
      Number(raw) /
      1e6;

    if (
      !Number.isFinite(value) ||
      value < 0
    ) {

      return {
        ok: false,
        balance: 0
      };
    }

    return {
      ok: true,
      balance: value
    };

  } catch (_) {

    return {
      ok: false,
      balance: 0
    };
  }
}


async function buildUserPayload(
  env,
  user
) {

  const wallet =
    String(
      user?.wallet || ""
    );

  let holding =
    num(
      user?.holding_wallet,
      0
    );

  const chainResult =
    await holdingWalletBalance(
      env,
      wallet
    );

  if (chainResult.ok) {

    holding =
      chainResult.balance;

    try {

      await env.DB
        .prepare(
          "UPDATE users SET holding_wallet = ? WHERE telegram_id = ?"
        )
        .bind(

          holding,

          String(
            user.telegram_id
          )

        )
        .run();

    } catch (_) {}
  }

  const pool =
    num(
      user?.balance,
      0
    );

  const mined =
    num(
      user?.mined,
      0
    );

  const totalAssets =
    pool + holding;

  const level =
    Math.min(
      CONFIG.MAX_LEVEL,
      Math.max(
        1,
        Math.floor(
          totalAssets /
          CONFIG.LEVEL_STEP_LNR
        ) + 1
      )
    );

  const rate =
    miningRateForLevel(
      level
    );

  return {

    ...user,

    balance:
      pool,

    pool:
      pool,

    mined:
      mined,

    holding:
      holding,

    holding_wallet:
      holding,

    total_assets:
      totalAssets,

    level:
      level,

    mining_rate:
      rate,

    next_level_required:
      level <
      CONFIG.MAX_LEVEL
        ? levelRequiredLNR(
            level + 1
          )
        : null,

    referral_success:
      Number(
        user?.referral_success || 0
      ),

    referral_earnings:
      num(
        user?.referral_earnings,
        0
      ),

    successful_referrals:
      Number(
        user?.referral_success || 0
      )
  };
}


/* =========================================================
   USER POST
   ========================================================= */

async function handleUserPost(
  request,
  env
) {

  const data =
    await request.json();

  let user =
    await ensureUser(
      env,
      data
    );

  if (data.referral_code) {

    user =
      await attachReferral(
        env,
        user,
        data.referral_code
      );
  }

  if (
    String(
      data.referral_action || ""
    ).toLowerCase() ===
    "wallet_verified"
  ) {

    await markSuccessfulReferral(
      env,
      user
    );

    user =
      await getUser(
        env,
        user.telegram_id
      );
  }

  return json({

    success:
      true,

    user:
      await buildUserPayload(
        env,
        user
      )

  });
}


/* =========================================================
   MINE
   ========================================================= */

async function handleMine(
  request,
  env
) {

  const data =
    await request.json();

  const telegramId =
    String(
      data.telegram_id || ""
    );

  const wallet =
    String(
      data.wallet || ""
    );

  if (!telegramId) {

    return json(
      {
        success: false,
        error:
          "telegram_id is required"
      },
      400
    );
  }

  if (!wallet) {

    return json(
      {
        success: false,
        error:
          "wallet is required"
      },
      400
    );
  }

  const user =
    await getUser(
      env,
      telegramId
    );

  if (!user) {

    return json(
      {
        success: false,
        error:
          "User not found"
      },
      404
    );
  }

  const updated =
    await settleMining(
      env,
      user,
      wallet
    );

  if (
    updated.referred_by &&
    Number(
      updated.referral_success || 0
    ) !== 1
  ) {

    await markSuccessfulReferral(
      env,
      updated
    );
  }

  const finalUser =
    await getUser(
      env,
      telegramId
    );

  return json({

    success:
      true,

    earned:
      Math.max(
        0,
        num(finalUser.mined) -
        num(user.mined)
      ),

    user:
      await buildUserPayload(
        env,
        finalUser
      )

  });
}


/* =========================================================
   CLAIM
   ========================================================= */

async function handleClaim(
  request,
  env
) {

  const data =
    await request.json();

  const telegramId =
    String(
      data.telegram_id || ""
    );

  const wallet =
    String(
      data.wallet || ""
    );

  if (!telegramId) {

    return json(
      {
        success: false,
        error:
          "telegram_id is required"
      },
      400
    );
  }

  if (!wallet) {

    return json(
      {
        success: false,
        error:
          "wallet is required"
      },
      400
    );
  }

  const user =
    await getUser(
      env,
      telegramId
    );

  if (!user) {

    return json(
      {
        success: false,
        error:
          "User not found"
      },
      404
    );
  }

  const now =
    Date.now();

  const last =
    user.last_mining_at
      ? new Date(
          user.last_mining_at
        ).getTime()
      : now;

  let elapsed =
    (now - last) /
    1000;

  if (
    !Number.isFinite(elapsed) ||
    elapsed < 0
  ) {
    elapsed = 0;
  }

  elapsed =
    Math.min(
      elapsed,
      86400
    );

  const rate =
    Number(
      user.mining_rate ||
      CONFIG.BASE_MINING_RATE
    );

  const accrued =
    (elapsed / 3600) *
    rate;

  const claimAmount =
    Number(
      user.mined || 0
    ) +
    accrued;

  if (
    claimAmount <= 0
  ) {

    return json(
      {
        success: false,
        error:
          "Nothing to claim"
      },
      400
    );
  }

  const newBalance =
    Number(
      user.balance || 0
    ) +
    claimAmount;

  await env.DB
    .prepare(`
      UPDATE users
      SET
        wallet = ?,
        balance = ?,
        mined = 0,
        last_mining_at = ?,
        updated_at =
          CURRENT_TIMESTAMP
      WHERE telegram_id = ?
    `)
    .bind(

      wallet,

      newBalance,

      nowIso(),

      telegramId

    )
    .run();

  let claimId =
    null;

  try {

    const inserted =
      await env.DB
        .prepare(`
          INSERT INTO claims
          (
            telegram_id,
            amount
          )
          VALUES (?, ?)
        `)
        .bind(
          telegramId,
          claimAmount
        )
        .run();

    claimId =
      inserted?.meta?.last_row_id ??
      null;

  } catch (_) {}

  try {

    await creditReferralClaimReward(
      env,
      user,
      claimAmount,
      claimId
    );

  } catch (_) {}

  const finalUser =
    await getUser(
      env,
      telegramId
    );

  return json({

    success:
      true,

    claimed:
      claimAmount,

    user:
      await buildUserPayload(
        env,
        finalUser
      )

  });
}


/* =========================================================
   TASK
   ========================================================= */

async function handleTask(
  request,
  env
) {

  const data =
    await request.json();

  const telegramId =
    String(
      data.telegram_id || ""
    );

  const taskKey =
    String(
      data.task_key ||
      "daily"
    );

  if (!telegramId) {

    return json(
      {
        success: false,
        error:
          "telegram_id is required"
      },
      400
    );
  }

  const user =
    await getUser(
      env,
      telegramId
    );

  if (!user) {

    return json(
      {
        success: false,
        error:
          "User not found"
      },
      404
    );
  }

  const today =
    new Date()
      .toISOString()
      .slice(
        0,
        10
      );

  try {

    const existing =
      await env.DB
        .prepare(`
          SELECT id
          FROM daily_tasks
          WHERE telegram_id = ?
            AND task_key = ?
            AND task_date = ?
        `)
        .bind(
          telegramId,
          taskKey,
          today
        )
        .first();

    if (existing) {

      return json(
        {
          success: false,
          error:
            "Task already claimed",

          user:
            await buildUserPayload(
              env,
              user
            )
        },
        400
      );
    }

    await env.DB
      .prepare(`
        UPDATE users
        SET
          balance =
            COALESCE(balance,0)
            + ?,

          last_task_date = ?,

          updated_at =
            CURRENT_TIMESTAMP

        WHERE telegram_id = ?
      `)
      .bind(
        CONFIG.DAILY_TASK_REWARD,
        today,
        telegramId
      )
      .run();

    await env.DB
      .prepare(`
        INSERT INTO daily_tasks
        (
          telegram_id,
          task_key,
          task_date,
          reward
        )
        VALUES (?, ?, ?, ?)
      `)
      .bind(
        telegramId,
        taskKey,
        today,
        CONFIG.DAILY_TASK_REWARD
      )
      .run();

  } catch (e) {

    return json(
      {
        success: false,
        error:
          e.message ||
          "Task failed"
      },
      500
    );
  }

  const updated =
    await getUser(
      env,
      telegramId
    );

  return json({

    success:
      true,

    reward:
      CONFIG.DAILY_TASK_REWARD,

    user:
      await buildUserPayload(
        env,
        updated
      )

  });
}


/* =========================================================
   WITHDRAW REQUEST
   ========================================================= */

async function handleWithdraw(
  request,
  env
) {

  const data =
    await request.json();

  const telegramId =
    String(
      data.telegram_id || ""
    );

  const wallet =
    String(
      data.wallet || ""
    ).trim();

  if (!telegramId) {

    return json(
      {
        success: false,
        error:
          "telegram_id is required"
      },
      400
    );
  }

  if (!wallet) {

    return json(
      {
        success: false,
        error:
          "wallet is required"
      },
      400
    );
  }

  if (!isValidTonAddress(wallet)) {

    return json(
      {
        success: false,
        error:
          "Invalid withdrawal wallet"
      },
      400
    );
  }

  const user =
    await getUser(
      env,
      telegramId
    );

  if (!user) {

    return json(
      {
        success: false,
        error:
          "User not found"
      },
      404
    );
  }

  const amount =
    num(data.amount);

  if (
    amount <
    CONFIG.WITHDRAWAL_MIN
  ) {

    return json(
      {
        success: false,
        error:
          `Minimum withdrawal is ${CONFIG.WITHDRAWAL_MIN} LNR`
      },
      400
    );
  }

  const balance =
    num(user.balance);

  if (
    balance <
    amount
  ) {

    return json(
      {
        success: false,
        error:
          "Insufficient balance"
      },
      400
    );
  }

  const net =
    Math.max(
      0,
      amount -
      CONFIG.WITHDRAWAL_FEE
    );

  try {

    /*
     * Deduct from Pool Wallet.
     */

    const update =
      await env.DB
        .prepare(`
          UPDATE users
          SET
            balance =
              balance - ?,

            updated_at =
              CURRENT_TIMESTAMP

          WHERE telegram_id = ?
            AND balance >= ?
        `)
        .bind(
          amount,
          telegramId,
          amount
        )
        .run();

    if (
      Number(
        update?.meta?.changes || 0
      ) !== 1
    ) {

      return json(
        {
          success: false,
          error:
            "Balance changed before withdrawal"
        },
        409
      );
    }

    await env.DB
      .prepare(`
        INSERT INTO withdrawals
        (
          telegram_id,
          wallet,
          requested_amount,
          fee,
          payout_amount,
          status,
          error_stage,
          error_message,
          error_details
        )
        VALUES (
          ?,
          ?,
          ?,
          ?,
          ?,
          'pending',
          NULL,
          NULL,
          NULL
        )
      `)
      .bind(
        telegramId,
        wallet,
        amount,
        CONFIG.WITHDRAWAL_FEE,
        net
      )
      .run();

  } catch (e) {

    /*
     * If DB insertion fails after balance deduction,
     * refund immediately.
     */

    try {

      await env.DB
        .prepare(`
          UPDATE users
          SET
            balance =
              COALESCE(balance,0)
              + ?,

            updated_at =
              CURRENT_TIMESTAMP

          WHERE telegram_id = ?
        `)
        .bind(
          amount,
          telegramId
        )
        .run();

    } catch (_) {}

    return json(
      {
        success: false,
        error:
          e.message ||
          "Withdrawal failed"
      },
      500
    );
  }

  const updated =
    await getUser(
      env,
      telegramId
    );

  return json({

    success:
      true,

    withdrawal: {

      amount,

      requested_amount:
        amount,

      fee:
        CONFIG.WITHDRAWAL_FEE,

      net_amount:
        net,

      payout_amount:
        net,

      status:
        "pending",

      wallet

    },

    user:
      await buildUserPayload(
        env,
        updated
      )

  });
}


/* =========================================================
   REFERRAL
   ========================================================= */

async function handleReferral(
  request,
  env
) {

  const url =
    new URL(
      request.url
    );

  const telegramId =
    String(
      url.searchParams.get(
        "telegram_id"
      ) || ""
    );

  if (!telegramId) {

    return json(
      {
        success: false,
        error:
          "telegram_id is required"
      },
      400
    );
  }

  const user =
    await getUser(
      env,
      telegramId
    );

  if (!user) {

    return json(
      {
        success: false,
        error:
          "User not found"
      },
      404
    );
  }

  const successful =
    Number(
      user.referral_success || 0
    );

  const earnings =
    num(
      user.referral_earnings,
      0
    );

  return json({

    success:
      true,

    referral_code:
      user.referral_code,

    referral_link:
      `https://t.me/${CONFIG.BOT_USERNAME}?start=${encodeURIComponent(
        user.referral_code || ""
      )}`,

    successful_referrals:
      successful,

    referral_earnings:
      earnings,

    success_bonus:
      CONFIG.REFERRAL_SUCCESS_BONUS,

    claim_percent:
      CONFIG.REFERRAL_CLAIM_PERCENT

  });
}


/* =========================================================
   WITHDRAWAL HISTORY
   ========================================================= */

async function handleWithdrawals(
  request,
  env
) {

  const url =
    new URL(
      request.url
    );

  const telegramId =
    url.searchParams.get(
      "telegram_id"
    );

  if (!telegramId) {

    return json(
      {
        success: false,
        error:
          "telegram_id is required"
      },
      400
    );
  }

  try {

    const result =
      await env.DB
        .prepare(`
          SELECT
            id,
            wallet,

            requested_amount,

            requested_amount
              AS amount,

            fee,

            payout_amount,

            payout_amount
              AS net_amount,

            status,

            tx_hash,

            error_stage,

            error_message,

            error_details,

            created_at,

            completed_at,

            completed_at
              AS processed_at

          FROM withdrawals

          WHERE telegram_id = ?

          ORDER BY id DESC

          LIMIT 100
        `)
        .bind(
          telegramId
        )
        .all();

    return json({

      success:
        true,

      withdrawals:
        result.results || []

    });

  } catch (e) {

    return json(
      {
        success: false,
        error:
          e.message ||
          "Unable to load withdrawals"
      },
      500
    );
  }
}


/* =========================================================
   MINERS
   ========================================================= */

async function handleMiners(
  env
) {

  const levels = [];

  for (
    let level = 1;
    level <= CONFIG.MAX_LEVEL;
    level++
  ) {

    levels.push({

      level,

      required_lnr:
        levelRequiredLNR(
          level
        ),

      mining_rate:
        miningRateForLevel(
          level
        )

    });
  }

  return json({

    success:
      true,

    max_level:
      CONFIG.MAX_LEVEL,

    level_step_lnr:
      CONFIG.LEVEL_STEP_LNR,

    levels

  });
}


/* =========================================================
   WITHDRAWAL ERROR STORAGE
   ========================================================= */

async function saveWithdrawalError(
  env,
  id,
  stage,
  error,
  details = null
) {

  const message =
    String(
      error?.message ||
      error ||
      "Unknown withdrawal error"
    );

  let detailText =
    details;

  try {

    if (
      detailText !== null &&
      typeof detailText !==
      "string"
    ) {

      detailText =
        JSON.stringify(
          detailText
        );
    }

  } catch (_) {

    detailText =
      String(
        detailText
      );
  }

  try {

    await env.DB
      .prepare(`
        UPDATE withdrawals
        SET
          error_stage = ?,
          error_message = ?,
          error_details = ?

        WHERE id = ?
      `)
      .bind(

        String(
          stage ||
          "unknown"
        ),

        message,

        detailText ||
          null,

        id

      )
      .run();

  } catch (_) {}

  return {
    stage:
      String(
        stage ||
        "unknown"
      ),

    message,

    details:
      detailText ||
      null
  };
}


/* =========================================================
   WITHDRAWAL FAILURE + REFUND
   ========================================================= */

async function failWithdrawalAndRefund(
  env,
  withdrawal,
  stage,
  error,
  details = null
) {

  const id =
    Number(
      withdrawal.id
    );

  const telegramId =
    String(
      withdrawal.telegram_id ||
      ""
    );

  const requestedAmount =
    Number(
      withdrawal.requested_amount ??
      withdrawal.amount
    );

  const saved =
    await saveWithdrawalError(
      env,
      id,
      stage,
      error,
      details
    );

  const failed =
    await env.DB
      .prepare(`
        UPDATE withdrawals

        SET
          status = 'failed',
          completed_at =
            CURRENT_TIMESTAMP

        WHERE id = ?
          AND status = 'processing'
      `)
      .bind(id)
      .run();

  const changed =
    Number(
      failed?.meta?.changes || 0
    );

  let refunded =
    false;

  if (
    changed === 1 &&
    Number.isFinite(
      requestedAmount
    ) &&
    requestedAmount > 0 &&
    telegramId
  ) {

    await env.DB
      .prepare(`
        UPDATE users

        SET
          balance =
            COALESCE(balance,0)
            + ?,

          updated_at =
            CURRENT_TIMESTAMP

        WHERE telegram_id = ?
      `)
      .bind(
        requestedAmount,
        telegramId
      )
      .run();

    refunded =
      true;
  }

  return {

    success:
      false,

    withdrawal_id:
      id,

    error_stage:
      saved.stage,

    error_message:
      saved.message,

    error_details:
      saved.details,

    refunded

  };
}


/* =========================================================
   PROCESS ONE WITHDRAWAL
   ========================================================= */

async function processWithdrawal(
  env,
  withdrawal
) {

  const id =
    Number(
      withdrawal.id
    );

  const payout =
    Number(
      withdrawal.payout_amount ??
      withdrawal.net_amount
    );

  const requestedAmount =
    Number(
      withdrawal.requested_amount ??
      withdrawal.amount
    );

  const wallet =
    String(
      withdrawal.wallet ||
      ""
    ).trim();

  const telegramId =
    String(
      withdrawal.telegram_id ||
      ""
    ).trim();


  /*
   * Lock row.
   */

  const lock =
    await env.DB
      .prepare(`
        UPDATE withdrawals

        SET
          status = 'processing',
          error_stage = NULL,
          error_message = NULL,
          error_details = NULL

        WHERE id = ?
          AND status = 'pending'
      `)
      .bind(id)
      .run();

  if (
    Number(
      lock?.meta?.changes || 0
    ) !== 1
  ) {

    return {
      skipped:
        true,

      reason:
        "already_processing_or_completed"
    };
  }


  /*
   * Stage 1:
   * Validation
   */

  try {

    if (!wallet) {

      throw new Error(
        "Withdrawal wallet is empty"
      );
    }

    if (
      !isValidTonAddress(
        wallet
      )
    ) {

      throw new Error(
        "Invalid withdrawal wallet"
      );
    }

    if (
      !Number.isFinite(
        payout
      ) ||
      payout <= 0
    ) {

      throw new Error(
        "Invalid payout amount"
      );
    }

  } catch (error) {

    return await failWithdrawalAndRefund(
      env,
      withdrawal,
      "validation",
      error,
      {
        wallet,
        payout,
        requestedAmount
      }
    );
  }


  /*
   * Stage 2:
   * Treasury + Jetton wallet
   */

  let treasuryInfo;

  try {

    treasuryInfo =
      await getTreasuryJettonWallet(
        env
      );

  } catch (error) {

    return await failWithdrawalAndRefund(
      env,
      withdrawal,
      "treasury",
      error,
      {
        treasuryOwner:
          TREASURY_OWNER,

        lnrMaster:
          LNR_MASTER
      }
    );
  }


  /*
   * Stage 3:
   * Send Jetton
   */

  let sendResult;

  try {

    sendResult =
      await sendLnr(
        env,
        wallet,
        payout
      );

  } catch (error) {

    return await failWithdrawalAndRefund(
      env,
      withdrawal,
      "send_transfer",
      error,
      {
        wallet,
        payout,
        treasury:
          treasuryInfo
            ?.treasury
            ?.wallet
            ?.address
            ?.toString(),

        jettonWallet:
          treasuryInfo
            ?.jettonWalletAddress
            ?.toString(),

        lnrMaster:
          LNR_MASTER
      }
    );
  }


  /*
   * IMPORTANT:
   *
   * From this point the transaction may already
   * have been broadcast.
   *
   * We MUST NOT blindly refund if confirmation
   * becomes ambiguous.
   */

  let seqnoConfirmed =
    false;

  /*
   * Stage 4:
   * Wait for external transaction
   */

  try {

    await waitForSeqnoAdvance(

      treasuryInfo.client,

      treasuryInfo.treasury.wallet,

      sendResult.seqno,

      120000

    );

    seqnoConfirmed =
      true;

  } catch (error) {

    /*
     * The transfer may have been broadcast
     * even though confirmation polling failed.
     *
     * Therefore DO NOT REFUND.
     */

    await saveWithdrawalError(
      env,
      id,
      "confirmation",
      error,
      {
        seqno:
          sendResult.seqno,

        treasury:
          treasuryInfo
            .treasury
            .wallet
            .address
            .toString(),

        note:
          "Transfer may already have been broadcast; automatic refund was intentionally skipped."
      }
    );

    await env.DB
      .prepare(`
        UPDATE withdrawals

        SET
          status = 'needs_review',
          completed_at =
            CURRENT_TIMESTAMP

        WHERE id = ?
          AND status = 'processing'
      `)
      .bind(id)
      .run();

    return {

      success:
        false,

      withdrawal_id:
        id,

      error_stage:
        "confirmation",

      error_message:
        error?.message ||
        "Treasury transaction confirmation timeout",

      refunded:
        false,

      needs_review:
        true
    };
  }


  /*
   * Stage 5:
   * Find transaction hash
   */

  let txHash =
    null;

  try {

    await sleep(3000);

    txHash =
      await findRecentTransactionHash(
        env,
        treasuryInfo
          .treasury
          .wallet
          .address
      );

  } catch (error) {

    /*
     * The transaction is already confirmed
     * by seqno.
     *
     * Do not refund.
     */

    await saveWithdrawalError(
      env,
      id,
      "tx_lookup",
      error,
      {
        seqno:
          sendResult.seqno,

        note:
          "Treasury seqno advanced, but transaction hash lookup failed."
      }
    );
  }


  /*
   * Stage 6:
   * Complete withdrawal
   */

  try {

    await env.DB
      .prepare(`
        UPDATE withdrawals

        SET
          status = 'completed',

          tx_hash = ?,

          error_stage = NULL,

          error_message = NULL,

          error_details = NULL,

          completed_at =
            CURRENT_TIMESTAMP

        WHERE id = ?
          AND status = 'processing'
      `)
      .bind(
        txHash,
        id
      )
      .run();

  } catch (error) {

    /*
     * The chain transfer is already confirmed.
     * Never refund here.
     */

    await saveWithdrawalError(
      env,
      id,
      "database",
      error,
      {
        seqno:
          sendResult.seqno,

        txHash
      }
    );

    return {

      success:
        false,

      withdrawal_id:
        id,

      error_stage:
        "database",

      error_message:
        error?.message ||
        "Unable to save completed withdrawal",

      refunded:
        false,

      needs_review:
        true,

      seqnoConfirmed
    };
  }


  return {

    success:
      true,

    withdrawal_id:
      id,

    telegram_id:
      telegramId,

    payout,

    tx_hash:
      txHash,

    seqno:
      sendResult.seqno

  };
}


/* =========================================================
   PROCESS PENDING WITHDRAWALS
   ========================================================= */

async function processPendingWithdrawals(
  env
) {

  const rows =
    await env.DB
      .prepare(`
        SELECT
          id,
          telegram_id,
          wallet,
          requested_amount,
          payout_amount,
          status,
          tx_hash,
          created_at

        FROM withdrawals

        WHERE status = 'pending'

        ORDER BY id ASC

        LIMIT 5
      `)
      .all();

  const results = [];

  for (
    const withdrawal of
    (
      rows?.results ||
      []
    )
  ) {

    try {

      results.push(
        await processWithdrawal(
          env,
          withdrawal
        )
      );

    } catch (error) {

      /*
       * Last-resort protection.
       *
       * We don't let one withdrawal crash
       * the whole Cron execution.
       */

      try {

        await saveWithdrawalError(
          env,
          Number(
            withdrawal.id
          ),
          "unexpected",
          error,
          {
            message:
              error?.message,

            stack:
              error?.stack ||
              null
          }
        );

      } catch (_) {}

      results.push({

        success:
          false,

        withdrawal_id:
          Number(
            withdrawal.id
          ),

        error_stage:
          "unexpected",

        error_message:
          error?.message ||
          "Unexpected withdrawal error",

        refunded:
          false

      });
    }

    await sleep(1000);
  }

  return results;
}


/* =========================================================
   MAIN WORKER
   ========================================================= */

export default {

  async fetch(
    request,
    env
  ) {

    if (
      request.method ===
      "OPTIONS"
    ) {

      return new Response(
        null,
        {
          status: 204,
          headers:
            corsHeaders
        }
      );
    }

    const url =
      new URL(
        request.url
      );

    const path =
      url.pathname;


    /* =====================================================
       HEALTH
       ===================================================== */

    if (
      path === "/" &&
      request.method === "GET"
    ) {

      return json({

        success:
          true,

        app:
          "LUNARO",

        api:
          "running",

        version:
          "withdrawal-debug-v1"

      });
    }


    if (
      path === "/health" &&
      request.method === "GET"
    ) {

      return json({

        success:
          true,

        service:
          "LUNARO API",

        version:
          "withdrawal-debug-v1",

        time:
          nowIso()

      });
    }


    /* =====================================================
       CONFIG
       ===================================================== */

    if (
      path === "/config" &&
      request.method === "GET"
    ) {

      return json({

        success:
          true,

        bot_username:
          CONFIG.BOT_USERNAME,

        max_level:
          CONFIG.MAX_LEVEL,

        level_step_lnr:
          CONFIG.LEVEL_STEP_LNR,

        withdrawal_min:
          CONFIG.WITHDRAWAL_MIN,

        withdrawal_fee:
          CONFIG.WITHDRAWAL_FEE,

        withdrawal_net:
          CONFIG.WITHDRAWAL_NET,

        referral_success_bonus:
          CONFIG.REFERRAL_SUCCESS_BONUS,

        referral_claim_percent:
          CONFIG.REFERRAL_CLAIM_PERCENT

      });
    }


    /* =====================================================
       PRICE
       ===================================================== */

    if (
      path === "/price" &&
      request.method === "GET"
    ) {

      return json({

        success:
          true,

        symbol:
          "LNR",

        reference_price_usdt:
          num(
            env.LNR_REFERENCE_PRICE,
            CONFIG.DEFAULT_LNR_PRICE
          ),

        source:
          env.LNR_REFERENCE_PRICE
            ? "env"
            : "reference"

      });
    }


    /*
     * Best-effort schema.
     */

    try {

      await bestEffortSchema(
        env
      );

    } catch (_) {}


    try {

      /* ===================================================
         USER
         =================================================== */

      if (
        path === "/user" &&
        request.method === "POST"
      ) {

        return await handleUserPost(
          request,
          env
        );
      }


      if (
        path === "/user" &&
        request.method === "GET"
      ) {

        const telegramId =
          url.searchParams.get(
            "telegram_id"
          );

        if (!telegramId) {

          return json(
            {
              success: false,
              error:
                "telegram_id is required"
            },
            400
          );
        }

        const user =
          await getUser(
            env,
            telegramId
          );

        if (!user) {

          return json(
            {
              success: false,
              error:
                "User not found"
            },
            404
          );
        }

        return json({

          success:
            true,

          user:
            await buildUserPayload(
              env,
              user
            )

        });
      }


      /* ===================================================
         MINE
         =================================================== */

      if (
        path === "/mine" &&
        request.method === "POST"
      ) {

        return await handleMine(
          request,
          env
        );
      }


      /* ===================================================
         CLAIM
         =================================================== */

      if (
        path === "/claim" &&
        request.method === "POST"
      ) {

        return await handleClaim(
          request,
          env
        );
      }


      /* ===================================================
         TASK
         =================================================== */

      if (
        path === "/task" &&
        request.method === "POST"
      ) {

        return await handleTask(
          request,
          env
        );
      }


      /* ===================================================
         WITHDRAW
         =================================================== */

      if (
        path === "/withdraw" &&
        request.method === "POST"
      ) {

        return await handleWithdraw(
          request,
          env
        );
      }


      /* ===================================================
         REFERRAL
         =================================================== */

      if (
        path === "/referral" &&
        (
          request.method === "GET" ||
          request.method === "POST"
        )
      ) {

        return await handleReferral(
          request,
          env
        );
      }


      /* ===================================================
         WITHDRAWAL HISTORY
         =================================================== */

      if (
        path === "/withdrawals" &&
        request.method === "GET"
      ) {

        return await handleWithdrawals(
          request,
          env
        );
      }


      /* ===================================================
         MINERS
         =================================================== */

      if (
        path === "/miners" &&
        request.method === "GET"
      ) {

        return await handleMiners(
          env
        );
      }


      /* ===================================================
         MANUAL PROCESS ENDPOINT
         =================================================== */

      if (
        path === "/process-withdrawals" &&
        request.method === "POST"
      ) {

        const secret =
          request.headers.get(
            "X-LNR-CRON-SECRET"
          );

        if (
          !env.LNR_CRON_SECRET ||
          secret !==
            env.LNR_CRON_SECRET
        ) {

          return json(
            {
              success: false,
              error:
                "Unauthorized"
            },
            401
          );
        }

        return json({

          success:
            true,

          results:
            await processPendingWithdrawals(
              env
            )

        });
      }


      return json(
        {
          success: false,
          error:
            "Not Found"
        },
        404
      );

    } catch (error) {

      console.error(
        "LUNARO API error:",
        error
      );

      return json(
        {
          success: false,
          error:
            error?.message ||
            "Internal Server Error"
        },
        500
      );
    }
  },


  /* =====================================================
     CLOUDFLARE CRON
     ===================================================== */

  async scheduled(
    event,
    env,
    ctx
  ) {

    ctx.waitUntil(

      (async () => {

        try {

          const results =
            await processPendingWithdrawals(
              env
            );

          console.log(
            "LNR auto-withdraw results:",
            JSON.stringify(
              results
            )
          );

        } catch (error) {

          console.error(
            "LNR auto-withdraw error:",
            error
          );
        }

      })()

    );
  }

};
