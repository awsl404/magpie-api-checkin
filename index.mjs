// Magpie provider plugin: daily check-in (签到) for new-api / one-api and
// sub2api sites, or any custom URL + header + body endpoint, with each
// account's balance on the Usage page.
//
// The check-in itself is Magpie's: this plugin's auth.checkin hook is pressed
// by Magpie once per account per Beijing day (first look 2 minutes after
// start, then every 30 minutes, failures retried), from the Usage card's
// "Check in now", from Settings → Usage → Plugins, or from
// `magpie accounts checkin`. The Usage card shows balance, the last result and
// the Auto check-in switch.

import {
  NO_TOKEN_KEY,
  PLATFORM_LABELS,
  accountOf,
  displayLabel,
  isValidPlatform,
  jwtUserId,
  jwtUsername,
  normalizeBaseUrl,
  usd,
} from "./lib/auth.mjs"
import { validateCustomConfig } from "./lib/config.mjs"
import { finiteNumber, nonEmptyString } from "./lib/http.mjs"
import { PlatformError, checkinOf, detectPlatform, listModelIds, profileOf } from "./lib/platforms.mjs"
import { looseNumber } from "./lib/values.mjs"

const PROVIDER = "api-checkin"
const PROVIDER_NAME = "API 签到"
// A provider needs a base URL; the loader gives each account its own.
const PLACEHOLDER_API = "https://api-checkin.invalid/v1"
const CHAT_SDK = "@ai-sdk/openai-compatible"

// The custom-endpoint questions only appear when the user picked that
// platform. Magpie's prompt `when` is a plain equality check on an earlier
// answer (see the plugin docs' `when: { key, op, value }`).
const CUSTOM_WHEN = { key: "platform", op: "eq", value: "custom" }

function positiveDivisor(value) {
  const text = nonEmptyString(value)
  if (!text) return undefined
  const n = looseNumber(text)
  return n !== undefined && n > 0 ? undefined : "请填写大于 0 的数字，留空表示 1"
}

const PROMPTS = [
  {
    type: "text",
    key: "url",
    message: "站点地址",
    placeholder: "https://api.example.com",
    validate: (value) => {
      try {
        normalizeBaseUrl(value)
        return undefined
      } catch (error) {
        return error.message
      }
    },
  },
  {
    type: "select",
    key: "platform",
    message: "站点类型",
    options: [
      { label: "自动检测", value: "auto", hint: "先探测 sub2api，再探测 new-api" },
      { label: "new-api / one-api", value: "new-api", hint: "/api/user/checkin" },
      { label: "sub2api", value: "sub2api", hint: "/api/v1/user/checkin" },
      { label: "sub2api Pro", value: "sub2api-pro", hint: "/api/v1/redeem/checkin" },
      { label: "自定义接口", value: "custom", hint: "自己填 URL / Header / Body" },
    ],
  },
  {
    type: "password",
    key: "token",
    message: "用户访问令牌 / JWT / Cookie（自定义接口可留空）",
    placeholder: "粘贴访问令牌；也可以粘贴 session=… 的 Cookie；自定义接口可留空",
  },
  {
    type: "text",
    key: "label",
    message: "账号备注（可选）",
    placeholder: "例如 主站-Alice；留空用用户名",
  },
  {
    type: "text",
    key: "userId",
    message: "用户 ID（可选，部分 one-api 分支需要）",
    placeholder: "站点控制台个人信息里的数字 ID",
  },
  {
    type: "password",
    key: "apiKey",
    message: "站点 API Key（可选）",
    placeholder: "sk-…；填写后可在 magpie 中直接使用该站模型",
  },
  {
    type: "select",
    key: "customMethod",
    message: "自定义签到：请求方法",
    when: CUSTOM_WHEN,
    options: [
      { label: "POST", value: "POST", hint: "最常用" },
      { label: "GET", value: "GET", hint: "状态查询 / 无请求体" },
      { label: "PUT", value: "PUT" },
      { label: "PATCH", value: "PATCH" },
      { label: "DELETE", value: "DELETE" },
    ],
  },
  {
    type: "text",
    key: "customUrl",
    message: "自定义签到：接口地址",
    placeholder: "/api/user/checkin；也可填完整 URL；支持 {baseUrl} {token} 等占位符",
    when: CUSTOM_WHEN,
    validate: (value) => (nonEmptyString(value) ? undefined : "请填写签到接口地址，例如 /api/user/checkin"),
  },
  {
    type: "text",
    key: "customHeaders",
    message: "自定义签到：请求头（可选）",
    placeholder: '{"Authorization":"Bearer {token}","New-API-User":"{userId}"}；也可写 Key: Value; Key2: Value2',
    when: CUSTOM_WHEN,
  },
  {
    type: "text",
    key: "customBody",
    message: "自定义签到：请求体（可选）",
    placeholder: '{"foo":"bar"} 或 a=1&b=2；支持 {token} {userId} 等占位符',
    when: CUSTOM_WHEN,
  },
  {
    type: "text",
    key: "customSuccess",
    message: "自定义签到：成功关键词（可选，多个用 | 分隔）",
    placeholder: "例如 签到成功|success；留空则按 HTTP 状态和 JSON 的 success/code 判断",
    when: CUSTOM_WHEN,
  },
  {
    type: "text",
    key: "customAlready",
    message: "自定义签到：已签到关键词（可选，多个用 | 分隔）",
    placeholder: "例如 今日已签到|already checked",
    when: CUSTOM_WHEN,
  },
  {
    type: "text",
    key: "customCreditField",
    message: "自定义签到：奖励字段（可选，JSON 路径）",
    placeholder: "例如 data.reward 或 data.quota_awarded",
    when: CUSTOM_WHEN,
  },
  {
    type: "text",
    key: "customCreditDivisor",
    message: "自定义签到：奖励换算除数（可选，默认 1）",
    placeholder: "例如 new-api 的 quota 填 500000",
    when: CUSTOM_WHEN,
    validate: (value) => positiveDivisor(value),
  },
  {
    type: "text",
    key: "customStreakField",
    message: "自定义签到：连续天数字段（可选，JSON 路径）",
    placeholder: "例如 data.streak；留空会尝试 streak / continuous_days 等常见字段",
    when: CUSTOM_WHEN,
  },
  {
    type: "text",
    key: "customBalanceUrl",
    message: "自定义接口：余额地址（可选）",
    placeholder: "例如 /api/user/self；留空则不显示余额",
    when: CUSTOM_WHEN,
  },
  {
    type: "text",
    key: "customBalanceField",
    message: "自定义接口：余额字段（可选，JSON 路径）",
    placeholder: "例如 data.quota；留空会尝试 balance / quota 等常见字段",
    when: CUSTOM_WHEN,
  },
  {
    type: "text",
    key: "customBalanceDivisor",
    message: "自定义接口：余额换算除数（可选，默认 1）",
    placeholder: "例如 new-api 的 quota 填 500000",
    when: CUSTOM_WHEN,
    validate: (value) => positiveDivisor(value),
  },
]

