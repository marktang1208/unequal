# CP-7 真接验证 Checklist

**目标**：user 侧跑通 5 步真机验证，验证 CP-7-A（cloudCall 统一）+ CP-7-B（handler 补全 + [N] 解析）端到端 work
**前置**：CP-7-A + CP-7-B 已 merge master（commits `65fae87` + `db843c0`）
**预期工时**：user 30-60 分钟（首次部署 + 真机扫码）

---

## ⚠️ 现状扫描（CP-7-B 合并后）

### ✅ 已就位

| 项 | 状态 | 文件 |
|---|---|---|
| AppID 真值（非占位符）| `wxf5b8ce05a977f0c6` | `apps/miniprogram/project.config.json:66` |
| apiBaseUrl 真 CloudBase URL | `unequal-d4ggf7rwg82e0900b-1444590671.ap-shanghai.app.tcloudbase.com` | `apps/miniprogram/app.ts:8` |
| cloudEnvId 真值 | `unequal-d4ggf7rwg82e0900b` | `apps/miniprogram/app.ts:12` |
| urlCheck = false | 真机调试允许 | `project.config.json:6` |
| minipgm 端 7 caller 全改 cloudCall | CP-7-A 完成 | `apps/miniprogram/lib/api.ts` |
| 后端 2 新 handler 已就位 | rename + nickname | `apps/api/src/handlers/api-sessions-rename.ts` + `api-user-nickname.ts` |
| api-chat [N] 解析代码就位 | parseAnswerSegments + citedNums | `apps/api/src/handlers/api-chat.ts` |
| minipgm 前端富文本代码就位 | citation-parser + message-bubble | `apps/miniprogram/lib/citation-parser.ts` + `components/message-bubble/` |
| admin CloudBaseCallTest 页 | 可用于 admin 端测试 | `apps/admin/src/pages/CloudBaseCallTest.tsx` (untracked) |

### ⚠️ 需要 user 确认 / 修复

| 项 | 当前 | 应该 | 操作 |
|---|---|---|---|
| `cloudbaserc.json` envId | `unequal-d8g4fjk0x5ea36822`（d8g4 = 已注销旧个人版）| `unequal-d4ggf7rwg82e0900b`（d4gg = 现个人版）| **修**：见 §A.1 |
| `api-router/index.js` bundle | CP-6 时打的旧 bundle（不含 CP-7-B 新 handler）| 用 CP-7-B src 重打 | **打**：见 §A.2 |
| `apps/admin/.env.local` | 不存在（gitignored）| 含 `VITE_TCB_ENV_ID=unequal-d4ggf7rwg82e0900b` | **建**（仅 admin 真接测试需要）：见 §A.3 |
| CloudBase 9 collections | 已建（CP-6 跑过 `deploy:collections`）| 同 | 不需要操作 |
| CloudBase 9 indexes | 可选 | 同 | 不需要操作 |
| CloudBase 4 secrets + 8 vars | 已注入（CP-6 跑过 `deploy:secrets`）| 同 | 不需要操作 |
| `apps/admin/src/pages/CloudBaseCallTest.tsx` | untracked（P3.9 加）| tracked 或保留 untracked | 不需要操作（git 工作流问题） |
| `apps/miniprogram/pages/cloudbase-test/` | untracked（P3.9 加）| tracked 或保留 untracked | 不需要操作 |

---

## A. 准备阶段（5-15 分钟）

### A.1 修 cloudbaserc.json envId

```bash
cd /Users/Mark/cc_project/unequal

# 检查当前
cat cloudbaserc.json
# {"$schema":"...","version":"2.0","envId":"unequal-d8g4fjk0x5ea36822"}

# 改为现个人版 env
cat > cloudbaserc.json <<'EOF'
{
  "$schema": "https://static.cloudbase.net/cli/cloudbaserc.schema.json",
  "version": "2.0",
  "envId": "unequal-d4ggf7rwg82e0900b"
}
EOF

# 或 sed 替换
sed -i '' 's/unequal-d8g4fjk0x5ea36822/unequal-d4ggf7rwg82e0900b/g' cloudbaserc.json
cat cloudbaserc.json  # 验证
```

**为什么**：d8g4 已注销，`tcb fn deploy` 默认读 cloudbaserc.json，不改会 deploy 到错 env。

### A.2 重打 api-router bundle（含 CP-7-B 新代码）

```bash
cd /Users/Mark/cc_project/unequal
pnpm -F api deploy:build
# 输出：esbuild bundle src/index.ts → apps/miniprogram/cloudfunctions/api-router/index.js
```

**验证**：

