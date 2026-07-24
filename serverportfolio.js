/**
 * Ledger — portfolio module (paper trading)
 * -----------------------------------------------------------
 * Lets a logged-in user "buy" and "sell" tracked stocks using
 * real live prices, with pretend money — zero real financial
 * risk, but real market movement. Starting cash: $100,000.
 *
 * Needs read access to the live price cache from server.js, so
 * it's attached as attachPortfolio(app, cache) instead of just
 * attachPortfolio(app) — cache.quotes[ticker].c is the current price.
 */

const rateLimit = require("express-rate-limit");
const pool = require("./db");

const STARTING_CASH = 100000;

module.exports = function attachPortfolio(app, cache) {
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

  async function getOrCreateCash(userEmail) {
    const existing = await pool.query("select cash from portfolio_cash where user_email = $1", [userEmail]);
    if (existing.rows.length > 0) return Number(existing.rows[0].cash);
    await pool.query("insert into portfolio_cash (user_email, cash) values ($1, $2)", [userEmail, STARTING_CASH]);
    return STARTING_CASH;
  }

  app.get("/api/portfolio", limiter, requireLogin, async (req, res) => {
    const cash = await getOrCreateCash(req.session.userEmail);
    const holdingsResult = await pool.query(
      "select ticker, shares, avg_cost from holdings where user_email = $1 order by ticker asc",
      [req.session.userEmail]
    );
    const holdings = holdingsResult.rows.map((h) => {
      const price = currentPrice(h.ticker);
      const shares = Number(h.shares);
      const avgCost = Number(h.avg_cost);
      return {
        ticker: h.ticker,
        shares,
        avgCost,
        currentPrice: price,
        marketValue: price !== null ? +(price * shares).toFixed(2) : null,
        gainLoss: price !== null ? +((price - avgCost) * shares).toFixed(2) : null
      };
    });
    res.json({ cash, holdings });
  });

  app.post("/api/portfolio/buy", limiter, requireLogin, async (req, res) => {
    const ticker = (req.body?.ticker || "").trim().toUpperCase();
    const shares = Number(req.body?.shares);
    if (!ticker || !Number.isFinite(shares) || shares <= 0) {
      return res.status(400).json({ error: "Enter a valid ticker and a positive number of shares." });
    }
    const price = currentPrice(ticker);
    if (price === null) return res.status(400).json({ error: "No current price available for that ticker yet." });

    const cash = await getOrCreateCash(req.session.userEmail);
    const cost = price * shares;
    if (cost > cash) return res.status(400).json({ error: `Not enough cash — this would cost $${cost.toFixed(2)}, you have $${cash.toFixed(2)}.` });

    const existing = await pool.query("select shares, avg_cost from holdings where user_email = $1 and ticker = $2", [
      req.session.userEmail,
      ticker
    ]);

    if (existing.rows.length > 0) {
      const oldShares = Number(existing.rows[0].shares);
      const oldAvgCost = Number(existing.rows[0].avg_cost);
      const newShares = oldShares + shares;
      const newAvgCost = (oldShares * oldAvgCost + shares * price) / newShares;
      await pool.query("update holdings set shares = $1, avg_cost = $2 where user_email = $3 and ticker = $4", [
        newShares,
        newAvgCost,
        req.session.userEmail,
        ticker
      ]);
    } else {
      await pool.query("insert into holdings (user_email, ticker, shares, avg_cost) values ($1, $2, $3, $4)", [
        req.session.userEmail,
        ticker,
        shares,
        price
      ]);
    }

    await pool.query("update portfolio_cash set cash = cash - $1 where user_email = $2", [cost, req.session.userEmail]);
    res.json({ ok: true });
  });

  app.post("/api/portfolio/sell", limiter, requireLogin, async (req, res) => {
    const ticker = (req.body?.ticker || "").trim().toUpperCase();
    const shares = Number(req.body?.shares);
    if (!ticker || !Number.isFinite(shares) || shares <= 0) {
      return res.status(400).json({ error: "Enter a valid ticker and a positive number of shares." });
    }
    const price = currentPrice(ticker);
    if (price === null) return res.status(400).json({ error: "No current price available for that ticker yet." });

    const existing = await pool.query("select shares from holdings where user_email = $1 and ticker = $2", [
      req.session.userEmail,
      ticker
    ]);
    if (existing.rows.length === 0 || Number(existing.rows[0].shares) < shares) {
      return res.status(400).json({ error: "You don't own that many shares to sell." });
    }

    const remaining = Number(existing.rows[0].shares) - shares;
    if (remaining <= 0) {
      await pool.query("delete from holdings where user_email = $1 and ticker = $2", [req.session.userEmail, ticker]);
    } else {
      await pool.query("update holdings set shares = $1 where user_email = $2 and ticker = $3", [
        remaining,
        req.session.userEmail,
        ticker
      ]);
    }

    const proceeds = price * shares;
    await pool.query("update portfolio_cash set cash = cash + $1 where user_email = $2", [proceeds, req.session.userEmail]);
    res.json({ ok: true });
  });
};