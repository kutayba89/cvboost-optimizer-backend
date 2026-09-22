// api/optimize.js
// POST /api/optimize  →  { mode, text, context?, lang? }
// Requires a valid JWT in the Authorization header.

import { GoogleGenerativeAI } from "@google/generative-ai";
import { pool } from "../../db/client.js";
import { requireAuth } from "../middleware/auth.js";

const genAI     = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");
const MODEL     = "gemini-1.5-flash";
const FREE_TRIES = 3;

const MODES = {
  headline: {
    label: "LinkedIn Headline",
    system: `You are an expert LinkedIn strategist and recruiter.
Rewrite the user's LinkedIn headline to be punchy, keyword-rich, and recruiter-friendly.
Rules:
- Max 220 characters per option.
- Lead with the role/value, include 2-4 high-signal keywords.
- Avoid clichés ("results-driven", "hardworking").
Return exactly 3 distinct headline options, each on its own line, numbered 1-3. No preamble.`,
  },
  summary: {
    label: "LinkedIn About / Summary",
    system: `You are an expert LinkedIn profile writer.
Rewrite the user's "About" section into a compelling first-person summary.
Rules:
- 3-4 short paragraphs, ~120-200 words total.
- Open with a strong hook, show impact with metrics where possible, end with a clear call to action.
- Natural keywords, no buzzword stuffing.
Return only the rewritten summary. No preamble.`,
  },
  experience: {
    label: "Experience Bullets",
    system: `You are an expert resume and LinkedIn experience writer.
Rewrite the user's job experience into strong achievement-focused bullet points.
Rules:
- Start each bullet with a powerful action verb.
- Quantify impact with metrics (%, $, time, scale) wherever plausible.
- Use the format: Action + Task + Result.
- 4-6 bullets max.
Return only the bullet points, each starting with "• ". No preamble.`,
  },
  resume: {
    label: "Resume Enhancement",
    system: `You are an expert resume writer and ATS optimization specialist.
Improve the user's resume text: stronger action verbs, measurable metrics, ATS-friendly phrasing.
Rules:
- Preserve the user's real facts; enhance clarity and impact.
- Flag missing metrics with "[add metric]".
- Keep formatting clean and scannable.
Return the improved resume text plus a short "Key improvements" list at the end. No preamble.`,
  },
  cover_letter: {
    label: "Cover Letter",
    system: `You are an expert career coach who writes compelling cover letters.
Write a concise, tailored cover letter based on the user's background and (if provided) the target role/company.
Rules:
- 3-4 paragraphs, ~250-350 words.
- Confident but not arrogant; specific, not generic.
- Clear opening hook and a strong closing call to action.
Return only the cover letter. No preamble.`,
  },
};

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")   return res.status(405).json({ error: "Method not allowed" });

  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({ error: "Server misconfigured: GEMINI_API_KEY is not set." });
  }

  try {
    // ── Verify JWT ────────────────────────────────────────────────────────────
    let userPayload;
    try {
      userPayload = requireAuth(req);
    } catch (authErr) {
      return res.status(authErr.status).json({ error: authErr.error, code: authErr.code });
    }

    // ── Load user profile from DB ─────────────────────────────────────────────
    const result = await pool.query(
      "SELECT uses_count, is_paid FROM users WHERE id = $1",
      [userPayload.id]
    );

    const profile = result.rows[0];
    if (!profile) {
      return res.status(404).json({ error: "Account not found." });
    }

    // ── Trial gate ────────────────────────────────────────────────────────────
    if (!profile.is_paid && profile.uses_count >= FREE_TRIES) {
      return res.status(402).json({
        error:     "You've used all your free optimizations. Upgrade for unlimited access.",
        code:      "LIMIT_REACHED",
        usesCount: profile.uses_count,
        isPaid:    profile.is_paid,
      });
    }

    // ── Parse & validate request body ─────────────────────────────────────────
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch { body = {}; }
    }

    const { mode, text, context, lang } = body || {};
    const language = lang === "de" ? "de" : "en";
    const languageInstruction = language === "de"
      ? "\n\nWICHTIG: Antworte ausschließlich auf Deutsch."
      : "\n\nIMPORTANT: Respond only in English.";

    if (!mode || !MODES[mode]) {
      return res.status(400).json({
        error: `Invalid mode. Valid modes: ${Object.keys(MODES).join(", ")}`,
      });
    }
    if (!text || typeof text !== "string" || text.trim().length < 5) {
      return res.status(400).json({ error: "Please provide at least a few words of input text." });
    }
    if (text.length > 8000) {
      return res.status(400).json({ error: "Input too long (max 8000 characters)." });
    }

    // ── Call Gemini ───────────────────────────────────────────────────────────
    const selected    = MODES[mode];
    const userContent = context
      ? `Target role/company or extra context:\n${context}\n\n---\n\nUser input:\n${text}`
      : `User input:\n${text}`;

    const model = genAI.getGenerativeModel({
      model: MODEL,
      systemInstruction: selected.system + languageInstruction,
      generationConfig: { maxOutputTokens: 1500, temperature: 0.7 },
    });

    const aiResult      = await model.generateContent(userContent);
    const responseText  = aiResult.response.text();

    // ── Increment uses_count (only for free users) ────────────────────────────
    let newUsesCount = profile.uses_count;
    if (!profile.is_paid) {
      newUsesCount = profile.uses_count + 1;
      await pool.query(
        "UPDATE users SET uses_count = $1 WHERE id = $2",
        [newUsesCount, userPayload.id]
      );
    }

    const triesLeft = profile.is_paid ? null : Math.max(0, FREE_TRIES - newUsesCount);

    return res.status(200).json({
      mode,
      label:     selected.label,
      result:    responseText,
      usesCount: newUsesCount,
      isPaid:    profile.is_paid,
      triesLeft,
    });

  } catch (err) {
    console.error("/api/optimize error:", err);
    return res.status(500).json({ error: err.message || "Unknown error" });
  }
}