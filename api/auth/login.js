// api/auth/login.js
// POST /api/auth/login  →  { email, password }
// Returns a signed JWT token valid for 7 days.

import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import pool from "../../db/client.js";

const JWT_EXPIRES_IN = "7d";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    // ── Parse body ────────────────────────────────────────────────────────────
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch { body = {}; }
    }

    const email    = (body?.email    || "").trim().toLowerCase();
    const password = (body?.password || "").trim();

    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required." });
    }

    // ── Look up user ──────────────────────────────────────────────────────────
    const result = await pool.query(
      "SELECT id, email, password_hash, is_verified, uses_count, is_paid FROM users WHERE email = $1",
      [email]
    );

    const user = result.rows[0];

    // Use constant-time comparison to prevent timing attacks.
    // Always run bcrypt even if user not found to avoid user enumeration.
    const dummyHash = "$2a$12$invalidhashfortimingattackprevention000000000000000000";
    const passwordMatch = await bcrypt.compare(password, user?.password_hash || dummyHash);

    if (!user || !passwordMatch) {
      return res.status(401).json({ error: "Invalid email or password." });
    }

    // ── Check email is verified ───────────────────────────────────────────────
    if (!user.is_verified) {
      return res.status(403).json({
        error: "Please verify your email before logging in.",
        code: "EMAIL_NOT_VERIFIED",
      });
    }

    // ── Sign JWT ──────────────────────────────────────────────────────────────
    const token = jwt.sign(
      { id: user.id, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );

    const FREE_TRIES = 3;
    const triesLeft = user.is_paid ? null : Math.max(0, FREE_TRIES - user.uses_count);

    return res.status(200).json({
      token,
      email: user.email,
      usesCount: user.uses_count,
      isPaid: user.is_paid,
      triesLeft,
    });

  } catch (err) {
    console.error("/api/auth/login error:", err);
    return res.status(500).json({ error: "Login failed. Please try again." });
  }
}