# P3-7 v1 简化补完：种子 URL 库

**日期**：2026-06-22
**作者**：Mark + Claude (brainstorming 协作)
**状态**：✅ Design approved（5 节全部 user confirmed）
**Tag**：`p3-7-seeds`
**前置**：
- P3-7 spec `2026-06-22-cp7-p3-7-crawler-manual-push-design.md`（commit `c9211b4`）
- P3-7 真接发现：crawler `runCrawler({fullScan, source})` 模式返 `total=0`（`resolveSeedUrls` v1 简化返空）

---

## 1. 摘要

P3-7 v1 简化把"种子 URL 列表"留作"未来 spec 补"。本 spec 补完：4 个 source（xhs / wechat-mp / webpage）各一份 JSON 文件（git 跟踪）+ admin UI `/seeds` 页增删改 + 状态同步。

**核心设计**：
- **JSON 文件是 source of truth**（`apps/crawler/seeds/{source}.json`）
- **SQLite `crawler_seeds` 表是 UI 视图**（runtime 状态：last_crawled_at / last_status / retry_count）
- **crawler 启动时**：`seeds-loader` 读 JSON 同步到 SQLite + 过滤 `active=true` + 按 `last_crawled_at ASC` 排序 + 取 limit
- **admin UI 增删改时**：写 SQLite + 立即写 JSON（原子写：tmp + rename）
- **失败处理**：3 retry（退避 1/3/10s）→ 失败写 `last_status=failed` + `last_error`（next_crawled_at 仍更新到 now，下次仍拉）

**不在范围**：
- 健康检查（HEAD 探活）—— 爬取失败反馈已足够
- 自动重试间隔升级（指数 backoff）—— 3 次重试后写 failed，下次仍拉
- 双向冲突解决（多 admin 设备）—— 单设备单 admin
- minipgm / 多端 seed 共享 —— 仍纯本地 MacBook

---

## 2. 决策摘要

| 决策点 | 选择 | 原因 |
|---|---|---|
| **数据存储** | 本地 JSON 文件 + SQLite 视图 | git 跟踪 + 备份简单；SQLite 给 UI 高性能查询 |
| **文件格式** | JSON | 通用，git diff 易读；YAML 需新解析器不值 |
| **同步方向** | UI 改 = 立即写 JSON（写后立即 sync）| 单设备无冲突；JSON 是 source of truth |
| **去重策略** | `last_crawled_at ASC`（null 优先）| 简单可预测；增量 + 全量同逻辑 |
| **trust_level** | 种子 URL 上指定（覆盖默认）| spec §5.3 信任绑源属性 |
| **trust 默认值** | xhs=0 / wechat-mp=2 / webpage=1 | 不同源不同基线 |
| **失败重试** | 3 次（退避 1/3/10s）| 兼容 P3-7 §6.1 5xx 策略 |
| **active 标志** | 每条 seed 有 active=true/false | 暂跳不删 |
| **健康检查** | 不做（爬取失败 = 反馈）| YAGNI |
| **UI 位置** | 独立新页 `/seeds` | 独立工作流，不嵌弹窗 |

---

## 3. 架构

### 3.1 总览

```
                    MacBook (admin 本地)
                    ════════════════════════

   Source of truth: JSON 文件
   ┌────────────────────────────────────────────┐
   │ apps/crawler/seeds/                         │
   │   xhs.json          [12 URLs]              │
   │   wechat-mp.json    [ 8 URLs]              │
   │   webpage.json      [30 URLs]              │
   │   (all 不存文件，crawler 自合并 3 份)      │
   └────────────────────────────────────────────┘
                    ▲         │ (admin UI 增删改)
                    │         ▼
   UI 视图:          admin dev 5173 (/seeds 页面)
   ┌────────────────────────────────────────────┐
   │ /seeds 页 (4 tab: xhs/wechat-mp/webpage/all)│
   │ ├─ URL 列表 (checkbox + 状态 + last_crawled) │
   │ ├─ 添加 URL (单条 / 批量粘贴)               │
   │ ├─ active 切换                                │
   │ └─ 调用 /api/seeds 写 SQLite + 写 JSON      │
   └────────────────────────────────────────────┘
                              │
                              ▼
                     admin 共享 SQLite (本地)
                     ┌──────────────────────────┐
                     │ crawler_seeds 表 (视图)   │
                     │ url, source,               │
                     │ trust_level, active,       │
                     │ last_crawled_at,           │
                     │ last_status, retry_count   │
                     └──────────────────────────┘
                              ▲
                              │ (crawler 启动时读一次)
                              │
   爬取逻辑:        apps/crawler/src/trigger.ts
                    ┌──────────────────────────────────┐
                    │ runCrawler() 启动时:             │
                    │  1. 读 seeds/{source}.json       │
                    │  2. 与 SQLite 同步状态             │
                    │  3. 过滤 active=true              │
                    │  4. 按 last_crawled_at 排序       │
                    │  5. 取 limit 条                    │
                    │  6. fetch + parse + embed + 入库  │
                    │  7. 写回 last_crawled_at + 状态    │
                    └──────────────────────────────────┘
```