```bash
wc -l apps/miniprogram/cloudfunctions/api-router/index.js
# 期望 ~327000+ 行（CP-6 时 327739，CP-7-B 增加 ~500 行）

# 抽查新 handler 是否进 bundle
grep -c "api-sessions-rename" apps/miniprogram/cloudfunctions/api-router/index.js
# 期望 ≥1
grep -c "api-user-nickname" apps/miniprogram/cloudfunctions/api-router/index.js
# 期望 ≥1
grep -c "parseAnswerSegments" apps/miniprogram/cloudfunctions/api-router/index.js
# 期望 ≥1
```

### A.3 （仅 admin 真接测试需要）建 admin .env.local

```bash
cd /Users/Mark/cc_project/unequal/apps/admin
cp .env.local.example .env.local
cat .env.local
# VITE_TCB_ENV_ID=unequal-d4ggf7rwg82e0900b
```

**为什么**：`apps/admin/src/pages/CloudBaseCallTest.tsx` 用 `VITE_TCB_ENV_ID` 调 CloudBase Gateway。admin 真接测试时需此 env。

---

## B. 部署阶段（10-20 分钟）

### B.1 部署 api-router 到 CloudBase

**前置**：tcb CLI 已装 + 已 login（API Key 3.0）

```bash
# 检查 tcb CLI 状态
which tcb && tcb --version
tcb login --apiKeyId <YOUR_SECRET_ID> --apiKey <YOUR_SECRET_KEY>
# 或交互：tcb login -e unequal-d4ggf7rwg82e0900b
```

**部署**：

```bash
cd /Users/Mark/cc_project/unequal/apps/miniprogram/cloudfunctions/api-router

# 单函数部署（推荐；spec §2.4 mode A 单入口）
tcb fn deploy api-router -e unequal-d4ggf7rwg82e0900b

# 或完整部署（强制覆盖 + 重置 vars；CP-7-C 待内化）
# tcb fn deploy api-router -e unequal-d4ggf7rwg82e0900b --force
```

**验证**：CloudBase 控制台 → 云函数 → api-router → 函数代码 → 应见 `api-sessions-rename` + `api-user-nickname` handler。

### B.2 验证 vars 未被 reset

`--force` 会 reset env vars。CP-6 时注入的 8 vars（`MINIMAX_API_KEY` 等）+ 4 secrets 需保留：

```bash
# 列出当前 env vars
tcb fn config get api-router -e unequal-d4ggf7rwg82e0900b | jq '.EnvVars'

# 期望：8 vars 都在
# MINIMAX_BASE_URL / MINIMAX_API_KEY / KEK_CURRENT_VERSION /
# KEK_SECRET_V1 / DEFAULT_USER_ID / JWT_SECRET /
# ENVIRONMENT / ALLOWED_ORIGIN

# 列出 secrets
tcb secrets list -e unequal-d4ggf7rwg82e0900b
# 期望：4 secrets（ADMIN_TOKEN / MINIMAX_API_KEY / WX_APP_SECRET / KEK_SECRET_V1）
```

**如果 vars 被 reset**：

```bash
cd /Users/Mark/cc_project/unequal
pnpm -F api deploy:secrets  # 重注入 4 secrets + 8 vars
```

### B.3 （可选）admin build 验证

```bash
cd /Users/Mark/cc_project/unequal
pnpm -F admin build
# 期望：✓ built in ~700ms, 202.97 kB JS / 15.67 kB CSS
```

---

## C. 微信开发者工具操作（5-10 分钟）

### C.1 导入 apps/miniprogram

1. 打开微信开发者工具（用你 AppID `wxf5b8ce05a977f0c6` 对应的微信扫码）
2. 左上「小程序」→「+」→「导入项目」
3. **目录**：`/Users/Mark/cc_project/unequal/apps/miniprogram`
4. **AppID**：`wxf5b8ce05a977f0c6`（自动从 project.config.json 读）
5. **项目名称**：unequal-miniprogram
6. **开发模式**：小程序
7. **后端服务**：小程序·云开发（自动识别）
8. 点击「导入」

### C.2 确认云开发环境

1. 微信开发者工具顶部「云开发」按钮
2. 应自动跳转到 CloudBase 控制台，env = `unequal-d4ggf7rwg82e0900b`
3. **如果 env 不对** → 工具栏「设置」→「环境」→ 选 d4ggf7rwg82e0900b

### C.3 编译

1. 工具栏「编译」按钮
2. **观察控制台**（应见）：
   ```
   [unequal] wx.cloud.init ok, env: unequal-d4ggf7rwg82e0900b
   [unequal] ensureJwt: ... (调 /api-auth-wx-login)
   ```

