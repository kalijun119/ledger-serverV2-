/**
 * Ledger — database connection
 * -----------------------------------------------------------
 * Replaces the old server/data/users.json file with a real,
 * persistent Postgres database (hosted free on Supabase). Unlike
 * the web server's own filesystem, this database is NOT wiped
 * when your server restarts, redeploys, or spins down — it's a
 * completely separate, always-persistent service.
 */

const { Pool } = require("pg");

if (!process.env.DATABASE_URL) {
  console.error("Missing DATABASE_URL — copy .env.example to .env and add your Supabase connection string.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // Supabase requires SSL; this keeps local setup simple for a small project
});

module.exports = pool;