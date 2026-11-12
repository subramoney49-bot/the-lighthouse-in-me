import { createHash, randomBytes } from "node:crypto"
import { getStore } from "@netlify/blobs"

// ---------------------------------------------------------------------------
// Products — prices are set here on the server, never trusted from the browser
// ---------------------------------------------------------------------------
export const PRODUCTS = {
  ebook: {
    id: "ebook",
    name: "The Lighthouse in Me - Ebook",
    description: "Online ebook edition with a personal access code",
    amount: "199.00",
    needsDelivery: false,
  },
  paperback: {
    id: "paperback",
    name: "The Lighthouse in Me - Paperback",
    description: "Printed book R310 + R120 PostNet to PostNet delivery, with the free 7-Day Journal App",
    amount: "430.00",
    needsDelivery: true,
  },
  collect: {
    id: "collect",
    name: "The Lighthouse in Me - Paperback (collect in Midrand)",
    description: "Printed book for collection in Midrand (no delivery), with the free 7-Day Journal App",
    amount: "310.00",
    needsDelivery: false,
  },
  ereader: {
    id: "ereader",
    name: "Custom E-Reader for Authors",
    description: "A custom online e-reader for your book, locked with access codes (once-off)",
    amount: "3800.00",
    needsDelivery: false,
  },
  // R5 payment for testing the live checkout. Only accepted when the
  // ALLOW_TEST_PURCHASE setting is "yes" in Netlify.
  test: {
    id: "test",
    name: "The Lighthouse in Me - Website test",
    description: "Test payment to check the website checkout",
    amount: "5.00",
    needsDelivery: false,
  },
} as const

export type ProductId = keyof typeof PRODUCTS

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const env = (k: string) => (Netlify.env.get(k) ?? "").trim()

export function payfastConfig() {
  const live = env("PAYFAST_MODE").toLowerCase() === "live"
  if (live) {
    return {
      live: true,
      host: "www.payfast.co.za",
      merchantId: env("PAYFAST_MERCHANT_ID") || "35468501",
      merchantKey: env("PAYFAST_MERCHANT_KEY") || "ssdtrqqd1hvfk",
      passphrase: env("PAYFAST_PASSPHRASE"),
    }
  }
  // PayFast's public sandbox test merchant
  return {
    live: false,
    host: "sandbox.payfast.co.za",
    merchantId: "10000100",
    merchantKey: "46f0cd694581a",
    // Test payments are signed without a passphrase (the documented test
    // passphrase was rejected by the sandbox). Set PAYFAST_SANDBOX_PASSPHRASE
    // to sign sandbox payments with one.
    passphrase: env("PAYFAST_SANDBOX_PASSPHRASE"),
  }
}

// The new secure reader (per-buyer licence codes + SMS check). The old edition2
// reader has closed, so READER_URL may only override this with the new link.
const NEW_READER = "https://lighthouse-secure-reader.netlify.app/"
export const READER_URL = () => {
  const u = env("READER_URL")
  return u && !u.includes("edition2") ? u : NEW_READER
}

// Normalise a South African cell number to +27XXXXXXXXX
export function intlCell(cell: string): string {
  const d = String(cell || "").replace(/[^\d+]/g, "")
  if (d.startsWith("+")) return d
  if (d.startsWith("27")) return "+" + d
  if (d.startsWith("0")) return "+27" + d.slice(1)
  return d
}

// Ask the secure reader to create (or re-issue) a licence for this buyer.
// Needs READER_ADMIN_KEY in Netlify (the same key as the reader's admin page).
export async function issueReaderLicence(name: string, cell: string): Promise<{ code: string; phone: string } | null> {
  const key = env("READER_ADMIN_KEY")
  if (!key) { console.error("READER_ADMIN_KEY is not set"); return null }
  const api = new URL(".netlify/functions/reader", READER_URL()).toString()
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(api, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({ action: "admin-issue", name, phone: intlCell(cell) }),
      })
      const j = (await res.json().catch(() => ({}))) as { code?: string; phone?: string; error?: string }
      if (res.ok && j.code) return { code: j.code, phone: j.phone || intlCell(cell) }
      console.error("Reader licence failed", res.status, j.error)
      if (res.status < 500) return null
    } catch (e) {
      console.error("Reader licence error", e)
    }
  }
  return null
}

// Optional WhatsApp alert to Reshma through CallMeBot (free personal WhatsApp API).
// Set CALLMEBOT_APIKEY (and optionally WHATSAPP_NOTIFY_PHONE) in Netlify to switch it on.
export async function notifyWhatsApp(text: string): Promise<boolean> {
  const apikey = env("CALLMEBOT_APIKEY")
  if (!apikey) return false
  const phone = (env("WHATSAPP_NOTIFY_PHONE") || "+27742895635").replace(/[^\d]/g, "")
  try {
    const url = `https://api.callmebot.com/whatsapp.php?phone=${phone}&text=${encodeURIComponent(text)}&apikey=${encodeURIComponent(apikey)}`
    const res = await fetch(url)
    if (!res.ok) console.error("WhatsApp alert failed", res.status)
    return res.ok
  } catch (e) {
    console.error("WhatsApp alert error", e)
    return false
  }
}
export const SALES_EMAIL = () => env("NOTIFY_EMAIL") || "lighthouseinme@gmail.com"

