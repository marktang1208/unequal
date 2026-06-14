# 不等号 / unequal —— 顶层架构设计

- **状态**：草稿，待用户复核
- **日期**：2026-06-14
- **范围**：架构总图级（不含各子系统详细 API / SQL / prompt）

---

## 0. 目标

构建一个部署在微信生态中的"一问一答式"育儿智能体。回答必须标注引用来源，避免 LLM 幻觉。知识库来源于：(a) 用户上传 PDF/Word/TXT/Markdown；(b) 用户指定的网页 URL；(c) 抓取小红书指定账号；(d) 抓取微信公众号指定账号。所有来源平权入库，按 trust_level 做信源评级。MVP 不做真鉴权，schema 预留多用户。

## 1. 架构总览

```
┌──────────────────────┐  ┌──────────────────────┐
│ 微信小程序（原生）     │  │ 管理后台 (React+Vite) │
│ 家长端对话 UI         │  │ 源/文档/问答测试     │
└──────────┬───────────┘  └──────────┬───────────┘
           │ wx.request                │ HTTPS
           ▼                            ▼
┌─────────────────────────────────────────────────┐
│           Cloudflare Workers (API 网关)          │
│  /ask /chat /sources /documents /ingest /crawl   │
│  ── Durable Objects: UserSession (会话状态)     │
│  ── Cron Triggers: 定时抓取调度                 │
└──────────┬───────────┬─────────────┬────────────┘
           │           │             │
           ▼           ▼             ▼
       ┌───────┐  ┌────────┐   ┌──────────┐
       │ D1    │  │Vectorize│   │  R2      │
       │ 元数据 │  │向量检索 │   │ 原文/PDF │
       └───────┘  └────────┘   └──────────┘
                       │
                       ▼
              ┌──────────────────┐
              │  MiniMax API      │
              │  chat / embedding │
              └──────────────────┘

  抓取路径（独立进程，本地 Mac）：
  Mac crawler → HTTP POST /ingest → Workers → D1/Vectorize/R2
```

## 2. 七个子系统

| # | 子系统 | 职责 | 部署位置 |
|---|---|---|---|
| 1 | 微信小程序 | 家长端对话 UI + 引用卡片 + 历史 | 微信平台（个人主体） |
| 2 | API 网关 | 路由、鉴权、限流、统一错误格式 | Cloudflare Workers |
| 3 | 会话状态 | 一个 user 一段会话，存多轮历史 | Cloudflare Durable Objects |
| 4 | RAG 检索 + 生成 | embedding → Vectorize topK → rerank → prompt → chat | `packages/shared` 共享包 |
| 5 | 摄入管道 | 解析 → chunk → embedding → 入库 | `packages/shared` 共享包 |
| 6 | 爬虫 | 4 种源适配器，手动 + 定时调 Worker /ingest | 本地 Mac（不部署） |
| 7 | 管理后台 | 源管理、文档列表、问答测试、抓取日志 | Cloudflare Pages |

## 3. 横向议题

### 3.1 反幻觉：双层验证 + 医疗免责声明

LLM prompt 强制要求答案末尾输出 `{"citations": [N, M, ...]}` 块，正文里只允许用 `[来源 N]` 引用。应用层取两层交集 = 真正引用的编号。交集为空则降级为"未在知识库中找到可靠来源"。

**强制医疗免责声明**（法务底线，0 成本，必须在 MVP 落地）：所有 LLM 生成的答案必须追加以下声明（不计入 citations 校验）：

> 以上信息来源于知识库内容，不构成医疗建议。具体情况请咨询专业儿科医生。

声明由应用层在 `§5.2 ⑨` 之后追加，不由 LLM 生成（避免被 LLM 改写或省略）。如果 LLM 自己已经在答案里写了类似免责语，去重不重复追加。

### 3.2 信源评级：所有来源平权入库

每个 `source` 有 `trust_level: 0|1|2|3`。chunk 表冗余该字段。检索打分时 `final_score = vectorize_score × trust_weight`（权重 1.0/1.0/1.1/1.3）。前端引用卡片显示信源等级图标。

### 3.3 用户体系：MVP 不鉴权

