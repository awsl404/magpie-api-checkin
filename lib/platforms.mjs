// Platform adapters: new-api / one-api (and forks) and sub2api (generic and
// Pro). Each turns a site's check-in, status and balance endpoints into the
// shapes Magpie's auth.usage and auth.checkin hooks want.

import {
  PlatformError,
  dataOf,
  describeBadBody,
  finiteNumber,
  hostOf,
  messageOf,
  nonEmptyString,
  nowStamp,
  record,
  request,
  timeZoneName,
} from "./http.mjs"
import { headersFor, jwtExpired, round2, sub2ApiHeaders } from "./auth.mjs"
import {
  isAlreadyCheckedMessage,
  isAuthMessage,
  isCaptchaMessage,
  isDisabledMessage,
  isMissingUserIdMessage,
  isPermissionMessage,
  isRateLimitedMessage,
} from "./messages.mjs"
import { captcha, claimed, done, failed, ineligible, inactive } from "./results.mjs"
import { customCheckin, customProfile } from "./custom.mjs"
import { shiftDay, streakFromRecords, streakOf } from "./values.mjs"

export { PlatformError }

/* --------------------------------------------------------------- HTTP helpers */

function transportHint(error) {
  if (error instanceof PlatformError) {
    if (error.kind === "auth") return `访问令牌已失效，请重新登录：${error.message}`
    return error.message
  }
  return String(error?.message ?? error)
}

async function call(account, path, options = {}) {
  return request(`${account.baseUrl}${path}`, {
    ...options,
    fetchImpl: account.fetchImpl,
  })
}

function authMessageOf(res) {
  return messageOf(res.json) || (res.html ? "" : nonEmptyString(res.text).slice(0, 200))
}

function authFailure(res) {
  const why = authMessageOf(res)
  return new PlatformError(
    why ? `访问令牌被站点拒绝（HTTP ${res.status}）：${why}` : `访问令牌被站点拒绝（HTTP ${res.status}）`,
    { kind: "auth", status: res.status },
  )
}

function missingUserIdFailure() {
  return new PlatformError(
    "该站点要求提供用户 ID（New-API-User）：请重新登录，并在「用户 ID」一栏填写站点控制台里的用户 ID",
    { kind: "unsupported" },
  )
}

/* ------------------------------------------------------------------ new-api */

async function newApiPublicStatus(account) {
  let res
  try {
    res = await call(account, "/api/status", {
      headers: { Accept: "application/json" },
      timeout: 8_000,
    })
  } catch {
    return null
  }
  const body = record(res.json)
  if (!res.ok || !body) return null
  const data = record(body.data) || body
  const siteName = nonEmptyString(data.system_name)
  if (body.success !== true && !siteName) return null
  return {
    siteName,
    version: nonEmptyString(data.version),
    quotaPerUnit: finiteNumber(data.quota_per_unit),
    checkinEnabled: typeof data.checkin_enabled === "boolean" ? data.checkin_enabled : undefined,
    turnstile: data.turnstile_check === true,
  }
}

async function newApiSelf(account) {
  const res = await call(account, "/api/user/self", {
    headers: headersFor("new-api", account.token, account.userId),
    timeout: 10_000,
  })
  const why = authMessageOf(res)
  if (res.status === 404 || res.status === 405) {
    throw new PlatformError(
      `${hostOf(account.baseUrl)} 没有 /api/user/self：不像 new-api 站点`,
      { kind: "unsupported", status: res.status },
    )
  }
  if (isMissingUserIdMessage(why)) throw missingUserIdFailure()
  if (res.status === 401 || res.status === 403) throw authFailure(res)
  if (!res.json) throw describeBadBody(res, hostOf(account.baseUrl))
  const body = record(res.json)
  if (!body) throw describeBadBody(res, hostOf(account.baseUrl))
  if (body.success === false) {
    if (isPermissionMessage(why)) {
      throw new PlatformError(`站点拒绝读取账号信息：${why}`, { kind: "business", status: res.status })
    }
    throw new PlatformError(why || "站点没有返回用户信息", { kind: "auth", status: res.status })
  }
  const data = dataOf(body)
  if (!record(data) || finiteNumber(data.id) === undefined) {
    throw new PlatformError(
      `${hostOf(account.baseUrl)} 不像 new-api 站点（/api/user/self 没有返回用户信息）`,
      { kind: "unsupported" },
    )
  }
  return data
}

