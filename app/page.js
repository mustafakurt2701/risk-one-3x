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

export default function Page() {
  const [scan, setScan] = useState(null);
  const [state, setState] = useState(null);
  const [testSending, setTestSending] = useState(false);
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

  async function ensureRunning() {
    setError("");
    try {
      const currentState = await request("/api/paper-trader/status");
      setState(currentState);

      if (currentState.running || currentState.starting) {
        setActionText("Motor otomatik olarak calisiyor.");
        return;
      }

      setActionText("Motor otomatik baslatiliyor...");
      await request("/api/paper-trader/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ intervalSeconds: 10 })
      });
      await refresh();
      setActionText("Motor otomatik olarak calisiyor.");
    } catch (err) {
      setError(err.message);
      setActionText("");
    }
  }

  async function sendTestSignals() {
    setTestSending(true);
    setError("");
    setActionText("Test sinyalleri Telegram'a gonderiliyor...");

    try {
      const result = await request("/api/telegram/test", { method: "POST" });
      await refresh();
      setActionText(
        result.sentCount > 0
          ? `${result.sentCount} test sinyali Telegram'a gonderildi.`
          : "Gonderilecek test sinyali bulunamadi."
      );
    } catch (err) {
      setError(err.message);
      setActionText("");
    } finally {
      setTestSending(false);
    }
  }

  useEffect(() => {
    ensureRunning();
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, []);

  return (
    <main className="page-shell">
      <section className="hero">
        <div>
          <p className="eyebrow">Telegram Signal Bot</p>
          <h1>Yeni Coin Sinyallerini Telegram&apos;a Gonder</h1>
          <p className="hero-copy">
            Bu panel Dexscreener uzerinden yeni Solana coin&apos;lerini tarar, uygun `NOW` sinyallerini bulur ve dogrudan Telegram botuna iletir.
          </p>
          <p className="hero-copy">
            Tarama otomatik olarak surekli calisir; manuel baslatma veya durdurma yoktur.
          </p>
          <button onClick={sendTestSignals} disabled={testSending || !state?.telegramEnabled}>
            {testSending ? "Gonderiliyor..." : "Test Telegram Gonder"}
          </button>
        </div>
      </section>

      {actionText ? <div className="notice">{actionText}</div> : null}
      {error ? <div className="error-banner">{error}</div> : null}

      <section className="stats-grid">
        <StatCard label="Taranan Pair" value={scan ? scan.rawPairCount : "-"} />
        <StatCard label="Bulunan Sinyal" value={scan ? scan.signals.length : "-"} />
        <StatCard label="Bildirim Gonderilen" value={state ? state.notifiedSignalCount : "-"} />
        <StatCard label="Telegram" value={state ? (state.telegramEnabled ? "Aktif" : "Kapali") : "-"} />
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
            <h2>Bot Durumu</h2>
            <span>{state?.starting ? "Başlatılıyor" : state?.running ? "Çalışıyor" : "Kapalı"}</span>
          </div>
          <div className="list">
            <div className="log-row">
              <span>{state?.telegramEnabled ? "Bot Hazir" : "Bot Kapali"}</span>
              <p>
                {state?.telegramEnabled
                  ? "Uygun NOW sinyalleri Telegram mesajı olarak gonderilir."
                  : "TELEGRAM_BOT_TOKEN ve TELEGRAM_CHAT_ID tanimli degil."}
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Bot Gunlugu</h2>
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
