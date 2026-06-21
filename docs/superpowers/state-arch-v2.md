# Arch-V2: 本地处理 + 上传 chunks 架构调整

**日期**：2026-06-22
**状态**：🟡 设计阶段（待实施）
**作者**：用户决策
**影响范围**：全部知识库来源（PDF / Word / 网页 / 小红书 / 公众号）

---

## 1. 决策摘要

**核心调整**：所有知识库原始文件的**解析、切片、embedding** 全部在 **Mac 本地**完成，**只把 chunks（content + embedding + 元数据）上传到腾讯云**。

云上 `api-router` **不再**做：
- ❌ 文件解析（pdf-parse / mammoth）
- ❌ 文本切片（chunkText）
- ❌ Embedding（MiniMax embed API 调用）
- ❌ 4MB 文件大小限制（HTTP body 限制）

云上 `api-router` **只**做：
- ✅ JWT 鉴权 + IP allowlist
- ✅ 接收 chunks payload + 写入 DB
- ✅ 向量检索（RAG search/ask/chat）
- ✅ 引用追溯 + 反幻觉 prompt

---

## 2. 旧 vs 新架构对比

### 2.1 旧架构（CP-6 ~ CP-7-C）

```
┌──────────────────────┐
│ minipgm / admin       │
│  - 选 PDF (UI 未实现) │
│  - POST base64        │
└──────────┬───────────┘
           ↓
┌──────────────────────┐
│ CloudBase (腾讯云)     │  ⬅️ 解析/切分/embedding 全在这
│  - pdf-parse (老)     │
│  - mammoth            │
│  - chunkText          │
│  - MiniMax embed API  │
│  - 入库                │
└──────────────────────┘

痛点：
- 4MB HTTP body 限制
- 256MB 内存限制（大 PDF 解析失败）
- pdf-parse@1.1.1 内嵌 pdf.js v1.10.100（2017）
- 中文/现代 PDF 经常解析失败
- embedding API 每次上传都从云上调
```

### 2.2 新架构（Arch-V2）

```
┌────────────────────────────┐
│ Mac 本地 (M3 Pro)             │  ⬅️ 全部解析/切分/embedding 在这
│                              │
│  apps/crawler                 │
│   - fetchWebpage/Xhs/WxMp   │
│   - parsePdf (pdf-parse 新版) │
│   - parseDocx (mammoth)      │
│                              │
│  packages/shared              │
│   - chunkText                │
│   - MiniMaxEmbedder          │
│                              │
│  apps/admin (本地 dev)        │
│   - 用户上传文件              │
│   - 调本地 ingest-chunks CLI  │
│                              │
│  apps/minipgm (用户侧)        │
│   - wx.chooseMessageFile     │
│   - 把文件下载到本地临时目录  │
│   - 调本地 worker (file://)  │
│   - OR: 上传 base64 到本地 CLI │
└──────────────┬────────────────┘
               ↓ 只传 chunks + embedding
┌──────────────────────────────┐
│ CloudBase (腾讯云)              │  ⬅️ 只入库 + 检索
│  - /api-ingest (新协议)        │
│    - chunks[] (content+embed) │
│    - document metadata         │
│    - source metadata           │
│  - 入库 (no parsing)           │
│  - /api-search /api-ask /api-chat│
│  - 引用追溯                    │
└──────────────────────────────┘

收益：
- ✅ 4MB 限制消失（云上只收 chunks payload，小）
- ✅ 256MB 限制消失（解析不占云上资源）
- ✅ PDF 库升级自由（本地 npm install）
- ✅ 中文/现代 PDF 用最新 pdfjs-dist 4.x
- ✅ 扫描 PDF 可加 OCR (Tesseract 本地)
- ✅ 大文件批处理 (本地脚本可跑)
- ✅ embedding API 走用户本地网络（可换 key）
```

---

## 3. 新 /api-ingest 协议（chunks 直传）