function newApiProfile(self, status) {
  const quotaPerUnit = status?.quotaPerUnit || 500_000
  const quota = finiteNumber(self.quota)
  return {
    platform: "new-api",
    userId: finiteNumber(self.id),
    username:
      nonEmptyString(self.username) ||
      nonEmptyString(self.display_name) ||
      nonEmptyString(self.email),
    email: nonEmptyString(self.email),
    siteName: status?.siteName || "",
    version: status?.version || "",
    quotaPerUnit,
    balance: quota === undefined ? undefined : quota / quotaPerUnit,
    checkinEnabled: status?.checkinEnabled,
  }
}

function newApiReward(data, quotaPerUnit) {
  const r = record(data)
  if (!r) return 0
  const quota =
    finiteNumber(r.quota_awarded) ??
    finiteNumber(r.today_quota_awarded) ??
    finiteNumber(r.quota_reward)
  if (quota === undefined || quota <= 0) return 0
  return round2(quota / (quotaPerUnit || 500_000))
}

function newApiRewardFromRecords(records, day, quotaPerUnit) {
  if (!Array.isArray(records)) return 0
  const row = records.find(
    (item) => record(item) && nonEmptyString(item.checkin_date).slice(0, 10) === day,
  )
  return row ? newApiReward(row, quotaPerUnit) : 0
}

function interpretNewApiCheckin(res, account, statusNote = "") {
  const why = authMessageOf(res)
  const note = statusNote ? `；状态查询：${statusNote}` : ""
  if (isMissingUserIdMessage(why)) {
    return failed("该站点要求提供用户 ID：请重新登录，并在「用户 ID」一栏填写站点控制台里的用户 ID")
  }
  if (res.status === 401) {
    return failed(`访问令牌已失效（HTTP 401）${why ? `：${why}` : ""}`)
  }
  if (res.status === 403) {
    // A site's 403 is not proof that the token is gone: forks use it for
    // admin-only routes, disabled features and permissions. Never label it
    // "token invalid" without the body saying so.
    if (isPermissionMessage(why)) {
      return ineligible(`站点拒绝了签到（HTTP 403）：${why}${note}`)
    }
    return failed(`站点拒绝了签到（HTTP 403）${why ? `：${why}` : ""}${note}`)
  }
  if (res.status === 404 || res.status === 405) {
    return inactive(`站点没有标准 /api/user/checkin 接口（可能是自定义签到路径）${note}`)
  }
  if (!res.json) {
    if (res.html) {
      return failed("站点返回了网页而不是 JSON：可能被 Cloudflare 拦截，请先在浏览器打开站点通过验证")
    }
    return failed(`站点返回了无法解析的响应（HTTP ${res.status}）`)
  }
  const body = record(res.json)
  const data = dataOf(body)
  const text = String(why || "").trim()
  const quotaPerUnit = account.quotaPerUnit
  const streak = streakOf(data)

  if (isAlreadyCheckedMessage(text)) {
    return done(text || "今日已签到", newApiReward(data, quotaPerUnit), streak)
  }
  if (body?.success === true) {
    return claimed(text || "签到成功", newApiReward(data, quotaPerUnit), streak)
  }
  if (isCaptchaMessage(text)) {
    return captcha(`站点要求 Turnstile 人机校验，请在站点页面手动签到${text ? `（${text}）` : ""}`)
  }
  if (isDisabledMessage(text)) return inactive(text)
  if (isPermissionMessage(text)) return ineligible(text)
  if (isAuthMessage(text) || jwtExpired(account.token)) {
    return failed(`访问令牌已失效，请重新登录${text ? `：${text}` : ""}`)
  }
  if (isRateLimitedMessage(text) || res.status === 429) return failed(text || "站点限流，稍后再试")
  if (res.status >= 500) return failed(`站点服务器错误（HTTP ${res.status}）${text ? `：${text}` : ""}`)
  return failed(text || `签到失败（HTTP ${res.status}）`)
}

