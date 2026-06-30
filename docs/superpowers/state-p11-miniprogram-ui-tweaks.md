# state-p11-miniprogram-ui-tweaks — 上线前 UI 改动 + 备案阻塞 (2026-06-28)

> 日期: 2026-06-28
> 项目: unequal 微信小程序 (AppID `wxf5b8ce05a977f0c6`, 个人主体)
> 状态: 🟡 **代码 + docs + legal 全收官, 微信备案阻塞 (P11 UI 改动已 PASS), 2.0 架构调研完成 (仅记录不执行)**

## 0. TL;DR

**今日 (2026-06-28) 完成**:

1. ✅ **P11 UI 改动全收官** (5 commit + 49/49 PASS + 5 张真机截图)
   - chat 页气泡镜像 (user 左 / assistant 右)
   - 信息源 popup 弹层 (取代底部 chip 条)
   - docs/launch 协议 URL 占位符替换 (真实 URL)
   - legal HTML 邮箱占位符替换 (mark_tang@163.com) + gh-pages 已 rebuild
   - 真机 5 路径回归全 PASS

2. ✅ **P11.2 round 2-5 修复** (5 commit)
   - + 号挪到右上避免遮消息
   - settings 页加法律文档卡片
   - 协议链接: web-view 白屏 → clipboard 退路
   - popup checkbox activeMap 派生 state (修响应式追踪问题)

3. 🟡 **微信小程序 1.0.0 上传成功**, 但 **mp.weixin.qq.com 提交审核时遇到备案提醒**

4. 🟡 **2.0 架构可行性分析完成** (仅记录, 不执行)
   - 5 方案对比 + 网络可达性硬 gate 实测
   - 决策: **暂不迁移, 继续微信备案**

**关键 memory**:
- `project_unequal_2_0_architecture_roadmap.md` — 2.0 完整路线图
- `wechat_miniprogram_webview_gotcha.md` — web-view 跳外链白屏
- `feedback_china_network_constraints.md` — 国内网络 §1 硬 gate
- `resolved_miniprogram_ui_tweaks.md` — UI 反馈消化

## 1. P11 UI 改动 (5 commit 链)

```
bebc8ae2 docs(launch): 重截 05-source-popup-open.png (P11.2 popup 修复后)
9754d31d fix(miniprogram): P11.2 round 5 — popup checkbox 选中态 UI 不更新 (用 activeMap 派生 state)
36db5a18 fix(miniprogram): P11.2 round 4f — 用 wx.showToast 强制可见 (替代 console.warn)
c8b144ce fix(miniprogram): P11.2 round 4d — popup 加 debug button 验证事件系统
3b352ed1 fix(miniprogram): P11.2 round 4 — popup checkbox 点击无反应排查
e066d99f fix(miniprogram): P11.2 webview 白屏修复
5362a47e fix(miniprogram): P11.2 round 3 — settings 协议改用 clipboard
dae3ad53 fix(miniprogram): P11.2 — + 号挪到右上
5f35fe6e (合并行) 
a6ba87e5 feat(miniprogram): chat 页气泡镜像 + 信息源 popup 弹层
caf0520  fix(launch): 替换 docs 协议 URL 占位符
1767d04  docs(launch): PRD — 上线前 UI 改动
3df5cc3  fix(legal): 替换邮箱占位符 → mark_tang@163.com
1142a10  fix(legal): gh-pages 同步 master 邮箱替换
```

**前序 (P10)**:
```
3c870d6  docs(state): P11 上线前 UI 改动
0854ed0  docs(launch): 同步 P10 完成状态
a05ff19  feat(miniprogram): chat UI 改进 - 去掉提问按钮 + 加新会话入口
61a01e6  fix(api): P10+ 真接 getClientIp undefined crash bugfix
```

## 2. P11.2 关键 bug 修复故事 (5 round)

| Round | Bug | 根因 | 修法 |
|---|---|---|---|
| 2 | + 号遮消息 (左上 fixed 跟 user 消息冲突) | user 消息靠右延伸到 + 号区域 | + 号挪到右上 (top: 200rpx) 跟 ⚙/🔍 垂直排 3 列 |
| 3 | settings 协议链接白屏 (web-view 跳 github.io) | 微信 web-view 需配业务域名 (memory `wechat_miniprogram_webview_gotcha.md`) | 改用 wx.setClipboardData + showModal 提示浏览器打开 |
| 4 | popup checkbox 点击无反应 | 微信响应式系统 wx:for 嵌套 + 三元表达式 + .indexOf 数组方法不重渲染 | **activeMap 派生 state 提到 data** + 用对象属性访问替代 .indexOf |
| 5 | popup checkbox 选中态 UI 不更新 (但 setData 成功) | 同 round 4 根因 | 同 round 4 修法 (activeMap 维护同步 selectedSourceTypes) |