### 3.2 JSON 文件 schema

**`apps/crawler/seeds/xhs.json`**:
```json
{
  "source": "xhs",
  "version": 1,
  "updated_at": "2026-06-22T12:00:00Z",
  "urls": [
    {
      "url": "https://www.xiaohongshu.com/explore/abc123",
      "trust_level": 0,
      "active": true,
      "last_crawled_at": "2026-06-21T03:00:00Z",
      "last_status": "done"
    }
  ]
}
```

**字段说明**：
- `source`: `"xhs" | "wechat-mp" | "webpage"`（4 个文件各一份，不存 `all`）
- `version`: 1（schema 升级时 +1）
- `updated_at`: ISO 8601，最后修改时间
- `urls[]`: URL 列表
  - `url`: 完整 URL
  - `trust_level`: 0-3（admin 设；source 默认值：xhs=0, wechat-mp=2, webpage=1）
  - `active`: true/false（false = 跳过）
  - `last_crawled_at`: ISO 8601 | null（null = 未拉过，**优先拉**）
  - `last_status`: `"done" | "failed" | "pending"`（最近状态）

**`all.json` 不存文件**——crawler 触发 `--source=all` 时 = 读 3 份 JSON 合并。

### 3.3 SQLite schema

```sql
CREATE TABLE crawler_seeds (
  url TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  trust_level INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  last_crawled_at INTEGER,           -- ms epoch
  last_status TEXT,                  -- done | failed | pending
  last_error TEXT,
  retry_count INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_seeds_source_active ON crawler_seeds(source, active);
CREATE INDEX idx_seeds_last_crawled ON crawler_seeds(last_crawled_at);
```

---

## 4. 组件清单

| 组件 | 路径 | 职责 |
|---|---|---|
| **SeedsStore** | `apps/admin/server/seeds-store.ts`（新）| seeds JSON ↔ SQLite 同步 + 增删改查；写 JSON 是副作用 |
| **SeedsMiddleware** | `apps/admin/server/seeds-middleware.ts`（新）| `/api/seeds` REST endpoint |
| **SeedsPage** | `apps/admin/src/pages/Seeds.tsx`（新）| admin UI 4 tab + URL 列表 + 增删改 |
| **seeds-loader** | `apps/crawler/src/seeds-loader.ts`（新）| crawler 启动时读 JSON + 同步到 SQLite + 排序取 limit |
| **json-io** | `packages/local-llm/src/json-io.ts`（新）| 通用 JSON 文件读写（原子写：tmp + rename） |
| **trigger.ts** | `apps/crawler/src/trigger.ts`（改）| `resolveSeedUrls` 改调 `seeds-loader` + 写回 last_crawled_at |
| **App.tsx** | `apps/admin/src/App.tsx`（改）| 加 `/seeds` 路由 |
| **AdminNav.tsx** | `apps/admin/src/components/AdminNav.tsx`（改）| 加 "种子管理" 链接 |
| **vite.config.ts** | `apps/admin/vite.config.ts`（改）| 注册 seeds middleware |

---

## 5. 数据流

### 5.1 happy path: admin UI 添加 1 条 URL

```
admin 在 /seeds 页 → 选 "xhs" tab → 点 "添加" → 填 URL + trust_level
            ↓
SeedsPage → POST /api/seeds body={source:"xhs", url:"...", trust_level:0}
            ↓
SeedsMiddleware.handleAdd:
  1. SeedsStore.add(source, url, trust_level)
  2. → 写 SQLite (active=1, last_crawled_at=null, last_status=null)
  3. → 写 seeds/xhs.json (load → push → atomic write)
  4. 返 201 { url, source, active, ... }
            ↓
UI 刷新列表
```

### 5.2 happy path: launchd 凌晨 3 点全量跑

```
launchd 启 → scripts/run-daily-crawler.sh → pnpm -F crawler start --full-scan --source=all
            ↓
trigger.runCrawler({fullScan:true, source:"all"})
  → seedsLoader.loadAll()                        ← 读 xhs+wechat-mp+webpage 3 份 JSON
  → 合并 + 过滤 active=true
  → 同步到 SQLite（read=INSERT OR UPDATE；JSON 是 source of truth，SQLite 镜像）
  → 按 last_crawled_at ASC 排序（null 优先）
  → 取 --full-scan = 全量（无 limit）
  → 遍历每条:
     - processOne (fetch + chunk + embed + 写 local_ingest)
     - SeedsStore.markCrawled(url, status, error?)
       → 写 SQLite (last_crawled_at=now, last_status, retry_count++)
            ↓
  return { total, succeeded, failed, file_ids }
            ↓
  UI 启动 crawler 的话：crawler-spawner 读 /api/crawler/status 拿返回
```

### 5.3 失败处理

