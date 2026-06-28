# 上线前 UI 改动 — chat 页气泡镜像 + 信息源 popup

## Problem

小程序「育儿不等号」上线前（1.0.0 尚未上传），chat 页有两个**视觉/交互痛点**会让首次扫码的家长产生「这是测试版」的第一印象：

1. **+ 号 FAB 跟 user 消息可能视觉冲突**：当前 user 消息靠右、+ 号左上 fixed，max-width 78% 的 user 气泡延伸到 right: 32rpx margin 时，左侧 96rpx 区域（+ 号占位）跟 user 气泡右上角有可能视觉重叠。
2. **信息源筛选 chip 条长期占底部 80rpx**：5 个 chip（网页/文件/PDF/小红书/公众号）横排夹在 message-list 和 input-bar 中间，挤掉聊天内容可视空间，选中态视觉弱（5 个橙色 chip 并排难以辨识「我选了啥」）。

不解决 → 用户首次打开 chat 页可能「看着乱 / 不知道信息源在干嘛 / 不知道 + 号是干嘛的」 → 留存下降。

## Evidence

- **Validated**:
  - memory `feedback_pending_ui_tweaks.md` — 用户 2026-06-26 深夜「UI 还有要商榷修改的地方」+ 提出镜像 + 信息源过滤的诉求
  - commit `a05ff19` state-p10 §1.3 — 历史上有过「+ 号上移到 navigationBar 区域」尝试，因 env() 解析问题回滚 → 用户已在意 + 号位置
  - 代码: `apps/miniprogram/pages/chat/chat.wxss` chip 条 padding 12rpx + chip height ~40rpx + 16rpx gap ≈ 80rpx 占据底部空间
- **Assumption — needs validation via 真机回归**:
  - 「+ 号 FAB 真的遮 user 消息右半部分」是设计推断，**未经真机实测截图证实**。回归测试时若发现不重叠，需要回退镜像部分，只改信息源部分

## Users

- **Primary**: 首次扫码进入小程序的家长（潜在用户）。他们只有第一眼，决定「这能不能用 / 值不值得留下来」。
- **Secondary**: 当前唯一的真用户（owner, user_id `01KVCZ2JRBAGF3MY75D7KEY4RZ`）。他会在真机回归 + 截图中验证改动不破坏。
- **Not for**: 后端管理员 / 微信审核员（他们的反馈不通过 UI 通道）

## Hypothesis

我们相信 **把 chat 页的「user 靠右 / assistant 靠左」改成「user 靠左 / assistant 靠右」+ 把信息源筛选从底部固定 chip 条改成 popup 弹层**，会让**首次扫码的家长在看到 chat 页时不会因为 + 号视觉冲突 + 信息源条挤压产生「这是测试版」的第一印象**。

我们会知道这次改动对了，当：

1. **+ 号遮挡消息次数 = 0**（真机回归 5 路径，每条 user 消息肉眼检查无重叠）
2. **信息源筛选可达性 = 1 步**（从 chat 页点 🔍 立即进入筛选 popup）
3. **chat 页 message-list 可视区域增加 ~80rpx**（chip 条移除前后对比）
4. **5 路径真机回归全 PASS**（P10 已验过的 5 路径无破坏：冷启动 / chat 短问 / + 号新会话 / 历史 / settings）

## Success Metrics

| 指标 | 目标 | 怎么测 |
|---|---|---|
| + 号遮挡 user 消息 | 0 次 | 真机回归截图肉眼检查 |
| 信息源筛选点击数 | 1 次（点 🔍 直接进入 popup） | 真机手测 |
| chat 页底部留白增加 | ≥ 80rpx | 改前后 message-list height 对比 |
| 5 路径真机回归 | 全 PASS | 跟 P10 同样的 5 路径脚本（state-p10 §1.2） |
| 单测全绿 | 全 PASS | `pnpm -F miniprogram test` |
| typecheck | 0 错 | `pnpm -F miniprogram typecheck` |
| 上线 1.0.0 提审 | 1 次过 | 微信开发者工具上传 + 公众平台提交审核 |

