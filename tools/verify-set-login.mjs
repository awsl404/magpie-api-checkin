// tools/set-login.mjs 的端到端验证（分两步，由 shell 串起来，因为本沙箱禁止 node 起子进程）。
//
//   node tools/verify-set-login.mjs prepare <假站点地址>   写好临时 plugin-auth.json，打印目录
//   node tools/verify-set-login.mjs check  <目录> <密码>   读回文件并逐项断言
//
// 中间由 shell 跑真正的 set-login：
//   printf '<密码>\n' | node tools/set-login.mjs --dir <目录> "user@example.com"

import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import process from "node:process"

const DIR = path.resolve(".verify-tmp")
const FILE = path.join(DIR, "plugin-auth.json")
const PER_UNIT = 500_000

async function prepare(baseUrl) {
  await mkdir(DIR, { recursive: true })
  await writeFile(
    FILE,
    JSON.stringify(
      {
        "api-checkin": {
          type: "api",
          key: "old-token",
          metadata: {
            platform: "new-api",
            baseUrl,
            userId: 100001,
            username: "github_100001",
            label: "user@example.com",
            siteName: "Agent Router",
            quotaPerUnit: PER_UNIT,
            apiKey: "",
          },
        },
        "api-checkin#b": {
          type: "api",
          key: "other-token",
          metadata: {
            platform: "new-api",
            baseUrl,
            userId: 200002,
            username: "linuxdo_200002",
            label: "second@example.com",
            quotaPerUnit: PER_UNIT,
          },
        },
      },
      null,
      2,
    ),
  )
  console.log(DIR)
}

async function check(password) {
  const saved = JSON.parse(await readFile(FILE, "utf8"))
  const md = saved["api-checkin"].metadata
  const other = saved["api-checkin#b"].metadata
  const checks = [
    ["checkinMode 写入 login", md.checkinMode === "login"],
    ["登录密码写入", md.loginPassword === password],
    // The e-mail wins over the internal OAuth handle, so a password login is
    // entered exactly the way a person would do it on the site.
    ["登录名取邮箱", md.loginUsername === "user@example.com"],
    ["令牌被登录刷新", md.token === "tok-fresh"],
    ["userId 保留", md.userId === 100001],
    ["站点名保留", md.siteName === "Agent Router"],
    ["另一个账号未被改动", other.checkinMode === undefined && other.loginPassword === undefined],
  ]
  for (const [name, ok] of checks) console.log(`${ok ? "✔" : "✘"} ${name}`)
  if (!checks.every(([, ok]) => ok)) process.exit(1)
}

const [phase, a, b] = process.argv.slice(2)
if (phase === "prepare") await prepare(a)
else if (phase === "check") await check(b)
else {
  console.error("用法：prepare <基址> | check <目录> <密码>")
  process.exit(2)
}
