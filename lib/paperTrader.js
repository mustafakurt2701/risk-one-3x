import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fetchPairsByPairAddress, formatMoney, formatPrice, scanNewCoins } from "@/lib/scanner";

const STOP_LOSS_PCT = 0.5;
const TAKE_PROFIT_MULTIPLIER = 2;
const RISK_PER_TRADE = 0.1;
const MAX_OPEN_POSITIONS = 3;
const FAST_PRICE_INTERVAL_MS = 2000;
const TP_CONFIRM_TICKS = 3;
const RUG_LIQUIDITY_FLOOR = 0.35;
const HARD_RUG_PRICE_FLOOR = 0.15;
const MAX_REALIZABLE_LIQUIDITY_SHARE = 0.2;
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

function positionSizeUsd(totalPortfolioUsd) {
  const riskUsd = totalPortfolioUsd * RISK_PER_TRADE;
  return {
    riskUsd,
    allocationUsd: riskUsd / STOP_LOSS_PCT
  };
}

function realizableValueUsd(position, currentPrice, currentLiquidityUsd) {
  const markedValue = position.tokenAmount * currentPrice;
  if (!currentLiquidityUsd || currentLiquidityUsd <= 0) {
    return Math.min(markedValue, position.allocationUsd);
  }
  return Math.min(markedValue, currentLiquidityUsd * MAX_REALIZABLE_LIQUIDITY_SHARE);
}

function canConfirmTakeProfit(position, currentPrice, currentLiquidityUsd) {
  if (currentPrice < position.takeProfitPrice) {
    return false;
  }
  if ((position.tpCandidateTicks || 0) < TP_CONFIRM_TICKS) {
    return false;
  }
  if (!currentLiquidityUsd || currentLiquidityUsd <= 0) {
    return false;
  }

  const minRequiredLiquidity = Math.max(
    position.allocationUsd * 3,
    position.entryLiquidityUsd > 0 ? position.entryLiquidityUsd * 0.5 : 0
  );

  if (currentLiquidityUsd < minRequiredLiquidity) {
    return false;
  }

  const realizableValue = realizableValueUsd(position, currentPrice, currentLiquidityUsd);
  return realizableValue >= position.allocationUsd * 2.5;
}

