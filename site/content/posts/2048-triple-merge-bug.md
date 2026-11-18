---
title: "2048 的「三连合并」为什么容易写错"
date: 2026-11-18T12:00:00+08:00
draft: false
tags: ["JavaScript", "算法", "游戏开发"]
categories: ["技术"]
description: "实现 2048 时最隐蔽的 bug：[4,4,4] 往左滑，正确答案是 [8,4]，但很多人会写成 [8]。这里是原因和三种正确写法。"
summary: "一行 [4,4,4] 向左合并，正确结果是 [8,4]，因为同一次移动中每块只能合并一次。90% 的实现会在这里出错，本文讲清原因和三种正确写法。"
ShowToc: true
---

## 先看这道题

有个 2048 的棋盘，某一行是：

```
[4, 4, 4, 0]
```

向左滑动，结果应该是什么？

**正确答案：`[8, 4, 0, 0]`**

**很多人会答：`[8, 0, 0, 0]`** —— 这是错的。

规则是：**同一次移动中，每个方块只能参与一次合并。**

所以：
- 第一个 `4` 和第二个 `4` 合并成 `8` ✓
- 第三个 `4` 不能和刚合并出来的 `8` 再合（数字不同，本来也不行），留下来 ✓
- 结果：`8, 4`

## 另一种容易错的情况

再看这个：

```
[2, 2, 2, 2]
```

向左滑，正确答案是：

```
[4, 4, 0, 0]
```

即：**两两配对**，第一个和第二个合成 4，第三个和第四个合成 4。

而不是 `[8, 0, 0, 0]`（错误：把 4 和 4 又合了）。

## 为什么会写错

大多数人的第一版实现长这样：

```javascript
function moveLeft(row) {
  // 先压缩：去掉 0
  let tiles = row.filter(v => v !== 0);

  // 再合并相邻相同项
  for (let i = 0; i < tiles.length - 1; i++) {
    if (tiles[i] === tiles[i + 1]) {
      tiles[i] *= 2;
      tiles.splice(i + 1, 1);   // 删掉被合并的那个
      // ← 问题在这：i 没变，下一轮会拿新值继续比
    }
  }

  // 补 0
  while (tiles.length < 4) tiles.push(0);
  return tiles;
}
```

跑一下 `[4, 4, 4, 0]`：

```
第 1 轮：i=0, tiles[0]=4, tiles[1]=4 → 相同 → tiles[0]=8, 删除 tiles[1]
        现在 tiles = [8, 4]
第 2 轮：i 仍然是 0（没变），比较 tiles[0]=8 和 tiles[1]=4 → 不同 → i++
        结束
结果：[8, 4, 0, 0]  ← 这里居然对了？
```

等等，这个例子居然是对的。再看 `[2, 2, 2, 2]`：

```
初始：[2, 2, 2, 2]

第 1 轮：i=0, tiles[0]=2, tiles[1]=2 → 合并 → tiles[0]=4, 删除 tiles[1]
        tiles = [4, 2, 2]
第 2 轮：i 还是 0，比较 tiles[0]=4 和 tiles[1]=2 → 不同 → i=1
第 3 轮：i=1, tiles[1]=2, tiles[2]=2 → 合并 → tiles[1]=4, 删除 tiles[2]
        tiles = [4, 4]
第 4 轮：循环结束（i < length-1，即 1 < 1 为 false）
结果：[4, 4, 0, 0]  ← 也对了？
```

**看起来都对？** 那问题在哪？

关键在 **`i` 的递增时机**。上面代码里，合并后没有 `break` 也没有跳过，`i` 会继续正常递增。如果改成下面这样就有问题了：

```javascript
for (let i = 0; i < tiles.length - 1; i++) {
  if (tiles[i] === tiles[i + 1]) {
    tiles[i] *= 2;
    tiles.splice(i + 1, 1);
    i--;   // ← 常见写法：为了让下一轮重新检查这个位置
  }
}
```

跑 `[2, 2, 2, 2]`：

