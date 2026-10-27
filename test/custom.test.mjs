import test from "node:test"
import assert from "node:assert/strict"

import {
  PlatformError,
  customCheckin,
  customProfile,
  genericVerdict,
  interpretCustom,
  saysAlready,
} from "../lib/custom.mjs"

function answer(status, body, extra = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: body,
    text: extra.text ?? (body === undefined ? "" : JSON.stringify(body)),
    html: extra.html === true,
    headers: {},
  }
}

function config(overrides = {}) {
  return {
    method: "POST",
    url: "/custom/checkin",
    headers: {},
    body: "",
    success: "",
    already: "",
    creditField: "",
    creditDivisor: 1,
    streakField: "",
    balanceUrl: "",
    balanceField: "",
    balanceDivisor: 1,
    noToken: false,
    ...overrides,
  }
}

function account(custom = {}, extra = {}) {
  return {
    baseUrl: "https://site.test",
    token: "tok",
    userId: 7,
    username: "alice",
    apiKey: "",
    cookie: false,
    custom: config(custom),
    ...extra,
  }
}

test("already-checked flags are found anywhere in a JSON body", () => {
  assert.equal(saysAlready({ data: { checked_in_today: true } }), true)
  assert.equal(saysAlready({ data: { alreadyChecked: true } }), true)
  assert.equal(saysAlready({ data: { new_reward: false } }), true)
  assert.equal(saysAlready({ data: { checked_in_today: false } }), false)
  assert.equal(saysAlready({ data: { reward: 1 } }), false)
})

test("generic envelopes are read as claimed, done or failed", () => {
  assert.equal(genericVerdict({ success: true }), "claimed")
  assert.equal(genericVerdict({ ok: true }), "claimed")
  assert.equal(genericVerdict({ code: 0 }), "claimed")
  assert.equal(genericVerdict({ code: "200" }), "claimed")
  assert.equal(genericVerdict({ statusCode: 201 }), "claimed")
  assert.equal(genericVerdict({ code: 500, message: "boom" }), "failed")
  assert.equal(genericVerdict({ status: "ok" }), "claimed")
  assert.equal(genericVerdict({ error: "bad" }), "failed")
  assert.equal(genericVerdict({ data: { already_checked: true } }), "done")
})

test("a configured success keyword claims the reward", () => {
  const result = interpretCustom(
    answer(200, { message: "签到成功", data: { reward: "$0.25" } }),
    config({ success: "签到成功", creditField: "data.reward" }),
  )
  assert.equal(result.outcome, "claimed")
  assert.equal(result.credit, 0.25)
  assert.equal(result.message, "签到成功")
})

test("already-checked wording is done, with the day's reward", () => {
  const result = interpretCustom(
    answer(200, { message: "今日已签到", data: { reward_amount: 0.1 } }),
    config(),
  )
  assert.equal(result.outcome, "done")
  assert.equal(result.credit, 0.1)

  const keyword = interpretCustom(
    answer(200, undefined, { text: "ALREADY DONE" }),
    config({ already: "already|done" }),
  )
  assert.equal(keyword.outcome, "done")
})

test("captcha, disabled, permission and auth answers keep their meaning", () => {
  assert.equal(
    interpretCustom(answer(200, { message: "Turnstile token 为空" }), config()).outcome,
    "captcha",
  )
  assert.equal(
    interpretCustom(answer(200, { message: "签到已关闭" }), config()).outcome,
    "inactive",
  )
  assert.equal(
    interpretCustom(answer(403, { message: "permission denied" }), config()).outcome,
    "ineligible",
  )
  const auth = interpretCustom(answer(401, { message: "unauthorized" }), config())
  assert.equal(auth.outcome, "failed")
  assert.match(auth.message, /访问令牌已失效/)
})

test("a missing custom route, a server error and an HTML wall are failures", () => {
  const missing = interpretCustom(answer(404, undefined, { text: "Not Found" }), config())
  assert.equal(missing.outcome, "failed")
  assert.match(missing.message, /自定义签到接口不存在/)

  const server = interpretCustom(answer(500, { message: "boom" }), config())
  assert.equal(server.outcome, "failed")
  assert.match(server.message, /服务器错误/)

  const html = interpretCustom(
    answer(200, undefined, { text: "<!doctype html><html>challenge</html>", html: true }),
    config(),
  )
  assert.equal(html.outcome, "failed")
  assert.match(html.message, /Cloudflare|网页/)
})

test("a plain 200 answer is a claim; code/code + divisor works too", () => {
  const plain = interpretCustom(answer(200, undefined, { text: "ok" }), config())
  assert.equal(plain.outcome, "claimed")
  assert.equal(plain.message, "ok")

  const quota = interpretCustom(
    answer(200, { code: 0, data: { quota_awarded: 100_000 } }),
    config({ creditField: "data.quota_awarded", creditDivisor: 500_000 }),
  )
  assert.equal(quota.outcome, "claimed")
  assert.equal(quota.credit, 0.2)
})

test("a streak field is passed through to Magpie", () => {
  const result = interpretCustom(
    answer(200, { code: 0, data: { reward: 0.1, streak: 4 } }),
    config(),
  )
  assert.equal(result.outcome, "claimed")
  assert.equal(result.credit, 0.1)
  assert.equal(result.streak, 4)
})

test("customCheckin sends the configured method, headers and body", async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    return new Response(
      JSON.stringify({ success: true, message: "签到成功", data: { reward_amount: 0.3 } }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  }
  const result = await customCheckin(
    account(
      {
        method: "POST",
        url: "/custom/checkin",
        headers: { "X-Token": "{token}", "New-API-User": "{userId}" },
        body: '{"user":"{username}"}',
        success: "签到成功",
      },
      { fetchImpl },
    ),
  )
  assert.equal(result.outcome, "claimed")
  assert.equal(result.credit, 0.3)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, "https://site.test/custom/checkin")
  assert.equal(calls[0].init.method, "POST")
  assert.equal(calls[0].init.headers["X-Token"], "tok")
  assert.equal(calls[0].init.headers["New-API-User"], "7")
  assert.equal(calls[0].init.headers["Content-Type"], "application/json")
  assert.equal(calls[0].init.body, '{"user":"alice"}')
})

test("customCheckin explains a missing configuration", async () => {
  const result = await customCheckin(account({ url: "" }))
  assert.equal(result.outcome, "failed")
  assert.match(result.message, /自定义签到配置/)
})

test("customProfile reads a configured balance endpoint", async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    return new Response(JSON.stringify({ code: 0, data: { quota: 2_500_000 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }
  const profile = await customProfile(
    account(
      {
        balanceUrl: "/api/self",
        balanceField: "data.quota",
        balanceDivisor: 500_000,
        headers: { "X-Token": "{token}" },
      },
      { fetchImpl },
    ),
  )
  assert.equal(profile.balance, 5)
  assert.equal(calls[0].url, "https://site.test/api/self")
  assert.equal(calls[0].init.method, "GET")
  assert.equal(calls[0].init.headers["X-Token"], "tok")
})

test("a refused balance read is an auth error, not a balance of zero", async () => {
  const fetchImpl = async () =>
    new Response(JSON.stringify({ message: "unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    })
  await assert.rejects(
    () => customProfile(account({ balanceUrl: "/api/self" }, { fetchImpl })),
    (error) => error instanceof PlatformError && error.kind === "auth",
  )
})

test("no balance endpoint simply leaves the balance empty", async () => {
  const profile = await customProfile(account())
  assert.equal(profile.platform, "custom")
  assert.equal(profile.balance, undefined)
})
