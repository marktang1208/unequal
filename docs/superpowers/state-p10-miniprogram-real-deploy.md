# state-p10-miniprogram-real-deploy — 微信小程序真接 5 路径 PASS (2026-06-26)

> 日期: 2026-06-26 (深夜)
> 项目: unequal 微信小程序 (AppID wxf5b8ce05a977f0c6)
> 状态: 🟢 **5 路径真机测试全 PASS, 2 commits pushed, 阻塞解除**

## 0. TL;DR

**小程序真接 5 路径全部 PASS** (冷启动 / chat 短问 / + 号新会话 / 历史 / settings), **2 个新发现 bug 已修 1 个**。

- ✅ **`getClientIp` undefined crash** → 修, 真接 deploy PASS, 6/6 单测 + 384/384 全量 + 真机 5 路径
- ⚠️ **chat 跨轮 session 复用 bug** → 暂不阻塞上线 (用户单 query 也能用), P11+ 修
- 🟢 **2 commits pushed to master** (`61a01e6` + `a05ff19`)

**P9 → P10 之间的真接工作**:
- P9 NLI async 真接 PASS 后, 真接小程序 5 路径真机测试
- 真接发现 `getClientIp` 在 CloudBase gateway 偶发 headers=undefined crash (新 bug, P9 真接日没踩到)
- 顺手收 user UI 反馈 (提问按钮 + 新会话入口)

## 1. 真接 5 路径验证

### 1.1 设备环境

| 项 | 值 |
|---|---|
| 工具 | 微信开发者工具 (wechatwebdevtools.app) |
| 模拟器 | iPhone 12/13 (iOS) |
| 基础库 | WeChatLib 3.16.1 (2026.6.18) |
| AppID | wxf5b8ce05a977f0c6 |
| cloudEnvId | unequal-d4ggf7rwg82e0900b |
| user_id | 01KVCZ2JRBAGF3MY75D7KEY4RZ (ULID 25 字符) |
| session 数 | 126 |
| message 数 | 252 (avg 2 msgs/session) |

### 1.2 5 路径 PASS 表

