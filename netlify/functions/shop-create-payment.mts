import type { Config, Context } from "@netlify/functions"
import {
  PRODUCTS, payfastConfig, signature, orders, newOrderId, json,
  type Order, type ProductId,
} from "../shared/shop.mts"

const clean = (v: unknown, max = 100) =>
  String(v ?? "").replace(/[\r\n\t]/g, " ").trim().slice(0, max)

export default async (req: Request, context: Context) => {
  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return json({ error: "Invalid request" }, 400)
  }

  const productId = clean(body.product) as ProductId
  const product = PRODUCTS[productId]
  if (!product) return json({ error: "Unknown product" }, 400)
  if (product.id === "test" && (Netlify.env.get("ALLOW_TEST_PURCHASE") ?? "").trim().toLowerCase() !== "yes") {
    return json({ error: "Unknown product" }, 400)
  }

  const firstName = clean(body.firstName, 100)
  const lastName = clean(body.lastName, 100)
  const email = clean(body.email, 100).toLowerCase()
  const cell = clean(body.cell, 20).replace(/[^\d+]/g, "")
  const postnet = clean(body.postnet, 200)

  if (!firstName || !lastName) return json({ error: "Please enter your full name." }, 400)
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "Please enter a valid email address." }, 400)
  if (product.needsDelivery) {
    if (cell.replace(/\D/g, "").length < 9) return json({ error: "Please enter a valid cell number." }, 400)
    if (!postnet) return json({ error: "Please enter your nearest PostNet branch." }, 400)
  }

  const order: Order = {
    id: newOrderId(),
    product: product.id,
    amount: product.amount,
    firstName, lastName, email, cell, postnet,
    status: "pending",
    createdAt: new Date().toISOString(),
  }
  await orders().setJSON(order.id, order)

  const pf = payfastConfig()
  const base = new URL(req.url).origin

  // Field order matters for the PayFast signature
  const pairs: [string, string][] = [
    ["merchant_id", pf.merchantId],
    ["merchant_key", pf.merchantKey],
    ["return_url", `${base}/shop/thank-you.html?order=${order.id}`],
    ["cancel_url", `${base}/books/?cancelled=1`],
    ["notify_url", `${base}/api/shop/payfast-itn`],
    ["name_first", firstName],
    ["name_last", lastName],
    ["email_address", email],
  ]
  // PayFast expects a 10-digit SA number starting with 0
  const saCell = cell.startsWith("+27") ? "0" + cell.slice(3) : cell
  if (/^0\d{9}$/.test(saCell)) pairs.push(["cell_number", saCell])
  pairs.push(
    ["m_payment_id", order.id],
    ["amount", product.amount],
    ["item_name", product.name],
    ["item_description", product.description],
    ["custom_str1", product.id],
    // Shown on the PayFast transaction, so delivery details are visible there too
    ["custom_str2", product.needsDelivery ? `PostNet: ${postnet}`.slice(0, 255) : ""],
    ["custom_str3", product.needsDelivery ? `Cell: ${cell}` : ""],
  )
  const fields = pairs.map(([k, v]) => [k, v.trim()] as [string, string]).filter(([, v]) => v !== "")
  fields.push(["signature", signature(fields, pf.passphrase)])

  return json({
    action: `https://${pf.host}/eng/process`,
    fields: Object.fromEntries(fields),
    testMode: !pf.live,
  })
}

export const config: Config = { path: "/api/shop/create-payment", method: "POST" }
