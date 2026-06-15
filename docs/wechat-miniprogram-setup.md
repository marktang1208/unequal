# 微信小程序真机联调指南

> M3 mock-first 阶段产物。本文档是**真人操作 checklist**，覆盖从「零」到「手机上跑通 /ask」的全流程。
>
> 目标读者：项目作者本人（非团队 — 所有微信平台账号、AppID、付费认证都是个人主体）。
>
> 预计耗时：注册 + 审核 1-2 个工作日，其余步骤当天可完成。

---

## 0. 前置确认

在开始前，确认本地已经跑通 mock 流程：

```bash
# 1. 后端 mock 跑通（参见 README.md 「M2 状态」段）
curl -X POST http://localhost:8787/ask \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"q":"5个月宝宝发烧38.5怎么办？"}'

# 2. admin ChatSim 跑通（参见 README.md 「M3 状态」段）
pnpm -F admin dev
# 浏览器打开 http://localhost:5173/chat-sim
```

如果上面任一不通过，先回到 README 排错，不要往下走。

---

## 1. 注册个人主体

小程序发布必须有一个「主体」。个人开发者选「个人」类型（不是企业/媒体/其他组织）。

### 1.1 入口

- 浏览器打开 https://mp.weixin.qq.com
- 右上角「立即注册」→ 选择「小程序」

### 1.2 主体信息

| 字段 | 说明 |
|------|------|
| 邮箱 | **未被微信注册过**（不能是已有公众号 / 订阅号的邮箱）。推荐 163 / Gmail。 |
| 密码 | 单独密码，不要与微信账号密码混用 |
| 验证码 | 邮箱收到的激活链接 |
| 主体类型 | **个人**（不是企业） |

### 1.3 个人信息（个人主体）

- 身份证号 + 姓名（必须真实 — 微信会做人脸核身）
- 微信扫码（用手机微信扫页面二维码，绑定管理员身份）
- 管理员手机号（接收短信验证码）

### 1.4 付费认证

- **30 元/年**（微信官方定价，不可免）
- 用微信支付扫码付款

### 1.5 审核

- 微信审核 1-2 个工作日
- 通过后邮箱收到「小程序已开通」通知
- 登录后台 https://mp.weixin.qq.com 可看到「小程序」面板

---

## 2. 获取 AppID

### 2.1 入口

- 登录 https://mp.weixin.qq.com
- 左侧菜单 → **开发管理** → **开发设置**

### 2.2 复制 AppID

- 在「开发者ID」区域，复制 **AppID（小程序ID）**
- 格式形如 `wx1234567890abcdef`（18 位，以 `wx` 开头）
- **AppSecret（小程序密钥）** 也要生成一次并妥善保存（后面提审时用）

### 2.3 记录到本地

把 AppID 记到一个你能找到的地方（密码管理器 / `~/.env.local`），下一步要替换到项目里。

---

## 3. 安装微信开发者工具

### 3.1 下载

- 官方下载页：https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html
- macOS 选择「稳定版 Stable Build」→ 下载 `.dmg`
- Windows / Linux 同理（本文档以 macOS 为准）

### 3.2 安装

- 双击 `.dmg`，把微信开发者工具拖入「应用程序」文件夹
- 启动后用「微信扫码」登录（用第 1 步绑定的小程序管理员微信）

---

## 4. 导入项目

### 4.1 添加项目

- 微信开发者工具 → 左侧「小程序」tab → 右上角「+」→ 「导入项目」
- **项目目录**：选择本仓库的 `apps/miniprogram/` 目录（不是仓库根，是子目录）
- **AppID**：选择「使用测试号」→ **取消** → 选「手动输入 AppID」→ 粘贴第 2 步拿到的 AppID
- **项目名称**：`unequal-miniprogram`（或自取）
- 点击「导入」

### 4.2 首次编译

- 工具会自动编译一次
- 编译成功后左侧会出现文件树，右侧模拟器会渲染 chat 页（或空白页 — 取决于当前页面）
- 如果编译失败，看左下角「控制台」报错，最常见原因是 AppID 格式错（必须 `wx` 开头、18 位）

---

## 5. 开发期配置

### 5.1 关闭「不校验合法域名」

小程序默认会强制所有网络请求走 https + ICP 备案域名。本地开发阶段不可能有 https + 备案域名，必须关掉校验。

