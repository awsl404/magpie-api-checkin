import test from "node:test"
import assert from "node:assert/strict"
import http from "node:http"

import plugin from "../index.mjs"
import { NO_TOKEN_KEY } from "../lib/auth.mjs"

const { server: createPlugin } = plugin

async function withServer(routes, run) {
  const calls = []
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1")
    let body = ""
    req.on("data", (chunk) => {
      body += chunk
    })
    req.on("end", async () => {
      calls.push({ method: req.method, path: url.pathname, headers: req.headers, body })
      const handler = routes[`${req.method} ${url.pathname}`]
      if (!handler) {
        res.writeHead(404, { "content-type": "application/json" })
        res.end(JSON.stringify({ code: 404, message: "not found" }))
        return
      }
      try {
        const out = await handler({ url, req, body })
        res.writeHead(out.status ?? 200, { "content-type": "application/json" })
        res.end(JSON.stringify(out.json))
      } catch (error) {
        res.writeHead(500, { "content-type": "application/json" })
        res.end(JSON.stringify({ message: String(error?.message ?? error) }))
      }
    })
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    await run(base, calls)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

test("a tokenless custom sign-in checks in and reads its own balance", async () => {
  const routes = {
    "POST /custom/checkin": () => ({
      json: { success: true, message: "签到成功", data: { reward: 0.2 } },
    }),
    "GET /custom/balance": () => ({ json: { code: 0, data: { amount: 4 } } }),
  }
  await withServer(routes, async (base, calls) => {
    const hooks = await createPlugin({ client: {} }, {})
    const signed = await hooks.auth.methods[0].authorize({
      url: base,
      platform: "custom",
      token: "",
      label: "自定义站",
      userId: "",
      apiKey: "",
      customMethod: "POST",
      customUrl: "/custom/checkin",
      customHeaders: '{"X-Key":"{token}"}',
      customBody: '{"day":"{date}"}',
      customSuccess: "签到成功",
      customAlready: "",
      customCreditField: "data.reward",
      customCreditDivisor: "",
      customStreakField: "",
      customBalanceUrl: "/custom/balance",
      customBalanceField: "data.amount",
      customBalanceDivisor: "2",
    })
    assert.equal(signed.type, "success")
    assert.equal(signed.key, NO_TOKEN_KEY)
    assert.equal(signed.metadata.platform, "custom")
    assert.equal(signed.metadata.detectedPlatform, "")
    assert.equal(signed.metadata.custom.method, "POST")
    assert.equal(signed.metadata.custom.url, "/custom/checkin")
    assert.equal(signed.metadata.custom.noToken, true)
    assert.match(signed.metadata.email, /自定义站 · 127\.0\.0\.1/)

    const getAuth = async () => ({ type: "api", key: signed.key, metadata: signed.metadata })
    const usage = await hooks.auth.usage(getAuth)
    assert.equal(usage.balance, "$2.00")
    assert.equal(usage.plan, "自定义接口")
    assert.equal(usage.error, "")

    const checkin = await hooks.auth.checkin(getAuth)
    assert.equal(checkin.outcome, "claimed")
    assert.equal(checkin.credit, 0.2)

    const press = calls.find((call) => call.method === "POST" && call.path === "/custom/checkin")
    assert.ok(press)
    assert.equal(press.headers["x-key"], "")
    assert.match(press.body, /^\{"day":"\d{4}-\d{2}-\d{2}"\}$/)
    const balance = calls.find((call) => call.method === "GET" && call.path === "/custom/balance")
    assert.ok(balance)
  })
})

test("a custom check-in keeps a detected new-api balance", async () => {
  const routes = {
    "GET /api/status": () => ({
      json: {
        success: true,
        data: { system_name: "Demo", checkin_enabled: true, quota_per_unit: 500_000 },
      },
    }),
    "GET /api/user/self": () => ({
      json: { success: true, data: { id: 7, username: "alice", quota: 250_000 } },
    }),
    "POST /custom/checkin": () => ({
      json: { success: true, message: "签到成功", data: { quota_awarded: 100_000 } },
    }),
    // If the adapter wrongly used the standard new-api press this would win.
    "POST /api/user/checkin": () => ({
      json: { success: true, message: "standard", data: { quota_awarded: 1 } },
    }),
  }
  await withServer(routes, async (base, calls) => {
    const hooks = await createPlugin({ client: {} }, {})
    const signed = await hooks.auth.methods[0].authorize({
      url: base,
      platform: "custom",
      token: "access-token-123456",
      label: "",
      userId: "",
      apiKey: "",
      customMethod: "POST",
      customUrl: "/custom/checkin",
      customHeaders: "",
      customBody: "{}",
      customSuccess: "",
      customAlready: "",
      customCreditField: "data.quota_awarded",
      customCreditDivisor: "500000",
      customStreakField: "",
      customBalanceUrl: "",
      customBalanceField: "",
      customBalanceDivisor: "",
    })
    assert.equal(signed.type, "success")
    assert.equal(signed.metadata.platform, "custom")
    assert.equal(signed.metadata.detectedPlatform, "new-api")
    assert.equal(signed.metadata.userId, 7)
    assert.equal(signed.metadata.username, "alice")
    assert.equal(signed.metadata.siteName, "Demo")

    const getAuth = async () => ({ type: "api", key: signed.key, metadata: signed.metadata })
    const usage = await hooks.auth.usage(getAuth)
    assert.equal(usage.balance, "$0.50")
    assert.equal(usage.plan, "Demo")

    const checkin = await hooks.auth.checkin(getAuth)
    assert.equal(checkin.outcome, "claimed")
    assert.equal(checkin.credit, 0.2)
    assert.equal(
      calls.some((call) => call.method === "POST" && call.path === "/api/user/checkin"),
      false,
    )
    assert.ok(calls.some((call) => call.method === "POST" && call.path === "/custom/checkin"))
  })
})

test("a custom sign-in requires its endpoint and a body-free GET", async () => {
  const hooks = await createPlugin({ client: {} }, {})
  const authorize = (inputs) =>
    hooks.auth.methods[0].authorize({
      url: "https://api.example.com",
      platform: "custom",
      token: "",
      ...inputs,
    })

  const missing = await authorize({ customUrl: "" })
  assert.equal(missing.type, "failed")
  assert.match(missing.error, /签到接口地址/)

  const getWithBody = await authorize({ customUrl: "/x", customMethod: "GET", customBody: "{}" })
  assert.equal(getWithBody.type, "failed")
  assert.match(getWithBody.error, /不会携带请求体/)

  const badHeaders = await authorize({ customUrl: "/x", customHeaders: "garbage" })
  assert.equal(badHeaders.type, "failed")
  assert.match(badHeaders.error, /Key: Value/)
})

test("a standard platform still requires the access token", async () => {
  const hooks = await createPlugin({ client: {} }, {})
  const result = await hooks.auth.methods[0].authorize({
    url: "https://api.example.com",
    platform: "new-api",
    token: "",
    label: "",
    userId: "",
    apiKey: "",
  })
  assert.equal(result.type, "failed")
  assert.match(result.error, /访问令牌/)
})