## Scope

**MVP — 必须做**:

1. `apps/miniprogram/components/message-bubble/message-bubble.wxss` 改对齐:
   - `.bubble.user` 的 `align-self: flex-end` → `flex-start`，border-radius `28rpx 8rpx 28rpx 28rpx` 镜像成 `8rpx 28rpx 28rpx 28rpx`（圆角从小角移到大角，呼应镜像）
   - `.bubble.assistant` 的 `align-self: flex-start` → `flex-end`，border-radius `8rpx 28rpx 28rpx 28rpx` 镜像成 `28rpx 8rpx 28rpx 28rpx`
   - 保留 max-width 78% + box-shadow 偏移方向（user 阴影偏右下 → 偏左下？细节待 plan 阶段确认）
2. `apps/miniprogram/pages/chat/chat.wxml` + `chat.wxss`:
   - 删除 `<scroll-view class="source-picker">...</scroll-view>`
   - 加一个 🔍 图标按钮（位置：右上 ⚙ 下方，或左上 + 号右侧）
   - 加 popup 弹层（默认隐藏，点击 🔍 后从底部弹出）
3. `apps/miniprogram/pages/chat/chat.ts`:
   - 删除 `onToggleSourceType` 方法
   - 加 `onOpenSourceFilter` / `onCloseSourceFilter` / `onApplySourceFilter` 方法
   - 加 `sourceFilterOpen: boolean` 到 data
   - 保留 `availableSourceTypes` + `selectedSourceTypes` 数据结构
4. **真机回归**: 走完 P10 5 路径（state-p10 §1.2），截图肉眼检查
5. **截 5 张新截图**: 替换 `docs/launch/01-submission-materials.md` §5 引用的截图
6. **替换 docs 协议 URL 占位符**（独立 task，但跟这次改动一并提审）:
   - `docs/launch/01-submission-materials.md` §3.3 + `04-submit-review.md` §3.3 里 `https://YOUR_GITHUB_USERNAME.github.io/unequal-legal/` → `https://marktang1208.github.io/unequal/`
   - `privacy.html` 同上 → `https://marktang1208.github.io/unequal/privacy.html`
7. **替换 legal HTML 邮箱占位符**（独立 task，但跟这次改动一并提审）:
   - `legal-site/index.html` + `privacy.html` 里 `[填入你的邮箱]` → 用户提供的真实邮箱
   - push 到 gh-pages 分支

**Out of scope — 明确不做**:

- ❌ 不动 navigationBar（app.json 已简化，加自定义 navigationBar 复杂度大）
- ❌ 不改 + 号位置（保持左上 fixed top:24rpx left:24rpx，避开 navigationBar 胶囊按钮冲突）
- ❌ 不改 ⚙ 图标位置（保持右上 fixed）
- ❌ 不动 settings 页的 source 过滤（保留 settings 页里也有 source 过滤，迁移期冗余避免 mismatch）
- ❌ 不动信息源后端逻辑（chat.ts 调 api-chat 时的 `sourceTypes` 参数照常传，popup 改的是前端 state）
- ❌ 不写新功能（不写「最近用过的来源」「来源搜索」「来源推荐」）
- ❌ 不动 P10 已修的 bug（getClientIp crash fix 保留；chat 跨轮 session 复用 P11+ 修）
- ❌ 不动 corpus 内容（已知 1966 chunks 只有 ~3 条真育儿，P11+ ingest 真资料）
- ❌ 不动 NLI cold-start race（35% success rate，P11+ 修）

## Delivery Milestones

