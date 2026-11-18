---
title: "Hugo 构建产物路径踩坑：站点全站 404 的一次排查"
date: 2026-11-18T13:00:00+08:00
draft: false
tags: ["Hugo", "Docker", "踩坑"]
categories: ["技术"]
description: "Hugo 说构建成功、生成了 19 个页面，但 Nginx 访问全是 404。原因是产物落到了另一个目录，而 Nginx 挂载的是空目录。"
summary: "Hugo 报构建成功但网站 404，原因是 --destination 与 volume 挂载路径不一致，文件生成在了容器的另一层里，宿主机看到的是空目录。"
ShowToc: true
---

## 现象

用 Docker 跑 Hugo 构建静态站，`docker-compose.yml` 大致是这样：

```yaml
services:
  builder:
    image: hugomods/hugo:exts-0.128.0
    profiles: ["build"]
    working_dir: /src
    volumes:
      - ./site:/src
      - ./public:/src/public      # ← 期望产物出现在这里
    command: build --gc --minify --cleanDestinationDir

  nginx:
    image: nginx:1.27-alpine
    ports:
      - "80:80"
    volumes:
      - ./public:/usr/share/nginx/html:ro   # ← Nginx 从这里读
```

跑构建：

```bash
$ docker compose --profile build run --rm builder
Start building sites …
                   │ ZH
───────────────────┼─────
 Pages             │ 19
 Total in 357 ms
```

**构建成功，19 个页面，没有报错。**

然后启动 Nginx：

```bash
$ docker compose up -d nginx
$ curl -I http://localhost/
HTTP/1.1 404 Not Found
```

**全站 404。**

## 第一个错误猜测：Nginx 配置问题

先查 Nginx 能不能读到文件：

```bash
$ docker compose exec nginx ls -la /usr/share/nginx/html/
total 0
drwxr-xr-x  2 root root   0 Nov 19 10:00 .
drwxr-xr-x  1 root root 4096 Nov 19 10:00 ..
```

**目录是空的。**

再看宿主机：

```bash
$ ls -la ./public/
total 0
```

**也是空的。**

但 Hugo 明明说构建了啊？19 个页面去哪了？

## 根因：产物落在了两个 volume 的交界处

关键在于这个挂载：

```yaml
volumes:
  - ./site:/src          # 宿主机 ./site → 容器 /src
  - ./public:/src/public # 宿主机 ./public → 容器 /src/public
```

Hugo 的默认行为是：**把构建产物放在「源目录」下的 `public/`**，也就是 `/src/public`。

看起来没问题——`/src/public` 正好挂载到了宿主机的 `./public`。

**但 Docker 的 volume 挂载顺序和覆盖关系会导致问题：**

当 `./site` 挂载到 `/src` 后，容器内的 `/src` 完全变成了宿主机的 `./site` 目录。然后 `./public` 挂载到 `/src/public`，在 `/src` 内部又覆盖了一层。

**问题在于：Hugo 构建时会先「清理目标目录」（`--cleanDestinationDir`），而清理动作作用在了挂载点上。** 更关键的是，某些情况下 volume 的挂载时机与 Hugo 写文件的时机交错，导致写到了**未被挂载的临时层**里。

## 验证：产物到底在哪

加一个容器，直接看构建时的文件系统：

```bash
$ docker compose --profile build run --rm builder sh -c "ls -la /src/public/"
```

**发现：`/src/public` 里有文件！**

但退出容器后再看宿主机 `./public/`，还是空的。

说明：**文件写在容器内的 `/src/public`，但没有同步到宿主机。**

原因是 `--cleanDestinationDir` 这个参数：它会先删除目标目录，**而删除挂载点本身会导致后续写入落到容器自身的可写层**，不再经过挂载。

## 更可靠的做法

### 方案 A：显式指定 destination，且不挂载目标目录

```yaml
services:
  builder:
    image: hugomods/hugo:exts-0.128.0
    profiles: ["build"]
    working_dir: /src
    volumes:
      - ./site:/src      # 只挂载源目录，产物会写在 /src/public
    command: >
      build
      --destination /src/public
      --gc
      --minify
      --cleanDestinationDir
```

