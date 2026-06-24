# P0-#1 ADMIN_IP_ALLOWLIST 修 CIDR — design

> 日期: 2026-06-24
> 前置: [state-m7-d.md §6.1](../state-m7-d.md) — M7-D 真机 verify 发现 IP allowlist 阻断 admin 真接
> 状态: 📋 design 待用户 review

> ⚠️ **2026-06-24 spec 修订**: 原文 §2 根因段"CloudBase allowlist 支持 CIDR" 是**误判** — 真实 IP 校验在 `apps/api/src/lib/admin-ip-allowlist.ts` 里做（`isAdminIpAllowed` = `string.includes`），**不支持 CIDR**。本次修复需改 helper 函数 + 加单测 + 改 env 值。已确认方向：B 方案 (支持 CIDR)。

## 1. TL;DR

M7-D 真机端到端 verify 时发现：用户家庭 IP `***REMOVED***.46`（深圳电信 AS4134 CHINANET）不在 `ADMIN_IP_ALLOWLIST` 内，**admin 真接 100% 失败（IP_NOT_ALLOWED）**。minipgm 真机走 user jwt 走通，不受影响；但任何 admin 端真接（CP-7 真接 step 1-6 / P5 NLI step 2-6 / 后续 ARCH-V2.4 / M3-D 真接）都被同一道墙挡住。

**修复**: 两层改动 —
1. **代码层**: `apps/api/src/lib/admin-ip-allowlist.ts` 加 CIDR 范围匹配 (detect `/` → mask & 比较)
2. **数据层**: `ADMIN_IP_ALLOWLIST` 从单 IP 列表改为 CIDR `***REMOVED***.0/24`

一次性覆盖家庭同 ISP 同子网内漂移范围，删两个半年前失效的老单 IP。

| 维度 | 现状 | 修后 |
|---|---|---|
| allowlist 值 | `240e:3b4:38ed:4100:10a1:f77f:f362:d8b0,113.116.119.197` | `***REMOVED***.0/24` |
| IP 校验 | `isAdminIpAllowed` string equality | 加 CIDR 范围匹配 |
| 覆盖 IP 数 | 2 | 254 |
| 鉴权机制 | 不变 (IP 鉴权 + ADMIN_TOKEN) | 不变 |
| admin 真接 200/401 | 100% 403 (IP_NOT_ALLOWED) | 200 (本子网) / 403 (其他) |
| 维护复杂度 | IP 漂移一次改一次 | 一次性 /24 段 |
| Rollback | 5 min (从 `deploy:status` 拿旧值) | 同 |

## 2. 根因

**IP 漂移是 ISP 网络层常态，不是异常**。M7-D 真接时的家庭 IP `***REMOVED***.46` 是中国电信家庭宽带 C 段地址，与 allowlist 中两个老 entry 完全不同：
- `240e:3b4:...:d8b0` (IPv6，半年前 entry) — 用户 IP 不再是 IPv6 或地址变了
- `113.116.119.197` (IPv4) — 应该是早期公司 IP 或异地家宽 IP

**半年前 entry 不会"自动过期"**。CloudBase allowlist 没有 TTL 机制，靠手动维护。结果就是"假安全" — admin 接口"看起来"被保护，实际信任了一堆失效 IP + 阻断了当前真接。

**CloudBase allowlist 实际是 process.env，IP 匹配在 `apps/api/src/lib/admin-ip-allowlist.ts` 函数里做**（`isAdminIpAllowed` = `string.includes`），**目前不支持 CIDR**。本次修复需同时改 helper 函数（这是 spec 修订点）。

## 3. 改动清单

4 处代码改动 + 1 个 Keychain 写入 + 1 次 deploy + 1 次真接验证。

### 3.0 `apps/api/src/lib/admin-ip-allowlist.ts`（核心 ~30 行）

**改 `isAdminIpAllowed`** 支持 CIDR 范围匹配：

