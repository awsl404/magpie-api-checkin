import test from "node:test"
import assert from "node:assert/strict"

import {
  NO_TOKEN_KEY,
  accountOf,
  decodeJwt,
  displayLabel,
  isCookieCredential,
  jwtExpired,
  jwtUserId,
  jwtUsername,
  newApiHeaders,
  normalizeBaseUrl,
  usd,
} from "../lib/auth.mjs"

function b64url(value) {
  return Buffer.from(JSON.stringify(value))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
}

function jwt(payload) {
  return `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url(payload)}.signature`
}

test("normalizeBaseUrl keeps the origin and strips API suffixes", () => {
  assert.equal(normalizeBaseUrl("https://api.example.com/"), "https://api.example.com")
  assert.equal(normalizeBaseUrl("https://api.example.com/v1"), "https://api.example.com")
  assert.equal(normalizeBaseUrl("https://api.example.com/api/v1/"), "https://api.example.com")
  assert.equal(normalizeBaseUrl("api.example.com"), "https://api.example.com")
  assert.equal(normalizeBaseUrl("http://127.0.0.1:8080/sub/"), "http://127.0.0.1:8080/sub")
  assert.throws(() => normalizeBaseUrl(""), /请填写站点地址/)
  assert.throws(() => normalizeBaseUrl("ftp://example.com"), /http/)
})

test("cookie credentials are told from bearer tokens", () => {
  assert.equal(isCookieCredential("session=abc; acw_tc=1"), true)
  assert.equal(isCookieCredential("jwt_token=abc"), true)
  assert.equal(isCookieCredential("sk-abc123"), false)
  assert.equal(isCookieCredential(jwt({ id: 1 })), false)
})

test("JWT payloads give the user id and expiry", () => {
  const good = jwt({ id: 42, exp: Math.floor(Date.now() / 1000) + 3600 })
  const old = jwt({ user_id: 7, exp: Math.floor(Date.now() / 1000) - 10 })
  assert.equal(jwtUserId(good), 42)
  assert.equal(jwtUserId(old), 7)
  assert.equal(jwtUserId("sk-opaque"), undefined)
  assert.equal(jwtExpired(good), false)
  assert.equal(jwtExpired(old), true)
  assert.equal(jwtExpired("sk-opaque"), false)
  assert.deepEqual(decodeJwt(good).id, 42)
})

test("a JWT username is a fallback display name", () => {
  assert.equal(jwtUsername(jwt({ username: "alice" })), "alice")
  assert.equal(jwtUsername(jwt({ name: "Bob" })), "Bob")
  assert.equal(jwtUsername(jwt({ email: "a@b.test" })), "a@b.test")
  assert.equal(jwtUsername("sk-opaque"), "")
})

test("new-api headers carry a bearer token or a cookie, plus the user id", () => {
  const bearer = newApiHeaders("Bearer abc", 42)
  assert.equal(bearer.Authorization, "Bearer abc")
  assert.equal(bearer["New-API-User"], "42")
  assert.equal(bearer["Veloera-User"], "42")
  assert.equal(bearer["X-User-Id"], "42")

  const cookie = newApiHeaders("session=abc", 7)
  assert.equal(cookie.Cookie, "session=abc")
  assert.equal(cookie.Authorization, undefined)
  assert.equal(cookie["New-API-User"], "7")
})

test("displayLabel names an account by label, username or token tail", () => {
  assert.equal(
    displayLabel({ label: "主站", baseUrl: "https://api.example.com", username: "alice", token: "x" }),
    "主站 · api.example.com",
  )
  assert.equal(
    displayLabel({ baseUrl: "https://api.example.com", username: "alice", token: "x" }),
    "alice · api.example.com",
  )
  assert.equal(
    displayLabel({ baseUrl: "https://api.example.com", userId: 9, token: "x" }),
    "#9 · api.example.com",
  )
  assert.equal(
    displayLabel({ baseUrl: "https://api.example.com", token: "abcd1234" }),
    "1234 · api.example.com",
  )
  assert.equal(displayLabel({ baseUrl: "https://api.example.com", token: "" }), "api.example.com")
})

test("usd formats balances", () => {
  assert.equal(usd(0), "$0.00")
  assert.equal(usd(0.005), "<$0.01")
  assert.equal(usd(1.234), "$1.23")
  assert.equal(usd(1234.5), "$1,234.50")
  assert.equal(usd(undefined), "")
})

test("accountOf reads Magpie's auth object", () => {
  const token = jwt({ id: 11 })
  const account = accountOf({
    type: "api",
    key: token,
    metadata: {
      baseUrl: "https://api.example.com",
      platform: "new-api",
      quotaPerUnit: 500000,
      apiKey: "sk-1",
      username: "alice",
    },
  })
  assert.equal(account.baseUrl, "https://api.example.com")
  assert.equal(account.platform, "new-api")
  assert.equal(account.userId, 11)
  assert.equal(account.apiKey, "sk-1")
  assert.equal(account.token, token)
  assert.equal(account.cookie, false)
})

test("accountOf keeps a custom endpoint config, including tokenless accounts", () => {
  const tokenless = accountOf({
    type: "api",
    key: NO_TOKEN_KEY,
    metadata: {
      baseUrl: "https://custom.test",
      platform: "custom",
      detectedPlatform: "new-api",
      userId: 11,
      username: "alice",
      custom: {
        method: "POST",
        url: "/checkin",
        headers: { "X-Key": "{token}" },
        body: '{"u":"{userId}"}',
        success: "ok",
        creditDivisor: "500,000",
        balanceUrl: "/self",
      },
    },
  })
  assert.equal(tokenless.platform, "custom")
  assert.equal(tokenless.detectedPlatform, "new-api")
  assert.equal(tokenless.token, "")
  assert.equal(tokenless.noToken, true)
  assert.equal(tokenless.custom.method, "POST")
  assert.equal(tokenless.custom.url, "/checkin")
  assert.deepEqual(tokenless.custom.headers, { "X-Key": "{token}" })
  assert.equal(tokenless.custom.body, '{"u":"{userId}"}')
  assert.equal(tokenless.custom.success, "ok")
  assert.equal(tokenless.custom.creditDivisor, 500_000)
  assert.equal(tokenless.custom.balanceUrl, "/self")

  const withToken = accountOf({
    type: "api",
    key: "custom-token",
    metadata: {
      baseUrl: "https://custom.test",
      platform: "custom",
      custom: { url: "/checkin", noToken: false },
    },
  })
  assert.equal(withToken.token, "custom-token")
  assert.equal(withToken.noToken, false)
})
