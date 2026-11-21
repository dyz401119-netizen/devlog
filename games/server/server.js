/**
 * 贪吃蛇大作战 —— 游戏服务器（复刻 slither.io / 贪吃蛇大作战 核心机制）
 *
 * 与原作一致的核心机制：
 *   1. 360° 平滑移动：玩家控制方向角，不是四方向格移动
 *   2. 蛇身是轨迹：蛇头移动，蛇身跟随历史轨迹（像一条绳子）
 *   3. 加速消耗：按住加速，速度翻倍，但持续掉长度
 *   4. 尸体掉落：死亡后沿蛇身位置散落食物
 *   5. 圆形竞技场：地图是圆形，出界即死
 *   6. 围杀战术：用身体围住对手，让对方撞上来
 *   7. 撞自己不死：只有撞别人的身体和边界才会死
 */

'use strict';

const http = require('http');
const { WebSocketServer } = require('ws');
const os = require('os');

const PORT = process.env.PORT || 8080;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'dev-admin-token';

// ---------------------------------------------------------------------------
// 游戏参数（尽可能贴近原作手感）
// ---------------------------------------------------------------------------
const WORLD_RADIUS = 2400;          // 圆形竞技场半径
const TICK_MS = 33;                 // 30 FPS
const TICK_RATE = 1000 / TICK_MS;

const BASE_SPEED = 3.2;             // 基础速度（像素/帧）
const BOOST_SPEED = 7.0;            // 加速速度（约 2.2 倍）
const TURN_RATE = 0.16;             // 转向速率（弧度/帧），约 1.3 秒转一圈
const BODY_SPACING = 6.5;           // 蛇身点间距
const HEAD_RADIUS = 13;             // 蛇头半径
const BODY_RADIUS = 11;             // 蛇身半径

const INIT_LENGTH = 10;             // 初始长度（珠子数）
const MIN_BOOST_LEN = 8;            // 低于这个长度不能加速（初始 10，吃几个就能加速）
const BOOST_LOSE_INTERVAL = 150;    // 加速时每隔多少毫秒掉一节
const MAX_PLAYERS_PER_ROOM = 20;

const FOOD_COUNT = 900;             // 食物总数
const FOOD_RADIUS = 5;
const FOOD_VALUE = 1;               // 吃一个食物加多少珠子

// 死亡时掉落食物的比例（每颗珠子生成几个食物）
const DEATH_FOOD_RATIO = 2;

const COLORS = [
  '#ff4757', '#2ed573', '#1e90ff', '#ffa502', '#a55eea',
  '#00d2d3', '#ff6b81', '#7bed9f', '#70a1ff', '#ff7f50',
  '#5f27cd', '#00b894', '#fdcb6e', '#e17055', '#81ecec',
];

// ---------------------------------------------------------------------------
// 全局统计（管理后台用）
// ---------------------------------------------------------------------------
const startedAt = Date.now();
const stats = {
  totalConnections: 0,
  totalGames: 0,
  totalDeaths: 0,
  peakOnline: 0,
  deathHistory: [],     // 最近的死亡记录
  killHistory: [],      // 最近的击杀记录
};

function recordDeath(entry) {
  stats.deathHistory.unshift(entry);
  if (stats.deathHistory.length > 60) stats.deathHistory.pop();
  stats.totalDeaths++;
}

function recordKill(entry) {
  stats.killHistory.unshift(entry);
  if (stats.killHistory.length > 60) stats.killHistory.pop();
}

