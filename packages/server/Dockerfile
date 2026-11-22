# Build context: the repository root (docker build -f packages/server/Dockerfile .).

# The web feed: static files, served by the server at /feed/<token> and /join/<token>.
FROM node:22-slim AS web
ENV PNPM_HOME=/pnpm PATH="/pnpm:$PATH"
RUN npm install -g pnpm@12.16.1
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/web/package.json packages/web/
RUN --mount=type=cache,target=/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts --filter @hailboard/web...
COPY packages/protocol/src packages/protocol/src
COPY packages/web packages/web
RUN pnpm --filter @hailboard/web build

FROM python:3.13-slim AS build
COPY --from=ghcr.io/astral-sh/uv:0.11 /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never
WORKDIR /app
COPY packages/server/pyproject.toml packages/server/uv.lock ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --locked --no-dev --no-install-project
COPY packages/server/src ./src
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --locked --no-dev --no-editable

FROM python:3.13-slim
RUN useradd --system --uid 10001 --no-create-home hailboard
WORKDIR /app
COPY --from=build /app/.venv /app/.venv
COPY --from=web /repo/packages/web/dist /app/web
ENV PATH="/app/.venv/bin:$PATH" HOST=0.0.0.0 PORT=8080 TRUST_PROXY=true PYTHONUNBUFFERED=1 \
    WEB_DIR=/app/web
USER hailboard
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD python -c "import urllib.request,os;urllib.request.urlopen(f'http://127.0.0.1:{os.environ[\"PORT\"]}/health',timeout=2)"
CMD ["python", "-m", "hailboard_server"]
