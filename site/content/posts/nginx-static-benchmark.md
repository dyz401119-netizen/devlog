---
title: "2核1.8G 云服务器能扛多少 QPS？一次较真的静态站压测"
date: 2026-11-16T19:00:00+08:00
draft: false
tags: ["性能测试", "Nginx", "压测", "运维"]
categories: ["技术"]
description: "在 2 核 1.8G 的香港 ECS 上对 Hugo 静态站做压测，严格 A/B 对照测试了 6 项 Nginx 优化，最后发现只有一项真正有效。"
# summary 会显示在首页卡片和列表页，优先于自动截取的正文
summary: "压测了 6 项常见的 Nginx 优化，实测只有 open_file_cache 真正有效（+23%），gzip 和无脑调大 worker_connections 几乎没用。"
ShowToc: true
---

## 起因

这台博客跑在一台很普通的云服务器上：

| 项目 | 配置 |
| --- | --- |
| CPU | Intel Xeon Platinum @ 2.5GHz，2 核（1 核 2 线程） |
| 内存 | 1870 MB（无 Swap） |
| 磁盘 | 40 GB |
| 系统 | Alibaba Cloud Linux 3，内核 5.10 |
| 软件 | Docker 26.1.3 + Nginx 1.27.5 + Hugo 0.170 静态站 |

静态站按理说很能打，但「很能打」到底是多少？网上说法从 "几千" 到 "几十万" 都有。

所以我决定较真一次：**用 wrk 压出真实数字，并且严格验证每一条优化到底有没有用**。

结论先说：**2 核 1.8G 内存的机器，这个博客能稳定跑 2.5 万 QPS 左右**。而在 6 项常见优化里，真正起作用的只有 1 项，提升 23%。

---

## 一、先说测试方法，因为它决定了结论可不可信

### 一个必须承认的局限

最理想的压测是「客户端在另一台机器上」，这样压测工具不会和服务端抢 CPU。但我只有这一台服务器，所以用的是**本机回环压测**（`wrk` 打 `127.0.0.1`）。

这意味着：**wrk 和 Nginx 在抢同一块 2 核 CPU**，测出来的数字偏保守。真实公网访问时，服务端不用分 CPU 给客户端，理论上限会更高。但公网还受带宽限制（这台机器带宽有限），所以本机回环其实是个还行的折中。

### 工具与方法

```bash
# 安装
dnf install -y wrk

# 基本用法：2 线程、100 连接、持续 10 秒
wrk -t2 -c100 -d10s --latency http://127.0.0.1/
```

**关键方法学**：每个配置**连续测 3 次，取中位数**。因为单次测量的波动就有 ±4%，只看一次数据很容易得出错误结论（这个坑我后面会讲）。

先验证测量稳定性：

```text
同一配置连续测 5 次（每次 10 秒）：
  第 1 次: 26524 req/s
  第 2 次: 25635 req/s
  第 3 次: 26549 req/s
  第 4 次: 26788 req/s
  第 5 次: 25997 req/s
```

波动范围约 ±4%，所以**小于 5% 的差异都不能算优化生效**。

---

## 二、基线：默认配置能跑多少

Nginx 镜像的默认配置：

```nginx
worker_processes auto;        # 自动 = 2（按 CPU 核数）
worker_connections 1024;      # 每个 worker 最多 1024 连接
sendfile on;
keepalive_timeout 65;
# gzip 默认是注释掉的
```

压测结果：

```text
Running 10s test @ http://127.0.0.1/
  2 threads and 100 connections
  Latency     5.32ms    4.97ms  68.11ms   88.67%
  Requests/sec:  21476.55
  Transfer/sec:    187.81MB
```

**2.1 万 QPS，187 MB/s**。作为基线。

### 瓶颈在哪

压测时看 CPU 分布：

```text
%Cpu(s): 24.1 us, 58.6 sy,  0.0 ni,  0.0 id, 17.2 si
```

三个数字很说明问题：

- `sy`（内核态）**58.6%**，远高于 `us`（用户态）24.1%
- `si`（软中断）**17.2%**，处理网卡中断占了不少
- `id`（空闲）**0%** —— CPU 已经跑满了

**结论：瓶颈在 CPU，而且主要消耗在网络栈的系统调用上，不是业务逻辑。** 对静态文件服务来说这是正常的：Nginx 本身逻辑极轻，大部分时间花在 `accept`、`read`、`write`、`sendfile` 这些系统调用上。