```typescript
export function isAdminIpAllowed(clientIp: string, allowlist: string[]): boolean {
  for (const entry of allowlist) {
    if (entry === clientIp) return true;             // 单 IP 精确匹配 (旧行为)
    if (entry.includes("/") && isCidrMatch(clientIp, entry)) return true;  // CIDR 范围匹配
  }
  return false;
}

/** IPv4 CIDR 匹配: ***REMOVED***.46 in ***REMOVED***.0/24 = true */
export function isCidrMatch(ip: string, cidr: string): boolean {
  const [range, bitsStr] = cidr.split("/");
  const bits = parseInt(bitsStr, 10);
  if (!range || isNaN(bits)) return false;
  if (bits < 0 || bits > 32) return false;
  if (ip.includes(":")) return false;  // IPv4 only 本次; IPv6 CIDR 留作未来
  const ipNum = ipToNumber(ip);
  const rangeNum = ipToNumber(range);
  if (ipNum === null || rangeNum === null) return false;
  if (bits === 0) return true;
  const mask = (~0 << (32 - bits)) >>> 0;
  return (ipNum & mask) === (rangeNum & mask);
}

function ipToNumber(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const v = parseInt(p, 10);
    if (isNaN(v) || v < 0 || v > 255) return null;
    n = (n * 256) + v;
  }
  return n;
}
```

边界：
- IPv6 CIDR 暂不支持（spec 显式拒绝，留作未来 candidate）
- bits=0 (匹配所有 IPv4) 显式允许，边界清晰
- bits=32 等价单 IP，路径走 `entry === clientIp` 不走 CIDR

### 3.0.1 `apps/api/test/lib/admin-ip-allowlist.test.ts`（新增或扩 ~12 用例）

| # | 名称 | 期望 |
|---|---|---|
| 1 | 单 IP 精确匹配（回归测试） | true |
| 2 | IPv4 在 /24 CIDR 范围内 | true |
| 3 | IPv4 在 /24 CIDR 范围外 | false |
| 4 | IPv4 在 /32 CIDR 范围内（=单 IP） | true |
| 5 | IPv4 在 /16 CIDR 范围内（深圳电信大段） | true |
| 6 | bits=0 匹配所有 IPv4 | true |
| 7 | bits=33 非法 → false | false |
| 8 | CIDR 格式错误（无 /）→ 走精确匹配（向后兼容） | 取决于是否相等 |
| 9 | IPv6 CIDR 暂不支持 → false | false |
| 10 | 空 allowlist → false | false |
| 11 | 混合 allowlist（单 IP + CIDR）OR 语义 | true if 任一匹配 |
| 12 | IPv4 格式错误（5 段）→ false | false |

### 3.1 `apps/api/scripts/deploy/commands/push.ts`（3 行注释）

在 `SECRETS` 数组 `ADMIN_IP_ALLOWLIST` 上方加注释，说明推荐 CIDR 格式：

```typescript
/** 7 个 secrets（顺序敏感，IP allowlist 是 config 不是 key）
 *  ADMIN_IP_ALLOWLIST 推荐 CIDR 格式（如 ***REMOVED***.0/24），
 *  避免 IP 漂移时反复更新。CloudBase 支持多 CIDR 逗号分隔。
 */
const SECRETS = [
  "ADMIN_TOKEN",
  "JWT_SECRET",
  ...
  "ADMIN_IP_ALLOWLIST",
  ...
] as const;
```

### 3.4 Keychain 写入（不入 git）

§6.1 加修订小节，§8 P4 候选 #2 标"✅ 完成 (2026-06-24)"。见 §6。

### 3.4 Keychain 写入（不入 git）

```bash
security update-generic-password \
  -s "unequal:api-router:ADMIN_IP_ALLOWLIST" \
  -a "unequal-deploy" \
  -w "***REMOVED***.0/24"
```

### 3.5 `docs/superpowers/state-m7-d.md`（~15 行）

§6.1 加修订小节，§8 P4 候选 #2 标"✅ 完成 (2026-06-24)"。见 §6。

### 3.6 部署（不入 git）

```bash
cd /Users/Mark/cc_project/unequal
pnpm -F api deploy:push
```

走 P4 pipeline（Keychain → /tmp 临时 config → tcb config update fn Merge 模式 → diff + KEK 漂移检查 → audit_log）。生产其他 19 vars 保留（Merge 模式），仅 ADMIN_IP_ALLOWLIST 值变更。

