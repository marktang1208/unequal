# state-m7-d — settings 页 + /api-auth-me + 多用户隔离可见 PASS

> 日期: 2026-06-23
> 前置: state-v2.4-zhenjie6.md (commit d0eecdc) — retry 流程优化
> 状态: ✅ 新建 minipgm `pages/settings/` + 后端 `/api-auth-me` + chat 页 ⚙ 入口
> **真接**: 511/511 tests PASS + API 真接 200/401/404 路由正确

## 1. 验收结果

| 维度 | 状态 |
|---|---|
| 后端 `/api-auth-me` handler | ✅ 新建 (apps/api/src/handlers/api-auth-me.ts) |
| API 测试覆盖 | ✅ 6 用例 (happy, 401×2, 404, OPTIONS, nickname=null) |
| minipgm `me()` lib 函数 | ✅ 加到 apps/miniprogram/lib/api.ts |
| minipgm `pages/settings/` (4 文件) | ✅ settings.json/ts/wxml/wxss |
| chat 页 ⚙ 入口 | ✅ 右上角悬浮 FAB → navigateTo |
| 部署到 CloudBase | ✅ 真接 200/401/404 |
| 副作用 | ⚠️ production 缺 secrets 暂时恢复了 12 vars (见 §6) |
| 测试 | 505 → **511/511 PASS** (+6) |

## 2. 实施路径

### 2.1 现状

- v2.4 全部完成 (zhenjie 1-6)
- top-level-design.md §14 标 "M7-D UI 收尾: 多用户隔离在 settings 页可见" 待做
- minipgm **无 settings 页**
- API **无 /api-auth-me 端点**

### 2.2 关键决策

| 决策 | 选项 | 选 |
|---|---|---|
| M7-D 范围 | (A) 新建 settings 页 / (B) chat 角标 / (C) 其他 | A |
| production 部署策略 | (A) 保留 12 vars / (B) 7 vars / (C) 不部署 | A (用户选) |

### 2.3 改动

#### 2.3.1 后端: `/api-auth-me` handler

`apps/api/src/handlers/api-auth-me.ts`:
- JWT auth (user scope)
- 查 user (getById)
- 查 sessions 统计 (whereQuery)
- 返 `{ user_id, nickname, created_at, session_count, total_messages, isolation }`

`apps/api/src/index.ts`: 注册新 handler。

#### 2.3.2 API 测试 (6 用例)

`apps/api/test/handlers/api-auth-me.test.ts`:
- happy: GET + valid jwt → 200 + user info + count
- 401: 无 Authorization
- 401: 无效 jwt
- 404: user 不存在
- 204: OPTIONS 预检
- nickname undefined → 返 null

#### 2.3.3 minipgm `me()` lib

`apps/miniprogram/lib/api.ts`: 加 `MeResponse` interface + `me()` 函数。

#### 2.3.4 minipgm `pages/settings/`

4 个文件:
- **settings.json** — 页面配置 (navigationBarTitleText: "设置")
- **settings.wxml** — 3 卡片 (账号信息 / 我的数据 / 数据隔离) + 登出按钮 + 加载/错误/未登录态
- **settings.wxss** — 卡片样式 + mono 字体 ID
- **settings.ts** — `onShow` 调 `me()` 拉数据；登出清 jwt + session_id + 跳回 chat

#### 2.3.5 minipgm app.json + chat 页 ⚙ 入口

- `app.json`: 注册 `pages/settings/settings` (在 history 后)
- `chat.wxml`: 加 `<view class="settings-fab" bindtap="onTapSettings">⚙</view>`
- `chat.wxss`: `.settings-fab` 右上角悬浮样式
- `chat.ts`: `onTapSettings()` → `wx.navigateTo({ url: "/pages/settings/settings" })`

## 3. 真接 trace

### 3.1 /api-auth-me 真接 (production)

