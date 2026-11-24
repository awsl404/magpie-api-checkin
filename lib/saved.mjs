// Reading back this plugin's own accounts from Magpie's plugin-auth.json.
//
// Magpie keeps every plugin sign-in's answers there. On a re-login it calls
// the method with empty inputs, so without this the user would have to type
// the site URL, platform, headers and body again. We only read entries whose
// key belongs to this provider, and only to offer them back as defaults; no
// copy of the token is written anywhere else.

import { NO_TOKEN_KEY, PLATFORM_LABELS, isValidPlatform } from "./auth.mjs"
import { normalizeCustomConfig } from "./config.mjs"
import { nonEmptyString } from "./http.mjs"

const PROVIDER = "api-checkin"

async function nodeModules() {
  try {
    const [fsModule, pathModule, osModule] = await Promise.all([
      import("node:fs"),
      import("node:path"),
      import("node:os"),
    ])
    return {
      fs: fsModule.default ?? fsModule,
      path: pathModule.default ?? pathModule,
      os: osModule.default ?? osModule,
    }
  } catch {
    return null
  }
}

/** Magpie's config folder, as the host sees it. */
export async function configDir() {
  const modules = await nodeModules()
  if (!modules) return ""
  const env = globalThis.process?.env || {}
  const xdg = nonEmptyString(env.XDG_CONFIG_HOME)
  try {
    if (xdg) return modules.path.join(xdg, "magpie")
    return modules.path.join(modules.os.homedir(), ".config", "magpie")
  } catch {
    return ""
  }
}

async function readAuthFile() {
  const modules = await nodeModules()
  const dir = await configDir()
  if (!modules || !dir) return {}
  try {
    const raw = modules.fs.readFileSync(modules.path.join(dir, "plugin-auth.json"), "utf8")
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function authObject(value) {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value)
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null
    } catch {
      return null
    }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? value : null
}

function accountName(metadata, token) {
  const email = nonEmptyString(metadata.email)
  if (email) return email
  const label = nonEmptyString(metadata.label) || nonEmptyString(metadata.username)
  if (label) return label
  return nonEmptyString(metadata.baseUrl) || nonEmptyString(metadata.url) || (token ? "已登录账号" : "自定义账号")
}

/**
 * This provider's saved accounts, most recent first. Each carries the
 * original flat sign-in answers so a re-login can reuse them.
 */
export async function savedApiCheckinAccounts() {
  const auth = await readAuthFile()
  const out = []
  for (const [key, value] of Object.entries(auth)) {
    if (key !== PROVIDER && !key.startsWith(`${PROVIDER}#`)) continue
    const entry = authObject(value)
    if (!entry) continue
    const metadata = entry.metadata && typeof entry.metadata === "object" ? entry.metadata : {}
    const rawToken = nonEmptyString(entry.key)
    const token = rawToken === NO_TOKEN_KEY ? "" : rawToken || nonEmptyString(metadata.token)
    out.push({
      sourceKey: key,
      email: accountName(metadata, token),
      label: nonEmptyString(metadata.label),
      username: nonEmptyString(metadata.username),
      platform: isValidPlatform(metadata.platform) ? metadata.platform : "auto",
      baseUrl: nonEmptyString(metadata.baseUrl) || nonEmptyString(metadata.url),
      url: nonEmptyString(metadata.url) || nonEmptyString(metadata.baseUrl),
      userId: metadata.userId,
      apiKey: nonEmptyString(metadata.apiKey),
      token,
      custom: normalizeCustomConfig(metadata),
      detectedAt: nonEmptyString(metadata.detectedAt),
    })
  }
  out.sort((a, b) => String(b.detectedAt).localeCompare(String(a.detectedAt)))
  return out
}

/** The flat answers a normal sign-in would have collected. */
export function inputsFromSaved(account) {
  const custom = account.custom || normalizeCustomConfig({})
  const userId = Number(account.userId)
  return {
    url: account.url || account.baseUrl || "",
    token: account.token || "",
    platform: account.platform || "auto",
    // Keeping the old label (or username) keeps Magpie's account name, so
    // the new sign-in replaces the account instead of adding a second one.
    label: account.label || account.username || "",
    userId: Number.isFinite(userId) && userId > 0 ? String(userId) : "",
    apiKey: account.apiKey || "",
    customMethod: custom.method,
    customUrl: custom.url,
    customHeaders: Object.keys(custom.headers || {}).length ? JSON.stringify(custom.headers) : "",
    customBody: custom.body,
    customSuccess: custom.success,
    customAlready: custom.already,
    customCreditField: custom.creditField,
    customCreditDivisor: String(custom.creditDivisor ?? ""),
    customStreakField: custom.streakField,
    customBalanceUrl: custom.balanceUrl,
    customBalanceField: custom.balanceField,
    customBalanceDivisor: String(custom.balanceDivisor ?? ""),
  }
}

export function savedAccountTitle(account) {
  return (account.email || account.baseUrl || account.label || "已登录账号").slice(0, 80)
}

export function savedAccountHint(account) {
  const platform = PLATFORM_LABELS[account.platform] || account.platform || ""
  const host = String(account.baseUrl || "").replace(/^https?:\/\//, "")
  return [platform, host].filter(Boolean).join(" · ")
}

/** Only the last four characters of a saved token, for the hint text. */
export function maskToken(token) {
  const text = String(token || "")
  return text ? `••••${text.slice(-4)}` : ""
}