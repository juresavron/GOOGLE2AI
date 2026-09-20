FROM node:22-slim
WORKDIR /app

# Stamped by the deploy workflow so the running server can say which commit it is (see /healthz).
ARG GIT_SHA=""

ENV NODE_ENV=production \
    HOST=0.0.0.0 PORT=8080 \
    GIT_SHA=$GIT_SHA \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi && npm cache clean --force
COPY src ./src

# No entrypoint script and no chown, unlike whatsapp2ai: that server owns a linked-device session on
# a mounted volume and has to fix its ownership while still root. This one holds nothing between
# requests — the credentials arrive as environment variables and Search Console is the only store —
# so it drops to an unprivileged user at build time and never needs to be root at all.
USER node

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "src/index.ts"]
