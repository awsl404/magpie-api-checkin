import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"

import plugin from "../index.mjs"
import { NO_TOKEN_KEY } from "../lib/auth.mjs"
import { inputsFromSaved, savedApiCheckinAccounts } from "../lib/saved.mjs"

const { server: createPlugin } = plugin

async function withAuth(auth, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "magpie-reuse-"))
  const magpie = path.join(dir, "magpie")
  fs.mkdirSync(magpie, { recursive: true })
  fs.writeFileSync(path.join(magpie, "plugin-auth.json"), JSON.stringify(auth, null, 2))
  const old = process.env.XDG_CONFIG_HOME
  process.env.XDG_CONFIG_HOME = dir
  try {
    await run(dir)
  } finally {
    if (old === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = old
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

async function withServer(routes, run) {
  const calls = []
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1")
    req.on("data", () => {})
    req.on("end", () => {
      calls.push({ method: req.method, path: url.pathname, headers: req.headers })
      const handler = routes[`${req.method} ${url.pathname}`]
      if (!handler) {
        res.writeHead(404, { "content-type": "application/json" })
        res.end(JSON.stringify({ code: 404, message: "not found" }))
        return
      }
      const out = handler(req)
      res.writeHead(out.status ?? 200, { "content-type": "application/json" })
      res.end(JSON.stringify(out.json))
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

function newApiAuth(baseUrl) {
  const host = new URL(baseUrl).host
  return {
    "api-checkin": {
      type: "api",
      key: "old-token",
      metadata: {
        baseUrl,
        url: baseUrl,
        platform: "new-api",
        userId: 7,
        username: "tester",
        email: `tester · ${host}`,
        label: "",
        apiKey: "",
        token: "old-token",
        detectedAt: "2026-01-01T00:00:00.000Z",
      },
    },
  }
}

function newApiRoutes() {
  return {
    "GET /api/status": () => ({
      json: { success: true, data: { system_name: "Demo", quota_per_unit: 500_000 } },
    }),
    "GET /api/user/self": () => ({
      json: { success: true, data: { id: 7, username: "tester", quota: 250_000 } },
    }),
  }
}

function twoUserRoutes() {
  return {
    "GET /api/status": () => ({
      json: { success: true, data: { system_name: "Demo", quota_per_unit: 500_000 } },
    }),
    "GET /api/user/self": (req) => {
      const auth = req.headers.authorization
      if (auth === "Bearer token-a") {
        return { json: { success: true, data: { id: 7, username: "alice", quota: 500_000 } } }
      }
      if (auth === "Bearer token-b") {
        return { json: { success: true, data: { id: 9, username: "bob", quota: 500_000 } } }
      }
      return { status: 401, json: { success: false, message: "unauthorized" } }
    },
  }
}

test("saved accounts are read from plugin-auth.json without another token copy", async () => {
  await withAuth(newApiAuth("https://api.example.com"), async () => {
    const accounts = await savedApiCheckinAccounts()
    assert.equal(accounts.length, 1)
    assert.equal(accounts[0].sourceKey, "api-checkin")
    assert.equal(accounts[0].token, "old-token")
    assert.equal(accounts[0].platform, "new-api")
    assert.equal(accounts[0].email, "tester · api.example.com")
    const inputs = inputsFromSaved(accounts[0])
    assert.equal(inputs.url, "https://api.example.com")
    assert.equal(inputs.platform, "new-api")
    assert.equal(inputs.label, "tester")
    assert.equal(inputs.userId, "7")
  })
})

test("a saved custom endpoint becomes the flat re-login answers", async () => {
  const auth = {
    "api-checkin": {
      type: "api",
      key: NO_TOKEN_KEY,
      metadata: {
        baseUrl: "https://custom.test",
        url: "https://custom.test",
        platform: "custom",
        email: "自定义站 · custom.test",
        label: "自定义站",
        username: "",
        token: "",
        custom: {
          method: "POST",
          url: "/custom/checkin",
          headers: { "X-Key": "secret" },
          body: '{"day":"{date}"}',
          success: "签到成功",
          already: "已签到",
          creditField: "data.reward",
          creditDivisor: 2,
          balanceUrl: "/balance",
          balanceField: "data.amount",
          balanceDivisor: 4,
          noToken: true,
        },
      },
    },
  }
  await withAuth(auth, async () => {
    const accounts = await savedApiCheckinAccounts()
    assert.equal(accounts.length, 1)
    assert.equal(accounts[0].token, "")
    const inputs = inputsFromSaved(accounts[0])
    assert.equal(inputs.platform, "custom")
    assert.equal(inputs.customUrl, "/custom/checkin")
    assert.equal(inputs.customHeaders, '{"X-Key":"secret"}')
    assert.equal(inputs.customCreditDivisor, "2")
    assert.equal(inputs.customBalanceUrl, "/balance")
    assert.equal(inputs.customBalanceDivisor, "4")

    const hooks = await createPlugin({ client: {} }, {})
    const method = await hooks.auth.methods[0].ask({
      _reuse_action: "reuse",
      _reuse_account: "api-checkin",
      _reuse_mode: "request",
      url: "https://custom.test",
      platform: "custom",
      label: "",
      userId: "",
      apiKey: "",
    })
    assert.equal(method.key, "customMethod")
    assert.ok(method.options.some((option) => option.label.includes("保持上次")))
  })
})

test("new accounts are the default; saved sites appear only after choosing re-login", async () => {
  await withAuth(newApiAuth("https://api.example.com"), async () => {
    const hooks = await createPlugin({ client: {} }, {})
    const method = hooks.auth.methods[0]

    const action = await method.ask({})
    assert.equal(action.key, "_reuse_action")
    assert.deepEqual(
      action.options.map((option) => option.value),
      ["new", "reuse"],
    )
    assert.match(action.options[0].label, /添加新账号/)
    // The default, new-account path starts at the site URL, with no saved
    // site list in front of it.
    assert.equal((await method.ask({ _reuse_action: "new" })).key, "url")

    const account = await method.ask({ _reuse_action: "reuse" })
    assert.equal(account.key, "_reuse_account")
    assert.ok(account.options.some((option) => option.value === "api-checkin"))
    assert.ok(account.options.some((option) => option.value === "new"))

    const reuse = { _reuse_action: "reuse", _reuse_account: "api-checkin" }
    const mode = await method.ask(reuse)
    assert.equal(mode.key, "_reuse_mode")
    assert.deepEqual(
      mode.options.map((option) => option.value),
      ["edit", "token", "request", "all", "new"],
    )

    const edit = await method.ask({ ...reuse, _reuse_mode: "edit" })
    assert.equal(edit.key, "url")
    assert.equal(edit.placeholder, "https://api.example.com")
    const editToken = await method.ask({
      ...reuse,
      _reuse_mode: "edit",
      url: "https://api.example.com",
      platform: "new-api",
    })
    assert.equal(editToken.key, "token")
    assert.match(editToken.placeholder, /••••oken/)

    const request = await method.ask({ ...reuse, _reuse_mode: "request" })
    assert.equal(request.key, "url")
    assert.equal(request.placeholder, "https://api.example.com")
    const platform = await method.ask({
      ...reuse,
      _reuse_mode: "request",
      url: "https://api.example.com",
    })
    assert.equal(platform.key, "platform")
    assert.ok(platform.options.some((option) => option.label.includes("保持上次")))
    const afterPlatform = await method.ask({
      ...reuse,
      _reuse_mode: "request",
      url: "https://api.example.com",
      platform: "new-api",
    })
    // The token is kept in this mode, so the next question is the label.
    assert.equal(afterPlatform.key, "label")
    assert.equal(afterPlatform.placeholder, "tester")

    const token = await method.ask({ ...reuse, _reuse_mode: "token" })
    assert.equal(token.key, "token")
    assert.equal(token.type, "password")
    assert.match(token.placeholder, /••••oken/)

    assert.equal(await method.ask({ ...reuse, _reuse_mode: "token", token: "new" }), null)
    assert.equal(await method.ask({ ...reuse, _reuse_mode: "all" }), null)
    assert.equal(
      (await method.ask({ _reuse_action: "reuse", _reuse_account: "new" })).key,
      "url",
    )
    assert.equal((await method.ask({ ...reuse, _reuse_mode: "new" })).key, "url")
  })
})

test("with no saved accounts the normal sign-in questions are asked", async () => {
  await withAuth({}, async () => {
    const hooks = await createPlugin({ client: {} }, {})
    const first = await hooks.auth.methods[0].ask({})
    assert.equal(first.key, "url")
  })
})

test("adding a new account never resolves saved reuse fields", async () => {
  await withServer(newApiRoutes(), async (base, calls) => {
    await withAuth(newApiAuth(base), async () => {
      const hooks = await createPlugin({ client: {} }, {})
      const signed = await hooks.auth.methods[0].authorize({
        _reuse_action: "new",
        _reuse_account: "api-checkin",
        _reuse_mode: "all",
        url: base,
        platform: "new-api",
        token: "new-token",
        label: "",
        userId: "",
        apiKey: "",
      })
      assert.equal(signed.type, "success")
      assert.equal(signed.key, "new-token")
      assert.equal(signed.metadata.token, "new-token")
      const self = calls.find((call) => call.path === "/api/user/self")
      assert.equal(self.headers.authorization, "Bearer new-token")
    })
  })
})

test("edit mode keeps every blank answer on the saved value", async () => {
  await withServer(newApiRoutes(), async (base, calls) => {
    await withAuth(newApiAuth(base), async () => {
      const hooks = await createPlugin({ client: {} }, {})
      const signed = await hooks.auth.methods[0].authorize({
        _reuse_action: "reuse",
        _reuse_account: "api-checkin",
        _reuse_mode: "edit",
        url: base,
        platform: "new-api",
        token: "",
        label: "",
        userId: "",
        apiKey: "",
      })
      assert.equal(signed.type, "success")
      assert.equal(signed.key, "old-token")
      assert.equal(signed.metadata.token, "old-token")
      assert.equal(signed.metadata.email, `tester · ${new URL(base).host}`)
      const self = calls.find((call) => call.path === "/api/user/self")
      assert.equal(self.headers.authorization, "Bearer old-token")
    })
  })
})

test("a token and a different user id are refused", async () => {
  await withServer(newApiRoutes(), async (base) => {
    await withAuth({}, async () => {
      const hooks = await createPlugin({ client: {} }, {})
      const signed = await hooks.auth.methods[0].authorize({
        url: base,
        platform: "new-api",
        token: "tok",
        userId: "9",
        label: "",
        apiKey: "",
      })
      assert.equal(signed.type, "failed")
      assert.match(signed.error, /用户 ID 与令牌不匹配/)
      assert.match(signed.error, /#7/)
      assert.match(signed.error, /#9/)
    })
  })
})

test("one site can host several users with their own token and id", async () => {
  await withServer(twoUserRoutes(), async (base) => {
    await withAuth({}, async () => {
      const hooks = await createPlugin({ client: {} }, {})
      const alice = await hooks.auth.methods[0].authorize({
        url: base,
        platform: "new-api",
        token: "token-a",
        userId: "7",
        label: "",
        apiKey: "",
      })
      const bob = await hooks.auth.methods[0].authorize({
        url: base,
        platform: "new-api",
        token: "token-b",
        userId: "9",
        label: "",
        apiKey: "",
      })
      assert.equal(alice.type, "success")
      assert.equal(bob.type, "success")
      assert.equal(alice.key, "token-a")
      assert.equal(bob.key, "token-b")
      assert.match(alice.metadata.email, /^alice · /)
      assert.match(bob.metadata.email, /^bob · /)
      assert.notEqual(alice.metadata.email, bob.metadata.email)
    })
  })
})

test("reuse all keeps the old token and the account name", async () => {
  await withServer(newApiRoutes(), async (base, calls) => {
    await withAuth(newApiAuth(base), async () => {
      const hooks = await createPlugin({ client: {} }, {})
      const signed = await hooks.auth.methods[0].authorize({
        _reuse_action: "reuse",
        _reuse_account: "api-checkin",
        _reuse_mode: "all",
      })
      assert.equal(signed.type, "success")
      assert.equal(signed.key, "old-token")
      assert.equal(signed.metadata.token, "old-token")
      assert.equal(signed.metadata.platform, "new-api")
      assert.equal(signed.metadata.email, `tester · ${new URL(base).host}`)
      assert.equal(signed.metadata.baseUrl, base)
      const self = calls.find((call) => call.path === "/api/user/self")
      assert.equal(self.headers.authorization, "Bearer old-token")
    })
  })
})

test("update-token uses the new token and keeps everything else", async () => {
  await withServer(newApiRoutes(), async (base, calls) => {
    await withAuth(newApiAuth(base), async () => {
      const hooks = await createPlugin({ client: {} }, {})
      const signed = await hooks.auth.methods[0].authorize({
        _reuse_action: "reuse",
        _reuse_account: "api-checkin",
        _reuse_mode: "token",
        token: "new-token",
      })
      assert.equal(signed.type, "success")
      assert.equal(signed.key, "new-token")
      assert.equal(signed.metadata.token, "new-token")
      assert.equal(signed.metadata.email, `tester · ${new URL(base).host}`)
      const self = calls.find((call) => call.path === "/api/user/self")
      assert.equal(self.headers.authorization, "Bearer new-token")
    })
  })
})

test("request mode changes the request but keeps the saved token", async () => {
  await withServer(newApiRoutes(), async (base, calls) => {
    await withAuth(newApiAuth(base), async () => {
      const hooks = await createPlugin({ client: {} }, {})
      const signed = await hooks.auth.methods[0].authorize({
        _reuse_action: "reuse",
        _reuse_account: "api-checkin",
        _reuse_mode: "request",
        url: base,
        platform: "new-api",
        label: "tester-renamed",
      })
      assert.equal(signed.type, "success")
      assert.equal(signed.key, "old-token")
      assert.equal(signed.metadata.token, "old-token")
      assert.equal(signed.metadata.email, `tester-renamed · ${new URL(base).host}`)
      const self = calls.find((call) => call.path === "/api/user/self")
      assert.equal(self.headers.authorization, "Bearer old-token")
    })
  })
})

test("an empty new token falls back to the saved one", async () => {
  await withServer(newApiRoutes(), async (base, calls) => {
    await withAuth(newApiAuth(base), async () => {
      const hooks = await createPlugin({ client: {} }, {})
      const signed = await hooks.auth.methods[0].authorize({
        _reuse_action: "reuse",
        _reuse_account: "api-checkin",
        _reuse_mode: "token",
        token: "",
      })
      assert.equal(signed.type, "success")
      assert.equal(signed.key, "old-token")
      assert.equal(signed.metadata.token, "old-token")
      const self = calls.find((call) => call.path === "/api/user/self")
      assert.equal(self.headers.authorization, "Bearer old-token")
    })
  })
})

test("a tokenless custom account reuses its complete request", async () => {
  const auth = {
    "api-checkin": {
      type: "api",
      key: NO_TOKEN_KEY,
      metadata: {
        baseUrl: "https://custom.test",
        url: "https://custom.test",
        platform: "custom",
        email: "自定义站 · custom.test",
        label: "自定义站",
        username: "",
        token: "",
        custom: {
          method: "POST",
          url: "/custom/checkin",
          headers: { "X-Key": "secret" },
          body: '{"day":"{date}"}',
          success: "签到成功",
          noToken: true,
        },
      },
    },
  }
  await withAuth(auth, async () => {
    const hooks = await createPlugin({ client: {} }, {})
    const signed = await hooks.auth.methods[0].authorize({
      _reuse_action: "reuse",
      _reuse_account: "api-checkin",
      _reuse_mode: "all",
    })
    assert.equal(signed.type, "success")
    assert.equal(signed.key, NO_TOKEN_KEY)
    assert.equal(signed.metadata.token, "")
    assert.equal(signed.metadata.platform, "custom")
    assert.equal(signed.metadata.email, "自定义站 · custom.test")
    assert.equal(signed.metadata.custom.url, "/custom/checkin")
    assert.deepEqual(signed.metadata.custom.headers, { "X-Key": "secret" })
    assert.equal(signed.metadata.custom.noToken, true)
  })
})

test("a chosen account that disappeared asks for a refill instead of guessing", async () => {
  await withAuth({}, async () => {
    const hooks = await createPlugin({ client: {} }, {})
    const signed = await hooks.auth.methods[0].authorize({
      _reuse_action: "reuse",
      _reuse_account: "api-checkin",
      _reuse_mode: "all",
    })
    assert.equal(signed.type, "failed")
    assert.match(signed.error, /重新填写全部/)
  })
})