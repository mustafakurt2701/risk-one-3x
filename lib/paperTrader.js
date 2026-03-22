import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { formatMoney, formatPrice, scanNewCoins } from "@/lib/scanner";
import { isTelegramEnabled, sendTelegramMessage } from "@/lib/telegram";

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
const SIGNAL_DEDUPE_TTL_MS = 24 * 60 * 60 * 1000;

function defaultStore() {
  return {
    running: false,
    starting: false,
    intervalSeconds: 10,
    notifiedSignals: {},
    lastSignals: [],
    lastUpdatedAt: null,
    lastLog: [],
    timer: null
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

function signalKey(signal) {
  return signal.contractAddress || signal.pairAddress;
}

function pruneNotifiedSignals(store) {
  const now = Date.now();

  for (const [key, value] of Object.entries(store.notifiedSignals)) {
    const sentAt = Date.parse(value);
    if (!Number.isFinite(sentAt) || now - sentAt > SIGNAL_DEDUPE_TTL_MS) {
      delete store.notifiedSignals[key];
    }
  }
}

function formatSignalTelegramMessage(signal, title = "Yeni sinyal") {
  return [
    title,
    `${signal.name} (${signal.symbol})`,
    `Fiyat: $${formatPrice(signal.priceRaw)}`,
    `Likidite: $${formatMoney(signal.liquidityRaw)}`,
    `Hacim 5dk: $${formatMoney(signal.volume5mRaw)}`,
    `Skor: ${signal.score}`,
    `Guven: ${signal.confidence}`,
    `Giris: ${signal.entry}`,
    `Pair: ${signal.pairAddress}`
  ].join("\n");
}

async function tick() {
  const store = getStore();
  const result = await scanNewCoins();
  pruneNotifiedSignals(store);

  for (const signal of result.signals) {
    if (signal.entry !== "NOW" || !signal.priceRaw) {
      continue;
    }
    const key = signalKey(signal);
    if (store.notifiedSignals[key]) {
      continue;
    }

    const message = `SINYAL ${signal.symbol} | Fiyat: $${formatPrice(signal.priceRaw)} | Likidite: $${formatMoney(signal.liquidityRaw)} | Hacim 5dk: $${formatMoney(signal.volume5mRaw)} | Skor: ${signal.score}`;
    pushLog(store, message);

    try {
      const telegramResult = await sendTelegramMessage(formatSignalTelegramMessage(signal));
      if (telegramResult.ok) {
        store.notifiedSignals[key] = new Date().toISOString();
      }
    } catch (error) {
      pushLog(store, `TELEGRAM HATA ${error.message}`);
    }
  }
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
}

function scheduleLoop(store) {
  clearTimer(store);
  store.timer = setInterval(() => {
    tick().catch((error) => pushLog(store, `HATA ${error.message}`));
  }, store.intervalSeconds * 1000);
}

export async function startPaperTrader({ intervalSeconds = 10 } = {}) {
  const store = getStore();
  if (store.running || store.starting) {
    pushLog(store, "Motor zaten aktif.");
    return getPaperTraderState();
  }

  clearTimer(store);
  store.running = true;
  store.starting = true;
  store.intervalSeconds = intervalSeconds;
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

  return {
    running: store.running,
    starting: store.starting,
    intervalSeconds: store.intervalSeconds,
    telegramEnabled: isTelegramEnabled(),
    notifiedSignalCount: Object.keys(store.notifiedSignals).length,
    lastSignals: store.lastSignals,
    lastUpdatedAt: store.lastUpdatedAt,
    lastLog: store.lastLog
  };
}

export async function sendCurrentSignalsToTelegram() {
  const store = getStore();
  const result = await scanNewCoins();

  if (!isTelegramEnabled()) {
    throw new Error("Telegram config missing");
  }

  if (!result.signals.length) {
    pushLog(store, "TEST TELEGRAM Gonderilecek sinyal bulunamadi.");
    return { sentCount: 0, scannedAt: result.scannedAt, signals: [] };
  }

  for (const signal of result.signals) {
    await sendTelegramMessage(formatSignalTelegramMessage(signal, "Test sinyal"));
  }

  pushLog(store, `TEST TELEGRAM ${result.signals.length} sinyal gonderildi.`);

  return {
    sentCount: result.signals.length,
    scannedAt: result.scannedAt,
    signals: result.signals
  };
}
