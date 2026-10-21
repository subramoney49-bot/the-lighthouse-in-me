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
    amount: "250.00",
    needsDelivery: false,
  },
  paperback: {
    id: "paperback",
    name: "The Lighthouse in Me - Paperback",
    description: "Printed book posted to your nearest PostNet, plus the free 7-Day Journal App",
    amount: "330.00",
    needsDelivery: true,
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

export const READER_URL = () =>
  env("READER_URL") || "https://the-lighthouse-in-me-edition2.netlify.app/"
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
  status: "pending" | "paid" | "failed" | "cancelled"
  createdAt: string
  paidAt?: string
  pfPaymentId?: string
  ebookCode?: string
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
export async function sendEmail(to: string, subject: string, html: string): Promise<boolean> {
  const key = env("RESEND_API_KEY")
  const from = env("EMAIL_FROM")
  if (!key || !from) return false
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [to], subject, html, reply_to: SALES_EMAIL() }),
    })
    if (!res.ok) console.error("Email failed", res.status, await res.text())
    return res.ok
  } catch (e) {
    console.error("Email error", e)
    return false
  }
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  )
}
