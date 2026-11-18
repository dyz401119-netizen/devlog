#!/usr/bin/env bash
# ===========================================================================
# 个人博客一键部署脚本
#
# 适用：Ubuntu 22.04 / 24.04，全新 ECS 或已有 Docker 的机器
# 用法：
#   1. 把整个 hugo-blog 目录上传到服务器，例如 /opt/hugo-blog
#   2. cd /opt/hugo-blog
#   3. cp .env.example .env && nano .env      # 填你的域名和邮箱
#   4. bash install.sh
#
# 脚本做的事：
#   - 检查 Docker / Compose
#   - 读取 .env，把域名写进 Nginx 配置
#   - 生成占位自签证书（保证 Nginx 能先起来）
#   - 首次申请 Let's Encrypt 正式证书
#   - 拉取主题、构建站点、启动 Nginx
#   - 最后做一次 HTTPS 自检
#
# 可重复执行（幂等）：已存在的配置不会被覆盖，证书已申请则跳过。
# ===========================================================================

set -euo pipefail

# ---------- 颜色输出 ----------
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
info()  { echo -e "${BLUE}[INFO]${NC} $*"; }
ok()    { echo -e "${GREEN}[ OK ]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
die()   { echo -e "${RED}[FAIL]${NC} $*" >&2; exit 1; }

cd "$(dirname "$0")"
ROOT="$(pwd)"

# ===========================================================================
# 0. 前置检查
# ===========================================================================
info "检查环境..."

command -v docker >/dev/null 2>&1 || die "没有找到 docker，请先安装：curl -fsSL https://get.docker.com | bash -s docker --mirror Aliyun"
docker compose version >/dev/null 2>&1 || die "没有找到 docker compose 插件（需要 v2），请升级 Docker"
docker info >/dev/null 2>&1 || die "docker 守护进程未运行或当前用户无权限。试试：sudo systemctl start docker && sudo usermod -aG docker \$USER 后重新登录"

[ -f .env ] || die "缺少 .env 文件。先执行：cp .env.example .env 然后编辑填入域名"

# 读取 .env
set -a; . ./.env; set +a

[ -n "${DOMAIN:-}" ]     || die ".env 里 DOMAIN 为空"
[ -n "${SITE_URL:-}" ]   || die ".env 里 SITE_URL 为空"
[ -n "${ACME_EMAIL:-}" ] || die ".env 里 ACME_EMAIL 为空"
[ "${DOMAIN}" != "blog.example.com" ] || die ".env 里 DOMAIN 还是示例值，请改成你的真实域名"

info "域名: ${DOMAIN}"
info "站点: ${SITE_URL}"

# ===========================================================================
# 1. 创建目录结构
# ===========================================================================
info "创建目录..."
mkdir -p site/public certs data/letsencrypt data/acme data/nginx-logs
chmod +x scripts/reload-cert.sh

# ===========================================================================
# 2. 替换 Nginx 配置里的域名占位符
# ===========================================================================
info "写入域名到 Nginx 配置..."
site_conf="nginx/conf.d/site.conf"
if grep -q "__DOMAIN__" "$site_conf"; then
  # 先备份原始模板只做一次
  [ -f "${site_conf}.template" ] || cp "$site_conf" "${site_conf}.template"
  sed -i "s/__DOMAIN__/${DOMAIN}/g" "$site_conf"
  ok "域名已写入 site.conf"
else
  ok "site.conf 已经是配置好的状态，跳过"
fi

# ===========================================================================
# 3. 生成占位自签证书（保证 Nginx 在正式证书就绪前能启动）
# ===========================================================================
if [ ! -f certs/placeholder.crt ]; then
  info "生成占位自签证书..."
  docker run --rm -v "${ROOT}/certs:/certs" alpine:3.20 sh -c '
    apk add --no-cache openssl >/dev/null
    openssl req -x509 -nodes -newkey rsa:2048 -days 1 \
      -keyout /certs/placeholder.key \
      -out /certs/placeholder.crt \
      -subj "/CN=placeholder.local" >/dev/null 2>&1
  '
  ok "占位证书已生成"
fi

# 如果还没有正式证书，先复制一份占位证书冒充，让 Nginx 起得来
if [ ! -f certs/fullchain.pem ]; then
  cp certs/placeholder.crt certs/fullchain.pem
  cp certs/placeholder.key certs/privkey.pem
  warn "正式证书尚未申请，暂时使用占位证书（浏览器会提示不安全，属正常）"
fi

# ===========================================================================
# 4. 先启动 Nginx（占用 80 端口，供 ACME 校验）
# ===========================================================================
info "启动 Nginx..."
# 首次启动时 public 目录为空，给个占位页避免 404 太难看
if [ ! -f site/public/index.html ]; then
  cat > site/public/index.html <<'HTML'
<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>站点构建中</title></head><body>
<h1>站点正在初始化，请稍后刷新</h1></body></html>
HTML
fi

docker compose up -d nginx
sleep 3
docker compose ps nginx

# 等待 Nginx 真正可用
for i in $(seq 1 20); do
  if curl -fsS -o /dev/null "http://127.0.0.1/healthz" 2>/dev/null; then
    ok "Nginx 已就绪"
    break
  fi
  [ "$i" -eq 20 ] && die "Nginx 启动超时，查看日志：docker compose logs nginx"
  sleep 1
done

# ===========================================================================
# 5. 检查域名解析是否指向本机
# ===========================================================================
info "检查域名解析..."
server_ip="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || echo '')"
resolved_ip="$(getent hosts "${DOMAIN}" | awk '{print $1; exit}' || true)"

if [ -z "$resolved_ip" ]; then
  warn "无法解析 ${DOMAIN}，请确认 DNS 已配置 A 记录指向本机公网 IP"
  warn "本机公网 IP: ${server_ip:-获取失败}"
  read -rp "仍要继续申请证书吗？(y/N) " ans
  [ "$ans" = "y" ] || die "已中止。配置好 DNS 后重新执行本脚本"
elif [ -n "$server_ip" ] && [ "$resolved_ip" != "$server_ip" ]; then
  warn "域名解析到 ${resolved_ip}，但本机公网 IP 是 ${server_ip}"
  warn "如果中间有 CDN 或反代，忽略此提示；否则请修正 DNS"
  read -rp "仍要继续吗？(y/N) " ans
  [ "$ans" = "y" ] || die "已中止"
else
  ok "域名解析正确: ${DOMAIN} -> ${resolved_ip}"
fi

# ===========================================================================
# 6. 申请正式证书
# ===========================================================================
if [ -d "data/letsencrypt/live/${DOMAIN}" ]; then
  ok "证书已存在，跳过申请"
else
  info "申请 Let's Encrypt 证书（首次会稍慢）..."
  domain_args=(-d "${DOMAIN}")
  # 如果你还想让 www 也能访问，取消下一行注释
  # domain_args+=(-d "www.${DOMAIN}")

  docker run --rm \
    -v "${ROOT}/data/letsencrypt:/etc/letsencrypt" \
    -v "${ROOT}/data/acme:/var/www/certbot" \
    certbot/certbot:latest \
    certonly --webroot -w /var/www/certbot \
    "${domain_args[@]}" \
    --email "${ACME_EMAIL}" \
    --agree-tos --no-eff-email \
    --non-interactive \
    || die "证书申请失败。常见原因：80 端口未在安全组放行 / 域名未备案 / DNS 未生效"

  # 复制证书到 nginx 可读位置
  docker run --rm \
    -v "${ROOT}/data/letsencrypt:/etc/letsencrypt:ro" \
    -v "${ROOT}/certs:/certs" \
    alpine:3.20 sh -c "
      cp -fL /etc/letsencrypt/live/${DOMAIN}/fullchain.pem /certs/fullchain.pem
      cp -fL /etc/letsencrypt/live/${DOMAIN}/privkey.pem   /certs/privkey.pem
      chmod 644 /certs/fullchain.pem
      chmod 600 /certs/privkey.pem
    "
  ok "正式证书已就位"
fi

# ===========================================================================
# 7. 拉取 PaperMod 主题并构建站点
# ===========================================================================
if [ ! -d site/themes/PaperMod ]; then
  info "拉取 PaperMod 主题..."
  # 优先用 gitee 镜像（国内快），失败再走 github
  if git clone --depth=1 https://gitee.com/hugo-themes/PaperMod.git site/themes/PaperMod 2>/dev/null; then
    ok "主题已从 gitee 拉取"
  else
    warn "gitee 镜像不可用，改用 GitHub..."
    git clone --depth=1 https://github.com/adityatelange/hugo-PaperMod.git site/themes/PaperMod \
      || die "主题拉取失败，请检查网络或手动 clone 到 site/themes/PaperMod"
    ok "主题已从 GitHub 拉取"
  fi
else
  ok "主题已存在，跳过"
fi

info "构建站点..."
docker compose --profile build run --rm builder
[ -f site/public/index.html ] || die "构建失败：site/public/index.html 不存在，查看 build 阶段输出"
ok "站点构建完成"

# ===========================================================================
# 8. 重启 Nginx 使新证书和内容生效
# ===========================================================================
info "重载 Nginx..."
docker compose restart nginx
sleep 2

# ===========================================================================
# 9. 自检
# ===========================================================================
info "自检..."
http_code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1/" || true)"
https_code="$(curl -sk -o /dev/null -w '%{http_code}' "https://127.0.0.1/" -H "Host: ${DOMAIN}" || true)"

echo ""
echo "------------------------------------------------------------"
echo "  HTTP  本机 : ${http_code}   （301 跳转属正常）"
echo "  HTTPS 本机 : ${https_code}   （200 属正常）"
echo "------------------------------------------------------------"
echo ""

# 外部可达性检查（仅提示，不阻断）
ext_code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "${SITE_URL}" || true)"
if [ "$ext_code" = "200" ]; then
  ok "外网访问正常：${SITE_URL}"
else
  warn "外网访问返回 ${ext_code}。若刚部署，可能有几秒延迟；持续异常请检查安全组是否放行 80/443"
fi

# 启动 certbot 常驻续期
info "启动证书自动续期容器..."
docker compose up -d certbot
ok "certbot 已启动（每 12 小时检查一次续期）"

echo ""
ok "全部完成！"
echo ""
echo "  博客地址: ${SITE_URL}"
echo ""
echo "  常用命令："
echo "    docker compose ps                       # 查看容器状态"
echo "    docker compose logs -f nginx            # 查看 Nginx 日志"
echo "    docker compose --profile build run --rm builder   # 重新构建站点"
echo "    docker compose restart nginx            # 重载配置"
echo ""
echo "  写文章：编辑 site/content/posts/ 下的 .md 文件后执行上面第 3 条命令"
echo ""
