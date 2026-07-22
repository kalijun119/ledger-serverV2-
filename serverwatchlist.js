/**
 * Ledger — watchlist module
 * -----------------------------------------------------------
 * Lets a logged-in user save/remove tickers they want to follow,
 * stored in Supabase (survives Render restarts, same as accounts).
 */

const rateLimit = require("express-rate-limit");
const pool = require("./db");

module.exports = function attachWatchlist(app) {
  const limiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests — please slow down." }
  });

  function requireLogin(req, res, next) {
    if (!req.session.userEmail) return res.status(401).json({ error: "Not logged in." });
    next();
  }

  app.get("/api/watchlist", limiter, requireLogin, async (req, res) => {
    const result = await pool.query(
      "select ticker from watchlist where user_email = $1 order by added_at asc",
      [req.session.userEmail]
    );
    res.json({ tickers: result.rows.map((r) => r.ticker) });
  });

  app.post("/api/watchlist", limiter, requireLogin, async (req, res) => {
    const ticker = (req.body?.ticker || "").trim().toUpperCase();
    if (!ticker) return res.status(400).json({ error: "Missing ticker." });
    await pool.query(
      "insert into watchlist (user_email, ticker) values ($1, $2) on conflict (user_email, ticker) do nothing",
      [req.session.userEmail, ticker]
    );
    res.json({ ok: true });
  });

  app.delete("/api/watchlist/:ticker", limiter, requireLogin, async (req, res) => {
    const ticker = req.params.ticker.trim().toUpperCase();
    await pool.query("delete from watchlist where user_email = $1 and ticker = $2", [
      req.session.userEmail,
      ticker
    ]);
    res.json({ ok: true });
  });
};