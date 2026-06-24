# M6.1 多轮会话 + Durable Objects

- **状态**：待用户复核
- **日期**：2026-06-16
- **范围**：M6.1 阶段 — 多 session 独立模型 + Durable Object 会话状态 + D1 session 列表 + 小程序双 tab + admin 多 session ChatSim
- **不包含**：M6.2（wx.login + JWT）— 接口预留，详见 §7
- **配套设计**：`docs/superpowers/specs/2026-06-14-unequal-top-level-design.md` §2 (Durable Objects) / §5.3 (多轮对话) / §3.3 (用户体系)

---

## 0. 目标

把「单轮问答 + admin 全局共享」升级到「家长可登录的多轮会话产品」：
- 家长可在小程序创建多个独立 session（如「宝宝发烧」「辅食添加」），互不串
- 跨 session 保留历史，session 列表可重命名 / 删除
- admin 可在 ChatSim 调试多 session 行为（M3 ChatSim 升级）
- M6.2 留好 wx.login + JWT 切换点

**产品原则**（与 top-level design §0 一致）：
- 有据可依：每条答案必引用
- 不知道就说不知道
- 强制医疗免责声明

---

## 1. 架构

### 1.1 组件图

```
┌──────────────────┐   ┌──────────────────────────────┐
│ 微信小程序        │   │ admin ChatSim (M3 升级)     │
│ 双 Tab：对话/历史 │   │ 多 session 切换 + 重命名    │
└──────┬───────────┘   └──────┬───────────────────────┘
       │ wx.request (Bearer)   │ HTTPS (Bearer)
       ▼                       ▼
┌─────────────────────────────────────────────────────┐
│  Cloudflare Workers (API 网关)                       │
│  /ask /chat /sessions /sessions/:id (PATCH/DELETE)  │
│  ── Durable Object: ChatSessionDO (一 session 一 DO) │
└──────┬───────────────┬──────────────┬───────────────┘
       │               │              │
       ▼               ▼              ▼
   ┌───────┐      ┌─────────┐    ┌──────────┐
   │ D1    │      │ DO      │    │ Vectorize│
   │ session│     │ state.  │    │   / R2   │
   │ 列表   │     │ storage │    │          │
   │       │      │(messages)│   │          │
   └───────┘      └─────────┘    └──────────┘
```

### 1.2 关键抽象

- **一个 session = 一个 Durable Object instance**：DO 名字 = `session:${userId}:${sessionId}`，Cloudflare 按名字全球唯一路由
- **DO 内嵌 SQLite 替代方案**（方案 A）：用 `state.storage` KV 持久化 messages，内存 cache 用于读取
- **D1 存 session 列表**（不存 message 全文）：`chat_session(id, user_id, title, created_at, last_active_at)`
- **D1 chat_session 限额**：每 user 最多 50 个；不活跃 30 天后 lazy 过期

### 1.3 /chat 数据流

1. Worker 收 `POST /chat { q, session_id? }`
2. 若 `session_id` 缺 → 生成 ULID → 写 D1 `chat_session` row → 创建 DO instance
3. 调 `env.SESSION_DO.get(idFromName(\`session:${userId}:${sessionId}\`))` 拿 stub
4. Stub 返回 `{ messages: [...] }`（从 `state.storage` 加载）
5. 取最近 3 轮（每轮 = user + assistant），拼到 RAG query 前缀（见 §4）
6. 调 RAG pipeline（与 /ask 共享 `runRagPipeline`）：embedding → Vectorize → prompt → LLM → 双层验证
7. 写回 DO：`{ role: 'user', content: q }` + `{ role: 'assistant', content: answer, summary: 50字 }`
8. 首问：调 LLM 生成 10 字 title → 写 D1 `chat_session.title`
9. 更新 D1 `chat_session.last_active_at`
10. 返回 `{ answer, citations, session_id, session_title, is_new_session, cached: false }`

---

## 2. 数据模型

### 2.1 D1 Migration 0003

```sql
-- 多轮会话列表（D1 只存 metadata，不存 message 全文）
CREATE TABLE chat_session (
  id TEXT PRIMARY KEY,              -- ULID
  user_id TEXT NOT NULL,
  title TEXT,                       -- 首问后 LLM 生成 10 字
  created_at INTEGER NOT NULL,
  last_active_at INTEGER NOT NULL,  -- 用于 30 天过期判定
  degraded_at INTEGER,              -- DO 路由失败时标记
  FOREIGN KEY (user_id) REFERENCES user(id)
);
CREATE INDEX chat_session_user_active_idx
  ON chat_session(user_id, last_active_at DESC);
```

