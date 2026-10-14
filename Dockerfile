FROM node:24-bookworm-slim AS web-build
WORKDIR /src
COPY package.json package-lock.json build.mjs ./
RUN npm ci --ignore-scripts
COPY web ./web
RUN npm run build

FROM python:3.12-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 HERMES_MOBILE_STATE=/var/lib/hermes-web
WORKDIR /app
COPY requirements.lock ./
RUN pip install --no-cache-dir -r requirements.lock && useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin hermes-web && mkdir -p /var/lib/hermes-web && chown 10001:10001 /var/lib/hermes-web && chmod 700 /var/lib/hermes-web
COPY server.py ./
COPY --from=web-build /src/build/web ./web
USER 10001:10001
EXPOSE 9180
CMD ["python", "-m", "uvicorn", "server:app", "--host", "127.0.0.1", "--port", "9180", "--no-access-log"]