Workers 配 `ADMIN_TOKEN` secret，所有请求带 `Authorization: Bearer ${ADMIN_TOKEN}`。小程序"鉴权"靠 workers.dev 域名私密性 + 微信小程序后台 request 合法域名白名单。schema（`user.wx_openid`、各表 `user_id`）已为未来 wx.login → openid → JWT 升级预留。升级触发条件：第二个真实用户开始用。

### 3.4 部署形态

纯 Cloudflare + 微信小程序 + 本地 Mac 爬虫。不买域名，不租 VPS。`unequal-api.xxx.workers.dev` / `unequal-admin.pages.dev`。

## 4. 数据模型

### 4.1 D1 schema

```sql
CREATE TABLE user (
  id TEXT PRIMARY KEY,
  wx_openid TEXT UNIQUE,           -- 未来 wx.login 后填入
  nickname TEXT,
  created_at INTEGER
);

CREATE TABLE source (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,              -- 'file'|'webpage'|'xiaohongshu'|'wechat-mp'
  title TEXT,
  url TEXT,
  account TEXT,
  trust_level INTEGER NOT NULL,    -- 0..3
  created_at INTEGER,
  meta TEXT,                       -- JSON
  FOREIGN KEY (user_id) REFERENCES user(id)
);

CREATE TABLE document (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  user_id TEXT NOT NULL,           -- 冗余，便于按租户过滤
  title TEXT,
  raw_path TEXT,                   -- R2 路径
  parsed_text_path TEXT,           -- R2 路径（可选）
  created_at INTEGER,
  FOREIGN KEY (source_id) REFERENCES source(id)
);

CREATE TABLE chunk (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  user_id TEXT NOT NULL,           -- 冗余
  idx INTEGER,
  content TEXT,
  token_count INTEGER,
  trust_level INTEGER NOT NULL,    -- 镜像自 source
  FOREIGN KEY (document_id) REFERENCES document(id)
);

CREATE INDEX chunk_user_idx ON chunk(user_id);

CREATE TABLE crawl_job (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  source_id TEXT,
  trigger TEXT NOT NULL,           -- 'manual'|'cron'
  status TEXT NOT NULL,            -- 'pending'|'running'|'success'|'failed'
  started_at INTEGER,
  finished_at INTEGER,
  error TEXT
);
```

### 4.2 Vectorize 索引

- **名称**：`unequal-chunks`
- **维度**：由 MiniMax embedding 决定（预计 1024 或 1536，待登录 platform.MiniMax.io 确认）
- **metadata**：`{ chunk_id, user_id, source_id, document_id, trust_level, is_cached }`
- **metric**：cosine

### 4.3 信源评级

| trust_level | 含义 | 示例 | 检索权重 |
|---|---|---|---|
| 0 | 未评级 | 用户随手存的网页 | ×1.0 |
| 1 | 一般 | 个人公众号、不知名博主 | ×1.0 |
| 2 | 可信 | 崔玉涛、丁香医生 | ×1.1 |
| 3 | 权威 | WHO、UpToDate、《尼尔森儿科学》 | ×1.3 |

管理后台手动设；v2 引入域名白名单 + 账号粉丝数自动建议。

## 5. RAG pipeline

### 5.1 摄入管道（写库侧）

```
原始内容
  → 解析（按 source.type 分支：PDF/Word/TXT/MD/网页/小红书/公众号）
  → chunking（共享规则：按段落+标点切，最大 ~500 token，重叠 ~50 token）
  → embedding（MiniMax API，批量调）
  → 写 D1.chunk + Vectorize（Vectorize 失败时回滚 D1）
```

按 `source.url + content_hash` 去重。

### 5.2 检索 + 生成（读库侧）

```
用户问题 q
  ↓
  ① 查询缓存：q → embedding → Vectorize.topK(1) filter {user_id, is_cached=true}
     命中（final_score > 0.92）→ 直接返回缓存
     未命中 ↓
  ↓
  ② embedding(q) → 向量 v
  ↓
  ③ Vectorize.query(v, topK=20, filter={user_id, trust_level: {$gte: 0}})
  ↓
  ④ rerank（MVP 跳过；v2 引入 BGE-reranker）
  ↓
  ⑤ 截断 topK=5，应用 trust_level 加权 → 编号 [1]..[5]
  ↓
  ⑥ 拼 prompt：
     system: 只能基于 [1]..[5] 回答；引用处用 [来源 N]；末尾输出 {"citations": [...]} 块；
             知识库无答案时明确说明
     context: [1]..[5] 全文
     user: q
  ↓
  ⑦ MiniMax chat completion
  ↓
  ⑧ 双层验证：取 文本 [来源 N] ∩ JSON.citations = 真正引用
     交集为空 → 降级为"未在知识库中找到可靠来源"
  ↓
  ⑨ 强制追加医疗免责声明（见 §3.1），不计入 citations 校验
  ↓
  ⑩ 写回缓存：把 {q, answer, citations, q_embedding} 写入 Vectorize, is_cached=true
  ↓
返回 {answer, disclaimer, citations: [{n, title, snippet, url, trust_level, source_id, chunk_id}], cached}
```

