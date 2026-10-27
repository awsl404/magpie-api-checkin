// Account handles: URL normalising, credential shapes, JWT hints, and the
// metadata an account keeps in Magpie's plugin-auth.json.

import { finiteNumber, hostOf, nonEmptyString, record } from "./http.mjs"
import { normalizeCustomConfig } from "./config.mjs"
import { round2 } from "./values.mjs"

export const PLATFORM_IDS = ["auto", "new-api", "sub2api", "sub2api-pro", "custom"]

export const PLATFORM_LABELS = {
  "new-api": "new-api / one-api",
  sub2api: "sub2api",
  "sub2api-pro": "sub2api Pro",
  custom: "自定义接口",
  auto: "自动检测",
}

// The credential Magpie keeps for a custom account that needs no token at
// all (its auth is in the custom headers). It must not look like a token.
export const NO_TOKEN_KEY = "custom:no-token"

// new-api keeps its user id in a few headers across forks; sending all of them
// is what metapi and all-api-hub do, and harmless where they are ignored.
const USER_ID_HEADERS = [
  "New-API-User",
  "Veloera-User",
  "voapi-user",
  "User-id",
  "X-User-Id",
  "Rix-Api-User",
  "neo-api-user",
]

const COOKIE_RE =
  /(^|;\s*)(session|token|auth_token|access_token|jwt|jwt_token|sessionid)=/i

export function isValidPlatform(value) {
  return PLATFORM_IDS.includes(value)
}

/**
 * A site URL as the adapters use it: scheme and host, no trailing slash, and
 * no API suffix a browser address bar might have picked up.
 */
export function normalizeBaseUrl(input) {
  let text = nonEmptyString(input)
  if (!text) throw new Error("请填写站点地址，例如 https://api.example.com")
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `https://${text}`
  let url
  try {
    url = new URL(text)
  } catch {
    throw new Error(`站点地址无法解析：${text}`)
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("站点地址必须以 http:// 或 https:// 开头")
  }
  let path = url.pathname.replace(/\/+$/, "")
  path = path
    .replace(/\/api\/v1$/i, "")
    .replace(/\/v1$/i, "")
    .replace(/\/api$/i, "")
  const base = `${url.origin}${path}`
  if (!hostOf(base)) throw new Error(`站点地址无法解析：${text}`)
  return base
}

export function isCookieCredential(token) {
  return COOKIE_RE.test(String(token || ""))
}

function base64UrlDecode(input) {
  const normalized = String(input).replace(/-/g, "+").replace(/_/g, "/")
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4)
  if (typeof atob === "function") {
    const binary = atob(padded)
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0))
    return new TextDecoder().decode(bytes)
  }
  if (typeof Buffer !== "undefined") {
    return Buffer.from(padded, "base64").toString("utf8")
  }
  throw new Error("no base64 decoder")
}

/** A JWT's payload, or null for an opaque token. */
export function decodeJwt(token) {
  const parts = String(token || "").split(".")
  if (parts.length !== 3) return null
  try {
    const payload = JSON.parse(base64UrlDecode(parts[1]))
    return record(payload)
  } catch {
    return null
  }
}

export function jwtUserId(token) {
  const payload = decodeJwt(token)
  if (!payload) return undefined
  for (const key of ["id", "user_id", "uid", "sub", "userId"]) {
    const n = finiteNumber(payload[key])
    if (n !== undefined && n > 0) return Math.trunc(n)
  }
  return undefined
}

/** A display name a JWT carries, or "" for an opaque token. */
export function jwtUsername(token) {
  const payload = decodeJwt(token)
  if (!payload) return ""
  for (const key of ["username", "name", "preferred_username", "nickname", "email"]) {
    const text = nonEmptyString(payload[key])
    if (text) return text
  }
  return ""
}

/** Whether a JWT says it has expired (30s of leeway for clock drift). */
export function jwtExpired(token) {
  const payload = decodeJwt(token)
  const exp = finiteNumber(payload?.exp)
  if (exp === undefined) return false
  return exp * 1000 <= Date.now() + 30_000
}

