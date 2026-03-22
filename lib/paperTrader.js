import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { formatMoney, formatPrice, scanNewCoins } from "@/lib/scanner";
import { isTelegramEnabled, sendTelegramMessage } from "@/lib/telegram";

const FAST_PRICE_INTERVAL_MS = 2000;
function resolveStateDir() {
  if (process.env.RISK_ONE_3X_STATE_DIR) {
    return process.env.RISK_ONE_3X_STATE_DIR;
  }

  if (process.env.NODE_ENV !== "production") {
    return path.join(process.cwd(), ".data");
  }

  return path.join(os.tmpdir(), "risk-one-3x-data");
}

const STATE_DIR = resolveStateDir();
const STATE_FILE = path.join(STATE_DIR, "risk-one-3x-state.json");

function defaultStore() {
  return {
    running: false,
    starting: false,
    intervalSeconds: 10,
    solUsd: 130,
    initialBalanceSol: 1,
    cashUsd: 130,
    closedCount: 0,
    openCount: 0,
    positions: {},
    closedPositions: [],
    notifiedSignals: {},
    lastSignals: [],
    lastUpdatedAt: null,
    lastLog: [],
    timer: null
    ,
    priceTimer: null
  };
}

function persistStore(store) {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(
      STATE_FILE,
      JSON.stringify({
        running: store.running,
        starting: store.starting,
        intervalSeconds: store.intervalSeconds,
        solUsd: store.solUsd,
        initialBalanceSol: store.initialBalanceSol,
        cashUsd: store.cashUsd,
        closedCount: store.closedCount,
        openCount: store.openCount,
        positions: store.positions,
        closedPositions: store.closedPositions,
        notifiedSignals: store.notifiedSignals,
        lastSignals: store.lastSignals,
        lastUpdatedAt: store.lastUpdatedAt,
        lastLog: store.lastLog
      })
    );
  } catch {
    // Serverless ortamlarda disk yazma garantisi yok; state bellekte devam eder.
  }
}

function loadPersistedStore() {
  if (!existsSync(STATE_FILE)) {
    return defaultStore();
  }

  try {
    const persisted = JSON.parse(readFileSync(STATE_FILE, "utf-8"));
    return {
      ...defaultStore(),
      ...persisted,
      timer: null
    };
  } catch {
    return defaultStore();
  }
}

function getStore() {
  if (!globalThis.__RISK_ONE_3X__) {
    globalThis.__RISK_ONE_3X__ = loadPersistedStore();
    if (globalThis.__RISK_ONE_3X__.running && !globalThis.__RISK_ONE_3X__.timer) {
      scheduleLoop(globalThis.__RISK_ONE_3X__);
      tick().catch((error) => pushLog(globalThis.__RISK_ONE_3X__, `HATA ${error.message}`));
    }
  }
  return globalThis.__RISK_ONE_3X__;
}

function pushLog(store, message) {
  store.lastLog = [{ at: new Date().toISOString(), message }, ...store.lastLog].slice(0, 60);
  persistStore(store);
}

function portfolioValue(store) {
  return store.cashUsd + Object.values(store.positions).reduce((sum, item) => sum + item.valueUsd, 0);
}

function serializePosition(position) {
  return {
    ...position,
    entryPrice: Number(position.entryPrice),
    currentPrice: Number(position.currentPrice),
    allocationUsd: Number(position.allocationUsd),
    riskUsd: Number(position.riskUsd),
    tokenAmount: Number(position.tokenAmount),
    takeProfitPrice: Number(position.takeProfitPrice),
    stopLossPrice: Number(position.stopLossPrice),
    entryLiquidityUsd: Number(position.entryLiquidityUsd || 0),
    currentLiquidityUsd: Number(position.currentLiquidityUsd || 0),
    valueUsd: Number(position.valueUsd),
    pnlPct: Number(position.pnlPct)
  };
}

