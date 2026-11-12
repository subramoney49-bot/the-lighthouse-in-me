import type { Config } from "@netlify/functions"
import { siteStats, emptyDay, saDate, PRODUCTS, type Day } from "../shared/stats.mts"

// Anonymous website stats. Each day is one small summary record:
//   site-stats / day/YYYY-MM-DD  (South African date)
// No personal details are stored: only counts per page, source, campaign and shop step.

const clean = (v: unknown, max: number, re = /[^\w .()/-]/g) => String(v ?? "").replace(re, "").trim().slice(0, max)
const inc = (o: Record<string, number>, k: string, n = 1) => { o[k] = (o[k] || 0) + n }

export default async (req: Request) => {
  if (req.method !== "POST") return new Response("Not found", { status: 404 })
  if (/bot|crawl|spider|slurp|preview|headless/i.test(req.headers.get("user-agent") ?? "")) return new Response(null, { status: 204 })
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>
  const t = clean(b.t, 10)
  if (!["view", "buy", "checkout"].includes(t)) return new Response(null, { status: 204 })

  const source = clean(b.s, 30) || "Direct or messaging app"
  const campaign = clean(b.c, 40, /[^a-z0-9_-]/g)
  const product = clean(b.product, 15)
  let path = clean(b.p, 80, /[^\w./-]/g) || "/"
  if (!path.endsWith("/") && !path.includes(".")) path += "/"
  if (path.startsWith("/admin")) return new Response(null, { status: 204 })

  const store = siteStats()
  const key = `day/${saDate()}`
  for (let attempt = 0; attempt < 25; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 20 + Math.random() * 80 * Math.min(attempt, 5)))
    const cur = await store.getWithMetadata(key, { type: "json" })
    const day: Day = Object.assign(emptyDay(), (cur?.data as Day) ?? {})
    const camp = campaign ? (day.campaigns[campaign] ||= { visits: 0, buys: 0, checkouts: 0 }) : null

    if (t === "view") {
      day.views++
      inc(day.pages, path)
      if (b.n) {
        day.visits++
        inc(day.sources, source)
        if (camp) camp.visits++
      }
    } else if (t === "buy" && PRODUCTS.includes(product)) {
      inc(day.buys, product); inc(day.sourceBuys, source)
      if (camp) camp.buys++
    } else if (t === "checkout" && PRODUCTS.includes(product)) {
      inc(day.checkouts, product); inc(day.sourceCheckouts, source)
      if (camp) camp.checkouts++
    } else {
      return new Response(null, { status: 204 })
    }

    const res = cur
      ? await store.setJSON(key, day, { onlyIfMatch: cur.etag })
      : await store.setJSON(key, day, { onlyIfNew: true })
    if (res.modified) break
  }
  return new Response(null, { status: 204 })
}

export const config: Config = { path: "/api/track", method: "POST" }
