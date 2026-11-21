// 把一个已有账号改成「登录式签到」：补上站点登录密码，顺带刷新令牌并验证。
//
// 用法（在插件目录下）：
//   node tools/set-login.mjs                          列出所有 api-checkin 账号
//   node tools/set-login.mjs "user@example.com"   为该账号设置密码（交互输入，不回显）
//   node tools/set-login.mjs --all                    逐个设置所有还没配置密码的账号
//   node tools/set-login.mjs --as <站点登录名> ...      站点登录名与账号标签不同时指定
//   node tools/set-login.mjs --dir <配置目录> ...       指定 magpie 配置目录
//
// 写完后立刻用同一份凭据发一次登录请求，把结果打印出来，确认真的能签到。
// 密码只在本进程内存里出现，不打印、不写日志。

import { copyFile, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import process from "node:process"

import { accountOf, loginNameOf } from "../lib/auth.mjs"
import { loginCheckin, loginProfile } from "../lib/login-checkin.mjs"

const PROVIDER = "api-checkin"

function argValue(argv, flag) {
  const i = argv.indexOf(flag)
  return i >= 0 && argv[i + 1] ? argv[i + 1].trim() : ""
}

/**
 * One keypress stream for the whole run.
 *
 * Opening a fresh `for await` iterator per question would end the previous one,
 * and with it the listener, so the second account would never see its typing.
 * This keeps a single listener and hands out one finished line per question.
 */
let ttyPartial = ""
const ttyLines = []
let ttyNotify = null
let ttyStarted = false

function ttyStart() {
  const { stdin } = process
  stdin.setRawMode(true)
  stdin.setEncoding("utf8")
  stdin.resume()
  stdin.on("data", (chunk) => {
    for (const char of chunk) {
      if (char === "\u0003") {
        process.stdout.write("\n")
        process.exit(130)
      }
      if (char === "\r" || char === "\n") {
        ttyLines.push(ttyPartial)
        ttyPartial = ""
        process.stdout.write("\n")
        const notify = ttyNotify
        ttyNotify = null
        if (notify) notify()
        continue
      }
      if (char === "\u007f" || char === "\b") {
        if (ttyPartial) {
          ttyPartial = ttyPartial.slice(0, -1)
          process.stdout.write("\b \b")
        }
        continue
      }
      ttyPartial += char
      process.stdout.write("*")
    }
  })
}

function ttyLine(prompt) {
  process.stdout.write(prompt)
  return new Promise((resolve) => {
    if (ttyLines.length) {
      resolve(ttyLines.shift())
      return
    }
    ttyNotify = () => resolve(ttyLines.shift())
  })
}

/** 读一个密码：终端里不回显，管道里则读一行（剩下的行留给下一个账号）。 */
let piped = ""
async function askPassword(prompt) {
  const { stdin } = process
  if (!stdin.isTTY) {
    if (!piped) {
      const chunks = []
      for await (const chunk of stdin) chunks.push(chunk)
      piped = Buffer.concat(chunks).toString("utf8")
    }
    const [line, ...rest] = piped.split(/\r?\n/)
    piped = rest.join("\n")
    return line.trim()
  }
  if (!ttyStarted) {
    ttyStart()
    ttyStarted = true
  }
  return ttyLine(prompt)
}

function isLoginAccount(metadata) {
  return metadata?.checkinMode === "login" && Boolean(metadata?.loginPassword)
}

/**
 * Which directory Magpie keeps plugin-auth.json in.
 *
 * %USERPROFILE% is what Magpie itself uses on Windows, and it stays right even
 * when HOME was pointed somewhere else for this shell; homedir() is the fallback
 * for every other platform. --dir overrides both.
 */
async function configDir(argv) {
  const forced = argValue(argv, "--dir")
  if (forced) return forced
  const candidates = [process.env.USERPROFILE, homedir()]
    .filter(Boolean)
    .map((home) => path.join(home, ".config", "magpie"))
  for (const dir of [...new Set(candidates)]) {
    try {
      await readFile(path.join(dir, "plugin-auth.json"), "utf8")
      return dir
    } catch {
      // Try the next one; the last candidate is reported if none works.
    }
  }
  return candidates[candidates.length - 1]
}

async function main() {
  const argv = process.argv.slice(2)
  const dir = await configDir(argv)
  const loginAs = argValue(argv, "--as")
  const file = path.join(dir, "plugin-auth.json")

  let store
  try {
    store = JSON.parse(await readFile(file, "utf8"))
  } catch (error) {
    console.error(`读不到 ${file}：${error.message}`)
    process.exit(1)
  }

  const keys = Object.keys(store).filter((k) => k === PROVIDER || k.startsWith(`${PROVIDER}#`))
  if (!keys.length) {
    console.error(`${file} 里没有 ${PROVIDER} 的账号。`)
    process.exit(1)
  }

  const positional = argv.filter(
    (a) => !a.startsWith("--") && a !== dir && a !== loginAs,
  )
  const all = argv.includes("--all")

  if (!positional.length && !all) {
    console.log(`配置文件：${file}\n`)
    for (const key of keys) {
      const md = store[key].metadata || {}
      const name = md.label || md.username || ""
      console.log(
        `  ${key.padEnd(24)} ${String(name).padEnd(28)} ${isLoginAccount(md) ? "已是登录式签到" : "未配置登录式签到"}`,
      )
    }
    console.log('\n用法：node tools/set-login.mjs "<上面某一行的标签或用户名>"')
    return
  }

  let targets
  if (all) {
    targets = keys.filter((k) => !isLoginAccount(store[k].metadata))
    if (!targets.length) {
      console.log("所有账号都已配置登录式签到。")
      return
    }
  } else {
    const wanted = positional.join(" ").toLowerCase()
    targets = keys.filter((k) => {
      const md = store[k].metadata || {}
      return [k, md.label, md.username, md.email, md.loginUsername]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(wanted))
    })
    if (!targets.length) {
      console.error(`没有匹配「${positional.join(" ")}」的账号。先不带参数跑一次看列表。`)
      process.exit(1)
    }
  }

  await copyFile(file, `${file}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`)

  // 写成功的账号，最后回读文件确认没有被别的进程覆盖。
  const saved = []
  for (const key of targets) {
    const entry = store[key]
    const md = entry.metadata || {}
    const username = loginAs || loginNameOf(md)
    console.log(`\n=== ${key}  (${md.label || username}) ===`)
    if (!md.baseUrl) {
      console.log("  跳过：metadata 里没有 baseUrl。")
      continue
    }
    console.log(`  站点：${md.baseUrl}`)
    console.log(`  登录名：${username}`)
    const password = await askPassword("  站点登录密码（输入不回显）：")
    if (!password) {
      console.log("  跳过：没有输入密码。")
      continue
    }

    // 先用这份凭据真登录一次：既验证密码，也拿到新令牌和站点资料。
    let probe
    try {
      probe = await loginProfile({ baseUrl: md.baseUrl, username, password })
    } catch (error) {
      console.log(`  失败：${error.message}`)
      continue
    }

    entry.metadata = {
      ...md,
      platform: "new-api",
      checkinMode: "login",
      loginUsername: username,
      loginPassword: password,
      token: probe.token || md.token || "",
      userId: probe.profile.userId || md.userId,
      username: probe.profile.username || md.username,
      siteName: probe.profile.siteName || md.siteName || "",
      quotaPerUnit: probe.profile.quotaPerUnit || md.quotaPerUnit || 500_000,
      detectedAt: new Date().toISOString(),
    }
    await writeFile(file, `${JSON.stringify(store, null, 2)}\n`, "utf8")
    saved.push(key)
    console.log(`  已保存。站点：${entry.metadata.siteName || md.baseUrl}`)

    // 写完立刻跑一次真正的签到，把结论摆出来。
    const outcome = await loginCheckin(accountOf({ key, metadata: entry.metadata }))
    console.log(`  签到结果：${outcome.outcome} —— ${outcome.message}`)
  }

  if (!saved.length) {
    console.log("\n没有任何账号被改动。")
    return
  }

  const reread = JSON.parse(await readFile(file, "utf8"))
  const kept = saved.filter((k) => isLoginAccount(reread[k]?.metadata))
  console.log(`\n已确认写入：${kept.join("、")}`)
  if (kept.length < saved.length) {
    console.log("注意：有账号的改动没留在文件里，可能有别的进程正在覆盖它。")
  }
  console.log("如果 Magpie 正开着，重启一次让它重新读取账号配置。")
}

main()
  .then(() => {
    // Raw mode keeps the event loop alive; hand the terminal back before exiting.
    if (ttyStarted) {
      process.stdin.setRawMode(false)
      process.stdin.pause()
    }
    process.exit(0)
  })
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