```
processOne 抛错（fetch 5xx / parse 失败 / embed 失败）
            ↓
重试 3 次（退避 1/3/10s）
            ↓
仍失败 → SeedsStore.markFailed(url, error)
  → 写 SQLite (last_status="failed", last_error=msg, retry_count++)
  → 写 JSON (last_status="failed")
  → local_ingest 也写一条 status="failed"
            ↓
last_crawled_at 策略：失败后 last_crawled_at 仍更新到 now（避免无限重试同一 URL）
                   但有 3 retry 后下次 launchd 跑时这条 URL 仍在排序里可被重新拉到（无降级，无降权）
            ↓
admin UI /seeds 看到 "last_status: failed" 红色标记
```

### 5.4 admin UI 批量粘贴

```
admin 复制 "url1\nurl2\nurl3" 粘贴 → 解析每行 → 批量 POST /api/seeds
            ↓
每条都按 §5.1 流程
            ↓
返 { added: 3, skipped: 0, errors: [] }
```

---

## 6. 错误处理

| 阶段 | 错误 | 自动重试 | 用户操作 |
|---|---|---|---|
| 读 JSON | 文件不存在 | 0 次（自动建空文件）| n/a |
| 写 JSON | 权限 / 磁盘满 | 0 次 | fatal + 日志 |
| 写 SQLite | 锁 / 磁盘 | 0 次 | fatal + 日志 |
| 爬取 URL | fetch 5xx / 404 / 超时 | 3 次（退避 1/3/10s）| UI 看 failed |
| 解析 HTML | cheerio 抛 | 1 次（同 URL 同 fetch）| UI 看 failed |
| embed | OMLX/MiniMax 不可达 | 0 次（按现有 P3-7 fallback）| UI 看 failed |
| local_ingest 写 | SQLite 错 | 0 次 | fatal + 日志 |

---

## 7. 测试

### 7.1 测试金字塔

| 层级 | 数量 | 工具 | 覆盖 |
|---|---|---|---|
| 单元 | ~15 | vitest | SeedsStore CRUD / seeds-loader 排序 / json-io 原子写 / SeedsMiddleware 4 endpoint |
| 集成 | ~5 | vitest + supertest | admin UI /api/seeds 增删改同步 JSON / 启动 crawler 模拟 |
| 真接 | 3 场景 | manual + curl | UI 添加 URL → JSON 同步 / launchd 跑 / 失败标记 |

### 7.2 累计测试数

- packages/local-llm: 25 → ~33（+8 json-io / SeedsStore 部分）
- apps/admin: 148 → ~163（+8 seeds-middleware + ui 5 tests）
- apps/crawler: 41 → ~48（+7 seeds-loader）
- **总: 450 → ~478（+28 净）**

---

## 8. 实施计划（3 phase）

### Phase A: 数据层（1-2 天）
- 新建 `packages/local-llm/src/json-io.ts`（原子写 + lock）
- 新建 `apps/admin/server/seeds-store.ts`（CRUD + JSON sync）
- 新建 `apps/crawler/src/seeds-loader.ts`（启动时 read+sort）
- 单元测试覆盖（15 cases）

### Phase B: API + UI（1-2 天）
- 新建 `apps/admin/server/seeds-middleware.ts`（4 endpoint）
- 新建 `apps/admin/src/pages/Seeds.tsx`（4 tab + 列表 + 增删改）
- 修改 `App.tsx` / `AdminNav.tsx` / `vite.config.ts`
- 集成测试覆盖（5 cases）

### Phase C: 真接验证（半天）
- 启 admin dev → /seeds 页面增 3 条 URL → JSON 同步
- launchd 跑 → crawler 拉 3 条 → local_ingest 入库
- 模拟 fetch 失败 → last_status=failed 标记

---

## 9. References

- **P3-7 spec**：`docs/superpowers/specs/2026-06-22-cp7-p3-7-crawler-manual-push-design.md`（commit `c9211b4`）
- **P3-7 真接 4 暴露**：`apps/crawler/src/trigger.ts` `resolveSeedUrls` v1 简化返空
- **arch-v2.3**：`docs/archive/state/state-arch-v2.3.md`（admin 不 embed / API 自己 embed）
- **spec §5.3 信源评级**：所有来源平权入库，按 trust_level 做信源评级
- **spec drift 修订**：`docs/superpowers/specs/2026-06-14-unequal-top-level-design.md` §14

---

## 10. Open Questions（已解决）

| Q | 答案 |
|---|---|
| 种子库数据从哪？ | 本地 JSON 文件 + admin UI 编辑（同步） |
| 增量去重策略？ | last_crawled_at 时间戳（未拉过优先） |
| trust_level 怎么定？ | 种子 URL 上指定（覆盖默认） |
| 失败处理？ | 3 次重试 + 失败记日志 + UI 可见 |
| 同步策略？ | UI 改即写 JSON（单设备无冲突） |
| 是否做健康检查？ | 不做（爬取反馈已足够） |
| UI 位置？ | 独立新页 `/seeds` |
| active 标志？ | 每条 seed 有 active=true/false |