### C.4 真机扫码预览

1. 工具栏「预览」→ 「扫码」→ 微信扫码
2. **真机条件**：手机微信已绑定 AppID 对应的小程序管理员 / 体验成员
3. **如果没绑定**：工具栏「详情」→「成员管理」→ 加体验微信号

---

## D. 真机验证 5+1 步（15-30 分钟）

> 每步成功判据：**微信开发者工具控制台 + 真机弹窗/列表**双重验证

### D.1 onLaunch → ensureJwt → wx-login

**操作**：打开小程序（真机扫码后进入首页）

**期望**：
- 控制台：`[unequal] wx.cloud.init ok`
- 控制台：`ensureJwt: returning stored/refreshed jwt`（或首跑 `wx.login + /api-auth-wx-login`）
- 控制台无 `[unequal] ensureJwt failed` warn

**如失败**：
- 「ensureJwt failed: ...」→ 看 ApiError code
  - `WX_UNAVAILABLE` → 真机调 callFunction 失败（检查 appid + 体验成员）
  - `MISSING_AUTH` → JWT 缺失（冷启动 wx.login 失败）
  - `REFRESH_FAILED` → /api-auth-wx-login handler 错（看 CloudBase 日志）
  - `UNAUTHORIZED` → refresh 后仍 401（server 鉴权失败）
- 「wx.cloud.callFunction:fail ...」→ 通常是权限或环境问题
  - 真机调试必须「不校验合法域名」（urlCheck:false 已设 ✓）

### D.2 chat tab → /api-chat callFunction

**操作**：底部「问答」tab → 输入「5个月宝宝发烧38.5怎么办」→ 发送

**期望**：
- 答案气泡渲染（assistant role）
- 答案含 `[1] [2]` 等蓝色内联引用（**CP-7-B 新增**）
- 气泡下方 citation-card 列表显示引用文档
- 引用数 ≤ 5（top-5 限制）

**如失败**：
- 「ApiError(404, NOT_FOUND, Unknown path: /api-chat)」→ api-router 没部署 / 没注册
- 「ApiError(0, NETWORK_ERROR, wx.cloud.callFunction failed)」→ 网络/SDK 问题
- 答案无 [N] → LLM 没引用（属正常，citations=[]）

### D.3 [N] 富文本点击 → showToast（**CP-7-B 新增**）

**操作**：在 D.2 答案气泡上点击 `[1]`

**期望**：
- 真机弹 toast 显示引用文档标题（如「《疫苗指南》」）
- 1.5s 后自动消失
- icon: none（无图标，纯文字）

**如失败**：
- 没反应 → message-bubble onCiteTap 未绑（检查 .wxml `bindtap="onCiteTap"`）
- toast 显示「未知引用」→ citations 为空（server 返 citations:[]）

### D.4 history tab → /api-sessions-list

**操作**：底部「历史」tab

**期望**：
- session 列表显示（含 D.2 创建的）
- 每项显示 title + messageCount + 时间
- 按 updatedAt desc 排序

**如失败**：
- 空列表 → D.2 没成功创建 session
- 「NOT_FOUND Unknown path」→ handler 未注册

### D.5 rename session（**CP-7-B 新增**）

**操作**：长按 session 项 → 「重命名」→ 输入新标题 → 确认

**期望**：
- 列表立即刷新显示新标题
- 服务器侧 chatSession.title 写入

**如失败**：
- 「ApiError(404, NOT_FOUND, Session xxx not found)」→ sessionId 不对
- 「ApiError(403, FORBIDDEN, Not your session)」→ userId 不匹配（鉴权 bug）
- 「ApiError(405, METHOD_NOT_ALLOWED)」→ caller 没走 PATCH
- 「ApiError(400, INVALID_REQUEST)」→ title trim 后空 / > 100 chars

### D.6 delete session（**CP-7-B 修复 path bug**）

**操作**：长按 session → 「删除」→ 确认

**期望**：
- session 从列表消失
- 若删的是当前 chat session，chat 页清空

**如失败**：
- 「ApiError(400, Missing 'id' query param)」→ CP-7-A 遗留 bug 未修（应已修，验证 §A.2）
- 「ApiError(404)」→ session 不存在

### D.7 nickname 输入（**CP-7-B 新增**）

**操作**：进入 chat 页 → 系统弹 nickname 输入框（首次启动触发）→ 输入昵称 → 确认

**期望**：
- toast 显示「昵称已更新」
- server user.nickname 写入
- 后续 chat 可引用 nickname（CP-7-D 范围外，目前只是存储）

