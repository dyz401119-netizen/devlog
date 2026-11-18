# 快速开始（3 步）

前提：域名已解析到服务器 IP、备案完成（国内）、安全组已放行 80/443、已装 Docker。

```bash
# 1. 上传项目后进入目录
cd /opt/hugo-blog

# 2. 填写域名
cp .env.example .env
nano .env        # 改 DOMAIN / SITE_URL / ACME_EMAIL 三行

# 3. 一键部署
bash install.sh
```

看到 `全部完成！` 后访问 `https://你的域名`。

详细说明见 [README.md](README.md)。

---

## 日常

```bash
bash new-post.sh "文章标题" english-slug    # 新建草稿
# 编辑 site/content/posts/english-slug.md，draft 改 false
bash deploy.sh                              # 发布
```