### 5.3 多轮对话

会话历史存 Durable Object（一个 user 一个）。新检索时把最近 3 轮"用户问题 + LLM 答案 50 字摘要"拼到 query 前缀。摘要由 LLM 生成，不存全文。

### 5.4 缓存失效

任一触发即清空该 user 的 `is_cached=true` 索引条目：
- 该 user 任一 source 文档增删改
- MiniMax 模型升级（全局清空）
- TTL 30 天

## 6. API 接口

| 方法 | 路径 | 用途 | 鉴权 |
|---|---|---|---|
| POST | `/ask` | 单轮问答 | ADMIN_TOKEN |
| POST | `/chat` | 多轮问答（带 session_id） | ADMIN_TOKEN |
| GET/POST/DELETE | `/sources` | 源 CRUD | ADMIN_TOKEN |
| GET/DELETE | `/documents` | 文档列表/删除 | ADMIN_TOKEN |
| GET | `/documents/:id/raw` | 拉 R2 签名 URL | ADMIN_TOKEN |
| POST | `/ingest` | 爬虫回写 | 共享密钥 header |
| POST | `/crawl` | 手动触发抓取 | ADMIN_TOKEN |
| GET | `/crawl/jobs` | 抓取任务列表 | ADMIN_TOKEN |
| GET | `/search` | 纯检索（admin 测试用） | ADMIN_TOKEN |
| POST | `/upload/sign` | 文件直传 R2 签名 | ADMIN_TOKEN |

`/ask` 响应：

```json
{
  "answer": "5个月宝宝发烧38.5°C 建议... [来源 1] [来源 3]\n\n以上信息来源于知识库内容，不构成医疗建议。具体情况请咨询专业儿科医生。",
  "disclaimer": "以上信息来源于知识库内容，不构成医疗建议。具体情况请咨询专业儿科医生。",
  "citations": [
    {
      "n": 1,
      "title": "《崔玉涛育儿百科》第3章",
      "snippet": "5个月婴儿腋温超过38.5°C 时...",
      "url": "r2://documents/01H.../p42",
      "trust_level": 3,
      "source_id": "01H...",
      "chunk_id": "01H..."
    }
  ],
  "session_id": "01H...",
  "cached": false
}
```

## 7. 前端

### 7.1 微信小程序

```
pages/
  chat/              主对话页：输入框 + 消息流（用户气泡 / AI 气泡 + 引用卡片）
  source-detail/     引用原文页：PDF 用 wx.openDocument，网页用 web-view
  history/           历史问答列表（按 session_id 倒序）
```

- 消息流用 `scroll-view` + 虚拟列表
- LLM 答案用 `towxml` 渲染 Markdown
- 网络失败显示重试按钮

### 7.2 管理后台

```
pages/
  sources/     源列表 + 4 种 type 添加表单 + trust_level 调整
  documents/   文档列表 + chunk 列表 + 重新 embedding
  test/        问答测试：可视化命中 chunks / rerank / 最终 prompt
  crawl/       抓取任务列表 + 手动触发 + 日志详情
  settings/    trust 黑白名单 / 模型版本 / API key
```

部署到 `unequal-admin.pages.dev`，CORS 允许小程序域名。

## 8. 抓取调度

**手动触发**：admin 后台点按钮 → POST /crawl {source_id} → 写 crawl_job(pending) → 推送本地 Mac → Mac 处理 → POST /ingest → 改 status。

**定时触发**：Cloudflare Cron Triggers `0 */6 * * *` → Workers 查 trust_level ≥ 2 的 source → 写 crawl_job(cron) → 推本地 Mac。

**离线容错**：Mac 不在线时任务入本地队列；上线 startup hook 补跑。

