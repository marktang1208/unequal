# 上线执行手册 (Launch Playbook)

> 目标: 2026-06-26 ~ 2026-06-29 把「育儿不等号」小程序提交审核并发布上线。
> 状态: 🟢 **5 路径真机测试全 PASS**, 后端 P10 fix deployed, 剩 2 阻塞（提审物料 + 上传审核）。

## 📋 4 步执行清单

| # | 步骤 | 文档 | 耗时 | 状态 |
|---|---|---|---|---|
| 1 | 准备提审物料 | [`01-submission-materials.md`](./01-submission-materials.md) | 30min | 🟡 待执行 |
| 2 | 部署协议页 (GitHub Pages) | [`02-github-pages-setup.md`](./02-github-pages-setup.md) | 5min | ✅ done（daytime） |
| 3 | 真机测试 5 路径 | [`03-real-device-test.md`](./03-real-device-test.md) | 1-2h | ✅ **PASS (2026-06-26 night)** |
| 4 | 提交审核 + 发布 | [`04-submit-review.md`](./04-submit-review.md) | 30min | 🟡 待执行 |

**剩 2 阻塞人工总计: 1 小时。审核 1-3 天。最快 2026-06-29 上线。**

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

1. ✅ **完成**: 部署 GitHub Pages 协议页 (daytime)
2. ✅ **完成**: 5 路径真机测试（night, 1-2h, P10 fix + 顺手 UI 改进）
3. 🟡 **明早**: 准备 5 张真机测试截图（依赖今晚已截的）
4. 🟡 **明早**: 简介 + 关键词 + 类目填写（30min）
5. 🟡 **明早**: 微信开发者工具上传 + 提交审核（30min）
6. **等 1-3 天**: 审核中
7. **审核通过**: 发布上线

## 🆕 P10 真接发现 + 修复（2026-06-26 night）

| Bug | 状态 | 备注 |
|---|---|---|
| `getClientIp` undefined crash (CloudBase gateway) | ✅ 修 | commit `61a01e6` + 6 case 单测 + 真接 deploy |
| chat 跨轮 session 复用 (每 query 独立 session) | ⚠️ P11+ | 不阻塞上线，用户单 query 可用 |
| UI 反馈: 提问按钮冗余 | ✅ 修 | commit `a05ff19`，删 button |
| UI 反馈: 缺新会话入口 | ✅ 修 | commit `a05ff19`，加左上角 + 号 |

详见: [`../superpowers/state-p10-miniprogram-real-deploy.md`](../superpowers/state-p10-miniprogram-real-deploy.md)

## ⚠️ 已知限制 (上线后并行, 不阻塞)

- **真育儿 corpus 缺失**: 当前 1966 chunks 只有 ~3 条真育儿内容, "未涉及"率 ~80%
  - 解决: P11+ ingest 公开育儿资料
- **NLI cold-start race**: 35% success rate
  - 解决: P11 SDK 修复或 prewarm
- **chat 跨轮 session 复用 bug**: 每 query 新 session, 历史 tab 膨胀
  - 解决: P11 排查 onShow/setData 时序

## 🔗 关联

- 父文档: [`../superpowers/state-miniprogram-pre-launch.md`](../superpowers/state-miniprogram-pre-launch.md)
- P10 真接文档: [`../superpowers/state-p10-miniprogram-real-deploy.md`](../superpowers/state-p10-miniprogram-real-deploy.md)（新）
- 后端真接: [`../superpowers/state-p9-real-deploy.md`](../superpowers/state-p9-real-deploy.md)
- Memory: `project_miniprogram_pre_launch.md` + `project_p10_miniprogram_real_deploy.md`（新）
