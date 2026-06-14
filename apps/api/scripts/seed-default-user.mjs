// 用法：node scripts/seed-default-user.mjs
// 写一个固定的 default user，id 是 "01H0000000000000000000000"（MVP 阶段 admin 写死用这个 id）
//
// 注意：M0+M1 阶段不实际调用此脚本。它是占位符，依赖 ulid 包（Task 8 时再装）。
// 真实的 /seed-user 路由也在 Task 8 实现。
import { ulid } from "ulid";

const DEFAULT_USER_ID = "01H0000000000000000000000";

const result = await fetch("http://127.0.0.1:8787/seed-user", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ id: DEFAULT_USER_ID, nickname: "default" }),
});
console.log(result.status, await result.text());
