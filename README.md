# magpie-api-checkin

给 **new-api / one-api / sub2api** 以及**任意自定义接口**做每日自动签到的 Magpie 插件。签到由 Magpie 自己的插件签到框架执行：每个账号每个北京日一次、失败自动重试，结果直接显示在 **用量（Usage）** 页的账号卡片和 **设置 → 用量 → 插件** 里，卡片上还有余额和手动签到按钮。

- 不需要额外部署服务，也不需要自己写定时器
- 一个插件、一个供应商卡片，可以登录任意多个站点账号
- 内置 new-api / one-api / sub2api / sub2api Pro 适配器；其它站点可以用**自定义 URL + Header + Body** 签到
- 余额：new-api 按站点 `quota_per_unit` 换算成美元，sub2api 直接读 USD；自定义接口也能读任意余额字段
- 可选：登录时一并填写站点的 `sk-` API Key，就能把这个站点当作普通模型供应商在 Magpie 里使用

## 支持的站点

| 站点类型 | 签到接口（自动探测/使用） | 余额 |
| --- | --- | --- |
| new-api、one-api 及常见分支（veloera、done-hub、one-hub、voapi、riX 等） | `GET/POST /api/user/checkin`；Cookie 凭证时回退 `POST /api/user/sign_in` | `/api/user/self` |
| sub2api（定制签到） | `GET /api/v1/user/checkin/status` + `POST /api/v1/user/checkin` | `/api/v1/auth/me` |
| sub2api Pro | `GET /api/v1/redeem/checkin/status` + `POST /api/v1/redeem/checkin` | `/api/v1/auth/me` |
| **自定义接口** | 自己填请求方法、URL、Header、Body；响应规则也可配置 | 可选的自定义余额地址 |

说明：

- **sub2api 官方核心没有签到接口**。很多站点（Sub2API Pro、天才程序员、FreeAPI 等分支）自己加了签到，插件会按上面的路径自动探测；没有签到的站点会显示「站点没有签到接口」，不会反复失败。
- 使用完全自定义路径的站点（例如 `/checkin/api/checkin`、`/api/v1/tbe-sponsor-checkin/...`）现在**不需要改代码**：登录时把站点类型选成「自定义接口」，填上路径、Header 和 Body 即可。
- 插件**不会**也不应该绕过 Turnstile/验证码：站点要求人机校验时会显示 `captcha`，请在站点页面手动签到。

## 环境要求

- Magpie **0.1.1421 或更新**（插件签到钩子 `auth.checkin` 在 2026-10-06 加入；0.1.1560 上已核对返回契约）。
- 不需要 Node/npm；Magpie 自带 Bun 运行插件。仓库里的 `node --test` 只用于开发测试。

## 安装

从 GitHub 克隆后安装：

```bash
git clone https://github.com/awsl404/magpie-api-checkin.git
magpie plugin add ./magpie-api-checkin
```

应用内：**插件 → 添加插件**，填克隆下来的文件夹路径。

本地开发时也可以直接指向源码目录：

```bash
magpie plugin add "D:/AI-WorkSpace/mapgie插件开发/magpie-api-checkin"
```

加载后「插件」页会多出供应商 **API 签到**。它默认显示 **0 models** 是正常的：不填 `sk-` API Key 时它只负责签到和余额。

## 添加站点账号

在「插件」页的 **API 签到** 那一行点登录（或 `magpie plugin login api-checkin`），依次回答：

1. **站点地址**：`https://api.example.com`（粘贴带 `/v1` 或 `/api/v1` 的地址也可以，会自动去掉）
2. **站点类型**：`自动检测` / `new-api` / `sub2api` / `sub2api Pro` / `自定义接口`
3. **用户访问令牌 / JWT / Cookie**：见下面「怎么拿令牌」；自定义接口可以留空
4. **账号备注（可选）**：例如 `主站-Alice`；留空会用用户名
5. **用户 ID（可选）**：部分 one-api 分支要求 `New-API-User` 头，登录报「未提供用户 ID」时填这里
6. **站点 API Key（可选）**：`sk-…`；只影响「能不能在 Magpie 里调用该站模型」，不影响签到
7. 如果站点类型选了 **自定义接口**，还会继续问自定义签到和余额的字段（见下一节）