- 微信开发者工具 → 顶部菜单「详情」→ 「本地设置」
- 勾选 ✅ **不校验合法域名、web-view（业务域名）、TLS 版本以及 HTTPS 证书**
- 勾选 ✅ **不校验 WebSecurity 域名**

### 5.2 替换占位 AppID

`apps/miniprogram/project.config.json` 当前 `appid` 是 `touristappid0000000`（CP-3 mock-first 留下的占位，真机联调前必须替换）。

```diff
   "appid": "touristappid0000000",
+  "appid": "wx你的真实AppID",
```

替换完在微信开发者工具「详情」面板会刷新为真实 AppID。

### 5.3 apiBaseUrl 说明

`apps/miniprogram/app.ts` 里：

```ts
apiBaseUrl: "http://localhost:8787",  // CP-5 后改 https://unequal.xxx.workers.dev
```

- **开发期 / 真机调试**：保持 `http://localhost:8787`（本机 wrangler dev）
- **真机访问**：手机和电脑必须在同一 Wi-Fi 网段；wrangler dev 默认监听 `0.0.0.0:8787`，手机能直接访问
- **生产期**：CP-5 真接 Cloudflare 后改为 `https://unequal.xxx.workers.dev`，届时 `urlCheck: false` 就可以去掉（域名已备案）

---

## 6. 真机预览

### 6.1 开发者工具预览

- 微信开发者工具 → 顶部「预览」按钮（或 `Cmd + P`）
- 二维码出现在「预览」面板
- **必须用第 1 步注册时绑定的管理员微信**扫码（不是任何其他微信）
- 手机上会自动打开小程序（首次会提示「是否允许体验」）

### 6.2 体验成员授权

如果用非管理员微信扫码（家庭成员 / 测试朋友），需要先在后台加体验成员：

- mp.weixin.qq.com → 左侧「成员管理」→ 「体验成员」tab → 「添加」→ 输入对方微信号
- 对方微信会收到「邀请体验」通知，同意后才能扫码预览
- 个人主体最多 15 个体验成员

### 6.3 手机扫码

- 管理员 / 体验成员微信扫开发者工具预览码
- 第一次会提示「发现新版本，是否下载并打开」→ 确认
- 小程序加载 → chat 页可见

---

## 7. 联调 /ask 端到端

### 7.1 启动本地后端

```bash
# 终端 1：跑 wrangler dev（M0+M1 README「第一次跑」已配过的环境）
pnpm dev:api
# 看到 ⎔ Starting local server... http://localhost:8787

# 终端 2（可选）：跑 admin 看是否一致
pnpm dev:admin
# 浏览器 http://localhost:5173/chat-sim
```

### 7.2 手机输入问题

- 手机小程序 → chat 页
- 输入框键入：`5个月宝宝发烧38.5怎么办？`
- 点击「发送」

### 7.3 期望输出

- 气泡：「5个月宝宝... [来源 1] [来源 3]」+ 底部灰色 disclaimer「以上信息来源于知识库内容，不构成医疗建议」
- 下方 2 张引用卡片（citation-card 组件）：
  - 卡片 1：来源标题 + trust level（颜色标签）
  - 卡片 2：同上
- 点击引用卡片 → 跳转 `source-detail` 页，显示 chunk 全文 + 元数据

### 7.4 验证清单

| 项 | 期望 |
|----|------|
| 气泡出现 | ✅ 文字 + disclaimer |
| 引用卡片出现 | ✅ 1-5 张 |
| 卡片点击跳转 | ✅ source-detail 页 |
| 后端日志 | `wrangler dev` 终端能看到 `[ask] q="..." citations=N cached=false` |
| admin ChatSim 同时跑 | ✅ 返回同样的 answer |

---

## 8. 提审前准备（仅在要正式发布时做）

> M3 阶段不需要做这步。本节是 CP-6+ 真发布时的预热。

### 8.1 域名配置

- 准备一个**已 ICP 备案**的域名（个人备案也可）
- mp.weixin.qq.com → 开发管理 → 开发设置 → 「服务器域名」→ 配置：
  - request 合法域名：`https://unequal.xxx.workers.dev`
  - uploadFile 合法域名：同上
  - downloadFile 合法域名：同上

### 8.2 隐私协议

- mp.weixin.qq.com → 设置 → 第三方设置 → 隐私协议 → 「更新」
- 必填项：
  - 收集的用户信息：微信昵称、头像（如果用了 wx.login）
  - 收集目的：身份识别
  - 第三方 SDK：无
