import test from "node:test"
import assert from "node:assert/strict"

import { checkinOf } from "../lib/platforms.mjs"
import { loginCheckin, loginOnce, loginProfile } from "../lib/login-checkin.mjs"

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
    const handler =
      routes[`${method} ${url.pathname}`] || routes[`${method} ${url.pathname}${url.search}`]
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

function makeAccount(fetchImpl, extra = {}) {
  return {
    baseUrl: "https://site.test",
    token: "old-token",
    userId: 7,
    platform: "new-api",
    checkinMode: "login",
    quotaPerUnit: 500_000,
    apiKey: "",
    cookie: false,
    loginCheckin: { mode: "login", username: "alice@example.com", password: "pw" },
    fetchImpl,
    ...extra,
  }
}

const STATUS = () =>
  json({
    success: true,
    data: { system_name: "Example Site", quota_per_unit: 500_000, turnstile_check: false },
  })

test("login-checkin: a login that awards quota is claimed with its credit", async () => {
  const { fetchImpl, calls } = makeFetch({
    "GET /api/status": STATUS,
    "GET /api/user/self": () =>
      json({ success: true, data: { id: 7, username: "alice", quota: 1_000_000 } }),
    "POST /api/user/login": () =>
      json({
        success: true,
        data: { id: 7, username: "alice", quota: 13_500_000, checked_in: true, streak: 4 },
      }),
  })

  const result = await loginCheckin(makeAccount(fetchImpl))

  assert.equal(result.outcome, "claimed")
  assert.equal(result.credit, 25)
  assert.equal(result.streak, 4)
  assert.match(result.message, /25/)

  const login = calls.find((call) => call.path === "/api/user/login")
  assert.equal(login.method, "POST")
  assert.deepEqual(JSON.parse(login.body), {
    username: "alice@example.com",
    password: "pw",
  })
})

test("login-checkin: a login without the flag reports already checked in", async () => {
  const { fetchImpl } = makeFetch({
    "GET /api/status": STATUS,
    "GET /api/user/self": () => json({ success: true, data: { id: 7, quota: 5_000_000 } }),
    "POST /api/user/login": () =>
      json({ success: true, data: { id: 7, quota: 5_000_000, checked_in: false } }),
  })

  const result = await loginCheckin(makeAccount(fetchImpl))
  assert.equal(result.outcome, "done")
  assert.equal(result.credit, 0)
})

test("login-checkin: a refused password fails with the site's reason", async () => {
  const { fetchImpl } = makeFetch({
    "GET /api/status": STATUS,
    "GET /api/user/self": () => json({ success: true, data: { id: 7, quota: 1 } }),
    "POST /api/user/login": () =>
      json({ success: false, message: "用户名或密码错误，或用户已被封禁" }),
  })

  const result = await loginCheckin(makeAccount(fetchImpl))
  assert.equal(result.outcome, "failed")
  assert.match(result.message, /用户名或密码错误/)
})

test("login-checkin: a banned account is ineligible, not failed", async () => {
  const { fetchImpl } = makeFetch({
    "GET /api/status": STATUS,
    "POST /api/user/login": () => json({ success: false, message: "该账号已被封禁" }, 200),
  })

  const result = await loginCheckin(makeAccount(fetchImpl))
  assert.equal(result.outcome, "ineligible")
  assert.match(result.message, /封禁/)
})

test("login-checkin: a fused wrong-password-or-banned message stays failed", async () => {
  const { fetchImpl } = makeFetch({
    "GET /api/status": STATUS,
    "POST /api/user/login": () =>
      json({ success: false, message: "用户名或密码错误，或用户已被封禁" }),
  })

  const result = await loginCheckin(makeAccount(fetchImpl))
  assert.equal(result.outcome, "failed")
})

test("login-checkin: turnstile on the site stops before logging in", async () => {
  const { fetchImpl, calls } = makeFetch({
    "GET /api/status": () =>
      json({
        success: true,
        data: { system_name: "Gated", turnstile_check: true },
      }),
  })

  const result = await loginCheckin(makeAccount(fetchImpl))
  assert.equal(result.outcome, "captcha")
  assert.equal(
    calls.some((call) => call.path === "/api/user/login"),
    false,
  )
})

test("login-checkin: a new access token in the login reply is announced", async () => {
  const { fetchImpl } = makeFetch({
    "GET /api/status": STATUS,
    "GET /api/user/self": () => json({ success: true, data: { id: 7, quota: 0 } }),
    "POST /api/user/login": () =>
      json({
        success: true,
        data: { id: 7, quota: 500_000, checked_in: true, access_token: "fresh-token" },
      }),
  })

  const result = await loginCheckin(makeAccount(fetchImpl))
  assert.equal(result.outcome, "claimed")
  assert.match(result.message, /新的访问令牌/)
})

test("login-checkin: no stored token still checks in", async () => {
  const { fetchImpl, calls } = makeFetch({
    "GET /api/status": STATUS,
    "POST /api/user/login": () => json({ success: true, data: { id: 7, checked_in: true } }),
  })

  const result = await checkinOf(makeAccount(fetchImpl, { token: "" }))
  assert.equal(result.outcome, "claimed")
  assert.equal(calls.some((call) => call.path === "/api/user/self"), false)
})

test("login-checkin: checkinOf routes a login-mode account to the login adapter", async () => {
  const { fetchImpl, calls } = makeFetch({
    "GET /api/status": STATUS,
    "GET /api/user/self": () => json({ success: true, data: { id: 7, quota: 0 } }),
    "POST /api/user/login": () => json({ success: true, data: { id: 7, checked_in: true } }),
  })

  await checkinOf(makeAccount(fetchImpl))
  assert.equal(
    calls.some((call) => call.path === "/api/user/checkin"),
    false,
  )
})

test("login-checkin: loginOnce refuses empty credentials", async () => {
  const { fetchImpl } = makeFetch({})
  await assert.rejects(
    loginOnce({ baseUrl: "https://site.test", username: "", password: "pw", fetchImpl }),
    /缺少用户名或密码/,
  )
})

test("login-checkin: loginProfile returns the site's profile and token", async () => {
  const { fetchImpl } = makeFetch({
    "GET /api/status": STATUS,
    "POST /api/user/login": () =>
      json({
        success: true,
        data: {
          id: 100001,
          username: "github_100001",
          email: "a@b.c",
          quota: 2_500_000,
          access_token: "tok",
        },
      }),
  })

  const out = await loginProfile({
    baseUrl: "https://site.test",
    username: "a@b.c",
    password: "pw",
    fetchImpl,
  })

  assert.equal(out.token, "tok")
  assert.equal(out.profile.userId, 100001)
  assert.equal(out.profile.username, "github_100001")
  assert.equal(out.profile.siteName, "Example Site")
  assert.equal(out.profile.balance, 5)
})

test("login-checkin: loginProfile reports a refused password as auth", async () => {
  const { fetchImpl } = makeFetch({
    "GET /api/status": STATUS,
    "POST /api/user/login": () => json({ success: false, message: "无效的参数" }),
  })

  await assert.rejects(
    loginProfile({ baseUrl: "https://site.test", username: "a", password: "pw", fetchImpl }),
    /无效的参数/,
  )
})
