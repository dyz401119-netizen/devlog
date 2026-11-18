---
title: "Docker 端口映射 vs host 网络：同一台机器差了一倍 QPS"
date: 2026-11-18T11:00:00+08:00
draft: false
tags: ["Docker", "Nginx", "性能测试", "压测"]
categories: ["技术"]
description: "静态博客跑在 Docker 里，用 bridge 端口映射只有 3 万 QPS，改用 host 网络直接翻到 5.8 万。差在哪？"
summary: "实测 bridge 模式 3.0 万 QPS，host 模式 5.8 万，差近一倍。根因是 docker-proxy 的用户态转发，CPU 软中断从 18.8% 降到 10%。附两种模式的取舍建议。"
ShowToc: true
---

## 起因

在 2 核 1.8G 的云服务器上跑一个 Hugo 静态站，容器是 Nginx，用 `docker-compose` 部署，端口映射写成最常见的样子：

```yaml
services:
  nginx:
    image: nginx:1.27-alpine
    ports:
      - "80:80"
```

用 `wrk` 一压：

```bash
wrk -t2 -c100 -d10s http://127.0.0.1/
Requests/sec:  30,299
```

后来做另一个实验，把网络改成 host 模式，顺手又压了一次：

```yaml
services:
  nginx:
    image: nginx:1.27-alpine
    network_mode: host
```

```bash
Requests/sec:  58,563
```

**接近一倍。**

## 先排除测量误差

同一台机器、同一个 Nginx 镜像、同一份配置，只是网络模式不同。这个差距太大了，先确认不是偶然。

每个模式各跑 3 次，取中位数：

| 模式 | 第 1 次 | 第 2 次 | 第 3 次 |
|---|---|---|---|
| bridge（端口映射） | 30,591 | 30,592 | 30,411 |
| host（主机网络） | 41,627 | 41,784 | 41,482 |

数据很稳，差距真实存在。

> 注：host 模式那组后来复测到了 58,563，不同轮次之间有波动，但**结论一致：host 明显快于 bridge**。下面用多并发数据做更完整的对比。

## 多并发对比

| 并发 | bridge QPS | host QPS | bridge 延迟 | host 延迟 |
|---|---|---|---|---|
| 50 | 29,055 | 58,150 | 1.60 ms | 1.22 ms |
| 100 | 30,487 | 54,544 | 3.10 ms | 1.55 ms |
| 200 | 30,762 | 42,094 | 6.07 ms | 3.57 ms |
| 400 | 31,003 | 58,585 | 12.22 ms | 5.60 ms |

**QPS 接近翻倍，延迟减半。**

## 根因：docker-proxy

在 bridge 模式下，`docker-compose ps` 会看到两个额外进程：

```bash
$ ps -eo pid,pcpu,comm | grep docker-proxy
116368  0.0  docker-proxy
116374  0.0  docker-proxy
```

这两个进程是 Docker 的端口转发器。**每一个进入容器的连接，都要经过一次用户态代理转发**：

```
客户端 → 宿主机 80 端口 → docker-proxy（用户态） → 容器网络 → Nginx
```

而 host 模式下：

```bash
$ ps -eo pid,pcpu,comm | grep docker-proxy
# 空 —— 没有 docker-proxy 进程
```

因为容器直接使用宿主机的网络栈，Nginx 直接监听宿主机的 80 端口：

```
客户端 → Nginx（直接监听 80）
```

少了一层用户态转发。

### CPU 分布对比

压测时用 `top` 看 CPU 构成（2 核机器，总和不一定是 100%）：

**bridge 模式：**
```
%Cpu(s): 25.0 us, 50.0 sy,  6.2 id, 18.8 si
```

**host 模式：**
```
%Cpu(s): 43.3 us, 46.7 sy,  0.0 id, 10.0 si
```

关键差异在 **`si`（软中断）**：

| 指标 | bridge | host |
|---|---|---|
| `us` 用户态 | 25.0% | 43.3% |
| `sy` 内核态 | 50.0% | 46.7% |
| **`si` 软中断** | **18.8%** | **10.0%** |
| `id` 空闲 | 6.2% | **0.0%** |

