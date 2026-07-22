/**
 * Ledger — market data proxy
 * -----------------------------------------------------------
 * Why this exists: the browser can never hold your Finnhub API
 * key directly (anyone can view-source it), and Finnhub's free
 * tier is capped at 60 requests/minute — shared across ALL your
 * visitors, not per-visitor. So this server:
 *   1. Holds the key in an environment variable.
 *   2. Polls Finnhub on ONE shared timer (not once per visitor).
 *   3. Caches the results in memory.
 *   4. Serves your frontend from its own cache, instantly,
 *      no matter how many people are looking at the site.
 *   5. Rate-limits the PUBLIC endpoints so nobody can abuse them.
 *
 * Run:
 *   cd server
 *   npm install
 *   cp .env.example .env      # then paste your real Finnhub key in .env
 *   npm start
 *
 * Frontend then calls:
 *   GET  http://localhost:4000/api/quotes            -> all tracked tickers
 *   GET  http://localhost:4000/api/history/:ticker    -> daily candles
 */

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const session = require("express-session");
const rateLimit = require("express-rate-limit");
const attachAuth = require("./auth");
const pool = require("./db");
const PORT = process.env.PORT || 4000;
const FINNHUB_KEY = process.env.FINNHUB_API_KEY;
const TWELVEDATA_KEY = process.env.TWELVEDATA_API_KEY;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "http://localhost:8080";
const SESSION_SECRET = process.env.SESSION_SECRET || "change-this-to-something-random";
const POLL_MS = 60 * 1000;

if (!FINNHUB_KEY) {
  console.error("Missing FINNHUB_API_KEY — copy .env.example to .env and add your key.");
  process.exit(1);
}
if (!TWELVEDATA_KEY) {
  console.warn("No TWELVEDATA_API_KEY set — the 'Daily' calendar view won't have data until you add one.");
}

// Same 24 tickers as the frontend's mock universe — keep these in sync,
// or better, load this list from one shared JSON file both sides read.
const TICKERS = [
  "AAPL","MSFT","CRM","NVDA","PLTR","AI","LMT","BA","RTX","DE","ADM","CTVA",
  "TSLA","TM","F","XOM","NEE","CVX","JNJ","LLY","UNH","JPM","GS","V",
  "MCD","HD","SPY","QQQ","DIA","VTI"
];
const app = express();
app.set("trust proxy", 1); // needed for accurate rate-limiting once deployed behind a host's proxy (Render/Railway/etc.)
app.use(helmet());
app.use(cors({ origin: ALLOWED_ORIGIN, credentials: true }));
app.use(express.json());
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: false, // set to true once you're serving over HTTPS in production
      maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
    }
  })
);

attachAuth(app); // adds /api/signup, /api/login, /api/logout, /api/me


// --- Public rate limiting (protects YOUR server, separate from Finnhub's own limit) ---
const publicLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 600, // generous — visitors hit your cache, not Finnhub, so this can be looser
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests — please slow down." }
});
app.use("/api/", publicLimiter);

// --- Cache: quotes stay in memory (refreshed every minute anyway), but
// daily history is ALSO saved to Supabase — so when Render's free tier
// restarts/wakes from sleep, we can reload yesterday's already-fetched
// history instantly instead of waiting ~5 minutes to re-fetch everything.
const cache = { quotes: {}, history: {}, historyFetchedAt: {}, lastUpdated: null };

async function fetchQuote(ticker) {
  const url = `https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${FINNHUB_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Finnhub quote ${ticker} -> ${res.status}`);
  return res.json(); // { c: current, h: high, l: low, o: open, pc: prevClose, t: timestamp }
}

// Stooq's CSV download now requires a CAPTCHA-derived token, so it can't be
// scripted — daily history comes from Twelve Data instead (free key required,
// 800 calls/day and 8 calls/minute on the free tier: https://twelvedata.com).
async function fetchDailyCandles(ticker) {
  if (!TWELVEDATA_KEY) throw new Error("no TWELVEDATA_API_KEY configured");
  const url = `https://api.twelvedata.com/time_series?symbol=${ticker}&interval=1day&outputsize=365&apikey=${TWELVEDATA_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Twelve Data candle ${ticker} -> ${res.status}`);
  const data = await res.json();
  if (data.status === "error" || !Array.isArray(data.values)) {
    throw new Error(`Twelve Data candle ${ticker} -> ${data.message || "unexpected response"}`);
  }
  // Twelve Data returns newest-first; flip to oldest-first to match chart order
  const values = [...data.values].reverse();
  const closes = values.map((v) => Number(v.close));
  const timestamps = values.map((v) => Math.floor(new Date(v.datetime).getTime() / 1000));
  return { s: "ok", c: closes, t: timestamps };
}