**核心教训**: 微信小程序 wxml **嵌套三元表达式 + 数组方法调用 (.indexOf) 不一定触发重渲染**。**派生 state 提到 data 上** 是经典优化技巧。

## 3. 1.0.0 上传状态

| 阶段 | 状态 |
|---|---|
| 微信开发者工具上传 1.0.0 | ✅ done (2026-06-28 上午) |
| 公众平台 mp.weixin.qq.com 提交审核 | 🟡 **被备案提醒阻塞** |
| 公众平台操作 | 解除微搭低代码第三方授权后开发管理恢复 |
| 弹窗 | "**小程序备案提醒** - 你的小程序还未履行备案手续" |
| 用户决策 | 暂停提交审核, **先做 2.0 架构可行性分析** |

## 4. 2.0 架构可行性分析 (仅记录, 不执行)

**完整路线图**: `~/.claude/projects/-Users-Mark-cc-project-unequal/memory/project_unequal_2_0_architecture_roadmap.md`

### 5 候选方案

| 方案 | 月成本 | 国内可达 | 状态 |
|---|---|---|---|
| **A. 阿里云 ECS 免费试用** ⭐推荐 | ¥0 试用 3 个月 | ✅ | 待 P12+ 触发 |
| B. 阿里云函数计算 FC + OSS | ¥0-5/月 | ✅ | 待 P12+ 触发 |
| C. 华为云 HECS + OBS | ¥8-12/月 | ✅ | 待 P12+ 触发 |
| D. 腾讯云轻量 + 静态站 | ¥8-16/月 | ✅ | 仍是腾讯云 (用户顾虑) |
| E. 本地 + Tailscale VPN | ¥30/月 | ⚠️ 朋友需装客户端 | 不推荐 |

### §1 网络可达性硬 gate (2026-06-28 实测)

| 服务 | HTTP | 延迟 | 评估 |
|---|---|---|---|
| 腾讯云 | 200 | 0.09ms | ✅ |
| 阿里云 | 403 (需登录) | 0.04ms | ✅ |
| 华为云 | 302 (需登录) | 0.07ms | ✅ |
| 字节火山 | 200 | 0.32ms | ✅ |
| 百度智能云 | 200 | 0.21ms | ✅ |
| **Cloudflare** | 000 (timeout) | 5s+ | ❌ GFW 阻 |
| **Vercel** | 000 (timeout) | 8s+ | ❌ GFW 阻 |

→ **境外服务 (Cloudflare / Vercel / Render) 在国内不稳定, 朋友体验差**。

### 用户决策 (2026-06-28)

| 决策 | 选择 |
|---|---|
| 香港 vs 上海 | 倾向香港 (保留调国外 API 灵活性) |
| 立即迁移 | **否** (P12+ 触发才实施) |
| 微信备案 | **继续走** (打印承诺书 + 7-14 天工信部) |

## 5. 触发 2.0 实施的条件 (P12+)

任一发生启动 2.0:
1. 微信小程序备案失败 / 反复被打回
2. CloudBase 月费用持续 > ¥50 (1-2 个月观察)
3. 真用户开始用, 体验到 CloudBase 性能瓶颈
4. 产品验证期结束, 进入产品迭代期
5. 用户明确说「现在就开始迁移」

## 6. 当前阻塞 + 优先动作

| 阻塞 | 耗时 | 谁做 |
|---|---|---|
| 微信小程序备案 (打印承诺书 + 7-14 天工信部) | 7-14 天 + 30 min 打印 | 用户 |
| 2.0 架构迁移 | 半天-1 天 (4-8 h) | 待 P12+ 触发 |

**当前优先**: 微信小程序备案 (用户下午打印承诺书, 上传)

## 7. 关键文件位置

- **PRD**: `.claude/prds/launch-ui-mirror-and-source-popup.prd.md`
- **Plan**: `.claude/plans/launch-ui-mirror-and-source-popup.plan.md` (gitignored, 本地)
- **State 文档**: `docs/superpowers/state-p11-miniprogram-ui-tweaks.md` (本文档)
- **真机截图**: `docs/launch/screenshots/01-05.png`
- **Memory** (P11 关键):
  - `~/.claude/projects/-Users-Mark-cc-project-unequal/memory/project_unequal_2_0_architecture_roadmap.md`
  - `~/.claude/projects/-Users-Mark-cc-project-unequal/memory/resolved_miniprogram_ui_tweaks.md`
  - `~/.claude/projects/-Users-Mark-cc-project-unequal/memory/wechat_miniprogram_webview_gotcha.md`
  - `~/.claude/projects/-Users-Mark-cc-project-unequal/memory/feedback_china_network_constraints.md`