### 3.1 Request body

```typescript
{
  // source metadata
  url: string;              // 原始 URL 或本地路径
  type: "webpage" | "pdf" | "docx" | "xiaohongshu" | "wechat-mp" | "txt" | "md";
  title?: string;
  trust_level: 0 | 1 | 2 | 3;
  user_id?: string;          // proxy path 必填，admin path 缺省 DEFAULT_USER_ID

  // document metadata
  document: {
    title: string;
    rawPath?: string;        // 原文路径（minipgm R2 暂未用）
    previewSnippet?: string; // 列表页用
  };

  // ⭐ 关键：chunks 已在本地算好
  chunks: Array<{
    idx: number;             // 0, 1, 2, ...
    content: string;         // 文本（已切片）
    embedding: number[];     // 1536 维向量
    tokenCount: number;
  }>;

  // CP-7-C #2 兼容
  actor_via?: "ingest_proxy" | "admin_token" | "admin_jwt";
  client_ip?: string;
}
```

### 3.2 旧 content 路径（向后兼容）

```typescript
// 旧 /api-ingest 还接受（CP-7 真接用过）
{
  content: string;          // 原始文本
  // ... 云上自动 chunkText + embed
}
```

**新行为**：
- 有 `chunks` 字段 → **云上不解析/不切分/不 embed**，直接入库
- 只有 `content` 字段 → 走旧路径（云上 chunkText + embed）
- 两个都有 → 优先 `chunks`（warn 忽略 `content`）

### 3.3 Response

```typescript
{
  source_id: string;
  document_id: string;
  chunks_inserted: number;  // 等于 chunks.length
  chunks_failed: number;    // 0（云上不解析 = 不失败）
}
```

---

## 4. 本地 ingest-chunks CLI（apps/crawler）

### 4.1 命令模式

```bash
# 5 类 source 统一入口
node apps/crawler/src/main.ts \
  --url "https://example.com/article" \
  --source-type webpage \
  --ingest-url "https://gateway/api-ingest" \
  --ingest-proxy-secret "$INGEST_PROXY_SECRET" \
  --user-id "01KVCZ2JRBAGF3MY75D7KEY4RZ" \
  --trust 2

# PDF 上传
node apps/crawler/src/main.ts \
  --file ~/Downloads/weaning-guide.pdf \
  --source-type pdf \
  --title "断奶指南" \
  --ingest-url "..." \
  --user-id "..." \
  --trust 3
```

### 4.2 处理流程（本地）

```
1. fetchXxx (webpage/xhs/wx-mp) 或 parsePdf/parseDocx
   ↓
2. chunkText (packages/shared)
   ↓
3. MiniMax embed API (本地调, 本地 key)
   ↓
4. POST /api-ingest { chunks[], document, source, user_id }
```

### 4.3 5 类 source 覆盖

| source-type | 本地 fetch | 本地 parse | 本地 chunk | 本地 embed |
|---|---|---|---|---|
| `webpage` | `fetchWebpage()` (curl + cheerio) | inline | chunkText | MiniMax |
| `pdf` | `readFileSync` | `pdf-parse` (升级版) | chunkText | MiniMax |
| `docx` | `readFileSync` | `mammoth` | chunkText | MiniMax |
| `xiaohongshu` | `fetchXiaohongshuNote()` (cheerio) | inline | chunkText | MiniMax |
| `wechat-mp` | `fetchWechatMpArticle()` (cheerio) | inline | chunkText | MiniMax |
| `txt` / `md` | `readFileSync` | inline | chunkText | MiniMax |

---

## 5. minipgm 上传入口（待设计）

**问题**：minipgm 用户在手机上，怎么让本地 CLI 跑？

### 方案 A：小程序本地解析（受限）
- minipgm 拿到 PDF → 调 wx.chooseMessageFile → readFile
- 解析 PDF：minipgm 端有 `pdf.js` 但 bundle 大
- 调 MiniMax embed：需要 api key（不能放客户端）

