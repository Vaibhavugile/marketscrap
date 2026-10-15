"use strict";

const { setGlobalOptions } = require("firebase-functions/v2");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");

const { scrapeMarketFromAllSources } = require("./src/scraper");
const { MARKETS } = require("./src/markets");

if (admin.apps.length === 0) {
  admin.initializeApp();
}

const db = admin.firestore();

// Receiving Firebase project.
// The source function's runtime service account must have
// roles/datastore.user on project matkanews-79fb7.
const RECEIVING_PROJECT_ID = "matkanews-79fb7";

const receivingApp =
  admin.apps.find((app) => app.name === "receiving-project") ||
  admin.initializeApp(
    {
      credential: admin.credential.applicationDefault(),
      projectId: RECEIVING_PROJECT_ID,
    },
    "receiving-project"
  );

const receivingDb = receivingApp.firestore();

const TIME_ZONE = "Asia/Kolkata";
const MAX_ATTEMPTS = 11;
const TELEGRAM_BOT_TOKEN = defineSecret("TELEGRAM_BOT_TOKEN");

// Add all your Telegram public channel usernames here.
const TELEGRAM_CHANNELS = [
  "@mresultupdates1",
  // "@yoursecondchannel",
  // "@yourthirdchannel",
];
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

/* =========================================================
   MIDNIGHT SESSION HELPERS
========================================================= */

function crossesMidnight(market) {
  // Example: open 22:00, close 00:02.
  // The close belongs to the previous session date.
  return String(market.closeTime) < String(market.openTime);
}

function getPreviousDateKey(dateKey) {
  // UTC is used only for date arithmetic.
  // The actual market timezone remains Asia/Kolkata.
  const date = new Date(`${dateKey}T00:00:00Z`);

  date.setUTCDate(date.getUTCDate() - 1);

  return date.toISOString().slice(0, 10);
}

function getConfiguredMarketList() {
  return MARKETS.filter(
    (market) => market && market.enabled !== false
  );
}

/* =========================================================
   RECEIVING PROJECT SYNC
========================================================= */

function calculateAnk(panna) {
  const value = String(panna || "");

  if (!/^\d{3}$/.test(value)) {
    return "";
  }

  return String(
    value
      .split("")
      .reduce((sum, digit) => sum + Number(digit), 0) % 10
  );
}

function isValidPanna(value) {
  return /^\d{3}$/.test(String(value ?? ""));
}

function calculateJodi(openAnk, closeAnk) {
  if (
    !/^\d$/.test(String(openAnk ?? "")) ||
    !/^\d$/.test(String(closeAnk ?? ""))
  ) {
    return "";
  }

  return `${openAnk}${closeAnk}`;
}

async function findReceivingMarket(scraperMarketId) {
  const snapshot = await receivingDb
    .collection("markets")
    .where("scraperMarketId", "==", scraperMarketId)
    .limit(2)
    .get();

  if (snapshot.empty) {
    throw new Error(
      `No receiving market has scraperMarketId=${scraperMarketId}`
    );
  }

  if (snapshot.size > 1) {
    throw new Error(
      `Duplicate scraperMarketId=${scraperMarketId} in receiving markets`
    );
  }

  const doc = snapshot.docs[0];

  return {
    id: doc.id,
    ...doc.data(),
  };
}

