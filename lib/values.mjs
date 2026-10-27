// Reading values out of arbitrary JSON: money-like numbers, dotted paths,
// and the streak/credit/balance field names that sites commonly use.

import { finiteNumber, isRecord, nonEmptyString, record } from "./http.mjs"

/** A number a site wrote as "0.2", "$0.20", "1,234.5" or "0.2 USD". */
export function looseNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value !== "string") return undefined
  const text = value.trim().replace(/,/g, "")
  const match = text.match(/-?\d+(?:\.\d+)?/)
  if (!match) return undefined
  const n = Number(match[0])
  return Number.isFinite(n) ? n : undefined
}

/** `data.reward`, `data[0].amount`, `$.data.quota`, or `["data"]["quota"]`. */
export function getByPath(value, path) {
  const text = String(path || "").trim()
  if (!text) return undefined
  const parts = text
    .replace(/^\$\.?/, "")
    .replace(/\[\s*['"]?([^'"\]]+)['"]?\s*\]/g, ".$1")
    .split(".")
    .filter((part) => part !== "")
  let current = value
  for (const part of parts) {
    if (current === null || current === undefined) return undefined
    if (Array.isArray(current)) {
      const index = Number(part)
      if (!Number.isInteger(index)) return undefined
      current = current[index]
    } else if (isRecord(current)) {
      current = current[part]
    } else {
      return undefined
    }
  }
  return current
}

const CREDIT_KEYS = [
  "reward_amount",
  "rewardAmount",
  "today_reward",
  "todayReward",
  "quota_awarded",
  "today_quota_awarded",
  "quotaAwarded",
  "todayQuotaAwarded",
  "quota_reward",
  "quotaReward",
  "reward",
  "credit",
  "credits",
  "points",
  "amount",
]

const BALANCE_KEYS = [
  "balance",
  "remaining",
  "remain_quota",
  "remainQuota",
  "usable_quota",
  "usableQuota",
  "quota",
  "credits",
  "points",
  "left",
  "amount",
]

const STREAK_KEYS = [
  "streak",
  "streak_days",
  "streakDays",
  "continuous_days",
  "continuousDays",
  "consecutive_days",
  "consecutiveDays",
  "checkin_days",
  "checkinDays",
  "days_in_row",
  "daysInRow",
]

function findNumber(value, keys, depth, seen) {
  if (depth < 0) return undefined
  const row = record(value)
  if (!row || seen.has(row)) return undefined
  seen.add(row)
  for (const key of keys) {
    if (!(key in row)) continue
    const n = looseNumber(row[key])
    if (n !== undefined) return n
  }
  for (const child of Object.values(row)) {
    if (Array.isArray(child)) {
      for (const item of child) {
        const n = findNumber(item, keys, depth - 1, seen)
        if (n !== undefined) return n
      }
    } else if (isRecord(child)) {
      const n = findNumber(child, keys, depth - 1, seen)
      if (n !== undefined) return n
    }
  }
  return undefined
}

function divisorOf(value) {
  const n = finiteNumber(value)
  return n === undefined || n <= 0 ? 1 : n
}

/** The reward a check-in answered with, divided by `divisor` (1 by default). */
export function creditOf(value, field, divisor = 1) {
  const div = divisorOf(divisor)
  let raw
  if (field) {
    raw = looseNumber(getByPath(value, field))
  } else {
    raw = looseNumber(getByPath(value, "data"))
    if (raw === undefined) raw = findNumber(value, CREDIT_KEYS, 4, new Set())
  }
  if (raw === undefined || raw < 0) return 0
  return raw / div
}

/** The balance a site answered with, or undefined when no such field exists. */
export function balanceOf(value, field, divisor = 1) {
  const div = divisorOf(divisor)
  let raw
  if (field) {
    raw = looseNumber(getByPath(value, field))
  } else {
    raw = looseNumber(getByPath(value, "data"))
    if (raw === undefined) raw = findNumber(value, BALANCE_KEYS, 4, new Set())
  }
  return raw === undefined ? undefined : raw / div
}

/** Consecutive check-in days, from an explicit field or common field names. */
export function streakOf(value, field) {
  let raw
  if (field) {
    raw = looseNumber(getByPath(value, field))
  } else {
    raw = looseNumber(getByPath(value, "data"))
    if (raw === undefined) raw = findNumber(value, STREAK_KEYS, 4, new Set())
  }
  if (raw === undefined || raw < 0) return 0
  return Math.round(raw)
}

/** "2026-10-26" shifted by a whole number of days, in the same format. */
export function shiftDay(day, delta) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ""))
  if (!match) return ""
  const time = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) + delta * 86_400_000
  const date = new Date(time)
  const pad = (n) => String(n).padStart(2, "0")
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
}

/** Consecutive days ending at `day` among an array of check-in records. */
export function streakFromRecords(records, day) {
  if (!Array.isArray(records)) return 0
  const days = new Set()
  for (const row of records) {
    const item = record(row)
    const text =
      nonEmptyString(item?.checkin_date) ||
      nonEmptyString(item?.date) ||
      nonEmptyString(item?.day)
    if (/^\d{4}-\d{2}-\d{2}/.test(text)) days.add(text.slice(0, 10))
  }
  let count = 0
  let cursor = String(day || "").slice(0, 10)
  while (cursor && days.has(cursor) && count < 3_660) {
    count += 1
    cursor = shiftDay(cursor, -1)
  }
  return count
}

export function round2(value) {
  const n = finiteNumber(value)
  if (n === undefined) return 0
  return Math.round(n * 100) / 100
}
