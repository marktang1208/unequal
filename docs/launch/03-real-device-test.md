# 真机测试 5 路径执行脚本

> 目的: 在提交审核前, 在真机上走通 5 个核心路径, 确保发布后用户能用。
> 工具: 微信开发者工具 + 微信 (手机) + Mac
> 预计耗时: 1-2 小时 (含排查)

---

## 0. 准备 (10 分钟)

### 0.1 打开微信开发者工具

```bash
# 微信开发者工具安装 (如果还没装)
# https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html

open -a "微信开发者工具"
```

### 0.2 导入项目

| 步骤 | 操作 |
|---|---|
| 1 | 左侧「小程序」→ 右下角「+」→「导入项目」 |
| 2 | 项目目录: `/Users/Mark/cc_project/unequal/apps/miniprogram` |
| 3 | AppID: `wxf5b8ce05a977f0c6` (自动填) |
| 4 | 项目名称: `育儿不等号` |
| 5 | 后端服务: ✅ 勾选「微信云开发」 |
| 6 | 点「导入」→ 编译 30s-1min |

### 0.3 关键配置确认

`project.config.json`:
- `appid`: `wxf5b8ce05a977f0c6` ✅
- `setting.urlCheck`: `false` (真机调试不校验域名) ✅
- `compileType`: `miniprogram` ✅

`app.json`:
- 5 个页面注册 ✅
- tabBar 显示「问答」+「历史」✅

### 0.4 真机扫码

1. 微信开发者工具右上角 → 「真机调试」
2. 选择「自动预览」
3. 弹出二维码 → 微信扫码
4. 手机端打开小程序（开发版）

---

## 1. 路径 1: 冷启动 (5 分钟)

### 1.1 操作

1. 杀掉微信进程, 重新打开
2. 点击「育儿不等号」小程序入口
3. 观察首屏

### 1.2 预期

| 项 | 预期 |
|---|---|
| 首屏 | chat 页面, 空状态 (无消息) |
| tabBar | 显示「问答」+「历史」2 个 tab |
| 顶部导航 | 标题「育儿不等号」 |
| 输入框 | 底部固定, 有 placeholder |
| source picker | 输入框上方, 4-6 个 source 类型 chip |
| 加载时长 | < 2 秒 |

### 1.3 验证 console log

**手机端**:
- 微信右上角「...」→ 「打开调试」→ 「移动调试」→ vConsole

**预期看到**:
```
[unequal] wx.cloud.init ok, env: unequal-d4ggf7rwg82e0900b
[unequal] ensureJwt ok, user_id: 01K...
```

### 1.4 失败信号

| 现象 | 排查 |
|---|---|
| 一直白屏 | 看 vConsole 报 "wx.cloud.callFunction failed" → envId 错 |
| 报"网络错误" | 看 auth.ts ensureJwt, JWT 没拿到 |
| tabBar 不显示 | app.json tabBar.list 缺项 |
| 标题错 | app.json window.navigationBarTitleText 缺 |

### ✅ Pass 标准
- [ ] 首屏 2 秒内加载
- [ ] tabBar 显示
- [ ] vConsole 看到两条 log

---

## 2. 路径 2: chat 短问 (5-10 分钟)

### 2.1 操作

1. 在输入框输入: `宝宝几个月可以吃辅食`
2. 点发送
3. 观察 spinner 和回答

### 2.2 预期 (基于 P9 follow-up #13 修后)

| 阶段 | 时长 | 现象 |
|---|---|---|
| spinner | 3-5s | "正在思考…" |
| LLM 回答 | 15-25s | 出现文本回答 + 引用卡片 |
| 引用卡片 | 0-5 条 | 标题 + 摘要 + 原文链接 |
| 总耗时 | < 30s | 从发送到全部显示 |

### 2.3 预期回答内容

LLM 应该返:
- 详细辅食月龄建议（6 个月起, 看具体信号）
- 引用 0-5 条
- 不应该是 "未涉及"

### 2.4 失败信号

| 现象 | 排查 |
|---|---|
| spinner 不消失 (>30s) | polling 5 次都失败, 看 pollNliResult log |
| 报"未涉及" | corpus 内容问题, 换 query 或接受 |
| 报"网络错误" | JWT 问题, 重启小程序 |
| 报"404" | cloud-call.ts:86 name: "api-router" |
| 报"500" | 后端 audit_log 有堆栈, 看 NLI provider |

