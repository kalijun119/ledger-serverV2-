/**
 * Ledger — price alerts module
 * -----------------------------------------------------------
 * "Tell me when TICKER goes above/below $X." No email service —
 * alerts are checked against the live price cache whenever the
 * user's list is fetched (e.g. when they load their Account page),
 * and shown as "triggered" right there.
 */

const rateLimit = require("express-rate-limit");
const pool = require("./db");

module.exports = function attachAlerts(app, cache) {
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

  function currentPrice(ticker) {
    const q = cache.quotes[ticker];
    return q && typeof q.c === "number" ? q.c : null;
  }

  app.get("/api/alerts", limiter, requireLogin, async (req, res) => {
    const result = await pool.query(
      "select id, ticker, direction, target_price, triggered from price_alerts where user_email = $1 order by created_at desc",
      [req.session.userEmail]
    );

    for (const row of result.rows) {
      if (row.triggered) continue;
      const price = currentPrice(row.ticker);
      if (price === null) continue;
      const crossed = row.direction === "above" ? price >= Number(row.target_price) : price <= Number(row.target_price);
      if (crossed) {
        await pool.query("update price_alerts set triggered = true where id = $1", [row.id]);
        row.triggered = true;
      }
    }

    res.json({
      alerts: result.rows.map((r) => ({
        id: r.id,
        ticker: r.ticker,
        direction: r.direction,
        targetPrice: Number(r.target_price),
        triggered: r.triggered
      }))
    });
  });

  app.post("/api/alerts", limiter, requireLogin, async (req, res) => {
    const ticker = (req.body?.ticker || "").trim().toUpperCase();
    const direction = req.body?.direction;
    const targetPrice = Number(req.body?.targetPrice);
    if (!ticker) return res.status(400).json({ error: "Choose a ticker." });
    if (direction !== "above" && direction !== "below") return res.status(400).json({ error: "Choose above or below." });
    if (!Number.isFinite(targetPrice) || targetPrice <= 0) return res.status(400).json({ error: "Enter a valid target price." });

    await pool.query(
      "insert into price_alerts (user_email, ticker, direction, target_price) values ($1, $2, $3, $4)",
      [req.session.userEmail, ticker, direction, targetPrice]
    );
    res.json({ ok: true });
  });

  app.delete("/api/alerts/:id", limiter, requireLogin, async (req, res) => {
    await pool.query("delete from price_alerts where id = $1 and user_email = $2", [req.params.id, req.session.userEmail]);
    res.json({ ok: true });
  });
};