async function checkinNewApi(account) {
  const headers = headersFor("new-api", account.token, account.userId)
  const status = await newApiPublicStatus(account)
  if (status?.checkinEnabled === false) return inactive("站点未开启签到功能")

  // A status read first keeps magpie from pressing a check-in twice, and some
  // forks already carry today's award in it.
  const stamp = nowStamp()
  let statusNote = ""
  let records = null
  let res
  try {
    res = await call(account, `/api/user/checkin?month=${stamp.month}`, { headers })
  } catch (error) {
    return failed(transportHint(error))
  }
  if (res.status === 401) {
    return failed(`访问令牌已失效（HTTP 401）${messageOf(res.json) ? `：${messageOf(res.json)}` : ""}`)
  }
  if (res.status === 403) {
    // Forks answer 403 for an admin-only route or a feature the account may
    // not use. The press below is still worth one try: if it is missing too,
    // the site simply has no standard check-in endpoint.
    statusNote = messageOf(res.json) || nonEmptyString(res.text).slice(0, 120) || "HTTP 403"
  } else if (res.status === 404 || res.status === 405) {
    statusNote = "状态接口不存在"
  } else if (res.json) {
    const body = record(res.json)
    if (body?.success === true && record(body.data)) {
      const data = body.data
      if (data.enabled === false) return inactive("站点未开启签到功能")
      const stats = record(data.stats) || {}
      records = Array.isArray(stats.records) ? stats.records : null
      const quotaPerUnit = status?.quotaPerUnit || account.quotaPerUnit
      const reward = newApiRewardFromRecords(records, stamp.day, quotaPerUnit)
      if (stats.checked_in_today === true) {
        return done("今日已签到", reward, streakFromRecords(records, stamp.day) || streakOf(data))
      }
    } else if (body?.success === false) {
      const why = messageOf(body)
      if (isMissingUserIdMessage(why)) {
        return failed("该站点要求提供用户 ID：请重新登录，并在「用户 ID」一栏填写站点控制台里的用户 ID")
      }
      if (isDisabledMessage(why)) return inactive(why)
      if (isAuthMessage(why)) return failed(`访问令牌已失效，请重新登录：${why}`)
      if (isPermissionMessage(why)) statusNote = why
    }
  }

  try {
    res = await call(account, "/api/user/checkin", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: "{}",
      timeout: 15_000,
    })
  } catch (error) {
    return failed(transportHint(error))
  }

  // Some new-api forks answer /api/user/sign_in instead, with a session
  // cookie. Only a cookie credential can reach it.
  if ((res.status === 404 || res.status === 405) && account.cookie) {
    try {
      res = await call(account, "/api/user/sign_in", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: "{}",
        timeout: 15_000,
      })
    } catch (error) {
      return failed(transportHint(error))
    }
  }
  const result = interpretNewApiCheckin(res, account, statusNote)
  if (result.outcome === "claimed" && result.streak === 0 && Array.isArray(records) && records.length) {
    result.streak = streakFromRecords(records, shiftDay(stamp.day, -1)) + 1
  }
  return result
}

/* ------------------------------------------------------------------ sub2api */

/**
 * The {code, message, data} envelope sub2api and its forks use, plus the
 * {success, data} shape some proxies put in front of it.
 */
export function sub2Envelope(body) {
  const r = record(body)
  if (!r) {
    return { ok: false, code: undefined, message: typeof body === "string" ? body.slice(0, 300) : "", reason: "", data: null }
  }
  const code = r.code
  const ok =
    r.success === true ||
    code === 0 ||
    code === 200 ||
    code === "0" ||
    code === "200"
  return {
    ok,
    code,
    message: messageOf(r),
    reason: nonEmptyString(r.reason),
    data: record(r.data) || (Array.isArray(r.data) ? r.data : null),
  }
}

