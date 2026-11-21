// Login-style check-in. Some New API forks give up on a dedicated
// /api/user/checkin route and instead award the daily quota as a side effect
// of a password login: the login reply carries `checked_in: true` and the
// frontend only shows "签到成功" after a login. Re-logging in is the check-in.
//
// This adapter performs that password login (username or e-mail both work on
// those forks) and reads the flag, so the account can be checked in without a
// browser session.

import {
  PlatformError,
  dataOf,
  finiteNumber,
  hostOf,
  messageOf,
  nonEmptyString,
  record,
  request,
} from "./http.mjs"
import { newApiHeaders } from "./auth.mjs"
import { isCaptchaMessage } from "./messages.mjs"
import { captcha, claimed, done, failed, ineligible } from "./results.mjs"
import { round2, streakOf } from "./values.mjs"

const LOGIN_PATH = "/api/user/login"

// A login refused because the account itself is out of service: the site's
// banned/suspended wording, which is not the same as a wrong password. Sites
// routinely fuse both cases into one sentence ("用户名或密码错误，或用户已被封禁"),
// so a message that also names the password is read as bad credentials.
const BANNED = /封禁|禁用|已停用|被封|banned|suspended|disabled account/i
const BAD_CREDENTIALS = /密码错误|用户名或密码|密码不正确|凭据|invalid credential|incorrect password|wrong password/i

function isBannedMessage(text) {
  const message = String(text || "")
  return BANNED.test(message) && !BAD_CREDENTIALS.test(message)
}

function send(account, path, options = {}) {
  return request(`${account.baseUrl}${path}`, {
    ...options,
    fetchImpl: account.fetchImpl,
  })
}

/** Whether the site asks for a Turnstile token before it accepts a login. */
export async function loginSiteStatus(account) {
  try {
    const res = await send(account, "/api/status", {
      headers: { Accept: "application/json" },
      timeout: 8_000,
    })
    const body = record(res.json)
    if (!res.ok || !body) return null
    const data = record(body.data) || body
    return {
      siteName: nonEmptyString(data.system_name),
      quotaPerUnit: finiteNumber(data.quota_per_unit),
      turnstile: data.turnstile_check === true,
    }
  } catch {
    // A missing status endpoint says nothing about the login below.
    return null
  }
}

/** The quota before the login, so the award can be reported in USD. */
async function quotaBefore(account) {
  if (!account.token) return undefined
  try {
    const res = await send(account, "/api/user/self", {
      headers: newApiHeaders(account.token, account.userId),
      timeout: 8_000,
    })
    const body = record(res.json)
    if (!res.ok || !body) return undefined
    const data = record(dataOf(body))
    return finiteNumber(data?.quota)
  } catch {
    return undefined
  }
}

/**
 * One password login. Returns a plain outcome object instead of throwing on a
 * business failure, because the caller distinguishes "wrong password" from
 * "captcha" from "disabled account".
 */
export async function loginOnce(account) {
  const username = nonEmptyString(account?.username)
  const password = nonEmptyString(account?.password)
  if (!username || !password) {
    throw new PlatformError("登录式签到缺少用户名或密码", { kind: "unsupported" })
  }
  if (!account.baseUrl) {
    throw new PlatformError("账号缺少站点地址，请重新登录", { kind: "unsupported" })
  }

  const res = await send(account, LOGIN_PATH, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ username, password }),
    timeout: 15_000,
  })

  const body = record(res.json)
  if (!body) {
    const text = nonEmptyString(res.text)
    const message = res.html
      ? "站点返回了网页而不是 JSON：可能被 Cloudflare 拦截，请先在浏览器打开站点通过验证"
      : `站点返回了无法解析的响应（HTTP ${res.status}${text ? `：${text.slice(0, 120)}` : ""}）`
    return { ok: false, res, message }
  }

  const message = messageOf(body) || ""
  const data = record(dataOf(body)) || record(body.user)
  if (body.success === false || !data) {
    return {
      ok: false,
      res,
      message: message || `登录失败（HTTP ${res.status}）`,
    }
  }

  return {
    ok: true,
    res,
    data,
    message,
    token: nonEmptyString(data.access_token),
    checkedIn: data.checked_in === true,
  }
}

/**
 * Sign-in-time probe for a login-style account: one password login, then a
 * profile-shaped result (user id, name, site name, quota) that authorize() can
 * store. It also refreshes the stored token when the site issues a new one.
 */
export async function loginProfile(account) {
  const status = await loginSiteStatus(account)
  if (status?.turnstile) {
    throw new PlatformError(
      `站点开启了 Turnstile 人机验证，无法用密码自动登录：请在浏览器手动登录 ${hostOf(account.baseUrl)} 并在设置中关闭验证`,
      { kind: "blocked" },
    )
  }
  const result = await loginOnce({
    baseUrl: account.baseUrl,
    username: account.username,
    password: account.password,
    fetchImpl: account.fetchImpl,
  })
  if (!result.ok) {
    throw new PlatformError(`登录失败：${result.message}`, { kind: "auth" })
  }
  const data = result.data
  const perUnit = finiteNumber(status?.quotaPerUnit) || 500_000
  const quota = finiteNumber(data.quota)
  return {
    token: result.token,
    profile: {
      platform: "new-api",
      userId: finiteNumber(data.id),
      username:
        nonEmptyString(data.username) ||
        nonEmptyString(data.display_name) ||
        nonEmptyString(data.email) ||
        nonEmptyString(account.username),
      email: nonEmptyString(data.email),
      siteName: status?.siteName || "",
      quotaPerUnit: perUnit,
      balance: quota === undefined ? undefined : round2(quota / perUnit),
    },
  }
}

/**
 * The daily check-in for a login-style site: log in, then read whether that
 * login earned today's quota. Magpie's auth.checkin hook receives the outcome.
 */
export async function loginCheckin(account) {
  const login = record(account.loginCheckin) || {}
  const status = await loginSiteStatus(account)
  if (status?.turnstile) {
    return captcha(
      `站点开启了 Turnstile 人机验证，无法自动登录签到：请在浏览器手动登录 ${hostOf(account.baseUrl)}`,
    )
  }

  const before = await quotaBefore(account)
  const result = await loginOnce({
    baseUrl: account.baseUrl,
    username: login.username,
    password: login.password,
    fetchImpl: account.fetchImpl,
  })

  if (!result.ok) {
    if (isCaptchaMessage(result.message)) return captcha(`站点要求人机验证：${result.message}`)
    if (isBannedMessage(result.message)) return ineligible(`账号被站点封禁：${result.message}`)
    return failed(`登录失败：${result.message}`)
  }

  const data = result.data
  const perUnit = account.quotaPerUnit || 500_000
  const after = finiteNumber(data.quota)
  const streak = streakOf(data)
  // A fork that rotates access tokens would silently break the account's
  // stored credential; say so instead of failing on the next run.
  const rotated = Boolean(result.token && account.token && result.token !== account.token)
  const note = rotated ? "；站点下发了新的访问令牌，请重新添加该账号以更新令牌" : ""

  if (!result.checkedIn) {
    return done(`今日已签到（重新登录没有再发放额度）${note}`)
  }

  let credit = 0
  if (before !== undefined && after !== undefined && after > before) {
    credit = round2((after - before) / perUnit)
  }
  const head =
    credit > 0 ? `签到成功，新增额度 ${credit} USD 已到账` : "签到成功，新增额度已到账"
  return claimed(`${head}${note}`, credit, streak)
}
