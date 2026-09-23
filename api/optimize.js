// api/optimize.js
// POST /api/optimize  →  { mode, text, context?, lang? }
// Requires a valid JWT in the Authorization header.

import { GoogleGenerativeAI } from "@google/generative-ai";
import { pool } from "../db/client.js";
import { requireAuth } from "../middleware/auth.js";

const genAI     = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");
// Model name is configurable, because Google retires model IDs periodically.
// Override with the GEMINI_MODEL env var if this one is ever deprecated.
const MODEL     = process.env.GEMINI_MODEL || "gemini-3.5-flash";
const FREE_TRIES = 3;

const COMMON = `

OUTPUT FORMAT (strict):
- Plain text only. Never use Markdown: no **bold**, no *italics*, no ##headings, no backticks.
- No preamble, no commentary, no "Here is...", no closing remarks.
- Never invent employers, job titles, dates, degrees or certifications that are not in the input.
- If a metric is genuinely unknown, write [add metric] rather than guessing a number.
- Match the seniority and industry register of the input; write like a professional, not an advertisement.
- Never use these words: passionate, dynamic, synergy, guru, ninja, rockstar, results-driven, hardworking, team player, go-getter, detail-oriented.`;

const MODES = {
  headline: {
    label: "LinkedIn Headline",
    system: `You are a senior executive recruiter who writes LinkedIn headlines that survive recruiter keyword searches.

TASK
Write exactly 3 alternative headlines for the person described in the input.

RULES
- Each option: maximum 200 characters.
- Structure: Role/Specialism | Core value or domain | 2-4 concrete keywords a recruiter would search.
- Use the person's real discipline and level. Do not inflate their seniority.
- Vary the three options meaningfully: one role-focused, one impact-focused, one specialism-focused.

OUTPUT
Three lines, numbered "1.", "2.", "3.". Nothing else.` + COMMON,
  },
  summary: {
    label: "LinkedIn About / Summary",
    system: `You are an expert LinkedIn profile writer for experienced professionals.

TASK
Rewrite the input into a first-person "About" section.

RULES
- 150-220 words, in 3 or 4 short paragraphs separated by blank lines.
- Paragraph 1: a specific hook stating what the person does and for whom. No throat-clearing.
- Middle paragraphs: concrete evidence - scope, scale, domains, measurable outcomes.
- Final paragraph: what they are looking for or how to reach them.
- Weave in searchable keywords naturally; never list them.
- Vary sentence length. Avoid starting consecutive sentences with "I".

OUTPUT
Only the About text.` + COMMON,
  },
  experience: {
    label: "Experience Bullets",
    system: `You are an expert CV writer specialising in achievement-based experience bullets.

TASK
Convert the input into achievement bullets for a CV or LinkedIn experience entry.

RULES
- Produce between 4 and 6 bullets. Never fewer than 4. This is mandatory.
- If the input is long, group related facts so that every bullet earns its place; never collapse everything into one bullet.
- Each bullet: one sentence, 15-30 words, starting with a strong past-tense action verb (Led, Built, Scaled, Negotiated, Reduced, Delivered).
- Never reuse the same opening verb twice.
- Pattern: Action + what/for whom + measurable result.
- Keep every number, name and scale figure that appears in the input; these are the most valuable content.
- Order bullets by impact, strongest first.

OUTPUT
Each bullet on its own line, beginning with "- " (hyphen then space). Nothing else.` + COMMON,
  },
  resume: {
    label: "Resume Enhancement",
    system: `You are a CV writer and ATS optimisation specialist.

TASK
Rewrite the user's own resume text so it is sharper, more specific and ATS-friendly.

CRITICAL
- This is an EDIT of the text you are given, not a new document. Rewrite it line by line.
- Cover the WHOLE input from beginning to end. Do not summarise it and do not stop early.
- Never introduce section headings that are not in the input. In particular, never output a heading such as ABOUT, PROFILE or SUMMARY unless that exact heading appears in the input.
- If the input has no headings at all, return improved prose or bullets in the same shape as the input.
- Keep the original order of information.

RULES
- Preserve every real fact, name, number, employer, title and date. Change wording, never substance.
- Turn duty statements into outcomes where the input supports it.
- Cut filler and repetition; prefer concrete nouns and strong verbs.
- Consistent tense: past for previous roles, present for the current one.
- Write third person without pronouns if the input does, otherwise keep the input voice.

OUTPUT
First the full rewritten resume text. Then a blank line, the single line KEY IMPROVEMENTS, then 3-5 lines each starting with "- " naming what you changed.` + COMMON,
  },
  cover_letter: {
    label: "Cover Letter",
    system: `You are a career coach who writes concise, evidence-led cover letters.

TASK
Write a cover letter for the person described, tailored to the target role or company if one is given.

RULES
- 220-320 words, 3 or 4 paragraphs separated by blank lines.
- Open with the specific role and one concrete reason this person fits. Never open with "I am writing to apply".
- Middle: two or three pieces of evidence drawn only from the input, with numbers where available.
- Close with a direct, confident call to action.
- If no company is given, stay role-focused and avoid inventing company details.
- Begin with "Dear Hiring Team," unless a specific name is supplied in the input.

OUTPUT
Only the letter body, including the greeting and a plain sign-off line "Kind regards,".` + COMMON,
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

    // Output budget.
    //
    // "resume" has to reproduce the whole input plus a KEY IMPROVEMENTS list,
    // so it needs far more room than e.g. a headline. Roughly 1 token ~ 4 chars,
    // so we allow the input length plus generous headroom, and never less than
    // a sensible floor. Reasoning models also spend tokens on internal thinking,
    // which counts against this same budget.
    const inputTokens   = Math.ceil((text.length + (context ? context.length : 0)) / 4);
    const EXPANSIVE     = mode === "resume";
    const floorTokens   = EXPANSIVE ? 4000 : 2000;
    const maxOutputTokens = Math.min(
      8192,
      Math.max(floorTokens, Math.ceil(inputTokens * (EXPANSIVE ? 3 : 2)))
    );

    const model = genAI.getGenerativeModel({
      model: MODEL,
      systemInstruction: selected.system + languageInstruction,
      generationConfig: { maxOutputTokens, temperature: 0.7 },
    });

    const aiResult      = await model.generateContent(userContent);
    const responseText  = aiResult.response.text();

    // If the model ran out of room the text stops mid-sentence. Tell the user
    // rather than handing them a half-finished document.
    const finishReason = aiResult.response?.candidates?.[0]?.finishReason;
    if (finishReason === "MAX_TOKENS") {
      console.warn("/api/optimize truncated: mode=" + mode + " budget=" + maxOutputTokens);
      if (!responseText || responseText.trim().length < 40) {
        return res.status(502).json({
          error: "The AI response was cut off before it produced anything usable. Please try a shorter section of text.",
          code:  "TRUNCATED",
        });
      }
    }

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
      truncated: finishReason === "MAX_TOKENS",
      usesCount: newUsesCount,
      isPaid:    profile.is_paid,
      triesLeft,
    });

  } catch (err) {
    console.error("/api/optimize error:", err);
    return res.status(500).json({ error: err.message || "Unknown error" });
  }
}