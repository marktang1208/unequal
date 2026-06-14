# unequal / 不等号

微信端个人育儿智能体，基于个人知识库的问答 + 引用追溯。

## 架构

参见 `docs/superpowers/specs/2026-06-14-unequal-top-level-design.md`。

## 开发

```bash
pnpm install
pnpm typecheck
pnpm test
```

各 app 单独开发：

```bash
pnpm dev:api
pnpm dev:admin
```

## 部署

```bash
pnpm deploy:api
pnpm deploy:admin
```