## 8. 微信小程序提审填写字段 (备案下来后)

### 必填项
- **服务类目**: 生活服务 → 母婴
- **标签**: 育儿, 母婴, 辅食, 早教, 问答
- **简介 (A 套)**: "家长经验驱动的育儿问答助手, 每条回答标注引用来源, 拒绝 AI 幻觉" (28 字)
- **页面截图**: 5 张 (在 docs/launch/screenshots/)
- **用户协议 URL**: https://marktang1208.github.io/unequal/
- **隐私政策 URL**: https://marktang1208.github.io/unequal/privacy.html

### 备注 (写给审核员)
```
本小程序为家长提供育儿问答服务, 基于用户上传/抓取的个人育儿知识库
进行检索增强生成, 每条回答附带原文引用卡片。

核心功能:
1. 一对一问答 (chat 页, 含引用卡片)
2. 历史问答记录
3. 引用原文详情查看
4. 用户设置 (user_id 显示, 信息源筛选, 协议链接)

技术: 微信云开发 (CloudBase) + 微信小程序, 不涉及支付/位置/通讯录/广告,
不收集个人敏感信息。

个人主体可用类目: 生活服务 - 母婴。

UI 设计: chat 页采用差异化左右镜像布局 (user 消息靠左 / assistant 消息靠右),
便于家长快速识别自己提的问题与 AI 回答。
```

### 测试账号
填「无」(个人主体无需登录)

## 9. 完整 commit 链 (今日累计)

```
master 分支 (14 commit):
bebc8ae2 docs(launch): 重截 05-source-popup-open.png
9754d31d fix(miniprogram): popup checkbox 选中态 UI 不更新 (activeMap)
36db5a18 fix(miniprogram): wx.showToast 强制可见
c8b144ce fix(miniprogram): popup 加 debug button
3b352ed1 fix(miniprogram): popup checkbox 点击无反应排查
e066d99f fix(miniprogram): webview 白屏修复
5362a47e fix(miniprogram): settings 协议改用 clipboard
dae3ad53 fix(miniprogram): + 号挪到右上
5f35fe6e docs(launch): 更新 P11 milestone — T8 完成
a6ba87e5 feat(miniprogram): chat 页气泡镜像 + popup 弹层
caf0520  fix(launch): 替换 docs 协议 URL 占位符
1767d04  docs(launch): PRD
3c870d6  docs(state): P11 完整收尾
10405e4  docs(launch): 更新 P11 milestone

gh-pages 分支 (1 commit):
1142a10 fix(legal): gh-pages 同步 master 邮箱替换
```

**测试**: 49/49 单测 PASS + 0 typecheck 错 + gh-pages 含 mark_tang@163.com

## 10. 已知限制 (P12+ 改进)

### 不阻塞上线
- 1966 chunks 实际只有 ~3 条真育儿 → "未涉及" 率 ~80%
- NLI cold-start race (35.3% success rate) → SDK 临时 URL 问题
- chat 跨轮 session 复用 bug (P10 真接发现, 不阻塞单 query)
- 微信 web-view 跳外链 (用 clipboard 退路)

### P12+ 改进
- 加真育儿 corpus (公开公众号/网站 ingest 5-10K chunks)
- 修 NLI cold-start race
- 修 chat 跨轮 session 复用
- 配 web-view 合法域名 (1.0.1 优化)
- 监控 + 日志平台
- chat UX streaming 整合
- P13: 本地推理 (OMLX Qwen3-4B)
- 2.0 架构迁移 (触发条件: 见 §5)

## 11. 关联

- **state-p10**: `docs/superpowers/state-p10-miniprogram-real-deploy.md` (P10 5 路径 PASS)
- **state-miniprogram-pre-launch**: `docs/superpowers/state-miniprogram-pre-launch.md` (上线前 checklist)
- **launch README**: `docs/launch/README.md` (4 步执行清单)
- **PRD**: `.claude/prds/launch-ui-mirror-and-source-popup.prd.md`

## 12. 回滚路径

| 阶段 | 命令 |
|---|---|
| 前端回滚 (P11 全) | `git revert 10405e4..bebc8ae2` + 微信开发者工具重编译 |
| 后端不动 | P11 全是前端改动 |
| 取消 CloudBase | 启动 2.0 迁移流程 (见 §5 触发条件) |
| 微信小程序下架 | 微信公众平台 → 设置 → 暂停服务 |

---

*文档状态: 今日收工收口. 下次会话直接从此处接上.*
