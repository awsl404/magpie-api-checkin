# 更新记录

## 0.3.0 — 2026-11-24

### 新增

- **重新登录自动沿用上次配置**：账号失效后重新登录时，插件会读取 Magpie 的 `plugin-auth.json` 中本插件（`api-checkin` / `api-checkin#...`）已有账号，先问要沿用哪个账号，再问沿用方式。
  - **只更新访问令牌（推荐）**：URL、站点类型、Header、Body、备注、用户 ID、API Key 全部保留，只重新输入令牌；令牌留空则继续使用上次的令牌。
  - **沿用上次令牌，重新填写请求配置**：URL、站点类型、Header、Body 等可以改，令牌保留；留空的项继续使用上次的值。
  - **完全沿用上次配置（包括令牌）**：不再询问其他问题，直接用上次的配置重新登录。
  - **重新填写全部**：回到原来的逐项提问流程，用于新增账号或彻底改配置。
- 沿用后仍使用原账号名（备注/用户名 · 域名），因此会**覆盖原账号**，不会新增重复账号。
- 重新登录成功时同时更新 `key` 与 `metadata.token`，两处令牌保持一致。
- 新增 `lib/saved.mjs`：只读取本插件自己的账号条目，不复制令牌到新文件，不向任何第三方发送。
- 新增 `test/reuse.test.mjs`：覆盖账号读取、选择流程、只更新令牌、只改请求但保留令牌、完全沿用、无令牌自定义账号、账号消失等场景。
- 请求模式（保留令牌，修改 URL/平台/Header/Body）逐项留空即沿用上次值；平台和请求方法提供「保持上次」按钮。

### 修复

- URL / 自定义接口地址的输入校验允许留空，这样重新登录时留空会沿用上次值；必填校验改到合并旧配置后的 `authorize` 阶段执行。

### 文档

- README 新增「账号失效 / 重新登录」章节。
- 新增本 `CHANGELOG.md`，记录各版本更新列表。
- 测试数量从 75 增加到 **85**，全部通过。

### 验证

- 真实 Magpie **0.1.4685**（隔离配置目录 + 本地 mock 站点）：
  - `magpie plugin login api-checkin` 首先显示「检测到之前登录过的 API 签到账号，要沿用上次配置吗？」
  - 选择「只更新访问令牌」并输入新令牌 → 登录成功，请求使用 `Bearer new-token`，`key` 与 `metadata.token` 都是新令牌，仍然只有一个账号。
  - 选择「完全沿用上次配置（包括令牌）」→ 不再询问令牌，直接使用旧令牌登录成功。
  - 选择「沿用上次令牌，重新填写请求配置」，URL 留空、平台选「保持上次」、其余留空 → 登录成功，请求仍使用旧令牌。

## 0.2.0 — 2026-10-26

### 新增

- **自定义接口签到**：站点类型新增「自定义接口」，可配置请求方法、URL、Header、Body、成功/已签到关键词、奖励字段/除数、连续天数字段、余额地址/字段/除数。
- URL、Header 值、Body 支持占位符：`{token}`、`{bearer}`、`{cookie}`、`{userId}`、`{username}`、`{apiKey}`、`{baseUrl}`、`{host}`、`{label}`、`{date}`、`{month}`、`{timestamp}`、`{iso}`。
- 自定义响应判断：已签到标记、验证码、签到关闭、权限、令牌失效、限流、404/405、5xx、Cloudflare HTML、常见 JSON `success`/`ok`/`code`/`ret`/`status`/`error` 信封。
- 自定义余额读取；也可在自定义签到之外沿用自动识别出的 new-api/sub2api 余额。
- 无令牌自定义账号支持：令牌留空，把认证写进自定义 Header。
- 内置 new-api/sub2api 签到结果增加连续天数（`streak`）。

### 改进

- 抽出 `lib/messages.mjs`、`lib/results.mjs`、`lib/values.mjs`、`lib/config.mjs`、`lib/custom.mjs`。
- new-api 的「今日已签到」判断优先于 `success: true`，避免魔改站点误报为本次领取。
- 文档补充自动签到开关、结果展示、自定义接口示例和故障排查。
- 测试数量从 41 增加到 75。

### 验证

- 真实 Magpie **0.1.1560** + 本地 mock 自定义站点：
  - `magpie accounts checkin` → `checked in today +0.2 · a 4-day streak`
  - 同日再次执行 → `already`，不再发请求
  - `magpie quota` → 自定义余额按字段/除数显示
  - 打开插件自动签到后，网关约 105 秒自动签到成功

## 0.1.0 — 2026-10-25

### 新增

- new-api / one-api / sub2api / sub2api Pro 的每日签到适配。
- 余额读取：new-api 按 `quota_per_unit` 换算美元，sub2api 直接 USD。
- 通过 Magpie 的 `auth.checkin` 钩子自动签到，结果在用量页和 `magpie accounts checkin` 中显示。
- 可选 `sk-` API Key：把站点当作普通模型供应商使用。
- 41 个单元测试和本地 HTTP mock 测试。
