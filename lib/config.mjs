// Custom endpoint configuration: parsing the header/body templates a user
// typed at sign-in, validating them, filling placeholders at request time,
// and building one HTTP request.

import {
  hostOf,
  isRecord,
  nonEmptyString,
  nowStamp,
  record,
} from "./http.mjs"
import { looseNumber } from "./values.mjs"

export const CUSTOM_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"]
export const DEFAULT_CUSTOM_METHOD = "POST"

export function isValidCustomMethod(value) {
  return CUSTOM_METHODS.includes(String(value || "").toUpperCase())
}

function headerObject(input) {
  const out = {}
  for (const [name, value] of Object.entries(input)) {
    if (value === null || value === undefined) continue
    out[name] = String(value)
  }
  return out
}

/**
 * Headers from what a user can paste in one line: a JSON object, "Key: Value"
 * lines (newlines or semicolons between them), or a raw Cookie string.
 */
export function parseHeaderInput(input) {
  if (input === null || input === undefined) return {}
  if (isRecord(input)) return headerObject(input)
  const raw = String(input).trim()
  if (!raw) return {}
  if (raw.startsWith("{")) {
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      throw new Error(`请求头不是有效的 JSON：${error.message}`)
    }
    if (!isRecord(parsed)) throw new Error("请求头 JSON 必须是一个对象")
    return headerObject(parsed)
  }
  // A raw cookie string such as "session=abc; acw_tc=1" is the header people
  // paste most often.
  if (!raw.includes(":") && raw.includes("=")) return { Cookie: raw }

  const parts = []
  for (const line of raw.split(/\r?\n/).map((part) => part.trim()).filter(Boolean)) {
    const namedCookie = /^cookie\s*:/i.test(line)
    const segments = line.split(";").map((part) => part.trim()).filter(Boolean)
    if (!namedCookie && segments.length > 1 && segments.every((part) => part.includes(":"))) {
      parts.push(...segments)
    } else {
      parts.push(line)
    }
  }

  const out = {}
  for (const part of parts) {
    const at = part.indexOf(":")
    if (at <= 0) throw new Error(`请求头「${part}」的格式应为 Key: Value`)
    const name = part.slice(0, at).trim()
    const value = part.slice(at + 1).trim()
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) {
      throw new Error(`请求头名称「${name}」含有不允许的字符`)
    }
    out[name] = value
  }
  return out
}

export function parseHeaderInputLenient(input) {
  try {
    return parseHeaderInput(input)
  } catch {
    return {}
  }
}

function positiveNumber(value, fallback = 1) {
  const n = looseNumber(value)
  return n === undefined || n <= 0 ? fallback : n
}

function textOf(value) {
  return typeof value === "string" ? value : ""
}

function looksJson(text) {
  const trimmed = String(text || "").trim()
  return trimmed.startsWith("{") || trimmed.startsWith("[")
}

function looksForm(text) {
  const trimmed = String(text || "").trim()
  return !trimmed.includes("\n") && /^[^=&\s]+=/.test(trimmed)
}

/**
 * A saved custom configuration, read leniently: a bad saved header list is
 * dropped rather than making every hook throw.
 */
export function normalizeCustomConfig(metadata) {
  const md = record(metadata) || {}
  const raw = record(md.custom) || {}
  const methodRaw = raw.method ?? md.customMethod
  const headersRaw = raw.headers !== undefined ? raw.headers : md.customHeaders
  const headers = isRecord(headersRaw)
    ? headerObject(headersRaw)
    : parseHeaderInputLenient(headersRaw)

  return {
    method: isValidCustomMethod(methodRaw) ? String(methodRaw).toUpperCase() : DEFAULT_CUSTOM_METHOD,
    url: nonEmptyString(raw.url) || nonEmptyString(md.customUrl),
    headers,
    body: textOf(raw.body) !== "" ? textOf(raw.body) : textOf(md.customBody),
    success: nonEmptyString(raw.success) || nonEmptyString(md.customSuccess),
    already: nonEmptyString(raw.already) || nonEmptyString(md.customAlready),
    creditField: nonEmptyString(raw.creditField) || nonEmptyString(md.customCreditField),
    creditDivisor: positiveNumber(raw.creditDivisor ?? md.customCreditDivisor),
    streakField: nonEmptyString(raw.streakField) || nonEmptyString(md.customStreakField),
    balanceUrl: nonEmptyString(raw.balanceUrl) || nonEmptyString(md.customBalanceUrl),
    balanceField: nonEmptyString(raw.balanceField) || nonEmptyString(md.customBalanceField),
    balanceDivisor: positiveNumber(raw.balanceDivisor ?? md.customBalanceDivisor),
    noToken: raw.noToken === true || md.customNoToken === true,
  }
}

function checkUrlShape(url, label) {
  if (/\s/.test(url)) throw new Error(`${label}不能包含空格`)
  if (url === "?" || url === "#") throw new Error(`${label}不完整`)
}

function divisorError(value, label) {
  if (value === undefined || value === null || String(value).trim() === "") return
  const n = looseNumber(value)
  if (n === undefined || n <= 0) throw new Error(`${label}必须是大于 0 的数字`)
}

function probeVars(token) {
  return {
    token: token || "token",
    bearer: token ? `Bearer ${token}` : "Bearer token",
    cookie: "session=probe",
    userid: "1",
    username: "probe",
    apikey: "sk-probe",
    baseurl: "https://example.com",
    host: "example.com",
    label: "probe",
    date: "2026-01-01",
    month: "2026-01",
    timestamp: "0",
    iso: "2026-01-01T00:00:00.000Z",
  }
}