内置类型在登录时会立即访问站点校验令牌，并自动识别平台（new-api / sub2api / sub2api Pro）。自定义接口不做强制探测，但会顺手尝试识别 new-api/sub2api；识别成功时账号名和余额会自动沿用，识别失败也不影响自定义签到。

### new-api / one-api 的访问令牌

浏览器登录站点后任选一种：

- 站点页面 → 右上角头像 → **个人设置 / 控制台** → **访问令牌**（有的版本叫「系统访问令牌」）→ 复制
- 或按 F12 → **Application → Local Storage** → 找 `token` / `user` 之类的键，复制令牌值（通常是 `eyJ...` 的 JWT）
- 只认 Cookie 的站点，可以直接把 `session=...`（或 `token=...`）整段 Cookie 粘贴到令牌栏

> `sk-` 开头的是 **API Key**，不是用户访问令牌，不能用来签到；它应该填在最后的可选 API Key 一栏。

### sub2api 的 JWT

浏览器登录站点 → F12 → **Application → Local Storage** → 复制 `access_token`（或 `token`）的值（JWT）。sub2api 的 JWT 有有效期，过期后重新登录一次即可。

## 自定义接口签到（任意站点）

站点类型选「自定义接口」后，插件会多问下面这些字段。所有字段都可以用 `{占位符}`。

| 字段 | 说明 |
| --- | --- |
| 请求方法 | `POST`（最常用）、`GET`、`PUT`、`PATCH`、`DELETE`。`GET` 不会带请求体 |
| 接口地址 | 相对路径（`/api/user/checkin`）或完整 URL（`https://other.example/checkin`） |
| 请求头（可选） | JSON 对象，或 `Key: Value; Key2: Value2`，或直接粘一整段 Cookie（`session=...; acw_tc=...`） |
| 请求体（可选） | JSON（`{"a":1}`）、表单（`a=1&b=2`）或纯文本；会自动设置 Content-Type |
| 成功关键词（可选） | 响应里出现即视为签到成功；多个用 `|` 分隔，例如 `签到成功|success` |
| 已签到关键词（可选） | 响应里出现即视为今天已签过；多个用 `|` 分隔，例如 `今日已签到|already` |
| 奖励字段（可选） | JSON 路径，例如 `data.reward`、`data.quota_awarded` |
| 奖励换算除数（可选） | 默认 `1`；new-api 的 quota 填 `500000` |
| 连续天数字段（可选） | JSON 路径，例如 `data.streak`；留空会尝试 `streak` / `continuous_days` 等常见字段 |
| 余额地址（可选） | 相对路径或完整 URL；留空则不显示余额 |
| 余额字段（可选） | JSON 路径，例如 `data.quota`；留空会尝试 `balance` / `quota` / `remaining` 等常见字段 |
| 余额换算除数（可选） | 默认 `1`；new-api 的 quota 填 `500000` |

### 占位符

URL、Header 的值、Body 里都可以使用：

| 占位符 | 内容 |
| --- | --- |
| `{token}` | 登录时填的令牌原文 |
| `{bearer}` | `Bearer <token>`；Cookie 凭证时就是 Cookie 原文 |
| `{cookie}` | 令牌是 Cookie 时为其原文，否则为空 |
| `{userId}` | 用户 ID |
| `{username}` | 用户名（自动识别或登录时填的备注/用户名） |
| `{apiKey}` | 登录时填的 `sk-` API Key |
| `{baseUrl}` | 站点地址（已去掉 `/v1` 等后缀） |
| `{host}` | 站点域名 |
| `{label}` | 账号备注 |
| `{date}` / `{month}` | 本地日期 `2026-10-26` / `2026-10` |
| `{timestamp}` / `{iso}` | 毫秒时间戳 / ISO 时间 |

JSON 里的普通花括号不受影响（只有 `{字母开头的名字}` 会被替换），所以 `{"foo":1}` 原样保留。

请求头默认会带 `Accept: application/json`。如果令牌不是 Cookie，还会默认带 `Authorization: Bearer <token>`；一旦你在自定义请求头里自己写了 `Authorization`、`Cookie` 或 `X-API-Key`，就不再添加默认的 Authorization。

### 示例 1：魔改 new-api，签到在自定义路径

```text
站点类型：自定义接口
请求方法：POST
接口地址：/api/user/checkin
请求头：{"Authorization":"Bearer {token}","New-API-User":"{userId}"}
请求体：{}
成功关键词：签到成功
已签到关键词：已签到
奖励字段：data.quota_awarded
奖励换算除数：500000
余额地址：/api/user/self
余额字段：data.quota
余额换算除数：500000
```

