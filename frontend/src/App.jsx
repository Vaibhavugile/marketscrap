import React, { useEffect, useMemo, useState } from "react";
import { collection, onSnapshot } from "firebase/firestore";
import { db } from "./firebase";
import "./App.css";

const TIME_ZONE = "Asia/Kolkata";
const HISTORY_COLLECTION = "marketResultHistory";
const MARKETS_API =
  "https://us-central1-matkaresult-45b2c.cloudfunctions.net/getConfiguredMarkets";

const STAGES = [
  { id: "open", label: "Open" },
  { id: "close", label: "Close" },
];

const STATUS_OPTIONS = [
  "all",
  "approved",
  "pending",
  "checking",
  "error",
  "attempt_limit_reached",
  "waiting",
];

function getDateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const values = {};
  parts.forEach((part) => {
    if (part.type !== "literal") values[part.type] = part.value;
  });

  return `${values.year}-${values.month}-${values.day}`;
}

function shiftDate(dateKey, days) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));

  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

function toMillis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;

  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

function formatDateTime(value) {
  const millis = toMillis(value);
  if (!millis) return "Not recorded";

  return new Intl.DateTimeFormat("en-IN", {
    timeZone: TIME_ZONE,
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  }).format(new Date(millis));
}

function formatDate(dateKey) {
  if (!dateKey) return "Unknown date";

  const [year, month, day] = dateKey.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));

  return new Intl.DateTimeFormat("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function normalizeStage(value) {
  const stage = String(value || "").toLowerCase();
  return stage === "open" || stage === "close" ? stage : "";
}

function getHistoryResult(record, stage) {
  if (!record) return "";

  const stageResult = record[`${stage}Result`];
  const value =
    stageResult ??
    record.approvedResult ??
    record.result ??
    record.candidateResult;

  if (value === null || value === undefined) return "";
  return String(value);
}

function getCurrentResult(record, stage) {
  if (!record) return "";

  const value = record[`${stage}Result`];
  if (value === null || value === undefined) return "";

  return String(value);
}

function getApprovalTime(record, stage) {
  if (!record) return null;

  return (
    record[`${stage}ApprovedAt`] ||
    record.approvedAt ||
    record.updatedAt ||
    null
  );
}

function getSources(record, stage) {
  if (!record) return [];

  const sources =
    record[`${stage}Sources`] ??
    record.matchingSources ??
    record.sources ??
    [];

  return Array.isArray(sources) ? sources : [];
}

function getStageStatus(state, result, historyRecord) {
  if (
    historyRecord?.approved === true ||
    historyRecord?.status === "approved"
  ) {
    return "approved";
  }

  if (state?.approved === true || state?.status === "approved") {
    return "approved";
  }

  if (state?.status === "checking") return "checking";
  if (state?.status === "error") return "error";

  if (state?.status === "attempt_limit_reached") {
    return "attempt_limit_reached";
  }

  if (state?.status === "pending") return "pending";
  if (result) return "approved";

  return "waiting";
}

function StatusBadge({ status }) {
  const labels = {
    approved: "Approved",
    pending: "Pending",
    checking: "Checking",
    error: "Failed",
    attempt_limit_reached: "Limit reached",
    waiting: "Waiting",
  };

  return (
    <span className={`mp-status mp-status-${status || "waiting"}`}>
      <span className="mp-status-dot" />
      {labels[status] || status || "Waiting"}
    </span>
  );
}

function ResultCell({
  result,
  status,
  updatedAt,
  sources,
  attempts,
  lastError,
}) {
  return (
    <div className="mp-result-cell">
      <div className="mp-result-value">{result || "—"}</div>

      <StatusBadge status={status} />

      <div className="mp-result-meta">
        <span>
          <strong>Updated:</strong> {formatDateTime(updatedAt)}
        </span>

        <span>
          <strong>Attempts:</strong> {attempts}/10
        </span>

        {sources.length > 0 && (
          <span>
            <strong>Sources:</strong> {sources.join(", ")}
          </span>
        )}

        {lastError && (
          <span className="mp-error-detail">
            <strong>Error:</strong> {lastError}
          </span>
        )}
      </div>
    </div>
  );
}

