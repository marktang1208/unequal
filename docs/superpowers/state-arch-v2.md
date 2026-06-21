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

## 9. 决策补充：统一 markdown 中间格式 + 单一 ingest 接口

**日期**：2026-06-22
**触发**：用户 2 次重要架构调整
**原因**：业界 PDF 解析工具已成熟（marker / pymupdf4llm / minireu / unstructured 等），**所有文档统一先转 markdown 再入库**，让：
- 入库接口单一（只收 markdown 文本 + metadata，不再收 chunks）
- 解析手段按需选择（PDF 用 marker、docx 用 mammoth、网页用 cheerio 转 md 等）

### 9.1 调整前 vs 调整后

#### 调整前（arch-v2 §3 方案）
```
/api-ingest 接：content 字符串 OR chunks[] 数组
云上：自动 chunkText + embed（content 路径）/ 直接入库（chunks 路径）
```

#### 调整后（arch-v2.1）
```
/api-ingest 接：markdown 字符串 + 元数据（单一格式）
本地：fetchXxx → 解析（PDF 用 marker / docx 用 mammoth / webpage 用 cheerio+md 模板 / ...） → 输出 markdown
云上：只做 chunkText + embed + 入库（不再做"哪类怎么解析"的判断）
```

**关键变化**：
- ❌ 删 chunks 直传路径（arch-v2 §3 那个）
- ✅ 所有 source 输出统一是 **markdown 文本**
- ✅ 云上 ingest 永远走 chunkText + embed（不再有"云上不切分"分支）

### 9.2 5 类 source → markdown 转换矩阵

| source-type | 本地 fetch | 本地 → markdown 转换 | 工具 | 备注 |
|---|---|---|---|---|
| `webpage` | `fetchWebpage()` (curl + cheerio) | cheerio 提取 main + readability 模板 → markdown | `cheerio` + 自定义模板 | 列表/导航/广告自动过滤 |
| `pdf` | `readFileSync()` | **PDF → markdown 转换器** | `marker-pdf` ⭐ 或 `pymupdf4llm` 或 `unstructured` | **业界成熟** |
| `docx` | `readFileSync()` | mammoth extractRawText → 简单 markdown 包装 | `mammoth` | 表格/列表转 md 表格/列表 |
| `txt` | `readFileSync()` | 文本本身 ≈ markdown（直接传入）| — | 几乎无处理 |
| `md` | `readFileSync()` | 原样 | — | 几乎无处理 |
| `xiaohongshu` | `fetchXiaohongshuNote()` (cheerio) | cheerio 提取正文 → md | `cheerio` + 模板 | 反爬需代理 IP |
| `wechat-mp` | `fetchWechatMpArticle()` (cheerio) | cheerio 提取正文 → md | `cheerio` + 模板 | 反爬需第三方聚合 |

### 9.3 PDF → Markdown 库选择（**2026-06 业界对比**）

| 库 | 优势 | 劣势 | 适合 |
|---|---|---|---|
| **`marker-pdf`** ⭐推荐 | GPU 加速；表格/公式/图片都识别；输出干净 md | 需要 Python + 模型下载 ~1GB | 高质量 PDF（学术/书籍/报告）|
| **`pymupdf4llm`** | PyMuPDF 的 LLM 友好封装；纯 CPU；速度快 | 表格识别一般 | 简单结构 PDF（合同/发票）|
| **`minireu`** | 纯 Python 轻量；中等质量 | 表格/公式一般 | 简单 PDF 快速场景 |
| **`unstructured`** | 通用（PDF/DOCX/HTML/...）| 输出格式自定义麻烦 | 多格式混合场景 |
| **`pdf-parse`** (当前) | npm 纯 JS | 只提文本，无结构 ❌ | **不推荐做新架构** |

**决策**：
- **首选 marker-pdf**（GPU 加速 + 表格/公式 + md 干净）
- **回退 pymupdf4llm**（纯 CPU，部署简单）
- **当前 pdf-parse 弃用**（无 md 能力）