这也意味着：**优化方向应该是「减少系统调用次数」，而不是「优化代码」。**

---

## 三、逐个测试 6 项优化（严格 A/B 对照）

这是本文最有价值的部分。网上流传的「Nginx 性能优化清单」有几十条，但**大部分在小流量静态站上毫无作用**。我逐项做了对照实验。

### 实验设计

每次只改一个变量，重启 Nginx，预热一次，然后连续测 3 次取中位数。

### 结果汇总

| # | 配置 | 中位数 QPS | 相对基线 |
| --- | --- | --- | --- |
| 1 | 默认配置（1024 连接、无 gzip、无 file_cache） | 21,476 | 基线 |
| 2 | + `gzip on` | 21,720 | +1% |
| 3 | + `worker_connections 10240` | 21,616 | -0% |
| 4 | **+ `open_file_cache`** | **26,542** | **+23%** |
| 5 | + 关闭 `access_log` | 26,130 | -1% |
| 6 | 完整优化版（全部叠加） | 26,117 | 持平 #4 |

### 逐项解读

#### ❌ gzip：+1%，基本无效

```nginx
gzip on;
gzip_min_length 1024;
gzip_types text/html text/css application/javascript application/json;
```

理论上首页 8582 字节能压到 3574 字节，减少 58% 的传输量。**但对 QPS 几乎没影响**，因为这测的是**请求数**，不是带宽。CPU 花在压缩上的开销和网络传输省下的开销基本抵消了。

> gzip 真正的价值在**带宽和首屏速度**，不在 QPS。该开还是要开。

#### ❌ worker_connections 1024 → 10240：无变化

```nginx
events {
    worker_connections 10240;
}
```

网上很多「调优指南」第一条就是这个。但**测试时并发只有 100**，离 1024 的上限差得远，改了等于没改。

> 这个参数只在并发连接数真的超过 1024 时才有意义。低并发场景下调整它纯属自我安慰。

#### ✅ open_file_cache：+23%，唯一真正有效的优化

```nginx
open_file_cache          max=2000 inactive=20s;
open_file_cache_valid    30s;
open_file_cache_min_uses 2;
open_file_cache_errors   on;
```

**这是唯一带来显著提升的优化。**

原理：默认情况下，Nginx 每次请求静态文件都要调用 `open()`、`fstat()`、`close()`，这是 3 次系统调用。开启 `open_file_cache` 后，文件句柄会被缓存复用，**直接跳过这些系统调用**。

考虑到前面看到 `sy`（内核态）占了 58.6%，减少系统调用正好打在瓶颈上，效果立竿见影。

反向验证：把这项单独关掉，性能立刻从 26,542 掉回 21,586（**-19%**），和数据完全对应。

#### ❌ 关闭 access_log：-1%，无效甚至轻微变差

```nginx
access_log off;
```

访问日志确实要写磁盘，但这台机器磁盘是 `buff/cache` 全热的（1.2GB 缓存），写日志基本是写内存。关掉它**几乎不影响 QPS**，却让你失去排障能力。

> 更好的做法是**缓冲日志**：`access_log ... buffer=32k flush=5s;`，攒批再落盘，既保留日志又减少系统调用。

#### ⚠️ 完整优化版：没有额外收益

把所有优化叠加，结果和只开 `open_file_cache` 一样（26,117 vs 26,542）。说明**其他项要么无效，要么相互抵消**。

---

## 四、一个让我差点写错结论的坑

压测过程中，我一度测到过 **32,740 QPS**（比基线高 52%），当时以为找到了某个神奇的优化。

但后续反复测量都是 2.5–2.6 万，那个 32,740 再也没复现。

排查后发现原因：**那次测量时，环境的其他状态和我以为的不一样**（之前刚重建过容器，进程状态、缓存状态都不同）。单次测量 + 环境没控制干净 = 错误结论。

**教训**：

1. **任何一次测量都不能作为结论**，至少要 3 次取中位数
2. **每次测量前必须确保环境一致**（同样的容器、同样的缓存状态）
3. **优化前后要交替测**，避免系统状态漂移污染结果（比如先测 A 再测 B，但期间系统变慢了，就会误判）

方法论比工具重要。如果没有反复验证，我可能会写出一篇「我优化了 52%」的错文章。

---

## 五、最终数据

优化后的稳定表现（不同并发下的对比）：

