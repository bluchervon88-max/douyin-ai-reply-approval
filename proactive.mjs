// proactive.mjs — 「她会不会主动开口」的判定 + 开场白生成
// 独立模块：不 import watcher10.mjs / draft2.mjs。key 读法、soul()、BANNED、call() 的形状与 draft2 保持一致。
// 所有时间按 Asia/Shanghai 计算；now 一律是毫秒时间戳。
//
// state 里用到的字段（缺省即默认）：
//   proactiveOn: false            — 总开关
//   proactiveHours: "09:00-23:30" — 允许开口的时段（支持跨午夜，如 "23:00-02:00"）
//   proactiveCooldownMin: 180     — 两次主动开口的最小间隔（分钟）
//   proactiveDailyCap: 2          — 每天最多主动几次
//   lastProactiveAt: 0            — 上次主动开口的时间戳
//   proactiveDay: ""              — "YYYY-MM-DD"，配合 proactiveCount 做日切
//   proactiveCount: 0             — 当天已主动几次
//   proactiveIdleMin: 120         — 会话冷场多久（分钟）才算"该开口"
//   proactivePerConvWeek: 2       — 7 天内对同一会话最多主动几次
//   proactiveLog: []              — [{ conv, at }]，只留最近 50 条
//   autoConvs / muted / allowedGroups / convs[conv].lastActivityAt|lastBufferAt — 读，不改

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HOME = homedir();
const SOUL_PATH = process.env.SOUL_PATH || join(dirname(fileURLToPath(import.meta.url)), "persona", "SOUL.md");
const TZ = "Asia/Shanghai";

const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

/* ===================== 时间 ===================== */

const _fmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
const _wd = new Intl.DateTimeFormat("zh-CN", { timeZone: TZ, weekday: "long" });

function shanghaiParts(now = Date.now()) {
  const out = {};
  for (const p of _fmt.formatToParts(new Date(num(now, Date.now())))) {
    if (p.type !== "literal") out[p.type] = p.value;
  }
  return out;
}

/** 上海时区的 "YYYY-MM-DD"。 */
export function todayStr(now = Date.now()) {
  const p = shanghaiParts(now);
  return p.year + "-" + p.month + "-" + p.day;
}

/** 上海时区的 "HH:mm"（24 小时制，补零）。 */
export function nowHM(now = Date.now()) {
  const p = shanghaiParts(now);
  return p.hour + ":" + p.minute;
}