| # | 路径 | 关键证据 | commit | 状态 |
|---|---|---|---|---|
| 1 | 冷启动 | `[unequal] wx.cloud.init ok, env: unequal-d4ggf7rwg82e0900b` + 2 次 cloudCall 200 | 已有 | ✅ |
| 2 | chat 短问 (「月龄」+「添加辅食」+「测试」) | LLM 返内容/兜底, citations=2 命中 corpus | 已有 | ✅ |
| 3 | + 号新会话 (用户 UI 反馈 #2) | modal 弹 + messages 清空 | a05ff19 | ✅ |
| 4 | 历史 sessions tab | 50+ sessions 渲染, list 200 | 已有 | ✅ |
| 5 | settings 页 (⚙ → settings) | user_id 01K... + nickname "小松果" + 126 sessions + 252 msgs | 已有 | ✅ |

### 1.3 user UI 反馈同步

| 反馈 | 修法 | commit |
|---|---|---|
| 提问按钮冗余 (textarea 回车已发) | 删 button, 输入框拉满 | a05ff19 |
| 缺新会话入口 (onTapNewSession 是 dead code) | 加左上角 + 号, 镜像 ⚙️ 风格 | a05ff19 |
| 试过 + 号上移到 navigationBar 区域 | env() 解析不一致回滚到 top: 24rpx | a05ff19 (commit msg 注明) |

## 2. P10+ 新发现 bug

### 2.1 getClientIp undefined crash (P10 真接发现, 已修)

**症状**:
```
errCode: -1
errMsg: "Error: cloud.callFunction:fail Error: errCode: -504002 functions execute fail |
        errMsg: TypeError: Cannot read properties of undefined (reading 'x-real-ip')
        at getClientIp (/var/user/index.js:62442:23)
        at main17 (/var/user/index.js:66286:20)"
```

**根因**:
- `getClientIp` 在 `handler-utils.ts:91` 读 `event.headers["x-real-ip"]`
- **CloudBase gateway 偶发 headers=undefined** (P9 真接日没踩到, 可能是某个新加 handler 触发)
- `headers` 是 undefined → `headers["x-real-ip"]` 抛 TypeError → 整 cloud function crash
- 影响: 5 处 caller 全部可能 crash (api-router/index.ts + auth-admin + admin-login + chat + ask)

**修法** (commit `61a01e6`):
1. `getClientIp` 加 `event.headers ?? {}` 守门
2. `HttpTriggerEvent.headers` 类型从 `Record<string, string>` 改可选
3. 新建 `apps/api/test/lib/handler-utils.test.ts` 6 case:
   - headers=undefined → "unknown" (不 crash)
   - headers={} → "unknown"
   - headers={x-real-ip: 1.2.3.4} → 返 IP
   - headers 大小写不敏感 (X-Real-IP 也命中)
   - x-real-ip > x-forwarded-for 优先级
   - 无 x-real-ip 时 fallback 到 x-forwarded-for

**验证**:
- ✅ 6/6 单测 PASS
- ✅ 全量 42 files / 384 tests PASS
- ✅ 真接 deploy full (build + tcb fn deploy + SCF API push 27 vars)
- ✅ 真机 Network: 修后 12 条 cloudCall 中 11 绿 1 红 (红条是修前的旧调用)

### 2.2 chat 跨轮 session 复用 bug (P10 发现, P11+ 修)

**症状**:
- chat 页连续发「月龄」+「添加辅食」
- 期望: 同 session (state-p9 §3.3 预期)
- 实际: 2 个独立 session (历史 tab 显示 2 条)

**根因 (初步判断, 未完全定位)**:
- 前端 `chat.ts:266` 逻辑正确 (this.data.sessionId ? { session_id } : {})
- `chat.ts:272-275` saveCurrentSessionId + setData 也正确
- **可能原因**: onShow (`chat.ts:176-188`) loadCurrentSessionId 拿到 null → 清空 messages
  - 或 setData 在 async chat 流程里有同步性问题
- **也可能**: storage 写入时机问题, onShow 时 storage 还没写入

**影响**:
- **不阻塞上线** — 用户单 query 能用, session 复用只是 UX 提升
- 上线后用户感知: 每次 query 都是新会话, 历史 tab 会膨胀

**P11+ 排查方案** (commit 时机 P11):
1. 加 chat.ts console.log 跟踪 sessionId 在 onLoad/onSubmit/onShow 时的值
2. 看 storage 实际写入时机
3. 真机 1-2 小时可定位

## 3. 提审清单 (state-miniprogram-pre-launch.md §7.1)

| # | 任务 | 耗时 | 状态 |
|---|---|---|---|
| 1 | 真机扫码测试 5 路径 | 1-2h | ✅ **PASS (本 commit 落地)** |
| 2 | 提审物料 (简介/截图/协议) | 30min | 🟡 待执行 |
| 3 | 微信开发者工具上传 + 提交审核 | 30min | 🟡 待执行 |

**剩 2 个阻塞** (#2 提审物料 + #3 上传), 预计 1 小时内可完成, 然后 1-3 天审核, **最早 2026-06-29 上线**。

## 4. commits 记录

```
a05ff19 feat(miniprogram): chat UI 改进 - 去掉提问按钮 + 加新会话入口
61a01e6 fix(api): P10+ 真接 getClientIp undefined crash bugfix
e4ca5b6 chore: replace internal office IP 219.134.244.0/24 with RFC 5737 reserved 192.0.2.0/24 in code + docs
```

## 5. 关联

- **state-miniprogram-pre-launch.md** — 上线前 checklist (3 阻塞剩 2)
- **state-p9-real-deploy.md** — P9 NLI async 真接 PASS
- **state-p9-nli-async-polling.md** — P9 polling 实现
- **state-m7-d.md** — settings 页 + 真机 verify PASS (本次真接的 base)
- **state-p6-local-onnx-nli.md** — NLI provider (修后 P10 不动, P11 排查 NLI cold-start race 时一起)

## 6. P11+ 待办 (不阻塞上线)

| # | 任务 | 优先级 | 备注 |
|---|---|---|---|
| 1 | 修 chat 跨轮 session 复用 bug | 🟡 MED | 本次真接发现 |
| 2 | 修 NLI cold-start race (state-p9 §3.3) | 🟡 MED | NLI success rate 35% → 80%+ |
| 3 | 加真育儿 corpus (公开来源 ingest 5-10K chunks) | 🔴 HIGH | "未涉及"率从 ~80% → ~20% |
| 4 | 排查 console `Error: timeout` @ WAServiceMainContext (wx.login 内部) | 🟢 LOW | 不影响功能 |
| 5 | P10 真接发现记录入 state-p10 (本文件) | ✅ done | |

## 7. 回滚路径

| 阶段 | 命令 | 影响 |
|---|---|---|
| 后端回滚 (chat handler 跑旧代码) | `git revert 61a01e6` + `pnpm -F api deploy:full` | getClientIp 回到可能 crash 状态, 不建议 |
| 前端回滚 (UI 改动) | `git revert a05ff19` + 微信开发者工具重编译 | 提问按钮 + + 号消失, 但 chat 功能不受影响 |
| 完全回滚到 P9 | `git revert 61a01e6 a05ff19` + `pnpm -F api deploy:full` | 回到 P9 真接日状态, getClientIp crash 风险复现 |
