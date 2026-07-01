# Oracle Cloud 2.0 迁移准备文档

> **状态**：🚧 准备中（feature/oracle-2.0-prep 分支）
> **触发**：P12+ 启动迁移（备案失败 / CloudBase 费用持续 > ¥50 / 真用户性能瓶颈 / 用户明确说"现在迁移"）
> **当前 1.0**：P10 100% PASS, 1.0.0 已上传微信开发者工具, 备案审核中

## 0. 决策（2026-07-01）

| 决策 | 选择 | 原因 |
|---|---|---|
| **目标云** | Oracle Cloud Always Free（永久免费） | 1 OCPU + 6GB ARM, 10TB/月流量 |
| **部署模式** | **彻底迁移（不用 CloudBase）** | 用户拒绝混合云（CloudBase 仍要花钱） |
| **数据库** | 自建 PostgreSQL 16 + pgvector | 10 个 collection 全部落 pg |
| **入口层** | `@hono/node-server` 包一层 | 把 SCF event 转 Node http server |
| **域名** | 暂未买（备案下来再买 `unequal.top`） | 备案号是域名实名核验的前提 |
| **数据迁移** | `scripts/migrate-nosql-to-pg.ts`（待写） | 一次性从 CloudBase 拉 1966 chunks + 9 业务表 |

## 1. 准备资源

| 资源 | 状态 | 备注 |
|---|---|---|
| Oracle 实例 `instance-20260701-1639` | ✅ Running | 1 OCPU + 6GB, 法兰克福 |
| 公网 IP `158.178.140.241` | ✅ 绑定 primary VNIC | 法兰克福节点，国内可达（已测 83ms 拉 GitHub） |
| Docker Engine | ✅ v27+ | ARM64 兼容 |
| Docker Compose | ✅ v5.2.0 | |
| GitHub repo | ✅ marktang1208/unequal | 公开可 `git clone` |
| SSH key (ed25519) | ✅ `~/.ssh/id_ed25519` | 已注入实例 |
| 域名 | ⏳ 备案下来后买 | 阿里云万网 ~¥30/年 |
| Let's Encrypt SSL | ⏳ 域名就位后签 | 免费 |

## 2. 文件清单

```
deploy/oracle/
├── README.md                    ← 本文档
├── Dockerfile                   ← api 容器构建（Node 20 alpine + esbuild bundle）
├── docker-compose.yml           ← api + pg + nginx + admin 一键启停
├── .env.example                 ← 28 个环境变量模板
├── init-pg.sql                  ← pg schema 初始化（10 业务表 + pgvector 扩展）
├── nginx.conf                   ← 反代 + HTTPS 配置（待写）
├── migrate-nosql-to-pg.ts       ← 数据迁移脚本（待写）
├── oracle-deploy.sh             ← 一键部署到 Oracle 实例（待写）
└── nli-assets/                  ← ONNX 模型文件（待 download）
```

## 3. 启动迁移 checklist（P12+ 触发后逐项打勾）

### 阶段 1：代码改造（不破坏 1.0）
- [ ] `apps/api/src/index.ts` 加 `@hono/node-server` 包装
- [ ] 写 `apps/api/src/lib/db-pg.ts`（pg 版本的 db.ts，10 个 collection 方法）
- [ ] 改 `src/lib/cloudbase.ts` 兼容模式（保留 import 路径，去掉 SDK init）
- [ ] 改 `src/lib/env.ts` 增加 `VECTOR_STORE=pg` 强制（不再支持 `nosql`）
- [ ] 全量跑单测 `pnpm test`，确保 0 回归

### 阶段 2：本地 docker-compose 验证
- [ ] `docker compose up -d`（本地 Mac 跑，验证 4 容器联动）
- [ ] `curl http://localhost:8080/health` 返 200
- [ ] 跑 mini-program 5 路径回归（用 `apiBaseUrl=http://localhost:8080`）
- [ ] admin `pnpm dev` 跑通

