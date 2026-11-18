---
title: "Nginx add_header 的继承陷阱：我加了安全响应头，但一个都没生效"
date: 2026-11-18T10:00:00+08:00
draft: false
tags: ["Nginx", "运维", "踩坑"]
categories: ["技术"]
description: "server 块里写了 4 个安全响应头，用 curl 一看一个都没有。原因是 Nginx add_header 的继承规则比想象中更严格。"
summary: "server 级配置的 4 个安全头全部失效，原因是 location 里只要出现过 add_header，父级的就会被整体丢弃。附完整的规避方案。"
ShowToc: true
---

## 先说现象

给博客加安全响应头，我按最常见的写法，把它们放在 `server` 块里：

```nginx
server {
    listen 80;
    server_name example.com;

    # 安全响应头
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header Permissions-Policy "geolocation=(), microphone=(), camera=()" always;

    location / {
        try_files $uri $uri/ =404;
    }
}
```

配置检查通过，`nginx -s reload` 也没报错。但 `curl -I` 一看：

```bash
$ curl -sI http://example.com/
HTTP/1.1 200 OK
Server: nginx/1.27.5
Content-Type: text/html
Content-Length: 8582
Last-Modified: Wed, 19 Nov 2026 02:00:00 GMT
ETag: "6af96bce-215c"
Expires: Wed, 19 Nov 2026 02:05:00 GMT
Cache-Control: max-age=300
```

**四个安全头一个都没有。**

## 为什么会这样

问题出在我还有个静态资源的 `location` 块：

```nginx
location ~* \.(?:css|js|png|jpg|svg|ico)$ {
    expires 30d;
    add_header Cache-Control "public, max-age=2592000, immutable";  # ← 就是这行
    try_files $uri =404;
}
```

看起来这个块只处理 CSS/JS，跟首页 HTML 没关系。但 Nginx 的 `add_header` 继承规则是：

> **只有当前层级「没有任何 add_header 指令」时，才会继承上层的 add_header。**

也就是说，只要子级（location）里出现过**哪怕一条** `add_header`，父级（server）里**所有** `add_header` 都会被整体丢弃，**不是合并，是直接不管了**。

这个规则在 Nginx 官方文档里其实写了：

> These directives are inherited from the previous configuration level if and only if there are no `add_header` directives defined on the current level.

「if and only if」——只有当且仅当。很容易读漏。

## 为什么首页也受影响

我一开始想不通：请求的是首页 `/`，匹配的是 `location /`，那个块里没有 `add_header` 啊？

关键在于匹配顺序。我的配置里还有一条：

```nginx
location ~* \.html$ {
    expires 5m;
    add_header Cache-Control "public, max-age=300, must-revalidate";  # ← 这里也有
    try_files $uri $uri/ =404;
}
```

`/` 经过 `try_files` 后实际返回的是 `index.html`，会命中 `~* \.html$` 这条正则 location，于是又被那个 `add_header` 覆盖掉了。

**结果就是：页面上任何一个有 `add_header` 的 location，都会丢掉 server 级的安全头。**

## 验证这个小结论

我用一个最小复现确认了继承规则：

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
X-Test-Server: server-level          # 有 add_header 才继承

$ curl -sI http://127.0.0.1:8080/b | grep -i x-test
X-Test-Location: location-level      # server 级的那条消失了
```

确认无误。

## 解决方案：抽成片段，显式 include

最干净的做法是把安全头抽成一个片段文件，然后在**每个**写了 `add_header` 的 location 里都 include 一遍。

**`snippets/security-headers.conf`：**

```nginx
add_header X-Content-Type-Options "nosniff" always;
add_header X-Frame-Options "SAMEORIGIN" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
add_header Permissions-Policy "geolocation=(), microphone=(), camera=()" always;
```

**主配置里到处 include：**

```nginx
server {
    listen 80;
    root /usr/share/nginx/html;

    # server 级：给那些没写 add_header 的 location 兜底
    include /etc/nginx/snippets/security-headers.conf;

    # 静态资源：有 add_header，必须重新 include
    location ~* \.(?:css|js|png|jpg|jpeg|gif|svg|ico|woff2?|ttf)$ {
        expires 30d;
        add_header Cache-Control "public, max-age=2592000, immutable";
        include /etc/nginx/snippets/security-headers.conf;   # ← 补上
        access_log off;
        try_files $uri =404;
    }

    # HTML：同样要 include
    location ~* \.html$ {
        expires 5m;
        add_header Cache-Control "public, max-age=300, must-revalidate";
        include /etc/nginx/snippets/security-headers.conf;   # ← 补上
        try_files $uri $uri/ =404;
    }

    location / {
        try_files $uri $uri/ $uri/index.html =404;
    }
}
```

**改完再验证：**

```bash
$ curl -sI http://example.com/
HTTP/1.1 200 OK
Content-Type: text/html; charset=utf-8
Cache-Control: public, max-age=300, must-revalidate
X-Content-Type-Options: nosniff
X-Frame-Options: SAMEORIGIN
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: geolocation=(), microphone=(), camera=()
```

四个头全部回来了。

## 几个容易再次踩坑的细节

**1. `always` 参数要加**

不加 `always` 时，`add_header` 只在响应码为 200/201/204/206/301/302/303/304/307/308 时生效。**4xx、5xx 响应不会带上安全头**。

```nginx
# 错误：404 页面不会有这个头
add_header X-Frame-Options "SAMEORIGIN";

# 正确
add_header X-Frame-Options "SAMEORIGIN" always;
```

**2. `if` 块同样会触发继承终止**

```nginx
if ($host = www.example.com) {
    add_header X-Whatever "1";
    return 301 https://example.com$request_uri;
}
```

`if` 在 Nginx 里是独立的配置层级，同样会把 server 级的 `add_header` 挡住。

**3. 用 `include` 比复制粘贴好**

三五个 location 还行，多了就容易漏。抽成片段文件，改一处全站生效。

## 一个更简单的检查方法

改完配置后，别只看「配置语法 OK」，一定要实际看响应头：

```bash
# 首页
curl -sI http://your-domain/ | grep -iE "x-|referrer|permissions"

# 静态资源
curl -sI http://your-domain/assets/css/style.css | grep -iE "x-|referrer|permissions"

# 404 页面（验证 always 是否生效）
curl -sI http://your-domain/not-exist | grep -iE "x-|referrer|permissions"
```

三条都打出来，才算真的配好了。

## 小结

| 结论 | 说明 |
|---|---|
| **继承是「全有或全无」** | 子级只要有一条 `add_header`，父级所有 `add_header` 全部丢弃，不合并 |
| **不是只有直接子级** | `try_files` 重定向后命中的正则 location 也算 |
| **`if` 块同样算一层** | 也会阻断继承 |
| **`always` 必加** | 否则 4xx/5xx 响应没有安全头 |

这个坑的隐蔽之处在于：**配置不报错、页面也正常打开**，只有主动去查响应头才能发现。而安全头缺失恰恰是「平时看不出问题、出事时才要命」的那类配置。

---

*测试环境：Nginx 1.27.5 / Alpine，配置以 Docker 容器运行*
