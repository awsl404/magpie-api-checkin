// The custom endpoint adapter: one user-configured HTTP request whose URL,
// method, headers and body come from the sign-in answers, interpreted into
// Magpie's auth.checkin result. It is the escape hatch for sites whose
// check-in path or payload is not one of the built-in shapes.
//
// A successful custom check-in can also read a balance endpoint, and the
// sign-in may have detected a new-api/sub2api site for the account name and
// balance while still using the custom check-in press.

import {
  PlatformError,
  isRecord,
  messageOf,
  nonEmptyString,
  record,
  request,
} from "./http.mjs"
import { buildCustomRequest } from "./config.mjs"
import {
  isAlreadyCheckedMessage,
  isAuthMessage,
  isCaptchaMessage,
  isDisabledMessage,
  isMissingUserIdMessage,
  isPermissionMessage,
  isRateLimitedMessage,
  keywordHit,
} from "./messages.mjs"
import { captcha, claimed, done, failed, ineligible, inactive } from "./results.mjs"
import { balanceOf, creditOf, streakOf } from "./values.mjs"

export { PlatformError }

function transportHint(error) {
  if (error instanceof PlatformError) {
    if (error.kind === "auth") return `访问令牌已失效，请重新登录：${error.message}`
    return error.message
  }
  return String(error?.message ?? error)
}

function jsonText(body) {
  try {
    return JSON.stringify(body) ?? ""
  } catch {
    return ""
  }
}

const ALREADY_FIELDS = [
  "already_checked",
  "alreadyChecked",
  "checked_in_today",
  "today_checked_in",
  "signed_today",
  "signedToday",
  "already",
  "is_checked_in",
  "isCheckedIn",
]

/** Whether a JSON body says today's check-in is already done. */
export function saysAlready(body) {
  const seen = new Set()
  const walk = (value, depth) => {
    if (depth < 0) return false
    const row = record(value)
    if (!row || seen.has(row)) return false
    seen.add(row)
    for (const key of ALREADY_FIELDS) {
      const value = row[key]
      if (value === true || value === 1 || value === "1" || value === "true") return true
    }
    // sub2api answers data.new_reward === false when today was already done.
    if (row.new_reward === false) return true
    for (const child of Object.values(row)) {
      // Deliberately not arrays: a past record inside records[] saying
      // checked_in_today must not turn today's claim into "done".
      if (isRecord(child) && walk(child, depth - 1)) return true
    }
    return false
  }
  return walk(body, 3)
}

/** The common {success}/{code}/{status}/{error} envelopes, read generically. */
export function genericVerdict(body) {
  if (!isRecord(body)) return ""
  if (saysAlready(body)) return "done"

  for (const key of ["success", "ok"]) {
    if (body[key] === true) return "claimed"
    if (body[key] === false) return "failed"
  }

  const rawCode = body.code ?? body.statusCode ?? body.errcode ?? body.ret
  if (rawCode !== undefined && rawCode !== null && rawCode !== "") {
    const numeric = typeof rawCode === "number" ? rawCode : Number(String(rawCode).trim())
    if (Number.isFinite(numeric)) {
      // 0 is the usual business success; 200-299 covers HTTP-shaped codes.
      return numeric === 0 || (numeric >= 200 && numeric < 300) ? "claimed" : "failed"
    }
  }

  if (typeof body.status === "string") {
    const status = body.status.trim().toLowerCase()
    if (["success", "ok", "okay", "done", "true"].includes(status)) return "claimed"
    if (["error", "fail", "failed", "false"].includes(status)) return "failed"
  }

  if (typeof body.error === "string" && body.error.trim()) return "failed"
  if (isRecord(body.error) && Object.keys(body.error).length) return "failed"
  return ""
}

/**
 * A custom check-in answer as Magpie's result shape. Configured keywords win
 * over the generic envelope; a dead token, captcha, disabled check-in and
 * permission refusal are still recognised from their usual wording.
 */