async function sub2Me(account) {
  const res = await call(account, "/api/v1/auth/me", {
    headers: sub2ApiHeaders(account.token),
    timeout: 10_000,
  })
  if (res.status === 401 || res.status === 403) throw authFailure(res)
  if (!res.json) throw describeBadBody(res, hostOf(account.baseUrl))
  const env = sub2Envelope(res.json)
  if (!env.ok) {
    if (isAuthMessage(env.message)) throw authFailure(res)
    throw new PlatformError(
      `${hostOf(account.baseUrl)} 不像 sub2api 站点（/api/v1/auth/me：${env.message || `HTTP ${res.status}`}）`,
      { kind: "unsupported", status: res.status },
    )
  }
  const data = record(env.data)
  if (!data || finiteNumber(data.id) === undefined) {
    throw new PlatformError(
      `${hostOf(account.baseUrl)} 不像 sub2api 站点（/api/v1/auth/me 没有返回用户 id）`,
      { kind: "unsupported" },
    )
  }
  return data
}

function sub2Profile(me, platform) {
  return {
    platform,
    userId: finiteNumber(me.id),
    username: nonEmptyString(me.username) || nonEmptyString(me.email),
    email: nonEmptyString(me.email),
    siteName: "",
    quotaPerUnit: 500_000,
    balance: finiteNumber(me.balance),
    checkinEnabled: undefined,
  }
}

function sub2StatusPath(kind) {
  if (kind === "sub2api-pro") return "/api/v1/redeem/checkin/status"
  return `/api/v1/user/checkin/status?timezone=${encodeURIComponent(timeZoneName())}`
}

function sub2CheckinPath(kind) {
  return kind === "sub2api-pro" ? "/api/v1/redeem/checkin" : "/api/v1/user/checkin"
}

function sub2Reward(data) {
  const d = record(data)
  if (!d) return 0
  const amount =
    finiteNumber(d.reward_amount) ??
    finiteNumber(d.rewardAmount) ??
    finiteNumber(d.today_reward) ??
    finiteNumber(d.amount) ??
    finiteNumber(d.reward)
  return amount === undefined || amount <= 0 ? 0 : round2(amount)
}

function sub2Checked(data) {
  const d = record(data)
  if (!d) return undefined
  for (const key of [
    "checked_in_today",
    "today_checked_in",
    "signedToday",
    "signed_today",
    "alreadyChecked",
    "already_checked",
    "checked",
  ]) {
    if (typeof d[key] === "boolean") return d[key]
  }
  return undefined
}

function sub2Enabled(data) {
  const d = record(data)
  if (!d) return undefined
  if (typeof d.enabled === "boolean") return d.enabled
  const config = record(d.config)
  if (typeof config?.enabled === "boolean") return config.enabled
  return undefined
}

/**
 * Reads a sub2api-family status endpoint. null means "this deployment doesn't
 * expose that endpoint/it answered something else", not an error.
 */
async function sub2Status(account, kind) {
  let res
  try {
    res = await call(account, sub2StatusPath(kind), {
      headers: sub2ApiHeaders(account.token),
      timeout: 8_000,
    })
  } catch {
    return null
  }
  if (res.status === 401 || res.status === 403) throw authFailure(res)
  if (!res.json) return null
  const env = sub2Envelope(res.json)
  if (!env.ok) {
    if (isAuthMessage(env.message)) throw authFailure(res)
    return null
  }
  const data = record(env.data)
  if (!data) return null
  const enabled = sub2Enabled(data)
  const checked = sub2Checked(data)
  if (enabled === undefined && checked === undefined) return null
  return {
    matched: true,
    enabled: enabled !== false,
    checked: checked === true,
    reward: sub2Reward(data),
    streak: streakOf(data),
    message: env.message,
  }
}

