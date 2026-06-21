# CP-7 真接 — 微信小程序 + CloudBase 端到端验证

**完成日期**：2026-06-20（真接 PASS）
**前置**：CP-7-A（commit `65fae87`）+ CP-7-B（commit `db843c0`）+ 真接 prep（commit `94968ed`）
**Tag**：`cp7-zhenjie-archived`

---

## 1. 摘要

经过 **9 轮真接迭代**（一开始全链路 4 个串联 bug → 设计系统全套上线 → RAG 富文本端到端 PASS），CP-7 全功能在**真实 CloudBase 环境 + 真实微信小程序 + 真实知识库**下验证 PASS：

- ✅ wx-login → JWT → callFunction 全链路（CP-7-A）
- ✅ 7 caller 全部 cloudCall（CP-7-A）
- ✅ rename / nickname 2 新 handler（CP-7-B）
- ✅ `[N]` 富文本（CP-7-B）
- ✅ session 详情复显（round 3 新增）
- ✅ 06 童心日历设计语言（round 5-8 新增）
- ✅ RAG 检索 + citation title（round 9 新增）

**核心验收画面**（最终 PASS）：
- 真机问「宝什么时候断奶」
- LLM 返完整断奶建议 + `[1] [3] [4]` 等橙色圆形数字徽章嵌在文本流中
- 6 处不同位置的引用全部正确解析
- 点击徽章弹 toast 显示「宝宝多大断奶好？不是1岁，也不是2岁，就看7个信号！」

---

## 2. 9 轮真接发现 + 修复

### Round 1（2026-06-19）：CP-6 时代 sessions handler 设计 bug

- **症状**：smoke 端到端调 `PATCH /api-sessions-rename` 返 404
- **根因**：handler 用 `getById`（查 CloudBase `_id`），但 caller 传 schema `id`（list 返的 id）
- **修复**（commit `94968ed`）：3 sessions handler 改 `whereQuery({id}, {limit:1})` + update/remove 用 `session._id`
- **教训**：复制旧 handler 模式时必须验证 ID 字段语义

### Round 2（2026-06-20 早）：JWT.sub 是空字符串的核弹

- **症状**：minipgm 输入名字后弹「保存失败」
- **根因**（最关键的 CP-6 设计 bug）：
  - `db.add()` 生成 CloudBase `_id`（ULID），但 schema `id` 字段没填
  - `wx-login` handler 给 `newUser.id = ""` + add() 后 sign JWT 用 `user.id`
  - 结果：**JWT.sub 一直是空字符串 ""** + 所有 user-scope 调用 userId="" 写库（污染）
- **修复**（commit `b7bee4a`）：
  - `wx-login` 改 `signJwt({ userId: user._id })`
  - `nickname` handler 同步用 `userId` 直接当 `_id` 查
  - 副作用：旧 userId="" 的会话/chunks 不再可访问（属预期清污）

### Round 2（同 commit）：3 个连锁 bug

- LLM 抄字面 `[N]` → 改 system prompt 明确 N 是数字 + 给正反例
- minipgm chat.ts user msg 没传 segments → 给 user msg 加默认 `segments: []`
- `parseAnswerSegments` 类型混淆（api 返对象 vs minipgm 返数组）→ user msg 改成空数组 `[]`

### Round 3：history 切换 chat 后看不到旧消息

- **症状**：从 history 长按重命名 / 短按进 session 后 chat 页空白
- **根因**：chat.ts onShow 切 session 时清空 messages，但只在 sid 变化时拉历史。冷启动后 onLoad 读了持久化 sid，再切到 history 点击同一 sid → sid 没变 → 不进 reload 分支
- **修复**（commit `d5c6b41`）：onShow 加 `else if messages.length === 0` 兜底
- 同时新增 `getSession` caller + `loadSessionMessages` + `SessionDetailResponse` 类型

### Round 4-5：UI 配色 + UX 优化

- history 列表 UI 优化：卡片样式 + 相对时间 + 长按提示（commit `6a7e10f`）
- 全局 B 温暖调统一（commit `5add206`）
- 用户后续反馈："抛开历史 tab，重新设计" → 推出 6 种风格选择
- 用户选 **06 童心日历**（commit `1715a88`）
- 标题颜色调暖橙 `#ff8a65`