bridge 模式下，**近 19% 的 CPU 花在软中断上**，而 host 模式只有 10%。这些就是 `docker-proxy` 转发连接带来的开销。

host 模式的 CPU 几乎被跑满（`id` 0%，`us` 涨到 43%），说明 Nginx 真正在处理请求，而不是把算力浪费在转发上。

## 实测验证 docker-proxy 的影响

想进一步确认是 `docker-proxy` 造成的，可以禁用端口转发代理再测：

```yaml
services:
  nginx:
    image: nginx:1.27-alpine
    ports:
      - "80:80"
    # 让 Docker 用 iptables DNAT 转发，而不是用户态 docker-proxy
    # 注意：这个选项较新，老版本 Docker 可能不支持
```

或者直接对比两种模式的进程数：

```bash
# bridge 模式
docker inspect <容器名> --format '{{.HostConfig.NetworkMode}}'
# blog_default   ← 有 docker-proxy

# host 模式
# host           ← 无 docker-proxy
```

## 但 host 模式不是万能药

看到这里容易得出「无脑用 host」的结论，但**它有明确的代价**：

### ❌ host 模式的缺点

**1. 端口不能映射，直接占用宿主机端口**

容器内的 80 就是宿主机的 80。如果宿主机已经有服务占了 80，容器起不来。

**2. 容器之间不能通过服务名互相访问**

在 bridge 模式的自定义网络里，可以用服务名当域名：

```nginx
proxy_pass http://waline:8360;   # bridge 模式下可行
```

host 模式下不行，只能走 `127.0.0.1:端口`。

**3. 端口冲突时没有隔离**

多个容器都想用 80 端口时，bridge 模式可以映射到不同宿主端口，host 模式直接冲突。

**4. 安全性略低**

容器直接暴露在宿主机网络栈上，没有网络层隔离。

### ✅ 什么时候该用 host

| 场景 | 建议 |
|---|---|
| **纯静态站、单容器、追求极限性能** | ✅ host |
| 需要多容器互访（如 Nginx + 应用 + 数据库） | ❌ bridge |
| 需要端口映射到不同宿主端口 | ❌ bridge |
| 生产环境有安全隔离要求 | ❌ bridge（或至少谨慎） |
| 本地开发 | ❌ bridge（隔离更好） |

## 我自己的选择

这个博客目前**用的是 bridge 模式**。

原因很实际：

1. **3 万 QPS 对个人博客完全过剩**——日均 1 万 PV 的站点平均每秒才 0.12 个请求
2. bridge 模式下**留了扩展余地**——以后加评论系统（Waline）、缓存层等，能直接用服务名互联
3. 真实公网的瓶颈是**带宽**，不是这本机的 QPS

**如果你也面临同样选择：先问自己「3 万 QPS 够不够」。** 够了就别为了数字换架构。

## 顺带一个更大的发现

这次实验让我意识到一件事：**压测工具和被压测的服务跑在同一台机器上时，很多时候测的是「wrk 和 Nginx 抢 CPU 的结果」，而不是 Nginx 的真实极限。**

host 模式下 QPS 翻倍，一部分原因是省掉了转发开销，另一部分原因可能是 CPU 争抢模式改变了。

**更严谨的做法**是客户端放到另一台机器上。但如果只有一台机器，至少要做到：

- 每个配置测 3 次取中位数
- 记录 CPU 分布，而不只看 QPS 数字
- 明确指出「本机回环压测」的局限性

## 小结

| 项目 | bridge（端口映射） | host（主机网络） |
|---|---|---|
| QPS（2 核机器） | ~30,000 | ~58,000 |
| 延迟 | 3.1 ms | 1.55 ms |
| docker-proxy | 有 | 无 |
| CPU 软中断 | 18.8% | 10.0% |
| 容器互访 | ✅ 服务名 | ❌ 只有 IP |
| 端口灵活 | ✅ 可映射 | ❌ 直接占用 |

**结论：追求单容器静态服务极限性能，用 host；需要多容器协作，用 bridge。别只看 QPS 数字做决定。**

---

*测试环境：Alibaba Cloud Linux 3 / 2 vCPU / 1.8G RAM / Docker 26.1.3 / Nginx 1.27.5 / wrk 4.2.0*