async function detectSub2Variant(account) {
  try {
    const pro = await sub2Status(account, "sub2api-pro")
    if (pro?.matched) return "sub2api-pro"
  } catch {
    // A status route refusing the token says nothing about the variant; the
    // sign-in itself was already read.
  }
  return "sub2api"
}

function interpretSub2Checkin(res, kind) {
  const env = res.json ? sub2Envelope(res.json) : null
  const reason = env?.reason || ""
  const why = env?.message || (res.html ? "" : nonEmptyString(res.text).slice(0, 200))
  const streak = streakOf(env?.data ?? res.json)

  if (reason === "DAILY_CHECKIN_ALREADY_DONE" || isAlreadyCheckedMessage(why)) {
    return done(why || "今日已签到", sub2Reward(env?.data), streak)
  }
  if (reason === "DAILY_CHECKIN_DISABLED" || isDisabledMessage(why)) {
    return inactive(why || "站点未开启签到功能")
  }
  if (reason === "DAILY_CHECKIN_ROLE_FORBIDDEN") return ineligible(why || "该账号不能参与签到")
  if (isPermissionMessage(why)) return ineligible(why)
  if (res.status === 401 || res.status === 403) {
    return failed(`访问令牌已失效或没有权限（HTTP ${res.status}）${why ? `：${why}` : ""}`)
  }
  if (res.status === 404 || res.status === 405) {
    return inactive("站点没有签到接口（该 sub2api 部署可能未开启签到）")
  }
  if (res.status === 409) return done(why || "今日已签到", sub2Reward(env?.data), streak)
  if (!res.json) {
    if (res.html) {
      return failed("站点返回了网页而不是 JSON：可能被 Cloudflare 拦截，请先在浏览器打开站点通过验证")
    }
    return failed(`站点返回了无法解析的响应（HTTP ${res.status}）`)
  }
  if (isAuthMessage(why)) return failed(`访问令牌已失效，请重新登录${why ? `：${why}` : ""}`)
  if (res.status === 429 || isRateLimitedMessage(why)) return failed(why || "站点限流，稍后再试")
  if (res.status >= 500) return failed(`站点服务器错误（HTTP ${res.status}）${why ? `：${why}` : ""}`)

  if (env?.ok) {
    const data = record(env.data)
    const reward = sub2Reward(data)
    if (data?.new_reward === false) return done("今日已签到", reward, streak)
    if (sub2Checked(data) === true && reward === 0) return done("今日已签到", 0, streak)
    if (reward > 0) return claimed(why || "签到成功", reward, streak)
    return claimed(why || "签到成功", 0, streak)
  }

  if (kind === "sub2api-pro" && env?.code === 409) {
    return done(why || "今日已签到", sub2Reward(env?.data), streak)
  }
  return failed(why || `签到失败（HTTP ${res.status}）`)
}

async function checkinSub2Api(account, kind) {
  let status = null
  try {
    status = await sub2Status(account, kind)
  } catch (error) {
    return failed(transportHint(error))
  }
  if (status?.matched) {
    if (!status.enabled) return inactive(status.message || "站点未开启签到功能")
    if (status.checked) return done("今日已签到", status.reward, status.streak)
  }

  let res
  try {
    res = await call(account, sub2CheckinPath(kind), {
      method: "POST",
      headers: sub2ApiHeaders(account.token),
      timeout: 15_000,
    })
  } catch (error) {
    return failed(transportHint(error))
  }
  return interpretSub2Checkin(res, kind)
}

/* -------------------------------------------------------- detection & profiles */