function userIdOf(input, fallback) {
  const text = nonEmptyString(input)
  if (!text) return fallback
  const n = finiteNumber(text)
  if (n === undefined || n <= 0 || !Number.isInteger(n)) {
    throw new Error("用户 ID 必须是正整数")
  }
  return n
}

function modelEntry(id, baseUrl) {
  return {
    id,
    providerID: PROVIDER,
    name: id,
    api: { id, url: `${baseUrl}/v1`, npm: CHAT_SDK },
    status: "active",
    headers: {},
    options: {},
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 131_072, output: 8_192 },
    capabilities: {
      temperature: true,
      reasoning: false,
      attachment: false,
      toolcall: true,
      input: { text: true },
      output: { text: true },
    },
    release_date: "",
    variants: {},
  }
}

const server = async ({ client } = {}, _options = {}) => {
  const toast = async (message, variant = "info") => {
    try {
      await client?.tui?.showToast?.({ body: { title: PROVIDER_NAME, message, variant } })
    } catch {
      // a toast the window can't show is no reason to fail the work
    }
  }

  return {
    config: async (cfg) => {
      cfg.provider ??= {}
      cfg.provider[PROVIDER] ??= {
        name: PROVIDER_NAME,
        npm: CHAT_SDK,
        api: PLACEHOLDER_API,
        models: {},
      }
    },

    auth: {
      provider: PROVIDER,
      methods: [
        {
          type: "api",
          keyless: true,
          label: "添加站点账号",
          prompts: PROMPTS,

          // Runs after the questions above; the key it returns is kept as the
          // account's credential by Magpie (the access token), and metadata is
          // everything else the hooks need. Magpie only skips its own key
          // field for a keyless method that has this function.
          async authorize(inputs = {}) {
            let baseUrl
            try {
              baseUrl = normalizeBaseUrl(inputs.url)
            } catch (error) {
              return { type: "failed", error: error.message }
            }
            const token = nonEmptyString(inputs.token)
            const platform = nonEmptyString(inputs.platform) || "auto"
            if (!isValidPlatform(platform)) {
              return { type: "failed", error: `未知的站点类型：${platform}` }
            }
            let statedUserId
            try {
              statedUserId = userIdOf(inputs.userId, undefined)
            } catch (error) {
              return { type: "failed", error: error.message }
            }

            // A custom endpoint is one user-configured request, so its URL,
            // method, headers and body are validated here rather than by a
            // platform probe. Detection is best-effort: when the site also
            // answers new-api/sub2api, its name and balance come from there.
            if (platform === "custom") {
              let custom
              try {
                custom = validateCustomConfig(inputs, { token })
              } catch (error) {
                return { type: "failed", error: error.message }
              }

              let detected = null
              if (token && !custom.balanceUrl) {
                try {
                  detected = await detectPlatform({
                    baseUrl,
                    token,
                    userId: statedUserId ?? jwtUserId(token),
                    platform: "auto",
                  })
                } catch {
                  // A site with a custom check-in need not look like either
                  // built-in family; the custom press still works.
                }
              }
              const profile = detected?.profile
              const userId = statedUserId ?? profile?.userId ?? jwtUserId(token)
              const username = profile?.username || jwtUsername(token)
              const label = displayLabel({
                label: inputs.label,
                baseUrl,
                username,
                userId,
                token,
              })
              const metadata = {
                baseUrl,
                platform: "custom",
                detectedPlatform: detected?.platform || "",
                userId,
                username,
                // Magpie names an account by accountId, then metadata.email.
                email: label,
                label: nonEmptyString(inputs.label),
                siteName: profile?.siteName || "",
                quotaPerUnit: profile?.quotaPerUnit || 500_000,
                apiKey: nonEmptyString(inputs.apiKey),
                custom,
                detectedAt: new Date().toISOString(),
              }
              await toast(`${label} 已添加（自定义签到 ${custom.method} ${custom.url}）`, "info")
              return { type: "success", key: token || NO_TOKEN_KEY, metadata }
            }

            if (!token) return { type: "failed", error: "请粘贴站点访问令牌" }
            let userId
            try {
              userId = userIdOf(inputs.userId, jwtUserId(token))
            } catch (error) {
              return { type: "failed", error: error.message }
            }

            const account = {
              baseUrl,
              token,
              userId,
              platform,
              apiKey: nonEmptyString(inputs.apiKey),
            }
            let found
            try {
              found = await detectPlatform(account)
            } catch (error) {
              return { type: "failed", error: String(error.message || error).slice(0, 500) }
            }
            const profile = found.profile
            const label = displayLabel({
              label: inputs.label,
              baseUrl,
              username: profile.username,
              userId: profile.userId ?? userId,
              token,
            })
            const metadata = {
              baseUrl,
              platform: found.platform,
              userId: profile.userId ?? userId,
              username: profile.username || "",
              // Magpie names an account by accountId, then metadata.email.
              email: label,
              label: nonEmptyString(inputs.label),
              siteName: profile.siteName || "",
              quotaPerUnit: profile.quotaPerUnit || 500_000,
              apiKey: nonEmptyString(inputs.apiKey),
              detectedAt: new Date().toISOString(),
            }
            await toast(`${label} 已添加（${PLATFORM_LABELS[found.platform]}）`, "info")
            return { type: "success", key: token, metadata }
          },
        },
      ],

      async loader(getAuth) {
        const account = accountOf(await getAuth())
        if (!account.baseUrl) return {}
        return {
          baseURL: `${account.baseUrl}/v1`,
          // Never let the account's access token stand in for an API key:
          // the sites' /v1 uses sk- keys, a different credential.
          apiKey: account.apiKey || "no-api-key-set",
        }
      },

      // Balance and the site's name for the Usage card. Magpie marks the
      // account as needing a new sign-in when a read says signIn: "expired".
      async usage(getAuth) {
        const account = accountOf(await getAuth())
        const plan = PLATFORM_LABELS[account.platform] || ""
        if (!account.baseUrl) {
          return { plan, error: "账号缺少站点地址，请重新登录", windows: [] }
        }
        if (account.platform !== "custom" && !account.token) {
          return { plan, error: "账号缺少访问令牌，请重新登录", windows: [] }
        }
        try {
          const profile = await profileOf(account)
          return {
            plan: (profile.siteName || plan || PROVIDER_NAME).slice(0, 60),
            balance: usd(profile.balance),
            error: "",
            windows: [],
          }
        } catch (error) {
          if (error instanceof PlatformError && error.kind === "auth") {
            return { plan, signIn: "expired", error: "访问令牌已失效，请重新登录", windows: [] }
          }
          return { plan, error: String(error.message || error).slice(0, 300), windows: [] }
        }
      },

      // Magpie presses this once per account per day while Auto check-in is
      // on. Only the fields below are read: outcome, credit, streak, message.
      async checkin(getAuth) {
        const account = accountOf(await getAuth())
        return checkinOf(account)
      },
    },

    // Only accounts that also brought an sk- API key serve models; the rest
    // are check-in and balance accounts. A site's list can be long, so it is
    // capped and a failed read keeps the list Magpie already had.
    provider: {
      id: PROVIDER,
      async models(provider, { auth } = {}) {
        if (!auth) return provider.models
        const account = accountOf(auth)
        if (!account.baseUrl || !account.apiKey) return provider.models
        try {
          const ids = await listModelIds(account)
          if (!ids?.length) return provider.models
          const out = {}
          for (const id of ids.slice(0, 500)) out[id] = modelEntry(id, account.baseUrl)
          return out
        } catch {
          return provider.models
        }
      },
    },
  }
}

export default { id: PROVIDER, server }
