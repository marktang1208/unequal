# 上线执行手册 (Launch Playbook)

> 目标: 2026-06-26 ~ 2026-06-29 把「育儿不等号」小程序提交审核并发布上线。
> 状态: 后端 100% 就绪, 前端配置就位, 等真机测试 + 提审。

## 📋 4 步执行清单

| # | 步骤 | 文档 | 耗时 | 状态 |
|---|---|---|---|---|
| 1 | 准备提审物料 | [`01-submission-materials.md`](./01-submission-materials.md) | 30min | 🟡 待执行 |
| 2 | 部署协议页 (GitHub Pages) | [`02-github-pages-setup.md`](./02-github-pages-setup.md) | 5min | 🟡 待执行 |
| 3 | 真机测试 5 路径 | [`03-real-device-test.md`](./03-real-device-test.md) | 1-2h | 🟡 待执行 |
| 4 | 提交审核 + 发布 | [`04-submit-review.md`](./04-submit-review.md) | 30min | 🟡 待执行 |

**人工总计: 2-3 小时。审核 1-3 天。最快 2026-06-29 上线。**

## 📁 文件清单

- `01-submission-materials.md` — 简介 / 关键词 / 类目 / 截图清单 / 提审正文
- `02-github-pages-setup.md` — 协议 + 隐私政策 部署到 GitHub Pages
- `03-real-device-test.md` — 5 路径真机测试脚本 + 失败排查
- `04-submit-review.md` — 上传 + 提交审核 + 发布 操作步骤
- `legal/agreement.html` — 用户协议 (直接部署)
- `legal/privacy.html` — 隐私政策 (直接部署)
- `legal/用户协议.md` — 用户协议 Markdown 源
- `legal/隐私政策.md` — 隐私政策 Markdown 源

## 🚀 推荐执行顺序

1. **现在**: 部署 GitHub Pages 协议页 (5min, 后台跑着)
2. **并行**: 准备 5 张真机测试截图 (15min, 顺手截)
3. **30min 后**: 真机测试 5 路径 (1-2h, 阻塞点)
4. **测试通过**: 提交审核 (30min, 一次性提交)
5. **等 1-3 天**: 审核中
6. **审核通过**: 发布上线

## ⚠️ 已知限制 (上线后并行, 不阻塞)

- **真育儿 corpus 缺失**: 当前 1966 chunks 只有 ~3 条真育儿内容, "未涉及"率 ~80%
  - 解决: P10+ ingest 公开育儿资料
- **NLI cold-start race**: 35% success rate
  - 解决: P10 SDK 修复或 prewarm

## 🔗 关联

- 父文档: [`../superpowers/state-miniprogram-pre-launch.md`](../superpowers/state-miniprogram-pre-launch.md)
- 后端真接: [`../superpowers/state-p9-real-deploy.md`](../superpowers/state-p9-real-deploy.md)
- Memory: `project_miniprogram_pre_launch.md`
