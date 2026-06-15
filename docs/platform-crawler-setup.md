# 不等号平台抓取：小红书 + 微信公众号

> M5 范围。两个 source adapter 的 CLI + admin 用法、真平台风险说明、v2+ 登录态自动抓账号路线。

## 概述

M5 在 `apps/crawler` 加了两个 source adapter：

| Adapter | 入口 | 用途 |
|---|---|---|
| `xiaohongshu.ts` | `fetchXiaohongshuNote(url, opts)` | 抓小红书单帖 HTML → 提取 title / author / publishedAt / paragraphs |
| `wechat-mp.ts` | `fetchWechatMpArticle(url, opts)` | 抓微信公众号单文章 HTML → 提取 title / account / publishedAt / paragraphs |

两个 adapter 都用 cheerio 解析 HTML（零浏览器依赖，零运行时新依赖），结果统一为 `CrawledDocument` 加可选 `platformSpecific: { author?, publishedAt? }` 字段。

CLI、admin 抓取页都基于这两个 adapter。

---

## CLI 用法

### 抓小红书单帖

```bash
node --experimental-strip-types apps/crawler/src/main.ts \
  --url "https://xiaohongshu.com/explore/abc123" \
  --source-type xiaohongshu \
  --no-ingest
```

输出示例：

```
[crawler] fetch https://xiaohongshu.com/explore/abc123 (source-type: xiaohongshu)
[crawler] title: 5个月宝宝辅食添加全攻略
[crawler] paragraphs: 4, totalChars: 187
[crawler] --no-ingest set, skipping ingest
{ "url": "...", "title": "...", "paragraphs": [...], "totalChars": 187, "fetchedAt": ..., "platformSpecific": { "author": "小红书用户A", "publishedAt": "2026-05-12T10:30:00+08:00" } }
```

### 抓微信公众号单文章

```bash
node --experimental-strip-types apps/crawler/src/main.ts \
  --url "https://mp.weixin.qq.com/s/wx_abc" \
  --source-type wechat-mp \
  --no-ingest
```

### 调 /ingest 真入库

去掉 `--no-ingest` 标志，加上 `--token` + `--ingest-url` + `--user-id` + `--trust` 即可。M0+M1 /ingest endpoint 自动接受 `source.type='xiaohongshu'|'wechat-mp'`（D1 schema 已有 `source.type` 字面量）。

---

## admin 抓取页

dev 模式（mock-first）：

```bash
pnpm dev:api    # 终端 1
pnpm dev:admin  # 终端 2
```

访问：
- http://localhost:5173/crawl/xiaohongshu
- http://localhost:5173/crawl/wechat-mp

每个页面：
- textarea 输入 URL（每行一个）
- trust_level 下拉（XHS 默认 1，WX-MP 默认 2）
- 提交按钮 → fetch `/mock-crawl/{platform}.json`（Vite 静态服务）
- 结果列表：绿/黄/红框
- 确认入库按钮（mock-first 下写 localStorage；真接 Cloudflare 后调 /ingest）

dev fixture 在 `apps/admin/public/mock-crawl/`，3 个 XHS URL + 3 个 WX-MP URL。

---

## 真平台风险说明（M5 已知）

M5 抓取器在 mock-first 模式下不抓真网。真接时以下风险需要真人 / 平台操作介入：

| 风险 | 影响 | 缓解 |
|---|---|---|
| 小红书反爬（IP 风控 / 验证码） | 单 IP 抓 5-10 篇后被 ban | v2+ 接代理 IP 池；v1 限制每日抓取量 |
| 微信公众号反爬（登录态校验） | 公开访问的 mp.weixin.qq.com 链接有限 | v2+ 接登录态 cookie 注入（App 抓包 或 第三方服务） |
| 平台改版（HTML 结构变更） | parser selectors 失效 | 抓取报错时更新 selectors + fixture HTML |
| 平台 ToS 风险 | 大批量抓取可能违反服务条款 | 用户手动复制 URL 列表（M5 默认行为），不自动登录抓账号 |

**M5 范围内默认不解决上述风险**。v2+ 登录态自动抓账号推到 M5.5。

---

## v2+ / M5.5 路线

| 项 | 推到 | 备注 |
|---|---|---|
| 登录态自动抓账号（小红书 App 抓包 / 公众号 cookie） | v2+ / M5.5 | 需引入第三方服务（NewRank / 蝉妈妈 / 西瓜数据）或自实现 cookie 注入 |
| 反爬绕过（代理 IP / UA 轮换 / 验证码识别） | v2+ | 真平台抓取前提 |
| Cron 定时抓取 | v2+ | 手动触发优先 |
| `/api/xhs-batch` / `/api/wxmp-batch` 真 endpoint | v2+ | admin 直接调 fixture；真接时薄 proxy |
| 按 content hash 去重 | v2+ | M5 只按 URL（localStorage） |
| robots.txt 自动遵守 | 生产前必做 | M5 手动审查 |
| 抓取失败自动重试 / 指数退避 | v2+ | M5 单次抓取 |

---

## 测试

```bash
pnpm -F crawler test
# 19 用例: webpage 4 + ingest 3 + parser 4 + xiaohongshu 4 + wechat-mp 4
```

```bash
pnpm -F admin test
# 4 用例: dedupe 4
```

总用例数（M0-M5）：以 `pnpm -r test` 实际输出为准。
