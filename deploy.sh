#!/usr/bin/env bash
# ===========================================================================
# 重新构建并发布站点
# 改完 Markdown 或配置后执行：bash deploy.sh
# 也可被 GitHub Actions 远程调用
# ===========================================================================
set -euo pipefail

cd "$(dirname "$0")"

command -v docker >/dev/null 2>&1 || { echo "缺少 docker" >&2; exit 1; }
[ -f .env ] || { echo "缺少 .env" >&2; exit 1; }

set -a; . ./.env; set +a

echo "==> 构建站点 (${SITE_URL})"
docker compose --profile build run --rm builder

echo "==> 重载 Nginx"
docker compose exec -T nginx nginx -t
docker compose exec -T nginx nginx -s reload

echo "==> 完成"
