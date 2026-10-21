import type { Config, Context } from "@netlify/functions"
import { orders, json, READER_URL, type Order } from "../shared/shop.mts"

// Called by the thank-you page. The order id is a long random token that only
// the buyer's browser has, so it is safe to return their code to them here.
export default async (req: Request, context: Context) => {
  const id = new URL(req.url).searchParams.get("order") ?? ""
  if (!/^[a-f0-9]{24}$/.test(id)) return json({ error: "Order not found" }, 404)
  const order = (await orders().get(id, { type: "json" })) as Order | null
  if (!order) return json({ error: "Order not found" }, 404)

  return json({
    status: order.status,
    product: order.product,
    firstName: order.firstName,
    email: order.email,
    postnet: order.postnet || null,
    ebookCode: order.status === "paid" ? order.ebookCode ?? null : null,
    journalCode: order.status === "paid" ? order.journalCode ?? null : null,
    readerUrl: READER_URL(),
  })
}

export const config: Config = { path: "/api/shop/order-status", method: "GET" }
