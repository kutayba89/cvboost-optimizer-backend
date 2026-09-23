// api/auth/forgot-password.js
// POST /api/auth/forgot-password  →  { email }
//
// Emails a single-use password-reset link.
//
// Security notes:
//  - Always returns the same generic message, so the endpoint cannot be used to
//    discover which email addresses have accounts (user enumeration).
//  - Only a SHA-256 HASH of the token is stored. If the database is ever read by
//    an attacker, the stored value cannot be used to reset anyone's password.
//  - Short TTL (1 hour) and a per-address cooldown to limit abuse.

import crypto from "node:crypto";
import nodemailer from "nodemailer";
import { pool } from "../../db/client.js";
import { getBaseUrl } from "../../lib/base-url.js";

const TOKEN_TTL_MINUTES      = 60;
const RESEND_COOLDOWN_SECONDS = 60;

const GENERIC_REPLY =
  "If an account exists for that address, we've sent a password reset link. Please check your inbox and spam folder.";

export function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function createTransporter() {
  return nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   Number(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === "true",
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

async function sendResetEmail(email, token, baseUrl) {
  const resetUrl = `${baseUrl}/reset-password.html?token=${token}`;

  const transporter = createTransporter();
  await transporter.sendMail({
    from: `"CVBoost" <${process.env.SMTP_FROM || process.env.SMTP_USER}>`,
    to: email,
    subject: "Reset your CVBoost password",
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:auto">
        <h2>Reset your password</h2>
        <p>We received a request to reset the password for your CVBoost account.</p>
        <p>This link can be used once and expires in <strong>${TOKEN_TTL_MINUTES} minutes</strong>.</p>
        <a href="${resetUrl}"
           style="display:inline-block;padding:12px 24px;background:#4f46e5;
                  color:#fff;border-radius:6px;text-decoration:none;font-weight:bold">
          Set a new password
        </a>
        <p style="margin-top:20px;color:#666;font-size:12px">
          Or copy this link into your browser:<br>
          <a href="${resetUrl}" style="color:#4f46e5;word-break:break-all">${resetUrl}</a>
        </p>
        <p style="margin-top:24px;color:#888;font-size:12px">
          If you didn't request this, you can safely ignore this email &mdash;
          your password will stay unchanged.
        </p>
      </div>
    `,
  });
}

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

    const email = (body?.email || "").trim().toLowerCase();

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: "Please provide a valid email address." });
    }

    const result = await pool.query(
      "SELECT id, reset_token_exp FROM users WHERE email = $1",
      [email]
    );
    const user = result.rows[0];

    // Unknown address → identical reply, no hint that the account is missing.
    if (!user) {
      return res.status(200).json({ message: GENERIC_REPLY });
    }

    // Cooldown: derive when the previous token was issued from its expiry.
    if (user.reset_token_exp) {
      const issuedAt   = new Date(user.reset_token_exp).getTime() - TOKEN_TTL_MINUTES * 60_000;
      const ageSeconds = (Date.now() - issuedAt) / 1000;
      if (ageSeconds >= 0 && ageSeconds < RESEND_COOLDOWN_SECONDS) {
        return res.status(429).json({
          error: "Please wait a moment before requesting another reset email.",
          code:  "RATE_LIMITED",
        });
      }
    }

    // Raw token goes in the email; only its hash is stored.
    const rawToken = crypto.randomBytes(32).toString("hex");
    const expires  = new Date(Date.now() + TOKEN_TTL_MINUTES * 60_000);

    await pool.query(
      "UPDATE users SET reset_token = $1, reset_token_exp = $2 WHERE id = $3",
      [hashToken(rawToken), expires, user.id]
    );

    await sendResetEmail(email, rawToken, getBaseUrl(req));

    return res.status(200).json({ message: GENERIC_REPLY });

  } catch (err) {
    console.error("/api/auth/forgot-password error:", err);
    return res.status(500).json({ error: "Could not send the email. Please try again." });
  }
}