async function tick() {
  const store = getStore();
  const result = await scanNewCoins();
  const signalMap = new Map(result.signals.map((signal) => [signal.pairAddress, signal]));

  for (const [address, position] of Object.entries(store.positions)) {
    const live = signalMap.get(address);
    const currentPrice = live?.priceRaw || position.currentPrice;
    const currentLiquidityUsd = Number(live?.liquidityRaw || position.currentLiquidityUsd || position.entryLiquidityUsd || 0);
    position.currentPrice = currentPrice;
    position.currentLiquidityUsd = currentLiquidityUsd;
    position.valueUsd = realizableValueUsd(position, currentPrice, currentLiquidityUsd);
    position.pnlPct = ((currentPrice / position.entryPrice) - 1) * 100;
    position.tpCandidateTicks = currentPrice >= position.takeProfitPrice ? (position.tpCandidateTicks || 0) + 1 : 0;

    const rugDetected =
      currentPrice <= position.entryPrice * HARD_RUG_PRICE_FLOOR ||
      (position.entryLiquidityUsd > 0 && currentLiquidityUsd > 0 && currentLiquidityUsd <= position.entryLiquidityUsd * RUG_LIQUIDITY_FLOOR);
    const hitTp = canConfirmTakeProfit(position, currentPrice, currentLiquidityUsd);
    const hitSl = currentPrice <= position.stopLossPrice;

    if (hitTp || hitSl || rugDetected) {
      store.cashUsd += position.valueUsd;
      store.closedCount += 1;
      store.closedPositions = [
        {
          ...position,
          closedAt: new Date().toISOString(),
          closeReason: rugDetected ? "RUG" : hitTp ? "TP 2x" : "SL"
        },
        ...store.closedPositions
      ].slice(0, 200);
      pushLog(
        store,
        `KAPANDI ${position.symbol} ${rugDetected ? "RUG" : hitTp ? "TP 2x" : "SL"} | Deger: $${formatMoney(position.valueUsd)} | PnL: ${position.pnlPct.toFixed(2)}%`
      );
      delete store.positions[address];
      persistStore(store);
    }
  }

  const openCount = Object.keys(store.positions).length;
  const freeSlots = Math.max(0, MAX_OPEN_POSITIONS - openCount);

  if (freeSlots > 0) {
    for (const signal of result.signals) {
      if (Object.keys(store.positions).length >= MAX_OPEN_POSITIONS) {
        break;
      }
      if (store.positions[signal.pairAddress]) {
        continue;
      }
      if (!signal.priceRaw) {
        continue;
      }
      if (signal.entry !== "NOW") {
        continue;
      }

      const totalPortfolioUsd = portfolioValue(store);
      const sizing = positionSizeUsd(totalPortfolioUsd);
      if (store.cashUsd < sizing.allocationUsd) {
        continue;
      }

      const tokenAmount = sizing.allocationUsd / signal.priceRaw;
      store.positions[signal.pairAddress] = {
        pairAddress: signal.pairAddress,
        name: signal.name,
        symbol: signal.symbol,
        contractAddress: signal.contractAddress,
        entryPrice: signal.priceRaw,
        currentPrice: signal.priceRaw,
        allocationUsd: sizing.allocationUsd,
        riskUsd: sizing.riskUsd,
        tokenAmount,
        takeProfitPrice: signal.priceRaw * TAKE_PROFIT_MULTIPLIER,
        stopLossPrice: signal.priceRaw * (1 - STOP_LOSS_PCT),
        entryLiquidityUsd: Number(signal.liquidityRaw || 0),
        currentLiquidityUsd: Number(signal.liquidityRaw || 0),
        entryVolume5mUsd: Number(signal.volume5mRaw || 0),
        valueUsd: sizing.allocationUsd,
        pnlPct: 0,
        tpCandidateTicks: 0,
        score: Number(signal.score),
        ageHours: signal.ageHours
      };
      store.cashUsd -= sizing.allocationUsd;
      pushLog(
        store,
        `ALINDI ${signal.symbol} | Risk: $${formatMoney(sizing.riskUsd)} | Pozisyon: $${formatMoney(sizing.allocationUsd)} | TP: 2x | Giris: $${formatPrice(signal.priceRaw)}`
      );
      persistStore(store);
    }
  }

  store.openCount = Object.keys(store.positions).length;
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
  const store = getStore();
  const pairAddresses = Object.keys(store.positions);
  if (!pairAddresses.length) {
    return;
  }

  const livePairs = await fetchPairsByPairAddress(pairAddresses);
  const liveMap = new Map(livePairs.map((pair) => [pair.pairAddress, pair]));

  for (const [address, position] of Object.entries(store.positions)) {
    const livePair = liveMap.get(address);
    const currentPrice = Number(livePair?.priceUsd || position.currentPrice || position.entryPrice);
    const currentLiquidityUsd = Number(livePair?.liquidity?.usd || position.currentLiquidityUsd || position.entryLiquidityUsd || 0);
    const volume5mUsd = Number(livePair?.volume?.m5 || position.entryVolume5mUsd || 0);
    const buys5m = Number(livePair?.txns?.m5?.buys || 0);
    const sells5m = Number(livePair?.txns?.m5?.sells || 0);
    position.currentPrice = currentPrice;
    position.currentLiquidityUsd = currentLiquidityUsd;
    position.valueUsd = realizableValueUsd(position, currentPrice, currentLiquidityUsd);
    position.pnlPct = ((currentPrice / position.entryPrice) - 1) * 100;
    position.tpCandidateTicks = currentPrice >= position.takeProfitPrice ? (position.tpCandidateTicks || 0) + 1 : 0;

    const rugDetected =
      currentPrice <= position.entryPrice * HARD_RUG_PRICE_FLOOR ||
      (position.entryLiquidityUsd > 0 && currentLiquidityUsd > 0 && currentLiquidityUsd <= position.entryLiquidityUsd * RUG_LIQUIDITY_FLOOR);
    const hitTp = canConfirmTakeProfit(position, currentPrice, currentLiquidityUsd);
    const hitSl = currentPrice <= position.stopLossPrice;
    const fadedMomentum =
      (volume5mUsd > 0 && position.entryVolume5mUsd > 0 && volume5mUsd <= position.entryVolume5mUsd * 0.4) ||
      sells5m >= buys5m ||
      (position.entryLiquidityUsd > 0 && currentLiquidityUsd > 0 && currentLiquidityUsd <= position.entryLiquidityUsd * 0.6);

    if (hitTp || hitSl || rugDetected || fadedMomentum) {
      store.cashUsd += position.valueUsd;
      store.closedCount += 1;
      store.closedPositions = [
        {
          ...position,
          closedAt: new Date().toISOString(),
          closeReason: rugDetected ? "RUG" : hitTp ? "TP 2x" : hitSl ? "SL" : "EARLY EXIT"
        },
        ...store.closedPositions
      ].slice(0, 200);
      pushLog(
        store,
        `KAPANDI ${position.symbol} ${rugDetected ? "RUG" : hitTp ? "TP 2x" : hitSl ? "SL" : "EARLY EXIT"} | Deger: $${formatMoney(position.valueUsd)} | PnL: ${position.pnlPct.toFixed(2)}%`
      );
      delete store.positions[address];
    }
  }

  store.openCount = Object.keys(store.positions).length;
  store.lastUpdatedAt = new Date().toISOString();
  persistStore(store);
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
  store.lastSignals = [];
  store.lastUpdatedAt = null;
  store.lastLog = [];
  persistStore(store);
  pushLog(store, "Motor baslatiliyor. Dexscreener taramasi yapiliyor...");

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
  pushLog(store, "Risk %10 / TP 2x motoru durduruldu.");
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
    riskPerTradePct: RISK_PER_TRADE * 100,
    takeProfitMultiple: TAKE_PROFIT_MULTIPLIER,
    stopLossPct: STOP_LOSS_PCT * 100,
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