```
第 1 轮：i=0, 合并 → tiles = [4, 2, 2]，然后 i-- → i=-1
第 2 轮：i++ → i=0，比较 tiles[0]=4 和 tiles[1]=2 → 不同
第 3 轮：i=1，比较 tiles[1]=2 和 tiles[2]=2 → 合并 → tiles=[4,4]，i-- → i=0
第 4 轮：i++ → i=1，比较 tiles[1]=4 和 tiles[2]=undefined → 跳出
结果：[4, 4, 0, 0]  ← 还是对的
```

**实际上这两种写法在大多数情况下都能"碰巧"正确**，因为它们只在「合并后立即回头比较」这一种场景下出问题，而这个场景恰好被边界条件挡住了。

**真正会出错的写法是「合并后把值加到前一个，但没删除后一个」：**

```javascript
// 错误示例
for (let i = 0; i < tiles.length - 1; i++) {
  if (tiles[i] === tiles[i + 1]) {
    tiles[i] *= 2;
    tiles[i + 1] = 0;    // ← 意图是"清空"
  }
}
// 之后再统一 filter 掉 0
```

跑 `[2, 2, 2, 2]`：

```
第 1 轮: i=0, tiles=[4, 0, 2, 2]
第 2 轮: i=1, tiles[1]=0, tiles[2]=2 → 不同
第 3 轮: i=2, tiles[2]=2, tiles[3]=2 → 合并 → tiles=[4, 0, 4, 0]
filter 后: [4, 4]  ← 正确

跑 [4,4,4,0]:
第 1 轮: i=0, tiles=[8,0,4,0]
第 2 轮: i=1, tiles[1]=0, tiles[2]=4 → 不同
结果: [8,4] ← 正确
```

**还是对的？**

## 真正的坑：不做「压缩」直接原地处理

问题出在**没有先压缩掉 0** 就原地操作的情况：

```javascript
function moveLeft(row) {
  for (let i = 0; i < row.length - 1; i++) {
    if (row[i] !== 0 && row[i] === row[i + 1]) {
      row[i] *= 2;
      row[i + 1] = 0;
    }
  }
  // 然后用某种方式把 0 移到右边
  const nonZero = row.filter(v => v !== 0);
  while (nonZero.length < 4) nonZero.push(0);
  return nonZero;
}
```

跑 `[4, 0, 4, 4]`（注意中间有个 0）：

```
第 1 轮: i=0, row[0]=4, row[1]=0 → 4 !== 0 但 row[0] !== row[1] → 跳过
第 2 轮: i=1, row[1]=0 → 条件 row[1] !== 0 为 false → 跳过
第 3 轮: i=2, row[2]=4, row[3]=4 → 合并 → row=[4,0,8,0]
filter 后: [4, 8, 0, 0]
```

**答案是 `[4, 8]`，但正确的是 `[8, 4]`！**

因为向左滑时，`4, 0, 4, 4` 应该先**压缩成** `4, 4, 4`，然后**最左边的两个 4 合并**成 8，结果是 `[8, 4]`。

**这个 bug 的隐蔽性在于：它只在「中间有空位」时出现，而且只影响一两个位置。** 随便滑几下很难发现，但玩久了就会觉得"怎么数字对不上"。

## 正确写法的核心原则

**分三步，绝不能合并：**

### 第 1 步：压缩（把 0 全部挤到一边）

```javascript
// 向左滑：把所有非 0 往左挪
function compress(row) {
  return [
    ...row.filter(v => v !== 0),
    ...Array(row.filter(v => v === 0).length).fill(0)
  ];
}
```

`[4, 0, 4, 4]` → `[4, 4, 4, 0]`

### 第 2 步：合并（只合并一次）

```javascript
function merge(row) {
  const result = [...row];
  for (let i = 0; i < result.length - 1; i++) {
    if (result[i] !== 0 && result[i] === result[i + 1]) {
      result[i] *= 2;
      result[i + 1] = 0;
      i++;   // ← 关键：跳过被合并的那个，保证同一块不参与第二次合并
    }
  }
  return result;
}
```

