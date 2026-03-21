const API_BASE = "https://api.dexscreener.com";
function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getNested(obj, path, fallback = 0) {
  let current = obj;
  for (const key of path) {
    if (!current || typeof current !== "object") {
      return fallback;
    }
    current = current[key];
    if (current === undefined || current === null) {
      return fallback;
    }
  }
  return current;
}

export function formatMoney(value) {
  const amount = toNumber(value);
  if (amount >= 1_000_000) {
    return `${(amount / 1_000_000).toFixed(2)}M`;
  }
  if (amount >= 1_000) {
    return `${(amount / 1_000).toFixed(2)}K`;
  }
  return amount.toFixed(2);
}

export function formatPrice(value) {
  const amount = toNumber(value);
  if (amount === 0) {
    return "0";
  }
  if (amount >= 1) {
    return amount.toFixed(6).replace(/\.?0+$/, "");
  }
  return amount.toFixed(12).replace(/\.?0+$/, "");
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": "risk-one-3x/1.0"
    },
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error(`Dexscreener request failed: ${response.status}`);
  }

  return response.json();
}

function chunk(items, size) {
  const result = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

export async function fetchLatestSolanaPairs(limitTokens = 160) {
  const profiles = await fetchJson(`${API_BASE}/token-profiles/latest/v1`);
  const addresses = [];

  for (const item of profiles) {
    if (item.chainId !== "solana") {
      continue;
    }
    if (!item.tokenAddress || addresses.includes(item.tokenAddress)) {
      continue;
    }
    addresses.push(item.tokenAddress);
    if (addresses.length >= limitTokens) {
      break;
    }
  }

  const pairResults = await Promise.all(
    chunk(addresses, 30).map((batch) =>
      fetchJson(`${API_BASE}/tokens/v1/solana/${batch.join(",")}`).catch(() => [])
    )
  );

  return pairResults.flat();
}

export async function fetchPairsByPairAddress(pairAddresses) {
  const uniquePairs = [...new Set(pairAddresses)].filter(Boolean).slice(0, 30);
  if (!uniquePairs.length) {
    return [];
  }

  const response = await fetchJson(`${API_BASE}/latest/dex/pairs/solana/${uniquePairs.join(",")}`);
  return Array.isArray(response?.pairs) ? response.pairs : [];
}

function ageHours(pair, nowMs) {
  const createdAt = toNumber(pair?.pairCreatedAt, Number.MAX_SAFE_INTEGER);
  return (nowMs - createdAt) / 3_600_000;
}

function computeMetrics(pair) {
  const liquidity = toNumber(getNested(pair, ["liquidity", "usd"]));
  const volume5m = toNumber(getNested(pair, ["volume", "m5"]));
  const volume1h = toNumber(getNested(pair, ["volume", "h1"]));
  const buys5m = toNumber(getNested(pair, ["txns", "m5", "buys"]));
  const sells5m = toNumber(getNested(pair, ["txns", "m5", "sells"]));
  const txns5m = buys5m + sells5m;
  const priceChange5m = toNumber(getNested(pair, ["priceChange", "m5"]));
  const priceChange1h = toNumber(getNested(pair, ["priceChange", "h1"]));

  return {
    liquidity,
    volume5m,
    volume1h,
    buys5m,
    sells5m,
    txns5m,
    priceChange5m,
    priceChange1h,
    buySellRatio: sells5m > 0 ? buys5m / sells5m : buys5m > 0 ? buys5m : 0,
    volumeToLiquidity: liquidity > 0 ? volume5m / liquidity : 0
  };
}

function pairAddress(pair) {
  return pair.pairAddress || pair.url || "N/A";
}

function pairName(pair) {
  return {
    name: pair?.baseToken?.name || "Unknown",
    symbol: pair?.baseToken?.symbol || "UNKNOWN"
  };
}

function validNewCoin(pair, metrics, nowMs) {
  const age = ageHours(pair, nowMs);
  if (pair.chainId !== "solana") {
    return false;
  }
  if (age < 1 || age > 24) {
    return false;
  }
  if (metrics.liquidity < 10_000 || metrics.liquidity > 250_000) {
    return false;
  }
  if (metrics.volume5m < Math.max(5_000, metrics.liquidity * 0.1)) {
    return false;
  }
  if (metrics.txns5m < 10) {
    return false;
  }
  if (metrics.buys5m <= metrics.sells5m || metrics.buySellRatio < 1.5) {
    return false;
  }
  if (metrics.priceChange1h > 220 || metrics.priceChange5m > 100) {
    return false;
  }
  return true;
}

function setupScore(pair, metrics, nowMs) {
  const age = ageHours(pair, nowMs);
  let score = 0;

  if (age <= 6) {
    score += 3;
  } else if (age <= 12) {
    score += 2.2;
  } else {
    score += 1.4;
  }

  if (metrics.buySellRatio >= 2.2) {
    score += 3;
  } else if (metrics.buySellRatio >= 1.5) {
    score += 2.1;
  }

  if (metrics.volumeToLiquidity >= 0.3) {
    score += 2.8;
  } else if (metrics.volumeToLiquidity >= 0.2) {
    score += 2.5;
  } else if (metrics.volumeToLiquidity >= 0.1) {
    score += 1.7;
  } else {
    score += 0.4;
  }

  if (metrics.liquidity >= 20_000 && metrics.liquidity <= 200_000) {
    score += 1.8;
  } else {
    score += 0.7;
  }

  if (metrics.priceChange1h > 160) {
    score -= 1.5;
  } else if (metrics.priceChange1h > 120) {
    score -= 0.8;
  }

  if (metrics.priceChange5m > 35) {
    score -= 1;
  }

  return Math.max(0, Math.min(10, Number(score.toFixed(1))));
}

function confidence(score) {
  return `${Math.max(55, Math.min(95, Math.round(40 + score * 5)))}%`;
}

export async function scanNewCoins() {
  const nowMs = Date.now();
  const discoverySource = "dexscreener";
  const pairs = await fetchLatestSolanaPairs();

  const signals = [];

  for (const pair of pairs) {
    const metrics = computeMetrics(pair);
    if (!validNewCoin(pair, metrics, nowMs)) {
      continue;
    }

    const score = setupScore(pair, metrics, nowMs);
    if (score < 7) {
      continue;
    }
    const { name, symbol } = pairName(pair);
    const entry = metrics.priceChange5m > 18 ? "WAIT" : "NOW";
    signals.push({
      name,
      symbol,
      pairAddress: pairAddress(pair),
      contractAddress: pair?.baseToken?.address || pairAddress(pair),
      priceUsd: formatPrice(pair.priceUsd),
      priceRaw: toNumber(pair.priceUsd),
      liquidity: formatMoney(metrics.liquidity),
      liquidityRaw: metrics.liquidity,
      volume5m: formatMoney(metrics.volume5m),
      volume5mRaw: metrics.volume5m,
      buys5m: metrics.buys5m,
      sells5m: metrics.sells5m,
      txns5m: metrics.txns5m,
      ageHours: Number(ageHours(pair, nowMs).toFixed(2)),
      score: score.toFixed(1),
      confidence: confidence(score),
      momentum: metrics.buySellRatio >= 2 ? "STRONG" : "MEDIUM",
      entry,
      reason: [
        `${ageHours(pair, nowMs).toFixed(2)} saatlik yeni pair`,
        `5dk alis/satis ${metrics.buys5m}/${metrics.sells5m}, hacim/likidite %${Math.round(metrics.volumeToLiquidity * 100)}`
      ]
    });
  }

  signals.sort((left, right) => {
    if (left.ageHours !== right.ageHours) {
      return left.ageHours - right.ageHours;
    }
    if (right.liquidityRaw !== left.liquidityRaw) {
      return right.liquidityRaw - left.liquidityRaw;
    }
    return Number(right.score) - Number(left.score);
  });

  return {
    scannedAt: new Date(nowMs).toISOString(),
    rawPairCount: pairs.length,
    discoverySource,
    signals: signals.slice(0, 3)
  };
}
