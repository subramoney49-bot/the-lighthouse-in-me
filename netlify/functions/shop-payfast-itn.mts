import type { Config, Context } from "@netlify/functions"
import {
  PRODUCTS, payfastConfig, paramString, signature, orders, accessCodes,
  newAccessCode, SHARED_CODE, sendEmail, escapeHtml, READER_URL, SALES_EMAIL,
  issueReaderLicence, notifyWhatsApp, type Order,
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
  // Ebook: create a personal licence in the secure reader, tied to the buyer's cellphone
  if (order.product === "ebook") {
    const lic = await issueReaderLicence(`${order.firstName} ${order.lastName}`, order.cell)
    if (lic) { order.ebookCode = lic.code; order.licencePhone = lic.phone }
    else order.needsManualCode = true
  }
  // Free journal code (unchanged)
  const shared = SHARED_CODE()
  if (order.product !== "ereader") {
    if (shared) order.journalCode = shared
    else if (order.product === "paperback" || order.product === "collect" || order.product === "test") order.journalCode = await issue("JOURNAL", "journal")
  }
  await store.setJSON(order.id, order)

  // 6. Email the buyer straight away (the thank-you page also shows the code)
  const siteUrl = new URL(req.url).origin
  const name = escapeHtml(order.firstName)
  const journalLink = `${siteUrl}/journal/?code=${encodeURIComponent(order.journalCode ?? "")}`
  const codeBlock = (code: string) =>
    `<p style="font-size:22px;font-weight:bold;letter-spacing:2px;margin:16px 0">${escapeHtml(code)}</p>`
  const button = (href: string, label: string) =>
    `<p style="margin:12px 0"><a href="${href}" style="background:#1d3447;color:#fdfbf7;padding:12px 20px;border-radius:999px;text-decoration:none;font-weight:bold;display:inline-block">${label}</a></p>`
  const sign = `<p>With warm regards,<br>Reshma Subramoney<br><a href="${siteUrl}">${siteUrl.replace(/^https?:\/\//, "")}</a></p><p style="color:#666;font-size:13px">Please do not reply to this email. For any queries, email <a href="mailto:lighthouseinme@gmail.com">lighthouseinme@gmail.com</a>.</p>`

  if (order.product === "ebook" && order.ebookCode) {
    const localCell = (order.licencePhone || order.cell).replace(/^\+27/, "0")
    order.emailSent = await sendEmail(
      order.email,
      "Your licence code for The Lighthouse in Me",
      `<p>Dear ${name},</p>
       <p>Thank you for buying <em>The Lighthouse in Me</em>. Your payment is confirmed. Your personal licence code is:</p>
       ${codeBlock(order.ebookCode)}
       <p><strong>How to unlock the book:</strong></p>
       <ol>
         <li>Open the reader with the button below.</li>
         <li>Tap <strong>Access Full Book With A Code</strong>.</li>
         <li>Enter your cellphone number <strong>${escapeHtml(localCell)}</strong> and the licence code above.</li>
         <li>We'll SMS you a one-time code. Enter it, and the full book opens.</li>
       </ol>
       ${button(READER_URL(), "Open the reader")}
       <p>Your licence works on one device, so unlock it on the phone or tablet you'll read on. Tip: add the reader to your home screen so it's always one tap away.</p>
       ${order.journalCode ? `<p>Your free <em>Seven Days to Reclaim Your Worth</em> journal code is:</p>${codeBlock(order.journalCode)}${button(journalLink, "Open the journal")}` : ""}
       <p>Please keep your licence code private.</p>${sign}`,
    )
  } else if (order.product === "ebook") {
    order.emailSent = await sendEmail(
      order.email,
      "Your order of The Lighthouse in Me",
      `<p>Dear ${name},</p>
       <p>Thank you for buying the ebook of <em>The Lighthouse in Me</em>. Your payment is confirmed, and your personal licence code will be sent to you shortly.</p>${sign}`,
    )
  } else if (order.product === "paperback") {
    order.emailSent = await sendEmail(
      order.email,
      "Your order of The Lighthouse in Me",
      `<p>Dear ${name},</p>
       <p>Thank you for ordering the paperback of <em>The Lighthouse in Me</em>. Your payment is confirmed. The book will be posted to
       <strong>${escapeHtml(order.postnet)}</strong>, and PostNet will contact you on ${escapeHtml(order.cell)} when it arrives.</p>
       <p>While you wait, here is your access code for the free <em>Seven Days to Reclaim Your Worth</em> journal:</p>
       ${codeBlock(order.journalCode ?? "")}
       ${button(journalLink, "Open the journal")}${sign}`,
    )
  } else if (order.product === "collect") {
    order.emailSent = await sendEmail(
      order.email,
      "Your order of The Lighthouse in Me",
      `<p>Dear ${name},</p>
       <p>Thank you for ordering the paperback of <em>The Lighthouse in Me</em> for collection. Your payment is confirmed.
       We will contact you on ${escapeHtml(order.cell)} to arrange when and where to collect your book.</p>
       <p>While you wait, here is your access code for the free <em>Seven Days to Reclaim Your Worth</em> journal:</p>
       ${codeBlock(order.journalCode ?? "")}
       ${button(journalLink, "Open the journal")}${sign}`,
    )
  } else if (order.product === "ereader") {
    order.emailSent = await sendEmail(
      order.email,
      "Your custom e-reader order",
      `<p>Dear ${name},</p>
       <p>Thank you for ordering a custom e-reader${order.bookTitle ? ` for <strong>${escapeHtml(order.bookTitle)}</strong>` : ""}. Your payment of R3,800 is confirmed.</p>
       <p>Reshma will contact you on ${escapeHtml(order.cell)} within two working days to collect your manuscript, cover and preferences, and to agree a timeline.</p>${sign}`,
    )
  } else {
    order.emailSent = await sendEmail(
      order.email,
      "Website test payment received",
      `<p>The R5 test payment went through. Access code issued: ${escapeHtml(order.journalCode ?? "")}</p>${button(journalLink, "Open the journal")}`,
    )
  }
  await store.setJSON(order.id, order)

  await sendEmail(
    SALES_EMAIL(),
    `${order.needsManualCode ? "ACTION NEEDED - create a reader licence: " : ""}New ${order.product} order: ${order.firstName} ${order.lastName} (R${order.amount})`,
    `<p><strong>${order.product === "ereader" ? `Custom e-reader for an author — please contact the buyer${order.bookTitle ? ` (book: ${escapeHtml(order.bookTitle)})` : ""}` : order.product === "paperback" ? "Paperback — please post" : order.product === "collect" ? "Paperback — COLLECTION (no delivery), please contact buyer to arrange" : order.product === "test" ? "Test payment" : "Ebook"}</strong></p>
     <p>Buyer email ${order.emailSent ? "sent" : "NOT sent - please send the code yourself"}.</p>
     <p>Name: ${escapeHtml(order.firstName + " " + order.lastName)}<br>
     Email: ${escapeHtml(order.email)}<br>
     Cell: ${escapeHtml(order.cell || "-")}<br>
     PostNet branch: ${escapeHtml(order.postnet || "-")}<br>
     Amount: R${order.amount}<br>
     PayFast ref: ${escapeHtml(order.pfPaymentId ?? "")}<br>
     ${order.product === "ereader" ? "" : `${order.product === "ebook" ? (order.ebookCode ? `Reader licence issued automatically for ${escapeHtml(order.licencePhone ?? order.cell)}` : "NO LICENCE - the reader could not be reached. Create one on the Reader Admin app and send it to the buyer.") : `Code issued: ${order.journalCode ?? "NONE"}`}`}</p>`,
  )

  // WhatsApp alert to Reshma (only if CALLMEBOT_APIKEY is set)
  const label = order.product === "ebook" ? "Ebook" : order.product === "paperback" ? "Paperback (post)" : order.product === "collect" ? "Paperback (collect)" : order.product === "ereader" ? "Custom e-reader" : "Test"
  await notifyWhatsApp(
    `New sale: ${label} R${order.amount}\n${order.firstName} ${order.lastName}\n${order.cell || order.email}` +
    (order.product === "ebook" ? (order.ebookCode ? "\nLicence code sent automatically." : "\nACTION NEEDED: create a licence on Reader Admin.") : ""),
  )

  return ok()
}

export const config: Config = { path: "/api/shop/payfast-itn", method: "POST" }
