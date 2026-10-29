# One image for the API server, the worker and the one-shot migration job.
FROM node:22-slim AS base
WORKDIR /app
ENV NODE_ENV=production

COPY packages/engine/package.json packages/engine/package-lock.json packages/engine/
COPY packages/db/package.json packages/db/package-lock.json packages/db/
RUN npm ci --prefix packages/engine --include=dev && npm ci --prefix packages/db

COPY packages/engine packages/engine
COPY packages/db packages/db

WORKDIR /app/packages/engine
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["npx", "tsx", "src/server/server.ts"]