export function interpretCustom(res, custom) {
  const message = messageOf(res.json)
  const text = String(res.text || "")
  // In a JSON answer the envelope's message is the verdict; old records in
  // data could otherwise say "已签到" while today's press just claimed.
  const prose = res.json === undefined ? `${message}\n${text}` : message
  const hay = `${prose}\n${jsonText(res.json)}`
  const credit = creditOf(res.json, custom.creditField, custom.creditDivisor)
  const streak = streakOf(res.json, custom.streakField)

  if (
    saysAlready(res.json) ||
    keywordHit(hay, custom.already) ||
    isAlreadyCheckedMessage(prose)
  ) {
    return done(message || "今日已签到", credit, streak)
  }
  if (isCaptchaMessage(prose)) {
    return captcha(message || "站点要求人机校验，请在站点页面手动签到")
  }
  if (isDisabledMessage(prose)) return inactive(message || "站点未开启签到功能")
  if (isMissingUserIdMessage(prose)) {
    return failed("该站点要求提供用户 ID：请重新登录并填写「用户 ID」，或把 ID 写进自定义请求头")
  }
  if (isPermissionMessage(prose) || (res.status === 403 && isPermissionMessage(hay))) {
    return ineligible(message || "该账号不能参与签到")
  }
  if (res.status === 401 || isAuthMessage(prose)) {
    return failed(`访问令牌已失效，请重新登录${message ? `：${message}` : ""}`)
  }
  if (res.status === 429 || isRateLimitedMessage(prose)) {
    return failed(message || "站点限流，稍后再试")
  }

  if (custom.success && keywordHit(hay, custom.success)) {
    return claimed(message || "签到成功", credit, streak)
  }

  if (res.status === 404 || res.status === 405) {
    return failed(
      `自定义签到接口不存在（HTTP ${res.status}）：请重新登录并检查「签到接口地址」是否正确`,
    )
  }
  if (res.status === 403) {
    return failed(`站点拒绝了签到（HTTP 403）${message ? `：${message}` : ""}`)
  }
  if (res.status >= 500) {
    return failed(`站点服务器错误（HTTP ${res.status}）${message ? `：${message}` : ""}`)
  }

  if (res.json === undefined) {
    if (res.html) {
      return failed("站点返回了网页而不是 JSON：可能被 Cloudflare 拦截，请先在浏览器打开站点通过验证")
    }
    if (res.ok) {
      return claimed(message || nonEmptyString(text).slice(0, 200) || "签到成功", credit, streak)
    }
    return failed(message || `签到失败（HTTP ${res.status}）`)
  }
  const verdict = genericVerdict(record(res.json))
  if (verdict === "done") return done(message || "今日已签到", credit, streak)
  if (verdict === "failed") return failed(message || `签到失败（HTTP ${res.status}）`)
  if (verdict === "claimed" || res.ok) return claimed(message || "签到成功", credit, streak)
  return failed(message || `签到失败（HTTP ${res.status}）`)
}

/** One custom check-in press. */
export async function customCheckin(account) {
  const custom = account.custom
  if (!custom?.url) {
    return failed("账号没有自定义签到配置：请重新登录并填写「签到接口地址」")
  }

  let spec
  try {
    spec = buildCustomRequest(account, custom)
  } catch (error) {
    return failed(error.message)
  }

  let res
  try {
    res = await request(spec.url, {
      method: spec.method,
      headers: spec.headers,
      body: spec.body,
      timeout: 15_000,
      fetchImpl: account.fetchImpl,
    })
  } catch (error) {
    return failed(transportHint(error))
  }
  return interpretCustom(res, custom)
}

export function baseCustomProfile(account) {
  return {
    platform: "custom",
    userId: account.userId,
    username: nonEmptyString(account.username),
    email: "",
    siteName: nonEmptyString(account.siteName),
    quotaPerUnit: 1,
    balance: undefined,
    checkinEnabled: undefined,
  }
}

/** The account's balance from its optional custom balance endpoint. */
export async function customProfile(account) {
  const profile = baseCustomProfile(account)
  const custom = account.custom
  if (!custom?.balanceUrl) return profile

  let spec
  try {
    spec = buildCustomRequest(account, custom, {
      method: "GET",
      url: custom.balanceUrl,
      body: "",
    })
  } catch (error) {
    throw new PlatformError(error.message, { kind: "unsupported" })
  }

  const res = await request(spec.url, {
    method: "GET",
    headers: spec.headers,
    timeout: 10_000,
    fetchImpl: account.fetchImpl,
  })
  if (res.status === 401 || res.status === 403) {
    throw new PlatformError(`访问令牌被站点拒绝（HTTP ${res.status}）`, {
      kind: "auth",
      status: res.status,
    })
  }
  if (!res.ok || res.json === undefined) {
    const why = messageOf(res.json) || nonEmptyString(res.text).slice(0, 160)
    throw new PlatformError(
      `余额接口没有返回 JSON（HTTP ${res.status}${why ? `：${why}` : ""}）`,
      { kind: "server", status: res.status },
    )
  }

  profile.balance = balanceOf(res.json, custom.balanceField, custom.balanceDivisor)
  const body = record(res.json)
  const code = body?.code
  if (code === 401 || code === 403 || code === "401" || code === "403") {
    throw new PlatformError(`访问令牌被站点拒绝（HTTP 200，code ${code}）`, {
      kind: "auth",
      status: res.status,
    })
  }
  const site = nonEmptyString(body?.data?.system_name) || nonEmptyString(body?.system_name)
  if (site) profile.siteName = site
  return profile
}