function appendUserIds(headers, userId) {
  const n = finiteNumber(userId)
  if (n === undefined || n <= 0) return headers
  const value = String(Math.trunc(n))
  for (const name of USER_ID_HEADERS) headers[name] = value
  return headers
}

/** Headers new-api, one-api and their forks accept. */
export function newApiHeaders(token, userId) {
  const raw = String(token || "").trim()
  if (isCookieCredential(raw)) {
    return appendUserIds(
      {
        Cookie: raw,
        Accept: "application/json",
        "X-Requested-With": "XMLHttpRequest",
      },
      userId,
    )
  }
  const clean = raw.replace(/^Bearer\s+/i, "").trim()
  const headers = { Authorization: `Bearer ${clean}`, Accept: "application/json" }
  return appendUserIds(headers, userId)
}

/** Headers sub2api and its forks accept (JWT in the Authorization header). */
export function sub2ApiHeaders(token) {
  const raw = String(token || "").trim()
  if (isCookieCredential(raw)) {
    return { Cookie: raw, Accept: "application/json" }
  }
  const clean = raw.replace(/^Bearer\s+/i, "").trim()
  return { Authorization: `Bearer ${clean}`, Accept: "application/json" }
}

export function headersFor(platform, token, userId) {
  return platform === "new-api"
    ? newApiHeaders(token, userId)
    : sub2ApiHeaders(token)
}

/**
 * An account as the adapters see it, from the auth object Magpie hands a hook
 * ({type: "api", key, metadata}) or from a plain object in the tests.
 */
export function accountOf(auth) {
  const md = record(auth?.metadata) || {}
  const custom = normalizeCustomConfig(md)
  const rawKey = nonEmptyString(auth?.key)
  const noToken = custom.noToken || rawKey === NO_TOKEN_KEY
  const token = noToken ? "" : rawKey || nonEmptyString(md.token)
  const platform = isValidPlatform(md.platform) ? md.platform : "auto"
  return {
    token,
    baseUrl: md.baseUrl || md.url ? normalizeBaseUrl(md.baseUrl || md.url) : "",
    platform,
    // A custom account may still have had new-api/sub2api detected at
    // sign-in; its balance and site name are read from there.
    detectedPlatform: ["new-api", "sub2api", "sub2api-pro"].includes(md.detectedPlatform)
      ? md.detectedPlatform
      : "",
    userId: finiteNumber(md.userId) ?? jwtUserId(token),
    username: nonEmptyString(md.username),
    label: nonEmptyString(md.label),
    apiKey: nonEmptyString(md.apiKey) || nonEmptyString(md.apikey),
    quotaPerUnit: finiteNumber(md.quotaPerUnit) || 500_000,
    siteName: nonEmptyString(md.siteName),
    custom,
    noToken,
    cookie: isCookieCredential(token),
  }
}

/** The name Magpie shows for the account (metadata.email is its naming field). */
export function displayLabel({ label, baseUrl, username, userId, token }) {
  const host = hostOf(baseUrl)
  const stated = nonEmptyString(label) || nonEmptyString(username)
  const id = finiteNumber(userId)
  const tail = nonEmptyString(token) ? String(token).slice(-4) : ""
  const who = stated || (id ? `#${Math.trunc(id)}` : tail || host)
  return (who === host ? host : `${who} · ${host}`).slice(0, 80)
}

/** A dollar amount for a balance line: $0.00, <$0.01, $1.23, $1,234.56. */
export function usd(value) {
  const n = finiteNumber(value)
  if (n === undefined) return ""
  if (n === 0) return "$0.00"
  if (n > 0 && n < 0.01) return "<$0.01"
  const text = Math.abs(n) >= 1000 ? n.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 }) : n.toFixed(2)
  return `${n < 0 ? "-" : ""}$${text.replace("-", "")}`
}

export { round2 }