### Round 6-8：小程序 wxss 兼容性

- **症状**：粗描边 + 偏移阴影在某些 view 上没渲染
- **根因 1**：小程序 view 对 `< 2px` 的 rpx 边框会四舍五入吃掉 → 改 px 单位（commit `7b68b1b`）
- **根因 2**：scroll-view 的 `overflow-y: auto` 裁掉子元素 `box-shadow`（commit `9310e29`）
- **修复**：
  - `border` 全改 `2-3px solid` 强制保留
  - `box-shadow` 加显式 spread `0`（4-value 语法）
  - 给气泡加 `margin-right` 让阴影留显示空间
  - `.message-list` 加 `overflow-x: visible`

### Round 9（最关键）：RAG 检索全链路修复

灌库后 chat 仍返"参考资料中未涉及"。

**诊断过程**：
1. 通过临时 `api-debug-chunks` handler dump CloudBase
2. 确认 5 chunks 完整在表 + userId 对齐 + embedding 1536 维都在
3. 加 chat handler 日志：`fetched chunks=5, queryVecLen=1536, top.length=5, top[0]?.score=1.05`
4. **底层检索完全 OK**

**真正根因**：
- `searchChunks` 返的 `chunkId = c._id ?? c.id`（retrieval.ts:88）
- 但 chat handler 用 `chunksWithEmb.find((c) => c.id === t.chunkId)` find chunk
- `c.id` 是空字符串 → find 总返 `undefined`
- 拼出的 context 全是 `[1] 《?》 (空)` → LLM 看到空 context → "未涉及"

**修复**（commit `010b41b` + `9bf72ee`）：
- `findChunk(chunkId)` helper 用 `(c._id ?? c.id) === chunkId` 对齐
- doc lookup 改用 `getById(_id)` 不是 `whereQuery({id})`（chunk.documentId 是 add() 返的 _id）
- docMap key 用 `d._id`
- **副作用**：第一次 deploy 触发 esbuild TDZ bug（dynamic import 重复声明 `getById3`）→ 改静态 import 复用顶部 import

**最终验证**：
```
citedNums: [1, 3, 4, 5]
citations[0].title = "宝宝多大断奶好？不是1岁，也不是2岁，就看7个信号！"
```

---

## 3. 真接全链路 commit chain

| # | Commit | 内容 |
|---|---|---|
| 1 | `b7bee4a` | wx-login JWT.sub 用 _id + nickname handler 同步 + LLM prompt + minipgm segments |
| 2 | `dc5d0e4` | minipgm segments 类型 + adminLogin body field |
| 3 | `55f6405` | history 长按抑制 tap + chat onShow 复显历史 |
| 4 | `6a7e10f` | history 列表 UI 优化 — 卡片样式 + 时间格式化 + 长按提示 |
| 5 | `5add206` | B 温暖调全局应用 |
| 6 | `1715a88` | 切换至 06 童心日历风格 |
| 7 | `7b68b1b` | border 改 px 修描边渲染 |
| 8 | `9310e29` | scroll-view overflow 裁切修复 |
| 9 | `d5c6b41` | chat onShow 同 sid 但 messages 为空时也拉历史 |
| 10 | `eae1b14` | ingest 加 user_id 参数 + crawl-and-ingest 临时脚本 |
| 11 | `010b41b` | chat handler chunk/doc 映射用 _id（RAG 检索 + title） |
| 12 | `9bf72ee` | chat handler 删 dynamic import getById 避免 TDZ 错误 |

**共 12 commit**（不含 CP-7-A / CP-7-B merge 前的 commit）

---

## 4. 资源 + 凭证

| 资源 | 值 |
|---|---|
| CloudBase env | `unequal-d4ggf7rwg82e0900b` |
| CloudBase appid | `1444590671` |
| Gateway URL | `https://unequal-d4ggf7rwg82e0900b-1444590671.ap-shanghai.app.tcloudbase.com` |
| Mini-program AppID | `wxf5b8ce05a977f0c6` |
| 测试 wx user_id | `01KVCZ2JRBAGF3MY75D7KEY4RZ`（绑测试 chunks）|
| 测试文章 | 「宝宝多大断奶好？不是1岁，也不是2岁，就看7个信号！」(5 chunks, trust 2) |
| ADMIN_IP_ALLOWLIST | `240e:3b4:38ed:4100:10a1:f77f:f362:d8b0,113.116.119.197`（已恢复）|