function log(msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] ${msg}`);
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------
const rand = (min, max) => min + Math.random() * (max - min);
const dist2 = (x1, y1, x2, y2) => (x1 - x2) ** 2 + (y1 - y2) ** 2;

function angleDiff(from, to) {
  let d = to - from;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function randomPointInCircle(radius) {
  const a = Math.random() * Math.PI * 2;
  const r = Math.sqrt(Math.random()) * radius;
  return { x: Math.cos(a) * r, y: Math.sin(a) * r };
}

// ---------------------------------------------------------------------------
// 蛇（玩家）
// ---------------------------------------------------------------------------
class Snake {
  constructor(id, name, color, room) {
    this.id = id;
    this.name = (name || '玩家').slice(0, 14);
    this.color = color;
    this.room = room;

    // 出生在中心区域（半径 60% 以内），避免一出生就在边界附近
    const p = randomPointInCircle(WORLD_RADIUS * 0.6);
    this.x = p.x;
    this.y = p.y;
    this.angle = Math.random() * Math.PI * 2;
    this.targetAngle = this.angle;

    // 蛇身：一串「珠子」的位置，索引 0 是头
    this.body = [];
    for (let i = 0; i < INIT_LENGTH; i++) {
      this.body.push({
        x: this.x - Math.cos(this.angle) * i * BODY_SPACING,
        y: this.y - Math.sin(this.angle) * i * BODY_SPACING,
      });
    }

    this.length = INIT_LENGTH;      // 目标长度（珠子数）
    this.score = 0;                 // 吃的食物总量（排行榜用）
    this.kills = 0;
    this.alive = true;
    this.boosting = false;
    this.lastBoostLose = 0;
    this.deathReason = null;
    this.killedBy = null;

    this.ws = null;
    this.joinedAt = Date.now();
    this.inputQueue = [];           // 客户端输入缓冲
  }

  /** 当前实际珠子数（用于显示长度） */
  get bodyLength() { return this.body.length; }

  /** 是否能加速（长度足够） */
  get canBoost() {
    return this.alive && this.length > MIN_BOOST_LEN;
  }

  /**
   * 每帧移动
   * @returns {boolean} 是否因为加速而掉了一节
   */
  move(now) {
    if (!this.alive) return false;

    // 1. 转向：朝目标角度平滑旋转
    const diff = angleDiff(this.angle, this.targetAngle);
    const maxTurn = TURN_RATE;
    if (Math.abs(diff) <= maxTurn) {
      this.angle = this.targetAngle;
    } else {
      this.angle += Math.sign(diff) * maxTurn;
    }

    // 2. 加速判定
    const boosting = this.boosting && this.canBoost;
    const speed = boosting ? BOOST_SPEED : BASE_SPEED;

    // 3. 前进
    this.x += Math.cos(this.angle) * speed;
    this.y += Math.sin(this.angle) * speed;

    // 4. 更新蛇身：头插入新位置
    this.body.unshift({ x: this.x, y: this.y });

    // 5. 维持身体长度
    //    加速时持续掉长度
    let lostSegment = false;
    if (boosting && now - this.lastBoostLose > BOOST_LOSE_INTERVAL) {
      this.lastBoostLose = now;
      if (this.length > MIN_BOOST_LEN) {
        this.length -= 1;
        lostSegment = true;
        // 掉落的长度变成食物
        this.room.addFood(this.body[this.body.length - 1].x, this.body[this.body.length - 1].y, FOOD_VALUE);
      }
    }

    // 截断身体到目标长度
    // 珠子数量 = length，但间距是 BODY_SPACING，所以 body 数组长度要更多
    // 这里简化：body 数组的每个元素代表一个「珠子位置」，直接按长度截断
    const maxPoints = Math.ceil(this.length);
    while (this.body.length > maxPoints + 2) {
      this.body.pop();
    }

    return lostSegment;
  }

  /** 吃食物，变长 */
  eat(value) {
    this.length += value;
    this.score += value;
  }

  /** 死亡 */
  die(reason, killer) {
    if (!this.alive) return;
    this.alive = false;
    this.deathReason = reason;
    this.killedBy = killer ? killer.name : null;
  }

  /** 序列化（发给客户端） */
  serialize(forPlayer) {
    return {
      id: this.id,
      name: this.name,
      color: this.color,
      alive: this.alive,
      boosting: this.boosting && this.canBoost,
      score: Math.floor(this.score),
      kills: this.kills,
      // 只发送头附近的身体点，减少带宽（远距离看不到）
      // 但为了围杀正确显示，全部发送
      body: this.body.map(p => [Math.round(p.x), Math.round(p.y)]),
    };
  }

  /** 管理后台用的简略信息 */
  info() {
    return {
      id: this.id,
      name: this.name,
      color: this.color,
      alive: this.alive,
      length: Math.floor(this.length),
      score: Math.floor(this.score),
      kills: this.kills,
      boosting: this.boosting,
      x: Math.round(this.x),
      y: Math.round(this.y),
      deathReason: this.deathReason,
      joinedAt: this.joinedAt,
    };
  }
}

// ---------------------------------------------------------------------------
// 房间
// ---------------------------------------------------------------------------
class Room {
  constructor(id) {
    this.id = id;
    this.snakes = new Map();
    this.foods = new Map();       // foodId -> {x, y, value}
    this.foodSeq = 0;
    this.timer = null;
    this.started = false;
    this.createdAt = Date.now();
    this.leaderboard = [];

    // 初始食物
    for (let i = 0; i < FOOD_COUNT; i++) {
      const p = randomPointInCircle(WORLD_RADIUS * 0.98);
      const id = 'f' + (this.foodSeq++);
      this.foods.set(id, {
        id,
        x: p.x,
        y: p.y,
        value: FOOD_VALUE,
        color: COLORS[Math.floor(Math.random() * COLORS.length)],
      });
    }
  }

  get playerCount() { return this.snakes.size; }
  get aliveCount() {
    let n = 0;
    for (const s of this.snakes.values()) if (s.alive) n++;
    return n;
  }

  addFood(x, y, value) {
    const id = 'f' + (this.foodSeq++);
    this.foods.set(id, {
      id,
      x: x + rand(-8, 8),
      y: y + rand(-8, 8),
      value,
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
    });
  }

  addSnake(ws, name) {
    const id = 's' + Math.random().toString(36).slice(2, 9);
    const color = COLORS[this.snakes.size % COLORS.length];
    const snake = new Snake(id, name, color, this);

    // 【体验优化】新玩家出生在「已有玩家的附近」，而不是随机全图。
    // 否则玩家进房间后可能几千像素外，互相看不到也打不到，体验很差。
    // 第一个玩家随机出生，后续玩家在前一个玩家周围 300-700 像素的环形区域出生。
    const existing = [...this.snakes.values()];
    if (existing.length > 0) {
      const anchor = existing[Math.floor(Math.random() * existing.length)];
      const angle = Math.random() * Math.PI * 2;
      // 距离：不能太近（重叠），也不能太远（看不到）
      const dist = 300 + Math.random() * 400;
      let nx = anchor.x + Math.cos(angle) * dist;
      let ny = anchor.y + Math.sin(angle) * dist;

      // 保证不超出安全区域（用 0.7 而不是 0.88，留出活动空间）
      const d = Math.sqrt(nx * nx + ny * ny);
      const maxR = WORLD_RADIUS * 0.7;
      if (d > maxR) {
        nx = nx * maxR / d;
        ny = ny * maxR / d;
      }

      snake.x = nx;
      snake.y = ny;
      snake.angle = Math.random() * Math.PI * 2;
      snake.targetAngle = snake.angle;
      // 重建蛇身
      snake.body = [];
      for (let i = 0; i < INIT_LENGTH; i++) {
        snake.body.push({
          x: nx - Math.cos(snake.angle) * i * BODY_SPACING,
          y: ny - Math.sin(snake.angle) * i * BODY_SPACING,
        });
      }
    }
    snake.ws = ws;
    this.snakes.set(id, snake);

    // 保证食物数量
    while (this.foods.size < FOOD_COUNT) {
      const p = randomPointInCircle(WORLD_RADIUS * 0.98);
      const fid = 'f' + (this.foodSeq++);
      this.foods.set(fid, {
        id: fid, x: p.x, y: p.y, value: FOOD_VALUE,
        color: COLORS[Math.floor(Math.random() * COLORS.length)],
      });
    }

    if (!this.timer) this.start();
    return snake;
  }

  removeSnake(id) {
    this.snakes.delete(id);
    if (this.snakes.size === 0) this.stop();
  }

  start() {
    this.started = true;
    this.scheduleTick();
    log(`[房间 ${this.id}] 游戏循环启动`);
  }

  /**
   * 用递归 setTimeout 而不是 setInterval。
   * setInterval 在 tick 耗时超过间隔时会产生任务堆积，
   * 导致实际帧率远低于预期（实测只有 10 FPS 而不是 30 FPS）。
   */
  scheduleTick(delay = TICK_MS) {
    if (!this.started) return;
    this.timer = setTimeout(() => {
      const t0 = process.hrtime.bigint();
      try {
        this.tick();
      } catch (e) {
        log(`[房间 ${this.id}] tick 异常: ${e.message}`);
      }
      const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
      this.lastTickMs = elapsedMs;
      // 下次延迟 = 目标间隔 - 本帧耗时（不低于 1ms）。
      // 必须真的把这个延迟传回 scheduleTick：原先固定等 TICK_MS，
      // 再叠加本帧耗时，实测帧率只有 15 FPS。
      this.scheduleTick(Math.max(1, TICK_MS - elapsedMs));
    }, Math.max(1, delay));
  }

  stop() {
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  tick() {
    const now = Date.now();
    const alive = [...this.snakes.values()].filter(s => s.alive);

    // 1. 每个蛇移动
    for (const s of alive) {
      // 处理输入队列：只取最新的角度（避免积压导致转向延迟）
      let latestAngle = null;
      while (s.inputQueue.length) {
        const inp = s.inputQueue.shift();
        if (inp.type === 'angle') latestAngle = inp.value;
      }
      if (latestAngle !== null) s.targetAngle = latestAngle;

      s.move(now);
    }

    // 2. 边界判定：出圈即死
    for (const s of alive) {
      const d = Math.sqrt(s.x * s.x + s.y * s.y);
      if (d > WORLD_RADIUS) {
        this.killSnake(s, '撞到了边界', null);
      }
    }

    // 3. 碰撞判定：蛇头撞到别人的身体
    // 先收集所有命中，再统一结算 —— 避免"谁的判定先跑谁占便宜"的偏差
    const stillAlive = [...this.snakes.values()].filter(s => s.alive);
    const hitDist2 = (HEAD_RADIUS + BODY_RADIUS) ** 2;
    const headOnPairs = [];   // 头对头：双方都死，不算击杀
    const bodyHits = [];      // 撞到身体：撞的一方死，被撞的一方记一次击杀

    for (const s of stillAlive) {
      for (const other of stillAlive) {
        if (other.id === s.id) continue;

        // 蛇头撞到对方身体（跳过最近几节，避免贴身/刚出生时误判）
        let bodyHit = false;
        for (let i = 3; i < other.body.length; i++) {
          const seg = other.body[i];
          if (dist2(s.x, s.y, seg.x, seg.y) < hitDist2) { bodyHit = true; break; }
        }
        if (bodyHit) { bodyHits.push([s, other]); continue; }

        // 头对头：两个头贴近，且"双方互相都在对方正前方"（对称条件）
        //   对撞     A→B 与 B→A 各自都在自己正前方  -> 判头对头
        //   追逐     B 在 A 前方，但 A 在 B 正后方     -> 不算，B 该撞 A 身体
        //   并排     连线垂直于双方朝向               -> 不算
        //   刚贴身   距离已低于身体半径               -> 不算
        // 反过来，只判"对方在我前方"会把追逐误判成对撞。
        const dx = other.x - s.x;
        const dy = other.y - s.y;
        const d2 = dx * dx + dy * dy;
        const contactDist2 = (BODY_RADIUS * 2) ** 2;
        if (d2 < (HEAD_RADIUS * 2) ** 2 && d2 > contactDist2) {
          const inv = 1 / Math.sqrt(d2);
          const sFwd = (Math.cos(s.angle) * dx + Math.sin(s.angle) * dy) * inv;
          const oFwd = -(Math.cos(other.angle) * dx + Math.sin(other.angle) * dy) * inv;
          const limit = Math.cos((60 * Math.PI) / 180);
          if (sFwd > limit && oFwd > limit) {
            headOnPairs.push([s, other]);
          }
        }
      }
    }

    // 头对头同归于尽：不记击杀，也不给任何一方加分
    const headOnDead = new Set();
    for (const [a, b] of headOnPairs) {
      if (headOnDead.has(a.id) || headOnDead.has(b.id)) continue;
      headOnDead.add(a.id);
      headOnDead.add(b.id);
      this.killSnake(a, `和 ${b.name} 头对头`, b);
      this.killSnake(b, `和 ${a.name} 头对头`, a);
    }

    // 撞身体：只有撞的一方死，且被杀的一方得记分
    for (const [s, other] of bodyHits) {
      if (!s.alive || headOnDead.has(s.id)) continue;
      this.killSnake(s, `撞到了 ${other.name}`, other);
      if (other.alive) other.kills++;
      recordKill({
        room: this.id,
        killer: other.name,
        victim: s.name,
        time: Date.now(),
      });
    }

    // 4. 吃食物
    for (const s of [...this.snakes.values()].filter(x => x.alive)) {
      const headR2 = (HEAD_RADIUS + FOOD_RADIUS) ** 2;
      for (const [fid, f] of this.foods) {
        if (dist2(s.x, s.y, f.x, f.y) < headR2) {
          this.foods.delete(fid);
          s.eat(f.value);
        }
      }
    }

    // 5. 补充食物
    while (this.foods.size < FOOD_COUNT) {
      const p = randomPointInCircle(WORLD_RADIUS * 0.98);
      const fid = 'f' + (this.foodSeq++);
      this.foods.set(fid, {
        id: fid, x: p.x, y: p.y, value: FOOD_VALUE,
        color: COLORS[Math.floor(Math.random() * COLORS.length)],
      });
    }

    // 6. 更新排行榜
    this.updateLeaderboard();

    // 7. 广播状态
    this.broadcastState();
  }

  killSnake(snake, reason, killer) {
    if (!snake.alive) return;
    snake.die(reason, killer);

    // 掉落食物：沿蛇身位置散落
    for (let i = 0; i < snake.body.length; i += 2) {
      const seg = snake.body[i];
      for (let k = 0; k < DEATH_FOOD_RATIO; k++) {
        this.addFood(seg.x, seg.y, 1);
      }
    }

    recordDeath({
      room: this.id,
      name: snake.name,
      reason,
      score: Math.floor(snake.score),
      length: Math.floor(snake.length),
      time: Date.now(),
    });

    log(`[房间 ${this.id}] ${snake.name} 死亡（${reason}），得分 ${Math.floor(snake.score)}`);

    // 通知本人
    if (snake.ws && snake.ws.readyState === 1) {
      try {
        snake.ws.send(JSON.stringify({
          t: 'dead',
          reason,
          killer: killer ? killer.name : null,
          score: Math.floor(snake.score),
          rank: this.getRank(snake),
        }));
      } catch (e) {}
    }
  }

  getRank(snake) {
    const sorted = [...this.snakes.values()]
      .filter(s => s.alive)
      .sort((a, b) => b.score - a.score);
    const idx = sorted.indexOf(snake);
    return idx >= 0 ? idx + 1 : sorted.length + 1;
  }

  updateLeaderboard() {
    this.leaderboard = [...this.snakes.values()]
      .filter(s => s.alive)
      .sort((a, b) => b.score - a.score)
      .slice(0, 10)
      .map((s, i) => ({
        rank: i + 1,
        name: s.name,
        score: Math.floor(s.score),
        color: s.color,
      }));
  }

  broadcastState() {
    // 为每个玩家构造视野内的数据（只发附近的食物和蛇）
    for (const s of this.snakes.values()) {
      if (!s.alive || !s.ws || s.ws.readyState !== 1) continue;

      const viewRadius = 1200;
      const viewR2 = viewRadius * viewRadius;

      // 【带宽优化】食物是静止的，没必要每帧重发全部坐标。
      // 只有"上次下发后玩家移动超过 200px"时才重发全量视野食物，
      // 其余帧只发被吃掉消失的那些 id（rem）。
      // 原来每帧 238 个食物 ≈ 13KB，30 FPS 下每人下行 ~390KB/s，
      // 是画面卡顿的主要来源。
      const movedX = s.x - (s._foodRefX ?? 1e9);
      const movedY = s.y - (s._foodRefY ?? 1e9);
      const needFull = !s._foodRefX || (movedX * movedX + movedY * movedY) > 200 * 200;

      let foods = null;
      const rem = [];

      if (needFull) {
        foods = [];
        s._foodIds = s._foodIds || new Set();
        const nowIds = new Set();
        for (const f of this.foods.values()) {
          if (dist2(s.x, s.y, f.x, f.y) < viewR2) {
            foods.push({ i: f.id, x: Math.round(f.x), y: Math.round(f.y), c: f.color });
            nowIds.add(f.id);
          }
        }
        // 上一批里消失的（被吃掉）告诉客户端删掉
        for (const oldId of s._foodIds) {
          if (!nowIds.has(oldId)) rem.push(oldId);
        }
        s._foodIds = nowIds;
        s._foodRefX = s.x;
        s._foodRefY = s.y;
      }

      // 只发视野内的蛇
      const snakes = [];
      for (const other of this.snakes.values()) {
        if (!other.alive) continue;
        if (dist2(s.x, s.y, other.x, other.y) > (viewRadius * 1.5) ** 2) continue;
        snakes.push(other.serialize());
      }

      const payload = {
        t: 'state',
        me: {
          id: s.id,
          x: Math.round(s.x),
          y: Math.round(s.y),
          angle: +s.angle.toFixed(3),
          length: Math.floor(s.length),
          score: Math.floor(s.score),
          kills: s.kills,
          boosting: s.boosting && s.canBoost,
          canBoost: s.canBoost,
        },
        snakes,
        foods,
        rem,
        leaderboard: this.leaderboard,
        world: { r: WORLD_RADIUS },
      };

      try {
        s.ws.send(JSON.stringify(payload));
      } catch (e) {}
    }
  }

  info() {
    return {
      id: this.id,
      playerCount: this.playerCount,
      aliveCount: this.aliveCount,
      foodCount: this.foods.size,
      started: this.started,
      createdAt: this.createdAt,
      snakes: [...this.snakes.values()].map(s => s.info()),
      leaderboard: this.leaderboard,
    };
  }
}

// ---------------------------------------------------------------------------
// 房间管理
// ---------------------------------------------------------------------------
const rooms = new Map();

function getRoom(id) {
  let room = rooms.get(id);
  if (!room) {
    room = new Room(id);
    rooms.set(id, room);
    log(`[房间 ${id}] 创建`);
  }
  return room;
}

// ---------------------------------------------------------------------------
// HTTP 服务 + 管理 API
// ---------------------------------------------------------------------------
function json(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(obj, null, 2));
}

function checkAdmin(req, res) {
  const url = new URL(req.url, 'http://x');
  const token = req.headers['x-admin-token'] || url.searchParams.get('token');
  if (token !== ADMIN_TOKEN) {
    json(res, 401, { error: 'unauthorized' });
    return false;
  }
  return true;
}

const httpServer = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');

  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok\n');
    return;
  }

  if (url.pathname === '/admin/api/overview') {
    if (!checkAdmin(req, res)) return;
    const mem = process.memoryUsage();
    let online = 0, totalSnakes = 0;
    for (const r of rooms.values()) {
      online += r.aliveCount;
      totalSnakes += r.playerCount;
    }
    if (totalSnakes > stats.peakOnline) stats.peakOnline = totalSnakes;

    json(res, 200, {
      uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
      online,
      totalConnections: stats.totalConnections,
      peakOnline: stats.peakOnline,
      totalDeaths: stats.totalDeaths,
      rooms: rooms.size,
      tickRate: TICK_RATE,
      memory: {
        rssMB: +(mem.rss / 1048576).toFixed(1),
        heapUsedMB: +(mem.heapUsed / 1048576).toFixed(1),
      },
      system: {
        loadavg: os.loadavg().map(v => +v.toFixed(2)),
        freeMemMB: Math.round(os.freemem() / 1048576),
        totalMemMB: Math.round(os.totalmem() / 1048576),
        cpus: os.cpus().length,
      },
      deathHistory: stats.deathHistory.slice(0, 20),
      killHistory: stats.killHistory.slice(0, 20),
    });
    return;
  }

  if (url.pathname === '/admin/api/rooms') {
    if (!checkAdmin(req, res)) return;
    json(res, 200, {
      rooms: [...rooms.values()].map(r => r.info()),
    });
    return;
  }

  if (url.pathname.startsWith('/admin/api/kick/') && req.method === 'POST') {
    if (!checkAdmin(req, res)) return;
    const id = url.pathname.split('/').pop();
    const room = rooms.get(id);
    if (!room) { json(res, 404, { error: 'not found' }); return; }
    for (const s of room.snakes.values()) {
      try {
        s.ws.send(JSON.stringify({ t: 'kicked', reason: '房间已被管理员关闭' }));
        s.ws.close();
      } catch (e) {}
    }
    room.stop();
    rooms.delete(id);
    log(`[管理] 关闭房间 ${id}`);
    json(res, 200, { ok: true });
    return;
  }

  if (url.pathname.startsWith('/admin/api/kill/') && req.method === 'POST') {
    if (!checkAdmin(req, res)) return;
    // /admin/api/kill/{roomId}/{snakeId}
    const parts = url.pathname.split('/');
    const snakeId = parts.pop();
    const roomId = parts.pop();
    const room = rooms.get(roomId);
    if (!room) { json(res, 404, { error: 'room not found' }); return; }
    const snake = room.snakes.get(snakeId);
    if (!snake) { json(res, 404, { error: 'snake not found' }); return; }
    room.killSnake(snake, '被管理员击杀', null);
    log(`[管理] 击杀 ${snake.name}`);
    json(res, 200, { ok: true });
    return;
  }

  json(res, 404, { error: 'not found' });
});

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------
const wss = new WebSocketServer({ server: httpServer, maxPayload: 4096 });

wss.on('connection', (ws) => {
  stats.totalConnections++;
  let snake = null;
  let room = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (e) { return; }

    switch (msg.t) {
      case 'join': {
        const roomId = String(msg.room || 'default').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 20) || 'default';
        room = getRoom(roomId);

        if (room.playerCount >= MAX_PLAYERS_PER_ROOM) {
          ws.send(JSON.stringify({ t: 'error', message: `房间已满（最多 ${MAX_PLAYERS_PER_ROOM} 人）` }));
          return;
        }

        snake = room.addSnake(ws, msg.name);
        stats.totalGames++;

        ws.send(JSON.stringify({
          t: 'joined',
          id: snake.id,
          name: snake.name,
          color: snake.color,
          world: { r: WORLD_RADIUS },
        }));

        log(`[房间 ${roomId}] ${snake.name} 加入（当前 ${room.playerCount} 人）`);
        break;
      }

      case 'input': {
        if (!snake || !snake.alive) return;

        // 【重要】限流方式：队列满时丢弃「最旧」的输入，而不是丢弃新输入。
        // 之前写成 `if (length > 10) return;`，导致客户端高频输入时
        // 队列一满，后续所有输入（包括加速）都被丢弃，蛇就不听使唤了。
        if (snake.inputQueue.length > 8) {
          snake.inputQueue.shift();    // 丢弃最旧的
        }

        if (msg.type === 'angle' && typeof msg.value === 'number' && isFinite(msg.value)) {
          snake.inputQueue.push({ type: 'angle', value: msg.value });
        } else if (msg.type === 'boost' && typeof msg.value === 'boolean') {
          // 加速是状态型指令，直接生效，不走队列（避免被角度指令挤掉）
          snake.boosting = msg.value;
        }
        break;
      }

      case 'respawn': {
        // 死后重新开始（保留在同一房间，但作为新蛇）
        if (!room || !snake) return;
        if (snake.alive) return;    // 还活着不能重生

        const oldName = snake.name;
        room.snakes.delete(snake.id);

        const newSnake = room.addSnake(ws, oldName);
        snake = newSnake;

        ws.send(JSON.stringify({
          t: 'joined',
          id: snake.id,
          name: snake.name,
          color: snake.color,
          world: { r: WORLD_RADIUS },
          respawn: true,
        }));
        log(`[房间 ${room.id}] ${oldName} 重生`);
        break;
      }

      case 'ping':
        ws.send(JSON.stringify({ t: 'pong', ts: Date.now() }));
        break;
    }
  });

  ws.on('close', () => {
    if (room && snake) {
      room.removeSnake(snake.id);
      log(`[房间 ${room.id}] ${snake.name} 离开（剩余 ${room.playerCount} 人）`);
      if (room.playerCount === 0) {
        rooms.delete(room.id);
        log(`[房间 ${room.id}] 已销毁（无人）`);
      }
    }
  });

  ws.on('error', () => {});
});

// 清理空房间
setInterval(() => {
  for (const [id, room] of rooms) {
    if (room.playerCount === 0) {
      room.stop();
      rooms.delete(id);
      log(`[清理] 空房间 ${id}`);
    }
  }
}, 30000);

httpServer.listen(PORT, () => {
  log(`贪吃蛇大作战服务器启动: http://0.0.0.0:${PORT}`);
  log(`地图半径: ${WORLD_RADIUS}，${TICK_RATE.toFixed(0)} FPS，食物: ${FOOD_COUNT}`);
  log(`管理接口: /admin/api/overview?token=***`);
});
