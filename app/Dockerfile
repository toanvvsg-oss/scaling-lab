FROM node:24-alpine
WORKDIR /app
COPY package.json server.mjs prestop.mjs ./
USER node
EXPOSE 3000
CMD ["node", "server.mjs"]
