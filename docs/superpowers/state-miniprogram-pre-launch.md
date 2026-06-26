# state-miniprogram-pre-launch — 微信小程序"育儿不等号"上线进度 (2026-06-26)

> 日期: 2026-06-26
> 项目: unequal 微信小程序 (AppID: wxf5b8ce05a977f0c6, 个人主体)
> 后端: api-router 27 vars on cloud (P8 + P9 真接 PASS, 跟 state-p9-real-deploy.md)
> 状态: 🟡 **后端就绪, 前端待真机测试 + 提审**

## 0. TL;DR

**后端 100% 就绪** (P8 vector DB + P9 NLI polling + retrieval follow-up #13, 累计 3 commits + 378/378 tests + 5 次 deploy)。**前端 project.config.json 已就位** (AppID + 云开发 envId + 描述更新), 等待微信开发者工具真机扫码 + 提审物料准备 + 提交审核。

**真机测试发现问题** → P9 follow-up #13 (commit `ff195b6`) 5 个 retrieval bug 修复, 修后真 user chat 返有内容 (citations 0-5 + LLM 兜底)。

**Corpus 限制**: 1966 chunks 实际只有 ~3 条真育儿内容 (其余是测试/CS 论文/小说), 这是 corpus 内容问题, 上线后并行 ingest 真育儿资料。

## 1. 项目基本信息

| 项 | 值 | 备注 |
|---|---|---|
| 微信 AppID | `wxf5b8ce05a977f0c6` | 个人主体, 32 字符 wx 开头 |
| 小程序名称 | 育儿不等号 | 中文, 微信独一无二校验通过 |
| 主体类型 | 个人 | 个人主体, 类目限制较多 (不能做医疗/金融/支付) |
| 导航栏标题 | 育儿不等号 | app.json 简化 |
| 后端 env | unequal-d4ggf7rwg82e0900b | NoSQL + 云函数, 上海 region |
| 后端 envId 后缀 | 1444590671 | 不等于 AppID, 是云开发 envId 数字后缀 |
| Gateway URL | https://unequal-d4ggf7rwg82e0900b-1444590671.ap-shanghai.app.tcloudbase.com | 个人版 HTTP 触发器 |

## 2. 前端配置 (apps/miniprogram/)

### 2.1 project.config.json 已更新

| 配置项 | 值 | 备注 |
|---|---|---|
| `appid` | wxf5b8ce05a977f0c6 | 16 字符 wx 开头, 真 AppID |
| `projectname` | unequal-miniprogram | 微信开发者工具显示名 |
| `description` | 不等号 / unequal 微信小程序配置。AppID wxf5b8ce05a977f0c6 (个人主体), 云开发 envId unequal-d4ggf7rwg82e0900b, 后端 api-router 真接 P8 vector DB + P9 NLI polling。等待微信开发者工具真机预览 + 提交审核。 | P9 真接后更新 |
| `compileType` | miniprogram | 微信小程序 |
| `libVersion` | 3.5.0 | 基础库 |
| `miniprogramRoot` | ./ | 当前目录 |
| `cloudfunctionRoot` | cloudfunctions/ | 云函数目录 |
| `setting.urlCheck` | false | 真机调试时不校验合法域名 |
| `setting.useCompilerPlugins` | [typescript] | TS 支持 |

### 2.2 app.json 已更新

```json
{
  "pages": [
    "pages/chat/chat",
    "pages/history/history",
    "pages/source-detail/source-detail",
    "pages/settings/settings",
    "pages/cloudbase-test/cloudbase-test"
  ],
  "tabBar": {
    "color": "#666666",
    "selectedColor": "#2563eb",
    "list": [
      { "pagePath": "pages/chat/chat", "text": "问答" },
      { "pagePath": "pages/history/history", "text": "历史" }
    ]
  }
}
```

### 2.3 5 个页面状态

| 页面 | 文件 | 状态 | tabBar |
|---|---|---|---|
| `pages/chat/chat` | chat.{ts,wxml,wxss,json} | ✅ M7 + P9 polling 集成 | ✅ "问答" |
| `pages/history/history` | history.{ts,wxml,wxss,json} | ✅ M7-D sessions 列表 | ✅ "历史" |
| `pages/source-detail/source-detail` | source-detail.{ts,wxml,wxss,json} | ✅ 引用详情 | ❌ 隐藏 |
| `pages/settings/settings` | settings.{ts,wxml,wxss,json} | ✅ M7-D settings 页 | ❌ 隐藏 |
| `pages/cloudbase-test/cloudbase-test` | cloudbase-test.{ts,wxml,wxss,json} | 🟡 调试页 (CP-6 验云开发链路) | ❌ 隐藏 |

**隐藏页面入口**:
- `source-detail`: chat 引用卡片点击
- `settings`: chat 右上角菜单
- `cloudbase-test`: 开发者工具手动 navigateTo (真机用户进不了)

### 2.4 关键 lib 文件

| 文件 | 用途 | 状态 |
|---|---|---|
| `lib/auth.ts` | M6.2 冷启动拿 jwt (ensureJwt) | ✅ |
| `lib/cloud-call.ts` | wx.cloud.callFunction 封装 (api-router) | ✅ |
| `lib/api.ts` | API client 封装 | ✅ |
| `lib/storage.ts` | 本地存储 (session_id 等) | ✅ |
| `lib/citation-parser.ts` | 引用解析 | ✅ |
| `lib/chat-storage.ts` | chat 持久化 | ✅ |
| `lib/types.ts` | 共享类型 | ✅ |

## 3. 后端真接现状 (来自 state-p9-real-deploy.md)

### 3.1 27 vars on cloud

**17 template vars** (apps/api/cloudbaserc.json):
```
ENVIRONMENT, ALLOWED_ORIGIN, MINIMAX_BASE_URL, DEFAULT_USER_ID,
ADMIN_IP_ALLOWLIST, LLM_MAX_TOKENS, VECTOR_STORE, NLI_ASYNC, ...
```

**10 secrets** (Keychain, 推 SCF API):
```
ADMIN_TOKEN, JWT_SECRET, MINIMAX_API_KEY, KEK_SECRET_V1, INGEST_PROXY_SECRET,
ADMIN_IP_ALLOWLIST, SILICONFLOW_API_KEY, CLOUDBASE_SECRET_ID, CLOUDBASE_SECRET_KEY, PG_CONNECTION_STRING
```

### 3.2 P8 + P9 真接 PASS

| 项 | 状态 | commit |
|---|---|---|
| VECTOR_STORE=pg 切流 | ✅ | 162e0dd |
| PG 1976 chunks migrated + HNSW P99<100ms | ✅ | state-p8-real-deploy |
| NLI_ASYNC=1 全量切流 | ✅ | c832189 |
| polling 3-2-5 节奏 | ✅ | c832189 |
| audit_log 34 条 chat_nli_async | ✅ | state-p9 §2.5 |
| **retrieval corpus 共享 + threshold 修复 (5 bug)** | ✅ | ff195b6 |

### 3.3 P9 follow-up #13 修后实测 (2026-06-26 下午)

| Query | 修前 | 修后 |
|---|---|---|
| 月龄 | "未涉及" | **citations=5** |
| 添加辅食 | "未涉及" | LLM 兜底 + 详细常识 |
| 辅食添加 | "未涉及" | **citations=2** |
| 宝宝 | "未涉及" | LLM 反问澄清 |
| 新生儿 | "未涉及" | "未涉及新生儿信息" |
| 宝宝几个月可以吃辅食 | "未涉及" | context 拿到断奶 chunk, LLM 严格判断 corpus 不相关 → "未涉及" |

## 4. 真机测试 5 路径 checklist (待执行)

### 4.1 准备工作

```bash
# 1. 打开微信开发者工具
# 2. 左侧「小程序」→ 右下角「+」→「导入项目」
# 3. 项目目录: /Users/Mark/cc_project/unequal/apps/miniprogram
# 4. AppID 自动填 wxf5b8ce05a977f0c6
# 5. 项目名称: 育儿不等号
# 6. 后端服务: 微信云开发 (已勾选)
# 7. 点「导入」→ 等编译 30s-1min
# 8. 右上角「真机调试」→「自动预览」→ 微信扫码
```

### 4.2 5 路径测试

| # | 路径 | 预期 | fail 信号 |
|---|---|---|---|
| 1 | 冷启动 | chat 空状态, tabBar 显示, console `[unequal] wx.cloud.init ok` | 报 "wx.cloud.callFunction failed" → envId 错 |
| 2 | chat 短问 (宝宝几个月可以吃辅食) | 3-5s spinner, 20-25s LLM 回答, 3-2-5 polling spinner | 报"未涉及" → P9 follow-up 已修; 报网络错 → JWT 问题 |
| 3 | chat 跨轮 (那吃什么比较好) | 5-10s warm 回答, session 不变, 同 polling | 报"session not found" → sessionId 持久化问题 |
| 4 | 历史 sessions tab | 看到刚才 session + 2 问 2 答 + 引用 | 历史空 → /api-sessions fail |
| 5 | settings 页 | 看到 user_id + source 过滤选项 | user_id 空 → /api-auth-me fail |

### 4.3 fail 排查

| 现象 | 排查 |
|---|---|
| 报 "网络错误" | 看 `auth.ts` ensureJwt log, JWT 没拿到 |
| 报 "404" | 看 `lib/cloud-call.ts:86` `name: "api-router"` |
| spinner 不消失 | 看 `pollNliResult` log, 5 次 polling 失败 |
| 报"未涉及" | corpus 内容问题 (P10+ 加真育儿资料) |
| 报"session not found" | 看 `chat-storage.ts` sessionId 持久化 |
| wx.cloud.callFunction failed | envId 错 (app.ts:10 cloudEnvId) |

## 5. 提审前 checklist (个人主体)

### 5.1 类目选择

**个人主体可用类目**:
- ✅ 工具 → 效率
- ✅ 教育 → 在线教育
- ✅ **生活服务 → 母婴** (推荐, 跟产品"育儿问答"对齐)
- ❌ 医疗健康 (需企业 + 资质)
- ❌ 社交 (需企业 + ICP)

**推荐**: 生活服务 → 母婴

### 5.2 必备物料

| 物料 | 状态 | 备注 |
|---|---|---|
| 小程序名称 | ✅ 育儿不等号 | 中文, 微信独一无二校验通过 |
| 简介 (50 字内) | ❓ 待写 | 例: "育儿问答助手, 基于家长经验分享的智能搜索" |
| 关键词 (5 个) | ❓ 待列 | 例: 育儿, 母婴, 辅食, 早教, 问答 |
| 服务类目 | ❌ 待选 | 生活服务 → 母婴 |
| 用户协议 URL | ❓ 待提供 | 个人主体可挂 GitHub Pages / 博客 |
| 隐私政策 URL | ❓ 待提供 | 同上 |
| 体验版截图 (5 张) | ❓ 待截 | 截 5 个核心页面 (chat/history/settings/...) |
| 类目相关资质 | N/A | 个人主体"母婴"类目不要资质 |

### 5.3 个人主体限制

- 不能用 `wx.getLocation` / `wx.getUserInfo` (需企业 + scope.userLocation)
- 不能做支付 (企业才行)
- 不能做广告分成 (企业才行)
- **我们的功能都不需要这些** — 用 wx.cloud.callFunction + JWT 即可

### 5.4 体验版 → 审核 → 发布

```
1. 微信开发者工具 → 上传 → 版本号 1.0.0 + 项目备注
2. 微信公众平台 → 版本管理 → 体验版 → 提交审核
3. 等待审核 1-3 天 (个人主体快)
4. 审核通过 → 发布
```

## 6. 时间表 (今天 + 接下来 1 周)

| 阶段 | 时间 | 操作 | 状态 |
|---|---|---|---|
| 项目准备 | 2026-06-26 上午 | AppID 确认, project.config.json + app.json 更新 | ✅ done |
| 后端修复 | 2026-06-26 下午 | P9 follow-up #13 (5 bug 修复 + 4 deploy) | ✅ done |
| 真机测试 | 2026-06-26 下午-明天 | 微信开发者工具 + 真机扫码 5 路径 | 🟡 待执行 |
| 提审物料 | 2026-06-26 晚上 | 写简介/关键词 + 截图 + 协议 URL | 🟡 待执行 |
| 提交审核 | 2026-06-27 | 上传代码 + 提交审核 | 🟡 待执行 |
| 审核等待 | 2026-06-27 ~ 06-29 | 等审核 1-3 天 | 🟡 等 |
| 审核通过 + 发布 | 2026-06-29 | 发布上线 | 🟡 等 |
| 7 天监控 | 上线后 7 天 | 监控 audit_log + 真 user 体验 | 🟡 等 |

**最快 2-3 天上线** (今天 + 明天 + 审核 + 发布)。

## 7. 已知限制 + 后续

### 7.1 上线阻塞 (待做)

| # | 任务 | 时间 | 阻塞? |
|---|---|---|---|
| 1 | 真机扫码测试 5 路径 | 1-2 小时 | 🟡 是 |
| 2 | 提审物料 (简介/截图/协议) | 30 分钟 | 🟡 是 |
| 3 | 微信开发者工具上传 + 提交审核 | 30 分钟 | 🟡 是 |

### 7.2 上线后并行做 (不阻塞)

| # | 任务 | ROI | 优先级 |
|---|---|---|---|
| 1 | **加真育儿 corpus** (公开来源 ingest 5-10K chunks) | "未涉及"率从 ~80% → ~20% | 🔴 HIGH |
| 2 | **P10 NLI cold-start race** (修 SDK getTempFileURL 或 prewarm init) | NLI success rate 35% → 80%+ | 🟡 MED |
| 3 | 重新评估 retrieval threshold (corpus 大了后调) | 命中率优化 | 🟡 MED |
| 4 | 监控 + 日志平台 (Sentry/LogRocket) | 稳定性 | 🟢 LOW |
| 5 | chat UX streaming 整合 | 体感更好 | 🟢 LOW |

### 7.3 上线后候选 (P11+)

| # | 任务 | ROI | 风险 |
|---|---|---|---|
| 1 | P11 本地推理 (OMLX Qwen3-4B) | LLM 20s → 5-10s | 高 |
| 2 | 多源 ingest 全跑通 | 数据丰富度 | 中 |
| 3 | P12 chat UX 进一步优化 (per-turn warning 动画 + answer streaming 整合) | UX 提升 | 中 |

## 8. 关联

- **state-p9-real-deploy.md** — P9 NLI 异步化真接 + follow-up #13 完整 evidence
- **state-p8-real-deploy.md** — P8 vector DB 真接 evidence
- **state-p9-nli-async-polling.md** — P9 代码收官 (§1.3 真接 3 步 follow-up → §2.5 决策落地)
- **state-arch-v2.4.md** — CloudBase 限制事实稳定
- **state-p5-nli-entailment.md** — P5 v1.3 sync 路径 backward compat
- **state-p6-local-onnx-nli.md** — NLI provider (P9 不动, 仅调用时序改)
- **memory** `project_p9_nli_async_real_deploy.md` — P9 真接 memory pointer

## 9. 回滚路径

| 阶段 | 命令 | 影响 | 数据丢失? |
|---|---|---|---|
| 后端回滚到 P5 v1.3 | `NLI_ASYNC=0` + `VECTOR_STORE=nosql` + `pnpm -F api deploy:full` | P5 v1.3 baseline 恢复, 老客户端无感 | 无 |
| 真接 P9 follow-up #13 | `git revert ff195b6` + `pnpm -F api deploy:full` | 退回 P9 真接日状态, 真 user 命中 corpus 退化为 0 | 无 |
| 微信小程序下架 | 微信公众平台 → 设置 → 暂停服务 / 注销 | 用户无法访问, 数据保留 | 无 |
