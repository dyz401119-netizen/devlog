---
title: "静态站缓存策略：从 11 KB 到 4 KB，以及为什么 304 比 200 快得多"
date: 2026-11-18T16:00:00+08:00
draft: false
tags: ["Nginx", "性能优化", "HTTP"]
categories: ["技术"]
description: "实测 Hugo 站点的 minify 与 gzip 效果，以及 HTML/CSS/JSON 三类资源该怎么配缓存。附完整响应头和真实体积数据。"
summary: "minify 省 25%、gzip 再省 64%，最终 11.5 KB 的首页只传 4.1 KB。但真正让二次访问变快的不是压缩，是 304 和长缓存。"
ShowToc: true
---

## 一个 11 KB 的首页

我的博客首页 HTML，经过 Hugo `--minify` 处理后：

```bash
$ stat -c%s site/public/index.html
11485
```

**11.5 KB。**

但用户实际下载的字节数是：

```bash
$ gzip -c site/public/index.html | wc -c
4173
```

**4.1 KB。**

从 11.5 KB 到 4.1 KB，这是缓存和压缩策略共同作用的结果。这篇文章把每一步的实测数据摆出来。

## 第一步：minify 到底省了多少

Hugo 的 `--minify` 会去掉 HTML/CSS/JS 里所有不必要的空白和注释。

```bash
# 不加 minify
$ hugo build --destination /tmp/build_nomin --cleanDestinationDir
Total in 194 ms
$ du -sh /tmp/build_nomin
992K

# 加 minify
$ hugo build --destination /tmp/build_min --cleanDestinationDir --minify
Total in 185 ms
$ du -sh /tmp/build_min
884K
```

**整体体积从 992K 降到 884K，省 11%。**

但单个文件的差距更明显：

```bash
$ stat -c%s /tmp/build_nomin/index.html
15389
$ stat -c%s /tmp/build_min/index.html
11485
```

**首页从 15.4 KB 降到 11.5 KB，省 25%。**

为什么首页省得更多？因为首页 HTML 结构复���（导航、文章卡片、页脚），空白字符占比高。而像 `sitemap.xml` 这种本来就紧凑的文件，minify 收益小。

### minify 的代价

**几乎没有。** 构建时间从 194ms 变成 185ms（噪声范围内）。唯一的代价是**产物不可读**——调试时看不到格式化的 HTML。

如果经常需要调试页面结构，可以本地开发时不开 minify，生产构建时开。

## 第二步：gzip 压缩

Nginx 开启 gzip：

```nginx
gzip              on;
gzip_vary         on;
gzip_min_length   1024;
gzip_comp_level   5;
gzip_types
    text/plain text/css text/xml text/javascript
    application/javascript application/json application/xml
    application/rss+xml application/atom+xml
    image/svg+xml font/woff font/woff2;
```

效果（对 minify 后的首页）：

```bash
$ stat -c%s index.html
11485

$ gzip -c index.html | wc -c
4173
```

**11.5 KB → 4.1 KB，压缩率 64%。**

### 为什么能压这么多

HTML 大量重复的结构标签（`<div>`、`<span>`、`class="entry-content"`），gzip 的 LZ77 算法对重复字符串非常有效。

**对比不同内容的压缩率：**

| 内容类型 | 原始 | gzip 后 | 压缩率 |
|---|---|---|---|
| HTML（本文首页） | 11.5 KB | 4.1 KB | **64%** |
| CSS | 19.5 KB | ~5 KB | ~74% |
| JSON | 视内容 | ~30–50% | — |
| PNG / JPG | — | — | **几乎不压**（已压缩过） |
| 字体 woff2 | — | — | **几乎不压** |

**所以 `gzip_types` 里绝对不要把图片加进去**——纯属浪费 CPU，结果是负优化。

### gzip_comp_level 怎么选

| 级别 | 压缩率 | CPU 开销 |
|---|---|---|
| 1 | 较低 | 最低 |
| **5** | 接近最优 | **适中** |
| 9 | 略高一点点 | 高很多 |

级别 5 是性价比最高的点：**再往上调，体积只减小 1–2%，CPU 翻倍。**

