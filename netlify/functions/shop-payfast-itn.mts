import type { Config, Context } from "@netlify/functions"
import {
  PRODUCTS, payfastConfig, paramString, signature, orders, accessCodes,
  newAccessCode, claimEbookCode, sendEmail, escapeHtml, READER_URL, SALES_EMAIL, type Order,
} from "../shared/shop.mts"

// PayFast Instant Transaction Notification (ITN).
// This is the ONLY place an order is marked paid and access codes are issued.
export default async (req: Request, context: Context) => {
  const raw = await req.text()
  const pairs: [string, string][] = [...new URLSearchParams(raw).entries()]
  const data = Object.fromEntries(pairs)
  const pf = payfastConfig()
  const ok = () => new Response("OK", { status: 200 })

  // 1. Signature check
  const unsigned = pairs.filter(([k]) => k !== "signature")
  if (signature(unsigned, pf.passphrase) !== data.signature) {
    console.error("ITN: bad signature", data.m_payment_id)
    return new Response("Bad signature", { status: 400 })
  }

  // 2. Merchant check
  if (data.merchant_id !== pf.merchantId) {
    console.error("ITN: wrong merchant", data.merchant_id)
    return new Response("Wrong merchant", { status: 400 })
  }

  // 3. Confirm with PayFast's server that this notification is genuine
  try {
    const v = await fetch(`https://${pf.host}/eng/query/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: paramString(unsigned),
    })
    const text = (await v.text()).trim()
    if (text !== "VALID") {
      console.error("ITN: PayFast validation said", text)
      return new Response("Not valid", { status: 400 })
    }
  } catch (e) {
    console.error("ITN: validation request failed", e)
    return new Response("Validation unavailable", { status: 500 }) // PayFast will retry
  }

  // 4. Match the order and amount
  const store = orders()
  const order = (await store.get(data.m_payment_id, { type: "json" })) as Order | null
  if (!order) {
    console.error("ITN: unknown order", data.m_payment_id)
    return new Response("Unknown order", { status: 400 })
  }
  if (order.status === "paid") return ok() // duplicate notification

  const expected = Number(PRODUCTS[order.product].amount)
  if (Math.abs(Number(data.amount_gross) - expected) > 0.01) {
    console.error("ITN: amount mismatch", data.amount_gross, expected)
    order.status = "failed"
    await store.setJSON(order.id, order)
    return new Response("Amount mismatch", { status: 400 })
  }

  if (data.payment_status === "CANCELLED") {
    order.status = "cancelled"
    await store.setJSON(order.id, order)
    return ok()
  }
  if (data.payment_status !== "COMPLETE") {
    order.status = "failed"
    await store.setJSON(order.id, order)
    return ok()
  }

  // 5. Paid — issue access codes
  order.status = "paid"
  order.paidAt = new Date().toISOString()
  order.pfPaymentId = data.pf_payment_id
  const codes = accessCodes()
  const issue = async (prefix: string, type: "ebook" | "journal") => {
    for (let i = 0; i < 5; i++) {
      const code = newAccessCode(prefix)
      const { modified } = await codes.setJSON(
        code,
        { code, type, orderId: order.id, name: `${order.firstName} ${order.lastName}`, email: order.email, createdAt: order.paidAt },
        { onlyIfNew: true },
      )
      if (modified) return code
    }
    throw new Error("Could not create a unique access code")
  }
  if (order.product === "ebook") {
    const code = await claimEbookCode(order.id, order.email)
    if (code) order.ebookCode = code
    else order.needsManualCode = true
  }
  if (order.product === "paperback" || order.product === "test") order.journalCode = await issue("JOURNAL", "journal")
  await store.setJSON(order.id, order)

  const siteUrl = new URL(req.url).origin
  // 6. Emails (best effort — the thank-you page also shows the code)
  const name = escapeHtml(order.firstName)
  if (order.product === "ebook" && !order.ebookCode) {
    order.emailSent = await sendEmail(
      order.email,
      "Your order of The Lighthouse in Me",
      `<p>Dear ${name},</p>
       <p>Thank you for buying the ebook of <em>The Lighthouse in Me</em>. Your payment is confirmed, and your personal access code will be emailed to you shortly.</p>
       <p>With warm regards,<br>Reshma Subramoney</p>`,
    )
  } else if (order.product === "test") {
    order.emailSent = false
  } else if (order.ebookCode) {
    order.emailSent = await sendEmail(
      order.email,
      "Your access code for The Lighthouse in Me",
      `<p>Dear ${name},</p>
       <p>Thank you for buying <em>The Lighthouse in Me</em>. Your personal access code is:</p>
       <p style="font-size:22px;font-weight:bold;letter-spacing:2px">${order.ebookCode}</p>
       <p>Open the book here: <a href="${READER_URL()}">${READER_URL()}</a> and enter your code.</p>
       <p>This code is for your personal use. With warm regards,<br>Reshma Subramoney</p>`,
    )
  } else {
    order.emailSent = await sendEmail(
      order.email,
      "Your order of The Lighthouse in Me",
      `<p>Dear ${name},</p>
       <p>Thank you for ordering the paperback of <em>The Lighthouse in Me</em>. It will be posted to
       <strong>${escapeHtml(order.postnet)}</strong>, and we'll let you know when it's on its way.</p>
       <p>Your free 7-Day Journal App code is:</p>
       <p style="font-size:22px;font-weight:bold;letter-spacing:2px">${order.journalCode}</p>
       <p>Open your journal here: <a href="${siteUrl}/journal/?code=${order.journalCode}">${siteUrl}/journal/</a></p>
       <p>With warm regards,<br>Reshma Subramoney</p>`,
    )
  }
  await store.setJSON(order.id, order)

  await sendEmail(
    SALES_EMAIL(),
    `${order.needsManualCode ? "ACTION NEEDED - send ebook code: " : ""}New ${order.product} order: ${order.firstName} ${order.lastName} (R${order.amount})`,
    `<p><strong>${order.product === "paperback" ? "Paperback — please post" : "Ebook"}</strong></p>
     <p>Name: ${escapeHtml(order.firstName + " " + order.lastName)}<br>
     Email: ${escapeHtml(order.email)}<br>
     Cell: ${escapeHtml(order.cell || "-")}<br>
     PostNet branch: ${escapeHtml(order.postnet || "-")}<br>
     Amount: R${order.amount}<br>
     PayFast ref: ${escapeHtml(order.pfPaymentId ?? "")}<br>
     Code issued: ${order.ebookCode ?? order.journalCode ?? "NONE - the ebook code pool is empty. Add codes on the admin page and assign one to this order."}</p>`,
  )

  return ok()
}

export const config: Config = { path: "/api/shop/payfast-itn", method: "POST" }