function toMin(hm) {
  const m = String(hm == null ? "" : hm).trim().match(/^(\d{1,2}):(\d{1,2})$/);
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

/**
 * hm 是否落在 range 内。range 默认 "09:00-23:30"。
 * 支持跨午夜（"23:00-02:00"）。两端都算在内（23:30 在 "09:00-23:30" 里，23:31 不在）。
 * range 写坏 → 返回 true（fail-open，别因为配置手滑就永远不开口）。
 */
export function inActiveHours(hm, range = "09:00-23:30") {
  const cur = toMin(hm);
  if (cur == null) return false;
  const pair = String(range == null ? "" : range).split(/\s*-\s*/);
  const start = toMin(pair[0]);
  const end = toMin(pair[1]);
  if (start == null || end == null) return true;
  if (start === end) return true;            // 起止相同 → 全天
  if (start < end) return cur >= start && cur <= end;
  return cur >= start || cur <= end;         // 跨午夜
}

/* ===================== 该不该开口 ===================== */

/**
 * 是否该主动开口。
 * @returns {{ok: boolean, why: string}} why ∈ "ok" | "没开" | "不在时段" | "刚说过" | "今天说够了"
 */
export function plan({ state, now = Date.now(), rnd = Math.random } = {}) {
  const s = state || {};
  // rnd 保留（和 pickConv 同签名），判定本身不做抖动，保证可测/可复现
  void rnd;

  if (s.proactiveOn !== true) return { ok: false, why: "没开" };

  if (!inActiveHours(nowHM(now), s.proactiveHours || "09:00-23:30")) {
    return { ok: false, why: "不在时段" };
  }

  const cooldownMin = num(s.proactiveCooldownMin, 180);
  const last = num(s.lastProactiveAt, 0);
  if (last > 0 && now >= last && now - last < cooldownMin * 60000) {
    return { ok: false, why: "刚说过" };
  }

  const cap = num(s.proactiveDailyCap, 2);
  const count = s.proactiveDay === todayStr(now) ? num(s.proactiveCount, 0) : 0;
  if (count >= cap) return { ok: false, why: "今天说够了" };

  return { ok: true, why: "ok" };
}

/* ===================== 该对谁开口 ===================== */

/**
 * 从 state.autoConvs 里挑一个"冷场"的会话。
 * 排除：muted、群（allowedGroups 里的名字）、没有时间戳的、券用光（7 天内已主动够次数的）。
 * @returns {string|null}
 */
export function pickConv({ state, now = Date.now(), rnd = Math.random } = {}) {
  const s = state || {};
  const list = Array.isArray(s.autoConvs) ? s.autoConvs : [];
  const muted = new Set((s.muted || []).map(x => String(x).trim()));
  const groups = new Set((s.allowedGroups || []).map(x => String(x).trim()));
  const convs = s.convs || {};
  const idleMin = num(s.proactiveIdleMin, 120);
  const perWeek = num(s.proactivePerConvWeek, 2);
  const WEEK = 7 * 24 * 60 * 60 * 1000;
  const log = Array.isArray(s.proactiveLog) ? s.proactiveLog : [];
  const since = num(now, Date.now()) - WEEK;

  const cands = [];
  const seen = new Set();
  for (const raw of list) {
    const conv = String(raw == null ? "" : raw).trim();
    if (!conv || seen.has(conv)) continue;
    seen.add(conv);
    if (muted.has(conv)) continue;
    if (groups.has(conv)) continue;               // 群里不主动私聊

    const st = convs[conv] || {};
    const lastAt = num(st.lastActivityAt, 0) || num(st.lastBufferAt, 0);
    if (!lastAt) continue;                        // 从没聊过 → 不突然冒出来

    const idle = now - lastAt;
    if (idle < idleMin * 60000) continue;         // 还没冷场

    let used = 0;
    for (const e of log) {
      if (!e) continue;
      if (String(e.conv == null ? "" : e.conv).trim() !== conv) continue;
      if (num(e.at, 0) > since) used++;
    }
    if (used >= perWeek) continue;                // 这个会话的券用光了

    cands.push({ conv, idle });
  }

  if (!cands.length) return null;
  cands.sort((a, b) => b.idle - a.idle);          // 越冷门越靠前
  const r = typeof rnd === "function" ? Number(rnd()) : 0;
  const i = Math.min(cands.length - 1, Math.max(0, Math.floor(num(r, 0) * cands.length)));
  return cands[i].conv;
}

/** 记一次主动开口（就地改 state）。 */
export function recordProactive({ state, conv = "", now = Date.now() } = {}) {
  const s = state || {};
  const day = todayStr(now);
  if (s.proactiveDay !== day) { s.proactiveDay = day; s.proactiveCount = 0; }
  s.proactiveCount = num(s.proactiveCount, 0) + 1;
  s.lastProactiveAt = num(now, Date.now());
  s.lastProactiveConv = String(conv == null ? "" : conv);

  const log = Array.isArray(s.proactiveLog) ? s.proactiveLog : (s.proactiveLog = []);
  log.push({ conv: s.lastProactiveConv, at: s.lastProactiveAt });
  if (log.length > 50) s.proactiveLog = log.slice(-50);
  return s;
}

/* ===================== 生成开场白 ===================== */

function apiKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  try {
    const cmd = readFileSync(join(HOME, ".openclaw", "gateway.cmd"), "utf8");
    const m = cmd.match(/set "DEEPSEEK_API_KEY=([^"]+)"/);
    if (m) return m[1];
  } catch {}
  return null;
}

