# 个人博客：Hugo + Nginx + Docker + HTTPS

一套可以直接部署到 ECS 的个人博客。Hugo 生成纯静态页面，Nginx 提供服务，Docker 管理运行环境，Let's Encrypt 自动签发和续期证书。

**特点**：内存占用约 15MB，1核2G 完全够用；纯静态无数据库，基本无法入侵；文章是 Markdown 文件，随时可迁移。

---

## 一、目录结构

```
hugo-blog/
├── docker-compose.yml          # 服务编排：builder / nginx / certbot
├── .env.example                # 环境变量模板 → 复制成 .env
├── install.sh                  # 一键部署脚本（核心）
├── deploy.sh                   # 重新构建并发布
├── new-post.sh                 # 新建文章草稿
├── site/                       # Hugo 站点源码
│   ├── hugo.toml               # 站点配置（标题、菜单、主题参数）
│   ├── content/
│   │   ├── posts/              # 文章都放这里
│   │   │   ├── hello-world.md
│   │   │   └── _index.md
│   │   └── about.md            # 关于页
│   ├── static/                 # 图片、附件（原样复制到根目录）
│   ├── assets/css/extended/    # 自定义样式（覆盖主题移动端样式）
│   ├── public/                 # 构建产物（自动生成，不要手改）
│   └── themes/PaperMod/        # 主题（install.sh 自动拉取）
├── nginx/
│   ├── conf.d/
│   │   ├── 00-default.conf     # 兜底 server：HTTP 跳转、占位证书
│   │   └── site.conf           # 你的博客站点配置
│   └── snippets/               # 可复用的配置片段
├── scripts/
│   └── reload-cert.sh          # 证书续期后重载 Nginx
├── certs/                      # 证书文件（自动生成）
├── data/                       # 证书、日志等运行数据
└── .github/workflows/deploy.yml # 自动部署
```

> 构建产物位置：`site/public/`（Hugo 的产物默认输出在源目录下）。
> Nginx 容器挂载的正是 `./site/public`，所以不要在项目根目录找 `public/`。

---

## 二、部署前准备（必须按顺序做完）

### 1. 域名解析

在域名服务商控制台添加一条 A 记录：

| 类型 | 主机记录 | 记录值 |
| --- | --- | --- |
| A | `blog`（或 `@` 用主域名） | 你的 ECS 公网 IP |

验证解析生效：

```bash
# 在你自己的电脑上执行，能返回 ECS 公网 IP 才算生效
nslookup blog.example.com
```

> DNS 生效一般 1–10 分钟，慢的可能几小时。**没生效就不要往下走**，证书申请必然失败。

### 2. 域名备案（国内服务器必做）

如果 ECS 在中国大陆，域名必须完成 **ICP 备案**，否则 80/443 会被运营商拦截，表现为 `curl` 超时或连接被重置。

- 阿里云：控制台 → 备案系统
- 腾讯云：控制台 → 网站备案
- 备案通常需要 1–20 个工作日，建议提前办

**香港/海外节点的 ECS 不需要备案**，可以直接用。

### 3. 安全组放行端口

云控制台 → 安全组 → 入方向规则，放行：

| 端口 | 协议 | 来源 | 用途 |
| --- | --- | --- | --- |
| 80 | TCP | 0.0.0.0/0 | HTTP（跳转 + 证书校验） |
| 443 | TCP | 0.0.0.0/0 | HTTPS |
| 22 或自定义 | TCP | **你自己的 IP** | SSH 管理，不要对全网开放 |

### 4. 安装 Docker（如未安装）

```bash
curl -fsSL https://get.docker.com | bash -s docker --mirror Aliyun
sudo systemctl enable --now docker
sudo usermod -aG docker $USER
# 重新登录使 docker 组生效
```

验证：

```bash
docker version && docker compose version
```

---

## 三、部署

### 步骤 1：上传项目到服务器

在你自己的电脑上（Windows PowerShell）：

```powershell
# 把整个 hugo-blog 目录传到服务器
scp -r E:\DSH会话\hugo-blog deploy@你的服务器IP:/opt/hugo-blog
```

或者在服务器上直接用 git 拉取（推荐，方便之后自动部署）：

```bash
sudo mkdir -p /opt && cd /opt
sudo git clone https://github.com/你的账号/hugo-blog.git
sudo chown -R $USER:$USER /opt/hugo-blog
cd /opt/hugo-blog
```

### 步骤 2：填写域名信息

```bash
cd /opt/hugo-blog
cp .env.example .env
nano .env
```

改这三行：

```env
DOMAIN=blog.yourdomain.com          # 你的域名
SITE_URL=https://blog.yourdomain.com
ACME_EMAIL=your@email.com           # 证书到期提醒邮箱
```