### 2.2 Durable Object 结构

```ts
// apps/api/src/do/chat-session.ts
export class ChatSessionDO implements DurableObject {
  state: DurableObjectState;
  env: Env;
  messages: ChatMessage[] = [];   // 内存 cache

  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.state.blockConcurrencyWhile(async () => {
      this.messages = (await this.state.storage.get<ChatMessage[]>('messages')) || [];
    });
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/append') return this.handleAppend(req);
    if (url.pathname === '/list')   return this.handleList();
    if (url.pathname === '/reset')  return this.handleReset();
    return new Response('Not found', { status: 404 });
  }

  private async handleAppend(req: Request) {
    const msg: ChatMessage = await req.json();
    this.messages.push(msg);
    await this.state.storage.put('messages', this.messages);
    return new Response(JSON.stringify({ ok: true, count: this.messages.length }));
  }

  private handleList() {
    return new Response(JSON.stringify({ messages: this.messages }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  private async handleReset() {
    this.messages = [];
    await this.state.storage.delete('messages');
    return new Response(JSON.stringify({ ok: true }));
  }
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;       // user: 全文；assistant: 全文
  summary?: string;      // assistant: 50 字摘要（retrieval 用）
  created_at: number;
}
```

### 2.3 ID 与命名

- `session_id` = ULID（`ulid` npm 包），与现有 `user.id` / `source.id` / `document.id` 风格一致
- DO 名字：`session:${userId}:${sessionId}`
- 排序：ULID 字典序 = 时间顺序 → D1 `ORDER BY id DESC` = 「最近创建」

---

## 3. API 接口

### 3.1 端点清单

| 方法 | 路径 | 用途 | 鉴权 |
|---|---|---|---|
| POST | `/chat` | 多轮问答（带 session_id） | ADMIN_TOKEN（M6.1）→ JWT（M6.2） |
| GET | `/sessions` | 列出当前用户所有 session（按 last_active_at 倒序，过滤过期） | 同上 |
| PATCH | `/sessions/:id` | 重命名 title | 同上 |
| DELETE | `/sessions/:id` | 删除 session（D1 + DO 清理） | 同上 |

### 3.2 POST /chat

**请求**：
```json
{ "q": "那 38.5 以下呢？", "session_id": "01HXYZ..." }
```

**响应（成功）**：
```json
{
  "answer": "38.5°C 以下建议物理降温... [来源 1] [来源 2]\n\n以上信息来源于...",
  "disclaimer": "以上信息来源于知识库内容，不构成医疗建议。",
  "citations": [
    { "n": 1, "title": "...", "trust_level": 3, "chunk_id": "01H..." }
  ],
  "session_id": "01HXYZ...",
  "session_title": "宝宝发烧38.5",
  "is_new_session": false,
  "cached": false
}
```

**错误码**：

| 状态 | 错误码 | 含义 |
|---|---|---|
| 400 | `MISSING_Q` | `q` 缺 / 长度超 500 字 |
| 400 | `BAD_SESSION_ID` | session_id 格式错（非 ULID） |
| 401 | `UNAUTHORIZED` | ADMIN_TOKEN 缺 / 错 |
| 404 | `SESSION_NOT_FOUND` | session_id 不存在（已过期或被删） |
| 409 | `SESSION_LIMIT_EXCEEDED` | session 数已超 50 |
| 503 | `LLM_FAILED` | LLM 3 次重试后仍失败 |

### 3.3 GET /sessions

**响应**：
```json
{
  "sessions": [
    {
      "id": "01HXYZ...",
      "title": "宝宝发烧38.5",
      "created_at": 1749000000000,
      "last_active_at": 1749000050000
    }
  ]
}
```

注：`message_count` 不在 M6.1 返回（消息在 DO 内，每次查都打一次 DO stub 不值得）。v2+ 加 `/sessions/:id/stats` 端点。

### 3.4 PATCH /sessions/:id

**请求**：
```json
{ "title": "宝宝发烧处理" }
```

**校验**：title 长度 1-30 字；超 30 截断（不报错）

### 3.5 DELETE /sessions/:id

硬删：D1 DELETE row + `state.storage.deleteAll()` 兜底。仅删自己 user 的（`WHERE user_id = ?` 防越权）

---