### 示例 2：任意 JSON 接口

```text
站点类型：自定义接口
请求方法：POST
接口地址：https://example.com/api/checkin
请求头：{"X-Token":"{token}"}
请求体：{"user":"{username}"}
成功关键词：ok|success
已签到关键词：already
奖励字段：data.reward
余额地址：https://example.com/api/account
余额字段：data.balance
```

### 示例 3：只认 Cookie 的站点

```text
站点类型：自定义接口
令牌：session=xxxxxxxx; acw_tc=yyyy
请求方法：POST
接口地址：/checkin/api/checkin
请求体：{"type":"daily"}
成功关键词：签到成功
```

令牌粘成 Cookie 后，插件会默认发 `Cookie: session=...`，不需要再写请求头。

### 自定义响应怎么判断

按下面的顺序判断（配置的「已签到关键词」和「成功关键词」优先）：

1. 配置的「已签到关键词」、响应里的 `checked_in_today` / `already` / `new_reward:false`，或常见「已签到」文案 → `done`
2. 人机验证 / 验证码文案 → `captcha`
3. 签到关闭文案 → `inactive`
4. 权限不足文案，或 HTTP 403 且文案表示没权限 → `ineligible`
5. HTTP 401，或令牌失效文案 → `failed`
6. HTTP 429 / 限流文案 → `failed`
7. 配置的「成功关键词」出现在响应里 → `claimed`
8. HTTP 404/405 → `failed`，并提示检查自定义签到地址
9. HTTP 5xx → `failed`
10. 非 JSON 的 HTTP 2xx（纯文本）→ `claimed`
11. JSON 里 `success/ok: true`、`code/ret/errcode: 0/200`、`status: "ok"` 等 → `claimed`；`success/ok: false`、`error`、非 0/200 的 code → `failed`
12. 其余 HTTP 2xx → `claimed`（按接口成功处理）

如果站点用的成功标志比较特殊（例如 `code: 1` 表示成功），填一个「成功关键词」就能覆盖判断。

> 自定义配置只在登录时询问。要改 URL/Header/Body，请在该账号行用「重新登录 / Re-sign in」重新填一遍；直接改 `plugin-auth.json` 不推荐。

## 开启自动签到（重要）

Magpie 默认**不**给任何插件开启自动签到。添加账号后需要手动打开一次：

- **设置 → 用量 → 插件（Plugins）** → 找到 **API 签到** 的 **Daily check-in**，切到 **On**；或
- **用量（Usage）页** → 该账号卡片上的 **Auto check-in** 按钮

同一个插件的多个账号会出现每个账号的 Off/On 行，可以单独把某个账号排除在每日签到之外。

打开后的行为（Magpie 内置逻辑，不是插件的定时器）：

- Magpie（桌面应用或 `magpie serve` 网关）启动后约 **2 分钟**做第一次检查，之后约每 **30 分钟**一次
- 每个账号每个**北京日**只签一次
- 失败（`failed`）在之后的一次检查中重试；`claimed` / `done` / `inactive` / `ineligible` / `captcha` 当天不再重复请求
- 结果保存在 `~/.config/magpie/plugin-checkin.json`（Windows：`C:\Users\<你>\.config\magpie\plugin-checkin.json`）
- 只有 Magpie 在运行（桌面应用打开，或跑着 `magpie serve`）时才会自动签到；这是 Magpie 的设计

如果想手动立即签到（不受开关影响）：

```bash
magpie accounts checkin
```

或在账号卡片上点 **Check in now**。

## 结果怎么看

| 结果 | 含义 |
| --- | --- |
| `claimed` | 本次签到成功；`+x` 是奖励（new-api 换算成美元，sub2api 原样 USD，自定义按你填的字段/除数） |
| `done` | 今天已经签过 |
| `inactive` | 站点当前没有签到活动/没开签到/没有签到接口 |
| `ineligible` | 账号没有权限参与签到 |
| `captcha` | 站点要求 Turnstile/验证码，请到站点页面手动签到 |
| `failed` | 其他失败；Magpie 之后会再试 |

结果会显示在：

