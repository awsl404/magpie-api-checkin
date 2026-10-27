import test from "node:test"
import assert from "node:assert/strict"

import {
  PlatformError,
  checkinOf,
  detectPlatform,
  listModelIds,
  profileOf,
  sub2Envelope,
} from "../lib/platforms.mjs"
import { shiftDay } from "../lib/values.mjs"

const TOKEN = "eyJhbGciOiJub25lIn0.eyJpZCI6NywidXNlcm5hbWUiOiJhbGljZSJ9.sig"

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })

const text = (body, status = 200, type = "text/plain") =>
  new Response(body, { status, headers: { "content-type": type } })

function makeFetch(routes) {
  const calls = []
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url)
    const method = (init.method || "GET").toUpperCase()
    const handler = routes[`${method} ${url.pathname}`] || routes[`${method} ${url.pathname}${url.search}`]
    calls.push({
      method,
      path: url.pathname,
      search: url.search,
      headers: init.headers || {},
      body: init.body,
    })
    if (!handler) return text("Not Found", 404)
    return await handler({ url, init })
  }
  return { fetchImpl, calls }
}

function makeAccount(platform, fetchImpl, extra = {}) {
  return {
    baseUrl: "https://site.test",
    token: TOKEN,
    userId: 7,
    platform,
    quotaPerUnit: 500_000,
    apiKey: "",
    cookie: false,
    fetchImpl,
    ...extra,
  }
}

test("new-api: a press claims the award", async () => {
  const { fetchImpl, calls } = makeFetch({
    "GET /api/status": () =>
      json({
        success: true,
        data: { system_name: "Demo", checkin_enabled: true, quota_per_unit: 500_000 },
      }),
    "GET /api/user/checkin": () =>
      json({ success: true, data: { enabled: true, stats: { checked_in_today: false, records: [] } } }),
    "POST /api/user/checkin": () =>
      json({ success: true, message: "签到成功", data: { quota_awarded: 250_000 } }),
  })

  const result = await checkinOf(makeAccount("new-api", fetchImpl))
  assert.equal(result.outcome, "claimed")
  assert.equal(result.credit, 0.5)
  assert.equal(result.message, "签到成功")
  const post = calls.find((c) => c.method === "POST" && c.path === "/api/user/checkin")
  assert.ok(post)
  assert.equal(post.headers["New-API-User"], "7")
  assert.equal(post.headers.Authorization, `Bearer ${TOKEN}`)
})

test("new-api: already checked in reads as done", async () => {
  const { fetchImpl } = makeFetch({
    "GET /api/status": () => json({ success: true, data: { system_name: "Demo", checkin_enabled: true } }),
    "GET /api/user/checkin": () =>
      json({ success: true, data: { enabled: true, stats: { checked_in_today: false, records: [] } } }),
    "POST /api/user/checkin": () => json({ success: false, message: "今天已经签到" }),
  })
  const result = await checkinOf(makeAccount("new-api", fetchImpl))
  assert.equal(result.outcome, "done")
  assert.equal(result.message, "今天已经签到")
})

test("new-api: status already checked in skips the press", async () => {
  const { fetchImpl, calls } = makeFetch({
    "GET /api/status": () => json({ success: true, data: { system_name: "Demo", checkin_enabled: true } }),
    "GET /api/user/checkin": () =>
      json({
        success: true,
        data: {
          enabled: true,
          stats: {
            checked_in_today: true,
            records: [{ checkin_date: today(), quota_awarded: 100_000 }],
          },
        },
      }),
  })
  const result = await checkinOf(makeAccount("new-api", fetchImpl))
  assert.equal(result.outcome, "done")
  assert.equal(result.credit, 0.2)
  assert.equal(calls.some((c) => c.method === "POST"), false)
})

test("new-api: Turnstile is a captcha, never a solved challenge", async () => {
  const { fetchImpl } = makeFetch({
    "GET /api/status": () => json({ success: true, data: { system_name: "Demo", checkin_enabled: true } }),
    "GET /api/user/checkin": () =>
      json({ success: true, data: { enabled: true, stats: { checked_in_today: false } } }),
    "POST /api/user/checkin": () => json({ success: false, message: "Turnstile token 为空" }),
  })
  const result = await checkinOf(makeAccount("new-api", fetchImpl))
  assert.equal(result.outcome, "captcha")
  assert.match(result.message, /Turnstile/)
})