async function updateReceivingPanelChart(
  marketId,
  dateKey,
  values
) {
  const chartsRef = receivingDb
    .collection("markets")
    .doc(marketId)
    .collection("panelCharts");

  const snapshot = await chartsRef.get();

  const chartDoc = snapshot.docs.find((doc) => {
    const data = doc.data();

    const startDate = String(data.startDate || "");
    const endDate = String(data.endDate || "");

    return (
      startDate <= dateKey &&
      endDate >= dateKey &&
      Array.isArray(data.days)
    );
  });

  if (!chartDoc) {
    logger.warn(
      "No matching panel chart week found; result document still synced",
      {
        marketId,
        dateKey,
      }
    );

    return;
  }

  const data = chartDoc.data();

  const days = data.days.map((day) => {
    if (day.date !== dateKey) {
      return day;
    }

    const updated = { ...day };

    if (values.openPanna !== undefined) {
      updated.open = values.openPanna;
    }

    if (values.jodi !== undefined) {
      updated.jodi = values.jodi;
    }

    if (values.closePanna !== undefined) {
      updated.close = values.closePanna;
    }

    return updated;
  });

  await chartDoc.ref.update({
    days,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

async function syncApprovedStageToReceiving(
  market,
  stage,
  dateKey,
  approvedPanna
) {
  if (stage !== "open" && stage !== "close") {
    throw new Error(`Unsupported stage: ${stage}`);
  }

  if (!isValidPanna(approvedPanna)) {
    throw new Error(
      `Approved ${stage} result must contain exactly three digits`
    );
  }

  const receivingMarket = await findReceivingMarket(market.id);

  const marketId = receivingMarket.id;
  const marketName = receivingMarket.name || market.name;

  const resultRef = receivingDb
    .collection("results")
    .doc(`${marketId}_${dateKey}`);

  const marketRef = receivingDb
    .collection("markets")
    .doc(marketId);

  const existingResultSnap = await resultRef.get();

  const existingResult = existingResultSnap.exists
    ? existingResultSnap.data()
    : {};

  const now = admin.firestore.FieldValue.serverTimestamp();

  let resultPatch;
  let panelValues;
  let latestResult;

  if (stage === "open") {
    const openAnk = calculateAnk(approvedPanna);

    resultPatch = {
      marketId,
      marketName,
      resultDate: dateKey,
      year: Number(dateKey.slice(0, 4)),
      month: Number(dateKey.slice(5, 7)),
      day: Number(dateKey.slice(8, 10)),
      openPanna: approvedPanna,
      openAnk,
      closePanna: existingResult.closePanna || "",
      closeAnk: existingResult.closeAnk || "",
      jodi: existingResult.jodi || "",
      ...(!existingResult.createdAt
        ? { createdAt: now }
        : {}),
      updatedAt: now,
    };

    latestResult = {
      openPanna: approvedPanna,
      openAnk,
      jodi: existingResult.jodi || "",
      closePanna: existingResult.closePanna || "",
      closeAnk: existingResult.closeAnk || "",
      resultDate: dateKey,
    };

    panelValues = {
      openPanna: approvedPanna,
    };
  } else {
    // Close must use the already-saved open result.
    // Never fabricate a jodi if the open result is missing.
    const openPanna = String(
      existingResult.openPanna || ""
    );

    const openAnk = String(
      existingResult.openAnk || calculateAnk(openPanna)
    );

    if (
      !isValidPanna(openPanna) ||
      !/^\d$/.test(openAnk)
    ) {
      throw new Error(
        `Cannot sync close result for ${market.id}: open result is not yet present in receiving project`
      );
    }

    const closeAnk = calculateAnk(approvedPanna);
    const jodi = calculateJodi(openAnk, closeAnk);

    resultPatch = {
      closePanna: approvedPanna,
      closeAnk,
      jodi,
      updatedAt: now,
    };

    latestResult = {
      openPanna,
      openAnk,
      jodi,
      closePanna: approvedPanna,
      closeAnk,
      resultDate: dateKey,
    };

    panelValues = {
      jodi,
      closePanna: approvedPanna,
    };
  }

  // Merge ensures that saving the close result preserves the open result.
  await resultRef.set(resultPatch, { merge: true });

  await marketRef.set(
    {
      latestResult,
      updatedAt: now,
    },
    { merge: true }
  );

  // Keep the same announcement fields as ResultService.
  await receivingDb
    .collection("announcements")
    .doc("latest")
    .set(
      {
        marketId,
        marketName,
        openPanna: latestResult.openPanna || "",
        jodi: latestResult.jodi || "",
        closePanna: latestResult.closePanna || "",
        resultDate: dateKey,
        createdAt: now,
      },
      { merge: true }
    );

  // Keep the same breaking-news result format.
  await receivingDb
    .collection("breakingNews")
    .doc("latest")
    .set(
      {
        marketId,
        resultDate: dateKey,
        result: `${latestResult.openPanna || ""}-${latestResult.jodi || ""}-${latestResult.closePanna || ""}`,
        updatedAt: now,
      },
      { merge: true }
    );

  await updateReceivingPanelChart(
    marketId,
    dateKey,
    panelValues
  );

  logger.info("Approved result synced to receiving project", {
    scraperMarketId: market.id,
    receivingMarketId: marketId,
    stage,
    dateKey,
    result: approvedPanna,
  });
}

async function trySyncApprovedStage(
  market,
  stage,
  dateKey,
  stateRef,
  state
) {
  if (state.receivingSyncStatus === "synced") {
    return {
      status: "already_approved_and_synced",
    };
  }

  const approvedResult = state.approvedResult;

  try {
    await syncApprovedStageToReceiving(
      market,
      stage,
      dateKey,
      approvedResult
    );

    await stateRef.set(
      {
        receivingSyncStatus: "synced",
        receivingSyncedAt:
          admin.firestore.FieldValue.serverTimestamp(),
        receivingSyncError:
          admin.firestore.FieldValue.delete(),
      },
      { merge: true }
    );

    return {
      status: "synced",
    };
  } catch (error) {
    logger.error("Receiving-project sync failed", {
      market: market.name,
      marketId: market.id,
      stage,
      dateKey,
      errorMessage: error.message,
      errorCode: error.code || null,
      errorDetails: error.details || null,
      errorStack: error.stack || null,
    });

    await stateRef.set(
      {
        receivingSyncStatus: "pending",
        receivingSyncError: error.message,
        receivingSyncAttemptAt:
          admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    return {
      status: "sync_pending",
      message: error.message,
    };
  }
}

/* =========================================================
   SCRAPER — APPROVAL LOGIC PRESERVED
========================================================= */

async function processMarketStage(
  market,
  stage,
  dateKey,
  currentTime
) {
  const stateId = `${dateKey}_${market.id}_${stage}`;

  const stateRef = db
    .collection("marketScraperState")
    .doc(stateId);

  try {
    const snapshot = await stateRef.get();

    const state = snapshot.exists
      ? snapshot.data()
      : {};

    if (state.approved === true) {
      await tryPublishApprovedStageToTelegram(
  market,
  stage,
  dateKey,
  state.approvedResult,
  stateRef,
  state
);
      // Never scrape an already-approved stage again.
      // Retry receiving sync if it has not succeeded yet.
      const syncResult = await trySyncApprovedStage(
        market,
        stage,
        dateKey,
        stateRef,
        state
      );

      return {
        market: market.name,
        stage,
        status: syncResult.status,
        ...(syncResult.message
          ? { message: syncResult.message }
          : {}),
      };
    }

    if ((state.attempts || 0) >= MAX_ATTEMPTS) {
      return {
        market: market.name,
        stage,
        status: "attempt_limit_reached",
      };
    }

    // Determine whether this stage is due.
    const isCrossMidnight = crossesMidnight(market);
    let isDue;

    if (stage === "open") {
      // Open stage belongs to the current session date.
      isDue = currentTime >= market.openTime;
    } else if (isCrossMidnight) {
      // For markets such as 22:00 -> 00:02, the close is due
      // after midnight and belongs to the previous session date.
      isDue =
        currentTime >= market.closeTime &&
        currentTime < market.openTime;
    } else {
      // Normal same-day close.
      isDue = currentTime >= market.closeTime;
    }

    if (!isDue) {
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

    // Only accept a three-digit panna result.
    if (!isValidPanna(confirmation.candidateResult)) {
      await stateRef.set(
        {
          status: "invalid_result",
          lastError:
            `Invalid ${stage} panna: ${confirmation.candidateResult}`,
          lastConfirmation: confirmation,
        },
        { merge: true }
      );

      logger.warn("Approved candidate has invalid panna format", {
        market: market.name,
        stage,
        attempt,
        candidateResult: confirmation.candidateResult,
      });

      return {
        market: market.name,
        stage,
        attempt,
        status: "invalid_result",
      };
    }

    /*
     * Save the approved result in three source-project documents:
     * 1. marketResults — current result for each market.
     * 2. marketScraperState — approval and retry state.
     * 3. marketResultHistory — date-wise history.
     *
     * These three writes are committed together.
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
        updatedAt:
          admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    // 2. Scraper approval state.
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
        approvedAt:
          admin.firestore.FieldValue.serverTimestamp(),
        receivingSyncStatus: "pending",
      },
      { merge: true }
    );

    // 3. Permanent date-wise history.
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
        updatedAt:
          admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    // Commit source-project approval before receiving-project sync.
    await batch.commit();

    logger.info("Market result approved and saved", {
      market: market.name,
      stage,
      dateKey,
      result: confirmation.candidateResult,
      matchingSources: confirmation.matchingSources,
    });

    const freshStateSnapshot = await stateRef.get();

    const freshState = freshStateSnapshot.exists
      ? freshStateSnapshot.data()
      : {};
await tryPublishApprovedStageToTelegram(
  market,
  stage,
  dateKey,
  confirmation.candidateResult,
  stateRef,
  freshState
);
    const syncResult = await trySyncApprovedStage(
      market,
      stage,
      dateKey,
      stateRef,
      freshState
    );

    return {
      market: market.name,
      stage,
      status:
        syncResult.status === "synced"
          ? "approved_and_synced"
          : syncResult.status,
      result: confirmation.candidateResult,
      ...(syncResult.message
        ? { syncMessage: syncResult.message }
        : {}),
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

async function publishApprovedStageToTelegram(
  market,
  stage,
  dateKey,
  result,
  stateRef,
  state
) {
  const token = TELEGRAM_BOT_TOKEN.value();

  if (!token) {
    throw new Error("TELEGRAM_BOT_TOKEN is not configured.");
  }

  const sentChannels = new Set(
    Array.isArray(state.telegramSentChannels)
      ? state.telegramSentChannels
      : []
  );

  for (const channel of TELEGRAM_CHANNELS) {
    // Skip channels that already received this result.
    if (sentChannels.has(channel)) continue;

    const message = [
      "📢 MARKET RESULT",
      "",
      `Market: ${market.name}`,
      `Stage: ${String(stage).toUpperCase()}`,
      `Result: ${result}`,
      `Date: ${dateKey}`,
    ].join("\n");

    const response = await fetch(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: channel,
          text: message,
        }),
      }
    );

    const data = await response.json();

    if (!response.ok || !data.ok) {
      throw new Error(
        `Telegram failed for ${channel}: ${
          data.description || response.statusText
        }`
      );
    }

    // Record each successful channel immediately.
    await stateRef.set(
      {
        telegramSentChannels: [
          ...new Set([...sentChannels, channel]),
        ],
        telegramStatus: "pending",
        telegramLastSentAt:
          admin.firestore.FieldValue.serverTimestamp(),
        telegramError: null,
      },
      { merge: true }
    );

    sentChannels.add(channel);
  }

  await stateRef.set(
    {
      telegramStatus: "sent",
      telegramSentAt:
        admin.firestore.FieldValue.serverTimestamp(),
      telegramError: null,
    },
    { merge: true }
  );
}

async function tryPublishApprovedStageToTelegram(
  market,
  stage,
  dateKey,
  result,
  stateRef,
  state
) {
  try {
    await publishApprovedStageToTelegram(
      market,
      stage,
      dateKey,
      result,
      stateRef,
      state
    );

    return { status: "sent" };
  } catch (error) {
    logger.error("Telegram publishing failed; will retry", {
      market: market.name,
      stage,
      dateKey,
      message: error.message,
    });

    await stateRef.set(
      {
        telegramStatus: "pending",
        telegramError: error.message,
        telegramAttemptAt:
          admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    ).catch(() => {});

    return { status: "pending", message: error.message };
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
    secrets: [TELEGRAM_BOT_TOKEN],
  },
  async () => {
    const { dateKey, time } = getLocalDateAndTime();
    const markets = getConfiguredMarketList();

    const tasks = [];

    for (const market of markets) {
      // Open always belongs to today's session date.
      tasks.push(
        processMarketStage(
          market,
          "open",
          dateKey,
          time
        )
      );

      // A midnight close belongs to yesterday's session
      // until the next opening time is reached.
      const closeDateKey =
        crossesMidnight(market) && time < market.openTime
          ? getPreviousDateKey(dateKey)
          : dateKey;

      tasks.push(
        processMarketStage(
          market,
          "close",
          closeDateKey,
          time
        )
      );

      // After today's open time, also revisit yesterday's
      // close state so an already-approved but unsynced close
      // can retry synchronization.
      if (crossesMidnight(market) && time >= market.openTime) {
        tasks.push(
          processMarketStage(
            market,
            "close",
            getPreviousDateKey(dateKey),
            time
          )
        );
      }
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

        // Fallback to current result only if its date matches.
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
