import type { Config, Context } from "@netlify/functions"
import { accessCodes, json, isSharedCode } from "../shared/shop.mts"

// Lets the online reader (and later the journal app) check a code that was
// issued by the shop. GET /api/shop/verify-code?code=LIGHT-ABCD-EFGH
export default async (req: Request, context: Context) => {
  const code = (new URL(req.url).searchParams.get("code") ?? "").trim().toUpperCase()
  if (isSharedCode(code)) return json({ valid: true, type: "journal" })
  if (!/^(LIGHT|JOURNAL)-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code)) return json({ valid: false })
  const entry = (await accessCodes().get(code, { type: "json" })) as
    | { type: string; name: string; email: string }
    | null
  if (!entry) return json({ valid: false })
  return json({ valid: true, type: entry.type })
}

export const config: Config = {
  path: "/api/shop/verify-code",
  method: "GET",
  rateLimit: { windowLimit: 30, windowSize: 60, aggregateBy: ["ip", "domain"] },
}
