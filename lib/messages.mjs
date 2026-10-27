// Message classifiers: the phrases sites use for "already checked in", a
// captcha, a disabled feature, a permission refusal, a dead token, and rate
// limiting. Shared by the built-in platform adapters and custom endpoints.

const ALREADY = [
  "今日已签到",
  "今天已签到",
  "今天已经签到",
  "今日已经签到",
  "已经签到",
  "已签到",
  "签到过",
  "重复签到",
  "already checked in",
  "already signed",
  "already sign in",
  "already check",
]

const CAPTCHA = [
  "turnstile",
  "captcha",
  "人机验证",
  "验证码",
  "challenge required",
]

const DISABLED = [
  "checkin disabled",
  "check-in disabled",
  "checkin is disabled",
  "check-in is disabled",
  "checkin closed",
  "check-in closed",
  "checkin unavailable",
  "check-in unavailable",
  "check-in is not enabled",
  "checkin is not enabled",
  "签到已关闭",
  "签到未开放",
  "暂未开放签到",
  "未开启签到",
  "签到功能已停用",
  "签到功能已关闭",
  "未提供签到",
]

const PERMISSION = [
  "forbidden",
  "permission denied",
  "insufficient privilege",
  "insufficient permission",
  "no permission",
  "do not have permission",
  "don't have permission",
  "auth_insufficient_privilege",
  "无权限",
  "没有权限",
  "权限不足",
  "权限被拒绝",
  "无权进行此操作",
]

const AUTH = [
  "unauthorized",
  "unauthenticated",
  "authentication required",
  "auth required",
  "invalid auth",
  "not logged",
  "login required",
  "access token is invalid",
  "access token is expired",
  "invalid access token",
  "invalid token",
  "token expired",
  "访问令牌",
  "令牌无效",
  "令牌已过期",
  "令牌已失效",
  "未登录",
  "未授权",
  "请先登录",
  "登录已过期",
]

const RATE_LIMIT = ["429", "rate limit", "too many requests", "请求过于频繁", "限流", "频率"]

const MISSING_USER_ID = /new-api-user|未提供.{0,6}用户|missing.{0,6}user[\s_-]?id|user.?id.{0,6}required/i

export function containsAny(text, list) {
  const lower = String(text || "").toLowerCase()
  return list.some((snippet) => lower.includes(snippet.toLowerCase()))
}

export function isAlreadyCheckedMessage(text) {
  return containsAny(text, ALREADY)
}

export function isCaptchaMessage(text) {
  return containsAny(text, CAPTCHA)
}

export function isDisabledMessage(text) {
  return containsAny(text, DISABLED)
}

export function isPermissionMessage(text) {
  return containsAny(text, PERMISSION)
}

export function isAuthMessage(text) {
  return containsAny(text, AUTH)
}

export function isMissingUserIdMessage(text) {
  return MISSING_USER_ID.test(String(text || ""))
}

export function isRateLimitedMessage(text) {
  return containsAny(text, RATE_LIMIT)
}

/**
 * A user-configured keyword list ("签到成功|success", each alternative matched
 * case-insensitively) against a response's text and JSON.
 */
export function keywordHit(text, pattern) {
  const alternatives = String(pattern || "")
    .split("|")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)
  if (!alternatives.length) return false
  const hay = String(text || "").toLowerCase()
  return alternatives.some((part) => hay.includes(part))
}
