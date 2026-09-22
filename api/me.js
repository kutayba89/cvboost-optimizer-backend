// api/me.js
// GET /api/me
// Returns the logged-in user's trial/paid status from the database.

import pool from "../db/client.js";
import { requireAuth } from "../middleware/auth.js";

const FREE_TRIES = 3;

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET")     return res.status(405).json({ error: "Method not allowed" });

  try {
    // ── Verify JWT ────────────────────────────────────────────────────────────
    let userPayload;
    try {
      userPayload = requireAuth(req);
    } catch (authErr) {
      return res.status(authErr.status).json({ error: authErr.error, code: authErr.code });
    }

    // ── Fetch fresh profile from DB ───────────────────────────────────────────
    const result = await pool.query(
      "SELECT email, uses_count, is_paid FROM users WHERE id = $1",
      [userPayload.id]
    );

    const user = result.rows[0];
    if (!user) {
      return res.status(404).json({ error: "Account not found." });
    }

    const triesLeft = user.is_paid ? null : Math.max(0, FREE_TRIES - user.uses_count);

    return res.status(200).json({
      email:      user.email,
      usesCount:  user.uses_count,
      isPaid:     user.is_paid,
      triesLeft,
    });

  } catch (err) {
    console.error("/api/me error:", err);
    return res.status(500).json({ error: "Server error." });
  }
}