```bash
# 1. 恢复 production env (12 vars, 含 secrets, 因 P3.6 deploy:clean 后是 7 vars)
$ tcb --config-file cloudbaserc.smoke.json config update fn api-router
✅ envVariables=13项 (12 stable + KEK_CURRENT_VERSION 自增 1)

# 2. admin login → 拿 jwt
$ ADMIN_JWT=$(curl .../api-auth-admin-login -d '{"token":"5e5b4d..."}' | jq -r .jwt)
✅ jwt=eyJhbGciOiJIUzI1NiJ9.eyJzY29wZSI6ImFkbWluIi...

# 3. /api-auth-me (admin 默认 user 不存在 → 404，符合预期)
$ curl .../api-auth-me -H "Authorization: Bearer $ADMIN_JWT"
{"error":"NOT_FOUND","message":"user 01H0000000000000000000000 not found"}

# 4. /api-auth-me (无 token)
$ curl .../api-auth-me
{"error":"AUTH_FAILED","message":"Invalid JWT"}  # 401

# 5. /api-auth-me (错误 jwt)
$ curl .../api-auth-me -H "Authorization: Bearer invalid.token"
{"error":"AUTH_FAILED","message":"Invalid JWT"}  # 401

# 6. OPTIONS 预检
$ curl -X OPTIONS .../api-auth-me -i
HTTP 204
```

### 3.2 minipgm 部署

- 4 个新文件 + 4 个 chat 页修改 + app.json 注册
- **真机/微信开发者工具渲染** 需用户手动 verify（vscode 无 mini-pgm 模拟器）
- 预期：右上角 ⚙ → 点击 → 跳到 settings 页 → 显示 user_id / nickname / 统计

### 3.3 minipgm 真机 verify PASS（2026-06-24）

**主线程预检**（我跑的,真实 gateway domain = `https://unequal-d4ggf7rwg82e0900b-1444590671.ap-shanghai.app.tcloudbase.com`,memory/state 里都没记录,这次发现）：

| 验证项 | 结果 |
|---|---|
| OPTIONS /api-auth-me | ✅ 204 (CORS 正常) |
| GET /api-auth-me 无 token | ✅ 401 (`Invalid JWT`) |
| GET /api-auth-me 错 token | ✅ 401 (`Invalid JWT`) |
| POST /api-auth-admin-login | ⚠️ IP_NOT_ALLOWED (你当前 IP `***REMOVED***.46` 不在 `ADMIN_IP_ALLOWLIST`,家庭 IP 漂移导致) — 不影响真机 verify,真机用 wx.login 走 user jwt,不走 admin token |

**真机 verify**（用户截图,2026-06-24 10:37）：

- ✅ chat 页右上角 ⚙ FAB 显示
- ✅ 点 ⚙ 跳到 settings 页
- ✅ 标题"设置" + 3 卡片 + 退出登录按钮
- ✅ 账号信息卡片：user_id `01KVCZ2JRBAGF3MY75D7KEY4RZ` (25 位 ULID) / nickname "小松果" / 注册时间 2026-06-18
- ✅ 我的数据卡片：对话会话 13 个 / 累计消息 26 条
- ✅ 数据隔离卡片文案完整
- ✅ "退出登录"红色 CTA
- ✅ `wx.cloud.init ok, env: unequal-d4ggf7rwg82e0900b` (CloudBase envId 正确)
- ⚠️ Console 红色 `Error: timeout at Function.<anonymous> (WAServiceMainContext...)` — **基础库 3.16.1 灰度版 known issue**,data 已成功渲染,不影响功能

**真实 gateway domain 发现**：之前 `verify-ask-search-retrieval.sh` 和 `verify-nli.sh` 的 `API_BASE="https://unequal-d4ggf7rwg82e0900b.ap-shanghai.app.tcloudbase.com"` 实际访问,加上 admin `cloud-pusher.ts:79` 默认值 `https://unequal-d4ggf7rwg82e0900b-1444590671.ap-shanghai.app.tcloudbase.com` 才是真 endpoint。前者(无 -1444590671 段)返 `INVALID_ENV`,但有 `-1444590671` 才是真 gateway URL。这是个踩坑记录:以后真接 `verify-*.sh` 脚本里 `API_BASE` 应该是带 `-1444590671` 段的那个,而不是简版。

