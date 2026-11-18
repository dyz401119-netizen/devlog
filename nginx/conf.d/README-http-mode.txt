# ---------------------------------------------------------------------------
# 【HTTP-ONLY 模式已启用】
#
# 当前生效的是 site-http.conf（纯 HTTP，IP 直接访问）。
# 为了避免 80 端口冲突，原 HTTPS 相关的两个配置文件已重命名为 .disabled：
#
#   nginx/conf.d/00-default.conf.disabled   # 兜底 server + HTTPS 跳转 + 占位证书
#   nginx/conf.d/site.conf.disabled         # 正式域名 + Let's Encrypt 证书
#
# 切换到 HTTPS 时，把上面两个恢复为 .conf，并把本文件与 site-http.conf
# 重命名为 .disabled，然后配置 certbot（步骤见 README「切换到 HTTPS」）。
# ---------------------------------------------------------------------------