### 9.4 新 /api-ingest 协议（markdown 单一格式）

#### Request body
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
    rawPath?: string;
    previewSnippet?: string;
  };

  // ⭐ 关键：本地已转好 markdown
  markdown: string;          // 完整 markdown 文本（含 # ## - 1. 等结构）
  //   - 来源是 markdown/txt：原内容
  //   - 来源是 PDF：marker-pdf 输出
  //   - 来源是 docx：mammoth 转换
  //   - 来源是 webpage：cheerio 模板输出
  //   - 来源是 xiaohongshu/wechat-mp：cheerio 模板输出

  // 兼容：旧 chunks[] 字段（deprecated 警告但仍接受）
  chunks?: Array<...>;

  // 兼容：旧 content 字段（deprecated 警告但仍接受）
  content?: string;
}
```

#### 云上处理（永远统一）
```typescript
if (body.markdown) {
  parsedText = body.markdown;  // 直接用，不解析
} else if (body.content) {
  // 旧路径：deprecated，warn
  parsedText = body.content;
  console.warn("[ingest] DEPRECATED: content 路径，请改用 markdown 字段");
} else if (body.chunks) {
  // 旧路径：deprecated，warn
  // 走 chunks 直传（arch-v2 §3 方案，v2 弃用）
}

chunks = chunkText(parsedText);     // 永远云上切分
embeddings = await embed(chunks);   // 永远云上 embed
await addChunk(...);                // 入库
```

#### Response
```typescript
{
  source_id: string;
  document_id: string;
  chunks_inserted: number;
  chunks_failed: number;
  markdown_chars: number;    // ⭐ 新字段：源 markdown 长度
  parse_path: "markdown" | "content" | "chunks";  // ⭐ 用了哪条路径
}
```

### 9.5 5 类 source 处理流程（统一图）

```
┌──────────────────────────────────────────────┐
│ Mac 本地                                        │
│                                              │
│  fetchXxx (webpage/xhs/wx-mp)                │
│      OR                                       │
│  readFileSync (pdf/docx/txt/md)              │
│      ↓                                        │
│  ★ 解析为 markdown 文本                       │
│   ├─ pdf     → marker-pdf / pymupdf4llm        │
│   ├─ docx    → mammoth                        │
│   ├─ webpage → cheerio + readability 模板     │
│   ├─ xhs     → cheerio 模板                    │
│   ├─ wx-mp   → cheerio 模板                    │
│   ├─ txt     → 直接用                          │
│   └─ md      → 直接用                          │
│      ↓                                        │
│  POST /api-ingest { markdown, source, ... }    │
│      ↓                                        │
└──────│───────────────────────────────────────┘
       ↓
┌──────│────────────────────────────────────────┐
│ CloudBase (腾讯云)                                │
│  - 鉴权 (JWT + IP allowlist)                   │
│  - chunkText (云上, 不变)                       │
│  - MiniMax embed (云上, 不变)                  │
│  - 入库 (source + document + chunk)            │
│  - audit_log 记录 (actor.via = "local_ingest")  │
└──────────────────────────────────────────────────┘
```

### 9.6 PDF 解析工具栈（Mac 本地）

**推荐组合**：
```bash
# 安装 marker（GPU 推荐；CPU 也能跑，慢）
pip install marker-pdf

# 安装 pymupdf4llm（轻量回退）
pip install pymupdf4llm

# 验证
marker_single /path/to/test.pdf --output_format markdown
```

**Mac 本地调用（Node 调 Python）**：
```typescript
// apps/crawler/src/parsers/pdf-to-markdown.ts
import { spawn } from "node:child_process";

