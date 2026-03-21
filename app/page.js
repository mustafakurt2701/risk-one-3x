"use client";

import { useEffect, useState } from "react";

async function request(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }
  return response.json();
}

function StatCard({ label, value }) {
  return (
    <div className="stat-card">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function SignalRow({ signal }) {
  return (
    <div className="signal-row">
      <div>
        <strong>{signal.name} ({signal.symbol})</strong>
        <p>Skor {signal.score}/10 · {signal.momentum} · Giris {signal.entry}</p>
        <p>5dk {signal.buys5m}B / {signal.sells5m}S · Hacim ${signal.volume5m}</p>
        <code>{signal.contractAddress}</code>
      </div>
      <div>
        <span>{signal.ageHours.toFixed(2)} saat</span>
        <p>${signal.priceUsd}</p>
      </div>
    </div>
  );
}

function PositionRow({ position }) {
  const statusLabel = position.status === "closed" ? position.closeReason || "Kapandi" : "Acik";
  const statusClass =
    position.closeReason === "RUG"
      ? "status-rug"
      : position.closeReason === "SL"
        ? "status-sl"
        : position.closeReason === "TP 2x"
          ? "status-tp"
          : position.closeReason === "EARLY EXIT"
            ? "status-sl"
          : "status-open";
  return (
    <div className="signal-row">
      <div>
        <strong>{position.name} ({position.symbol})</strong>
        <p>Risk ${position.riskUsd.toFixed(2)} · Pozisyon ${position.allocationUsd.toFixed(2)}</p>
        {position.status === "open" && position.tpCandidateTicks > 0 ? (
          <p>TP teyit: {position.tpCandidateTicks}/3</p>
        ) : null}
        <code>{position.contractAddress}</code>
      </div>
      <div>
        <span className={statusClass}>{statusLabel} · {position.pnlPct.toFixed(2)}%</span>
        <p>${position.valueUsd.toFixed(2)}</p>
      </div>
    </div>
  );
}

export default function Page() {
  const [scan, setScan] = useState(null);
  const [state, setState] = useState(null);
  const [loading, setLoading] = useState(false);
  const [actionText, setActionText] = useState("");
  const [error, setError] = useState("");

  async function refresh() {
    try {
      const [scanData, stateData] = await Promise.all([
        request("/api/scan"),
        request("/api/paper-trader/status")
      ]);
      setScan(scanData);
      setState(stateData);
      setError("");
    } catch (err) {
      setError(err.message);
    }
  }

  async function start() {
    setLoading(true);
    setActionText("Motor baslatiliyor...");
    setError("");
    try {
      await request("/api/paper-trader/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ initialBalanceSol: 1, solUsd: 130, intervalSeconds: 10 })
      });
      await refresh();
      setActionText("Motor aktif.");
    } catch (err) {
      setError(err.message);
      setActionText("");
    } finally {
      setLoading(false);
    }
  }

  async function stop() {
    setLoading(true);
    setActionText("Motor durduruluyor...");
    try {
      await request("/api/paper-trader/stop", { method: "POST" });
      await refresh();
      setActionText("Motor durduruldu.");
    } catch (err) {
      setError(err.message);
      setActionText("");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, []);

  return (
    <main className="page-shell">
      <section className="hero">
        <div>
          <p className="eyebrow">Risk Controlled Launcher</p>
          <h1>Yeni Coinlere %10 Risk, TP 2x</h1>
          <p className="hero-copy">
            Bu panel son 6-24 saatte cikan Solana coin&apos;lerini tarar. Her islemde toplam portfoyun en fazla %10&apos;u riske edilir, stop -50%, hedef 2x ve pozisyon boyutu sermayenin %20&apos;sidir.
          </p>
        </div>
        <div className="hero-actions">
          <button onClick={start} disabled={loading || state?.running || state?.starting}>
            {loading || state?.starting ? "Baslatiliyor..." : state?.running ? "Motor Aktif" : "Motoru Başlat"}
          </button>
          <button onClick={stop} disabled={loading} className="ghost">Durdur</button>
          <button onClick={refresh} disabled={loading} className="ghost">Yenile</button>
        </div>
      </section>

      {actionText ? <div className="notice">{actionText}</div> : null}
      {error ? <div className="error-banner">{error}</div> : null}

      <section className="stats-grid">
        <StatCard label="Taranan Pair" value={scan ? scan.rawPairCount : "-"} />
        <StatCard label="Trade Adayı" value={scan ? scan.signals.length : "-"} />
        <StatCard label="Toplam Bakiye" value={state ? `${state.balanceSol.toFixed(4)} SOL` : "-"} />
        <StatCard label="Açık Pozisyon" value={state ? state.openCount : "-"} />
        <StatCard label="Toplam Pozisyon" value={state ? state.allPositions.length : "-"} />
        <StatCard label="Risk / Trade" value={state ? `%${state.riskPerTradePct}` : "%10"} />
        <StatCard label="Discovery" value={scan ? scan.discoverySource : "-"} />
      </section>

      <section className="content-grid">
        <div className="panel">
          <div className="panel-head">
            <h2>Yeni Coin Akışı</h2>
            <span>
              {scan?.scannedAt ? new Date(scan.scannedAt).toLocaleTimeString("tr-TR") : "-"}
              {" · Dexscreener"}
            </span>
          </div>
          <div className="list">
            {scan?.signals?.length ? scan.signals.map((signal) => (
              <SignalRow key={signal.pairAddress} signal={signal} />
            )) : <div className="empty">NO SIGNALS</div>}
          </div>
        </div>

        <div className="panel">
          <div className="panel-head">
            <h2>Açık Pozisyonlar</h2>
            <span>{state?.starting ? "Başlatılıyor" : state?.running ? "Çalışıyor" : "Kapalı"}</span>
          </div>
          <div className="list">
            {state?.openPositions?.length ? state.openPositions.map((position) => (
              <PositionRow key={position.pairAddress} position={position} />
            )) : <div className="empty">Pozisyon yok.</div>}
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Tüm Pozisyonlar</h2>
          <span>{state ? `${state.allPositions.length} adet` : "-"}</span>
        </div>
        <div className="list">
          {state?.allPositions?.length ? state.allPositions.map((position) => (
            <PositionRow
              key={`${position.pairAddress}-${position.closedAt || "open"}`}
              position={position}
            />
          )) : <div className="empty">Henüz pozisyon yok.</div>}
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>İşlem Günlüğü</h2>
          <span>{state?.lastUpdatedAt ? new Date(state.lastUpdatedAt).toLocaleTimeString("tr-TR") : "-"}</span>
        </div>
        <div className="list">
          {state?.lastLog?.length ? state.lastLog.map((item) => (
            <div key={`${item.at}-${item.message}`} className="log-row">
              <span>{new Date(item.at).toLocaleTimeString("tr-TR")}</span>
              <p>{item.message}</p>
            </div>
          )) : <div className="empty">Henüz log yok.</div>}
        </div>
      </section>
    </main>
  );
}
