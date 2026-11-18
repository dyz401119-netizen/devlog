#!/usr/bin/env bash
# ===========================================================================
# 重新构建并发布（HTTP-ONLY 模式）
# 改完 Markdown 或配置后执行：bash deploy-http.sh
# ===========================================================================
set -euo pipefail

cd "$(dirname "$0")"

command -v docker >/dev/null 2>&1 || { echo "缺少 docker" >&2; exit 1; }
command -v hugo  >/dev/null 2>&1 || { echo "缺少 hugo" >&2; exit 1; }
[ -f .env ] || { echo "缺少 .env" >&2; exit 1; }

set -a; . ./.env; set +a

echo "==> 构建站点 (${SITE_URL})"
hugo build \
  --source site \
  --destination "$(pwd)/site/public" \
  --gc --minify \
  --baseURL "${SITE_URL}/" \
  --cleanDestinationDir

echo "==> 校验 Nginx 配置"
docker compose exec -T nginx nginx -t

echo "==> 重载 Nginx"
docker compose exec -T nginx nginx -s reload

echo "==> 完成，访问 ${SITE_URL}"