**如失败**：
- 「ApiError(404, NOT_FOUND, User xxx not found)」→ user record 不存在（理论 0 触发；可能 wx-login 时序问题）
- 「ApiError(400, INVALID_REQUEST, Empty 'nickname')」→ trim 后空

---

## E. 调试工具

### E.1 微信开发者工具控制台

- `console.log` + `console.warn` 已埋点（看 `[unequal]` 前缀）
- 右上角「Network」面板看 callFunction 调用（仅 dev tools 显示，wx.cloud 私有协议）

### E.2 CloudBase 控制台

- **云函数 → api-router → 日志**：每次 invoke 的 request/response + 错误堆栈
- **云函数 → api-router → 函数代码**：验证 bundle 是最新版（含 CP-7-B 新 handler）

### E.3 admin CloudBaseCallTest 页（**强烈推荐**）

如果 admin 端也想测：

```bash
cd /Users/Mark/cc_project/unequal/apps/admin
pnpm dev
# 浏览器访问 http://localhost:5173/cloudbase-call-test
```

页面预设 3 个测试（GET /api-health / GET / / POST /api-search）+ 自定义输入。可匿名调 callFunction 直测 api-router handler，绕过 minipgm UI 层。

**CP-7 真接专项测试**（自定义）：
```
HTTP Method: PATCH
Path: /api-sessions-rename
Body: {"id":"01HSESSION_REAL_ID","title":"测试新标题"}
Headers: {"authorization":"Bearer <your_jwt>"}
```

如果 admin 端能 PATCH 成功 → handler OK，问题在 minipgm caller；如果 admin 也 4xx → handler 本身问题。

---

## F. 失败排查速查

| 错误 | 可能原因 | 排查 |
|---|---|---|
| `ApiError(404, NOT_FOUND, Unknown path: /api-X)` | api-router bundle 没 deploy / 没注册 handler | §B.1 重 deploy；§A.2 重 bundle |
| `ApiError(404, NOT_FOUND, Session xxx not found)` | sessionId 不存在 / CloudBase collection `chat_session` 缺数据 | §E.2 看 CloudBase DB |
| `ApiError(403, FORBIDDEN, Not your session)` | session.userId ≠ jwt.sub（鉴权 bug 或多用户数据污染）| CloudBase DB 看 session.userId |
| `ApiError(405, METHOD_NOT_ALLOWED)` | minipgm caller 没走 PATCH（cloudCall httpMethod 参数错）| 看 `lib/api.ts` |
| `ApiError(400, INVALID_REQUEST)` | body 字段缺 / 空 / 超长 | 看具体 message（`Empty 'title'` / `'title' exceeds 100 chars`） |
| `ApiError(0, NETWORK_ERROR, wx.cloud.callFunction failed)` | 网络 / SDK / 权限问题 | 检查「不校验合法域名」+ 真机是体验成员 + cloudEnvId 正确 |
| `ApiError(401, REFRESH_FAILED, ...)` | /api-auth-wx-login handler 抛错 | §E.2 看 CloudBase 日志 |
| toast「未知引用」 | `citations` 数组为空（server 返） | server 端 D.2 LLM 没引用任何 chunk → 属正常 |

---

## G. 真接成功后下一步

CP-7 真接 PASS 后：
1. **写真接报告** → `docs/superpowers/state-cp7-zhenjie.md`（参考 state-cp6 §8 格式）
2. **回填 README**：CP-7 限制中 "mock-first" 改为 "已真接验证 PASS"
3. **CP-7 真接 tag**：`git tag cp7-zhenjie-archived master`
4. **CP-7-C/D 候选**（独立项目）：
   - CP-7-C：deploy 流程内化 env vars push
   - CP-7-D：LLM model 跨 handler 一致性 + 引用格式统一

---

## H. References

- **CP-7-B state**：`docs/archive/state/state-cp7-b.md`
- **CP-7-A state**：`docs/archive/state/state-cp7-a.md`
- **CP-6 state**：`docs/archive/state/state-cp6.md` §8 真接路径 + §9.1 账号链路
- **api-router 部署脚本**：`apps/api/scripts/deploy-functions.sh` + `deploy-build.ts`
- **CloudBase 控制台**：https://console.cloud.tencent.com/tcb
- **tcb CLI 文档**：https://docs.cloudbase.net/cli/intro

---

**Checklist 完成日期**：2026-06-18
**预计 user 真接耗时**：30-60 分钟（首次部署）+ 后续 5 步验证 15-30 分钟
**真接 tag**：cp7-zhenjie-archived（待 user 真接 PASS 后）