export async function detectPlatform(account) {
  const forced = account.platform && account.platform !== "auto" ? account.platform : ""

  if (forced === "new-api") {
    const [self, status] = await Promise.all([
      newApiSelf(account),
      newApiPublicStatus(account),
    ])
    return { platform: "new-api", profile: newApiProfile(self, status) }
  }
  if (forced === "sub2api" || forced === "sub2api-pro") {
    const me = await sub2Me(account)
    return { platform: forced, profile: sub2Profile(me, forced) }
  }

  let subError = null
  try {
    const me = await sub2Me(account)
    const platform = await detectSub2Variant(account)
    return { platform, profile: sub2Profile(me, platform) }
  } catch (error) {
    subError = error
  }

  let newError = null
  try {
    const [self, status] = await Promise.all([
      newApiSelf(account),
      newApiPublicStatus(account),
    ])
    return { platform: "new-api", profile: newApiProfile(self, status) }
  } catch (error) {
    newError = error
  }

  if (subError?.kind === "auth" && newError?.kind === "auth") {
    throw new PlatformError(`访问令牌被站点拒绝：${subError.message}`, { kind: "auth" })
  }
  const details = [subError, newError]
    .filter(Boolean)
    .map((error) => error.message)
    .filter(Boolean)
    .join("；")
  throw new PlatformError(
    `无法识别站点类型：请确认地址与访问令牌，重新登录时也可以手动指定站点类型。${details ? `（${details}）` : ""}`,
    { kind: "unsupported" },
  )
}

export async function resolvePlatform(account) {
  if (account.platform && account.platform !== "auto") return account.platform
  const { platform } = await detectPlatform(account)
  return platform
}

/** User info and balance, for login validation and auth.usage. */
async function profileVia(platform, account) {
  if (platform === "new-api") {
    const [self, status] = await Promise.all([
      newApiSelf(account),
      newApiPublicStatus(account),
    ])
    return newApiProfile(self, status)
  }
  const me = await sub2Me(account)
  return sub2Profile(me, platform)
}

export async function profileOf(account) {
  if (account.platform === "custom") {
    // An explicit balance endpoint wins; otherwise a detected new-api or
    // sub2api site still provides the balance and its site name.
    if (account.custom?.balanceUrl) return customProfile(account)
    if (account.detectedPlatform) return profileVia(account.detectedPlatform, account)
    return customProfile(account)
  }
  return profileVia(await resolvePlatform(account), account)
}

/** One daily check-in press, as Magpie's auth.checkin hook wants it. */
export async function checkinOf(account) {
  if (!account.baseUrl) return failed("账号缺少站点地址，请重新登录")
  if (account.platform === "custom") {
    try {
      return await customCheckin(account)
    } catch (error) {
      if (error instanceof PlatformError && error.kind === "auth") {
        return failed(`访问令牌已失效，请重新登录：${error.message}`)
      }
      return failed(transportHint(error))
    }
  }
  if (!account.token) return failed("账号缺少访问令牌，请重新登录")
  try {
    const platform = await resolvePlatform(account)
    if (platform === "new-api") return await checkinNewApi(account)
    if (platform === "sub2api-pro") return await checkinSub2Api(account, "sub2api-pro")
    return await checkinSub2Api(account, "sub2api")
  } catch (error) {
    if (error instanceof PlatformError && error.kind === "auth") {
      return failed(`访问令牌已失效，请重新登录：${error.message}`)
    }
    return failed(transportHint(error))
  }
}

/** Models a site lists for an sk- API key, for provider.models. */
export async function listModelIds(account) {
  if (!account.apiKey) return null
  const res = await call(account, "/v1/models", {
    headers: { Authorization: `Bearer ${account.apiKey}`, Accept: "application/json" },
    timeout: 12_000,
  })
  if (!res.ok || !res.json) {
    throw new PlatformError(
      `${hostOf(account.baseUrl)} 的 /v1/models 没有返回模型列表（HTTP ${res.status}）`,
      { kind: "server", status: res.status },
    )
  }
  const rows = Array.isArray(res.json.data)
    ? res.json.data
    : Array.isArray(res.json.models)
      ? res.json.models
      : Array.isArray(res.json)
        ? res.json
        : []
  const ids = []
  for (const row of rows) {
    const entry = typeof row === "string" ? { id: row } : record(row)
    const id = nonEmptyString(entry?.id) || nonEmptyString(entry?.name) || nonEmptyString(entry?.model)
    if (id && !ids.includes(id)) ids.push(id)
  }
  return ids
}
