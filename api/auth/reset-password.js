// api/auth/reset-password.js
// POST /api/auth/reset-password  →  { token, password }
//
// Consumes a reset token and sets a new password.
//
// Security notes:
//  - The token is looked up by its SHA-256 hash; the raw value is never stored.
//  - Single use: the token is cleared in the same UPDATE that sets the password.
//  - Expiry is enforced in SQL (NOW()), so it cannot drift with the app server.
//  - A successful reset also verifies the email, since receiving the link proves
//    ownership of the address.

import bcrypt from "bcryptjs";
import { pool } from "../../db/client.js";
import { hashToken } from "./forgot-password.js";

const BCRYPT_ROUNDS  = 12;
const MIN_PASSWORD_LEN = 8;

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch { body = {}; }
    }

    const token    = (body?.token    || "").trim();
    const password = (body?.password || "").trim();

    if (!token) {
      return res.status(400).json({ error: "Reset token is missing.", code: "TOKEN_INVALID" });
    }
    if (!password || password.length < MIN_PASSWORD_LEN) {
      return res.status(400).json({
        error: `Password must be at least ${MIN_PASSWORD_LEN} characters.`,
      });
    }

    // Match on the hash, and let Postgres decide whether it is still valid.
    const result = await pool.query(
      `SELECT id
         FROM users
        WHERE reset_token = $1
          AND reset_token_exp IS NOT NULL
          AND reset_token_exp > NOW()`,
      [hashToken(token)]
    );
    const user = result.rows[0];

    if (!user) {
      return res.status(400).json({
        error: "This reset link is invalid or has expired. Please request a new one.",
        code:  "TOKEN_INVALID",
      });
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    // Set the password and burn the token in one statement.
    await pool.query(
      `UPDATE users
          SET password_hash    = $1,
              reset_token      = NULL,
              reset_token_exp  = NULL,
              is_verified      = TRUE
        WHERE id = $2`,
      [passwordHash, user.id]
    );

    return res.status(200).json({
      message: "Your password has been updated. You can now log in.",
    });

  } catch (err) {
    console.error("/api/auth/reset-password error:", err);
    return res.status(500).json({ error: "Could not reset your password. Please try again." });
  }
}