## 9. 部署

Cloudflare 资源清单（一次性开通）：

| 资源 | 名称 | 计费 |
|---|---|---|
| Worker | `unequal-api` | 免费额度 |
| Durable Object | `UserSession` | 按请求/存储 |
| Vectorize | `unequal-chunks` | 3000 万维度/月免费 |
| D1 | `unequal-db` | 5GB + 50 亿读/天免费 |
| R2 | `unequal-storage` | 10GB + 1 亿 A 类操作/月免费 |
| Pages | `unequal-admin` | 免费 |
| Cron Trigger | 配在 Worker | 免费 |
| KV（可选） | `unequal-cache` | 10 万读/天免费 |

发布命令：`pnpm -F api deploy` / `pnpm -F admin deploy`。
抓取：`pnpm -F crawler start`（本地 Mac 长驻）或 `node dist/index.js --once`（跑一次）。

## 10. 成本估算

| 项目 | 月费用 |
|---|---|
| Cloudflare 全套 | 0 |
| MiniMax LLM + Embedding | 0（年卡已含） |
| 微信小程序个人主体 | 30 元/年 |
| **合计** | **约 30 元/年** |

## 11. 风险与缓解

| 风险 | 缓解 |
|---|---|
| MiniMax API 限流/挂掉 | 失败重试 3 次 + 提示"系统繁忙"；v2 切 Claude |
| 微信小程序个人主体审核不通过 | 先把 admin 后台跑通当 MVP，小程序降级为最后接入 |
| 本地 Mac 关机导致抓取失败 | crawl_job 记录失败 + 报警；上线补跑 |
| Vectorize metadata 不可信 | 应用层用 chunk_id 反查 D1 二次校验 |
| 年卡额度用完 | 监控 token 用量 |
| 反幻觉双层验证失败率过高 | 降级为单层文本模式 |
| 医疗免责声明缺失 | 用户误把答案当医嘱 | MVP 强制加 disclaimer 字段（见 §3.1） |

## 12. 监控

- Workers Analytics：路由 p50/p99 + 错误率
- D1 Insights：慢查询
- `crawl_job` 表 + admin "抓取日志"页
- MiniMax 用量：定期查 platform.MiniMax.io

## 13. 后续演进（v2+，不在本 spec 范围）

- 多用户真鉴权（wx.login → openid → JWT）
- BGE-reranker / LLM-as-reranker
- **NLI 蕴含验证**：在 §5.2 ⑧ 之后用 NLI 模型判断每条答案句是否被检索 chunk 蕴含；不蕴含的句子降级为"知识库未支持"。能再压一档幻觉。预计 1-2 天工作量。
- **HyDE 检索增强**：在 §5.2 ② 之前用 LLM 根据 q 生成"假设性答案文本"，用这个文本 embedding 去检索。适合"用户问得口语化、文档写得书面化"的育儿场景。预计 1 天工作量。
- 答案质量反馈（点赞/点踩 → D1）
- 知识库更新自动 invalidate 缓存
- 信源自动评级（域名白名单 + 账号粉丝数）
- 飞书 / 企业微信多端接入

---

## 附录 A：关键设计决策记录

| 决策点 | 选择 | 触发对话轮次 |
|---|---|---|
| Spec 范围 | 一次性顶层设计，架构总图级 | 澄清 1 |
| 用户粒度 | 个人账号 = 一个租户 | 澄清 2 |
| 爬虫触发 | 手动 + 定时组合 | 澄清 3 |
| 小程序栈 | 微信原生 | 澄清 4 |
| 首跑场景 | 4 个全开（上传/网页/多轮/多租户预留） | 澄清 5 |
| 反幻觉机制 | 双层验证（文本+JSON） | 澄清 6 |
| 信源评级 | 所有来源平权入库 + trust_level 0-3 | 澄清 5 补充 |
| 查询缓存 | 复用 Vectorize, is_cached 区分；每次成功自动回写 | 澄清 7（追问） |
| 鉴权 | MVP 不做真鉴权，schema 预留 wx_openid | 横向议题 3.3 |
| 医疗免责声明 | 强制在所有答案末尾追加，不依赖 LLM | 业界策略反馈后追加 |
| NLI 验证 | v2 候选 | 业界策略反馈后追加 |
| HyDE 检索 | v2 候选 | 业界策略反馈后追加 |
