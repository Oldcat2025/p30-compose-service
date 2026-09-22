FROM node:20-slim

# @napi-rs/canvas 是 Rust 预编译 native 模块，需要 glibc
# (slim 镜像已含 libc6/libstdc++6，无需额外装，保留此步以防未来需要)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libc6 libstdc++6 fonts-noto-core \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 先复制 package.json 装依赖（利用 Docker 层缓存）
COPY package.json ./
RUN npm install --production --no-audit --no-fund

# 复制代码 + 引擎 + 字体
COPY . .

# 引擎依赖路径环境变量化（fonts.js 的 ENGINE25_MODULES + opentype.js 路径）
ENV COMPOSE_NODE_MODULES=/app/node_modules
ENV COMPOSE_OPENTYPE_PATH=/app/node_modules/opentype.js
ENV COMPOSE_PORT=8200
ENV COMPOSE_HOST=0.0.0.0

EXPOSE 8200

# 健康检查
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get({host:'127.0.0.1',port:8200,path:'/v1/health',headers:{'X-Compose-Key':process.env.COMPOSE_KEY||''}},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "11-合版引擎服务-M1B1/compose-service.js"]