function soul() {
  let s = "";
  try { s = readFileSync(SOUL_PATH, "utf8"); } catch {}
  return s.split("## 当前状态")[0].trim();
}

async function call(messages, maxTokens = 200, temp = 1.15) {
  const key = apiKey();
  if (!key) throw new Error("no DEEPSEEK_API_KEY");
  const r = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
    body: JSON.stringify({
      model: "deepseek-flash",
      messages,
      temperature: temp,
      max_tokens: maxTokens,
      stream: false,
      thinking: { type: "disabled" },
    }),
    signal: AbortSignal.timeout(60000),
  });
  const j = await r.json();
  return { text: j && j.choices && j.choices[0] && j.choices[0].message ? j.choices[0].message.content || "" : "", usage: (j && j.usage) || null };
}

const BANNED = /怎么了|发生什么|需要我|需要帮|我理解|抱歉|不好意思|哈哈|嗯嗯|好的|在的|有什么事|有什么可以|别难过|加油哦|希望/;

const clean = (s) => String(s == null ? "" : s).trim()
  .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
  .replace(/^(\d{1,2}[.、)]\s+|[-*]\s+)/, "")
  .replace(/\s+/g, " ")
  .trim();

function nowLine(now = Date.now()) {
  const p = shanghaiParts(now);
  const h = Number(p.hour);
  const phase = h < 6 ? "凌晨" : h < 11 ? "上午" : h < 14 ? "中午" : h < 18 ? "下午" : h < 23 ? "晚上" : "深夜";
  return Number(p.month) + "月" + Number(p.day) + "日 " + _wd.format(new Date(num(now, Date.now()))) + " " + p.hour + ":" + p.minute + "（" + phase + "）";
}

const SCENE =
  "【场景】你不是在回消息，是你自己想说话了。就发一句短的（5-20 字），像随手发一条。" +
  "不要接对方上一句话，不要提「你刚」「你刚才」「你说」「上次」这类指代；" +
  "不要复述数字、表情或很短的消息；不要问「在吗」、不要解释为什么突然说话、不要提 AI/系统/测试、不要超过 20 字。";

const STALE_REF = /你刚|你刚才|你说|上次|刚才说/;

function transcript(ctx) {
  const arr = Array.isArray(ctx) ? ctx.slice(-8) : [];
  const t = arr
    .map(m => (m && m.mine ? "我：" : "对方：") + String((m && m.text) == null ? "" : m.text).replace(/\s+/g, " ").slice(0, 60))
    .filter(x => x.length > 3)
    .join("\n");
  return t || "（还没聊过，或者很久没说话了）";
}

function lifeBits(life) {
  const L = life || {};
  const bits = [];
  if (L.mood) bits.push("心情：" + String(L.mood).slice(0, 80));
  if (Array.isArray(L.today) && L.today.length) bits.push("今天：" + L.today.slice(-3).map(String).join(" / ").slice(0, 160));
  if (Array.isArray(L.life) && L.life.length) bits.push("近况：" + L.life.slice(-2).map(String).join(" / ").slice(0, 160));
  if (L.today && typeof L.today === "string") bits.push("今天：" + L.today.slice(0, 160));
  if (L.life && typeof L.life === "string") bits.push("近况：" + L.life.slice(0, 160));
  return bits;
}

/** PROACTIVE_DRY=1 时的固定样例（联调用，不调 API）。 */
export const DRY_OPENING = "在干嘛呢";

/**
 * 生成 1 条她自己主动发的开场白。
 * @param {{conv?: string, ctx?: Array<{mine: boolean, text: string}>, life?: {mood?: string, today?: string[]|string, life?: string[]|string}|null, rnd?: () => number}} o
 * @returns {Promise<string|null>} 生成失败/不合规（空、>40 字、命中 BANNED）→ 重试 2 次后返回 null
 */