| # | Milestone | Outcome | Status | Plan |
|---|---|---|---|---|
| 1 | chat 页气泡镜像（user 左 / assistant 右） | 真机回归 + 号不遮消息 | in-progress | `.claude/plans/launch-ui-mirror-and-source-popup.plan.md` |
| 2 | chat 页信息源 popup 弹层（取代 chip 条） | popup 可开关 + 筛选生效 | in-progress | `.claude/plans/launch-ui-mirror-and-source-popup.plan.md` |
| 3 | docs/launch 协议 URL 占位符替换 | 真实 URL 写入提审物料 | pending | `.claude/plans/launch-ui-mirror-and-source-popup.plan.md` |
| 4 | legal HTML 邮箱占位符替换 + push gh-pages | 公开 URL 邮箱正确 | pending | `.claude/plans/launch-ui-mirror-and-source-popup.plan.md` |
| 5 | 5 路径真机回归 + 截 5 张新截图 | 截图替换 + 提审就绪 | pending | `.claude/plans/launch-ui-mirror-and-source-popup.plan.md` |
| 6 | 上传 1.0.0 + 提交审核 | 等待 1-3 天审核 | pending | — |

> **🟡 BLOCKER (T8)**: legal HTML 邮箱替换需要用户先提供真实邮箱（[填入你的邮箱] 占位符在 `legal-site/index.html:125` + `legal-site/privacy.html:160`）。未替换前 gh-pages 公开 URL 仍含占位符，提审会被打回。建议 `support@unequal.app` 或用户个人邮箱。

## Open Questions

- ❓ popup 弹层用 wx 原生 ActionSheet 还是自定义半屏弹窗？前者代码少但 UI 受限（不能放 checkbox，只能 radio），后者自由但要写动画。**倾向：自定义半屏**（因为信息源要支持多选，ActionSheet 的 radio 风格不匹配）
- ❓ popup 关闭策略：每次 tap checkbox 立即关闭 popup 写入？还是「应用 / 取消」双按钮？**倾向：每次 tap checkbox 立即生效 + popup 保留开着（实时预览），右上角 [×] 关闭**。原因：5 个选项不多，实时反馈更直接
- ❓ 🔍 图标位置：右上 ⚙ 下方 vs 左上 + 号右侧？**倾向：右上 ⚙ 下方**（信息源跟设置是同类 = 配置类，分散放更对称）。具体位置待 plan 阶段
- ❓ 真机回归发现 + 号其实没遮消息怎么办？**退路**: 仅保留镜像改动的 chip border-radius 视觉差异化（user/assistant 用不同色系），对齐保持现状 + 只做信息源 popup 改动
- ❓ legal-site 邮箱用什么？用户需提供（推送前 fill）
- ❓ 5 张新截图要不要包含「信息源 popup 打开状态」？**倾向：要**（展示新功能，但只占 5 张中的 1 张）
- ❓ 提审时备注要不要提「chat 页布局有调整」？**倾向：不提**（保持审核备注精简，不引导审核员细看）

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| 镜像布局让审核员觉得「不像聊天工具」，被打回 | 中 | 中（多排队 1-3 天） | 备注栏说明「左右镜像为产品差异化设计，便于家长快速识别自己提的问题」+ 截图用真实育儿 query 演示 |
| 真机回归发现 + 号根本没遮消息 → 镜像改动无意义 | 中 | 低 | 退路：保留镜像（视觉差异化收益仍然存在）+ 信息源 popup（核心收益）|
| popup 弹层在低端机上卡顿 | 低 | 中 | 用 CSS transition 而非 JS 动画 + popup 内容简洁（5 行 checkbox） |
| 用户没提供邮箱 → legal HTML 推送阻塞 | 中 | 高 | 显式列在 Open Questions + 任务清单，避免遗失 |
| 文档 URL 占位符忘改 → 提审被打回 | 高 | 高（已 P0 标识） | 跟 UI 改动一起做（同一 commit），避免二次提审 |
| 信息源 popup 改动破坏 P10 已修的 getClientIp 路径 | 极低 | 高 | popup 只动前端 state，不调任何 API，无网络请求 |
| typecheck 失败 | 低 | 中 | 改 wxss + wxml + ts 时各跑一次 `pnpm -F miniprogram typecheck` |
| 单测失败 | 低 | 中 | 现有 1 个 miniprogram chat 单测可能跟 chip 改动相关，plan 阶段先 grep 再决定 |

---

*Status: DRAFT — requirements only. Implementation planning pending via /plan.*