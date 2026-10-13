
"use strict";

const { setGlobalOptions } = require("firebase-functions/v2");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onRequest } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");

const { scrapeMarketFromAllSources } = require("./src/scraper");
const { MARKETS } = require("./src/markets");

if (admin.apps.length === 0) {
  admin.initializeApp();
}

const db = admin.firestore();

const TIME_ZONE = "Asia/Kolkata";
const MAX_ATTEMPTS = 10;

setGlobalOptions({
  maxInstances: 1,
});

function getLocalDateAndTime() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());

  const values = {};

  for (const part of parts) {
    if (part.type !== "literal") {
      values[part.type] = part.value;
    }
  }

  return {
    dateKey: `${values.year}-${values.month}-${values.day}`,
    time: `${values.hour}:${values.minute}`,
  };
}

function getConfiguredMarketList() {
  return MARKETS.filter(
    (market) => market && market.enabled !== false
  );
}

/* =========================================================
   EXISTING SCRAPER — APPROVAL LOGIC PRESERVED
========================================================= */

async function processMarketStage(market, stage, dateKey, currentTime) {
  const stateId = `${dateKey}_${market.id}_${stage}`;
  const stateRef = db.collection("marketScraperState").doc(stateId);

  try {
    const snapshot = await stateRef.get();
    const state = snapshot.exists ? snapshot.data() : {};

    if (state.approved === true) {
      return {
        market: market.name,
        stage,
        status: "already_approved",
      };
    }

    if ((state.attempts || 0) >= MAX_ATTEMPTS) {
      return {
        market: market.name,
        stage,
        status: "attempt_limit_reached",
      };
    }

    const scheduledTime =
      stage === "open" ? market.openTime : market.closeTime;

    if (currentTime < scheduledTime) {
      return {
        market: market.name,
        stage,
        status: "not_due",
      };
    }

    const attempt = (state.attempts || 0) + 1;

    await stateRef.set(
      {
        marketId: market.id,
        marketName: market.name,
        stage,
        dateKey,
        attempts: attempt,
        lastAttemptAt:
          admin.firestore.FieldValue.serverTimestamp(),
        status: "checking",
      },
      { merge: true }
    );

    const report = await scrapeMarketFromAllSources({
      ...market,
      checking: stage,
    });

    const confirmation = report.confirmation;

    if (!confirmation || confirmation.approved !== true) {
      await stateRef.set(
        {
          status: "pending",
          lastConfirmation: confirmation || null,
        },
        { merge: true }
      );

      logger.info("Result not approved", {
        market: market.name,
        stage,
        attempt,
        matchingCount: confirmation?.matchingCount || 0,
      });

      return {
        market: market.name,
        stage,
        attempt,
        status: "pending",
        matchingCount: confirmation?.matchingCount || 0,
      };
    }

    /*
     * Save the approved result in three places:
     * 1. marketResults: latest result for each market.
     * 2. marketScraperState: scraper approval state.
     * 3. marketResultHistory: permanent date-wise result history.
     *
     * All three writes are committed together.
     */

    const batch = db.batch();

    // 1. Current result document.
    const resultRef = db
      .collection("marketResults")
      .doc(market.id);

    batch.set(
      resultRef,
      {
        marketId: market.id,
        marketName: market.name,
        [`${stage}Result`]: confirmation.candidateResult,
        [`${stage}Sources`]: confirmation.matchingSources,
        [`${stage}ApprovedAt`]:
          admin.firestore.FieldValue.serverTimestamp(),
        [`${stage}DateKey`]: dateKey,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    // 2. Existing scraper approval state.
    batch.set(
      stateRef,
      {
        marketId: market.id,
        marketName: market.name,
        stage,
        dateKey,
        attempts: attempt,
        approved: true,
        status: "approved",
        approvedResult: confirmation.candidateResult,
        matchingSources: confirmation.matchingSources,
        approvedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    // 3. Permanent date-wise result history.
    // The deterministic ID prevents duplicate records for the same
    // date, market, and stage.
    const historyId = `${dateKey}_${market.id}_${stage}`;

    const historyRef = db
      .collection("marketResultHistory")
      .doc(historyId);

    batch.set(
      historyRef,
      {
        marketId: market.id,
        marketName: market.name,
        dateKey,
        stage,
        [`${stage}Result`]: confirmation.candidateResult,
        [`${stage}Sources`]: confirmation.matchingSources,
        [`${stage}ApprovedAt`]:
          admin.firestore.FieldValue.serverTimestamp(),
        approvedResult: confirmation.candidateResult,
        matchingSources: confirmation.matchingSources,
        approved: true,
        status: "approved",
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    // Commit all three records together.
    await batch.commit();

    logger.info("Market result approved and saved", {
      market: market.name,
      stage,
      dateKey,
      result: confirmation.candidateResult,
      matchingSources: confirmation.matchingSources,
    });

    return {
      market: market.name,
      stage,
      status: "approved",
      result: confirmation.candidateResult,
    };
  } catch (error) {
    logger.error("Market stage failed", {
      market: market.name,
      stage,
      message: error.message,
    });

    await stateRef
      .set(
        {
          marketId: market.id,
          marketName: market.name,
          stage,
          dateKey,
          status: "error",
          lastError: error.message,
        },
        { merge: true }
      )
      .catch(() => {});

    return {
      market: market.name,
      stage,
      status: "error",
      message: error.message,
    };
  }
}

/* =========================================================
   SCHEDULED MARKET SCRAPER
========================================================= */

exports.scheduledMarketScraper = onSchedule(
  {
    schedule: "every 5 minutes",
    timeZone: TIME_ZONE,
    timeoutSeconds: 300,
    memory: "512MiB",
    maxInstances: 1,
  },
  async () => {
    const { dateKey, time } = getLocalDateAndTime();
    const markets = getConfiguredMarketList();

    const tasks = [];

    for (const market of markets) {
      tasks.push(
        processMarketStage(market, "open", dateKey, time)
      );

      tasks.push(
        processMarketStage(market, "close", dateKey, time)
      );
    }

    const results = await Promise.all(tasks);

    logger.info("Scheduled market scraper finished", {
      dateKey,
      time,
      results,
    });
  }
);

/* =========================================================
   CONFIGURED MARKETS ENDPOINT
========================================================= */

exports.getConfiguredMarkets = onRequest(
  {
    region: "us-central1",
    cors: true,
  },
  (req, res) => {
    if (req.method !== "GET") {
      return res.status(405).json({
        success: false,
        message: "Method not allowed",
      });
    }

    const markets = getConfiguredMarketList().map((market) => ({
      id: market.id,
      name: market.name,
      openTime: market.openTime,
      closeTime: market.closeTime,
    }));

    return res.status(200).json({
      success: true,
      count: markets.length,
      timezone: TIME_ZONE,
      markets,
    });
  }
);

/* =========================================================
   PUBLIC READ-ONLY RESULTS API

   Reads saved results; it never starts a scrape.
========================================================= */

exports.publicMarketApi = onRequest(
  {
    region: "us-central1",
    cors: true,
    timeoutSeconds: 60,
    memory: "256MiB",
    maxInstances: 5,
  },
  async (req, res) => {
    // Avoid caching responses containing market results.
    res.set("Cache-Control", "no-store");

    if (req.method === "OPTIONS") {
      return res.status(204).send("");
    }

    if (req.method !== "GET") {
      return res.status(405).json({
        success: false,
        message: "Only GET requests are supported.",
      });
    }

    try {
      const path = (req.path || "/")
        .replace(/\/+$/, "")
        .toLowerCase();

      // Health check.
      if (path === "/v1/health") {
        return res.status(200).json({
          success: true,
          service: "MatkaResult API",
          status: "online",
          timestamp: new Date().toISOString(),
        });
      }

      const markets = getConfiguredMarketList();

      // List configured markets.
      if (path === "/v1/markets") {
        return res.status(200).json({
          success: true,
          count: markets.length,
          timezone: TIME_ZONE,
          data: markets.map((market) => ({
            id: market.id,
            name: market.name,
            openTime: market.openTime,
            closeTime: market.closeTime,
          })),
        });
      }

      const today = getLocalDateAndTime().dateKey;
      const isTodayEndpoint = path === "/v1/results/today";
      const isResultsEndpoint = path === "/v1/results";

      if (!isTodayEndpoint && !isResultsEndpoint) {
        return res.status(404).json({
          success: false,
          message: "Endpoint not found.",
          endpoints: [
            "/v1/health",
            "/v1/markets",
            "/v1/results/today",
            "/v1/results?date=YYYY-MM-DD",
            "/v1/results?marketId=time_bazar",
          ],
        });
      }

      // Use today's date by default.
      const date = isTodayEndpoint
        ? today
        : String(req.query.date || today);

      // Validate date format.
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return res.status(400).json({
          success: false,
          message: "Invalid date. Use YYYY-MM-DD.",
        });
      }

      // Validate that the date exists on the calendar.
      const parsedDate = new Date(`${date}T00:00:00Z`);

      if (
        Number.isNaN(parsedDate.getTime()) ||
        parsedDate.toISOString().slice(0, 10) !== date
      ) {
        return res.status(400).json({
          success: false,
          message: "Invalid calendar date.",
        });
      }

      // Optional market filter.
      const requestedMarketId = req.query.marketId
        ? String(req.query.marketId)
        : null;

      const selectedMarkets = markets.filter(
        (market) =>
          !requestedMarketId || market.id === requestedMarketId
      );

      if (
        requestedMarketId &&
        selectedMarkets.length === 0
      ) {
        return res.status(404).json({
          success: false,
          message: "Market is not configured or is disabled.",
          marketId: requestedMarketId,
        });
      }

      // Read current result documents.
      const currentSnapshot = await db
        .collection("marketResults")
        .get();

      const currentResults = new Map();

      currentSnapshot.forEach((doc) => {
        currentResults.set(doc.id, doc.data());
      });

      // Read date-wise result history.
      const historySnapshot = await db
        .collection("marketResultHistory")
        .where("dateKey", "==", date)
        .get();

      const historyResults = new Map();

      historySnapshot.forEach((doc) => {
        const record = doc.data();
        const stage = String(record.stage || "").toLowerCase();

        if (
          record.marketId &&
          (stage === "open" || stage === "close")
        ) {
          historyResults.set(
            `${record.marketId}_${stage}`,
            record
          );
        }
      });

      function getApprovedStage(market, stage) {
        const historyRecord = historyResults.get(
          `${market.id}_${stage}`
        );

        const current = currentResults.get(market.id) || {};

        // Prefer the result saved in date-wise history.
        if (
          historyRecord &&
          (
            historyRecord.approved === true ||
            historyRecord.status === "approved"
          )
        ) {
          const value =
            historyRecord[`${stage}Result`] ??
            historyRecord.approvedResult ??
            historyRecord.result ??
            null;

          if (
            value !== null &&
            value !== undefined &&
            value !== ""
          ) {
            const sources =
              historyRecord[`${stage}Sources`] ??
              historyRecord.matchingSources ??
              historyRecord.sources ??
              [];

            return {
              result: String(value),
              status: "approved",
              approved: true,
              sources: Array.isArray(sources) ? sources : [],
              approvedAt:
                historyRecord[`${stage}ApprovedAt`] ??
                historyRecord.approvedAt ??
                null,
            };
          }
        }

        // Fallback to the current result only if its date matches.
        const savedDate = current[`${stage}DateKey`];
        const value = current[`${stage}Result`];

        if (
          savedDate === date &&
          value !== null &&
          value !== undefined &&
          value !== ""
        ) {
          const sources = current[`${stage}Sources`] || [];

          return {
            result: String(value),
            status: "approved",
            approved: true,
            sources: Array.isArray(sources) ? sources : [],
            approvedAt: current[`${stage}ApprovedAt`] || null,
          };
        }

        return {
          result: null,
          status: "not_published",
          approved: false,
          sources: [],
          approvedAt: null,
        };
      }

      // Build the API response.
      const data = selectedMarkets.map((market) => ({
        marketId: market.id,
        marketName: market.name,
        date,
        openTime: market.openTime,
        closeTime: market.closeTime,
        open: getApprovedStage(market, "open"),
        close: getApprovedStage(market, "close"),
      }));

      return res.status(200).json({
        success: true,
        date,
        timezone: TIME_ZONE,
        count: data.length,
        data,
      });
    } catch (error) {
      logger.error("Public market API failed", {
        message: error.message,
      });

      return res.status(500).json({
        success: false,
        message: "Unable to retrieve market data.",
      });
    }
  }
);
