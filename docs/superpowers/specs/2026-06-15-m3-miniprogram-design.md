# M3 设计：微信小程序端单轮问答

> **For agentic workers:** 配套 plan: `docs/archive/plans/2026-06-15-m3-miniprogram-monorepo.md`（writing-plans 阶段产出）
> 上游：构想.md §九 M3 + §6 目录；spec 复用：M2 ask design §3 双层引用验证 + §5 ask 编排。

**Goal:** 微信小程序 + admin 内嵌 chat simulation 页双形态落地，端到端接 /ask 真接口，单轮问答 + 引用卡片可视化。零真人操作（无小程序注册、无 AppID、无真机调试）。

---

## 1. 范围（in-scope）

### 1.1 apps/miniprogram（monorepo 新包）

微信小程序原生开发（TypeScript + WXML/WXSS/JSON）：

| 路径 | 用途 |
|---|---|
| `apps/miniprogram/app.ts` | 小程序全局逻辑（onLaunch） |
| `apps/miniprogram/app.json` | 全局配置（页面注册、tabBar） |
| `apps/miniprogram/app.wxss` | 全局样式 |
| `apps/miniprogram/pages/chat/chat.ts` | 对话页逻辑（拉 /ask） |
| `apps/miniprogram/pages/chat/chat.wxml` | 对话页结构 |
| `apps/miniprogram/pages/chat/chat.wxss` | 对话页样式 |
| `apps/miniprogram/pages/chat/chat.json` | 对话页配置 |
| `apps/miniprogram/pages/source-detail/source-detail.ts` | 引用原文详情逻辑 |
| `apps/miniprogram/pages/source-detail/source-detail.{wxml,wxss,json}` | 同上 |
| `apps/miniprogram/pages/history/history.{ts,wxml,wxss,json}` | 历史问答（localStorage 暂存） |
| `apps/miniprogram/components/citation-card/citation-card.{ts,wxml,wxss,json}` | 引用卡片组件（标题 / 摘要 / 原文链接） |
| `apps/miniprogram/components/message-bubble/message-bubble.{ts,wxml,wxss,json}` | 消息气泡（user / assistant） |
| `apps/miniprogram/lib/api.ts` | /ask 请求封装（fetch + 鉴权） |
| `apps/miniprogram/lib/types.ts` | 小程序端类型（与 packages/shared 对齐） |
| `apps/miniprogram/lib/storage.ts` | localStorage 历史问答封装 |
| `apps/miniproproject.json5` | tsconfig 独立配置（extends tsconfig.base.json） |
| `apps/miniprogram/project.config.json` | 微信开发者工具项目配置（占位 AppID） |
| `apps/miniprogram/project.private.config.json` | 私有配置（gitignored） |
| `apps/miniprogram/sitemap.json` | 索引配置 |
| `apps/miniprogram/package.json` | npm 包（typecheck + lint scripts） |
| `apps/miniprogram/.gitignore` | miniprogram_npm/ + project.private.config.json |
| `apps/miniprogram/test/api.test.ts` | lib/api.ts 单元测试（mock fetch） |

### 1.2 apps/admin（已有，新增强化）

| 路径 | 用途 |
|---|---|
| `apps/admin/src/pages/ChatSim.tsx` | admin 内嵌 chat 仿真页（验 /ask 端到端，先于真机调试） |
| `apps/admin/src/App.tsx` | 加 /chat-sim 路由 + 导航 |
| `apps/admin/src/lib/api.ts` | 已 ask() 函数；本步不加新 |

### 1.3 docs/

| 路径 | 用途 |
|---|---|
| `docs/wechat-miniprogram-setup.md` | 真人操作 checklist（注册 / AppID / 真机调试 / 提审） |
| `README.md` | 追加 M3 状态段（仿 M2 README） |

### 1.4 根级配置

| 路径 | 用途 |
|---|---|
| `pnpm-workspace.yaml` | 加 `apps/miniprogram` 到 workspaces |
| `package.json` | 加 typecheck 集成 miniprogram（如能 typecheck） |

---

## 2. 范围外（out-of-scope，推 v2+/M4+）

