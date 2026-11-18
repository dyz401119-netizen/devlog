---
title: "那些「配置正确但没有生效」的坑：三次静默失败"
date: 2026-11-18T15:00:00+08:00
draft: false
tags: ["运维", "Nginx", "Hugo", "踩坑"]
categories: ["技术"]
description: "配置语法检查通过、服务正常启动、页面也能打开——但你想让它生效的东西，一个都没生效。记录三次真实的静默失败。"
summary: "最可怕的 bug 不是报错，是「什么都没发生」。安全响应头全部失效、安全头被静默丢弃、页面被跳过构建——三次配置正确却不生效的真实排查。"
ShowToc: true
---

## 为什么这类问题最折磨人

程序崩溃了，你会立刻知道。

但配置**静默失效**时：语法检查通过、服务正常启动、页面也能访问——一切看起来都很正常，只有你想让它做的事情没发生。

这类问题的共同特征：

1. **没有报错**，日志里干干净净
2. **不主动验证就永远发现不了**
3. **往往在不相关的地方才暴露**

这篇记录我最近遇到的三个。

---

## 案例一：安全响应头全部失效

### 现象

给博客加安全响应头，写法是标准做法：

```nginx
server {
    listen 80;

    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header Permissions-Policy "geolocation=(), microphone=(), camera=()" always;

    location / {
        try_files $uri $uri/ =404;
    }
}
```

```bash
$ nginx -t
nginx: configuration file /etc/nginx/nginx.conf test is successful

$ curl -sI http://example.com/
HTTP/1.1 200 OK
Server: nginx/1.27.5
Content-Type: text/html
Content-Length: 8582
Cache-Control: max-age=300
```

**一个安全头都没有。**

### 根因

我还写了这两条规则：

```nginx
# 静态资源：长缓存
location ~* \.(?:css|js|png|jpg|svg|ico)$ {
    expires 30d;
    add_header Cache-Control "public, max-age=2592000, immutable";   # ← A
    try_files $uri =404;
}

# HTML：短缓存
location ~* \.html$ {
    expires 5m;
    add_header Cache-Control "public, max-age=300, must-revalidate"; # ← B
    try_files $uri $uri/ =404;
}
```

Nginx 的 `add_header` 继承规则是：

> 只有当前层级**没有任何** `add_header` 时，才会继承上层的。

**注意是「任何」。** 子级只要有一条，父级的**全部**丢弃，不合并。

首页请求 `/` 经过 `try_files` 后实际返回 `index.html`，会命中正则规则 B → 父级的 4 个安全头全部失效。

### 最小复现

```nginx
server {
    listen 8080;
    add_header X-Test-Server "server-level" always;

    location = /a {
        return 200 "A\n";
    }

    location = /b {
        add_header X-Test-Location "location-level" always;
        return 200 "B\n";
    }
}
```

```bash
$ curl -sI http://127.0.0.1:8080/a | grep -i x-test
X-Test-Server: server-level          # 有

$ curl -sI http://127.0.0.1:8080/b | grep -i x-test
X-Test-Location: location-level      # server 级的那条凭空消失了
```

### 修复

抽成片段文件，在每个写了 `add_header` 的 location 里 include：

```nginx
# snippets/security-headers.conf
add_header X-Content-Type-Options "nosniff" always;
add_header X-Frame-Options "SAMEORIGIN" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
add_header Permissions-Policy "geolocation=(), microphone=(), camera=()" always;
```

```nginx
location ~* \.html$ {
    expires 5m;
    add_header Cache-Control "public, max-age=300, must-revalidate";
    include /etc/nginx/snippets/security-headers.conf;   # ← 补上
    try_files $uri $uri/ =404;
}
```

### 教训

**`nginx -t` 只检查语法，不检查语义。** 配置「合理但无效」它管不了。

改完必须实测响应头：

```bash
curl -sI http://your-domain/ | grep -iE "x-|referrer|permissions"
```

---

## 案例二：数据库表「建好了」，但其实一张都没建

### 现象

用 Docker 部署一个评论系统（Waline），配置了 SQLite：

```yaml
environment:
  SQLITE_PATH: /app/data
  SQLITE_DB: waline
```

容器启动日志很干净：

```
Server running at http://127.0.0.1:8360
ThinkJS version: 4.0.0
Environment: production
Workers: 1
```

访问接口：

```json
{"errno":500,"errmsg":"no such table: wl_Comment"}
```

### 排查

先看数据库文件：

```bash
$ ls -la data/waline/
-rw-r--r-- 1 root root 0 Nov 18 10:00 waline.sqlite
```

**0 字节。**

容器内也是 0 字节。说明文件被创建了，但**从没写入任何内容**。

### 根因

查官方文档才看到一句关键的话：

> 使用 SQLite 时**需要下载 `waline.sqlite` 文件**至合适的位置。

**Waline 的 SQLite 模式不会自动建表。** 它假定你已经放好了一个带表结构的空数据库。