async function tick() {
  const store = getStore();
  const result = await scanNewCoins();
  for (const signal of result.signals) {
    if (signal.entry !== "NOW" || !signal.priceRaw) {
      continue;
    }
    if (store.notifiedSignals[signal.pairAddress]) {
      continue;
    }

    const message = `SINYAL ${signal.symbol} | Fiyat: $${formatPrice(signal.priceRaw)} | Likidite: $${formatMoney(signal.liquidityRaw)} | Hacim 5dk: $${formatMoney(signal.volume5mRaw)} | Skor: ${signal.score}`;
    pushLog(store, message);

    try {
      const telegramResult = await sendTelegramMessage(
        [
          "Yeni sinyal",
          `${signal.name} (${signal.symbol})`,
          `Fiyat: $${formatPrice(signal.priceRaw)}`,
          `Likidite: $${formatMoney(signal.liquidityRaw)}`,
          `Hacim 5dk: $${formatMoney(signal.volume5mRaw)}`,
          `Skor: ${signal.score}`,
          `Guven: ${signal.confidence}`,
          `Pair: ${signal.pairAddress}`
        ].join("\n")
      );
      if (telegramResult.ok) {
        store.notifiedSignals[signal.pairAddress] = new Date().toISOString();
      }
    } catch (error) {
      pushLog(store, `TELEGRAM HATA ${error.message}`);
    }
  }

  store.positions = {};
  store.closedPositions = [];
  store.openCount = 0;
  store.closedCount = 0;
  store.starting = false;
  store.lastSignals = result.signals;
  store.lastUpdatedAt = new Date().toISOString();
  persistStore(store);
}

function clearTimer(store) {
  if (store.timer) {
    clearInterval(store.timer);
    store.timer = null;
  }
  if (store.priceTimer) {
    clearInterval(store.priceTimer);
    store.priceTimer = null;
  }
}

function scheduleLoop(store) {
  clearTimer(store);
  store.timer = setInterval(() => {
    tick().catch((error) => pushLog(store, `HATA ${error.message}`));
  }, store.intervalSeconds * 1000);
  store.priceTimer = setInterval(() => {
    refreshOpenPositionPrices().catch((error) => pushLog(store, `HATA ${error.message}`));
  }, FAST_PRICE_INTERVAL_MS);
}

async function refreshOpenPositionPrices() {
  return;
}

export async function startPaperTrader({ initialBalanceSol = 1, solUsd = 130, intervalSeconds = 10 } = {}) {
  const store = getStore();
  if (store.running || store.starting) {
    pushLog(store, "Motor zaten aktif. Mevcut pozisyonlar korunuyor.");
    return getPaperTraderState();
  }

  clearTimer(store);
  store.running = true;
  store.starting = true;
  store.intervalSeconds = intervalSeconds;
  store.solUsd = solUsd;
  store.initialBalanceSol = initialBalanceSol;
  store.cashUsd = initialBalanceSol * solUsd;
  store.closedCount = 0;
  store.openCount = 0;
  store.positions = {};
  store.closedPositions = [];
  store.notifiedSignals = {};
  store.lastSignals = [];
  store.lastUpdatedAt = null;
  store.lastLog = [];
  persistStore(store);
  pushLog(
    store,
    `Motor baslatiliyor. Dexscreener taramasi yapiliyor... Telegram ${isTelegramEnabled() ? "aktif" : "kapali"}`
  );

  await tick();
  pushLog(store, "Motor aktif. Yeni coinler izleniyor.");
  scheduleLoop(store);
  persistStore(store);

  return getPaperTraderState();
}

export function stopPaperTrader() {
  const store = getStore();
  clearTimer(store);
  store.running = false;
  store.starting = false;
  persistStore(store);
  pushLog(store, "Sinyal motoru durduruldu.");
  return getPaperTraderState();
}

export function getPaperTraderState() {
  const store = getStore();
  const totalUsd = portfolioValue(store);

  return {
    running: store.running,
    starting: store.starting,
    intervalSeconds: store.intervalSeconds,
    solUsd: store.solUsd,
    initialBalanceSol: store.initialBalanceSol,
    cashUsd: Number(store.cashUsd),
    portfolioUsd: Number(totalUsd),
    balanceSol: Number(store.solUsd > 0 ? totalUsd / store.solUsd : 0),
    closedCount: store.closedCount,
    openCount: store.openCount,
    telegramEnabled: isTelegramEnabled(),
    riskPerTradePct: 0,
    takeProfitMultiple: 0,
    stopLossPct: 0,
    openPositions: Object.values(store.positions).map(serializePosition),
    closedPositions: store.closedPositions.map(serializePosition),
    allPositions: [
      ...Object.values(store.positions).map((position) => ({ ...serializePosition(position), status: "open" })),
      ...store.closedPositions.map((position) => ({ ...serializePosition(position), status: "closed" }))
    ],
    lastSignals: store.lastSignals,
    lastUpdatedAt: store.lastUpdatedAt,
    lastLog: store.lastLog
  };
}
