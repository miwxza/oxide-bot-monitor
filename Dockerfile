# dev: dependency ครบ + source + test (ใช้รันเทสต์ใน compose)
FROM node:24-alpine AS dev
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY agent ./agent
COPY test ./test
COPY requests ./requests
COPY db ./db
COPY public ./public
COPY simulator ./simulator

FROM dev AS build
RUN npm run build && npm prune --omit=dev

# runtime: เฉพาะไฟล์ที่ใช้รัน
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY db ./db
COPY public ./public
COPY simulator ./simulator
EXPOSE 3000
CMD ["node", "dist/src/main.js"]