test("new-api: a site with check-in off is inactive and is not pressed", async () => {
  const { fetchImpl, calls } = makeFetch({
    "GET /api/status": () =>
      json({ success: true, data: { system_name: "Demo", checkin_enabled: false } }),
  })
  const result = await checkinOf(makeAccount("new-api", fetchImpl))
  assert.equal(result.outcome, "inactive")
  assert.equal(calls.some((c) => c.method === "POST"), false)
})

test("new-api: a missing endpoint is inactive, not a daily failure", async () => {
  const { fetchImpl } = makeFetch({
    "GET /api/status": () => json({ success: true, data: { system_name: "Demo" } }),
    "GET /api/user/checkin": () => json({ success: false, message: "Invalid URL (GET /api/user/checkin)" }),
    "POST /api/user/checkin": () => text("Not Found", 404),
  })
  const result = await checkinOf(makeAccount("new-api", fetchImpl))
  assert.equal(result.outcome, "inactive")
})

test("new-api: a cookie credential falls back to /api/user/sign_in", async () => {
  const { fetchImpl, calls } = makeFetch({
    "GET /api/status": () => json({ success: true, data: { system_name: "Demo", checkin_enabled: true } }),
    "GET /api/user/checkin": () => json({ success: false, message: "Invalid URL (GET /api/user/checkin)" }),
    "POST /api/user/checkin": () => text("Not Found", 404),
    "POST /api/user/sign_in": () =>
      json({ success: true, message: "checked in", data: { reward: "0.1" } }),
  })
  const result = await checkinOf(
    makeAccount("new-api", fetchImpl, { token: "session=abc", cookie: true }),
  )
  assert.equal(result.outcome, "claimed")
  const signIn = calls.find((c) => c.path === "/api/user/sign_in")
  assert.ok(signIn)
  assert.equal(signIn.headers.Cookie, "session=abc")
})

test("new-api: a missing New-API-User says what to fill in", async () => {
  const { fetchImpl } = makeFetch({
    "GET /api/status": () => json({ success: true, data: { system_name: "Demo", checkin_enabled: true } }),
    "GET /api/user/checkin": () =>
      json({ success: true, data: { enabled: true, stats: { checked_in_today: false } } }),
    "POST /api/user/checkin": () =>
      json({ success: false, message: "无权进行此操作，未提供 New-API-User" }),
  })
  const result = await checkinOf(makeAccount("new-api", fetchImpl))
  assert.equal(result.outcome, "failed")
  assert.match(result.message, /用户 ID/)
})

test("new-api: an HTML answer is reported as a challenge", async () => {
  const { fetchImpl } = makeFetch({
    "GET /api/status": () => json({ success: true, data: { system_name: "Demo", checkin_enabled: true } }),
    "GET /api/user/checkin": () => json({ success: true, data: { enabled: true, stats: { checked_in_today: false } } }),
    "POST /api/user/checkin": () => text("<!doctype html><html><body>challenge</body></html>", 200, "text/html"),
  })
  const result = await checkinOf(makeAccount("new-api", fetchImpl))
  assert.equal(result.outcome, "failed")
  assert.match(result.message, /Cloudflare|网页/)
})

test("new-api: a 403 status route does not pretend the token is dead", async () => {
  // The 艺の公益 case: /api/user/checkin exists as an admin-only route (403)
  // while the user check-in is a custom path the plugin doesn't know.
  const { fetchImpl } = makeFetch({
    "GET /api/status": () => json({ success: true, data: { system_name: "Ultra Router", checkin_enabled: true } }),
    "GET /api/user/checkin": () =>
      json(
        {
          code: "AUTH_INSUFFICIENT_PRIVILEGE",
          message: "Unauthorized, insufficient privileges",
          success: false,
        },
        403,
      ),
    "POST /api/user/checkin": () =>
      json({ error: { message: "Invalid URL (POST /api/user/checkin)", type: "invalid_request_error" } }, 404),
  })
  const result = await checkinOf(makeAccount("new-api", fetchImpl))
  assert.equal(result.outcome, "inactive")
  assert.match(result.message, /标准/)
  assert.match(result.message, /自定义/)
  assert.doesNotMatch(result.message, /令牌已失效/)
})

