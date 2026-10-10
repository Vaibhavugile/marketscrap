
const axios = require("axios");
const cheerio = require("cheerio");

const URL = "https://madhurbazar.com/";
const MARKET_NAME = "";
const MARKET_SELECTOR_NAME = "time";

async function scrapeTimeBazar() {
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

    // Find the exact Time Bazar card.
    const nameElement = $(".game-name-row")
      .filter((_, element) => {
        const name = $(element)
          .text()
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase();

        return name === MARKET_SELECTOR_NAME.toLowerCase();
      })
      .first();

    if (!nameElement.length) {
      return {
        market: MARKET_NAME,
        source: "madhurbazar",
        status: "not_found",
        fetchedAt,
      };
    }

    const card = nameElement.closest(".satta-result");

    // Read the actual result, not the guessing banner.
    const rawResult = card
      .find(".game-data-row.blinking")
      .first()
      .text()
      .replace(/[–—−]/g, "-")
      .replace(/\s+/g, " ")
      .trim();

    /*
      Supported examples:
      177 - 5 X - XXX  => open result only
      177 - 5 X - 468   => open and close results
      XXX - XX - XXX    => no result yet
    */
    const match = rawResult.match(
      /^(\d{3}|X+)\s*-\s*(\d{1,2}|X+)\s*X?\s*-\s*(\d{3}|X+)$/i
    );

    if (!match) {
      return {
        market: MARKET_NAME,
        source: "madhurbazar",
        rawResult,
        status: rawResult ? "unrecognized" : "pending",
        fetchedAt,
      };
    }

    const [, panelValue, jodiValue, closeValue] = match;

    const openPanelComplete = /^\d{3}$/.test(panelValue);
    const openJodiComplete = /^\d{1,2}$/.test(jodiValue);
    const closeComplete = /^\d{3}$/.test(closeValue);

    const openComplete = openPanelComplete && openJodiComplete;

    return {
      market: MARKET_NAME,
      source: "madhurbazar",
      rawResult,

      openPanel: openPanelComplete ? panelValue : null,
      openJodi: openJodiComplete ? jodiValue : null,
      closePanel: closeComplete ? closeValue : null,

      openComplete,
      closeComplete,

      status: !openComplete
        ? "pending"
        : closeComplete
          ? "complete_candidate"
          : "open_candidate",

      fetchedAt,
    };
  } catch (error) {
    return {
      market: MARKET_NAME,
      source: "madhurbazar",
      status: "error",
      error: error.message,
      fetchedAt,
    };
  }
}

scrapeTimeBazar()
  .then((result) => {
    console.log(JSON.stringify(result, null, 2));
  })
  .catch((error) => {
    console.error("Unexpected scraper error:", error.message);
    process.exitCode = 1;
  });