- **用量（Usage）页**账号卡片的签到行：今天是否签到、奖励、连续天数、失败原因
- **设置 → 用量 → 插件** 的 **API 签到 Daily check-in** 行
- `magpie accounts checkin` 的命令行输出
- `plugin-checkin.json` 的原始记录（最近一次结果和日期）

例如：

- `claimed` + `0.5` + `3 天连续` → 今天签到成功，奖励 $0.50，连续 3 天
- `done` → 今天已经签过，不会重复发请求
- `inactive` → 站点没开签到/没有该接口
- `failed: 自定义签到接口不存在（HTTP 404）…` → 自定义 URL 填错了，重新登录改地址

## 多账号 / 多站点

重复「添加站点账号」即可。每个账号名由「备注（或用户名）· 站点域名」组成，方便区分。同一个站点多个账号、不同站点混用都没问题。

要**更新某个账号的令牌或自定义配置**，请在该账号行用「重新登录 / Re-sign in」，不要重新添加，否则可能出现两条同名或重复的记录。Magpie 没有直接编辑令牌的表单：令牌属于登录凭据，只能通过重新登录替换。找不到「重新登录」时，先「退出登录 / Sign out」再重新添加同一站点也可以。

命令行等价做法（备注填成和原账号一样，会替换而不是新增）：

```bash
magpie plugin login api-checkin
```

## 可选：把站点当模型供应商用

登录时填了 `sk-` API Key 的账号，插件会调用站点的 `/v1/models`，把模型列进 Magpie，并把聊天请求发到 `${站点}/v1`。没填 API Key 的账号不会列出模型，也不会把用户访问令牌误当成 API Key 发给站点。

模型上下文长度默认按 131072 / 输出 8192 标记，仅作占位；具体模型的实际上下文以站点为准。

## 故障排查

| 现象 | 处理 |
| --- | --- |
| 登录失败「访问令牌被站点拒绝」 | 令牌错/过期；确认复制的是用户访问令牌而不是 `sk-`；只认 Cookie 的站点改贴 `session=...` |
| 签到提示「访问令牌已失效或没有权限（HTTP 403）」 | 403 **不一定**是令牌失效。很多魔改 new-api 把 `/api/user/checkin` 留作管理员接口（403），用户的签到在自定义路径；把站点类型换成「自定义接口」并填真实路径 |
| 「站点要求提供用户 ID」 | 重新登录，在「用户 ID」里填站点控制台里的数字 ID；自定义接口也可以把 ID 写进请求头，例如 `"New-API-User":"{userId}"` |
| 自定义接口返回 404/405 | 检查「接口地址」；相对路径要以 `/` 开头或直接填完整 URL。注意站点地址会自动去掉 `/v1`、`/api/v1` 后缀 |
| 自定义接口返回 401 | 令牌/ Cookie 不对，或站点要的是别的 Header；确认请求头里的认证方式和站点一致 |
| 自定义接口返回 403 | 可能是权限/管理员接口；确认这个路径对普通用户开放，或把站点要求的额外 Header 填上 |
| 签到明明成功却显示 `failed` | 站点用了特殊的成功标志（例如 `code: 1`）。填一个「成功关键词」，或检查 JSON 的 `success` / `code` / `status` 字段 |
| 提示「请求体不是有效的 JSON」 | 检查 JSON 引号和逗号；占位符放进字符串时要加引号，例如 `"user":"{userId}"` |
| 提示「GET 请求不会携带请求体」 | 把请求方法改成 POST / PUT / PATCH，或清空请求体 |
| 返回网页而不是 JSON / Cloudflare | 先在浏览器打开站点通过验证；或在 Magpie 里给该供应商/账号设代理（插件请求会走 Magpie 的代理设置） |
| 签到结果一直是 `inactive` | 站点没开签到、没有该接口，或签到在自定义路径（改用「自定义接口」）；sub2api 官方核心本来就没有签到 |
| `captcha` / 站点提示「Turnstile token 为空」 | 站点开了 Cloudflare Turnstile，插件不会破解人机验证，请到站点页面手动签到 |
| 自动签到没发生 | 确认 **设置 → 用量 → 插件** 里的 Daily check-in 已打开；多账号时确认该账号自己的开关也是 On；确认 Magpie 在运行；首次检查在启动约 2 分钟后 |
| 余额显示 `—` 或为空 | 内置站点看 `/api/user/self`、`/api/v1/auth/me` 是否返回余额；自定义接口检查「余额地址」「余额字段」「余额换算除数」 |
| 自定义配置改了没生效 | 重新登录该账号；配置保存在账号 metadata 里，只在登录时写入 |
| 供应商显示 0 models | 正常。只有填写 `sk-` API Key 的账号才会列模型 |
| 升级 Magpie 后卡片没有签到行 | 需要支持 `auth.checkin` 的版本（0.1.1421+） |

