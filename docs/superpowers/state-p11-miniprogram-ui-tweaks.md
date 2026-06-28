# state-p11-miniprogram-ui-tweaks — 上线前 UI 改动 commit family (2026-06-28)

> 日期: 2026-06-28
> 项目: unequal 微信小程序 (AppID `wxf5b8ce05a977f0c6`, 个人主体)
> 触发: memory `feedback_pending_ui_tweaks.md` + 2026-06-26 深夜 user UI 反馈
> 状态: 🟢 **代码 + docs 全收官, 1 blocker + 2 人工待办** (等邮箱 + 真机回归 + 提交审核)

## 0. TL;DR

**上线前最后 UI 改动 (P11)** 落地 3 个 commit, 解决 2 个上线阻塞 (chat 页镜像 + docs 占位符) + 1 个视觉/交互痛点 (信息源 chip → popup)。

**P11 改动** (3 commit, 249+12+126 行, 49/49 单测 PASS, typecheck 0 错):

| commit | 改动 | 影响 |
|---|---|---|
| `a6ba87e` `feat(miniprogram): chat 页气泡镜像 + 信息源 popup 弹层` | message-bubble 镜像 + 删 chip 加 popup | chat 页布局, 4 文件, +249/-63 |
| `caf0520` `fix(launch): 替换 docs 协议 URL 占位符为真实 GitHub Pages URL` | 04 提审文档 + legal-site README | 提审 / gh-pages 公开页, 2 文件, +7/-5 |
| `1767d04` `docs(launch): PRD — 上线前 UI 改动 chat 页气泡镜像 + 信息源 popup` | PRD 归档 | .claude/prds/, 1 文件, +126 |

**P11 阻塞 (1)**:

- 🟡 **legal HTML 邮箱占位符**: `[填入你的邮箱]` 还在 `legal-site/index.html:125` + `legal-site/privacy.html:160`。需要 user 真实邮箱 → 1 行 sed + cd legal-site && git push → 5 分钟解决。
  - 建议: `support@unequal.app` 或 user 个人公开邮箱

**P11 人工待办 (2)**:

- 🟡 **真机 5 路径回归** (P10 已 PASS, 改动后需再走一遍): 1-2 小时
- 🟡 **微信开发者工具上传 + 公众平台提交审核**: 30 min

## 1. 设计决策

### 1.1 镜像气泡 (user 左 / assistant 右)

**Why**: 解决 + 号 FAB (左上 fixed) 跟 user 消息右上角可能视觉重叠的设计推断 + 提供 user/assistant 视觉差异化 (对齐方向 + 圆角方向 + box-shadow 偏移方向都镜像)

**实现** (`apps/miniprogram/components/message-bubble/message-bubble.wxss`):
- `.bubble.user`:
  - `align-self: flex-end` → `flex-start` (靠左)
  - `border-radius: 28rpx 8rpx 28rpx 28rpx` → `8rpx 28rpx 28rpx 28rpx` (小角从右下移到左下)
  - `box-shadow: 8rpx 8rpx 0 0 #f5a623` → `-8rpx 8rpx 0 0 #f5a623` (偏移方向镜像)
  - `margin: 22rpx 32rpx 22rpx 24rpx` → `22rpx 24rpx 22rpx 32rpx` (左右 margin 镜像)
- `.bubble.assistant`:
  - `align-self: flex-start` → `flex-end` (靠右)
  - `border-radius: 8rpx 28rpx 28rpx 28rpx` → `28rpx 8rpx 28rpx 28rpx` (小角从左上移到右上)
  - `box-shadow: 8rpx 8rpx 0 0 #ffb84d` → `-8rpx 8rpx 0 0 #ffb84d`
  - `margin: 22rpx 24rpx 22rpx 32rpx`

**风险 + 退路**:
- ⚠️ 反行业惯例 (微信/QQ/iMessage 都 user 靠右代表「我说的」)
- ⚠️ 审核员可能觉得「不像聊天工具」被打回 → 备注栏说明「差异化布局, 便于家长快速识别自己提的问题」+ 截图清晰展示 user/assistant 区分
- 🟢 退路: 真机回归发现 + 号没遮消息 → 保留镜像 (视觉差异化收益) + 仍做信息源 popup (核心收益) + 不回退

### 1.2 信息源 popup 弹层

**Why**: 信息源筛选是次要设置, 不该长期占 chat 页底部 80rpx。chip 条夹在 message-list 和 input-bar 中间挤空间, 选中态视觉弱 (5 个橙色 chip 并排难以辨识「我选了啥」)

**实现** (`apps/miniprogram/pages/chat/chat.{wxml,wxss,ts}`):
- 删底部 `<scroll-view class="source-picker">` 整块 + `.source-picker` / `.chip` 全部样式
- 加 `.source-filter-fab` (🔍 + 数字徽章) 在 ⚙ 下方 (right: 24rpx, top: 112rpx)
  - `.filter-badge` 红色 32rpx 圆, 已选 N 项时显示
