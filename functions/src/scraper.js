
"use strict";

const axios = require("axios");
const cheerio = require("cheerio");
const { MARKETS } = require("./markets");

// ============================================
// CONFIGURATION
// ============================================

const SOURCES = {
  dpboss: "https://dpbossss.com/",
  madhurbazar: "https://madhurbazar.com/",
  mydpboss: "https://mydpboss.in/",
};

const SOURCE_IDS = ["dpboss", "madhurbazar", "mydpboss"];

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};

const TIMEOUT = 15000;
const REQUIRED_AGREEMENTS = 2;

// ============================================
// COMMON HELPERS
// ============================================

function normalize(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function normalizeRaw(value) {
  return String(value || "")
    .replace(/[–—−]/g, "-")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function fetchPage(url) {
  const response = await axios.get(url, {
    timeout: TIMEOUT,
    headers: HEADERS,
  });

  return cheerio.load(response.data);
}

function getSourceMarketName(market, source) {
  if (typeof market === "string") {
    return market;
  }

  return (
    market?.aliases?.[source] ||
    market?.name ||
    market?.id ||
    ""
  );
}

function getCheckingStage(market) {
  if (typeof market === "string") {
    return "open";
  }

  return market?.checking || market?.stage || "open";
}

// ============================================
// PARSE MARKET RESULT
// ============================================

function parseResultText(text) {
  const rawResult = normalizeRaw(text);

  const emptyResult = {
    rawResult: rawResult || null,
    openPanel: null,
    openJodi: null,
    closePanel: null,
    openComplete: false,
    closeComplete: false,
    status: "pending",
  };

  if (!rawResult) {
    return emptyResult;
  }

  // Examples:
  // 177-57-179
  // 177-5X-XXX
  // 177-57-XXX
  // XXX-XX-XXX
  // 177-57

  const match = rawResult.match(
    /^(\d{3}|X+)\s*-\s*(\d{1,2}|X+)\s*X?\s*(?:-\s*(\d{3}|X+))?$/i
  );

  if (!match) {
    return {
      ...emptyResult,
      status: /^(loading|please wait)\.{0,3}$/i.test(rawResult)
        ? "loading"
        : "unrecognized",
    };
  }

  const [, panel, jodi, close] = match;

  const openPanel = /^\d{3}$/.test(panel)
    ? panel
    : null;

  const openJodi = /^\d{1,2}$/.test(jodi)
    ? jodi
    : null;

  const closePanel = /^\d{3}$/.test(close || "")
    ? close
    : null;

  const openComplete = Boolean(openPanel && openJodi);
  const closeComplete = Boolean(closePanel);

  return {
    rawResult,
    openPanel,
    openJodi,
    closePanel,
    openComplete,
    closeComplete,
    status: !openComplete
      ? "pending"
      : closeComplete
        ? "complete_candidate"
        : "open_candidate",
  };
}

// ============================================
// STANDARD RESULT STRUCTURE
// ============================================

function makeResult({
  market,
  canonicalMarket = market,
  source,
  rawResult = null,
  status,
  error = null,
}) {
  const parsed = parseResultText(rawResult);

  return {
    market: canonicalMarket,
    source,
    sourceMarketName: market,
    rawResult: parsed.rawResult,
    openPanel: parsed.openPanel,
    openJodi: parsed.openJodi,
    closePanel: parsed.closePanel,
    openComplete: parsed.openComplete,
    closeComplete: parsed.closeComplete,
    status: error
      ? "error"
      : status || parsed.status,
    error,
    fetchedAt: new Date().toISOString(),
  };
}

// ============================================
// SOURCE 1: MADHURBAZAR
// ============================================

async function scrapeMadhurBazar(
  marketName,
  canonicalMarket = marketName
) {
  const source = "madhurbazar";

  try {
    const $ = await fetchPage(SOURCES.madhurbazar);
    const target = normalize(marketName);

    const heading = $(".game-name-row")
      .filter((_, element) => {
        return normalize($(element).text()) === target;
      })
      .first();

    if (!heading.length) {
      return makeResult({
        market: marketName,
        canonicalMarket,
        source,
        status: "not_found",
      });
    }

    const card = heading.closest(".satta-result");

    const rawResult = card
      .find(".game-data-row.blinking")
      .first()
      .text();

    return makeResult({
      market: marketName,
      canonicalMarket,
      source,
      rawResult,
    });
  } catch (error) {
    return makeResult({
      market: marketName,
      canonicalMarket,
      source,
      status: "error",
      error: error.response
        ? `HTTP ${error.response.status}`
        : error.message,
    });
  }
}

// ============================================
// SOURCE 2: MYDPBOSS
// ============================================

async function scrapeMyDPBoss(
  marketName,
  canonicalMarket = marketName
) {
  const source = "mydpboss";

  try {
    const $ = await fetchPage(SOURCES.mydpboss);

    $("script, style, noscript").remove();

    const pageText = $("body")
      .text()
      .replace(/\s+/g, " ")
      .trim();

    const pattern = new RegExp(
      escapeRegex(marketName.trim()) +
        "\\s*((?:\\d{3}|X+)\\s*-\\s*(?:\\d{1,2}|X+)\\s*(?:X\\s*)?(?:-\\s*(?:\\d{3}|X+))?)(?=\\s*\\()",
      "i"
    );

    const match = pageText.match(pattern);

    if (!match) {
      return makeResult({
        market: marketName,
        canonicalMarket,
        source,
        status: "not_found",
      });
    }

    return makeResult({
      market: marketName,
      canonicalMarket,
      source,
      rawResult: match[1].trim(),
    });
  } catch (error) {
    return makeResult({
      market: marketName,
      canonicalMarket,
      source,
      status: "error",
      error: error.response
        ? `HTTP ${error.response.status}`
        : error.message,
    });
  }
}

// ============================================
// SOURCE 3: DPBOSS
// ============================================

async function scrapeDPBoss(
  marketName,
  canonicalMarket = marketName
) {
  const source = "dpboss";

  try {
    const $ = await fetchPage(SOURCES.dpboss);
    const target = normalize(marketName);

    const heading = $("h4")
      .filter((_, element) => {
        return normalize($(element).text()) === target;
      })
      .first();

    if (!heading.length) {
      return makeResult({
        market: marketName,
        canonicalMarket,
        source,
        status: "not_found",
      });
    }

    const card = heading.parent();
    const cardText = normalizeRaw(card.text());

    const remainingText = cardText
      .replace(
        new RegExp(
          "^" + escapeRegex(heading.text().trim()),
          "i"
        ),
        ""
      )
      .trim();

    const match = remainingText.match(
      /^((?:\d{3}|X+)\s*-\s*(?:\d{1,2}|X+)\s*(?:X\s*)?(?:-\s*(?:\d{3}|X+))?)/i
    );

    if (!match) {
      return makeResult({
        market: marketName,
        canonicalMarket,
        source,
        rawResult: remainingText || null,
        status: remainingText
          ? "unrecognized"
          : "pending",
      });
    }

    return makeResult({
      market: marketName,
      canonicalMarket,
      source,
      rawResult: match[1].trim(),
    });
  } catch (error) {
    return makeResult({
      market: marketName,
      canonicalMarket,
      source,
      status: "error",
      error: error.response
        ? `HTTP ${error.response.status}`
        : error.message,
    });
  }
}

// ============================================
// EVALUATE RESULT FOR A STAGE
// ============================================

function evaluateResult(result, market) {
  const checking = getCheckingStage(market);
  const validMode = ["open", "close"].includes(checking);

  const targetResultAvailable =
    checking === "open"
      ? result.openComplete
      : checking === "close"
        ? result.closeComplete
        : false;

  let isTodayResult = false;
  let todayCheck;

  if (!validMode) {
    todayCheck = "invalid_checking_mode";
  } else if (result.status === "error") {
    todayCheck = "source_error";
  } else if (
    ["not_found", "unrecognized", "loading"].includes(
      result.status
    )
  ) {
    todayCheck = result.status;
  } else if (checking === "open") {
    if (!result.openComplete) {
      todayCheck = "open_result_pending";
    } else if (result.closeComplete) {
      // A complete close value may be an older result.
      // Do not automatically approve it as today's open.
      todayCheck = "close_already_present_not_first_open";
    } else {
      isTodayResult = true;
      todayCheck = "open_only_candidate";
    }
  } else {
    if (result.closeComplete) {
      isTodayResult = true;
      todayCheck = "close_result_candidate";
    } else {
      todayCheck = "close_result_pending";
    }
  }

  return {
    ...result,
    checking,
    targetResultAvailable,
    isFirstOpenCandidate:
      checking === "open" &&
      result.openComplete &&
      !result.closeComplete,
    isTodayResult,
    todayCheck,
  };
}

// ============================================
// GET NORMALIZED STAGE VALUE
// ============================================


function getStageValue(result, stage) {
  if (!result || result.isTodayResult !== true) {
    return null;
  }

  if (stage === "open") {
    // Open approval must contain ONLY the 3-digit panna.
    const panna = String(result.openPanel ?? "").trim();

    if (
      result.openComplete !== true ||
      !/^\d{3}$/.test(panna)
    ) {
      return null;
    }

    return panna;
  }

  if (stage === "close") {
    // Close approval must contain ONLY the 3-digit close panna.
    const panna = String(result.closePanel ?? "").trim();

    if (
      result.closeComplete !== true ||
      !/^\d{3}$/.test(panna)
    ) {
      return null;
    }

    return panna;
  }

  return null;
}


// ============================================
// CONFIRM RESULT FROM AT LEAST TWO SOURCES
// ============================================

function confirmResultUpload({
  marketId,
  marketName,
  stage,
  sources,
}) {
  const report = {
    marketId: marketId || null,
    marketName: marketName || marketId || null,
    stage,
    requiredAgreements: REQUIRED_AGREEMENTS,
    candidateResult: null,
    matchingSources: [],
    matchingCount: 0,
    rejectedSources: [],
    status: "DO_NOT_UPLOAD",
    approved: false,
    warning: null,
    reasons: [],
  };

  if (!["open", "close"].includes(stage)) {
    report.reasons.push(
      'Invalid checking value. Use "open" or "close".'
    );

    return report;
  }

  if (!Array.isArray(sources)) {
    report.reasons.push("Source results are missing.");
    return report;
  }

  const groups = new Map();

  for (const sourceId of SOURCE_IDS) {
    const result = sources.find(
      (item) => item.source === sourceId
    );

    if (!result) {
      report.rejectedSources.push({
        source: sourceId,
        reason: "Source result missing.",
      });

      continue;
    }

    if (result.status === "error") {
      report.rejectedSources.push({
        source: sourceId,
        reason: result.error || "Source request failed.",
      });

      continue;
    }

    if (result.isTodayResult !== true) {
      report.rejectedSources.push({
        source: sourceId,
        reason: result.todayCheck || "Result not verified.",
      });

      continue;
    }

    const value = getStageValue(result, stage);

    if (!value) {
      report.rejectedSources.push({
        source: sourceId,
        reason:
          `No complete ${stage} result marked as today's result.`,
      });

      continue;
    }

    if (!groups.has(value)) {
      groups.set(value, []);
    }

    groups.get(value).push(sourceId);
  }

  let bestValue = null;
  let bestSources = [];

  for (const [value, sourceIds] of groups.entries()) {
    if (sourceIds.length > bestSources.length) {
      bestValue = value;
      bestSources = sourceIds;
    }
  }

  report.candidateResult = bestValue;
  report.matchingSources = bestSources;
  report.matchingCount = bestSources.length;

  if (
    !bestValue ||
    bestSources.length < REQUIRED_AGREEMENTS
  ) {
    report.reasons.push(
      `At least ${REQUIRED_AGREEMENTS} websites must agree on the same complete ${stage} result.`
    );

    return report;
  }

  report.approved = true;
  report.status = "OK_TO_UPLOAD";

  report.reasons.push(
    `${bestSources.length} websites agree on ${bestValue}.`
  );

  const otherSources = SOURCE_IDS.filter(
    (sourceId) => !bestSources.includes(sourceId)
  );

  if (otherSources.length > 0) {
    report.warning =
      "Disagreement or unavailable result from: " +
      otherSources.join(", ");

    report.reasons.push(report.warning);
  }

  return report;
}

// ============================================
// SCRAPE ONE MARKET FROM ALL THREE SOURCES
// ============================================

async function scrapeMarketFromAllSources(market) {
  const canonicalMarket =
    typeof market === "string"
      ? market
      : market?.name;

  const marketId =
    typeof market === "string"
      ? null
      : market?.id || null;

  const checking = getCheckingStage(market);

  if (!canonicalMarket) {
    throw new Error("Market is missing its name.");
  }

  if (!["open", "close"].includes(checking)) {
    throw new Error(
      `Invalid stage "${checking}" for ${canonicalMarket}.`
    );
  }

  const [dpboss, madhurbazar, mydpboss] =
    await Promise.all([
      scrapeDPBoss(
        getSourceMarketName(market, "dpboss"),
        canonicalMarket
      ),

      scrapeMadhurBazar(
        getSourceMarketName(market, "madhurbazar"),
        canonicalMarket
      ),

      scrapeMyDPBoss(
        getSourceMarketName(market, "mydpboss"),
        canonicalMarket
      ),
    ]);

  const rawSources = [
    dpboss,
    madhurbazar,
    mydpboss,
  ];

  // Evaluate each source for the requested stage.
  const sources = rawSources.map((result) =>
    evaluateResult(result, { checking })
  );

  const confirmation = confirmResultUpload({
    marketId,
    marketName: canonicalMarket,
    stage: checking,
    sources,
  });

  return {
    market: canonicalMarket,
    marketId,
    checking,
    checkedAt: new Date().toISOString(),
    sources,
    confirmation,
  };
}

// ============================================
// SCRAPE ALL ENABLED MARKETS
// ============================================

async function scrapeAllMarkets(options = {}) {
  const requestedStage = options.stage || options.checking;

  const markets = (
    Array.isArray(MARKETS) ? MARKETS : []
  ).filter((market) => {
    return (
      typeof market === "string" ||
      (market && market.enabled !== false)
    );
  });

  const results = await Promise.all(
    markets.map(async (market) => {
      if (!market || (typeof market !== "string" && !market.name)) {
        return {
          market: market || null,
          error: "Market is missing its name.",
        };
      }

      const selectedMarket =
        typeof market === "string"
          ? {
              name: market,
              checking: requestedStage || "open",
            }
          : {
              ...market,
              checking:
                requestedStage ||
                market.checking ||
                market.stage ||
                "open",
            };

      try {
        return await scrapeMarketFromAllSources(
          selectedMarket
        );
      } catch (error) {
        return {
          market:
            typeof market === "string"
              ? market
              : market.name,
          error: error.message,
        };
      }
    })
  );

  return {
    checkedAt: new Date().toISOString(),
    stage: requestedStage || "configured",
    marketCount: results.length,
    results,
  };
}

// ============================================
// TERMINAL REPORT
// ============================================

async function main() {
  console.log("Fetching configured market results...\n");

  const report = await scrapeAllMarkets();

  console.log(JSON.stringify(report, null, 2));

  console.log("\n========== CONFIRMATION SUMMARY ==========\n");

  let approvedCount = 0;

  for (const market of report.results) {
    if (!market.confirmation) {
      console.log(
        `ERROR | ${market.market || "Unknown market"} | ` +
        `${market.error || "Confirmation unavailable"}`
      );

      continue;
    }

    const decision = market.confirmation;

    console.log(
      `${decision.status} | ${market.market} | ` +
      `${decision.stage.toUpperCase()} | ` +
      `${decision.candidateResult || "NO CONFIRMED RESULT"} | ` +
      `${decision.matchingCount}/${decision.requiredAgreements} matching websites`
    );

    if (decision.approved) {
      approvedCount++;
    }

    if (decision.warning) {
      console.log(`WARNING: ${decision.warning}`);
    }

    for (const reason of decision.reasons) {
      console.log(`- ${reason}`);
    }

    for (const rejected of decision.rejectedSources || []) {
      console.log(
        `REJECTED | ${rejected.source} | ${rejected.reason}`
      );
    }

    console.log("");
  }

  console.log(`Approved stages: ${approvedCount}`);
  console.log("No Firebase upload is performed by this script.");
}

// ============================================
// EXPORTS
// ============================================

module.exports = {
  SOURCES,
  SOURCE_IDS,
  REQUIRED_AGREEMENTS,
  parseResultText,
  makeResult,
  evaluateResult,
  getStageValue,
  confirmResultUpload,
  scrapeMadhurBazar,
  scrapeMyDPBoss,
  scrapeDPBoss,
  scrapeMarketFromAllSources,
  scrapeAllMarkets,
};

if (require.main === module) {
  main().catch((error) => {
    console.error("Scraper failed:", error.message);
    process.exitCode = 1;
  });
}
