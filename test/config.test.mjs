import test from "node:test"
import assert from "node:assert/strict"

import {
  buildCustomRequest,
  endpointFrom,
  fillPlaceholders,
  normalizeCustomConfig,
  parseHeaderInput,
  validateCustomConfig,
} from "../lib/config.mjs"
import {
  balanceOf,
  creditOf,
  getByPath,
  looseNumber,
  shiftDay,
  streakFromRecords,
  streakOf,
} from "../lib/values.mjs"

test("headers can be JSON, Key: Value pairs, lines, or a raw cookie", () => {
  assert.deepEqual(parseHeaderInput('{"Authorization":"Bearer {token}","X-N":1}'), {
    Authorization: "Bearer {token}",
    "X-N": "1",
  })
  assert.deepEqual(parseHeaderInput("X-A: 1; X-B: 2"), { "X-A": "1", "X-B": "2" })
  assert.deepEqual(parseHeaderInput("X-A: 1\nX-B: 2"), { "X-A": "1", "X-B": "2" })
  assert.deepEqual(parseHeaderInput("session=abc; acw_tc=1"), {
    Cookie: "session=abc; acw_tc=1",
  })
  assert.deepEqual(parseHeaderInput("Cookie: a=b; c=d"), { Cookie: "a=b; c=d" })
  assert.deepEqual(parseHeaderInput(""), {})
  assert.throws(() => parseHeaderInput("garbage"), /Key: Value/)
  assert.throws(() => parseHeaderInput("Bad Name: x"), /不允许的字符/)
})

test("placeholders are filled without touching JSON braces", () => {
  const vars = { token: "tok", userid: "7", bearer: "Bearer tok", username: "alice" }
  assert.equal(
    fillPlaceholders('{"a":"{token}","b":"{userId}","c":"{nope}"}', vars),
    '{"a":"tok","b":"7","c":"{nope}"}',
  )
  assert.equal(fillPlaceholders('{"a":1,"b":[2,3]}', vars), '{"a":1,"b":[2,3]}')
  assert.equal(fillPlaceholders("{TOKEN}", vars), "tok")
  assert.equal(fillPlaceholders("{bearer}", vars), "Bearer tok")
})

test("endpoints accept paths, absolute URLs and placeholders", () => {
  assert.equal(endpointFrom("https://site.test/", "/api/x", {}), "https://site.test/api/x")
  assert.equal(endpointFrom("https://site.test", "api/x", {}), "https://site.test/api/x")
  assert.equal(endpointFrom("https://site.test", "https://other.test/x", {}), "https://other.test/x")
  assert.equal(
    endpointFrom("https://site.test", "{baseUrl}/custom", { baseurl: "https://site.test" }),
    "https://site.test/custom",
  )
  assert.throws(() => endpointFrom("https://site.test", "", {}), /空的/)
})

test("a saved custom configuration can be nested or flat", () => {
  const flat = normalizeCustomConfig({
    customUrl: "/x",
    customMethod: "get",
    customHeaders: "X-A: 1",
    customBody: '{"a":1}',
    customCreditDivisor: "500,000",
    customNoToken: true,
  })
  assert.equal(flat.url, "/x")
  assert.equal(flat.method, "GET")
  assert.deepEqual(flat.headers, { "X-A": "1" })
  assert.equal(flat.body, '{"a":1}')
  assert.equal(flat.creditDivisor, 500_000)
  assert.equal(flat.noToken, true)

  const nested = normalizeCustomConfig({
    custom: {
      method: "PATCH",
      url: "/nested",
      headers: { "X-B": 2 },
      body: "a=1",
      success: "ok",
      already: "done",
      creditField: "data.credit",
    },
    customUrl: "/flat",
  })
  assert.equal(nested.method, "PATCH")
  assert.equal(nested.url, "/nested")
  assert.deepEqual(nested.headers, { "X-B": "2" })
  assert.equal(nested.success, "ok")
  assert.equal(nested.already, "done")
  assert.equal(nested.creditField, "data.credit")
})

test("a broken saved header list is dropped, not thrown", () => {
  const config = normalizeCustomConfig({ custom: { url: "/x", headers: "garbage" } })
  assert.deepEqual(config.headers, {})
})

