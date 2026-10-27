// The result shape Magpie's auth.checkin hook reads:
// { outcome, credit, streak, message }. Only these six outcomes are accepted;
// an unknown one is shown as a failure.

import { finiteNumber } from "./http.mjs"
import { round2 } from "./values.mjs"

export const OUTCOMES = ["claimed", "done", "ineligible", "inactive", "captcha", "failed"]

export function outcome(kind, message = "", credit = 0, streak = 0) {
  const amount = finiteNumber(credit)
  const days = finiteNumber(streak)
  return {
    outcome: kind,
    credit: amount === undefined || amount < 0 ? 0 : round2(amount),
    streak: days === undefined || days <= 0 ? 0 : Math.trunc(days),
    message: String(message || "").slice(0, 300),
  }
}

export const claimed = (message, credit = 0, streak = 0) =>
  outcome("claimed", message || "签到成功", credit, streak)

export const done = (message, credit = 0, streak = 0) =>
  outcome("done", message || "今日已签到", credit, streak)

export const inactive = (message) => outcome("inactive", message || "站点当前没有可用的签到活动")

export const ineligible = (message) => outcome("ineligible", message || "该账号不能参与签到")

export const captcha = (message) =>
  outcome("captcha", message || "站点要求人机校验，请在站点页面手动签到")

export const failed = (message) => outcome("failed", message || "签到失败")