### 阶段 3：数据迁移
- [ ] `scripts/migrate-nosql-to-pg.ts` 拉 CloudBase 10 collections
- [ ] 1966 chunks 走 `pgvector` (HNSW P99<100ms)
- [ ] 业务数据 9 张表（user / session / message / cache / audit / login / key / crawl_job）
- [ ] 校验：迁移前后 chunk 数 / user 数 / session 数 一致

### 阶段 4：Oracle 实例部署
- [ ] `git pull origin feature/oracle-2.0-prep`
- [ ] 上传 .env（scp /tmp/unequal.env → ~/unequal/deploy/oracle/.env）
- [ ] 上传 ONNX 模型（scp ~/nli-assets/* → ~/unequal/deploy/oracle/nli-assets/）
- [ ] `docker compose build && docker compose up -d`
- [ ] `curl http://158.178.140.241:8080/health` 返 200（绕开 nginx 测试）

### 阶段 5：域名 + HTTPS（备案下来后）
- [ ] 买 `unequal.top`（阿里云万网，~¥30/年）
- [ ] A 记录 → `158.178.140.241`
- [ ] `certbot --nginx -d unequal.top -d www.unequal.top`
- [ ] `curl https://unequal.top/health` 返 200

### 阶段 6：前端切换
- [ ] `apps/miniprogram/app.ts` 改 `apiBaseUrl = "https://unequal.top"`
- [ ] `apps/admin/.env.production` 改 `VITE_API_BASE=https://unequal.top`
- [ ] miniprogram 1.0.1 上传（不需再审核，admin 域名白名单加 unequal.top）
- [ ] admin `pnpm build` 部署

### 阶段 7：真接 5 路径回归
- [ ] 冷启动 chat
- [ ] + 号新会话
- [ ] 历史回看
- [ ] settings 页
- [ ] source 过滤

### 阶段 8：关停 CloudBase
- [ ] CloudBase PG（个人版）退订
- [ ] CloudBase 函数（个人版）退订
- [ ] 确认 ¥0 月费

## 4. 风险与缓解

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| Oracle 收回闲置实例 | 30% | 高 | CPU 持续 > 10%（部署 cron `pg_dump` + tiny Node script） |
| ARM 镜像兼容性 | 10% | 中 | 主流镜像都有 ARM64 版（pgvector / node-alpine） |
| Oracle 流量限制 | 5% | 低 | Always Free 10TB/月，验证期根本用不完 |
| 数据迁移丢失 | 20% | 高 | 迁移前 CloudBase 留底，迁移后比对行数 |
| MiniMax API 域阻 | 5% | 中 | 已确认 Oracle 法兰克福到 google 408ms，可达 |
| 域名备案 + 实名 | 100% | 必走 | 备案下来后 1 天完成 |

## 5. 不做的事

- ❌ 不立即启动（1.0 稳定 + 备案审核中，先不破坏）
- ❌ 不混合云（CloudBase 仍要花钱，用户已明确拒绝）
- ❌ 不买商业 ONNX 推理（本地 onnxruntime 已验证 P99<500ms）
- ❌ 不写监控 / 日志平台（先跑通，运维后补）
- ❌ 不切 LLM provider（MiniMax 满意）
- ❌ 不动 crawler（落本地 SQLite 是单独轨道 B）

## 6. 触发启动迁移的条件

任一发生启动 P12+ 迁移：
1. 微信小程序备案失败 / 反复被打回
2. CloudBase 月费用持续 > ¥50 (1-2 个月观察)
3. 真用户开始用，体验到 CloudBase 性能瓶颈
4. 产品验证期结束，进入产品迭代期
5. 用户明确说"现在就开始迁移"

## 7. 关联

- `project_unequal_2_0_architecture_roadmap.md` — 2.0 调研完整记录
- `state-p10-miniprogram-real-deploy.md` — 1.0 5 路径 PASS
- `state-p11-miniprogram-ui-tweaks.md` — P11 UI 改动 + 备案阻塞
- `state-miniprogram-pre-launch.md` — 1.0 上线 checklist
