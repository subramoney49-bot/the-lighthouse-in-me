import { getStore } from "@netlify/blobs"

// Anonymous website stats: one summary record per South African day.
export const siteStats = () => getStore({ name: "site-stats", consistency: "strong" })

export const PRODUCTS = ["ebook", "paperback", "collect", "ereader"]

export interface Day {
  views: number
  visits: number
  pages: Record<string, number>
  sources: Record<string, number>
  campaigns: Record<string, { visits: number; buys: number; checkouts: number }>
  buys: Record<string, number>
  checkouts: Record<string, number>
  sourceBuys: Record<string, number>
  sourceCheckouts: Record<string, number>
}

export const emptyDay = (): Day => ({
  views: 0, visits: 0, pages: {}, sources: {}, campaigns: {}, buys: {}, checkouts: {},
  sourceBuys: {}, sourceCheckouts: {},
})

export const saDate = (d = new Date()) => new Date(d.getTime() + 2 * 3600e3).toISOString().slice(0, 10)