## 4. 多轮上下文拼接

### 4.1 拼接算法

```ts
// packages/shared/src/multiturn.ts
export function buildMultiturnPrefix(messages: ChatMessage[], windowSize = 3): string {
  const rounds = groupIntoRounds(messages).slice(-windowSize);
  if (rounds.length === 0) return '';
  return rounds.map((round, i) => {
    const user = round.find(m => m.role === 'user')?.content || '';
    const asst = round.find(m => m.role === 'assistant');
    const summary = asst?.summary || asst?.content.slice(0, 50) || '';
    return `[第 ${i + 1} 轮]\n用户: ${user}\n助手: ${summary}`;
  }).join('\n\n');
}

function groupIntoRounds(messages: ChatMessage[]): ChatMessage[][] {
  const rounds: ChatMessage[][] = [];
  let current: ChatMessage[] = [];
  for (const m of messages) {
    current.push(m);
    if (m.role === 'assistant') {
      rounds.push(current);
      current = [];
    }
  }
  return rounds;
}
```

拼接后喂给 RAG：
```ts
const enrichedQ = contextPrefix
  ? `${contextPrefix}\n\n[当前问题]\n${q}`
  : q;
```

### 4.2 摘要生成策略（避免每条都耗 LLM）

- 第 1 条 assistant 消息：内容 < 200 字 → 直接当摘要用（不调 LLM）
- 后续 assistant 消息：长度 > 100 字 → 调 LLM 生成 50 字摘要
- LLM 失败 → fallback 到 content 前 50 字 + `...`（fail-open）
- 摘要回写 DO（key = message idx）

### 4.3 窗口失效场景

- 单 session messages > 50 → 截断到最近 50 条（写日志不报错）
- 单 session messages > 200 → 标记 archived（UI 显示「过长已归档」，仅读不写）

### 4.4 指代消解

不显式做。LLM 见到上下文自然理解。失败时降级到单轮模式（context prefix 置空）。

---

## 5. 错误处理与边界条件

### 5.1 限额

```ts
// /chat 入口：建新 session 前查
const activeCount = await d1.count('chat_session', { user_id: userId });
if (activeCount >= 50) {
  throw new HttpError(409, 'SESSION_LIMIT_EXCEEDED', '已达 50 个会话上限，请删除不用的会话');
}
```

### 5.2 过期

**Lazy 过期**（不在 M6.1 加 Cron Triggers）：
- 列出 / 打开时判定 `last_active_at > now - 30天`
- 过期 session 不出现在 `/sessions` 响应里
- 调 /chat 拿过期 session → 404 `SESSION_NOT_FOUND`
- 兜底：用户想找回过期 session → 引导「30 天未用自动清理」（v2 加恢复功能）

### 5.3 LLM 失败

| 场景 | 行为 |
|---|---|
| 主 RAG 失败 | 3 次重试 → 503 `LLM_FAILED`（同 /ask） |
| `generateSummary` 失败 | fallback 到 content 前 50 字 + `...`，不阻塞主流程 |
| `generateTitle` 失败 | title 留空（前端显示「未命名会话」），不阻塞主流程 |

### 5.4 DO 路由失败

- DO stub `fetch` 超时 5s → 重试 1 次
- 仍失败 → D1 update `degraded_at = now`，前端显示「会话暂不可用」
- 兜底：跳过历史 context，单轮模式返回

### 5.5 并发安全

- 同一 session 并发 → DO 单线程保证（Durable Objects 模型）→ 无竞态
- 跨 session → 各 DO instance 独立

### 5.6 软删 vs 硬删

- 选硬删（D1 DELETE + `state.storage.deleteAll()`）
- 个人用户场景无合规保留需求
- v2+ 加回收站 30 天

---

## 6. 测试策略

### 6.1 测试矩阵

| 包 | 新增测试 | 数量 | 覆盖目标 |
|---|---|---|---|
| `packages/shared` | `multiturn.test.ts` + `chat-types.test.ts` | 12 | 拼接 8 + 限额工具 4 |
| `apps/api` | `routes/chat.test.ts` + `routes/sessions.test.ts` + `lib/chat.test.ts` + `lib/do-client.test.ts` | 28 | /chat 4 + /sessions 4 + DO 集成 4 + 鉴权 4 + 限额 4 + 错误 8 |
| `apps/api/integration` | `chat-flow.test.ts` (miniflare + 真 DO stub) | 4 | 端到端 /chat 往返 + 多 session 切换 |
| `apps/miniprogram` | `lib/chat-api.test.ts` 扩到 /chat | 4 | mock /chat 调用 |
| `apps/admin` | `ChatSimPage 多 session 单测`（jsdom） | 4 | session 切换 + 重命名 UI |
| **合计** | — | **52 新用例** | — |