## 4. 部署状态

| 步骤 | 状态 |
|---|---|
| `pnpm run deploy:build` (api bundle) | ✅ 2.1MB esbuild bundle |
| `tcb fn deploy api-router` (代码) | ✅ |
| `tcb --config-file cloudbaserc.smoke.json config update fn api-router` (env vars 12) | ✅ |
| 恢复 production env 7 vars | ❌ **没做** — 用户决定保留 12 vars (production 真接用) |

## 5. 测试

| 测试集 | 数量 | 结果 |
|---|---|---|
| 全 monorepo | **511** | **PASS** |
| api-auth-me (api) | 6 (新增) | **PASS** |
| minipgm | 49 (无新增 — page UI 不在 unit test 范围) | PASS |
| api 全部 | 136 (= 130+6) | PASS |
| admin 全部 | 168 | PASS |

## 6. ⚠️ 副发现 / 教训

### 6.1 部署时 env vars 覆盖问题

**问题**：M7-D 部署时直接跑 `tcb fn deploy api-router --dir ...`，**触发了用根 cloudbaserc.json (7 vars) 覆盖** → production 缺 4 secrets + IP allowlist → 所有 handler 500 "Missing required env vars"。

**根因**：
- `cloudbaserc.json` (7 vars 干净版) 用于 mock-first production
- `cloudbaserc.smoke.json` (12 vars 含 secrets) gitignored 但 disk 上
- P3.6 后的 `deploy:clean` 用 7 vars 是默认行为

**修复**：
- 跑 `tcb --config-file cloudbaserc.smoke.json config update fn api-router` 恢复 12 vars
- production 现以 12 vars 跑（用户决定保留）

**P4 待办**：把 secrets 移到 proper secret manager（CAM 加密 / 容器 env / 第三方 secret store），不再依赖 gitignored JSON file。

### 6.2 deploy 流程改进空间

- `deploy:secrets` + `deploy:clean` 设计是 smoke-test 场景（M3 mock-first 时代）
- M7-D 后 production 真要带 secrets 跑 → 现有 `deploy:clean` 反向 deploy 流程不匹配
- P4 应重写 deploy 流程：
  - 默认走 `cloudbaserc.json` 推代码（**不**触发 env vars 覆盖）
  - secrets 通过单独 channel（tcb secrets API / tcb config update fn with merge mode）注入
  - 跑 `tcb config diff fn` 验证最终 env

> **2026-06-24 备注**: §6.1 / §6.2 描述的 deploy 痛点已由 P4 #2 (`commit 3466258 / 3dcd430 / 98cbbbd / fed4b1e / 9950196`) 闭环 — Keychain + /tmp 临时 config + Merge/Override 二选一 + tcb diff 验证。P4 #2 完成后 §6.2 "P4 应重写 deploy 流程" 实质已 supersede, 详见 §8 P4 候选 #2 状态。

## 6.1.1 修订 (2026-06-24): ADMIN_IP_ALLOWLIST 修 CIDR ✅

**问题**: M7-D 真机端到端 verify 时发现 admin 真接 100% 失败, user IP `***REMOVED***.46`(深圳电信 AS4134 CHINANET) 不在 allowlist `240e:3b4:...d8b0, 113.116.119.197` 内。minipgm 真机走 user jwt 走通不受影响, 但 admin 端任何真接 (CP-7 / P5 NLI / ARCH-V2.4 / M3-D) 都失败。

**根因**:
- 现状 allowlist 两个单 IP 是半年前 entry。家庭 IP 漂移后失效, CloudBase allowlist 无 TTL 机制, 半年 entry 不会"自动过期" → 假安全
- IP 校验实际在 `src/lib/admin-ip-allowlist.ts` (helper 函数 `isAdminIpAllowed`), 不是 CloudBase 网关层 (设计时误判)
- helper 原 `string.includes` 不支持 CIDR