## 安全说明

- 访问令牌保存在 Magpie 的 `plugin-auth.json`（Unix 权限 600），签到结果在 `plugin-checkin.json`；插件不会把数据发往任何第三方，所有请求都直接发给你填写的站点。
- 自定义请求头和请求体也会写进账号 metadata（同一个文件）。不要把 `plugin-auth.json` 或包含令牌的截图发给别人。
- 自定义接口允许把请求发到另一个域名（例如余额接口），请只填你信任的地址。
- 由于 Magpie 的插件登录会把问题答案一并写进账号 `metadata`，令牌在 `plugin-auth.json` 里会出现两份（`key` 与 `metadata.token`），但都在同一个权限受控的文件里。
- 插件没有窗口页面，也不需要页面读取权限：站点的签到状态和按钮都在 Magpie 自带的用量页面里。

## 开发与测试

```bash
npm test        # Node >= 18，75 个测试，全部使用本地 mock，不需要网络
```

目录：

```
index.mjs            插件入口：供应商声明、登录问题、authorize、usage、checkin、models
lib/auth.mjs         URL 规范化、JWT、new-api/sub2api 请求头、账号标签
lib/config.mjs       自定义接口配置：Header 解析、占位符、校验、请求构造
lib/custom.mjs       自定义接口签到 + 余额读取 + 响应判断
lib/http.mjs         超时/错误归一化、消息提取
lib/messages.mjs     站点常见文案判断（已签到/验证码/权限/令牌/限流）
lib/platforms.mjs    平台探测 + new-api / sub2api / sub2api Pro 的签到、状态、余额
lib/results.mjs      Magpie auth.checkin 的返回形状（outcome/credit/streak/message）
lib/values.mjs       JSON 路径、金额/连续天数提取
test/                node:test 单元测试 + 本地 HTTP mock 端到端测试
```

### 已验证

- 单元测试与本地 HTTP mock：75/75 通过（Node 24）
- 从 Magpie **0.1.1560** 的插件宿主代码核对了 `auth.checkin` 契约：返回 `outcome`（`claimed` / `done` / `ineligible` / `inactive` / `captcha` / `failed`）、`credit`、`streak`、`message`；Magpie 按北京日调度，并在失败后重试
- 真实 Magpie **0.1.1560** + 本地 mock 的自定义站点（隔离配置目录）：
  - `magpie accounts checkin` → `API 签到 自定义站 · 127.0.0.1 checked in today +0.2 · a 4-day streak`
  - 同一天再次执行 → 显示 `already`，不再发 HTTP 请求
  - `magpie quota` → `自定义接口 · 自定义站 · 127.0.0.1  subscription  $2.00 left`（自定义余额字段 ÷ 除数）
  - 打开 `pluginCheckins["api-checkin"]` 后运行 `magpie web --gateway`，约 **105 秒**后自动签到成功，日志：`plugin check-in: 自定义站 · 127.0.0.1 +0.2, a 4-day streak`
- 此前在真实 Magpie `0.1.1421` + 本地 mock 的 new-api 与 sub2api 站点上实测过内置站点的登录、余额、手动签到和自动签到
- 自定义接口的 URL/Header/Body 占位符、奖励/余额字段与除数、检测到 new-api 后继续用自定义路径签到，均有插件级 mock 覆盖

## 发布

`package.json` 已带 `magpie.icon` 和 `opencode-plugin` / `magpie` / `checkin` / `custom-checkin` 等关键词。仓库已推送到 GitHub 并打了 `magpie-plugin` topic，Magpie 的「插件 → 发现 → 非官方插件 · GitHub」会收录（仓库根目录有 `package.json`，入口和 `lib/` 都随源码提交）。

也可以照常 `npm publish`；如果要进社区 registry，还需要把包名改成 `@magpie-community/opencode-<name>-auth` 的约定形式（provider 插件），并给社区仓库的 `registry.json` 提 PR。

## License

MIT
