# syntax=docker/dockerfile:1
# One image for the API, the worker and the one-off database job. UNTESTED: Docker was not available where this was written.
# The runtime stage keeps the full dependency tree because `npm run db:setup` / `db:migrate` run through tsx.

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY . .
RUN npm ci && npm run build

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    API_HOST=0.0.0.0 \
    API_PORT=4000 \
    SERVE_WEB=true
WORKDIR /app
COPY --from=build /app /app
RUN mkdir -p /app/.data/storage && chown -R node:node /app/.data
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||4000)+'/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# API by default. The worker overrides the command: node apps/worker/dist/main.js
CMD ["node", "apps/api/dist/main.js"]
