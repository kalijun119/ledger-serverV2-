/**
 * Ledger — accounts module (Postgres version)
 * -----------------------------------------------------------
 * Replaces the old JSON-file version. Accounts now live in a real,
 * persistent Postgres database (see server/db.js and setup.sql),
 * not a file on the web server's own filesystem.
 *
 * Password reset uses a security question instead of email, since
 * that requires no domain purchase or email service to work for
 * real strangers. Trade-off, stated plainly: this is less secure
 * than an emailed reset link — anyone who knows the answer to your
 * question could reset your password. Reasonable for a small
 * personal project, not what a bank or major site would use.
 */

const bcrypt = require("bcryptjs");
const rateLimit = require("express-rate-limit");
const pool = require("./db");

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

function isStrongPassword(pw) {
  return typeof pw === "string" && pw.length >= 8 && /[a-zA-Z]/.test(pw) && /[0-9]/.test(pw);
}

function normalizeAnswer(answer) {
  return (answer || "").trim().toLowerCase();
}

function publicUser(u) {
  return { name: u.name, email: u.email, joined: u.joined_at, securityQuestion: u.security_question };
}

module.exports = function attachAuth(app) {
  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many attempts — please wait a few minutes and try again." }
  });

  app.post("/api/signup", authLimiter, async (req, res) => {
    const { name, email, password, securityQuestion, securityAnswer } = req.body || {};
    if (!name || typeof name !== "string" || name.trim().length < 2) {
      return res.status(400).json({ error: "Enter your full name." });
    }
    if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
      return res.status(400).json({ error: "Enter a valid email address." });
    }
    if (!isStrongPassword(password)) {
      return res.status(400).json({ error: "Password must be at least 8 characters and include a letter and a number." });
    }
    if (!securityQuestion || !securityAnswer || normalizeAnswer(securityAnswer).length < 2) {
      return res.status(400).json({ error: "Choose a security question and provide an answer." });
    }

    const cleanEmail = email.trim().toLowerCase();
    const existing = await pool.query("select id from users where email = $1", [cleanEmail]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: "An account with that email already exists." });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const securityAnswerHash = await bcrypt.hash(normalizeAnswer(securityAnswer), 12);

    const result = await pool.query(
      `insert into users (name, email, password_hash, security_question, security_answer_hash)
       values ($1, $2, $3, $4, $5)
       returning name, email, joined_at, security_question`,
      [name.trim(), cleanEmail, passwordHash, securityQuestion, securityAnswerHash]
    );

    req.session.userEmail = cleanEmail;
    res.json({ ok: true, user: publicUser(result.rows[0]) });
  });

  app.post("/api/login", authLimiter, async (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: "Enter your email and password." });
    const cleanEmail = email.trim().toLowerCase();

    const result = await pool.query("select * from users where email = $1", [cleanEmail]);
    const genericError = { error: "Incorrect email or password." };
    if (result.rows.length === 0) return res.status(401).json(genericError);
    const user = result.rows[0];

    if (user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
      const minutesLeft = Math.ceil((new Date(user.locked_until).getTime() - Date.now()) / 60000);
      return res.status(423).json({ error: `Too many failed attempts on this account. Try again in ${minutesLeft} minute(s).` });
    }

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      const attempts = user.failed_attempts + 1;
      if (attempts >= MAX_FAILED_ATTEMPTS) {
        await pool.query("update users set failed_attempts = 0, locked_until = $1 where id = $2", [
          new Date(Date.now() + LOCKOUT_MS),
          user.id
        ]);
      } else {
        await pool.query("update users set failed_attempts = $1 where id = $2", [attempts, user.id]);
      }
      return res.status(401).json(genericError);
    }

    await pool.query("update users set failed_attempts = 0, locked_until = null where id = $1", [user.id]);
    req.session.userEmail = user.email;
    res.json({ ok: true, user: publicUser(user) });
  });

  app.post("/api/logout", (req, res) => {
    req.session.destroy(() => res.json({ ok: true }));
  });

  app.get("/api/me", async (req, res) => {
    if (!req.session.userEmail) return res.json({ user: null });
    const result = await pool.query("select * from users where email = $1", [req.session.userEmail]);
    res.json({ user: result.rows.length ? publicUser(result.rows[0]) : null });
  });

  function requireLogin(req, res, next) {
    if (!req.session.userEmail) return res.status(401).json({ error: "Not logged in." });
    next();
  }

  app.post("/api/change-password", authLimiter, requireLogin, async (req, res) => {
    const { currentPassword, newPassword } = req.body || {};
    const result = await pool.query("select * from users where email = $1", [req.session.userEmail]);
    if (result.rows.length === 0) return res.status(401).json({ error: "Not logged in." });
    const user = result.rows[0];

    if (!currentPassword) return res.status(400).json({ error: "Enter your current password." });
    const match = await bcrypt.compare(currentPassword, user.password_hash);
    if (!match) return res.status(401).json({ error: "Current password is incorrect." });

    if (!isStrongPassword(newPassword)) {
      return res.status(400).json({ error: "New password must be at least 8 characters and include a letter and a number." });
    }

    const newHash = await bcrypt.hash(newPassword, 12);
    await pool.query("update users set password_hash = $1 where id = $2", [newHash, user.id]);
    res.json({ ok: true });
  });

  app.post("/api/delete-account", authLimiter, requireLogin, async (req, res) => {
    const { password } = req.body || {};
    const result = await pool.query("select * from users where email = $1", [req.session.userEmail]);
    if (result.rows.length === 0) return res.status(401).json({ error: "Not logged in." });
    const user = result.rows[0];

    if (!password) return res.status(400).json({ error: "Enter your password to confirm." });
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(401).json({ error: "Password is incorrect." });

    await pool.query("delete from users where id = $1", [user.id]);
    req.session.destroy(() => res.json({ ok: true }));
  });

  // ---------------- Password reset via security question ----------------

  app.get("/api/security-question", authLimiter, async (req, res) => {
    const email = (req.query.email || "").trim().toLowerCase();
    if (!email) return res.status(400).json({ error: "Enter your email." });
    const result = await pool.query("select security_question from users where email = $1", [email]);
    if (result.rows.length === 0) return res.status(404).json({ error: "No account found with that email." });
    res.json({ question: result.rows[0].security_question });
  });

  app.post("/api/reset-with-answer", authLimiter, async (req, res) => {
    const { email, answer, newPassword } = req.body || {};
    const cleanEmail = (email || "").trim().toLowerCase();
    if (!cleanEmail || !answer) return res.status(400).json({ error: "Enter your email and answer." });

    const result = await pool.query("select * from users where email = $1", [cleanEmail]);
    if (result.rows.length === 0) return res.status(404).json({ error: "No account found with that email." });
    const user = result.rows[0];

    const match = await bcrypt.compare(normalizeAnswer(answer), user.security_answer_hash);
    if (!match) return res.status(401).json({ error: "That answer doesn't match our records." });

    if (!isStrongPassword(newPassword)) {
      return res.status(400).json({ error: "New password must be at least 8 characters and include a letter and a number." });
    }

    const newHash = await bcrypt.hash(newPassword, 12);
    await pool.query(
      "update users set password_hash = $1, failed_attempts = 0, locked_until = null where id = $2",
      [newHash, user.id]
    );
    res.json({ ok: true });
  });
};