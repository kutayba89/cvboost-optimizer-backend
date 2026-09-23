// api/auth/register.js
// POST /api/auth/register  →  { email, password }

import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import nodemailer from "nodemailer";
import { pool } from "../../db/client.js";
import { getBaseUrl } from "../../lib/base-url.js";

const BCRYPT_ROUNDS = 12;
const TOKEN_TTL_HOURS = 24;

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

async function sendVerificationEmail(email, token, baseUrl) {
  const verifyUrl = `${baseUrl}/api/auth/verify-email?token=${token}`;

  const transporter = createTransporter();
  await transporter.sendMail({
    from: `"CVBoost" <${process.env.SMTP_FROM || process.env.SMTP_USER}>`,
    to: email,
    subject: "Verify your CVBoost account",
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:auto">
        <h2>Welcome to CVBoost! 🚀</h2>
        <p>Click the button below to verify your email address.</p>
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
          If you didn't create an account, you can safely ignore this email.
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
    // ── Parse body ────────────────────────────────────────────────────────────
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch { body = {}; }
    }

    const email    = (body?.email    || "").trim().toLowerCase();
    const password = (body?.password || "").trim();

    // ── Validate input ────────────────────────────────────────────────────────
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: "Please provide a valid email address." });
    }
    if (!password || password.length < 8) {
      return res.status(400).json({ error: "Password must be at least 8 characters." });
    }

    // ── Check for duplicate email ─────────────────────────────────────────────
    const existing = await pool.query(
      "SELECT id FROM users WHERE email = $1",
      [email]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: "An account with this email already exists." });
    }

    // ── Hash password ─────────────────────────────────────────────────────────
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    // ── Generate verification token ───────────────────────────────────────────
    const verifyToken   = crypto.randomBytes(32).toString("hex");
    const verifyTokenExp = new Date(Date.now() + TOKEN_TTL_HOURS * 60 * 60 * 1000);

    // ── Insert user into database ─────────────────────────────────────────────
    await pool.query(
      `INSERT INTO users (email, password_hash, verify_token, verify_token_exp)
       VALUES ($1, $2, $3, $4)`,
      [email, passwordHash, verifyToken, verifyTokenExp]
    );

        // ── Send verification email ───────────────────────────────────────────────
    // Build the link from the host the user actually registered on, so it can
    // never point at a stale deployment URL.
    await sendVerificationEmail(email, verifyToken, getBaseUrl(req));

    return res.status(201).json({
      message: "Account created! Please check your email to verify your account.",
    });

  } catch (err) {
    console.error("/api/auth/register error:", err);
    return res.status(500).json({ error: "Registration failed. Please try again." });
  }
}