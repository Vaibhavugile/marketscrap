
const express = require("express");
const { MARKETS } = require("./src/markets");
const { scrapeMarketFromAllSources } = require("./src/scraper");

const app = express();
const PORT = 3001;

app.use(express.json());

// Check that the API is running
app.get("/api/health", (req, res) => {
  res.json({ success: true, message: "API is running" });
});

// Load market options from markets.js
app.get("/api/markets", (req, res) => {
  res.json({ success: true, markets: MARKETS });
});

// Fetch the selected market from all three websites
app.get("/api/results", async (req, res) => {
  try {
    const { marketId } = req.query;
    const checking = String(req.query.checking || "open").toLowerCase();

    if (!["open", "close"].includes(checking)) {
      return res.status(400).json({
        success: false,
        message: "Choose open or close",
      });
    }

    const market = MARKETS.find((item) => item.id === marketId);

    if (!market) {
      return res.status(404).json({
        success: false,
        message: "Market not found",
      });
    }

    console.log(`Fetching ${market.name} — ${checking.toUpperCase()}`);

    const report = await scrapeMarketFromAllSources({
      ...market,
      checking,
    });

    res.json({
      success: true,
      market: report.market,
      marketId: report.marketId,
      checking: report.checking,
      checkedAt: report.checkedAt,
      sources: report.sources,
      confirmation: report.confirmation || null,
    });
  } catch (error) {
    console.error("Scraping error:", error.message);

    res.status(500).json({
      success: false,
      message: "Could not fetch results",
      error: error.message,
    });
  }
});

app.listen(PORT, () => {
  console.log(`API running at http://localhost:${PORT}`);
  console.log(`Markets configured: ${MARKETS.length}`);
});

