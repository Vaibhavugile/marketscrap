import React, { useCallback, useEffect, useMemo, useState } from "react";
import "./App.css";

const SOURCES = [
  { id: "dpboss", name: "DPBoss", url: "https://dpbossss.com/" },
  { id: "madhurbazar", name: "MadhurBazar", url: "https://madhurbazar.com/" },
  { id: "mydpboss", name: "MyDPBoss", url: "https://mydpboss.in/" },
];

function formatTime(value) {
  if (!value) return "Not available";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Not available" : date.toLocaleString();
}

function stageValue(result, stage) {
  if (!result) return "";
  if (stage === "open") {
    if (result.openComplete && result.openPanel != null && result.openJodi != null) {
      return `${result.openPanel}-${String(result.openJodi).padStart(2, "0")}`;
    }
    return "";
  }
  return result.closeComplete && result.closePanel ? String(result.closePanel) : "";
}

function compareStage(sources, stage) {
  const counts = new Map();
  SOURCES.forEach((source) => {
    const row = sources.find((item) => item?.source === source.id);
    const value = stageValue(row, stage);
    if (value) counts.set(value, (counts.get(value) || 0) + 1);
  });

  let finalValue = "";
  let matchingCount = 0;
  counts.forEach((count, value) => {
    if (count > matchingCount) {
      finalValue = value;
      matchingCount = count;
    }
  });

  return {
    finalValue: matchingCount >= 2 ? finalValue : "",
    candidateValue: finalValue,
    matchingCount,
    todayVerified: false,
  };
}

function TodayCell({ result }) {
  if (result?.isTodayResult === true) {
    return <span className="date-badge date-yes">Yes · candidate</span>;
  }
  if (result?.isTodayResult === false) {
    return <span className="date-badge date-no">No</span>;
  }
  return <span className="date-badge date-unknown">Unverified</span>;
}