### 6.2 测试模式

- LLM mock：`globalThis.fetch` 注入 fixture（`packages/shared/test/fixtures/llm-multiturn/`）
- DO mock：单元测用 `vi.mock('cloudflare:durable-objects')`；integration 用 miniflare 真 DO stub
- D1 mock：`better-sqlite3` in-memory 模拟 D1 schema（沿用 `apps/api/test/helpers/d1.ts`）

### 6.3 新增 fixture

- `chat-empty-history.json` — 0 轮
- `chat-3-rounds.json` — 3 轮完整
- `chat-7-rounds.json` — 7 轮（验证截断到 3）
- `chat-assistant-no-summary.json` — fallback 测试
- `chat-llm-summary-fail.json` — summary 失败回退

### 6.4 Checkpoint pass 标准

- **CP-1**：shared 12 用例 + typecheck
- **CP-2**：api 单测 28 用例 + integration 4 用例 + admin dev 验
- **CP-3**：miniprogram 4 用例 + 全 typecheck + admin build + miniprogram dev 验

### 6.5 dev verification（M3-realdeploy 教训应用）

完成实施后：
- `pnpm -F api dev` → curl `POST /chat` 真发请求看 200
- `pnpm -F admin dev` → 浏览器开 `/chat-sim` 真切 session + 重命名 + 删除
- `pnpm -F miniprogram dev` → 微信开发者工具真走新建 → 多轮 → 切 session

---

## 7. M6.1 → M6.2 衔接

M6.1 阶段所有鉴权仍走 ADMIN_TOKEN（与 M0-M5 一致）；M6.2 引入 wx.login + JWT。**M6.1 spec 必须留好切换点**避免 M6.2 大改。

### 7.1 切换点

1. **统一的 `verifyAuth(req, env)`**（`apps/api/src/lib/auth.ts`）：
   ```ts
   // M6.1 实现
   export async function verifyAuth(req: Request, env: Env): Promise<{ userId: string; isAdmin: boolean }> {
     const mode = env.AUTH_MODE || 'admin_token';
     if (mode === 'admin_token') {
       return await verifyAdminToken(req, env);  // 已有 M2 实现
     }
     if (mode === 'jwt') {
       // M6.2 实现：throw new HttpError(501, 'NOT_IMPLEMENTED', 'M6.2');
       throw new HttpError(501, 'NOT_IMPLEMENTED', 'JWT auth available in M6.2');
     }
     throw new HttpError(400, 'BAD_AUTH_MODE');
   }
   ```
   - M6.1：仅 `admin_token` 模式 work；`jwt` 模式返 501
   - M6.2：扩 `jwt` 分支 + `verifyAdminToken` fallback

2. **wx-login 入口预留**（M6.1 stub 405）：
   ```ts
   app.post('/auth/wx-login', (c) => {
     return c.json({ error: 'NOT_IMPLEMENTED', message: 'M6.2 will implement' }, 501);
   });
   ```

3. **小程序端 `getToken()` 抽象**（M6.1 永远返回 ''，M6.2 替换实现）：
   ```ts
   // apps/miniprogram/src/lib/auth.ts
   export function getToken(): string {
     // M6.1: 临时 hardcode（admin 模式不传 token 也能走 /chat？或临时支持 IP 白名单）
     // M6.2: 调 wx.login → /auth/wx-login → wx.setStorageSync('token', jwt)
     return '';
   }
   ```

4. **wrangler var 控制鉴权模式**：
   ```jsonc
   {
     "vars": {
       "AUTH_MODE": "admin_token"  // M6.1 默认；M6.2 改 "jwt"
     }
   }
   ```

### 7.2 M6.2 spec 范围预告（本 spec 不展开）

- wx.login 真接入 + jscode2session 调微信 API
- `/auth/wx-login` 端点实现：code → openid → JWT 签发
- JWT 设计：`jose` 库 + HS256 + 24h 过期 + refresh token 滑动窗口
- 小程序 token 持久化（`wx.setStorageSync`）
- admin 登录页（用户名密码 / 扫码登录，二选一）