- ❌ 微信扫码登录（个人主体注册 + wx.login 是 CP-5+ 真机调试范围）
- ❌ 真机发布 / 提交审核（需个人主体审核通过）
- ❌ 多轮会话 / Durable Objects（M6 范围）
- ❌ 历史问答云端同步（M6 范围，本地 localStorage 临时方案）
- ❌ 网页 / 小红书 / 公众号抓取（M4/M5 范围）
- ❌ 用户体系（M6 范围，本地单租户）
- ❌ 小程序端 E2E（需真 AppID + 真机；推到 v2+）
- ❌ admin ChatSim 多轮 / SSE 流式（M6 范围）
- ❌ 引文卡片分页（M3 限制 5 条 topK；M2 ask 已实现）

---

## 3. 关键技术设计

### 3.1 API 复用：lib/api.ts 一致性

`apps/miniprogram/lib/api.ts` 与 `apps/admin/src/lib/api.ts` 共享**逻辑**而非代码：

- 两者都调 `/api/ask`（小程序端：开发用 `http://localhost:8787`；admin 端：Vite proxy 已配）
- 鉴权：都从 token storage 拿（admin：`localStorage.token`；小程序：`wx.getStorageSync('admin_token')` 或占位）
- 都用同一套 AskResponse 类型（与 M2 `packages/shared/src/types.ts` Citation 对齐）

**为什么不复用代码**：微信小程序运行时是 wxml/wxss/jsapi，没有 node 模块系统，无法 import vite 模块。admin 用 React + Vite。两个端各写一套薄 wrapper 是 KISS 准则下的正确选择。

### 3.2 lib/types.ts 共享类型

```ts
// 与 packages/shared/src/types.ts 的 Citation / AskResponse 对齐
export interface Citation {
  n: number;          // 1..5
  title: string;
  snippet: string;
  url: string;        // R2 原始文件 URL 或 raw_path
  trustLevel: 0 | 1 | 2 | 3;
  sourceId: string;
  chunkId: string;
}

export interface AskResponse {
  answer: string;     // 含 [来源 N] 标记 + 免责声明
  disclaimer: string;
  citations: Citation[];
  cached: boolean;
}

export interface AskError {
  error: string;
  detail?: string;
}

export interface HistoryEntry {
  id: string;         // ulid
  q: string;
  response: AskResponse;
  createdAt: number;  // ms
}
```

### 3.3 Mock-first 边界（重要：与 M2 一致）

| 操作 | 状态 |
|---|---|
| 注册小程序个人主体 | ❌ 不做（真人） |
| 获取 AppID | ❌ 不做（真人） |
| 微信开发者工具 | ❌ 不装（真人） |
| 真机调试 | ❌ 不做（真人） |
| 提交审核 | ❌ 不做（真人） |
| `apps/miniprogram/` 代码骨架 | ✅ 全做 |
| `apps/miniprogram/lib/api.ts` mock fetch 单测 | ✅ Vitest |
| `apps/admin/src/pages/ChatSim.tsx` + 路由 | ✅ 全做（admin ChatSim 是 mock-first 端的"用户侧"） |
| `/ask` 调本地 mock（CP-5 前） | ✅ 已有（API dev server） |
| `/ask` 调真 Cloudflare（CP-5 后） | ✅ admin ChatSim 可立刻验（admin 调生产 URL） |
| 小程序真机联调 | 🟡 真人拿到 AppID 后做 |

### 3.4 真人操作 checklist（spec 列出，推到用户拿到 AppID 后做）

`docs/wechat-miniprogram-setup.md` 包含：

1. mp.weixin.qq.com 注册个人主体（30 元/年，身份证 + 微信扫码）
2. 邮箱激活 → 获取 AppID
3. 装微信开发者工具（macOS）：https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html
4. 项目导入：`文件 → 导入项目 → 项目目录 apps/miniprogram → AppID 填真值`
5. 勾选「不校验合法域名」（开发期）
6. 真机预览：右上角「预览」扫码
7. 提审前需改 project.config.json 的 miniprogramRoot / appid，并配置 request 合法域名

### 3.5 /ask 调用约定

小程序端（chat 页面）：