/**
 * The sign-in questions checked and turned into the metadata's `custom`
 * object. Throws a message fit for the sign-in dialog.
 */
export function validateCustomConfig(inputs = {}, { token = "" } = {}) {
  if (inputs.customMethod && !isValidCustomMethod(inputs.customMethod)) {
    throw new Error(`未知的自定义请求方法：${inputs.customMethod}`)
  }
  divisorError(inputs.customCreditDivisor, "奖励换算除数")
  divisorError(inputs.customBalanceDivisor, "余额换算除数")

  // Parse strictly first: a malformed header list is worth telling the user
  // about, while hooks must never throw over a saved one.
  parseHeaderInput(inputs.customHeaders)

  const config = normalizeCustomConfig({
    custom: {
      method: inputs.customMethod,
      url: inputs.customUrl,
      headers: inputs.customHeaders,
      body: inputs.customBody,
      success: inputs.customSuccess,
      already: inputs.customAlready,
      creditField: inputs.customCreditField,
      creditDivisor: inputs.customCreditDivisor,
      streakField: inputs.customStreakField,
      balanceUrl: inputs.customBalanceUrl,
      balanceField: inputs.customBalanceField,
      balanceDivisor: inputs.customBalanceDivisor,
      noToken: !token,
    },
  })

  if (!config.url) throw new Error("自定义接口需要填写「签到接口地址」")
  checkUrlShape(config.url, "签到接口地址")
  if (config.balanceUrl) checkUrlShape(config.balanceUrl, "余额接口地址")
  if ((config.method === "GET" || config.method === "HEAD") && config.body.trim()) {
    throw new Error(`${config.method} 请求不会携带请求体，请改用 POST / PUT / PATCH`)
  }
  if (config.body.trim() && looksJson(config.body)) {
    try {
      JSON.parse(fillPlaceholders(config.body, probeVars(token)))
    } catch (error) {
      throw new Error(`请求体不是有效的 JSON：${error.message}`)
    }
  }
  return config
}

/** Everything a template may say about the account, keyed in lower case. */
export function placeholderVars(account) {
  const stamp = nowStamp()
  const token = String(account?.token || "")
  const cookie = account?.cookie === true
  return {
    token,
    bearer: token ? (cookie ? token : `Bearer ${token}`) : "",
    cookie: cookie ? token : "",
    userid: account?.userId ? String(account.userId) : "",
    username: nonEmptyString(account?.username),
    apikey: nonEmptyString(account?.apiKey),
    baseurl: nonEmptyString(account?.baseUrl),
    host: hostOf(account?.baseUrl || ""),
    label: nonEmptyString(account?.label),
    date: stamp.day,
    month: stamp.month,
    timestamp: String(Date.now()),
    iso: new Date().toISOString(),
  }
}

/** Replaces known {name} placeholders; unknown braces (JSON) stay as typed. */
export function fillPlaceholders(text, vars) {
  return String(text ?? "").replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (whole, key) => {
    const name = key.toLowerCase()
    return Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name] ?? "") : whole
  })
}

export function setHeader(headers, name, value) {
  const lower = name.toLowerCase()
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) delete headers[key]
  }
  headers[name] = String(value)
}

function hasHeader(headers, name) {
  const lower = name.toLowerCase()
  return Object.keys(headers).some((key) => key.toLowerCase() === lower)
}

export function endpointFrom(baseUrl, template, vars) {
  const filled = fillPlaceholders(template, vars).trim()
  if (!filled) throw new Error("请求地址是空的")
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(filled)) return filled
  const base = String(baseUrl || "").replace(/\/+$/, "")
  if (!base) throw new Error("账号缺少站点地址，请重新登录")
  return `${base}${filled.startsWith("/") ? "" : "/"}${filled}`
}

/**
 * One request from the saved configuration. `overrides` lets the balance
 * read reuse the same headers with its own URL and method.
 */
export function buildCustomRequest(account, config, overrides = {}) {
  const vars = placeholderVars(account)
  const method = String(overrides.method || config.method || DEFAULT_CUSTOM_METHOD).toUpperCase()
  const url = endpointFrom(account.baseUrl, overrides.url || config.url, vars)

  const explicit = {}
  for (const [name, value] of Object.entries(config.headers || {})) {
    setHeader(explicit, name, fillPlaceholders(value, vars))
  }

  const headers = {}
  setHeader(headers, "Accept", "application/json")
  const hasOwnAuth =
    hasHeader(explicit, "authorization") ||
    hasHeader(explicit, "cookie") ||
    hasHeader(explicit, "x-api-key")
  if (account.token && !hasOwnAuth) {
    if (account.cookie) setHeader(headers, "Cookie", account.token)
    else setHeader(headers, "Authorization", `Bearer ${account.token}`)
  }
  for (const [name, value] of Object.entries(explicit)) setHeader(headers, name, value)

  let body
  if (method !== "GET" && method !== "HEAD") {
    const filled = fillPlaceholders(overrides.body ?? config.body ?? "", vars).trim()
    if (filled) {
      body = filled
      if (!hasHeader(headers, "content-type")) {
        if (looksJson(filled)) setHeader(headers, "Content-Type", "application/json")
        else if (looksForm(filled)) setHeader(headers, "Content-Type", "application/x-www-form-urlencoded")
        else setHeader(headers, "Content-Type", "text/plain; charset=utf-8")
      }
    }
  }

  return { url, method, headers, body }
}