export async function pdfToMarkdown(filePath: string): Promise<string> {
  // 调 marker-pdf Python CLI
  const { stdout } = await execFile("marker_single", [filePath, "--output_format", "markdown"]);
  return stdout;
}
```

**或者用 Node 纯 JS 替代**（如果不想装 Python）：
- `pdfjs-dist` (v4.x 解析) + 自写 md 转换（**质量不如 marker**，但 bundle 一致）
- **生产推荐 marker**

### 9.7 数据兼容（arch-v2 §6 升级）

现有 28 records **已经是 chunks 形式**（content + embedding in DB）— **不受新架构影响**：
- DB schema 不变
- ingest 路径变了（content 流程被替换为 markdown 流程）
- 旧 `content` 路径保留但 deprecated
- 旧 `chunks` 路径保留但 deprecated（v2 弃用）

### 9.8 修订后的迁移计划

#### Phase 1: API 兼容（1-2 天）
- [ ] 新 `markdown` 字段加到 `IngestRequest` type（取代 `chunks` 直传作为主推）
- [ ] `/api-ingest` handler 路由：markdown 优先 → content 走旧路径 → chunks 走旧路径
- [ ] 三条路径都加 deprecation warning（log）
- [ ] 单测覆盖 3 条路径 + 优先级
- [ ] 部署（不破现有 28 records）

#### Phase 2: 本地 markdown 工具（3-5 天）— **arch-v2.1 核心**
- [ ] `apps/crawler/src/parsers/pdf-to-markdown.ts`（调 marker-pdf / pymupdf4llm）
- [ ] `apps/crawler/src/parsers/docx-to-markdown.ts`（mammoth 包装）
- [ ] `apps/crawler/src/parsers/webpage-to-markdown.ts`（cheerio + 模板）
- [ ] `apps/crawler/src/ingest-markdown.ts` 新 CLI（统一 5 类 → markdown → /api-ingest）
- [ ] 5 类真接测（覆盖 PDF 中英文 / docx / 网页 / xhs / wx-mp）
- [ ] 升级 `pdf-parse` → 删除（不再用）

#### Phase 3: minipgm 上传 UI（v2）
- [ ] 选 R2 中转 / 本地 worker bridge 方案
- [ ] 实现 + 真机测

#### Phase 4: 旧路径弃用（v3）
- [ ] `/api-ingest` 旧 `content` + `chunks` 路径返 410 Gone
- [ ] 旧 API 文档标注 deprecated

---

## 11. admin 本地上传文件页面

**日期**：2026-06-22
**触发**：用户 3 次架构调整 — "本地上传文件的页面，方便上传解析，入库以及推到云端"
**现状**：`apps/admin/src/pages/Upload.tsx` 已存在 92 行，但 **实际 broken**（vite proxy 到 localhost:8787 CF Workers 早就无人跑了，CP-6 迁 CloudBase 后这个 proxy 失效）

### 11.1 用户需求

> "本地上传文件的页面，方便上传解析，入库以及推到云端的操作"

**分解**：
1. **本地上传**：admin web UI 接受文件（macOS Finder 拖入 / 点击选）
2. **本地的解析**（arch-v2.1）：PDF 用 marker-pdf / docx 用 mammoth / webpage 用 cheerio → markdown
3. **本地的入库**（arch-v2.1 §9.5 决定）：本地 chunkText + MiniMax embed + **写本地临时 DB**（不写云端！）
4. **推到云端**：把本地 chunks 通过 `/api-ingest` 推送到 CloudBase DB

### 11.2 当前 vs 目标架构

#### 11.2.1 当前（broken）
```
admin dev (5173) ──/api proxy──> localhost:8787 (CF Workers) ❌ 早停了
                                    ↓
                              cloud (api-router) ←─── 当前应该走的路径
