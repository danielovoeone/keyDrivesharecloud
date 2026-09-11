# KeyDrive 服务端镜像：node:22-alpine，体积小、免编译
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json server.js ./
COPY public ./public

# 数据目录（可用 Volume 挂载持久化）；必须归 node 用户所有，否则启动时无权限创建子目录
RUN mkdir -p /app/data && chown -R node:node /app/data

# 平台会注入 PORT，默认 3000
ENV PORT=3000
EXPOSE 3000

USER node
CMD ["node", "server.js"]