---

## 5. 验收清单（全 PASS）

| # | 测试项 | 结果 |
|---|---|---|
| D.1 | wx.cloud.init + ensureJwt + JWT.sub = _id | ✅ |
| D.2 | /api-chat 多轮问答 | ✅ |
| D.3 | `[N]` 富文本可点击 + showToast 显示真 title | ✅ |
| D.4 | history 列表 + 卡片样式 + 时间格式化 | ✅ |
| D.5 | rename 长按 → 操作表 → 改 title | ✅ |
| D.6 | delete 长按 → 操作表 → 删除 | ✅ |
| D.7 | nickname 保存 → toast 提示 | ✅ |
| 设计 | 06 童心日历全套（米黄背景 + 粗描边 + 偏移阴影 + 圆形 chip） | ✅ |
| RAG | embedding 检索 + cosine 相似度 + citation title 映射 | ✅ |

---

## 6. 临时调试资产（CP-7-C 收尾中）

| 资产 | 说明 | 处理 |
|---|---|---|
| `apps/api/src/handlers/api-debug-chunks.ts` | dump 该 user chunks（含 embeddingLen 验证）| ✅ CP-7-C #1 已删文件 + 删 import + 删 HANDLER_MAP 注册（待 commit + bundle + deploy）|
| `apps/api/src/handlers/api-debug-docs.ts` | dump 该 user docs | ✅ CP-7-C #1 已删文件 + 删 import + 删 HANDLER_MAP 注册（待 commit + bundle + deploy）|
| `apps/api/scripts/crawl-and-ingest.ts` | 临时拉文章 + ingest 脚本 | 已 commit；正式应集成进 crawler CLI |
| `api-ingest` handler 的 `user_id` 参数 | 让 ingest 可指定 userId | 已 commit；正式产品需要更严格的鉴权 |

---

## 7. 教训汇总

1. **JWT 设计 bug 隐藏几个月**：CP-6 时 JWT.sub="" 一直没暴露因为所有调用都 userId=""；直到 nickname handler 用 `getById(userId)` 期望真 _id 才崩。教训：**任何 add() 返的 _id 要和 schema id 字段同步**（或者干脆只用一个）。

2. **chunk/doc 字段对齐**：`searchChunks` 返 `_id ?? id`，chat find 用 `c.id` → 永远查不到。教训：**helper 返什么用什么 find**，不要假设字段。

3. **esbuild TDZ 陷阱**：同文件同名 import 一个静态、一个 dynamic → bundle 时变量被重命名但 TDZ 触发。教训：**避免 dynamic import 重复声明已静态 import 的变量**。

4. **小程序 wxss 兼容性**：rpx < 2 被吃 + scroll-view 裁 shadow。教训：**真机验收前别假设 CSS 跟浏览器一样**；用 px 而不是 rpx 做描边；给 overflow 容器加 visible 让阴影出来。

5. **设计反复迭代是正常的**：从渐薄玻璃 → 温暖调 → 6 种风格选择 → 童心日历，是用户自然演进。教训：**配色用浏览器预览页比文字描述快 10 倍达成共识**。

6. **CloudBase CLI 3.5.7 deploy 只更新代码**：每次 deploy 后必须单独 `tcb config update fn` 推 env vars。教训：**deploy 工具的"成功"提示需验证实际行为**（已记在 state-cp7-b.md §6.3）。

7. **临时绕过限制要记得收回**：测试时临时加 IP 到 allowlist + 加 debug handler，收尾必须清理。教训：**真接报告写到这一步就立刻 sed + redeploy 收掉**。

---

## 8. 下一步

CP-7-C 候选（独立项目）—— **2026-06-21 真接全 PASS**：

