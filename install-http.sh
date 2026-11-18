#!/usr/bin/env bash
# ===========================================================================
# 个人博客一键部署（HTTP-ONLY 模式）
#
# 适用：Ubuntu / Alibaba Cloud Linux 3 (Anolis) / CentOS 系，已装 Docker + Compose
# 场景：域名未备案或暂无域名，先用 http://服务器IP 访问验证站点
#
# 用法：
#   1. 项目已上传到服务器（如 /opt/hugo-blog）
#   2. cd /opt/hugo-blog
#   3. cp .env.example .env && nano .env     # SITE_URL 填 http://你的公网IP
#   4. bash install-http.sh
#
# 脚本做的事：
#   - 检查 docker / compose
#   - 检查 Hugo（缺失则自动下载官方二进制）
#   - 校验 .env
#   - 准备目录、拉取主题（多镜像兜底）
#   - 构建站点
#   - 启动 Nginx（只监听 80）
#   - 本地 + 公网自检
#
# 可重复执行（幂等）。
# ===========================================================================

set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
info() { echo -e "${BLUE}[INFO]${NC} $*"; }
ok()   { echo -e "${GREEN}[ OK ]${NC} $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
die()  { echo -e "${RED}[FAIL]${NC} $*" >&2; exit 1; }

cd "$(dirname "$0")"
ROOT="$(pwd)"

# ===========================================================================
# 0. 环境检查
# ===========================================================================
info "检查环境..."

command -v docker >/dev/null 2>&1 || die "未找到 docker。安装：dnf install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin"
docker info >/dev/null 2>&1 || die "docker 守护进程未运行：systemctl start docker"
docker compose version >/dev/null 2>&1 || die "缺少 docker compose v2 插件"

[ -f .env ] || die "缺少 .env。先执行：cp .env.example .env 然后编辑"

set -a; . ./.env; set +a

[ -n "${SITE_URL:-}" ] || die ".env 里 SITE_URL 为空"

# HTTP 模式必须有公网 IP 或域名，且不能是 https
if [ "${SITE_URL#https://}" != "${SITE_URL}" ]; then
  die "当前是 HTTP-ONLY 模式，但 SITE_URL 是 https://。请改成 http://你的公网IP"
fi

info "站点地址: ${SITE_URL}"

# ===========================================================================
# 1. Hugo 可用性
# ===========================================================================
if ! command -v hugo >/dev/null 2>&1; then
  warn "未找到 hugo，尝试下载官方二进制..."
  HUGO_VER="0.170.0"
  for u in \
    "https://ghfast.top/https://github.com/gohugoio/hugo/releases/download/v${HUGO_VER}/hugo_${HUGO_VER}_linux-amd64.tar.gz" \
    "https://github.com/gohugoio/hugo/releases/download/v${HUGO_VER}/hugo_${HUGO_VER}_linux-amd64.tar.gz"; do
    if curl -fsSL --max-time 180 -o /tmp/hugo.tgz "$u" && [ -s /tmp/hugo.tgz ]; then
      tar -xzf /tmp/hugo.tgz -C /usr/local/bin hugo && chmod +x /usr/local/bin/hugo && break
    fi
  done
  command -v hugo >/dev/null 2>&1 || die "hugo 安装失败，请手动安装后重试"
fi
ok "hugo: $(hugo version | cut -d' ' -f2)"

# ===========================================================================
# 2. 目录与配置检查
# ===========================================================================
info "准备目录..."
mkdir -p site/public data/nginx-logs

[ -f nginx/conf.d/site-http.conf ] || die "缺少 nginx/conf.d/site-http.conf"

# 防止 HTTPS 配置同时生效导致端口冲突
for bad in nginx/conf.d/00-default.conf nginx/conf.d/site.conf; do
  if [ -f "$bad" ]; then
    mv "$bad" "${bad}.disabled"
    warn "已禁用 HTTPS 配置: ${bad} -> ${bad}.disabled（避免 80 端口冲突）"
  fi
done
ok "Nginx 配置: 仅 site-http.conf 生效"

# ===========================================================================
# 3. 拉取主题（多镜像兜底）
# ===========================================================================
if [ ! -d site/themes/PaperMod ]; then
  info "拉取 PaperMod 主题..."
  ok_theme=0
  for u in \
    "https://ghfast.top/https://github.com/adityatelange/hugo-PaperMod/archive/refs/heads/master.zip" \
    "https://codeload.github.com/adityatelange/hugo-PaperMod/zip/refs/heads/master" \
    "https://gh-proxy.com/https://github.com/adityatelange/hugo-PaperMod/archive/refs/heads/master.zip"; do
    info "  尝试: $u"
    rm -rf /tmp/pm && mkdir -p /tmp/pm
    if curl -fsSL --max-time 120 -o /tmp/pm.zip "$u" 2>/dev/null && [ -s /tmp/pm.zip ]; then
      if command -v unzip >/dev/null 2>&1; then
        unzip -q -o /tmp/pm.zip -d /tmp/pm
      else
        python3 -c "import zipfile;zipfile.ZipFile('/tmp/pm.zip').extractall('/tmp/pm')" 2>/dev/null || continue
      fi
      inner=$(find /tmp/pm -maxdepth 1 -mindepth 1 -type d | head -1)
      if [ -n "$inner" ] && [ -d "$inner/layouts" ]; then
        mkdir -p site/themes
        rm -rf site/themes/PaperMod
        mv "$inner" site/themes/PaperMod
        ok_theme=1
        break
      fi
    fi
  done
  [ "$ok_theme" -eq 1 ] || die "主题下载失败。可手动：git clone https://github.com/adityatelange/hugo-PaperMod.git site/themes/PaperMod"
  ok "主题已就绪"
else
  ok "主题已存在"
fi

# ===========================================================================
# 4. 构建站点
# ===========================================================================
info "构建站点..."
cd site
hugo build \
  --destination "$ROOT/site/public" \
  --gc --minify \
  --baseURL "$SITE_URL/" \
  --cleanDestinationDir
cd "$ROOT"

[ -f site/public/index.html ] || die "构建失败：site/public/index.html 不存在"
count=$(find site/public -name '*.html' | wc -l)
ok "构建完成：${count} 个 HTML 页面"

# ===========================================================================
# 5. 启动 Nginx
# ===========================================================================
info "启动 Nginx..."
docker compose up -d nginx

for i in $(seq 1 30); do
  if curl -fsS -o /dev/null "http://127.0.0.1/healthz" 2>/dev/null; then
    ok "Nginx 已就绪"
    break
  fi
  [ "$i" -eq 30 ] && { docker compose logs --tail=30 nginx; die "Nginx 启动超时"; }
  sleep 1
done

# ===========================================================================
# 6. 自检
# ===========================================================================
info "自检..."
code_root=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1/" || true)
code_post=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1/posts/" || true)
code_arch=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1/archives/" || true)

pub_ip=$(curl -fsS --max-time 8 https://api.ipify.org 2>/dev/null || echo "获取失败")
code_pub=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "http://${pub_ip}/" 2>/dev/null || echo "超时")

echo ""
echo "------------------------------------------------------------"
echo "  本机 /        : ${code_root}"
echo "  本机 /posts/  : ${code_post}"
echo "  本机 /archives/: ${code_arch}"
echo "  公网 http://${pub_ip} : ${code_pub}"
echo "------------------------------------------------------------"
echo ""

[ "$code_root" = "200" ] || die "首页返回 ${code_root}，检查：docker compose logs nginx"

if [ "$code_pub" != "200" ]; then
  warn "公网访问返回 ${code_pub}。请在云控制台安全组放行 TCP 80 端口（入方向 0.0.0.0/0）"
fi

echo ""
ok "部署完成！"
echo ""
echo "  访问地址: ${SITE_URL}"
echo ""
echo "  常用命令："
echo "    docker compose ps                     # 容器状态"
echo "    docker compose logs -f nginx          # 实时日志"
echo "    docker compose restart nginx          # 重启"
echo "    bash deploy-http.sh                   # 重新构建发布"
echo ""
