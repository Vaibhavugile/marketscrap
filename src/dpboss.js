
const axios = require("axios");
const cheerio = require("cheerio");

// Change only this name when you want another market.
const MARKET_NAME = "Time Bazar";

const URL = "https://dpbossss.com/";

async function scrapeDPBossMarket() {
  const fetchedAt = new Date().toISOString();

  try {
    const response = await axios.get(URL, {
      timeout: 15000,
      headers: {
        "User-Agent": "MarketResultMonitor/1.0",
        Accept: "text/html,application/xhtml+xml",
      },
    });

    const $ = cheerio.load(response.data);
    const targetName = MARKET_NAME.trim().toLowerCase();

    // Find the exact market heading.
    const heading = $("h4")
      .filter(
        (_, element) =>
          $(element).text().replace(/\s+/g, " ").trim().toLowerCase() ===
          targetName
      )
      .first();

    if (!heading.length) {
      return {
        market: MARKET_NAME,
        source: "dpboss",
        status: "not_found",
        fetchedAt,
      };
    }

    const card = heading.parent();
    const cardText = card.text().replace(/\s+/g, " ").trim();

    // Supports results such as 177-5 and 177-52-468.
    const resultMatch = cardText.match(
      /\b(\d{3})\s*-\s*(\d{1,2})(?:\s*-\s*(\d{3}))?\b/
    );

    if (!resultMatch) {
      return {
        market: MARKET_NAME,
        source: "dpboss",
        rawResult: cardText,
        status: "pending",
        fetchedAt,
      };
    }

    const [, openPanel, openJodi, closePanel] = resultMatch;
    const closeComplete = Boolean(closePanel);

    return {
      market: MARKET_NAME,
      source: "dpboss",
      rawResult: resultMatch[0],
      openPanel,
      openJodi,
      closePanel: closePanel || null,
      openComplete: true,
      closeComplete,
      status: closeComplete ? "complete_candidate" : "open_candidate",
      fetchedAt,
    };
  } catch (error) {
    return {
      market: MARKET_NAME,
      source: "dpboss",
      status: "error",
      error: error.response
        ? `HTTP ${error.response.status}`
        : error.message,
      fetchedAt,
    };
  }
}

scrapeDPBossMarket()
  .then((result) => console.log(JSON.stringify(result, null, 2)))
  .catch((error) => console.error("Unexpected error:", error.message));