1. ✅ 删除临时 debug handlers（CP-7-C #1）— commit `fcc3693`；真接验证：调 `/api-debug-chunks` + `/api-debug-docs` 返 `404 NOT_FOUND`。
2. ✅ ingest user_id 参数加更严格鉴权（CP-7-C #2）— spec `docs/superpowers/specs/2026-06-21-cp7-c-ingest-audit-design.md`；impl commit `be61e1c`；真接 AC：
   - **AC-3** proxy + user_id → 200 + 2 audit log（in_progress + success）；source_id=`01KVM3PMZ...`，document_id=`01KVM3PN1...`，1 chunk 灌入 userId=`01KVCZ2JRBAGF3MY75D7KEY4RZ`
   - **AC-4** admin + user_id → 403 `INSUFFICIENT_SCOPE`
   - **AC-7** admin + 无 user_id → 200 回归（chunks 绑 DEFAULT_USER_ID `01H0000000000000000000000`）
   - **AC-9** IP allowlist 同时约束 admin + proxy（unknown IP 返 403 已证）
   - **AC-5/AC-8** skip（destructive 边缘：删 audit_log collection / 改 env）
3. ✅ crawler CLI 集成 user_id 支持（CP-7-C #3）— spec `docs/superpowers/specs/2026-06-21-cp7-c3-crawler-userid-design.md`；impl commit `f5ae83e`；真接 AC：
   - **AC-3** CLI proxy + user-id 端到端 → ingest ok（httpbin.org/html 抓取 + 1 chunk 灌入 wx user）
   - **AC-4** CLI token + 无 user-id → ingest ok（admin 路径，绑 DEFAULT_USER_ID）
   - **AC-5/6/7** fail-fast exit 1 + stderr：user-id 缺 proxy / proxy+token 互斥 / 两者都缺
   - **AC-8** 数据隔离 spot check：5/5 新 chunks 正确 userId 归属（2 个 wx user + 3 个 DEFAULT_USER_ID）
4. ✅ 修 `db.add()` 让 schema `id` 字段自动填（CP-7-C #4）— spec `docs/superpowers/specs/2026-06-21-cp7-c4-db-add-autoid-design.md`；impl commit `62734ab`；真接 spot check：5/5 新 chunks 的 `id` 字段 == `_id`（自动填成功）。

### CP-7-C 真接部署细节（2026-06-21 11:25-11:32）

- **bundle 路径**：`apps/api/functions/api-router/index.js`（deploy-build 输出） → 复制到 `apps/miniprogram/cloudfunctions/api-router/index.js`（tcb fn deploy 实际读这里）
- **deploy 流程**：`tcb --config-file /tmp/cloudbaserc.deploy.json fn deploy api-router --force`（用临时 config 含完整 13 env vars，避开污染 `apps/api/cloudbaserc.json`）
- **crawler 端 URL 修正**：CLI 默认 URL 含 `/api-router` 前缀（HTTP 触发器不 strip），实际生产 URL = `https://.../api-ingest`（去掉 `/api-router`）
- **IP allowlist 扩展**：crawler Mac 出口 = `113.118.175.164`（IPv4）和 `240e:3b4:38e4:8720:11f4:7016:4335:e655`（IPv6 ifconfig 看到的），都已加进 `ADMIN_IP_ALLOWLIST`（共 4 条）
- **未消耗的新 secret**：`openssl rand -hex 32` 生成了 `285272dd...` 但生产已有 `5852adc6...`，**新 secret 未使用、未 commit**（仅在我本地 shell 打印过；按 zsh subshell 模式已重置）

5. 修 `tcb fn deploy` 流程内化 env vars push（state-cp7-b §6.3 教训 #7）
6. 把 documents 的 schema id 字段补回（数据迁移；#4 上线后新数据自动正确，仅历史数据需 cleanup）

---

## 9. References

- **CP-7-A state**：`docs/superpowers/state-cp7-a.md`
- **CP-7-B state**：`docs/superpowers/state-cp7-b.md`
- **CP-7 真接 checklist**：`docs/superpowers/cp7-zhenjie-checklist.md`
- **测试文章**：https://mp.weixin.qq.com/s/50y5re6jivLGLzd5fTtaTA