静态站有个优势：**可以提前压缩好**。

```bash
# 预生成 .gz 文件
find site/public -type f \( -name "*.html" -o -name "*.css" -o -name "*.js" \) \
  -exec gzip -9 -k {} \;

# Nginx 直接发预压缩文件，零 CPU 开销
gzip_static on;
```

代价是磁盘占用翻倍（多一份 `.gz`），但对静态站来说完全值得。

## 第三步：缓存策略（这一步比压缩重要得多）

压缩优化的是**第一次访问**。但用户第二次访问时，真正起作用的是缓存。

### 三类资源，三种策略

**1. HTML —— 短缓存 + 强制重新验证**

```nginx
location ~* \.html$ {
    expires 5m;
    add_header Cache-Control "public, max-age=300, must-revalidate";
    try_files $uri $uri/ =404;
}
```

响应头：

```http
HTTP/1.1 200 OK
Last-Modified: Wed, 18 Nov 2026 11:11:45 GMT
ETag: "6afd87f1-2c8f"
Cache-Control: public, max-age=300, must-revalidate
```

**为什么只有 5 分钟？** 因为文章更新后，希望访客很快能看到新内容。

**2. 带 hash 的静态资源 —— 长缓存 + immutable**

Hugo 生成的 CSS 文件名带内容 hash：

```
stylesheet.7b2cbaaec847ac60490e3d75422d852ddf4443b5ce41fc3d564ae5d666fb12c9.css
```

```nginx
location ~* \.(?:css|js|woff2?|ttf|svg|png|jpe?g|gif|webp|avif|ico)$ {
    expires 30d;
    add_header Cache-Control "public, max-age=2592000, immutable";
    access_log off;
    try_files $uri =404;
}
```

响应头实测：

```http
HTTP/1.1 200 OK
Cache-Control: max-age=2592000
Cache-Control: public, max-age=2592000, immutable
Content-Length: 19514
```

**为什么敢缓存 30 天？** 因为文件名里有 hash。内容一变，文件名就变，浏览器会当成全新资源去请求。

**`immutable` 是关键**：它告诉浏览器「这个文件在这个 URL 下永远不会变」，所以**用户按 F5 刷新时也不会重新请求**。

> 只有文件名带 hash 的资源才能用 `immutable`。如果 CSS 文件名固定（比如 `style.css`），长缓存会导致用户看不到更新。

**3. RSS / JSON —— 中等缓存**

```http
HTTP/1.1 200 OK
ETag: "6afd87f1-14a1"
```

没有显式设置，走默认的 `Expires`。对订阅类内容够用了。

### 资源体积分布

我这 6 篇文章、38 个 HTML 页面的站点：

```bash
$ find site/public -name "*.html" -exec du -b {} \; | awk '{s+=$1} END {print s " bytes, " NR " 个文件"}'
438906 bytes, 38 个文件

$ find site/public -name "*.css" | xargs du -cb 2>/dev/null | tail -1
19514 bytes

$ find site/public \( -name "*.js" -o -name "*.json" \) | xargs du -cb 2>/dev/null | tail -1
69051 bytes
```

| 类型 | 体积 | 占比 |
|---|---|---|
| HTML（38 个） | 429 KB | 83% |
| CSS | 19 KB | 4% |
| JS/JSON | 67 KB | 13% |

**HTML 占了绝大多数**。但用户实际只访问其中几个页面，所以首屏的关键是**单页体积**，不是总量。

## 第四步：304 Not Modified 才是最高的性能优化

这是最容易被忽略的一点。

### 实测数据

```bash
# 第一次请求：200，完整传输
$ curl -sI http://127.0.0.1/
HTTP/1.1 200 OK
ETag: "6afd87f1-2c8f"
Content-Length: 11485

# 带条件请求：304，零字节
$ curl -s -o /dev/null -w "%{http_code}, %{size_download} bytes\n" \
    -H 'If-None-Match: "6afd87f1-2c8f"' http://127.0.0.1/
304, 0 bytes
```

**从 11.5 KB 降到 0 字节。**

### 什么时候会走 304

浏览器缓存了 HTML 后，`max-age=300` 到期，它会发一个**条件请求**：