test("sign-in validation catches the mistakes worth catching", () => {
  const good = validateCustomConfig(
    {
      customMethod: "POST",
      customUrl: "/api/checkin",
      customHeaders: '{"Authorization":"Bearer {token}"}',
      customBody: '{"user":"{userId}"}',
      customCreditField: "data.reward",
      customCreditDivisor: "500000",
      customBalanceUrl: "/api/self",
      customBalanceField: "data.quota",
      customBalanceDivisor: "500000",
    },
    { token: "tok" },
  )
  assert.equal(good.method, "POST")
  assert.equal(good.creditDivisor, 500_000)
  assert.equal(good.noToken, false)

  assert.throws(() => validateCustomConfig({ customUrl: "" }), /签到接口地址/)
  assert.throws(
    () => validateCustomConfig({ customUrl: "/x", customMethod: "GET", customBody: "{}" }),
    /不会携带请求体/,
  )
  assert.throws(
    () => validateCustomConfig({ customUrl: "/x", customBody: "{bad" }),
    /有效的 JSON/,
  )
  assert.throws(
    () => validateCustomConfig({ customUrl: "/x", customCreditDivisor: "0" }),
    /大于 0/,
  )
  assert.throws(
    () => validateCustomConfig({ customUrl: "/x", customHeaders: "garbage" }),
    /Key: Value/,
  )
  assert.equal(validateCustomConfig({ customUrl: "/x" }, { token: "" }).noToken, true)
})

test("a custom request applies auth defaults, headers, body and content type", () => {
  const account = {
    baseUrl: "https://site.test",
    token: "tok",
    userId: 7,
    username: "alice",
    apiKey: "sk-1",
    cookie: false,
  }
  const request = buildCustomRequest(account, {
    method: "POST",
    url: "/custom",
    headers: { "X-Token": "{token}", "New-API-User": "{userId}" },
    body: '{"user":"{username}"}',
  })
  assert.equal(request.url, "https://site.test/custom")
  assert.equal(request.method, "POST")
  assert.equal(request.headers.Authorization, "Bearer tok")
  assert.equal(request.headers["X-Token"], "tok")
  assert.equal(request.headers["New-API-User"], "7")
  assert.equal(request.headers["Content-Type"], "application/json")
  assert.equal(request.body, '{"user":"alice"}')

  const ownAuth = buildCustomRequest(account, {
    method: "POST",
    url: "/custom",
    headers: { Authorization: "Token {token}" },
    body: "a=1&b=2",
  })
  assert.equal(ownAuth.headers.Authorization, "Token tok")
  assert.equal(ownAuth.headers["Content-Type"], "application/x-www-form-urlencoded")

  const cookie = buildCustomRequest(
    { ...account, token: "session=abc", cookie: true },
    { method: "GET", url: "/state", headers: {}, body: "{}" },
  )
  assert.equal(cookie.headers.Cookie, "session=abc")
  assert.equal(cookie.headers.Authorization, undefined)
  assert.equal(cookie.body, undefined)
})

test("values read paths and money-like numbers", () => {
  assert.equal(looseNumber("$0.20"), 0.2)
  assert.equal(looseNumber("1,234.56"), 1234.56)
  assert.equal(looseNumber("0.2 USD"), 0.2)
  assert.equal(looseNumber("abc"), undefined)
  assert.equal(getByPath({ data: { items: [{ amount: 3 }] } }, "data.items[0].amount"), 3)
  assert.equal(getByPath({ data: { items: [{ amount: 3 }] } }, "$.data.items.0.amount"), 3)
  assert.equal(
    getByPath({ data: { items: [{ amount: 3 }] } }, 'data["items"][0]["amount"]'),
    3,
  )
  assert.equal(getByPath({ a: 1 }, "a.b"), undefined)
})

test("credit, balance and streak pick the common fields", () => {
  assert.equal(creditOf({ data: { reward: "$0.20" } }), 0.2)
  assert.equal(creditOf({ data: { quota_awarded: 100_000 } }, "data.quota_awarded", 500_000), 0.2)
  assert.equal(creditOf({ data: { rewardAmount: "1.5" } }), 1.5)
  assert.equal(balanceOf({ code: 0, data: 0 }), 0)
  assert.equal(balanceOf({ data: { quota: 2_500_000 } }, "data.quota", 500_000), 5)
  assert.equal(streakOf({ data: { continuous_days: 5 } }), 5)
  assert.equal(streakOf({ data: { streak: 3 } }, "data.streak"), 3)
})

test("streaks are counted back from today's records", () => {
  assert.equal(shiftDay("2026-03-01", -1), "2026-02-28")
  const records = [
    { checkin_date: "2026-03-01" },
    { checkin_date: "2026-02-28" },
    { checkin_date: "2026-02-27" },
    { checkin_date: "2026-02-25" },
  ]
  assert.equal(streakFromRecords(records, "2026-03-01"), 3)
  assert.equal(streakFromRecords(records, "2026-02-26"), 0)
})
