import type { Config, Context } from "@netlify/functions"
import { createHash } from "node:crypto"
import { accessCodes, journalSignups, newAccessCode, sendEmail, escapeHtml } from "../shared/shop.mts"

// Optional sign-up at the end of Chapter 1 in the secure reader.
// POST /api/journal/signup  { name, email, consent: true, src }
// Gives the reader their own JOURNAL- access code (opens /journal/), emails it,
// and keeps the sign-up so Reshma can see it on the admin page.
const ORIGINS = new Set([
  "https://lighthouse-secure-reader.netlify.app",
  "https://reshma.co.za",
  "https://www.reshma.co.za",
])

const JOURNAL_URL = "https://reshma.co.za/journal/"

function cors(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") ?? ""
  return ORIGINS.has(origin)
    ? { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", Vary: "Origin" }
    : {}
}

const reply = (req: Request, data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...cors(req) },
  })

export interface JournalSignup {
  name: string
  email: string
  code: string
  src: string
  consent: true
  createdAt: string
}

export default async (req: Request, context: Context) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req) })
  if (req.method !== "POST") return reply(req, { error: "Method not allowed" }, 405)

  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>
  const name = String(b.name ?? "").trim().replace(/\s+/g, " ")
  const email = String(b.email ?? "").trim().toLowerCase()
  const src = String(b.src ?? "").toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 24)

  if (!name || name.length > 80) return reply(req, { error: "Please enter your name." }, 400)
  if (email.length > 160 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return reply(req, { error: "Please check your email address." }, 400)
  if (b.consent !== true) return reply(req, { error: "Please tick the box so I may email you the journal." }, 400)

  const store = journalSignups()
  const key = "e/" + createHash("sha256").update(email).digest("hex").slice(0, 32)
  const existing = (await store.get(key, { type: "json" })) as JournalSignup | null
  if (existing) return reply(req, { ok: true, code: existing.code, url: `${JOURNAL_URL}?code=${encodeURIComponent(existing.code)}`, again: true })

  const code = newAccessCode("JOURNAL")
  const createdAt = new Date().toISOString()
  await accessCodes().setJSON(code, { type: "journal", name, email, source: "reader-chapter1", createdAt })
  const signup: JournalSignup = { name, email, code, src, consent: true, createdAt }
  await store.setJSON(key, signup)

  const url = `${JOURNAL_URL}?code=${encodeURIComponent(code)}`
  const first = escapeHtml(name.split(" ")[0])
  const html = `<div style="font-family:Georgia,serif;font-size:16px;line-height:1.6;color:#14233a;max-width:560px">
<p>Dear ${first},</p>
<p>Thank you for reading the first chapter of <em>The Lighthouse in Me</em>. Here is your free 7-Day Journal, <em>Seven Days to Reclaim Your Worth</em>.</p>
<p><a href="${url}" style="display:inline-block;background:#f2c46d;color:#14233a;padding:12px 20px;border-radius:10px;text-decoration:none;font-weight:bold">Open my 7-Day Journal</a></p>
<p>Your access code is <strong>${escapeHtml(code)}</strong>. Keep this email so you can come back to your journal at any time.</p>
<p>With light,<br>Reshma Subramoney</p>
<p style="font-size:13px;color:#526175">You're receiving this because you asked for the free journal in the online reader. To stop receiving emails, email lighthouseinme@gmail.com with the word "unsubscribe".</p>
</div>`
  const emailed = await sendEmail(email, "Your free 7-Day Journal from The Lighthouse in Me", html).catch(() => false)

  return reply(req, { ok: true, code, url, emailed })
}

export const config: Config = {
  path: "/api/journal/signup",
  rateLimit: { windowLimit: 10, windowSize: 60, aggregateBy: ["ip", "domain"] },
}