test("new-api: a 403 status route still lets a working press claim", async () => {
  const { fetchImpl } = makeFetch({
    "GET /api/status": () => json({ success: true, data: { system_name: "Demo", checkin_enabled: true } }),
    "GET /api/user/checkin": () =>
      json({ code: "AUTH_INSUFFICIENT_PRIVILEGE", message: "insufficient privileges", success: false }, 403),
    "POST /api/user/checkin": () => json({ success: true, message: "签到成功", data: { quota_awarded: 100000 } }),
  })
  const result = await checkinOf(makeAccount("new-api", fetchImpl))
  assert.equal(result.outcome, "claimed")
  assert.equal(result.credit, 0.2)
})

test("new-api: a permission refusal on the press is ineligible, not a token error", async () => {
  const { fetchImpl } = makeFetch({
    "GET /api/status": () => json({ success: true, data: { system_name: "Demo", checkin_enabled: true } }),
    "GET /api/user/checkin": () =>
      json({ success: true, data: { enabled: true, stats: { checked_in_today: false } } }),
    "POST /api/user/checkin": () =>
      json(
        { code: "AUTH_INSUFFICIENT_PRIVILEGE", message: "Unauthorized, insufficient privileges", success: false },
        403,
      ),
  })
  const result = await checkinOf(makeAccount("new-api", fetchImpl))
  assert.equal(result.outcome, "ineligible")
  assert.match(result.message, /HTTP 403/)
})

test("new-api: a 401 is an auth failure with a re-login hint", async () => {
  const { fetchImpl } = makeFetch({
    "GET /api/status": () => json({ success: true, data: { system_name: "Demo", checkin_enabled: true } }),
    "GET /api/user/checkin": () => json({ success: false, message: "未登录" }, 401),
  })
  const result = await checkinOf(makeAccount("new-api", fetchImpl))
  assert.equal(result.outcome, "failed")
  assert.match(result.message, /访问令牌已失效/)
})

test("sub2api: a press claims a USD reward", async () => {
  const { fetchImpl, calls } = makeFetch({
    "GET /api/v1/user/checkin/status": () =>
      json({ code: 0, message: "ok", data: { enabled: true, checked_in_today: false } }),
    "POST /api/v1/user/checkin": () =>
      json({ code: 0, message: "ok", data: { new_reward: true, reward_amount: 0.15 } }),
  })
  const result = await checkinOf(makeAccount("sub2api", fetchImpl))
  assert.equal(result.outcome, "claimed")
  assert.equal(result.credit, 0.15)
  const post = calls.find((c) => c.method === "POST")
  assert.equal(post.headers.Authorization, `Bearer ${TOKEN}`)
  assert.equal(post.body, undefined)
})

test("sub2api: the status saying checked in is done without a press", async () => {
  const { fetchImpl, calls } = makeFetch({
    "GET /api/v1/user/checkin/status": () =>
      json({ code: 0, data: { enabled: true, today_checked_in: true } }),
  })
  const result = await checkinOf(makeAccount("sub2api", fetchImpl))
  assert.equal(result.outcome, "done")
  assert.equal(calls.some((c) => c.method === "POST"), false)
})

test("sub2api: a 409 reason already checked in is done", async () => {
  const { fetchImpl } = makeFetch({
    "GET /api/v1/redeem/checkin/status": () =>
      json({ code: 0, data: { enabled: true, checked_in_today: false } }),
    "POST /api/v1/redeem/checkin": () =>
      json({ code: 409, message: "今日已签到", reason: "DAILY_CHECKIN_ALREADY_DONE" }, 409),
  })
  const result = await checkinOf(makeAccount("sub2api-pro", fetchImpl))
  assert.equal(result.outcome, "done")
})

test("sub2api Pro: a disabled reason is inactive", async () => {
  const { fetchImpl } = makeFetch({
    "GET /api/v1/redeem/checkin/status": () =>
      json({ code: 0, data: { enabled: false, checked_in_today: false } }),
  })
  const result = await checkinOf(makeAccount("sub2api-pro", fetchImpl))
  assert.equal(result.outcome, "inactive")
})

