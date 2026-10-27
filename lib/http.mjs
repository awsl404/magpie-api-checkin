// Small HTTP helpers shared by the platform adapters. No dependencies: the
// plugin runs inside Magpie's Bun host (and under Node in the tests).

export const DEFAULT_TIMEOUT_MS = 10_000
export const USER_AGENT = "magpie-api-checkin/0.2.0"

export class PlatformError extends Error {
  constructor(message, options = {}) {
    super(message)
    this.name = "PlatformError"
    // auth | blocked | network | timeout | unsupported | server | business
    this.kind = options.kind || "server"
    this.status = options.status
    this.retryable = options.retryable === true
    this.detail = options.detail
  }
}

export function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

export function record(value) {
  return isRecord(value) ? value : null
}

export function finiteNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value.trim())) {
    const n = Number(value.trim())
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}

export function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : ""
}

export function isHtml(text) {
  if (!text) return false
  return /<!doctype\s+html|<html[\s>]|<head[\s>]|<body[\s>]/i.test(text.slice(0, 2000))
}

export function hostOf(url) {
  try {
    return new URL(url).host
  } catch {
    return String(url || "")
  }
}

function networkMessage(err, url) {
  const code = err?.cause?.code || err?.code || ""
  const host = hostOf(url)
  const hint = /ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EPROTO|CERT|SSL/i.test(String(code))
    ? `（${code}）`
    : ""
  return `无法连接 ${host}${hint}，请检查站点地址、网络或 magpie 的代理设置`
}

/**
 * One HTTP request. Never throws on an HTTP status: returns it with the text
 * and, when the body is JSON, the parsed value. Throws PlatformError only for
 * transport failures (timeout, DNS, TLS, refused connection).
 */
export async function request(url, options = {}) {
  const {
    method = "GET",
    headers = {},
    body,
    timeout = DEFAULT_TIMEOUT_MS,
    fetchImpl,
  } = options
  const doFetch = fetchImpl || globalThis.fetch
  if (typeof doFetch !== "function") {
    throw new PlatformError("当前运行环境没有 fetch，无法访问站点", { kind: "network" })
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    const response = await doFetch(url, {
      method,
      headers: { "User-Agent": USER_AGENT, ...headers },
      body,
      signal: controller.signal,
      redirect: "follow",
    })
    const text = await response.text()
    let json
    if (text && text.trim()) {
      try {
        json = JSON.parse(text)
      } catch {
        json = undefined
      }
    }
    return {
      url,
      status: response.status,
      ok: response.ok,
      headers: response.headers,
      text: text || "",
      json,
      html: isHtml(text),
    }
  } catch (err) {
    if (controller.signal.aborted) {
      throw new PlatformError(
        `请求超时（${Math.round(timeout / 1000)} 秒）：${hostOf(url)}`,
        { kind: "timeout", retryable: true },
      )
    }
    throw new PlatformError(networkMessage(err, url), {
      kind: "network",
      retryable: true,
      detail: err,
    })
  } finally {
    clearTimeout(timer)
  }
}

/** The message a JSON response carries, in whichever field the site uses. */
export function messageOf(body) {
  const r = record(body)
  if (!r) return typeof body === "string" ? body.trim().slice(0, 300) : ""
  const candidates = [
    r.message,
    r.msg,
    r.error,
    r.reason,
    r.detail,
    r.data?.message,
    r.data?.msg,
    r.error?.message,
  ]
  for (const value of candidates) {
    const text = nonEmptyString(value)
    if (text) return text.slice(0, 300)
  }
  return ""
}

/** `data` of an envelope, or the body itself when it is the payload. */
export function dataOf(body) {
  const r = record(body)
  if (!r) return null
  const data = record(r.data)
  if (data) return data
  return r
}

/** A short, user-facing description of a non-JSON response. */
export function describeBadBody(res, siteLabel = hostOf(res.url)) {
  if (res.html) {
    return new PlatformError(
      `${siteLabel} 返回了网页而不是 JSON：可能被 Cloudflare/防火墙拦截，或地址填错`,
      { kind: "blocked", status: res.status, retryable: false },
    )
  }
  const sample = nonEmptyString(res.text).slice(0, 160)
  return new PlatformError(
    `${siteLabel} 返回了无法解析的响应（HTTP ${res.status}${sample ? `：${sample}` : ""}）`,
    { kind: "server", status: res.status, retryable: res.status >= 500 },
  )
}

export function nowStamp() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, "0")
  return {
    month: `${d.getFullYear()}-${pad(d.getMonth() + 1)}`,
    day: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
  }
}

export function timeZoneName() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai"
  } catch {
    return "Asia/Shanghai"
  }
}
