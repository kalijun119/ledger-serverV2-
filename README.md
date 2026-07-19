# Wiring up real market data

This turns the simulated random-walk demo into a site backed by real Finnhub quotes. Three steps: run the proxy server, point the frontend at it, serve the frontend over HTTP (not `file://`).

## 1. Run the proxy server

```bash
cd server
npm install
cp .env.example .env
# open .env and paste your real Finnhub API key (get one free at https://finnhub.io)
npm start
```

You should see `Ledger market-data server listening on :4000`. Visit `http://localhost:4000/api/quotes` in a browser — you should get back real JSON prices within a few seconds.

## 2. Serve the frontend over HTTP, not by double-clicking the file

Browsers block `fetch()` calls from `file://` pages in a lot of cases, and CORS won't behave correctly either. From the project root:

```bash
npx serve .          # or: python3 -m http.server 8080
```

Then open `http://localhost:8080` (matching whatever `ALLOWED_ORIGIN` you set in `server/.env`).

## 3. Turn on live mode on each page

Every HTML page currently loads the simulation like this, near the bottom:

```html
<script src="js/main.js"></script>
```

Add live-data.js right after it:

```html
<script src="js/main.js"></script>
<script src="js/live-data.js"></script>
```

Do this on `index.html`, `analysis.html`, `leaderboard.html`, and `signals.html`. As soon as `live-data.js` loads, it sets `window.LEDGER_LIVE_MODE = true`, which tells the simulation in `main.js` to stop generating random prices, and starts pulling real quotes from your proxy every 15 seconds — feeding them into the exact same `LedgerStocks` array and `ledger:tick` event every page already uses, so the charts, ticker tape, leaderboard, and signal cards all keep working unmodified.

**Before deploying:** open `js/live-data.js` and change `API_BASE` from `http://localhost:4000` to your deployed backend's real URL.

## 4. (Optional) Real daily history instead of the seeded random walk

`analysis.html`'s chart currently uses the seeded random-walk history for the price line. To use real daily candles instead, call `window.LedgerFetchRealHistory(ticker)` (defined in `live-data.js`) when a ticker is selected, and use the returned array of closes in place of `s.history`. This is intentionally left as a manual step rather than auto-wired, since you may want to keep the simulated intraday chart and only use real data for the headline quote — that's a product decision, not a technical one.

## 5. Deploying the backend

Render, Railway, and Fly.io all have free/cheap tiers that work well for a small Express app like this:
- Push `server/` to its own repo (or a subfolder deploy).
- Set the `FINNHUB_API_KEY` and `ALLOWED_ORIGIN` environment variables in the host's dashboard — never commit `.env`.
- Point `js/live-data.js`'s `API_BASE` at the deployed URL.
- Confirm HTTPS is on (these hosts provide it by default) — mixed HTTP/HTTPS content will be blocked by the browser.

## Notes on accuracy

Finnhub's free tier quote is effectively real-time for most U.S. large-caps but has been reported to run with a delay of up to ~20 minutes despite being marketed as real-time — fine for an educational dashboard, not something to represent to users as tick-by-tick live pricing. If you need genuinely real-time data, that's a paid tier on Finnhub or a move to a provider like Polygon.io's real-time plans.
