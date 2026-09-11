# KeyDrive 服务端镜像：node:22-alpine，体积小、免编译
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json server.js ./
COPY public ./public

# 数据目录（可用 Volume 挂载持久化）
RUN mkdir -p /app/data
VOLUME ["/app/data"]

# 平台会注入 PORT，默认 3000
ENV PORT=3000
EXPOSE 3000

USER node
CMD ["node", "server.js"]