### 步骤 3：执行一键部署

```bash
bash install.sh
```

脚本会自动完成：检查环境 → 写入域名 → 生成占位证书 → 启动 Nginx → 检查 DNS → 申请正式证书 → 拉取主题 → 构建站点 → 自检。

全程约 3–8 分钟（拉取 Docker 镜像为主）。

**看到 `全部完成！` 和你的博客地址就成功了。**

### 步骤 4：验证

浏览器打开 `https://你的域名`，应该看到博客首页，地址栏有锁标志。

命令行验证：

```bash
curl -I https://你的域名
# 期望看到：HTTP/2 200 和 strict-transport-security 响应头

# 检查 HTTP 是否正确跳转
curl -I http://你的域名
# 期望看到：301 且 Location: https://...
```

---

## 四、日常使用

### 写一篇新文章

```bash
cd /opt/hugo-blog
bash new-post.sh "我的第一篇技术笔记" my-first-note
```

会生成 `site/content/posts/my-first-note.md`，编辑它：

```markdown
---
title: "我的第一篇技术笔记"
date: 2026-11-15T10:00:00+08:00
draft: false          # ← 改成 false 才会发布
tags: ["Docker", "Linux"]
---

正文用 Markdown 写。
```

发布：

```bash
bash deploy.sh
```

### 修改站点信息

编辑 `site/hugo.toml`：

| 想改什么 | 改哪一项 |
| --- | --- |
| 浏览器标签标题 | `title` |
| 站点描述（SEO） | `params.description` |
| 作者名 | `params.author` |
| 首页大标题 | `params.homeInfoParams.Title` |
| 导航菜单 | `[[menu.main]]` 各块 |
| 默认深色/浅色 | `params.defaultTheme`（`auto`/`light`/`dark`） |
| 是否显示目录 | `params.ShowToc` |
| 社交链接 | `params.socialIcons` |

改完执行 `bash deploy.sh`。

### 添加图片

把图片放到 `site/static/images/`，文章里引用：

```markdown
![图片说明](/images/照片.jpg)
```

### 换主题

```bash
rm -rf site/themes/PaperMod
git clone --depth=1 https://github.com/其他主题仓库 site/themes/新主题名
# 改 site/hugo.toml 里的 theme = "新主题名"
bash deploy.sh
```

---

## 五、自动部署（GitHub Actions）

配好后，你在本地把文章 push 到 GitHub，服务器自动更新，不用登录 SSH。

### 1. 在服务器上创建部署密钥

```bash
ssh deploy@你的服务器IP
ssh-keygen -t ed25519 -f ~/.ssh/github_deploy -N "" -C "github-actions"
cat ~/.ssh/github_deploy.pub >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
cat ~/.ssh/github_deploy          # 复制输出的私钥（含 BEGIN/END 行）
```

### 2. 在 GitHub 仓库配置 Secrets

仓库 → Settings → Secrets and variables → Actions → New repository secret，添加：

| Name | Value |
| --- | --- |
| `ECS_HOST` | 服务器公网 IP |
| `ECS_USER` | `deploy`（或你的登录用户名） |
| `ECS_PORT` | SSH 端口，如 `22` |
| `ECS_SSH_KEY` | 上一步 `cat` 出来的**整段私钥** |
| `ECS_PROJECT_DIR` | `/opt/hugo-blog` |

### 3. 工作流行为

- 推送到 `main` 分支且改动了 `site/`、`nginx/`、`docker-compose.yml` 时触发
- 先在 GitHub 上跑一次 Hugo 构建，**构建失败直接中止，不会碰服务器**
- 构建成功才 SSH 到服务器执行 `deploy.sh`

> 注意：自动部署用 `git reset --hard origin/main`，**服务器上对文件的直接修改会被覆盖**。所有改动都在本地改完 push，别直接改服务器上的文件。

---

## 六、运维

### 常用命令

```bash
cd /opt/hugo-blog

docker compose ps                          # 容器状态
docker compose logs -f nginx               # 实时日志
docker compose logs --tail=100 nginx       # 最近 100 行
docker compose restart nginx               # 重启 Nginx
docker compose exec nginx nginx -t         # 测试配置语法
docker compose exec nginx nginx -s reload  # 重载配置（不中断服务）

bash deploy.sh                             # 重新构建并发布
```

### 备份

只需要备份两个东西：

```bash
# 文章内容（最重要）——排除主题目录（主题可重新拉取，体积大）
tar -czf blog-content-$(date +%F).tar.gz --exclude='site/themes' site/

# 证书（可重新申请，不备份也行）
tar -czf blog-certs-$(date +%F).tar.gz data/letsencrypt/
```

建议设置一个定时备份到本地：