export async function makeOpening({ conv = "", ctx = [], life = null, rnd = Math.random, onUsage = null } = {}) {
  void rnd;
  if (process.env.PROACTIVE_DRY === "1") return DRY_OPENING;

  const bits = lifeBits(life);
  const user = [
    "现在是 " + nowLine(),
    "你要给「" + String(conv || "对方") + "」发一条你自己想发的话——没人叫你，是你自己想说了。",
    bits.length ? "【此刻】\n" + bits.join("\n") : "",
    "【最近对话】\n" + transcript(ctx),
    "只输出你要发的那一句，不要引号、不要解释、不要分条、不要加署名。",
  ].filter(Boolean).join("\n\n");

  const messages = [
    { role: "system", content: soul() + "\n\n" + SCENE },
    { role: "user", content: user },
  ];

  for (let attempt = 0; attempt < 3; attempt++) {   // 首次 + 最多 2 次重试
    let raw = "";
    try { const rr = await call(messages, 200, 1.15); if (onUsage) { try { onUsage(rr.usage); } catch {} } raw = rr.text; } catch { continue; }
    const t = clean(raw);
    if (!t) continue;
    if (t.length > 40) continue;
    if (BANNED.test(t)) continue;
    if (STALE_REF.test(t)) continue;
    if (/在吗|在嘛/.test(t)) continue;
    return t;
  }
  return null;
}


/**
 * 把模型输出解析成候选（纯函数，方便测试）。
 * 只接受：一行一条、去编号、5-40 字、不命中 BANNED/STALE_REF/在吗，去重，最多 n 条。
 */
export function parseOpenings(raw, n = 4) {
  const limit = Math.max(1, Math.min(6, Number(n) || 4));
  const out = [];
  const seen = new Set();
  for (const line of String(raw == null ? "" : raw).split(/\r?\n/)) {
    const t = clean(line)
      .replace(/^\d{1,2}[.、)]\s*/, "")
      .replace(/^[-*]\s+/, "")
      .trim();
    if (!t || t.length > 40) continue;
    if (/^(好的|可以|没问题|以下|候选|给你|这是)/.test(t)) continue;
    if (BANNED.test(t) || STALE_REF.test(t) || /在吗|在嘛/.test(t)) continue;
    const k = t.replace(/\s+/g, "").toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * 用户点名「给某个人主动发一句」时，一次生成多条候选。
 * 和 makeOpening 的区别：带 topic（用户想表达的意思）和 hint（改短/改狠等），并且返回候选列表。
 * @returns {Promise<string[]>} 生成失败返回 []
 */
export async function makeOpenings({ conv = "", ctx = [], life = null, topic = "", hint = "", n = 4, onUsage = null } = {}) {
  const N = Math.max(2, Math.min(6, Number(n) || 4));
  if (process.env.PROACTIVE_DRY === "1") return [DRY_OPENING];

  const bits = lifeBits(life);
  const topicText = String(topic == null ? "" : topic).replace(/\s+/g, " ").trim().slice(0, 300);
  const hintText = String(hint == null ? "" : hint).replace(/\s+/g, " ").trim().slice(0, 60);
  const user = [
    "现在是 " + nowLine(),
    "你要给「" + String(conv || "对方") + "」发一条你自己想发的话——没人叫你，是你自己想说了。",
    bits.length ? "【此刻】\n" + bits.join("\n") : "",
    "【最近对话】\n" + transcript(ctx),
    topicText ? "【这次想说的意思】\n" + topicText : "【这次想说的意思】\n你自己想一句，别太刻意。",
    hintText ? "【额外要求】\n" + hintText : "",
    "写 " + N + " 条不同方向的候选，每条 5-20 字，像随手发的。一条一行，用 1. 2. 3. 开头；不要解释、不要引号、不要分条以外的内容。",
    "不要照抄【这次想说的意思】原话，用你自己的口气说。",
  ].filter(Boolean).join("\n\n");

  const messages = [
    { role: "system", content: soul() + "\n\n" + SCENE },
    { role: "user", content: user },
  ];

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const rr = await call(messages, Math.max(240, N * 80), 1.15);
      if (onUsage) { try { onUsage(rr.usage); } catch {} }
      const list = parseOpenings(rr.text, N);
      if (list.length) return list;
    } catch {}
  }
  return [];
}
