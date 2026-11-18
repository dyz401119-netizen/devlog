#!/usr/bin/env bash
# ===========================================================================
# 新建文章草稿
# 用法：bash new-post.sh "文章标题"
#       bash new-post.sh "文章标题" my-slug
# ===========================================================================
set -euo pipefail

cd "$(dirname "$0")"

TITLE="${1:-}"
SLUG="${2:-}"

if [ -z "$TITLE" ]; then
  echo "用法: bash new-post.sh \"文章标题\" [slug]" >&2
  exit 1
fi

# 没给 slug 就用时间戳兜底，避免中文标题生成奇怪的文件名
if [ -z "$SLUG" ]; then
  SLUG="post-$(date +%Y%m%d-%H%M%S)"
fi

FILE="site/content/posts/${SLUG}.md"
if [ -f "$FILE" ]; then
  echo "文件已存在: $FILE" >&2
  exit 1
fi

mkdir -p site/content/posts
cat > "$FILE" <<EOF
---
title: "${TITLE}"
date: $(date +%Y-%m-%dT%H:%M:%S%:z)
draft: true
tags: []
categories: []
description: ""
ShowToc: true
---

在这里写正文。

EOF

echo "已创建草稿: $FILE"
echo "写完后把 draft 改成 false，然后执行: bash deploy.sh"
