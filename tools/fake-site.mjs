// 一个最小的假站点，模仿 agentrouter.org 的签到行为，供 tools/verify-set-login.mjs 用。
//   node tools/fake-site.mjs <port> <password>
// 收到正确的密码就加 25 USD 额度并回 checked_in: true；额度记在内存里。

import http from "node:http"
import process from "node:process"

const port = Number(process.argv[2] || 21874)
const password = process.argv[3] || "demo-password"
const perUnit = 500_000
let quota = 1_000_000
let logins = 0

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x")
  const send = (body) => {
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify(body))
  }

  if (url.pathname === "/api/status") {
    return send({
      data: { system_name: "Agent Router", quota_per_unit: perUnit, turnstile_check: false },
    })
  }
  if (url.pathname === "/api/user/self") {
    return send({ success: true, data: { id: 100001, quota } })
  }
  if (url.pathname === "/api/user/login" && req.method === "POST") {
    let raw = ""
    req.on("data", (c) => (raw += c))
    req.on("end", () => {
      let body = {}
      try {
        body = JSON.parse(raw || "{}")
      } catch {
        return send({ success: false, message: "无效的参数" })
      }
      console.log(`login attempt username=${body.username} password-ok=${body.password === password}`)
      if (body.password !== password) {
        return send({ success: false, message: "用户名或密码错误，或用户已被封禁" })
      }
      logins += 1
      quota += 25 * perUnit
      return send({
        success: true,
        message: "",
        data: {
          id: 100001,
          username: "github_100001",
          email: "user@example.com",
          quota,
          access_token: "tok-fresh",
          checked_in: true,
          streak: 7,
        },
      })
    })
    return
  }
  if (url.pathname === "/__stats") {
    return send({ quota, logins })
  }
  res.writeHead(404, { "Content-Type": "application/json" })
  res.end(JSON.stringify({ success: false, message: "not found" }))
})

server.listen(port, "127.0.0.1", () => console.log(`fake site on http://127.0.0.1:${port}`))