**修复**:
- `src/lib/admin-ip-allowlist.ts` 加 CIDR 范围匹配 (IPv4 only, IPv6 CIDR 留未来)
- 12 个新单测 (admin-ip-allowlist.test.ts RED→GREEN) 覆盖: 回归 / /24 / /32 / /16 / /0 / 非法 bits / 格式错误 / IPv6 CIDR / 空 / 混合 / 5 段 IP
- Keychain `ADMIN_IP_ALLOWLIST` 改 `***REMOVED***.0/24` (深圳电信家庭 C 段 254 IP)
- 删两个老单 IP
- 走 `pnpm -F api deploy push` (P4 pipeline), 保留 audit log

**教训**:
1. **家庭 admin IP 鉴权应该用 CIDR 不用单 IP** — 漂移是常态不是异常
2. **老的单 IP entry 不会"自动过期"** — 半年没动 = 假安全
3. **IP 鉴权代码层而非 CloudBase 网关层** — 之前误以为是 CloudBase 做 allowlist, 实际是 helper 函数。这是架构 lesson
4. **设计 helper 时保留扩展点** — 现有 `isAdminIpAllowed` 用 `string.includes` 是最小实现, 但留了扩展成 CIDR 的位置 (拆分 entry 处理)
5. **真接需要 verify admin login 真的能走通** — 之前 CP-7-B 真接走了 user jwt path 没暴露, M7-D 真机走 user jwt 走通但 admin path 没人验。M7-D 教训"admin 端没真接验证" 这次落地

**Spec**: `docs/superpowers/specs/2026-06-24-p0-ip-allowlist-cidr-design.md`
**Plan**: `.claude/plans/p0-1-ip-allowlist-cidr.plan.md`

```
[本次] docs(state-m7-d): §6.1.1 IP allowlist CIDR 修订 + §8 #2/#6 标完成
[本次] docs(deploy): push.ts SECRETS 注释加 CIDR 提示
[本次] feat(ip-allowlist): CIDR 范围匹配支持 (GREEN)
[本次] test(ip-allowlist): 12 个 CIDR 单测 RED
38f585d docs(state-m7-d): 真机 verify PASS — settings UI + 3 卡片 + 退出登录
715187b docs(state): 追加真接发现 + production admin 部署 + M7-D 真机端到端 PASS
d0eecdc perf(v2.4): retry 跳过 parse/chunk/embed — chunks_with_emb_json 持久化
ccb98d2 fix(v2.4): CloudEmbedder MiniMax schema 修复 (texts+vectors) + BATCH_SIZE=100
4e31292 docs: v2.4 pushChunks 性能优化真接报告
f707f5f perf(v2.4): pushChunks 切批复用 source/document_id
```

## 8. P4 候选（v2.4 + M7-D 都完成后）

1. **proper secrets manager** — ✅ **2026-06-23 闭环 (P4 #1 commit 53fd0f8)** — macOS Keychain + /tmp 临时 config
2. **deploy 流程重写** — ✅ **2026-06-23 闭环 (P4 #2 commit 链 3466258 / 3dcd430 / 98cbbbd / fed4b1e / 9950196)** — Keychain → /tmp → tcb Merge/Override → diff → audit。**2026-06-24 附加修订**: ADMIN_IP_ALLOWLIST 改 CIDR (见 §6.1.1)
3. **admin 错误处理改进** — 之前 8 真接场景的 silent failure 收集 / 重试更智能
4. **embedder 切换 UX** — chunks_with_emb_json 是旧 OMLX，向量需要重算时手动 SQL 清 + retry
5. **M7-D 真机验证** — ✅ **2026-06-24 PASS** (user_id 01KVCZ2JRBAGF3MY75D7KEY4RZ / 13 sessions / 26 messages / 退出登录按钮)
6. **🆕 ADMIN_IP_ALLOWLIST 修 CIDR** — ✅ **2026-06-24 PASS** (见 §6.1.1)

建议优先级: ~~**1 → 2**~~ (production 健壮性) → 3 → 4 → 5(已完成) → 6(已完成)