**结论**：A 不可行（api key 暴露 + bundle 太大）

### 方案 B：minipgm → 本地 CLI bridge（推荐）
- minipgm 用户上传 PDF → 调本地 worker 进程（HTTP / file 桥）
- 本地 worker 是用户 Mac 跑的后台进程（类似 dev server）
- minipgm 走 WiFi LAN 调 `http://192.168.x.x:8787/api-ingest`
- 本地 worker：解析 + embed + 转发到腾讯云

**优点**：用户零感知（minipgm 还是直接用），PDF 处理能力在本地
**缺点**：要求 Mac 在同一网络（WiFi）/ 常开本地 worker

### 方案 C：minipgm 上传到 R2 / CloudBase Storage，云上做解析（不推荐）
- 等于 Arch-V1 升级版（换库到 pdfjs-dist 4.x）
- 4MB / 256MB 限制还在
- 用户明确否决

### 推荐

**先用方案 B 的简化版**：
- minipgm 上传 PDF → 暂存 CloudBase Storage
- minipgm 调 `/api-ingest-pending` → 云上返 `{pending: true}`
- 本地 worker（cron 5 min 跑一次）扫 pending 文件 → 下载 + 解析 + embed + 调 `/api-ingest`
- minipgm 端问问题前查 chunks 是否 ready

**v2 升级**：
- 本地 worker 实时桥（要求同 WiFi）

---

## 6. 数据兼容

### 6.1 现有 28 records

CP-7-C #6 迁移的 records 已经是 chunks in DB（content + embedding 字段），**不受新架构影响**：
- `document` 表：`title` / `url` / `userId` / `trustLevel` 等元数据
- `chunk` 表：`content` / `embedding` / `documentId` / `idx` / `userId`

新架构只是**改变 ingest 路径**（content 不再从云上 chunkText 来），不是改存储格式。

### 6.2 audit_log 兼容

CP-7-C #2 加的 `audit_log` collection 记录 ingest 操作。`actor.via` 字段加 `local_ingest` 表示新路径：

```typescript
actor: {
  via: "admin_token" | "admin_jwt" | "ingest_proxy" | "jwt_user" | "local_ingest";
  // ...
}
```

---

## 7. 迁移计划

### Phase 1: API 兼容（1-2 天）
- [ ] 新 `chunks` 字段加到 `IngestRequest` type
- [ ] `/api-ingest` handler 路由：有 chunks 走新路径，没 chunks 走旧路径
- [ ] 旧路径加 deprecation warning（log）
- [ ] 单测覆盖两条路径
- [ ] 部署（不破现有 28 records）

### Phase 2: 本地 ingest-chunks CLI（2-3 天）
- [ ] `apps/crawler/src/parsers/file-parsers.ts` 新增（pdf/docx/txt/md）
- [ ] `apps/crawler/src/ingest-chunks.ts` 新 CLI（统一 5 类）
- [ ] 升级 `pdf-parse` → `pdfjs-dist@4.x`（修中文 PDF 解析）
- [ ] 端到端真接：本地 CLI → /api-ingest → DB

### Phase 3: minipgm 上传 UI（v2）
- [ ] 选 R2 中转 / 本地 worker bridge 方案
- [ ] 实现 + 真机测

### Phase 4: 旧路径弃用（v3）
- [ ] `/api-ingest` 旧 `content` 路径返 410 Gone
- [ ] 旧 API 文档标注 deprecated

---

## 8. References

- 构想.md §四.1 数据来源优先级
- state-cp6.md §2-3 CloudBase 架构
- state-cp7-zhenjie.md §3 Round 9 RAG 链路
- state-cp7-zhenjie.md §8 CP-7-C 真接全 PASS
- spec/2026-06-21-cp7-c-ingest-audit-design.md (CP-7-C #2)

---

**最后更新**：2026-06-22 决策记录