```bash
# 在本地电脑执行，每天拉一次文章
crontab -e
0 3 * * * scp -r deploy@服务器IP:/opt/hugo-blog/site ~/backup/blog-$(date +\%F)/
```

### 证书续期

**自动的**，`certbot` 容器每 12 小时检查一次，到期前 30 天自动续期并重载 Nginx。

手动检查：

```bash
docker compose logs --tail=50 certbot
# 或者查看证书到期时间
echo | openssl s_client -servername 你的域名 -connect 你的域名:443 2>/dev/null \
  | openssl x509 -noout -dates
```

### 磁盘占用排查

```bash
df -h                                  # 磁盘总体
docker system df                       # Docker 占用
docker image prune -f                  # 清理没用到的镜像
docker builder prune -f                # 清理构建缓存
truncate -s 0 data/nginx-logs/*.log    # 清空日志（先确认不需要了）
```

---

## 七、常见问题

### Q1：`install.sh` 报证书申请失败

按这个顺序排查：

```bash
# 1. 80 端口通不通（在本地电脑执行）
curl -v http://你的域名/.well-known/acme-challenge/test

# 2. 安全组是否放行 80
# 3. 域名解析对不对
nslookup 你的域名

# 4. 服务器上 80 端口有没有被别的程序占用
sudo ss -tlnp | grep ':80'
```

常见原因：DNS 没生效 / 安全组没放行 / 域名没备案 / 80 端口被系统 Nginx 占用。

### Q2：`bind: address already in use`

宿主机上已经有 Nginx 或 Apache 占了 80/443：

```bash
sudo systemctl stop nginx apache2 2>/dev/null
sudo systemctl disable nginx apache2 2>/dev/null
docker compose up -d nginx
```

### Q3：访问显示 403 Forbidden

`site/public/` 目录权限或内容有问题：

```bash
ls -la site/public/ | head
# 如果是空的，重新构建
docker compose --profile build run --rm builder
```

### Q4：改了文章但网站没变

1. 文章 front matter 里 `draft: false` 了吗？
2. 执行 `bash deploy.sh` 了吗？
3. 浏览器缓存（强制刷新 Ctrl+F5）
4. 确认 `site/public/` 里文件时间戳变了：`ls -la site/public/posts/`

### Q5：中文标题生成的链接很难看

`new-post.sh` 第二个参数就是 slug，手动指定英文：

```bash
bash new-post.sh "如何用 Docker 部署博客" docker-deploy-blog
```

### Q6：想加评论、统计

纯静态站因此需要第三方服务，推荐（都不含 Google，国内可访问）：

- 评论：[Waline](https://waline.js.org/) 或 [Twikoo](https://twikoo.js.org/)（需要额外部署一个服务）
- 统计：[Umami](https://umami.is/) 自建，或 [51LA](https://www.51.la/)（国内免费）

在 `site/hugo.toml` 或主题的 `layouts/partials/` 里加对应脚本即可。这类服务涉及密钥，记得把 `.env` 留在服务器上，不要提交到 git。

### Q7：内存不够用

本方案常驻内存约 15–25MB（Nginx 约 10MB + certbot 空闲约 5MB），1核2G 绰绰有余。如果还开了别的服务，可以：

```bash
docker compose stop certbot          # 证书续期改成每月手动跑一次
docker compose --profile build down  # 构建容器跑完自动退出，不占常驻内存
```

---

## 八、本地预览（可选）

在本地电脑上不装 Docker 也能预览，装 Hugo 后：

```bash
cd site
hugo server -D --bind 0.0.0.0
# 浏览器打开 http://localhost:1313
```

`-D` 表示包含草稿，实时热更新，写文章体验最好。

---

## 九、这套方案的技术要点（可以用在面试里）

1. **构建与运行分离**：Hugo 构建是一次性容器（`--profile build run --rm`），跑完即退，不占常驻内存；Nginx 只做静态文件服务。
2. **三层容器职责**：`builder` 构建、`nginx` 服务、`certbot` 续期，各自独立，一个挂了不影响其他。
3. **ACME HTTP-01 校验**：`/.well-known/acme-challenge/` 路径在 80 端口单独放行，其余全部 301 跳 HTTPS，既保证证书可续又能强制加密。
4. **占位证书策略**：先用 1 天的自签证书让 Nginx 起来，再申请正式证书覆盖，避免"证书没有 → Nginx 起不来 → 证书申请不了"的死锁。
5. **安全头完整**：HSTS、X-Content-Type-Options、X-Frame-Options、Referrer-Policy、Permissions-Policy。
6. **缓存分层**：静态资源 30 天 immutable，HTML 5 分钟，兼顾速度和更新及时性。
7. **CI 先验证后部署**：GitHub Actions 先在云端构建，失败就中止，避免坏配置污染线上。
