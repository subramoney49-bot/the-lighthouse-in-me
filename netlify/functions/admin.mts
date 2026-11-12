import type { Config, Context } from "@netlify/functions"
import { orders, ebookPool, poolCount, checkAdmin, json, sendEmail, escapeHtml, READER_URL, type Order } from "../shared/shop.mts"
import { siteStats, emptyDay, saDate, type Day } from "../shared/stats.mts"

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

  if (action === "stats" && req.method === "GET") {
    const days = Math.max(1, Math.min(365, Number(new URL(req.url).searchParams.get("days")) || 30))
    const from = saDate(new Date(Date.now() - (days - 1) * 864e5))
    const st = siteStats()
    const { blobs } = await st.list({ prefix: "day/" })
    const keys = blobs.map((b) => b.key).filter((k) => k.slice(4) >= from)
    const dayData = (await Promise.all(keys.map((k) => st.get(k, { type: "json" })))) as (Day | null)[]
    const sum = emptyDay()
    const add = (to: Record<string, number>, fromO: Record<string, number> = {}) => { for (const k in fromO) to[k] = (to[k] || 0) + fromO[k] }
    const daily: { date: string; visits: number; views: number }[] = []
    keys.forEach((k, i) => {
      const d = Object.assign(emptyDay(), dayData[i] ?? {})
      daily.push({ date: k.slice(4), visits: d.visits, views: d.views })
      sum.views += d.views; sum.visits += d.visits
      add(sum.pages, d.pages); add(sum.sources, d.sources); add(sum.buys, d.buys); add(sum.checkouts, d.checkouts)
      add(sum.sourceBuys, d.sourceBuys); add(sum.sourceCheckouts, d.sourceCheckouts)
      for (const c in d.campaigns) {
        const t = (sum.campaigns[c] ||= { visits: 0, buys: 0, checkouts: 0 })
        t.visits += d.campaigns[c].visits; t.buys += d.campaigns[c].buys; t.checkouts += d.campaigns[c].checkouts
      }
    })
    daily.sort((a, b) => a.date.localeCompare(b.date))

    const { blobs: ob } = await store.list()
    const all = (await Promise.all(ob.map((b) => store.get(b.key, { type: "json" })))) as Order[]
    const paid = all.filter((o) => o && o.status === "paid" && o.product !== "test" && saDate(new Date(o.paidAt ?? o.createdAt)) >= from)
    const money = (o: Order) => Number(o.amount) || 0
    const byProduct: Record<string, { sales: number; revenue: number }> = {}
    const bySource: Record<string, { sales: number; revenue: number }> = {}
    const byCampaign: Record<string, { sales: number; revenue: number }> = {}
    for (const o of paid) {
      const p = (byProduct[o.product] ||= { sales: 0, revenue: 0 }); p.sales++; p.revenue += money(o)
      const sKey = o.source || "Unknown (before tracking)"
      const sr = (bySource[sKey] ||= { sales: 0, revenue: 0 }); sr.sales++; sr.revenue += money(o)
      if (o.campaign) { const c = (byCampaign[o.campaign] ||= { sales: 0, revenue: 0 }); c.sales++; c.revenue += money(o) }
    }
    const booksViews = (sum.pages["/books/"] || 0)
    return json({
      days, from,
      totals: { visits: sum.visits, views: sum.views, sales: paid.length, revenue: paid.reduce((a, o) => a + money(o), 0) },
      daily,
      sources: Object.keys({ ...sum.sources, ...bySource }).map((k) => ({
        source: k, visits: sum.sources[k] || 0, buyTaps: sum.sourceBuys[k] || 0, checkouts: sum.sourceCheckouts[k] || 0,
        sales: bySource[k]?.sales || 0, revenue: bySource[k]?.revenue || 0,
      })).sort((a, b) => b.visits - a.visits || b.sales - a.sales),
      funnel: ["ebook", "paperback", "collect", "ereader"].map((p) => ({
        product: p, booksPageViews: booksViews, buyTaps: sum.buys[p] || 0, checkouts: sum.checkouts[p] || 0,
        sales: byProduct[p]?.sales || 0, revenue: byProduct[p]?.revenue || 0,
      })),
      pages: Object.entries(sum.pages).map(([path, views]) => ({ path, views })).sort((a, b) => b.views - a.views).slice(0, 15),
      campaigns: Object.keys({ ...sum.campaigns, ...byCampaign }).map((c) => ({
        campaign: c, visits: sum.campaigns[c]?.visits || 0, buyTaps: sum.campaigns[c]?.buys || 0,
        checkouts: sum.campaigns[c]?.checkouts || 0, sales: byCampaign[c]?.sales || 0, revenue: byCampaign[c]?.revenue || 0,
      })).sort((a, b) => b.visits - a.visits),
      bestSellers: Object.entries(byProduct).map(([product, v]) => ({ product, ...v })).sort((a, b) => b.revenue - a.revenue),
    })
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
    if (!code) return json({ error: "Enter the licence code" }, 400)
    order.ebookCode = code
    order.needsManualCode = false
    const localCell = (order.cell || "").replace(/^\+27/, "0")
    order.emailSent = await sendEmail(
      order.email,
      "Your licence code for The Lighthouse in Me",
      `<p>Dear ${escapeHtml(order.firstName)},</p>
       <p>Thank you for buying <em>The Lighthouse in Me</em>. Your personal licence code is:</p>
       <p style="font-size:22px;font-weight:bold;letter-spacing:2px">${escapeHtml(code)}</p>
       <p>Open the reader at <a href="${READER_URL()}">${READER_URL()}</a>, tap <strong>Access Full Book With A Code</strong>, and enter your cellphone number${localCell ? ` <strong>${escapeHtml(localCell)}</strong>` : ""} with this licence code. We'll SMS you a one-time code to finish.</p>
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
