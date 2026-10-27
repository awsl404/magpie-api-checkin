import test from "node:test"
import assert from "node:assert/strict"
import http from "node:http"

import plugin from "../index.mjs"

const { server: createPlugin } = plugin

async function withServer(run) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1")
    const send = (status, body, type = "application/json") => {
      res.writeHead(status, { "content-type": type })
      res.end(type === "application/json" ? JSON.stringify(body) : body)
    }
    if (req.method === "GET" && url.pathname === "/api/v1/auth/me") {
      return send(200, {
        code: 0,
        data: { id: 5, username: "dev", email: "dev@example.com", balance: 12.5 },
      })
    }
    if (req.method === "GET" && url.pathname === "/api/v1/redeem/checkin/status") {
      return send(404, "not found", "text/plain")
    }
    if (req.method === "GET" && url.pathname === "/api/v1/user/checkin/status") {
      return send(200, { code: 0, data: { enabled: true, checked_in_today: false } })
    }
    if (req.method === "POST" && url.pathname === "/api/v1/user/checkin") {
      return send(200, { code: 0, message: "ok", data: { new_reward: true, reward_amount: 0.2 } })
    }
    if (req.method === "GET" && url.pathname === "/v1/models") {
      return send(200, { object: "list", data: [{ id: "model-a" }, { id: "model-b" }] })
    }
    send(404, { code: 404, message: "not found" })
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    await run(base)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

test("the manifest declares one keyless sign-in with the site questions", async () => {
  const hooks = await createPlugin({ client: {} }, {})
  assert.equal(hooks.auth.provider, "api-checkin")
  assert.equal(hooks.auth.methods.length, 1)
  const method = hooks.auth.methods[0]
  assert.equal(method.type, "api")
  assert.equal(method.keyless, true)
  const keys = method.prompts.map((p) => p.key)
  assert.deepEqual(keys.slice(0, 6), ["url", "platform", "token", "label", "userId", "apiKey"])
  assert.deepEqual(keys.slice(6), [
    "customMethod",
    "customUrl",
    "customHeaders",
    "customBody",
    "customSuccess",
    "customAlready",
    "customCreditField",
    "customCreditDivisor",
    "customStreakField",
    "customBalanceUrl",
    "customBalanceField",
    "customBalanceDivisor",
  ])
  const platform = method.prompts.find((p) => p.key === "platform")
  assert.ok(platform.options.some((option) => option.value === "custom"))
  for (const prompt of method.prompts) {
    if (!prompt.when) continue
    assert.deepEqual(prompt.when, { key: "platform", op: "eq", value: "custom" })
  }
  assert.equal(typeof method.authorize, "function")
  assert.equal(typeof hooks.auth.usage, "function")
  assert.equal(typeof hooks.auth.checkin, "function")
  assert.equal(typeof hooks.auth.loader, "function")
  assert.equal(hooks.provider.id, "api-checkin")
})

test("config declares the provider without overwriting a user's entry", async () => {
  const hooks = await createPlugin({ client: {} }, {})
  const empty = {}
  await hooks.config(empty)
  assert.equal(empty.provider["api-checkin"].name, "API 签到")
  assert.equal(empty.provider["api-checkin"].npm, "@ai-sdk/openai-compatible")

  const custom = { provider: { "api-checkin": { name: "Mine" } } }
  await hooks.config(custom)
  assert.equal(custom.provider["api-checkin"].name, "Mine")
})

test("a sign-in detects sub2api, names the account and keeps the token", async () => {
  await withServer(async (base) => {
    const toasts = []
    const hooks = await createPlugin(
      { client: { tui: { showToast: async ({ body }) => toasts.push(body) } } },
      {},
    )
    const result = await hooks.auth.methods[0].authorize({
      url: `${base}/`,
      token: "test-token-1234567890",
      platform: "auto",
      label: "开发站",
      userId: "",
      apiKey: "",
    })
    assert.equal(result.type, "success")
    assert.equal(result.key, "test-token-1234567890")
    assert.equal(result.metadata.platform, "sub2api")
    assert.equal(result.metadata.userId, 5)
    assert.equal(result.metadata.username, "dev")
    assert.match(result.metadata.email, /^开发站 · 127\.0\.0\.1/)
    assert.equal(toasts.length, 1)
  })
})

test("authorize rejects a missing token before asking the network", async () => {
  const hooks = await createPlugin({ client: {} }, {})
  const result = await hooks.auth.methods[0].authorize({
    url: "https://api.example.com",
    token: "",
    platform: "auto",
  })
  assert.equal(result.type, "failed")
  assert.match(result.error, /访问令牌/)
})

test("authorize rejects an unknown platform", async () => {
  const hooks = await createPlugin({ client: {} }, {})
  const result = await hooks.auth.methods[0].authorize({
    url: "https://api.example.com",
    token: "test-token-1234567890",
    platform: "wat",
  })
  assert.equal(result.type, "failed")
  assert.match(result.error, /未知的站点类型/)
})

test("usage and checkin work from the saved sign-in", async () => {
  await withServer(async (base) => {
    const hooks = await createPlugin({ client: {} }, {})
    const signed = await hooks.auth.methods[0].authorize({
      url: base,
      token: "test-token-1234567890",
      platform: "auto",
      label: "",
      userId: "",
      apiKey: "",
    })
    const auth = { type: "api", key: signed.key, metadata: signed.metadata }
    const getAuth = async () => auth

    const usage = await hooks.auth.usage(getAuth)
    assert.equal(usage.balance, "$12.50")
    assert.equal(usage.plan, "sub2api")
    assert.equal(usage.error, "")

    const checkin = await hooks.auth.checkin(getAuth)
    assert.equal(checkin.outcome, "claimed")
    assert.equal(checkin.credit, 0.2)
  })
})

test("the loader gives each account its own base URL and never its access token", async () => {
  const hooks = await createPlugin({ client: {} }, {})
  const loader = hooks.auth.loader
  const noKey = await loader(async () => ({
    type: "api",
    key: "access-token",
    metadata: { baseUrl: "https://api.example.com", platform: "new-api" },
  }))
  assert.equal(noKey.baseURL, "https://api.example.com/v1")
  assert.equal(noKey.apiKey, "no-api-key-set")

  const withKey = await loader(async () => ({
    type: "api",
    key: "access-token",
    metadata: { baseUrl: "https://api.example.com", platform: "new-api", apiKey: "sk-test" },
  }))
  assert.equal(withKey.apiKey, "sk-test")
})

test("models are listed only for an account that brought an sk- key", async () => {
  await withServer(async (base) => {
    const hooks = await createPlugin({ client: {} }, {})
    const given = { models: {} }

    const noKey = await hooks.provider.models(given, {
      auth: { type: "api", key: "access-token", metadata: { baseUrl: base, platform: "new-api" } },
    })
    assert.equal(noKey, given.models)

    const listed = await hooks.provider.models(given, {
      auth: {
        type: "api",
        key: "access-token",
        metadata: { baseUrl: base, platform: "new-api", apiKey: "sk-test" },
      },
    })
    assert.deepEqual(Object.keys(listed), ["model-a", "model-b"])
    assert.equal(listed["model-a"].api.url, `${base}/v1`)
    assert.equal(listed["model-a"].providerID, "api-checkin")
  })
})
