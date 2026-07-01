# unequal api 服务镜像（Oracle Cloud 2.0 部署用）
#
# 设计目标：
# - 单镜像 (api server) 跑 Hono on Node 20
# - 数据层另起 pg 容器（不在此镜像内）
# - ARM64 兼容（Oracle Ampere A1）
# - 入口层改造：@hono/node-server 把 SCF event 风格转 Node http server
# - 启动期硬验证 (validateEmbeddingDim)
# - 保留 keep-alive 防冷启退 (setInterval 1s)
#
# 为什么不沿用 SCF bundle？
# - SCF main(event, context) 签名跟 Node http server (req, res) 不兼容
# - @hono/node-server 把 Hono app 直接 serve 成 Node http server (1 行代码)
# - 保留 setInterval 1s 是因为 keep-alive hack 跟 SCF 无关，对 bare Node 也有用
#   (Hono 自身不会自动 keep handle，需要 timer 维持)
#
# 构建上下文：项目根目录 (unequal/)

# 阶段 1：装依赖
FROM node:20-alpine AS deps
WORKDIR /app
RUN apk add --no-cache python3 make g++ libc6-compat
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/api/package.json ./apps/api/
COPY packages/shared/package.json ./packages/shared/
COPY packages/local-llm/package.json ./packages/local-llm/
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
RUN pnpm install --frozen-lockfile

# 阶段 2：编译
FROM deps AS build
WORKDIR /app
COPY apps/api/ ./apps/api/
COPY packages/ ./packages/
RUN pnpm -r --filter @unequal/api build
# esbuild bundle 到 dist/index.js
RUN pnpm -F @unequal/api exec esbuild apps/api/src/index.ts \
  --bundle --platform=node --target=node20 --format=esm \
  --outfile=apps/api/dist/index.js \
  --external:better-sqlite3 --external:onnxruntime-node

# 阶段 3：运行镜像
FROM node:20-alpine AS runtime
WORKDIR /app

# better-sqlite3 / onnxruntime-node 需要 native binary
RUN apk add --no-cache python3 make g++ libc6-compat
COPY --from=deps /app/node_modules/.pnpm ./node_modules/.pnpm
COPY --from=build /app/apps/api/dist ./dist
COPY --from=build /app/apps/api/package.json ./package.json
COPY --from=build /app/packages ./packages

# 非 root 用户
RUN addgroup -S app && adduser -S app -G app
USER app

# 健康检查
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:8080/health || exit 1

EXPOSE 8080

# 生产模式启动
ENV NODE_ENV=production
ENV PORT=8080
# 注：keep-alive setInterval 由代码内部启动 (apps/api/src/index.ts:69)
CMD ["node", "dist/index.js"]
