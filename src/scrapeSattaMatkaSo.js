
const axios = require("axios");
const cheerio = require("cheerio");

const URL = "https://sattamatka.so/";
const MARKET_NAME = "TIME BAZAR";
const SOURCE = "sattamatkaso";

async function scrapeSattaMatkaSo(marketName = MARKET_NAME) {
  const fetchedAt = new Date().toISOString();

  const emptyResult = {
    market: marketName,
    source: SOURCE,
    rawResult: null,
    openPanel: null,
    openJodi: null,
    closePanel: null,
    openComplete: false,
    closeComplete: false,
    status: "not_found",
    error: null,
    fetchedAt,
  };

  try {
    const response = await axios.get(URL, {
      timeout: 15000,
      headers: {
        "User-Agent": "Mozilla/5.0",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });

    const $ = cheerio.load(response.data);

    $("script, style, noscript").remove();

    const pageText = $("body")
      .text()
      .replace(/\s+/g, " ")
      .trim();

    // Escape special characters in the market name.
    const escapeRegex = (value) =>
      value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    // Expected format: TIME BAZAR177-57-179
    const marketRegex = new RegExp(
      escapeRegex(marketName.trim()) +
        "\\s*(\\d{3})\\s*-\\s*(\\d{1,2})\\s*-\\s*(\\d{3})",
      "i"
    );

    const match = pageText.match(marketRegex);

    if (!match) {
      return {
        ...emptyResult,
        status: "not_found",
      };
    }

    const [, openPanel, openJodi, closePanel] = match;

    return {
      market: marketName,
      source: SOURCE,
      rawResult: `${openPanel}-${openJodi}-${closePanel}`,
      openPanel,
      openJodi,
      closePanel,
      openComplete: true,
      closeComplete: true,
      status: "complete_candidate",
      error: null,
      fetchedAt,
    };
  } catch (error) {
    console.error("Scraper request failed:", {
      status: error.response?.status,
      headers: error.response?.headers,
      body:
        typeof error.response?.data === "string"
          ? error.response.data.slice(0, 1500)
          : undefined,
      message: error.message,
    });

    return {
      ...emptyResult,
      status: "error",
      error: error.response
        ? `HTTP ${error.response.status}`
        : error.message,
    };
  }
}

if (require.main === module) {
  scrapeSattaMatkaSo()
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
    })
    .catch((error) => {
      console.error("Unexpected error:", error.message);
      process.exitCode = 1;
    });
}

module.exports = { scrapeSattaMatkaSo };