而我的流程是：mkdir 目录 → 启动容器 → 期望它自己建表。

结果是：文件是 0 字节，每次查询都因为表不存在而失败。**但启动日志里一个警告都没有。**

### 修复

下载官方模板：

```bash
cd /opt/blog
mkdir -p data/waline
curl -fsSL -o data/waline/waline.sqlite \
  https://raw.githubusercontent.com/walinejs/waline/main/assets/waline.sqlite

# 验证文件有效（应该是 24576 字节左右）
file data/waline/waline.sqlite
# data/waline/waline.sqlite: SQLite 3.x database
```

重启后恢复正常。

### 教训

**「启动成功」≠「能用」。**

对任何带数据存储的服务，部署后第一个动作应该是**实际读写一次**，而不是看容器状态是 `Up`。

```bash
# 别只信这个
docker compose ps
# NAME         STATUS
# blog-waline  Up

# 要真的打一下接口
curl -s http://127.0.0.1/api/comment | head -c 100
```

---

## 案例三：页面写好了，但 Hugo 压根没构建它

### 现象

写了一篇新文章 `message-board.md`，front matter：

```yaml
---
title: "留言板"
date: 2026-11-19T18:00:00+08:00
draft: false
---
```

构建：

```bash
$ hugo build
 Pages  │ 25
 Total in 98 ms
```

没报错。但访问 `/message-board/` 返回 **404**。

### 排查

```bash
$ hugo list all
content/message-board.md,,留言板,2026-11-19T18:00:00+08:00,...,false,https://example.com/message-board/,page,
```

Hugo **认这个文件**，`draft=false`，但也**没生成页面**。

再看当前时间：

```bash
$ date
Wed Nov 18 17:50:00 CST 2026
```

**文件日期是 11-19 18:00，比当前时间晚了 20 分钟。**

### 根因

Hugo 默认 **不构建「未来日期」的内容**（`buildFuture = false`）。

这个设计本来是为了「定时发布」——你写好文章，设一个未来时间，到期后构建就自动出现。但如果你只是随手写了个日期，就会莫名其妙地「消失」。

而且它**不会给出任何提示**，只是构建页面上少了一个。

### 修复

```yaml
date: 2026-11-18T17:00:00+08:00   # 改成过去的时间
```

或者全局开启：

```toml
# hugo.toml
buildFuture = true
```

### 教训

**「构建成功」要看页面数量对不对。**

我注意到过 `Pages 25` 这个数字，但当时以为是「预期如此」。实际上之前是 26。

```bash
# 加一行校验，页面数不对就报警
PAGES=$(hugo build 2>&1 | grep "Pages" | awk '{print $3}')
echo "生成页面数: $PAGES"
```

更好的做法是**对关键路径做 smoke test**：

```bash
# 部署后逐个验证重要页面
for p in / /posts/ /about/; do
  code=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost$p")
  [ "$code" = "200" ] || echo "❌ $p -> $code"
done
```

---

## 三次失败的共同点

| 案例 | 表面现象 | 真实原因 | 为什么难以发现 |
|---|---|---|---|
| 安全头失效 | 配置检查通过 | 子级 `add_header` 阻断继承 | 响应头不在页面上显示 |
| 数据库无表 | 容器启动成功 | SQLite 需预置表结构 | 日志无警告 |
| 页面 404 | 构建无报错 | 未来日期被跳过 | 只是少了一个页面 |

**三条共通的排查原则：**

### 1. 别信「状态」，要信「结果」

| 不可信 | 可信 |
|---|---|
| `nginx -t` 成功 | `curl -I` 看到正确的响应头 |
| 容器 `Up` | 接口返回正确的 JSON |
| 构建 `Total in 98ms` | 产物目录里有那个文件 |

### 2. 建立「基线数字」

改了配置后，看变化：

- 页面数：25 → 26（多了 1）
- 响应头：4 个安全头，一个都不能少
- 接口返回：`{"errno":0}`

**数字对不上就是有问题**，即使没有报错。

### 3. 主动验证，不要等用户发现

每次部署后跑一遍检查：

```bash
#!/bin/bash
# 简易 smoke test
set -e
BASE="http://127.0.0.1"

for p in / /posts/ /about/; do
  code=$(curl -s -o /dev/null -w "%{http_code}" "$BASE$p")
  [ "$code" = "200" ] || { echo "❌ $p -> $code"; exit 1; }
done

# 检查安全头
curl -sI "$BASE/" | grep -q "X-Content-Type-Options" || { echo "❌ 安全头缺失"; exit 1; }

echo "✅ 所有检查通过"
```

---

## 一句话总结

> **配置正确不等于生效。**
>
> 每一次改动，都要用「用户能感知的结果」去验证，而不是用「系统说它没问题」去相信。

---

*环境：Nginx 1.27.5 / Waline 1.43.7 / Hugo 0.170.0，均以 Docker 部署在 Alibaba Cloud Linux 3*