预期 deploy 日志：
```
[push] ✓ before: 20 vars from remote (audit_log)
[push] ✓ 7 secrets loaded
[push] ✓ tmp config: /tmp/unequal-deploy-XXX/cloudbaserc.json
[push] ✓ tcb config update fn 成功
[push] ✓ diff: +0 -0 ~1 | warnings: 0
[push] ✓ audit_log written (action=deploy mode=merge)
```

## 4. 真接验收（3 步，必跑）

```bash
# Step 1: 确认云端值已更新
pnpm -F api deploy:status
# 预期: ADMIN_IP_ALLOWLIST = "***REMOVED***.0/24"

# Step 2: 拿 admin JWT
ADMIN_JWT=$(curl -s -X POST \
  "https://unequal-d4ggf7rwg82e0900b-1444590671.ap-shanghai.app.tcloudbase.com/api-auth-admin-login" \
  -H "Content-Type: application/json" \
  -d '{"token":"***REMOVED***"}' \
  | jq -r .jwt)
# 预期: jwt=eyJ...

# Step 3: 调 /api-auth-me
curl -s \
  "https://unequal-d4ggf7rwg82e0900b-1444590671.ap-shanghai.app.tcloudbase.com/api-auth-me" \
  -H "Authorization: Bearer $ADMIN_JWT"
# 预期: 200 + user info (admin user_id "01H0000..." + is_admin context)
# 不再是 401 IP_NOT_ALLOWED
```

## 5. Rollback（5 min）

如果改完 admin login 仍失败（极小概率，可能子网算错）：

```bash
# 拿回旧值
pnpm -F api deploy:status | grep ADMIN_IP_ALLOWLIST

# 重写 Keychain
security update-generic-password \
  -s "unequal:api-router:ADMIN_IP_ALLOWLIST" \
  -a "unequal-deploy" \
  -w "240e:3b4:38ed:4100:10a1:f77f:f362:d8b0,113.116.119.197"

# 推回
pnpm -F api deploy:push
```

## 6. state-m7-d.md 修订

§6.1 后加：

```markdown
### 6.1.1 修订 (2026-06-24): ADMIN_IP_ALLOWLIST 修 CIDR ✅

**问题**: M7-D 真机端到端 verify 时发现 admin 真接 100% 失败，user IP `***REMOVED***.46`
（深圳电信 AS4134 CHINANET）不在 allowlist 内。minipgm 真机走 user jwt 走通不受影响，
但 admin 端任何真接（CP-7 / P5 NLI / ARCH-V2.4 / M3-D）都失败。

**根因**: 现状 allowlist 是 `240e:3b4:...:d8b0,113.116.119.197` 两个单 IP，
是半年前 entry。家庭 IP 漂移后失效，CloudBase allowlist 无 TTL 机制，半年前 entry
不会"自动过期"，结果就是"假安全"。

**修复**:
- `ADMIN_IP_ALLOWLIST` 改 CIDR `***REMOVED***.0/24`（深圳电信家庭 C 段，254 个 IP）
- 删两个老单 IP
- 走 `pnpm -F api deploy push`（P4 pipeline），保留 audit log

**教训**:
1. **家庭 admin IP 鉴权应该用 CIDR 不用单 IP** — 漂移是常态不是异常
2. **老的单 IP entry 不会"自动过期"** — 半年没动 = 假安全
3. **IP 鉴权代码层而非 CloudBase 网关层** — 之前误以为是 CloudBase 做 allowlist，实际是 `lib/admin-ip-allowlist.ts` 函数。这是个架构 lesson
4. **设计 helper 时保留扩展点** — 现有 `isAdminIpAllowed` 用 `string.includes` 是最小实现，但留了扩展成 CIDR 的位置（拆分 entry 处理）
5. **真接需要 verify admin login 真的能走通** — 之前 CP-7-B 真接走了 user jwt path 没暴露，
   M7-D 真机走 user jwt 走通但 admin path 没人验。M7-D 教训"admin 端没真接验证"
   这次落地。
```

