// api/auth/resend-verification.js
// POST /api/auth/resend-verification  →  { email }
//
// Issues a fresh verification token and emails a new link.
// Always returns the same generic success message so the endpoint cannot be
// used to discover which email addresses have accounts (user enumeration).

import crypto from "node:crypto";
import nodemailer from "nodemailer";
import { pool } from "../../db/client.js";
import { getBaseUrl } from "../../lib/base-url.js";

const TOKEN_TTL_HOURS = 24;

// Minimum seconds between resend attempts for the same address.
const RESEND_COOLDOWN_SECONDS = 60;

// Generic reply used for every outcome (found, not found, already verified).
const GENERIC_REPLY =
  "If an unverified account exists for that address, we've sent a new verification link. Please check your inbox and spam folder.";

function createTransporter() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === "true",
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

async function sendVerificationEmail(email, token, baseUrl) {
  const verifyUrl = `${baseUrl}/api/auth/verify-email?token=${token}`;

  const transporter = createTransporter();
  await transporter.sendMail({
    from: `"CVBoost" <${process.env.SMTP_FROM || process.env.SMTP_USER}>`,
    to: email,
    subject: "Your new CVBoost verification link",
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:auto">
        <h2>Verify your CVBoost account</h2>
        <p>Here is a fresh verification link, as requested.</p>
        <p>This link expires in <strong>${TOKEN_TTL_HOURS} hours</strong>.</p>
        <a href="${verifyUrl}"
           style="display:inline-block;padding:12px 24px;background:#4f46e5;
                  color:#fff;border-radius:6px;text-decoration:none;font-weight:bold">
          Verify Email
        </a>
        <p style="margin-top:20px;color:#666;font-size:12px">
          Or copy this link into your browser:<br>
          <a href="${verifyUrl}" style="color:#4f46e5;word-break:break-all">${verifyUrl}</a>
        </p>
        <p style="margin-top:24px;color:#888;font-size:12px">
          If you didn't request this, you can safely ignore this email.
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
      `SELECT id, is_verified, verify_token_exp
         FROM users
        WHERE email = $1`,
      [email]
    );
    const user = result.rows[0];

    // Unknown address or already verified → say nothing specific.
    if (!user || user.is_verified) {
      return res.status(200).json({ message: GENERIC_REPLY });
    }

    // Simple cooldown: the existing token's expiry tells us when it was issued.
    if (user.verify_token_exp) {
      const issuedAt = new Date(user.verify_token_exp).getTime() - TOKEN_TTL_HOURS * 3600_000;
      const ageSeconds = (Date.now() - issuedAt) / 1000;
      if (ageSeconds < RESEND_COOLDOWN_SECONDS) {
        return res.status(429).json({
          error: "Please wait a moment before requesting another email.",
          code: "RATE_LIMITED",
        });
      }
    }

    // Issue a brand-new token and invalidate the old one.
    const verifyToken = crypto.randomBytes(32).toString("hex");
    const verifyTokenExp = new Date(Date.now() + TOKEN_TTL_HOURS * 3600_000);

    await pool.query(
      `UPDATE users
          SET verify_token = $1, verify_token_exp = $2
        WHERE id = $3`,
      [verifyToken, verifyTokenExp, user.id]
    );

    // Build the link from the host the request actually arrived on.
    await sendVerificationEmail(email, verifyToken, getBaseUrl(req));

    return res.status(200).json({ message: GENERIC_REPLY });

  } catch (err) {
    console.error("/api/auth/resend-verification error:", err);
    return res.status(500).json({ error: "Could not send the email. Please try again." });
  }
}