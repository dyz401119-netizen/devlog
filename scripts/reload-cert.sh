#!/bin/sh
# ---------------------------------------------------------------------------
# certbot 续期成功后的 deploy-hook
# 作用：把新证书同步到 ./certs 并重载 Nginx，让新证书立即生效
# 由 docker-compose.yml 里的 certbot 服务挂载调用
# ---------------------------------------------------------------------------

set -e

domain="${RENEWED_DOMAINS%% *}"
src="/etc/letsencrypt/live/${domain}"
dst="/certs"

if [ ! -d "$src" ]; then
  echo "[reload-cert] 找不到证书目录: $src" >&2
  exit 1
fi

# -L 解开符号链接，复制成实体文件（Nginx 容器只读挂载时不能跟随外部符号链接）
cp -fL "${src}/fullchain.pem" "${dst}/fullchain.pem"
cp -fL "${src}/privkey.pem"   "${dst}/privkey.pem"
chmod 644 "${dst}/fullchain.pem"
chmod 600 "${dst}/privkey.pem"

echo "[reload-cert] 证书已更新: ${domain}"

# 重载 Nginx：用宿主机 docker 命令（容器内没有 docker cli 时，
# 改用 nginx 优雅重载方式——这里通过信号文件不可行，故直接用 docker exec）
if command -v docker >/dev/null 2>&1; then
  docker exec blog-nginx nginx -s reload && echo "[reload-cert] Nginx 已重载"
else
  echo "[reload-cert] 未找到 docker 命令，请手动执行: docker exec blog-nginx nginx -s reload" >&2
fi