§8 P4 候选表 #2 标：

```diff
- 2. deploy 流程重写 — 修 env vars 覆盖问题；新增 tcb config diff 验证步骤
+ 2. ~~deploy 流程重写~~ — P4 #2 (commit 3466258 / 3dcd430 / 98cbbbd / fed4b1e / 9950196) 已闭环，
+   本次 (2026-06-24) 仅修 IP allowlist 单点
```

## 7. 不动的东西

- ✅ ADMIN_TOKEN 鉴权机制不变（不是改鉴权策略）
- ✅ `apps/api/src/handlers/api-auth-admin-login.ts` IP 校验代码不变（仍调用 isAdminIpAllowed，helper 内部升级）
- ✅ P4 deploy pipeline 代码不变（直接复用）
- ✅ Keychain 其他 6 secrets 不变
- ✅ 19 个其他 env vars 不变（Merge 模式只改 ADMIN_IP_ALLOWLIST）
- ✅ minipgm 端不变（user jwt 走通，无影响）

## 8. 测试

**新增 12 个单测**（`apps/api/test/lib/admin-ip-allowlist.test.ts`），覆盖：
- 旧行为回归（单 IP 精确匹配）
- CIDR 各 bits（/24, /32, /16, /0）
- 边界（bits 非法 / IPv6 CIDR / 格式错误）
- 混合 allowlist OR 语义
- IPv4 解析容错

**真接验收**（§4 3 步）。PASS 即闭环。

**长期监控**（可选，1 周后看）：
```bash
# audit_log 查 IP_NOT_ALLOWED 记录
tcb db nosql execute --command '[{"TableName":"audit_log","CommandType":"QUERY","Command":"{\"find\":\"audit_log\",\"filter\":{\"action\":\"login_attempt\",\"result\":\"denied\",\"reason\":\"ip_not_allowed\"},\"sort\":{\"timestamp\":-1},\"limit\":10}"}]'
```

如果有新 IP_NOT_ALLOWED = 子网算小了，需要再扩 CIDR（例如 `/16`）。

## 9. 工时 / 风险

| 维度 | 数值 |
|---|---|
| 写单测 (12 cases) | ~30 min |
| 改 helper 函数 | ~20 min |
| 改 cloudbaserc + push.ts 注释 | ~5 min |
| Keychain 写 + 部署 + 真接 | ~10 min |
| **总计** | **~1-1.5 hr** |
| 风险 | 低（rollback 5 min） |
| 阻塞解除范围 | 全部 admin 真接链路（CP-7 / P5 NLI / ARCH-V2.4 / M3-D） |

## 10. 后续候选（独立 brainstorm，本 spec 不做）

- **鉴权策略现代化**：TOTP / 个人短期 JWT / 临时白名单机制（不限网络环境）
- **IPv6 CIDR 支持**：helper 现在 IPv6 CIDR 显式拒绝，未来需支持时加
- **audit_log 自动告警**：N 次 IP_NOT_ALLOWED 触发 webhook（家庭漂移早期预警）
- **helper CIDR 解析提取到 packages/shared**：admin allowlist 当前仅 api 用，未来 crawler / admin / minipgm 都用则下放

## 11. References

- [state-m7-d.md §6.1](../state-m7-d.md) — IP allowlist 问题首次发现
- [state-p4-deploy-pipeline.md](../state-p4-deploy-pipeline.md) — P4 pipeline 设计
- [state-p4-secrets-manager.md](../state-p4-secrets-manager.md) — Keychain 写入规范
- [state-arch-v2.4.md §1](../state-arch-v2.4.md) — 验证 admin 真接是 ARCH-V2.4 实施前置
- [state-m6-10](../state-m6-10.md) — admin allowlist v0 设计（string equality）
- `apps/api/src/lib/admin-ip-allowlist.ts` — 当前 helper（待升级 CIDR）
- `apps/api/src/lib/auth-admin.ts:115` + `apps/api/src/handlers/api-auth-admin-login.ts:70` — isAdminIpAllowed 调用点
- CloudBase allowlist 文档: 接受 CIDR 格式（`x.x.x.x/n`），多值逗号分隔
