// api/auth/verify-email.js
// GET /api/auth/verify-email?token=<token>
// Activates the user's account when they click the link in their email.

import { pool } from "../../db/client.js";
import { getBaseUrl } from "../../lib/base-url.js";

export default async function handler(req, res) {
  // Resolve the real public origin for parsing and redirects.
  const APP_URL = getBaseUrl(req);

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  try {
    // ── Extract token from query string ───────────────────────────────────────
    const url   = new URL(req.url, APP_URL);
    const token = url.searchParams.get("token") || "";

    if (!token) {
      return res.status(400).json({ error: "Verification token is missing." });
    }

    // ── Find user with this token ─────────────────────────────────────────────
    const result = await pool.query(
      `SELECT id, is_verified, verify_token_exp
       FROM users
       WHERE verify_token = $1`,
      [token]
    );

    const user = result.rows[0];

    if (!user) {
      return res.status(400).json({ error: "Invalid or already used verification link." });
    }

    if (user.is_verified) {
      // Already verified — redirect to login
      res.setHeader("Location", `${APP_URL}/login.html?verified=already`);
      return res.status(302).end();
    }

    // ── Check token expiry ────────────────────────────────────────────────────
    if (new Date() > new Date(user.verify_token_exp)) {
      return res.status(400).json({
        error: "Verification link has expired. Please register again.",
        code: "TOKEN_EXPIRED",
      });
    }

    // ── Activate account ──────────────────────────────────────────────────────
    await pool.query(
      `UPDATE users
       SET is_verified = TRUE, verify_token = NULL, verify_token_exp = NULL
       WHERE id = $1`,
      [user.id]
    );

    // ── Redirect to login page with success message ───────────────────────────
    res.setHeader("Location", `${APP_URL}/login.html?verified=true`);
    return res.status(302).end();

  } catch (err) {
    console.error("/api/auth/verify-email error:", err);
    return res.status(500).json({ error: "Verification failed. Please try again." });
  }
}