- 加 `.source-popup` 半屏弹层 (从底部滑入, 240ms ease CSS transition)
  - mask 半透明黑 (rgba(0,0,0,0.4)) 点关闭
  - 标题「信息来源筛选」+ × 关闭
  - 5 个 row (网页/文件/PDF/小红书/公众号), 每个有 40rpx checkbox + label
  - 底部「全部 (默认)」按钮 → 清空 selectedSourceTypes
- `chat.ts` data 加 `sourceFilterOpen: false`, 4 个新方法:
  - `onOpenSourceFilter` (🔍 触发)
  - `onCloseSourceFilter` (mask/× 触发)
  - `onToggleSourceTypeInPopup` (checkbox 触发, 实时预览, 不关 popup)
  - `onResetSourceFilter` (全部按钮触发, 空数组 = 不过滤默认)
- 保留 `availableSourceTypes` + `selectedSourceTypes` 数据结构, `chat()` 调用照常从 `selectedSourceTypes` 读 `source_types` 透传给后端 (api-chat.ts:126)

**P11 决策: popup 关闭策略 = checkbox 实时生效 + 右上 [×] 显式关闭**
- 5 个选项不多, 实时反馈更直接
- 不用「应用/取消」双按钮 (chip 时代也是即时反馈, 一致性)

**P11 决策: 🔍 位置 = 右上 ⚙ 下方 (不是左上 + 号右侧)**
- 信息源 + 设置都是「配置类」, 分散放更对称
- 避开 navigationBar 胶囊按钮 (右上区域是 safe area)

**风险**:
- ⚠️ popup 在低端机卡顿 → 用 CSS transition 而非 JS setData, 5 行内容, runtime 无网络请求
- ⚠️ popup mask z-index 200 遮住 ⚙ (z-index 100) → 关闭 popup 后 ⚙ 可点; mask 不能点击穿透, 设计上是对的

### 1.3 docs 协议 URL 占位符替换

**Why**: memory `project_github_push_complete.md` 写的实际部署 URL 是 `marktang1208.github.io/unequal/`, 但 `04-submit-review.md §3.3` + `legal-site/README.md` 仍用占位符 `YOUR_GITHUB_USERNAME.github.io/unequal-legal/`, 该独立 repo **不存在 (404)**。如果照占位符填入提交审核会被打回。

**实现**:
- `docs/launch/04-submit-review.md:109-110`: 替换为真实 URL + 加「独立 unequal-legal repo 不存在」备注
- `legal-site/README.md:6-8`: 替换为真实 URL + 加「主 repo gh-pages 分支」备注
- `docs/launch/02-github-pages-setup.md`: **不改** (新人部署指引, 实际部署方案已在 commit `9ffc97a` 改用主 repo gh-pages)

**教训**: 之前 `docs/launch/README.md` 标 "✅ done (daytime)" + state-p10 §6 "GitHub push 全收官" 都误判, 实际 repo 没建, 文档占位符没替换。**state 文档不能等同于实际部署** — 必须 curl 验证。

## 2. 真接验证 (待 T9 跑)

P10 5 路径脚本 (`docs/launch/03-real-device-test.md` + state-p10 §1.2) 走一遍:

| # | 路径 | 预期 |
|---|---|---|
| 1 | 冷启动 | chat 空状态, 🔍 (右上 ⚙ 下方) + ⚙ + + 号 (左上) 三个 FAB 都可见, vConsole `[unequal] wx.cloud.init ok` |
| 2 | chat 短问 (宝宝几个月可以吃辅食) | 30s 内有回答, **user 消息靠左 + assistant 消息靠右 + 无 + 号遮消息** + 引用卡片可见 |
| 3 | + 号新会话 | 点 + 号 → modal 弹 + messages 清空 (P10 验证过的行为不变) |
| 4 | 历史 sessions tab | 看到刚才 session (P10 PASS 不变) |
| 5 | settings 页 | user_id 显示 + 独立 source 过滤 (settings 页冗余保留) |
| **新加 6** | 信息源 popup | 点 🔍 → 弹出 popup (240ms 滑入) → 点 checkbox → 选中态 + 数字徽章更新 → 发新 query → 后端 audit_log 看 source_types 字段 |

**5 张新截图** (替换 `docs/launch/01-submission-materials.md §5`):
- 01-chat-home.png (冷启动空状态)
- 02-chat-qa-citations.png (含引用卡片)
- 03-chat-multiturn.png (chat 跨轮, 展示镜像对齐)
- 04-history-sessions.png (历史 tab)
- 05-source-popup-open.png (新加, 替换原 settings 截图, 展示 popup 弹层)

## 3. 提审流程 (待 T9-T10 走)

按 `docs/launch/04-submit-review.md` (URL 已更新):

