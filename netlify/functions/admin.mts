import type { Config, Context } from "@netlify/functions"
import { orders, ebookPool, poolCount, checkAdmin, json, sendEmail, escapeHtml, READER_URL, type Order } from "../shared/shop.mts"

// Admin API — every call needs the ADMIN_PASSWORD (set in Netlify) in the x-admin-key header.
//   GET  /api/admin/summary            orders + code pool counts
//   POST /api/admin/codes              { codes: "CODE1\nCODE2..." }  add reader codes to the pool
//   POST /api/admin/assign             { orderId, code }  give an ebook buyer a code by hand
//   POST /api/admin/posted             { orderId, posted }  mark a paperback as posted
export default async (req: Request, context: Context) => {
  if (!(Netlify.env.get("ADMIN_PASSWORD") ?? "").trim()) {
    return json({ error: "Admin is not set up yet. Add ADMIN_PASSWORD in Netlify." }, 503)
  }
  if (!checkAdmin(req)) return json({ error: "Wrong password" }, 401)

  const action = context.params.action
  const store = orders()

  if (action === "summary" && req.method === "GET") {
    const { blobs } = await store.list()
    const all = (await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" })))) as Order[]
    const list = all
      .filter((o) => o && o.status !== "pending")
      .sort((a, b) => (b.paidAt ?? b.createdAt).localeCompare(a.paidAt ?? a.createdAt))
    return json({ orders: list, pool: await poolCount() })
  }

  if (req.method !== "POST") return json({ error: "Not found" }, 404)
  const body = await req.json().catch(() => ({}))

  if (action === "codes") {
    const codes = [...new Set(String(body.codes ?? "")
      .split(/[\s,;]+/).map((c) => c.trim()).filter((c) => c.length >= 3 && c.length <= 60))]
    const pool = ebookPool()
    let added = 0, skipped = 0
    for (const code of codes) {
      if (await pool.get(`used/${code}`)) { skipped++; continue }
      const { modified } = await pool.setJSON(`available/${code}`, { addedAt: new Date().toISOString() }, { onlyIfNew: true })
      modified ? added++ : skipped++
    }
    return json({ added, skipped, pool: await poolCount() })
  }

  const order = (await store.get(String(body.orderId ?? ""), { type: "json" })) as Order | null
  if (!order) return json({ error: "Order not found" }, 404)

  if (action === "assign") {
    const code = String(body.code ?? "").trim()
    if (!code) return json({ error: "Enter a code" }, 400)
    order.ebookCode = code
    order.needsManualCode = false
    await ebookPool().delete(`available/${code}`)
    await ebookPool().setJSON(`used/${code}`, { orderId: order.id, email: order.email, usedAt: new Date().toISOString() })
    order.emailSent = await sendEmail(
      order.email,
      "Your access code for The Lighthouse in Me",
      `<p>Dear ${escapeHtml(order.firstName)},</p>
       <p>Thank you for buying <em>The Lighthouse in Me</em>. Your personal access code is:</p>
       <p style="font-size:22px;font-weight:bold;letter-spacing:2px">${escapeHtml(code)}</p>
       <p>Open the book here: <a href="${READER_URL()}">${READER_URL()}</a> and enter your code.</p>
       <p>With warm regards,<br>Reshma Subramoney</p>`,
    )
    await store.setJSON(order.id, order)
    return json({ ok: true, emailSent: order.emailSent })
  }

  if (action === "posted") {
    order.posted = !!body.posted
    await store.setJSON(order.id, order)
    return json({ ok: true })
  }

  return json({ error: "Not found" }, 404)
}

export const config: Config = { path: "/api/admin/:action" }