```ts
const res = await ask(q);
// res.answer 含 [来源 1] [来源 3] 等标记
// res.citations 是结构化引用卡片数据
// res.disclaimer 是免责声明
```

admin ChatSim（与小程序同协议）：

```tsx
<form onSubmit={ask(q)}>
  {resp.answer}
  {resp.citations.map(c => <CitationCard ... />)}
</form>
```

---

## 4. 数据流（端到端）

```
┌────────────────────────────────┐
│ Chat Page / ChatSim            │
│ user: 5个月宝宝发烧38.5怎么办     │
└──────────┬─────────────────────┘
           │ POST /ask { q }
           │ Authorization: Bearer <token>
┌──────────▼─────────────────────┐
│ Cloudflare Worker API          │
│ (CP-5 前: localhost:8787       │
│  CP-5 后: unequal.xxx.workers.dev)
└──────────┬─────────────────────┘
           │ /ask → runAsk → embed → search → prompt → LLM → verify → disclaimer
           ▼
┌────────────────────────────────┐
│ { answer, disclaimer,           │
│   citations[], cached }         │
└──────────┬─────────────────────┘
           │
┌──────────▼─────────────────────┐
│ 渲染：answer 文本 + 引用卡片      │
│ + history localStorage          │
└────────────────────────────────┘
```

---

## 5. UI 设计（高层，不做视觉细节）

### 5.1 Chat 页

- 顶部：标题栏「不等号 · 育儿问答」
- 中部：滚动消息列表（user 右对齐蓝气泡，assistant 左对齐白气泡含 [来源 N] 标记）
- 底部：textarea + 「提问」按钮
- 引用卡片渲染：`message-bubble` 内嵌 `citation-card` 列表，点击跳转 `source-detail` 页

### 5.2 Source Detail 页

- 顶部：标题 + 来源信任等级 badge
- 中部：chunk 全文
- 底部：跳 R2 原文按钮（开发期禁用，真机 + 合法域名配置后启用）

### 5.3 History 页

- localStorage 拉历史问答列表
- 每条 item：问题 + 时间 + 「再次问」按钮（跳 chat 带 q）
- 顶部「清空历史」按钮

### 5.4 ChatSim (admin) 页

- 与小程序 Chat 页一致布局
- 唯一区别：调本地 /ask 走 Vite proxy

---

## 6. 验收标准

| 项 | 标准 |
|---|---|
| `pnpm -r typecheck` | 全绿（含 apps/miniprogram） |
| `pnpm -F miniprogram test` | lib/api.ts 单测 ≥ 4 用例 |
| `pnpm -F admin build` | 成功（含 ChatSim 页） |
| `pnpm -F admin test` | （如有）全绿 |
| `docs/wechat-miniprogram-setup.md` | 真人 checklist 完整 |
| README M3 段 | 已有 |

---

## 7. CP 划分（建议 4-5 个）

| CP | 范围 | Task 数 |
|---|---|---|
| CP-1 | monorepo 接入 + lib 层（api.ts + types.ts + storage.ts）+ Vitest 单测 | 4-5 |
| CP-2 | admin ChatSim 页 + 路由 + 集成 /ask | 2-3 |
| CP-3 | apps/miniprogram 骨架（app.* + 全局配置） | 2-3 |
| CP-4 | 小程序页面（chat + source-detail + history）+ 组件（citation-card + message-bubble） | 4-5 |
| CP-5 | docs + 真机 checklist + README + CP-5 收尾 | 1-2 |

具体 task 划分由 writing-plans skill 产出。

---

## 8. 与 M2 边界

- ✅ 复用：M2 `/ask` endpoint（M3 只是新加客户端）
- ✅ 复用：`packages/shared/src/types.ts` Citation 类型（M3 在 lib/types.ts 镜像一遍）
- ✅ 复用：M0+M1 admin 鉴权 token 体系（M3 admin ChatSim 用同一 getToken）
- ❌ 不动：M2 ask.ts / cache.ts / migrations（仅消费）
- ❌ 不动：wrangler.jsonc（M3 不影响部署）

---

## 9. 与上游 spec 的偏差

无。M3 范围严格对齐 `构想.md §九 M3 + §6 目录`。
