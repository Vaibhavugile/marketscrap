
const axios = require("axios");
const cheerio = require("cheerio");

const URL = "https://mydpboss.in/";
const MARKET_NAME = "TIME BAZAR";

async function scrapeMyDPBoss(marketName = MARKET_NAME) {
  const fetchedAt = new Date().toISOString();
  const source = "mydpboss";

  try {
    const response = await axios.get(URL, {
      timeout: 15000,
      headers: {
        "User-Agent": "Mozilla/5.0",
        Accept: "text/html,application/xhtml+xml",
      },
    });

    const $ = cheerio.load(response.data);

    // Get page text without scripts or styles.
    $("script, style, noscript").remove();

    const pageText = $("body")
      .text()
      .replace(/\s+/g, " ")
      .trim();

    const escapeRegex = (value) =>
      value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    // Match the requested market followed by its result.
    // Example: TIME BAZAR177-57-179(01:00 PM 02:00 PM)
    const marketRegex = new RegExp(
      escapeRegex(marketName.trim()) +
        "\\s*(\\d{3})\\s*-\\s*(\\d{1,2})\\s*-\\s*(\\d{3})",
      "i"
    );

    const match = pageText.match(marketRegex);

    if (!match) {
      return {
        market: marketName,
        source,
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
    }

    const [, openPanel, openJodi, closePanel] = match;

    return {
      market: marketName,
      source,
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
    return {
      market: marketName,
      source,
      rawResult: null,
      openPanel: null,
      openJodi: null,
      closePanel: null,
      openComplete: false,
      closeComplete: false,
      status: "error",
      error: error.response
        ? `HTTP ${error.response.status}`
        : error.message,
      fetchedAt,
    };
  }
}

if (require.main === module) {
  scrapeMyDPBoss()
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error("Unexpected error:", error.message);
      process.exitCode = 1;
    });
}

module.exports = { scrapeMyDPBoss };