`[4, 4, 4, 0]` → `[8, 0, 4, 0]`

**`i++` 是核心。** 它保证合并后直接跳过下一个位置，所以 `[2,2,2,2]` 会得到：
- 第 1 次：`[4, 0, 2, 2]`，i 跳到 2
- 第 2 次：`[4, 0, 4, 0]`
- 结果：`[4, 4]` ✓

### 第 3 步：再压缩

```javascript
merge([8, 0, 4, 0]) → compress → [8, 4, 0, 0]
```

**最终：`[8, 4, 0, 0]` ✓**

## 完整的四方向实现

四个方向的逻辑是同一个函数，只是遍历顺序不同：

```javascript
function moveRow(row, direction) {
  // direction: 'left' 或 'right'
  const reversed = direction === 'right';
  let work = reversed ? [...row].reverse() : [...row];

  // 1. 压缩
  work = [...work.filter(v => v !== 0),
          ...Array(work.filter(v => v === 0).length).fill(0)];

  // 2. 合并
  for (let i = 0; i < work.length - 1; i++) {
    if (work[i] !== 0 && work[i] === work[i + 1]) {
      work[i] *= 2;
      work[i + 1] = 0;
      i++;
    }
  }

  // 3. 再压缩
  work = [...work.filter(v => v !== 0),
          ...Array(work.filter(v => v === 0).length).fill(0)];

  return reversed ? work.reverse() : work;
}
```

**上下移动**就是把棋盘转置一下（行列互换），用同一个函数处理，再转置回来：

```javascript
function transpose(grid) {
  return grid[0].map((_, c) => grid.map(row => row[c]));
}

function moveUp(grid) {
  return transpose(transpose(grid).map(row => moveRow(row, 'left')));
}

function moveDown(grid) {
  return transpose(transpose(grid).map(row => moveRow(row, 'right')));
}
```

## 怎么验证自己的实现是对的

写测试用例，覆盖这几种边界情况：

```javascript
const cases = [
  // [输入, 期望]（向左滑）
  [[4, 4, 4, 0], [8, 4, 0, 0]],   // 三连
  [[2, 2, 2, 2], [4, 4, 0, 0]],   // 四连，两两配对
  [[4, 0, 4, 4], [8, 4, 0, 0]],   // 中间有空位（最易错）
  [[0, 0, 4, 4], [8, 0, 0, 0]],   // 前面有空格
  [[2, 2, 4, 4], [4, 8, 0, 0]],   // 两组不同数字
  [[2, 4, 2, 4], [2, 4, 2, 4]],   // 无法合并
  [[0, 0, 0, 0], [0, 0, 0, 0]],   // 全空
  [[2, 0, 0, 2], [4, 0, 0, 0]],   // 首尾相同
];

cases.forEach(([input, expected]) => {
  const result = moveRow(input, 'left');
  const ok = JSON.stringify(result) === JSON.stringify(expected);
  console.log(ok ? '✓' : '✗', input, '→', result, ok ? '' : `(期望 ${expected})`);
});
```

**特别要测 `[4, 0, 4, 4]`**——这条能抓出 90% 的实现错误。

## 小结

| 错误写法 | 表现 |
|---|---|
| 不先压缩就原地合并 | `[4,0,4,4]` → `[4,8]`（错），应为 `[8,4]` |
| 合并后不跳过 | `[2,2,2,2]` 可能变成 `[8]`（错），应为 `[4,4]` |
| 用 `i--` 重试 | 在某些输入下会重复合并 |

**正确做法：压缩 → 合并（合并后 `i++` 跳过）→ 再压缩。**

记住一句话：**「先归位，再配对，再归位」，而且配对时一步一挪，不回头。**

---

*这是我在写一个 2048 小游戏时踩的坑。当时测试用例第一版只写了 `[2,2,0,0]` 这种简单情况，全部通过，结果实际玩的时候才发现 `[4,0,4,4]` 会出错。*