- 隐私弹窗设计：首次进入小程序必须弹出「同意隐私协议」

### 8.3 类目选择

- mp.weixin.qq.com → 设置 → 基本设置 → 服务类目
- 个人主体可选类目有限（不支持医疗、金融、社交等敏感类）
- 育儿知识类通常选「教育 → 在线教育」或「工具 → 效率」

### 8.4 审核

- 微信开发者工具 → 右上角「上传」→ 填版本号 + 项目备注
- mp.weixin.qq.com → 版本管理 → 找到刚上传的版本 → 「提交审核」
- 审核 1-7 天（首次可能更久）
- 通过后 → 「发布」→ 线上版本生效

---

## 9. 遇到问题（排查表）

| 症状 | 可能原因 | 排查 |
|------|---------|------|
| 模拟器白屏 | AppID 错 / 编译失败 | 检查 `project.config.json` 的 `appid` 格式（`wx` 开头 18 位）；看控制台报错 |
| 手机扫码「小程序未发布」 | 用非体验成员微信扫 | 加体验成员（§6.2）或用管理员微信 |
| `/ask` 请求失败（小程序 toast 报网络错误） | 后端没跑 / 手机和电脑不同 Wi-Fi | 终端确认 `pnpm dev:api` 在跑；手机和电脑 ping 一下；wrangler dev 应监听 `0.0.0.0` 而不是 `localhost` |
| `/ask` 返回 400 | 请求格式错 | 看 app.ts `apiBaseUrl` 和 lib/api.ts 的 request body，确认 `q` 字段存在 |
| `/ask` 返回 500 | LLM caller / retrieval 抛错 | 看 wrangler dev 终端日志栈；本地跑 `pnpm -F api test` 确认 mock 夹具绿 |
| TypeScript 报错 `wx 未定义` | tsconfig types 缺 | 确认 `apps/miniprogram/tsconfig.json` 有 `"types": ["miniprogram-api-typings"]`（CP-1 已设） |
| 引用卡片点击不跳转 | citation-card 组件 navigateTo 路径错 | 看 `components/citation-card/citation-card.ts` 的 `onTap`，确认路径 `/pages/source-detail/source-detail` |
| 真机看不到本地 `localhost:8787` | 手机 / 电脑不在同 Wi-Fi | 用手机 ping 电脑 IP（`ifconfig | grep inet`）；或手机开热点给电脑 |
| 提审被拒「缺少隐私协议」 | 没填第三方设置 | §8.2 |

---

## 10. Mock-first 真机回退

如果暂时不想走 §1-§6 的完整流程（注册、付 30 元、装工具），**完全可以用 admin ChatSim 验证 /ask 端到端**：

```bash
pnpm dev:api    # 终端 1
pnpm dev:admin  # 终端 2
# 浏览器打开 http://localhost:5173/chat-sim
```

ChatSim 是小程序 chat 页的镜像（同样的 form、同样的 citation-card 渲染、同样的 lib/api.ts fetch 逻辑），所以：

- ✅ M3 的 lib 层 4 个单测（happy / 带 token / 400 / 500）已经在 `pnpm -F miniprogram test` 覆盖
- ✅ ChatSim 调同样的 `/ask` endpoint，验证了真实网络路径（不是 mock fetch）
- ✅ ChatSim 渲染同样的 citation 数据，验证了 UI 组件

也就是说：**只要 ChatSim 能用 /ask 出正确结果，小程序真机联调时 99% 也能跑通**（剩下 1% 是小程序特有约束：合法域名 / AppID / 真机 JS 引擎差异 — 这些在小程序开发者工具模拟器里就能验证）。

---

## 11. 速查：commit 后的下一步

| 状态 | 下一步 |
|------|--------|
| 没跑过 /ask | README M2 段 → 本地启 wrangler dev |
| /ask 通了，但 admin ChatSim 没通 | README M3 段 → `pnpm -F admin dev` |
| 都不想跑 | §10 mock-first 回退 |
| ChatSim 通了，想上真机 | §1-§6 全流程 |
| 真机也通了，准备发布 | §8 提审 |

---

## 关联文档

- 设计稿：`docs/superpowers/specs/2026-06-14-unequal-top-level-design.md`
- M0+M1 计划：`docs/superpowers/plans/2026-06-14-m0-m1-monorepo-knowledge-base.md`
- M3 计划：`docs/superpowers/plans/2026-06-15-m3-miniprogram-monorepo.md`
- 总 README：`README.md`（M3 段）