export default function App() {
  const [markets, setMarkets] = useState([]);
  const [marketId, setMarketId] = useState("");
  const [checking, setChecking] = useState("open");
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);
  const [marketsLoading, setMarketsLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    async function loadMarkets() {
      try {
        const response = await fetch("/api/markets");
        const data = await response.json();
        if (!response.ok || !data.success || !Array.isArray(data.markets)) {
          throw new Error(data.message || "Could not load configured markets.");
        }
        if (!cancelled) {
          setMarkets(data.markets);
          setMarketId(data.markets[0]?.id || "");
        }
      } catch (err) {
        if (!cancelled) setError(`${err.message} Check that node server.js is running.`);
      } finally {
        if (!cancelled) setMarketsLoading(false);
      }
    }
    loadMarkets();
    return () => { cancelled = true; };
  }, []);

  const findResults = useCallback(async (forceRefresh = true) => {
    if (!marketId) {
      setError("Please select a market.");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ marketId, checking });
      if (forceRefresh) params.set("refresh", "1");
      const response = await fetch(`/api/results?${params}`);
      const data = await response.json();
      if (!response.ok || !data.success) {
        throw new Error(data.message || `Results API returned HTTP ${response.status}`);
      }
      setReport(data);
    } catch (err) {
      setReport(null);
      setError(`${err.message} Make sure the scraper API is running on port 3001.`);
    } finally {
      setLoading(false);
    }
  }, [marketId, checking]);

  const selectedMarket = markets.find((market) => market.id === marketId);
  const sourceRows = report?.sources || [];
  const activeCompare = useMemo(() => {
    const confirmation = report?.confirmation;
    const eligible = sourceRows
      .map((row) => ({ row, value: stageValue(row, checking) }))
      .filter(({ row, value }) => value && row?.isTodayResult === true);

    const counts = new Map();
    eligible.forEach(({ value }) => counts.set(value, (counts.get(value) || 0) + 1));

    let candidateValue = "";
    let matchingCount = 0;
    counts.forEach((count, value) => {
      if (count > matchingCount) {
        candidateValue = value;
        matchingCount = count;
      }
    });

    const approved =
      confirmation?.approved === true &&
      confirmation?.stage === checking &&
      Boolean(confirmation?.candidateResult);

    return {
      candidateValue: confirmation?.candidateResult || candidateValue,
      finalValue: approved ? confirmation.candidateResult : "",
      matchingCount: confirmation?.stage === checking
        ? Number(confirmation.matchingCount || 0)
        : matchingCount,
      approved,
    };
  }, [report, sourceRows, checking]);

  function resultFor(sourceId, stage) {
    const row = sourceRows.find((item) => item?.source === sourceId);
    return stageValue(row, stage) || "—";
  }

  function sourceStatus(sourceId) {
    const row = sourceRows.find((item) => item?.source === sourceId);
    if (row?.status === "error") return "Error";
    if (row?.status === "not_found") return "Not found";
    return row?.status || "Fetched";
  }

  return (
    <main className="dashboard">
      <header className="dashboard-header">
        <div className="brand">
          <div className="brand-mark">M</div>
          <div>
            <p className="eyebrow">MARKET INTELLIGENCE</p>
            <h1>MarketPulse</h1>
          </div>
        </div>
        <span className="connection-indicator"><span /> Local scraper API</span>
      </header>

      <section className="hero">
        <p className="eyebrow">LIVE SCRAPER TESTING</p>
        <h2>One market. One clear comparison.</h2>
        <p>Select one market and one stage. Compare all three sources and the scraper decision.</p>
      </section>

      <section className="search-panel">
        <div className="field">
          <label htmlFor="market">MARKET</label>
          <select id="market" value={marketId} disabled={marketsLoading || !markets.length}
            onChange={(event) => { setMarketId(event.target.value); setReport(null); setError(""); }}>
            {marketsLoading && <option value="">Loading markets…</option>}
            {!marketsLoading && !markets.length && <option value="">No markets configured</option>}
            {markets.map((market) => <option key={market.id} value={market.id}>{market.name}</option>)}
          </select>
          {selectedMarket && <small>Scheduled open: {selectedMarket.openTime || "—"} · close: {selectedMarket.closeTime || "—"}</small>}
        </div>

        <div className="field">
          <label>STAGE WE ARE TESTING</label>
          <div className="stage-switch">
            <button type="button" className={checking === "open" ? "active" : ""}
              onClick={() => { setChecking("open"); setReport(null); }}>Open</button>
            <button type="button" className={checking === "close" ? "active" : ""}
              onClick={() => { setChecking("close"); setReport(null); }}>Close</button>
          </div>
        </div>

        <button className="find-button" type="button" onClick={() => findResults(true)}
          disabled={loading || !marketId || marketsLoading}>
          {loading ? "Fetching live data…" : "Fetch live results"}
        </button>
      </section>

      {error && <div className="error-banner">{error}</div>}
      {loading && <div className="loading-panel"><span className="loader" />Fetching this market from all three sources…</div>}

      {report && !loading && (
        <>
          <section className="report-heading">
            <div>
              <p className="eyebrow">SCRAPE REPORT</p>
              <h2>{report.market || selectedMarket?.name || "Selected market"}</h2>
              <p>Fetched {formatTime(report.checkedAt)} · Focus stage: <strong>{checking.toUpperCase()}</strong></p>
            </div>
            <button className="secondary-button" type="button" onClick={() => findResults(true)} disabled={loading}>↻ Refresh</button>
          </section>

          <section className="table-card">
            <div className="table-title">
              <div>
                <h3>Market result comparison</h3>
                <p>Showing only the selected stage. “Today?” uses your scraper’s isTodayResult flag; it is a candidate heuristic, not independent date proof.</p>
              </div>
              <span className="live-tag"><span /> LIVE DATA</span>
            </div>

            <div className="table-scroll">
              <table className="results-table">
                <thead>
                  <tr>
                    <th>Market</th>
                    <th>Stage</th>
                    <th>Source 1 · DPBoss</th>
                    <th>Is today?</th>
                    <th>Source 2 · MadhurBazar</th>
                    <th>Is today?</th>
                    <th>Source 3 · MyDPBoss</th>
                    <th>Is today?</th>
                    <th>Match</th>
                    <th>Final value</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="active-row">
                    <td className="market-cell">{report.market || selectedMarket?.name || marketId}</td>
                    <td><span className={`stage-tag ${checking}`}>{checking.toUpperCase()}</span></td>
                    {SOURCES.map((source) => {
                      const row = sourceRows.find((item) => item?.source === source.id);
                      const value = resultFor(source.id, checking);
                      const matched = value !== "—" &&
                        value === activeCompare.candidateValue &&
                        row?.isTodayResult === true;
                      return (
                        <React.Fragment key={`${checking}-${source.id}`}>
                          <td>
                            <strong className={value === "—" ? "empty-value" : matched ? "matched-value" : "result-value"}>{value}</strong>
                            <small className="cell-status">{sourceStatus(source.id)}</small>
                          </td>
                          <td><TodayCell result={row} /></td>
                        </React.Fragment>
                      );
                    })}
                    <td>
                      <span className={`match-count ${activeCompare.matchingCount >= 2 ? "match-good" : ""}`}>
                        {activeCompare.matchingCount}/3
                      </span>
                      <small className="cell-status">
                        {activeCompare.matchingCount >= 2 ? "TODAY CANDIDATES MATCH" : "Not enough today candidates"}
                      </small>
                    </td>
                    <td>
                      <strong className={activeCompare.finalValue ? "final-value" : "empty-value"}>
                        {activeCompare.finalValue || "Not confirmed"}
                      </strong>
                      <small className="cell-status">
                        {activeCompare.approved ? "Approved by scraper" : "DO_NOT_UPLOAD"}
                      </small>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div className="table-note">The highlighted row is the stage currently being tested. Scroll horizontally on smaller screens to see every column.</div>
          </section>

          <section className="final-status">
            <div className="final-icon">✓</div>
            <div className="final-copy">
              <p className="eyebrow">FINAL STATUS · {checking.toUpperCase()}</p>
              <h3>{activeCompare.approved
                ? `${activeCompare.matchingCount}/3 today candidates match · Final ${activeCompare.finalValue}`
                : `${activeCompare.matchingCount}/3 today candidates match · Not confirmed`}</h3>
              <p>{activeCompare.approved
                ? "The scraper confirmation approved this selected market stage."
                : "The scraper did not approve this selected market stage. The final value is withheld; matching raw values alone are not enough."}</p>
            </div>
            <span className={`date-badge ${activeCompare.approved ? "date-yes" : "date-unknown"}`}>{activeCompare.approved ? "Scraper approved" : "Not confirmed"}</span>
          </section>
        </>
      )}

      {!report && !loading && !error && (
        <section className="empty-state">
          <h3>Ready to test your market</h3>
          <p>Select the market and Open or Close stage, then fetch results to populate the comparison table.</p>
        </section>
      )}

      <footer>MarketPulse · Live values from DPBoss, MadhurBazar and MyDPBoss</footer>
    </main>
  );
}