test("sub2api: a missing endpoint is inactive", async () => {
  const { fetchImpl } = makeFetch({
    "GET /api/v1/user/checkin/status": () => text("Not Found", 404),
    "POST /api/v1/user/checkin": () => text("Not Found", 404),
  })
  const result = await checkinOf(makeAccount("sub2api", fetchImpl))
  assert.equal(result.outcome, "inactive")
})

test("sub2api: a permission failure is ineligible", async () => {
  const { fetchImpl } = makeFetch({
    "GET /api/v1/user/checkin/status": () => json({ code: 0, data: { enabled: true, checked_in_today: false } }),
    "POST /api/v1/user/checkin": () =>
      json({ code: 403, message: "permission denied", reason: "DAILY_CHECKIN_ROLE_FORBIDDEN" }, 403),
  })
  const result = await checkinOf(makeAccount("sub2api", fetchImpl))
  assert.equal(result.outcome, "ineligible")
})

test("detectPlatform: a new-api site", async () => {
  const { fetchImpl } = makeFetch({
    "GET /api/v1/auth/me": () => text("Not Found", 404),
    "GET /api/status": () =>
      json({ success: true, data: { system_name: "Demo", quota_per_unit: 500_000, checkin_enabled: true } }),
    "GET /api/user/self": () =>
      json({ success: true, data: { id: 7, username: "alice", quota: 250_000 } }),
  })
  const { platform, profile } = await detectPlatform(makeAccount("auto", fetchImpl))
  assert.equal(platform, "new-api")
  assert.equal(profile.userId, 7)
  assert.equal(profile.username, "alice")
  assert.equal(profile.balance, 0.5)
})

test("detectPlatform: sub2api Pro from its status route", async () => {
  const { fetchImpl } = makeFetch({
    "GET /api/v1/auth/me": () =>
      json({ code: 0, data: { id: 9, username: "bob", balance: 3.21 } }),
    "GET /api/v1/redeem/checkin/status": () =>
      json({ code: 0, data: { enabled: true, checked_in_today: false, reward_min: 0.1, reward_max: 0.2 } }),
  })
  const { platform, profile } = await detectPlatform(makeAccount("auto", fetchImpl))
  assert.equal(platform, "sub2api-pro")
  assert.equal(profile.userId, 9)
  assert.equal(profile.balance, 3.21)
})

test("detectPlatform: generic sub2api when Pro has no route", async () => {
  const { fetchImpl } = makeFetch({
    "GET /api/v1/auth/me": () => json({ code: 0, data: { id: 9, username: "bob", balance: 1 } }),
    "GET /api/v1/redeem/checkin/status": () => text("Not Found", 404),
    "GET /api/v1/user/checkin/status": () =>
      json({ code: 0, data: { enabled: true, checked_in_today: false } }),
  })
  const { platform } = await detectPlatform(makeAccount("auto", fetchImpl))
  assert.equal(platform, "sub2api")
})

test("detectPlatform: a refused token is an auth error", async () => {
  const { fetchImpl } = makeFetch({
    "GET /api/v1/auth/me": () => json({ code: 401, message: "unauthorized" }, 401),
    "GET /api/user/self": () => json({ success: false, message: "未登录" }, 401),
  })
  await assert.rejects(
    () => detectPlatform(makeAccount("auto", fetchImpl)),
    (error) => error instanceof PlatformError && error.kind === "auth",
  )
})

test("profileOf: new-api balance uses quota_per_unit", async () => {
  const { fetchImpl } = makeFetch({
    "GET /api/status": () =>
      json({ success: true, data: { system_name: "Demo", quota_per_unit: 1_000_000 } }),
    "GET /api/user/self": () =>
      json({ success: true, data: { id: 7, username: "alice", quota: 2_500_000 } }),
  })
  const profile = await profileOf(makeAccount("new-api", fetchImpl))
  assert.equal(profile.balance, 2.5)
  assert.equal(profile.siteName, "Demo")
})

test("sub2Envelope understands {code,message,data} and {success,data}", () => {
  assert.equal(sub2Envelope({ code: 0, data: { enabled: true } }).ok, true)
  assert.equal(sub2Envelope({ success: true, data: {} }).ok, true)
  assert.equal(sub2Envelope({ code: 500, message: "boom" }).ok, false)
  assert.equal(sub2Envelope({ code: 500, message: "boom" }).message, "boom")
})

