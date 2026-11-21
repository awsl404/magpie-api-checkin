import test from "node:test"
import assert from "node:assert/strict"

import {
  NO_TOKEN_KEY,
  accountOf,
  decodeJwt,
  displayLabel,
  isLoginCheckin,
  isCookieCredential,
  jwtExpired,
  jwtUserId,
  loginNameOf,
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

test("a login-keyed account keeps its own token and never reads the key as one", () => {
  const keyed = accountOf({
    type: "api",
    key: "login:user@example.com",
    metadata: {
      baseUrl: "https://api.example.com",
      platform: "new-api",
      checkinMode: "login",
      loginUsername: "user@example.com",
      loginPassword: "pw",
      token: "tok-from-login",
    },
  })
  // The key names the account; the token it logs in with lives in metadata.
  assert.equal(keyed.token, "tok-from-login")
  assert.equal(keyed.noToken, false)
  assert.equal(keyed.checkinMode, "login")
  assert.equal(keyed.loginCheckin.username, "user@example.com")
  assert.equal(keyed.loginCheckin.password, "pw")

  const bare = accountOf({
    type: "api",
    key: "login:user@example.com",
    metadata: {
      baseUrl: "https://api.example.com",
      checkinMode: "login",
      loginUsername: "user@example.com",
      loginPassword: "pw",
    },
  })
  // No token yet: the login still works and the key is not mistaken for one.
  assert.equal(bare.token, "")
  assert.equal(bare.noToken, true)
  assert.equal(isLoginCheckin(bare), true)
})

test("two login-style accounts never share one key", () => {
  const a = accountOf({
    key: "login:a@test",
    metadata: { checkinMode: "login", loginUsername: "a@test", loginPassword: "1" },
  })
  const b = accountOf({
    key: "login:b@test",
    metadata: { checkinMode: "login", loginUsername: "b@test", loginPassword: "2" },
  })
  assert.notEqual(a.loginCheckin.username, b.loginCheckin.username)
  assert.equal(a.loginCheckin.password, "1")
  assert.equal(b.loginCheckin.password, "2")
})

test("a login-style account signs in with its e-mail, not an OAuth handle", () => {
  // What Magpie already stores for accounts added before login-style check-in
  // existed: label/email hold the e-mail, username is the internal handle.
  const account = accountOf({
    key: "api-checkin",
    metadata: {
      baseUrl: "https://api.example.com",
      platform: "new-api",
      userId: 100001,
      username: "github_100001",
      label: "user@example.com",
      email: "user@example.com · api.example.com",
      checkinMode: "login",
      loginPassword: "pw",
    },
  })
  assert.equal(account.loginCheckin.username, "user@example.com")

  // An explicitly stored login name always wins over the derived one.
  assert.equal(
    loginNameOf({ loginUsername: "me@x.com", label: "other@y.com", username: "h" }),
    "me@x.com",
  )
  // Magpie's naming field can carry a " · host" suffix; the host is not part of
  // the login name.
  assert.equal(
    loginNameOf({ email: "a@b.com · api.example.com" }),
    "a@b.com",
  )
  // Nothing e-mail shaped: fall back to whatever name is there.
  assert.equal(loginNameOf({ username: "github_1" }), "github_1")
  assert.equal(loginNameOf({}), "")
})