async function loadHistoryFromDB() {
  try {
    const result = await pool.query("select ticker, data, fetched_at from daily_history");
    for (const row of result.rows) {
      cache.history[row.ticker] = row.data;
      cache.historyFetchedAt[row.ticker] = new Date(row.fetched_at).getTime();
    }
    console.log(`Loaded cached daily history for ${result.rows.length} ticker(s) from Supabase.`);
  } catch (err) {
    console.error("Could not load history cache from database:", err.message);
  }
}

async function saveHistoryToDB(ticker, data) {
  try {
    await pool.query(
      `insert into daily_history (ticker, data, fetched_at) values ($1, $2, now())
       on conflict (ticker) do update set data = excluded.data, fetched_at = excluded.fetched_at`,
      [ticker, JSON.stringify(data)]
    );
  } catch (err) {
    console.error(`Could not save history cache for ${ticker}:`, err.message);
  }
}

async function refreshQuotes() {
  for (const ticker of TICKERS) {
    try {
      const q = await fetchQuote(ticker);
      cache.quotes[ticker] = q;
    } catch (err) {
      console.error(`[quote] ${ticker}:`, err.message, err.cause ? `| cause: ${err.cause}` : "");
      // keep the last good value in cache rather than wiping it out
    }
    // small stagger so we don't fire 24 requests in the same instant
    await new Promise((r) => setTimeout(r, 250));
  }
  cache.lastUpdated = new Date().toISOString();
}

async function refreshHistoryOnce() {
  if (!TWELVEDATA_KEY) return; // skip quietly — /api/history will report "pending" until a key is added
  const HOURS_24 = 24 * 60 * 60 * 1000;
  for (const ticker of TICKERS) {
    const fetchedAt = cache.historyFetchedAt[ticker];
    if (fetchedAt && Date.now() - fetchedAt < HOURS_24) {
      continue; // already fetched within the last day (possibly from Supabase on startup) — skip
    }
    try {
      const data = await fetchDailyCandles(ticker);
      cache.history[ticker] = data;
      cache.historyFetchedAt[ticker] = Date.now();
      await saveHistoryToDB(ticker, data);
    } catch (err) {
      console.error(`[history] ${ticker}:`, err.message, err.cause ? `| cause: ${err.cause}` : "");
    }
    // 8-second gap between calls keeps us under Twelve Data's free-tier
    // limit of 8 calls/minute — only actually reached for tickers that
    // aren't already fresh in the cache above.
    await new Promise((r) => setTimeout(r, 8000));
  }
}

// Load whatever's already cached in Supabase FIRST (fast, one query) so a
// Render restart can serve real data immediately, then top up quotes, then
// only fetch whichever tickers' history is actually missing or stale.
(async () => {
  await loadHistoryFromDB();
  await refreshQuotes();
  await refreshHistoryOnce();
})();
setInterval(refreshQuotes, POLL_MS);
setInterval(refreshHistoryOnce, 4 * 60 * 60 * 1000); // every 4 hours (skips anything still fresh)

// --- Public endpoints your frontend actually calls ---
app.get("/api/quotes", (req, res) => {
  res.json({ lastUpdated: cache.lastUpdated, quotes: cache.quotes });
});

app.get("/api/history/:ticker", (req, res) => {
  const ticker = req.params.ticker.toUpperCase();
  if (!TICKERS.includes(ticker)) return res.status(404).json({ error: "Unknown ticker" });
  res.json(cache.history[ticker] || { s: "pending" });
});

app.get("/api/health", (req, res) => res.json({ ok: true, lastUpdated: cache.lastUpdated }));

app.listen(PORT, () => console.log(`Ledger market-data server listening on :${PORT}`));