test("listModelIds reads an OpenAI-compatible model list", async () => {
  const { fetchImpl, calls } = makeFetch({
    "GET /v1/models": () =>
      json({ object: "list", data: [{ id: "gpt-4o" }, { id: "claude-3" }, { id: "gpt-4o" }] }),
  })
  const ids = await listModelIds(makeAccount("new-api", fetchImpl, { apiKey: "sk-test" }))
  assert.deepEqual(ids, ["gpt-4o", "claude-3"])
  assert.equal(calls[0].headers.Authorization, "Bearer sk-test")
})

test("new-api: a claimed press counts the streak from the status records", async () => {
  const yesterday = shiftDay(today(), -1)
  const before = shiftDay(today(), -2)
  const { fetchImpl } = makeFetch({
    "GET /api/status": () =>
      json({ success: true, data: { system_name: "Demo", checkin_enabled: true } }),
    "GET /api/user/checkin": () =>
      json({
        success: true,
        data: {
          enabled: true,
          stats: {
            checked_in_today: false,
            records: [{ checkin_date: yesterday }, { checkin_date: before }],
          },
        },
      }),
    "POST /api/user/checkin": () =>
      json({ success: true, message: "签到成功", data: { quota_awarded: 100_000 } }),
  })
  const result = await checkinOf(makeAccount("new-api", fetchImpl))
  assert.equal(result.outcome, "claimed")
  assert.equal(result.credit, 0.2)
  assert.equal(result.streak, 3)
})

test("sub2api: the status streak is passed through", async () => {
  const { fetchImpl } = makeFetch({
    "GET /api/v1/user/checkin/status": () =>
      json({ code: 0, data: { enabled: true, today_checked_in: true, streak: 6 } }),
  })
  const result = await checkinOf(makeAccount("sub2api", fetchImpl))
  assert.equal(result.outcome, "done")
  assert.equal(result.streak, 6)
})

test("checkinOf: a custom account presses its configured endpoint", async () => {
  const { fetchImpl, calls } = makeFetch({
    "POST /custom/checkin": () =>
      json({ success: true, message: "签到成功", data: { reward: 0.2 } }),
  })
  const result = await checkinOf(
    makeAccount("custom", fetchImpl, {
      custom: {
        method: "POST",
        url: "/custom/checkin",
        headers: {},
        body: "{}",
        success: "",
        already: "",
        creditField: "data.reward",
        creditDivisor: 1,
        streakField: "",
        balanceUrl: "",
        balanceField: "",
        balanceDivisor: 1,
        noToken: false,
      },
    }),
  )
  assert.equal(result.outcome, "claimed")
  assert.equal(result.credit, 0.2)
  assert.equal(calls[0].path, "/custom/checkin")
})

test("checkinOf: a custom account needs no token when its headers carry auth", async () => {
  const { fetchImpl, calls } = makeFetch({
    "POST /custom/checkin": () => json({ code: 0, message: "ok" }),
  })
  const result = await checkinOf(
    makeAccount("custom", fetchImpl, {
      token: "",
      cookie: false,
      custom: {
        method: "POST",
        url: "/custom/checkin",
        headers: { "X-Key": "secret" },
        body: "",
        success: "ok",
        already: "",
        creditField: "",
        creditDivisor: 1,
        streakField: "",
        balanceUrl: "",
        balanceField: "",
        balanceDivisor: 1,
        noToken: true,
      },
    }),
  )
  assert.equal(result.outcome, "claimed")
  assert.equal(calls[0].headers["X-Key"], "secret")
})

test("profileOf: a custom account reads its own balance endpoint", async () => {
  const { fetchImpl } = makeFetch({
    "GET /balance": () => json({ code: 0, data: { amount: 3 } }),
  })
  const profile = await profileOf(
    makeAccount("custom", fetchImpl, {
      custom: {
        method: "POST",
        url: "/checkin",
        headers: {},
        body: "",
        success: "",
        already: "",
        creditField: "",
        creditDivisor: 1,
        streakField: "",
        balanceUrl: "/balance",
        balanceField: "data.amount",
        balanceDivisor: 1,
        noToken: false,
      },
    }),
  )
  assert.equal(profile.platform, "custom")
  assert.equal(profile.balance, 3)
})

function today() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