因为 `./site` 已经完整挂载，产物写到 `/src/public` 就是写到宿主机的 `./site/public`。

**Nginx 也要相应改：**

```yaml
  nginx:
    volumes:
      - ./site/public:/usr/share/nginx/html:ro
```

**这就是我最后采用的方案。好处是：**

- 只有一个挂载点，不存在覆盖关系
- 产物位置一目了然：`site/public/`
- `.gitignore` 里加 `site/public/` 就行

### 方案 B：不用 `--cleanDestinationDir`

```yaml
command: build --gc --minify
```

不清理旧文件，避免删除挂载点。**缺点是**：删除的页面不会从产物里消失，可能残留死链。

### 方案 C：构建和部署分离

在宿主机上用 Hugo 二进制构建，产物直接写在宿主机文件系统上，再让 Nginx 挂载：

```bash
# 宿主机安装 hugo 后
cd site && hugo build --destination ../public --minify
```

**最简单，也最不容易出问题。** 缺点是宿主机需要装 Hugo（对 Linux 来说一条 `dnf install` 或下载二进制即可）。

## 顺带踩的第二个坑：未来日期的文章不会构建

排查过程中还发现另一个坑：写了篇新文章，`hugo` 说生成 25 个页面，但新文章没出现在站点里。

原因是 front matter 里写了：

```yaml
date: 2026-11-18T13:00:00+08:00
```

**而当时是 17:50，这篇文章的时间是「未来」。**

Hugo 默认**不构建未来日期的内容**（`buildFuture = false`）。表现是：

- 构建没有报错
- 页面数量少了一个
- 访问该路径返回 404

**排查方法：**

```bash
$ hugo list all
content/message-board.md,,留言板,2026-11-19T18:00:00+08:00,...,false,https://example.com/message-board/,page,
```

能看到它确实被识别了，但 `date` 在未来。

**解决：** 把日期改成过去时间，或者配置里开启：

```toml
buildFuture = true
```

## 怎么快速判断是「路径问题」还是「构建问题」

| 现象 | 大概率原因 |
|---|---|
| 构建日志正常，但 Nginx 目录空 | **挂载/路径问题** |
| 构建日志正常，目录有文件，但访问 404 | Nginx `try_files` 或 `root` 配置问题 |
| 构建日志里页面数量比预期少 | **未来日期 / draft / 被排除** |
| 某些页面能访问，新页面 404 | 同上，新增内容没被构建 |

**最快的检查命令：**

```bash
# 1. 看宿主机产物目录
ls -la ./site/public/

# 2. 看容器内实际读到的
docker compose exec nginx ls -la /usr/share/nginx/html/

# 3. 看 Hugo 认为有哪些页面
cd site && hugo list all
```

三条命令一对比，问题立刻现形。

## 最终采用的配置

```yaml
services:
  builder:
    image: hugomods/hugo:exts-0.128.0
    profiles: ["build"]
    working_dir: /src
    environment:
      HUGO_ENV: production
    volumes:
      - ./site:/src
    command: >
      build
      --destination /src/public
      --gc
      --minify
      --baseURL ${SITE_URL}
      --cleanDestinationDir

  nginx:
    image: nginx:1.27-alpine
    ports:
      - "80:80"
    volumes:
      - ./nginx/conf.d:/etc/nginx/conf.d:ro
      - ./site/public:/usr/share/nginx/html:ro
```

**核心原则：只挂载一个源目录，让产物自然落在里面。** 不要试图把「源目录的子目录」再单独挂载一次。

## 排查这类问题的思路

1. **先确认文件是否存在**（宿主机 + 容器两处都看）
2. **再确认构建日志说了什么**（页面数、有无错误）
3. **再用 `hugo list all` 看 Hugo 认不认这个页面**
4. **最后才怀疑 Nginx 配置**

我一开始直接跳到第 4 步去查 Nginx 的 `try_files`，浪费了不少时间。**「文件不存在」和「文件存在但路由错了」是完全不同的问题，要先分清。**

---

*测试环境：Hugo 0.170.0 / Docker 26.1.3 / Nginx 1.27.5*