export default function App() {
  const today = getDateKey();

  const [markets, setMarkets] = useState([]);
  const [marketsLoading, setMarketsLoading] = useState(true);
  const [currentResults, setCurrentResults] = useState([]);
  const [states, setStates] = useState([]);
  const [history, setHistory] = useState([]);

  const [dateMode, setDateMode] = useState("today");
  const [customDate, setCustomDate] = useState(today);
  const [stageFilter, setStageFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [search, setSearch] = useState("");

  const [loading, setLoading] = useState(true);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [errors, setErrors] = useState([]);

  // Get the enabled market list from the deployed Cloud Function.
  // The old Firestore "markets" collection is intentionally not used.
  useEffect(() => {
    let active = true;

    async function loadConfiguredMarkets() {
      setMarketsLoading(true);

      try {
        const response = await fetch(MARKETS_API);
        const data = await response.json();

        if (
          !response.ok ||
          data.success !== true ||
          !Array.isArray(data.markets)
        ) {
          throw new Error(
            data.message ||
              `Markets endpoint returned HTTP ${response.status}`
          );
        }

        if (active) {
          setMarkets(
            data.markets.filter(
              (market) => market && market.enabled !== false
            )
          );

          setErrors((previous) =>
            previous.filter(
              (item) => !item.startsWith("Configured markets:")
            )
          );
        }
      } catch (error) {
        if (active) {
          setErrors((previous) => [
            ...previous.filter(
              (item) => !item.startsWith("Configured markets:")
            ),
            `Configured markets: ${error.message}`,
          ]);
        }
      } finally {
        if (active) setMarketsLoading(false);
      }
    }

    loadConfiguredMarkets();

    return () => {
      active = false;
    };
  }, [refreshVersion]);

  // Subscribe only to saved results, scraper states, and history.
  useEffect(() => {
    let active = true;
    let pending = 3;
    const unsubscribers = [];

    setLoading(true);

    function subscribe(name, collectionName, onData) {
      const unsubscribe = onSnapshot(
        collection(db, collectionName),
        (snapshot) => {
          if (!active) return;

          onData(
            snapshot.docs.map((doc) => ({
              ...doc.data(),
              _docId: doc.id,
            }))
          );

          pending -= 1;
          if (pending <= 0) setLoading(false);
        },
        (error) => {
          if (!active) return;

          setErrors((previous) => [
            ...previous.filter((item) => !item.startsWith(`${name}:`)),
            `${name}: ${error.message}`,
          ]);

          pending -= 1;
          if (pending <= 0) setLoading(false);
        }
      );

      unsubscribers.push(unsubscribe);
    }

    subscribe("Results", "marketResults", setCurrentResults);
    subscribe("Scraper status", "marketScraperState", setStates);
    subscribe("Result history", HISTORY_COLLECTION, setHistory);

    return () => {
      active = false;
      unsubscribers.forEach((unsubscribe) => unsubscribe());
    };
  }, [refreshVersion]);

  const resultByMarket = useMemo(() => {
    const map = new Map();

    currentResults.forEach((record) => {
      const id = record.marketId || record._docId;
      if (id) map.set(id, record);
    });

    return map;
  }, [currentResults]);

  const stateByKey = useMemo(() => {
    const map = new Map();

    states.forEach((record) => {
      const marketId = record.marketId;
      const dateKey = record.dateKey;
      const stage = normalizeStage(record.stage);

      if (marketId && dateKey && stage) {
        map.set(`${dateKey}_${marketId}_${stage}`, record);
      } else {
        map.set(record._docId, record);
      }
    });

    return map;
  }, [states]);

  const historyByKey = useMemo(() => {
    const map = new Map();

    history.forEach((record) => {
      const marketId = record.marketId;
      const dateKey = record.dateKey;
      const stage = normalizeStage(record.stage);

      if (!marketId || !dateKey || !stage) return;

      map.set(`${dateKey}_${marketId}_${stage}`, record);
    });

    return map;
  }, [history]);

  // The configured endpoint is the only source of market rows.
  const allMarkets = useMemo(() => {
    return markets
      .filter((market) => market && market.enabled !== false)
      .map((market) => ({
        ...market,
        id: market.id,
        name: market.name || market.id,
      }))
      .filter((market) => Boolean(market.id))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [markets]);

  const selectedDate = useMemo(() => {
    if (dateMode === "yesterday") return shiftDate(today, -1);
    if (dateMode === "custom") return customDate;
    return today;
  }, [dateMode, customDate, today]);

  const allDates = useMemo(() => {
    const dates = new Set();

    history.forEach((record) => {
      if (record.dateKey) dates.add(record.dateKey);
    });

    states.forEach((record) => {
      if (record.dateKey) dates.add(record.dateKey);
    });

    currentResults.forEach((record) => {
      if (record.openDateKey) dates.add(record.openDateKey);
      if (record.closeDateKey) dates.add(record.closeDateKey);
    });

    return [...dates].sort((a, b) => b.localeCompare(a));
  }, [history, states, currentResults]);

  const tableRows = useMemo(() => {
    const dates =
      dateMode === "all"
        ? allDates
        : selectedDate
          ? [selectedDate]
          : [];

    const rows = [];

    dates.forEach((dateKey) => {
      allMarkets.forEach((market) => {
        const current = resultByMarket.get(market.id);

        const openHistory = historyByKey.get(
          `${dateKey}_${market.id}_open`
        );

        const closeHistory = historyByKey.get(
          `${dateKey}_${market.id}_close`
        );

        const openState = stateByKey.get(
          `${dateKey}_${market.id}_open`
        );

        const closeState = stateByKey.get(
          `${dateKey}_${market.id}_close`
        );

        const openIsCurrent = current?.openDateKey === dateKey;
        const closeIsCurrent = current?.closeDateKey === dateKey;

        const openResult = openHistory
          ? getHistoryResult(openHistory, "open")
          : openIsCurrent
            ? getCurrentResult(current, "open")
            : "";

        const closeResult = closeHistory
          ? getHistoryResult(closeHistory, "close")
          : closeIsCurrent
            ? getCurrentResult(current, "close")
            : "";

        const openUpdatedAt = openHistory
          ? getApprovalTime(openHistory, "open")
          : openIsCurrent
            ? getApprovalTime(current, "open")
            : openState?.approvedAt || openState?.lastAttemptAt || null;

        const closeUpdatedAt = closeHistory
          ? getApprovalTime(closeHistory, "close")
          : closeIsCurrent
            ? getApprovalTime(current, "close")
            : closeState?.approvedAt || closeState?.lastAttemptAt || null;

        const openSources = openHistory
          ? getSources(openHistory, "open")
          : openIsCurrent
            ? getSources(current, "open")
            : [];

        const closeSources = closeHistory
          ? getSources(closeHistory, "close")
          : closeIsCurrent
            ? getSources(current, "close")
            : [];

        const openStatus = getStageStatus(
          openState,
          openResult,
          openHistory
        );

        const closeStatus = getStageStatus(
          closeState,
          closeResult,
          closeHistory
        );

        rows.push({
          key: `${dateKey}_${market.id}`,
          dateKey,
          market,
          open: {
            result: openResult,
            status: openStatus,
            updatedAt: openUpdatedAt,
            sources: openSources,
            attempts: Number(openState?.attempts || 0),
            lastError: openState?.lastError || "",
            state: openState,
          },
          close: {
            result: closeResult,
            status: closeStatus,
            updatedAt: closeUpdatedAt,
            sources: closeSources,
            attempts: Number(closeState?.attempts || 0),
            lastError: closeState?.lastError || "",
            state: closeState,
          },
        });
      });
    });

    return rows;
  }, [
    dateMode,
    selectedDate,
    allDates,
    allMarkets,
    resultByMarket,
    stateByKey,
    historyByKey,
  ]);

  const filteredRows = useMemo(() => {
    return tableRows.filter((row) => {
      const query = search.trim().toLowerCase();

      if (
        query &&
        !row.market.name.toLowerCase().includes(query) &&
        !row.market.id.toLowerCase().includes(query)
      ) {
        return false;
      }

      const visibleStages =
        stageFilter === "all"
          ? STAGES
          : STAGES.filter((stage) => stage.id === stageFilter);

      return visibleStages.some((stage) => {
        const item = row[stage.id];

        if (
          statusFilter !== "all" &&
          item.status !== statusFilter
        ) {
          return false;
        }

        return true;
      });
    });
  }, [tableRows, search, stageFilter, statusFilter]);

  const summary = useMemo(() => {
    const items = filteredRows.flatMap((row) => {
      if (stageFilter === "open") return [row.open];
      if (stageFilter === "close") return [row.close];
      return [row.open, row.close];
    });

    return {
      markets: new Set(filteredRows.map((row) => row.market.id)).size,
      approved: items.filter((item) => item.status === "approved").length,
      pending: items.filter((item) => item.status === "pending").length,
      failed: items.filter(
        (item) =>
          item.status === "error" ||
          item.status === "attempt_limit_reached"
      ).length,
      waiting: items.filter((item) => item.status === "waiting").length,
    };
  }, [filteredRows, stageFilter]);

  const dateLabel =
    dateMode === "all"
      ? "All available dates"
      : dateMode === "yesterday"
        ? "Yesterday"
        : dateMode === "custom"
          ? "Selected date"
          : "Today";

  const isLoading = loading || marketsLoading;

  return (
    <main className="dashboard mp-dashboard">
      <header className="dashboard-header">
        <div className="brand">
          <div className="brand-mark">M</div>
          <div>
            <p className="eyebrow">FIRESTORE MARKET MONITOR</p>
            <h1>MarketPulse</h1>
          </div>
        </div>

        <div className="mp-header-actions">
          <span className="connection-indicator">
            <span />
            Configured markets + Firestore
          </span>

          <button
            type="button"
            className="secondary-button"
            onClick={() => setRefreshVersion((value) => value + 1)}
          >
            ↻ Reconnect
          </button>
        </div>
      </header>

      <section className="hero">
        <p className="eyebrow">MARKET RESULTS DASHBOARD</p>
        <h2>Every market. Every result. One view.</h2>
        <p>
          Browse saved results by date, track Open and Close approvals,
          and inspect scraper attempts without triggering new website scrapes.
        </p>
      </section>

      {errors.length > 0 && (
        <section className="mp-error-banner">
          <strong>Some dashboard data could not be loaded.</strong>

          {errors.map((error, index) => (
            <p key={`${error}-${index}`}>{error}</p>
          ))}

          <p>
            Check that the configured-markets endpoint is deployed and allows
            requests from this website. Also check your Firebase configuration
            and Firestore Security Rules. The dashboard needs read access to
            marketResults, marketScraperState, and marketResultHistory.
          </p>
        </section>
      )}

      <section className="mp-date-toolbar">
        <div className="mp-toolbar-heading">
          <div>
            <p className="eyebrow">RESULT PERIOD</p>
            <h2>{dateLabel}</h2>
            <p>
              {dateMode === "all"
                ? `${allDates.length} dates found in saved data`
                : formatDate(selectedDate)}
              {" · India Standard Time"}
            </p>
          </div>
        </div>

        <div className="mp-date-buttons">
          <button
            type="button"
            className={dateMode === "today" ? "active" : ""}
            onClick={() => setDateMode("today")}
          >
            Today
          </button>

          <button
            type="button"
            className={dateMode === "yesterday" ? "active" : ""}
            onClick={() => setDateMode("yesterday")}
          >
            Yesterday
          </button>

          <button
            type="button"
            className={dateMode === "custom" ? "active" : ""}
            onClick={() => setDateMode("custom")}
          >
            Choose date
          </button>

          <button
            type="button"
            className={dateMode === "all" ? "active" : ""}
            onClick={() => setDateMode("all")}
          >
            All dates
          </button>
        </div>

        {dateMode === "custom" && (
          <div className="mp-custom-date">
            <label htmlFor="mp-date">Select date</label>
            <input
              id="mp-date"
              type="date"
              max={today}
              value={customDate}
              onChange={(event) => setCustomDate(event.target.value)}
            />
          </div>
        )}
      </section>

      <section className="mp-summary-grid">
        <div className="mp-summary-card">
          <span className="mp-summary-label">Markets shown</span>
          <strong>{summary.markets}</strong>
          <span>Configured in functions/src/markets.js</span>
        </div>

        <div className="mp-summary-card mp-summary-approved">
          <span className="mp-summary-label">Approved stages</span>
          <strong>{summary.approved}</strong>
          <span>Open and Close results approved</span>
        </div>

        <div className="mp-summary-card mp-summary-pending">
          <span className="mp-summary-label">Pending stages</span>
          <strong>{summary.pending}</strong>
          <span>Waiting for matching confirmation</span>
        </div>

        <div className="mp-summary-card mp-summary-failed">
          <span className="mp-summary-label">Failed / limit reached</span>
          <strong>{summary.failed}</strong>
          <span>Errors or maximum attempts reached</span>
        </div>
      </section>

      <section className="mp-controls">
        <div className="mp-search">
          <label htmlFor="mp-search">Search markets</label>
          <input
            id="mp-search"
            type="search"
            placeholder="Search by market name or ID..."
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>

        <div className="mp-filter">
          <label htmlFor="mp-stage">Stage</label>
          <select
            id="mp-stage"
            value={stageFilter}
            onChange={(event) => setStageFilter(event.target.value)}
          >
            <option value="all">Open + Close</option>
            <option value="open">Open only</option>
            <option value="close">Close only</option>
          </select>
        </div>

        <div className="mp-filter">
          <label htmlFor="mp-status">Status</label>
          <select
            id="mp-status"
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value)}
          >
            {STATUS_OPTIONS.map((status) => (
              <option key={status} value={status}>
                {status === "all"
                  ? "All statuses"
                  : status.replaceAll("_", " ")}
              </option>
            ))}
          </select>
        </div>
      </section>

      <section className="mp-table-card">
        <div className="mp-table-heading">
          <div>
            <p className="eyebrow">SAVED FIRESTORE DATA</p>
            <h2>Market results</h2>
            <p>
              {filteredRows.length} market/date rows · Live updates from
              Firestore
            </p>
          </div>

          <span className="live-tag">
            <span />
            LIVE
          </span>
        </div>

        {isLoading && (
          <div className="loading-panel">
            <span className="loader" />
            Loading configured markets and saved Firebase data...
          </div>
        )}

        {!isLoading && allMarkets.length === 0 && (
          <div className="mp-empty">
            <h3>No markets found</h3>
            <p>
              The configured-markets endpoint returned no enabled markets.
              Check functions/src/markets.js and make sure the
              getConfiguredMarkets function is deployed.
            </p>
          </div>
        )}

        {!isLoading &&
          allMarkets.length > 0 &&
          dateMode === "all" &&
          allDates.length === 0 && (
            <div className="mp-empty">
              <h3>No dated results found</h3>
              <p>
                No saved date keys were found in the history, result, or
                scraper state collections. Historical dates will appear once
                their records exist in Firestore.
              </p>
            </div>
          )}

        {!isLoading && filteredRows.length > 0 && (
          <div className="mp-table-scroll">
            <table className="mp-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Market</th>

                  {(stageFilter === "all" || stageFilter === "open") && (
                    <th>Open result</th>
                  )}

                  {(stageFilter === "all" || stageFilter === "close") && (
                    <th>Close result</th>
                  )}

                  <th>Scheduled timings</th>
                </tr>
              </thead>

              <tbody>
                {filteredRows.map((row) => (
                  <tr key={row.key}>
                    <td className="mp-date-cell">
                      <strong>{formatDate(row.dateKey)}</strong>
                      <small>{row.dateKey}</small>
                    </td>

                    <td className="mp-market-cell">
                      <strong>{row.market.name}</strong>
                      <small>{row.market.id}</small>

                      {row.market.enabled === false && (
                        <span className="mp-disabled-label">Disabled</span>
                      )}
                    </td>

                    {(stageFilter === "all" || stageFilter === "open") && (
                      <td>
                        <ResultCell
                          result={row.open.result}
                          status={row.open.status}
                          updatedAt={row.open.updatedAt}
                          sources={row.open.sources}
                          attempts={row.open.attempts}
                          lastError={row.open.lastError}
                        />
                      </td>
                    )}

                    {(stageFilter === "all" || stageFilter === "close") && (
                      <td>
                        <ResultCell
                          result={row.close.result}
                          status={row.close.status}
                          updatedAt={row.close.updatedAt}
                          sources={row.close.sources}
                          attempts={row.close.attempts}
                          lastError={row.close.lastError}
                        />
                      </td>
                    )}

                    <td className="mp-timing-cell">
                      <span>
                        <strong>Open:</strong> {row.market.openTime || "—"}
                      </span>
                      <span>
                        <strong>Close:</strong> {row.market.closeTime || "—"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {!isLoading &&
          allMarkets.length > 0 &&
          filteredRows.length === 0 &&
          !(dateMode === "all" && allDates.length === 0) && (
            <div className="mp-empty">
              <h3>No matching records</h3>
              <p>Try another date, market search, stage, or status.</p>
            </div>
          )}

        <div className="mp-table-footer">
          <span>
            Data source: Firebase Firestore · Timezone: Asia/Kolkata
          </span>
          <span>Refreshing this dashboard never triggers a scrape.</span>
        </div>
      </section>

      <section className="mp-information">
        <h3>Understanding the data</h3>
        <ul>
          <li>
            <strong>Approved:</strong> The stage is marked approved in saved
            history or scraper state.
          </li>
          <li>
            <strong>Pending:</strong> The latest recorded attempt did not
            obtain approval.
          </li>
          <li>
            <strong>Waiting:</strong> No saved result or state exists for this
            market, date, and stage.
          </li>
          <li>
            <strong>Updated:</strong> Shows the saved approval time or the
            latest attempt time when available.
          </li>
          <li>
            <strong>Attempts:</strong> Reads the attempt counter from
            marketScraperState; it is not a reconstructed history of every
            attempt.
          </li>
        </ul>

        <p>
          Older dates appear only when their data exists in Firestore. The
          marketResults collection stores the latest result per market;
          complete historical dates require marketResultHistory records.
        </p>
      </section>

      <footer className="dashboard-footer">
        MarketPulse · Firebase-only dashboard
      </footer>
    </main>
  );
}