1. 微信开发者工具 → 编译 → 上传 1.0.0 + 项目备注「首发版本: 育儿知识问答, 引用追溯, P8 + P9 + P11 真接」
2. 公众平台 → 版本管理 → 设为体验版 → 用非管理员微信号扫码
3. 体验版走 5 路径 (跟 P10 同样的脚本)
4. 提交审核: 类目「生活服务 - 母婴」+ 简介 A 套 28 字 + 关键词「育儿, 母婴, 辅食, 早教, 问答」+ 5 张新截图 + 协议 URL (已替换)
5. 等审核 1-3 天
6. 通过 → 发布 (个人主体默认全量)

## 4. 测试 + 部署

- **单测**: `pnpm -F miniprogram test` → **49/49 PASS** (跟 baseline 一致, message-bubble 单测只测 onCiteTap, 不测样式)
- **typecheck**: `pnpm -F miniprogram typecheck` → **0 错**
- **后端**: 不动 (P9 已定型的 api-chat.ts:126 sourceTypes 透传路径不变)
- **deploy**: 不需要 (前端改动, 微信开发者工具编译即可)
- **gh-pages**: T8 邮箱替换后 push 即可 (已替换占位符的 docs URL 立即生效, GitHub Pages 1-2 分钟)

## 5. 完整 commit 链 (P11 阶段)

```
1767d04 docs(launch): PRD — 上线前 UI 改动 chat 页气泡镜像 + 信息源 popup
caf0520 fix(launch): 替换 docs 协议 URL 占位符为真实 GitHub Pages URL
a6ba87e feat(miniprogram): chat 页气泡镜像 + 信息源 popup 弹层
```

**前序 (P10)**:
```
0854ed0 docs(launch): 同步 P10 完成状态 - 5 路径 PASS + 剩 2 阻塞
3ef7a17 docs(state): P10 微信小程序真接 5 路径 PASS
a05ff19 feat(miniprogram): chat UI 改进 - 去掉提问按钮 + 加新会话入口
61a01e6 fix(api): P10+ 真接 getClientIp undefined crash bugfix
```

## 6. 阻塞清单 (上线 1.0.0 前)

| # | 阻塞 | 耗时 | 解决 |
|---|---|---|---|
| 1 | legal HTML 邮箱占位符 (2 处) | 5min | user 给邮箱 → 1 行 sed + push |
| 2 | 真机 5 路径回归 + 5 张新截图 | 1.5-2h | user 拿手机扫码 |
| 3 | 微信开发者工具上传 + 提交审核 | 30min | 微信公众平台操作 |

**总计人工 2-2.5h** + 审核 1-3 天 = **最早 2026-06-30 上线** (假设 6/29 提交, 6/30 通过)。

## 7. 关联

- **PRD**: `.claude/prds/launch-ui-mirror-and-source-popup.prd.md`
- **Plan**: `.claude/plans/launch-ui-mirror-and-source-popup.plan.md` (gitignored, 本地留底)
- **state-p10**: `docs/superpowers/state-p10-miniprogram-real-deploy.md` — P10 5 路径 PASS 完整 evidence
- **state-miniprogram-pre-launch**: `docs/superpowers/state-miniprogram-pre-launch.md` — 上线前 checklist
- **launch README**: `docs/launch/README.md` — 4 步执行清单
- **launch playbook**: `docs/launch/01-submission-materials.md` / `02-github-pages-setup.md` / `03-real-device-test.md` / `04-submit-review.md`
- **memory** `feedback_pending_ui_tweaks.md` — 触发本次 P11 改动的源头
- **memory** `project_github_push_complete.md` — 实际部署 URL 跟 state 文档脱节的教训

## 8. P11+ 待办 (不阻塞上线)

- 真育儿 corpus ingest (公开公众号/育儿网站 5-10K chunks) — "未涉及" 率从 ~80% → ~20%
- NLI cold-start race (35.3% → 80%+ success rate) — 改 NliCosDownloader 用 direct COS URL 绕过 SDK getTempFileURL
- chat 跨轮 session 复用 bug (state-p10 §2.2) — P10 真接发现, P11+ 排查
- P11 本地推理 (OMLX Qwen3-4B) — LLM 20s → 5-10s
- 监控 + 日志平台 (Sentry/LogRocket)
- chat UX streaming 整合
- settings 页 source 过滤迁移 (跟 chat popup 合并) — 1.1.0 candidate

## 9. 回滚路径

| 阶段 | 命令 | 影响 |
|---|---|---|
| 前端回滚 (P11 全) | `git revert a6ba87e caf0520 1767d04` + 微信开发者工具重编译 | 回到 P10 状态 (user 靠右, chip 条, 占位符 URL) |
| 前端回滚 (仅 chat 改动) | `git revert a6ba87e` + 微信开发者工具重编译 | 回到 P10 chat 布局 + chip 条 (docs URL 替换保留) |
| docs 回滚 | `git revert caf0520 1767d04` | 04 + legal-site README 恢复占位符 (注意: 这会再次阻塞提审) |