| 并发 | QPS | 平均延迟 | 说明 |
| --- | --- | --- | --- |
| 10 | 21,258 | 0.52 ms | 低并发，延迟极低 |
| 50 | 25,287 | 2.12 ms | 最佳区间 |
| 100 | 25,168 | 4.16 ms | 主流压测点 |
| 200 | 26,606 | 7.06 ms | 高并发，QPS 略升，延迟增加 |

**结论：这台 2 核机器稳定输出 2.5 万 QPS，平均延迟在毫秒级。**

### 这相当于什么量级？

- 一个日均 PV 1 万的博客，平均每秒请求数是 **0.12**，峰值按 100 倍算也就 **12**
- 2.5 万 QPS 意味着：**即使全站被 DDoS 级别的流量冲击，只要带宽跟得上，CPU 也不会先成为瓶颈**

真正的限制是**带宽**。这台机器的公网带宽有限，实际公网吞吐会远低于本机回环的 187 MB/s。

---

## 六、最终采用的配置

综合测试结果，只保留真正有效和必要的项：

```nginx
# nginx.conf 关键部分
worker_processes  auto;              # 按 CPU 核数自动
worker_rlimit_nofile 65535;          # 提高文件句柄上限

events {
    worker_connections  10240;       # 够用，虽然低并发时不影响
    multi_accept        on;          # 一次接受所有新连接
    use                 epoll;
}

http {
    sendfile        on;              # 零拷贝发送文件
    tcp_nopush      on;              # 配合 sendfile 合并小包
    tcp_nodelay     on;

    keepalive_timeout  65;
    keepalive_requests 10000;        # 长连接复用更多请求

    # ⭐ 唯一带来显著提升的优化
    open_file_cache          max=2000 inactive=20s;
    open_file_cache_valid    30s;
    open_file_cache_min_uses 2;
    open_file_cache_errors   on;

    # 日志缓冲（不关闭日志，但减少写盘）
    access_log /var/log/nginx/access.log main buffer=32k flush=5s;

    gzip on;
    gzip_min_length 1024;
    gzip_types text/plain text/css application/json application/javascript;
}
```

---

## 七、总结

### 真正有用的优化

| 优化 | 效果 | 原理 |
| --- | --- | --- |
| `open_file_cache` | **+23%** | 缓存文件句柄，跳过 `open/fstat/close` 系统调用 |
| 日志缓冲 | 小幅 | 攒批写盘，减少 `write` 调用 |

### 基本无效的优化（别再浪费时间）

| 优化 | 实测效果 | 为什么 |
| --- | --- | --- |
| gzip | +1% | 省带宽不省 QPS |
| worker_connections 调大 | 0% | 并发没到上限，改了没用 |
| 关闭 access_log | -1% | 磁盘缓存让写日志几乎免费，还丢了排障能力 |

### 三条方法论

1. **先测基线，再谈优化。** 没有基线的「优化了 3 倍」都是耍流氓。
2. **一次只改一个变量，测 3 次取中位数。** 单次测量的波动就能骗过你。
3. **瓶颈在哪，优化就在哪。** 这次 CPU 内核态占 58%，所以减少系统调用才有效。如果瓶颈是带宽或磁盘 IO，上面所有调优就都是白费。

### 这台机器的真实水平

2 核 1.8G，跑静态博客：**2.5 万 QPS，延迟毫秒级**。

对个人博客来说，这个性能**远超需求**。与其折腾 Nginx 参数，不如把时间花在写内容和加 CDN 上——**CDN 带来的收益，比任何服务端调优都大几个数量级**。

---

## 附：完整压测脚本

```bash
#!/usr/bin/env bash
# 对照测试脚本：每个变体测 3 次取中位数

measure() {
  local label="$1"
  docker compose restart nginx > /dev/null 2>&1
  sleep 2
  curl -s -o /dev/null http://127.0.0.1/      # 预热

  local vals=""
  for i in 1 2 3; do
    v=$(wrk -t2 -c100 -d10s http://127.0.0.1/ 2>&1 | grep 'Requests/sec' | awk '{print $2}')
    vals="$vals $v"
  done

  local med=$(echo $vals | tr ' ' '\n' | sort -n | sed -n '2p')
  echo "【$label】中位数=$med (三次: $vals)"
}

measure "当前配置"
```

---

*测试环境：Alibaba Cloud Linux 3 / 2 vCPU / 1.8G RAM / Docker 26.1.3 / Nginx 1.27.5 / Hugo 0.170*