### 7.3 M6.1 spec 末尾的「不重构边界」承诺

M6.1 → M6.2 不需要重构的部分：
- 路由层（`/chat`, `/sessions*`）不动
- `verifyAuth()` 是唯一鉴权入口
- `getToken()` 是小程序端唯一 token 入口
- wrangler var `AUTH_MODE` 是唯一切换开关
- D1 schema / DO 结构不动

---

## 8. 实施计划（M6.1 任务拆分预告）

具体 task list 留到 writing-plans skill 产出。本 spec 仅列 7 个 phase 边界：

1. **Phase 1 — shared 库**：migration 0003 + `multiturn.ts` + chat types + 12 用例
2. **Phase 2 — DO + DO client**：`ChatSessionDO` + `apps/api/src/lib/do-client.ts` + 单元 mock 测试
3. **Phase 3 — /chat endpoint**：route + lib/chat.ts（拼 context + 调 RAG + 写回）+ 14 单测
4. **Phase 4 — /sessions CRUD**：list + patch + delete + 10 单测
5. **Phase 5 — admin ChatSim 升级**：session 切换 + 重命名 + 4 jsdom 单测 + dev 验
6. **Phase 6 — 小程序双 tab**：chat 页 + history 页 + 4 单测 + dev 验
7. **Phase 7 — 收尾**：integration 4 用例 + 全 typecheck + build + README 更新 + state-m6-1.md

---

## 9. 范围外（推到 v2+ / M6.2）

- wx.login + JWT（M6.2 spec 范围）
- Admin 真鉴权（用户名密码 / 扫码登录）
- Cron Triggers 自动清理过期 session
- 回收站 30 天软删
- BGE-reranker / HyDE / NLI 蕴含验证
- session message_count 实时统计（需 DO stub 查）
- 单 session 限速（防 LLM 滥用）
- 引用卡片在多轮上下文里的 hover 高亮
- 微信小程序端「分享会话」功能

---

## 10. 风险与缓解

| 风险 | 缓解 |
|---|---|
| DO 重启丢 messages | `state.storage` 持久化（见 §2.2） |
| 50 个 session 限额太严 | M6.1 不调；收集家长反馈 v2 调整 |
| 首问 LLM 生成标题多耗一次 LLM | 失败 fallback 到空 title；用户可手动改 |
| /chat 比 /ask 慢（多 DO 往返）| DO 全球唯一 instance 延迟 < 10ms；UX 无感 |
| DO 路由失败 | retry + `degraded_at` 标记 + 单轮模式兜底 |
| ULID 依赖体积 | `ulid` 包 2KB；可接受 |

---

## 附录 A：关键设计决策记录

| 决策点 | 选择 | 触发 brainstorming 轮次 |
|---|---|---|
| M6 范围 | 拆 M6.1 / M6.2 | 澄清 1 |
| 真鉴权范围 | 只小程序端真鉴权 | 澄清 1 |
| wx.login 策略 | Mock-first 双模式 | 澄清 3 |
| Session 模型 | 多 session 独立 | 澄清 2 |
| Session 元数据 | D1 存列表 + DO 存消息 | 澄清 4 |
| 缓存策略 | /ask 缓存，/chat 不缓存 | 澄清 5 |
| Session 命名 | 自动 LLM 10 字 + 可重命名 | 澄清 6 |
| Session 限额 | 50 / 30 天 | 澄清 7 |
| 小程序 UI | 双 Tab 对话/历史 | visual companion 选 c |
| Admin 范围 | admin 加多 session ChatSim | 澄清 9 |
| session_id 格式 | ULID | 澄清 10 |
| 持久化方案 | DO 内存 + state.storage 兜底 | 方案 A |
| DO name 约定 | `session:${userId}:${sessionId}` | top-level design §2 既定 |
| 多轮窗口 | 3 轮 | top-level design §5.3 既定 |
| M6.1 → M6.2 切换 | verifyAuth() + AUTH_MODE var | §7 |

---

## 附录 B：配套文档

- 顶层设计：`docs/superpowers/specs/2026-06-14-unequal-top-level-design.md` §2 / §3.3 / §5.3
- 上一个里程碑：`docs/archive/state/state-m5.md`
- wx.login 设计：M6.2 spec（本 spec 不含）
- 微信小程序端：M3 spec `docs/superpowers/specs/2026-06-15-m3-miniprogram-design.md`
- 微信小程序真机联调：`docs/wechat-miniprogram-setup.md`