```

**问题**：
- vite.config.ts proxy 还指向 8787（已废）
- admin 调用 `/upload` 通过 proxy → 8787 → 失败
- admin 实际从未真接过上传（只在 curl 测过 /api-upload）

#### 11.2.2 目标（arch-v2.1 + 本地解析）
```
┌─────────────────────────────────────────────────────────────┐
│ admin dev server (Vite)                                       │
│                                                               │
│  前端 UI (5173)                                               │
│  ├─ /upload 页 (Upload.tsx)                                   │
│  │   - 文件选择（拖入 + 按钮）                                 │
│  │   - trust_level 选择                                       │
│  │   - 上传按钮 → FormData POST /api/upload                    │
│  │                                                            │
│  Vite middleware (/api/*)                                    │
│  ├─ /api/upload (POST multipart)                              │
│  │   - 接 FormData                                            │
│  │   - 写文件到本地 .tmp/uploads/                              │
│  │   - 调本地 parser (PDF/md/docx) → markdown                  │
│  │   - 调 chunkText (packages/shared)                          │
│  │   - 调 MiniMaxEmbedder (本地 key)                          │
│  │   - 写本地 SQLite (.tmp/unequal.db) ← 暂存                 │
│  │   - 推 chunks 到 CloudBase /api-ingest (proxy 鉴权)         │
│  │   - 返 { source_id, document_id, markdown_chars }           │
│  │                                                            │
│  └─ /api/ingest-local (POST chunks) ← 暂存 + 推                │
│      - admin 调本地"补推"用                                    │
│                                                               │
│  /api/ingest-status (GET)                                    │
│      - 看本地 SQLite 暂存 + 推送状态                          │
└─────────────────────────────────────────────────────────────┘
                          ↓
            CloudBase /api-ingest (markdown 字段)
                          ↓
                CloudBase DB (source/document/chunk)
```

### 11.3 vite middleware 实现要点

#### 11.3.1 vite.config.ts
```typescript
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { localIngestMiddleware } from "./server/local-ingest.js";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // 删掉旧的 /api → 8787 proxy（broken）
    // 新增：本地 middleware 处理 /api/upload /api/ingest-status
  },
});
```

#### 11.3.2 apps/admin/server/local-ingest.ts（新建）
```typescript
import type { Connect } from "vite";
import { PDFDocument } from "pdf-lib";
import mammoth from "mammoth";
import { execFile } from "node:child_process";
import { chunkText } from "@unequal/shared/chunking";
import { createMiniMaxEmbedder } from "@unequal/shared/embedding";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

export const localIngestMiddleware: Connect.Server = (req, res, next) => {
  // POST /api/upload
  if (req.method === "POST" && req.url === "/api/upload") {
    return handleUpload(req, res);
  }
  // GET /api/ingest-status
  if (req.method === "GET" && req.url?.startsWith("/api/ingest-status")) {
    return handleStatus(req, res);
  }
  next();
};

async function handleUpload(req, res) {
  // 1. 解析 multipart FormData
  // 2. 写文件到 .tmp/uploads/
  // 3. 按 ext 选 parser:
  //    - pdf → marker-pdf (Python subprocess)
  //    - docx → mammoth
  //    - txt/md → 直接用
  // 4. 调 chunkText (本地) + embed (本地 MiniMax)
  // 5. 推 /api-ingest (cloud) with markdown + chunks
  // 6. 返 { source_id, document_id, markdown_chars, parse_path }
}
```

### 11.4 5 类文件处理（admin 端）

| 文件类型 | 本地处理 | 推到云端的字段 |
|---|---|---|
| `.pdf` | marker-pdf → markdown | `markdown` |
| `.docx` | mammoth → markdown | `markdown` |
| `.txt` | 直接用 | `markdown` |
| `.md` | 直接用 | `markdown` |
| `.html` | cheerio 提取 → markdown | `markdown` |
| 网页 URL | curl + cheerio → markdown | `markdown` |

### 11.5 SQLite 暂存（v1 简化）

**为什么暂存**：
- 本地解析慢（marker-pdf 几秒~几十秒）
- 推云端可能失败（网络 / 限流）
- 暂存给"补推"用

**schema**（`apps/admin/.tmp/unequal.db`）：
```sql
CREATE TABLE local_ingest (
  id INTEGER PRIMARY KEY,
  filename TEXT NOT NULL,
  ext TEXT NOT NULL,
  markdown TEXT NOT NULL,
  markdown_chars INTEGER,
  chunks_count INTEGER,
  embeddings BLOB,           -- JSON 序列化
  status TEXT NOT NULL,       -- 'pending' | 'pushed' | 'failed'
  pushed_at INTEGER,
  cloud_source_id TEXT,
  cloud_document_id TEXT,
  error_message TEXT,
  created_at INTEGER NOT NULL
);
```

**UI 补推**：
- "Pending" 状态的文件可"重推"按钮
- "Failed" 显示 error + 可重试

### 11.6 minipgm 端 / admin 端 / CLI 端 三方一致

| 客户端 | 上传入口 | 解析 | 推到云端 |
|---|---|---|---|
| **minipgm** | wx.chooseMessageFile | minipgm 端无能力 → 走 **R2 中转 + 本地 worker 异步** | /api-ingest-pending + 本地 worker 推 |
| **admin web** ⭐ | `<input type="file">` 拖入 | Vite middleware 本地解析 | /api-ingest |
| **CLI** | `cat file \| cmd` | 直接 Node 解析 | /api-ingest |
| **crawler** | URL fetch | cheerio 解析 | /api-ingest |

**共同点**：**所有路径最终都调同一个 `/api-ingest`，传 `markdown` 字段**

### 11.7 实施计划

#### Phase A: vite middleware 基础（1-2 天）
- [ ] 修 vite.config.ts 删 8787 proxy
- [ ] 新增 `apps/admin/server/local-ingest.ts`（接 multipart + 写文件 + 调 parser）
- [ ] 5 类 parser 函数（marker-pdf / mammoth / cheerio / txt-md）
- [ ] 推云端 chunks（复用 CloudBaseCallTest 的 jwt 流程）
- [ ] 修 Upload.tsx 适配新 API（错误信息 + 进度）
- [ ] 单测覆盖 5 类文件端到端

#### Phase B: SQLite 暂存（1 天）
- [ ] `apps/admin/.tmp/unequal.db` schema
- [ ] status 字段 + 补推逻辑
- [ ] UI 显示 pending/failed 列表

#### Phase C: PDF 库升级（与 arch-v2.1 phase 2 同步）
- [ ] 装 marker-pdf（pip install marker-pdf）
- [ ] 验证中文 PDF → md 质量
- [ ] 失败时回退 pymupdf4llm

#### Phase D: minipgm 上传（v2 独立项）
- [ ] R2 中转 / 本地 worker bridge 方案（arch-v2.1 §9.5 方案 B）

### 11.8 当前 broken 修法（快速 fix）

在实施 Phase A 之前，先**让 admin 上传能用**（即使不做本地解析）：

```typescript
// vite.config.ts
server: {
  port: 5173,
  proxy: {
    // 改 proxy 到 CloudBase Gateway（admin 调云端 /api-upload）
    "/api": {
      target: "https://unequal-d4ggf7rwg82e0900b-1444590671.ap-shanghai.app.tcloudbase.com",
      changeOrigin: true,
      rewrite: (path) => path.replace(/^\/api/, "/api-router/api"),
      // 改云端解析（暂时回归 CP-6 模式）
    },
  },
},
```

**注意**：这只是快速 fix 让功能 work。arch-v2.1 实施后改用本地 middleware 走 markdown 路径。

---

## 12. References 更新

- 构想.md §四.1 数据来源优先级
- state-cp6.md §2-3 CloudBase 架构
- state-cp7-zhenjie.md §3 Round 9 RAG 链路
- state-cp7-zhenjie.md §8 CP-7-C 真接全 PASS
- spec/2026-06-21-cp7-c-ingest-audit-design.md (CP-7-C #2)
- marker-pdf: https://github.com/datalab-to/marker
- pymupdf4llm: https://github.com/pymupdf/pymupdf4llm
- vite middleware 文档: https://vitejs.dev/guide/api-plugin.html#configureserver

---

**最后更新**：2026-06-22 决策记录（v2.2 补充 admin 本地上传文件页）