// ---------------------------------------------------------------------------
// PayFast signature (matches PHP urlencode as used in PayFast's docs)
// ---------------------------------------------------------------------------
export function pfEncode(value: string): string {
  return encodeURIComponent(value)
    .replace(/%20/g, "+")
    .replace(/[!'()*~]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase())
}

export function paramString(pairs: [string, string][]): string {
  return pairs.map(([k, v]) => `${k}=${pfEncode(v)}`).join("&")
}

export function signature(pairs: [string, string][], passphrase: string): string {
  let s = paramString(pairs)
  if (passphrase) s += `&passphrase=${pfEncode(passphrase)}`
  return createHash("md5").update(s).digest("hex")
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------
export const orders = () => getStore({ name: "shop-orders", consistency: "strong" })
export const accessCodes = () => getStore({ name: "shop-access-codes", consistency: "strong" })
// Reshma's existing online-reader codes, loaded through the admin page.
// Keys: "available/<CODE>" and "used/<CODE>"
export const ebookPool = () => getStore({ name: "ebook-code-pool", consistency: "strong" })

export async function claimEbookCode(orderId: string, email: string): Promise<string | null> {
  const pool = ebookPool()
  const { blobs } = await pool.list({ prefix: "available/" })
  for (const b of blobs.sort((a, z) => a.key.localeCompare(z.key))) {
    const code = b.key.slice("available/".length)
    const { modified } = await pool.setJSON(
      `used/${code}`,
      { orderId, email, usedAt: new Date().toISOString() },
      { onlyIfNew: true },
    )
    if (modified) {
      await pool.delete(b.key)
      return code
    }
  }
  return null
}

export async function poolCount(): Promise<{ available: number; used: number }> {
  const pool = ebookPool()
  const [a, u] = await Promise.all([pool.list({ prefix: "available/" }), pool.list({ prefix: "used/" })])
  return { available: a.blobs.length, used: u.blobs.length }
}

export function checkAdmin(req: Request): boolean {
  const expected = (Netlify.env.get("ADMIN_PASSWORD") ?? "").trim()
  const given = (req.headers.get("x-admin-key") ?? "").trim()
  if (expected.length < 8 || given.length !== expected.length) return false
  let diff = 0
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i)
  return diff === 0
}

export interface Order {
  id: string
  product: ProductId
  amount: string
  firstName: string
  lastName: string
  email: string
  cell: string
  postnet: string
  bookTitle?: string
  status: "pending" | "paid" | "failed" | "cancelled"
  createdAt: string
  paidAt?: string
  pfPaymentId?: string
  ebookCode?: string
  licencePhone?: string
  journalCode?: string
  needsManualCode?: boolean
  posted?: boolean
  emailSent?: boolean
}

export function newOrderId(): string {
  return randomBytes(12).toString("hex")
}

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789" // no 0/O/1/I
export function newAccessCode(prefix: string): string {
  const bytes = randomBytes(8)
  let out = ""
  for (let i = 0; i < 8; i++) out += ALPHABET[bytes[i] % ALPHABET.length]
  return `${prefix}-${out.slice(0, 4)}-${out.slice(4)}`
}

export const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  })

// ---------------------------------------------------------------------------
// Email (optional — sent through Resend when RESEND_API_KEY is set)
// ---------------------------------------------------------------------------
// The one access code that opens both the online book and the journal.
// Set SHARED_ACCESS_CODE in Netlify; it must also be a valid code in the reader.
export const SHARED_CODE = () => env("SHARED_ACCESS_CODE")

export function isSharedCode(code: string): boolean {
  const shared = SHARED_CODE()
  return !!shared && code.trim().toUpperCase() === shared.toUpperCase()
}

// Sends through Resend from the verified reshma.co.za domain when
// RESEND_API_KEY is set (no reply-to; queries go to lighthouseinme@gmail.com).
// Falls back to Gmail (GMAIL_APP_PASSWORD) if Resend is missing or fails.
async function sendViaResend(to: string, subject: string, html: string): Promise<boolean> {
  const key = env("RESEND_API_KEY").trim()
  if (!key) return false
  const from = env("EMAIL_FROM") || "The Lighthouse in Me <books@reshma.co.za>"
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [to], subject, html }),
    })
    if (!res.ok) console.error("Resend failed", res.status, await res.text())
    return res.ok
  } catch (e) {
    console.error("Resend error", e)
    return false
  }
}

async function sendViaGmail(to: string, subject: string, html: string): Promise<boolean> {
  const gmailPass = env("GMAIL_APP_PASSWORD").replace(/\s+/g, "")
  if (!gmailPass) return false
  const user = env("GMAIL_USER") || "lighthouseinme@gmail.com"
  try {
    const nodemailer = (await import("nodemailer")).default
    const transport = nodemailer.createTransport({
      host: "smtp.gmail.com", port: 465, secure: true,
      auth: { user, pass: gmailPass },
    })
    await transport.sendMail({ from: `"The Lighthouse in Me" <${user}>`, to, subject, html })
    return true
  } catch (e) {
    console.error("Gmail send failed", e)
    return false
  }
}

export async function sendEmail(to: string, subject: string, html: string): Promise<boolean> {
  if (await sendViaResend(to, subject, html)) return true
  return sendViaGmail(to, subject, html)
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  )
}