### ✅ Pass 标准
- [ ] 30s 内有回答
- [ ] 出现至少 1 个引用卡片
- [ ] 内容是合理育儿建议

---

## 3. 路径 3: chat 跨轮 (3-5 分钟)

### 3.1 操作

1. 紧接路径 2, 继续输入: `那吃什么比较好`
2. 点发送
3. 观察回答 + session 状态

### 3.2 预期

| 阶段 | 时长 | 现象 |
|---|---|---|
| spinner | 1-3s | 复用 session, warm cache |
| 回答 | 5-10s | 围绕辅食食材 |
| sessionId | 不变 | 历史 tab 看到同一 session |

### 3.3 验证

- 切到「历史」tab
- 应该看到 1 个 session, 2 问 2 答

### 3.4 失败信号

| 现象 | 排查 |
|---|---|
| 报"session not found" | chat-storage.ts sessionId 持久化 |
| session 变 2 个 | sessionId 没传, 每次新开 |

### ✅ Pass 标准
- [ ] 10s 内有回答
- [ ] 历史 tab 看到 1 个 session + 2 问 2 答

---

## 4. 路径 4: 历史 sessions tab (2 分钟)

### 4.1 操作

1. 点底部 tabBar「历史」
2. 滚动查看列表

### 4.2 预期

- 看到刚才的 session
- 显示: user_id (前 8 位) + 消息数 (2) + 时间
- 点击进入能看到完整问答

### 4.3 失败信号

| 现象 | 排查 |
|---|---|
| 列表空白 | /api-sessions 失败, JWT 问题 |
| 看到「暂无记录」 | session 没入库, 看 audit_log |
| 列表卡死 | N+1 查询或分页问题 |

### ✅ Pass 标准
- [ ] 看到至少 1 个 session
- [ ] 时间/消息数正确
- [ ] 点击能进入详情

---

## 5. 路径 5: settings 页 (2 分钟)

### 5.1 操作

1. 切到「问答」tab
2. 点右上角菜单 (三个点 或 ⚙ 图标)
3. 选「设置」
4. 查看页面

### 5.2 预期

| 项 | 内容 |
|---|---|
| user_id | OpenID 派生 (例: `01KVCZ2JRB...`) |
| source 过滤 | 4-6 个 chip (文件/网页/...) |
| 链接 | 用户协议 / 隐私政策 (填了 URL 后才显示) |

### 5.3 失败信号

| 现象 | 排查 |
|---|---|
| user_id 空 | /api-auth-me 失败 |
| settings 页空白 | navigateTo 路径错 |
| 协议链接 404 | 还没部署 GitHub Pages |

### ✅ Pass 标准
- [ ] user_id 显示
- [ ] source 过滤 chip 可点
- [ ] 协议链接可点 (可选, 不阻塞)

---

## 6. 整体回归 checklist

完成 5 路径后, 整体验收:

- [ ] 5 路径全部 ✅
- [ ] vConsole 无 error
- [ ] audit_log 后端有 5+ 条记录 (chat + sessions + auth-me)
- [ ] 退出小程序再进, 状态保留 (sessionId, JWT)
- [ ] 切后台 1 分钟再回前台, 不卡顿

---

## 7. 失败排查快速参考

| 现象 | 第一动作 |
|---|---|
| 任何路径 fail | 看 vConsole `[unequal]` 开头的 log |
| 报"未涉及" | corpus 限制, 改 query 试 |
| 报"网络错误" | 重启小程序, 看 ensureJwt log |
| spinner 不消失 | vConsole 看 pollNliResult 调用次数 |
| tabBar 缺 | app.json 配置问题, 重新编译 |
| 报"404" | 检查 cloud-call.ts:86 name |
| 后端 500 | 看 `cloud function log` (CloudBase 控制台) |

---

## 8. 全部通过后

1. **截图 5 张** (按 `01-submission-materials.md` §5)
2. **退出真机调试**
3. 进入提审流程 (见 `03-submit-review.md`)

---

## 9. 阻塞时

如果某路径怎么都过不了, 走降级:
- 路径 1-3 必过 (核心)
- 路径 4-5 可降级 (体验优化)
- 提审时备注清楚哪些路径有 workaround