```http
GET / HTTP/1.1
If-None-Match: "6afd87f1-2c8f"
```

服务器对比 ETag，发现没变，返回：

```http
HTTP/1.1 304 Not Modified
ETag: "6afd87f1-2c8f"
```

**没有响应体。** 浏览器直接用本地缓存。

**这比任何压缩方案都强——不是压缩了，是根本不传。**

### 必须开启的两个响应头

```nginx
# etag 默认是 on，显式写出来更清楚
etag on;

# Last-Modified 由 Nginx 自动添加（基于文件修改时间）
```

两个都给，浏览器会优先用 ETag（更精确）。ETag 是基于文件内容/大小/修改时间生成的，比 `Last-Modified` 精确到秒更可靠。

## 完整的 Nginx 缓存配置

```nginx
server {
    listen 80;
    root /usr/share/nginx/html;

    # --- 压缩 ---
    gzip              on;
    gzip_vary         on;
    gzip_min_length   1024;
    gzip_comp_level   5;
    gzip_types
        text/plain text/css text/xml text/javascript
        application/javascript application/json application/xml
        application/rss+xml application/atom+xml
        image/svg+xml font/woff font/woff2;
    # 如果预生成了 .gz 文件，开启下面这行
    # gzip_static on;

    # --- HTML：短缓存 ---
    location ~* \.html$ {
        expires 5m;
        add_header Cache-Control "public, max-age=300, must-revalidate";
        try_files $uri $uri/ =404;
    }

    # --- 带 hash 的静态资源：长缓存 ---
    location ~* \.(?:css|js|woff2?|ttf|eot|otf|svg|png|jpe?g|gif|webp|avif|ico)$ {
        expires 30d;
        add_header Cache-Control "public, max-age=2592000, immutable";
        access_log off;
        try_files $uri =404;
    }

    location / {
        try_files $uri $uri/ $uri/index.html =404;
    }
}
```

## 优化效果汇总

| 阶段 | 首页传输体积 |
|---|---|
| 原始 HTML | 15.4 KB |
| + minify | 11.5 KB（-25%） |
| + gzip | **4.1 KB（-64%）** |
| + 二次访问 304 | **0 KB** |

**从 15.4 KB 到 0 KB。**

这个优化的收益，**远远超过升级服务器配置**。

## 几个容易配错的点

### 1. `add_header` 会阻断继承

如果 location 里写了 `add_header Cache-Control`，server 级的安全头会全部失效。详见[另一篇](/posts/nginx-add-header-inheritance/)。

### 2. 没有 hash 的文件不要长缓存

如果你的 CSS 文件名固定，用 `max-age=2592000` 会导致：

- 你改了 CSS
- 用户打开网站还是旧样式
- 用户以为你网站坏了

**要么文件名加 hash，要么把 HTML 的缓存时间设短。**

### 3. 不要缓存 HTML 的 API 响应

如果页面里有动态内容（比如评论数），HTML 缓存 30 分钟会让数字看起来很旧。

静态站没这个问题，但**混合架构要注意**。

### 4. 图片该单独处理

PNG/JPG 已经是压缩格式，gzip 无效。但**图片本身应该压缩**：

```bash
# 用 imageoptim / squoosh 之类的工具
# 或者 Hugo 的图片处理管道
{{ $img := resources.Get "images/photo.jpg" }}
{{ $img := $img.Resize "800x q85" }}
```

WebP 比 JPEG 小 25–35%，比 PNG 小得多。

## 小结

| 优化 | 效果 | 成本 |
|---|---|---|
| Hugo `--minify` | -25% | 零 |
| gzip level 5 | -64% | 低 |
| gzip_static（预压缩） | 同 gzip | 磁盘 ×2 |
| HTML 短缓存 | 二次访问快 | 无 |
| 静态资源长缓存 + immutable | 几乎零请求 | 需要 hash 文件名 |
| **ETag + 304** | **-100%** | **零** |

**优先级：304 > 长缓存 > gzip > minify。**

前两项几乎零成本，收益最大。

---

*测试环境：Hugo 0.170.0 / Nginx 1.27.5 / 6 篇文章 38 个页面*
