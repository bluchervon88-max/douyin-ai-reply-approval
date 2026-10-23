
/**
 * 每个人的记忆（Douyin DM）
 *
 * 抖音号里她跟一堆人（私信）和群聊说话。这里给「每个会话」单独存一份记忆：
 *   - 原始往来：people/<slug>.json → log[]（从 watcher 的 state.json 的 ctx 里吸，双向）
 *   - 人物档案：profile{ who, relation, style, topics, lastState }（deepseek-flash 定期整理）
 *
 * draft2.mjs 生成草稿前调 memoryFor(conv)，把「这个人是谁 + 你俩最近说了啥」塞进 prompt。
 *
 * 用法：
 *   node people.mjs --tick        吸一遍 state.json，给新消息多的会话更新档案（定时任务用）
 *   node people.mjs --tick --force  忽略阈值，全部重建
 *   node people.mjs --show 某人    打印这个会话会被注入的记忆块
 *   node people.mjs --list         列出所有人
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const HOME = homedir();
const DIR = process.env.DOUYIN_DM_DIR || dirname(fileURLToPath(import.meta.url));
const PEOPLE = process.env.PEOPLE_DIR || join(DIR, "people");
const STATE = process.env.STATE_PATH || join(DIR, "state.json");
const LOG = process.env.PEOPLE_LOG || join(DIR, "people.log");
const LOG_CAP = 240;
const MIN_NEW_FOR_PROFILE = 6;

function logLine(m) {
  try { appendFileSync(LOG, new Date().toISOString() + "  " + m + "\n", "utf8"); } catch {}
}

function ensureDir() { try { mkdirSync(PEOPLE, { recursive: true }); } catch {} }

function slug(name) {
  const h = createHash("sha1").update(String(name)).digest("hex").slice(0, 10);
  return h;
}

function fileOf(name) { return join(PEOPLE, slug(name) + ".json"); }

// 昵称会改（加 emoji、改一个字），改完 slug 就变了、记忆会断档。
// baseName 去掉空白/标点/符号（emoji 属 \p{S}），只用来做「像不像同一个人」的兜底匹配。
function baseName(s) {
  return String(s || "").replace(/[\s\p{P}\p{S}]+/gu, "").toLowerCase();
}

// 顺序：直接命中 slug → 别名表命中 → 归一化名字唯一命中（命中后自动记进 alias）
function findPersonFile(name) {
  const direct = fileOf(name);
  if (existsSync(direct)) return direct;
  let files = [];
  try { files = readdirSync(PEOPLE).filter(f => f.endsWith(".json")); } catch { return null; }
  const all = [];
  for (const f of files) {
    let p;
    try { p = JSON.parse(readFileSync(join(PEOPLE, f), "utf8")); } catch { continue; }
    all.push({ file: join(PEOPLE, f), p });
  }
  const byAlias = all.find(x => (x.p.alias || []).includes(name));
  if (byAlias) return byAlias.file;
  const target = baseName(name);
  if (!target) return null;
  const fuzzy = all.filter(x => baseName(x.p.name) === target || (x.p.alias || []).some(a => baseName(a) === target));
  return fuzzy.length === 1 ? fuzzy[0].file : null;
}

function emptyPerson(name) {
  return { name, group: false, firstSeen: Date.now(), lastSeenAt: 0, log: [], seen: [], profile: null, profiledCount: 0, absorbed: 0, alias: [] };
}

function loadPerson(name) {
  const p = findPersonFile(name);
  if (!p) return emptyPerson(name);
  try {
    const o = JSON.parse(readFileSync(p, "utf8"));
    if (!o.name) o.name = name;
    return o;
  } catch { return emptyPerson(name); }
}

function savePerson(p) {
  try { writeFileSync(fileOf(p.name), JSON.stringify(p), "utf8"); } catch {}
}

function sleepMs(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch {}
}
function readState() {
  // watcher 每轮都可能整份重写 state.json，正好撞上读会读到半个文件
  for (let i = 0; i < 6; i++) {
    try {
      const o = JSON.parse(readFileSync(STATE, "utf8"));
      if (o && o.convs) return o;
    } catch {}
    if (i < 5) sleepMs(120);
  }
  return null;
}

function normText(s) {
  return String(s || "").replace(/[\s\p{P}\p{S}]+/gu, "").toLowerCase().slice(0, 30);
}

function hashItem(m) {
  return createHash("sha1").update((m.mine ? "1" : "0") + "|" + String(m.text || "").slice(0, 200)).digest("hex").slice(0, 16);
}

function appendToLog(person, items, seenSet) {
  let added = 0;
  for (const m of items) {
    const text = String(m.text || "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    const h = hashItem({ mine: m.mine, text });
    if (seenSet.has(h)) continue;
    seenSet.add(h);
    person.log.push({ at: Date.now(), mine: !!m.mine, text: text.slice(0, 160), h });
    added++;
  }
  if (person.log.length > LOG_CAP) person.log = person.log.slice(-LOG_CAP);
  return added;
}

// 兜底：watcher 发过的消息全在 douyin-memory.jsonl（{at, conv, incoming, sent}）。
// 有些会话没有 ctx（只出过卡、没重建过上下文），从这份流水里补，至少保持「我回过他什么」。
function absorbSendLog() {
  const f = join(DIR, "douyin-memory.jsonl");
  if (!existsSync(f)) return { touched: 0, added: 0 };
  let lines = [];
  try { lines = readFileSync(f, "utf8").split("\n").filter(Boolean); } catch { return { touched: 0, added: 0 }; }
  const byConv = new Map();
  for (const l of lines) {
    let o;
    try { o = JSON.parse(l); } catch { continue; }
    const name = String(o.conv || "");
    if (!name || name === "你") continue;
    if (!byConv.has(name)) byConv.set(name, []);
    const arr = byConv.get(name);
    if (o.incoming) arr.push({ mine: false, text: String(o.incoming) });
    if (o.sent) arr.push({ mine: true, text: String(o.sent) });
  }
  let touched = 0, added = 0;
  for (const [name, items] of byConv) {
    if (!items.length) continue;
    const person = loadPerson(name);
    const seenSet = new Set(person.seen || []);
    if (person.absorbed == null) person.absorbed = person.profiledCount || person.log.length;
    const n = appendToLog(person, items, seenSet);
    if (n) {
      person.absorbed += n;
      person.lastSeenAt = Date.now();
      person.seen = person.log.slice(-LOG_CAP).map(x => x.h);
      savePerson(person);
      touched++; added += n;
    }
  }
  return { touched, added };
}

function absorb(opts = {}) {
  ensureDir();
  const st = readState();
  if (!st) return { ok: false, why: "state.json 读不出来" };
  const convs = st.convs || {};
  const groupNames = new Set((st.autoGroups || []).map(String));
  let touched = 0, addedTotal = 0;
  for (const [name, c] of Object.entries(convs)) {
    if (!name || name === "你") continue;
    const person = loadPerson(name);
    if (!person.name) person.name = name;
    if (person.name !== name) person.alias = Array.from(new Set((person.alias || []).concat(name)));
    const wasGroup = !!person.group;
    if (c._group === true || groupNames.has(name)) person.group = true;
    else if (c._group === false && !groupNames.has(name)) person.group = false;
    const groupChanged = !!person.group !== wasGroup;
    if (person.absorbed == null) person.absorbed = person.profiledCount || person.log.length;
    const seenSet = new Set(person.seen || []);
    const sentKeys = new Set(((c.sent || []).map(x => normText(x.text))).filter(Boolean));
    const items = (c.ctx || []).concat([]);
    // ctx 兜底：没有 ctx 就用 recent(对方) + sent(自己)
    if (!items.length) {
      const merged = [];
      for (const x of (c.recent || [])) merged.push({ at: x.at || 0, mine: false, text: x.text });
      for (const x of (c.sent || [])) merged.push({ at: x.at || 0, mine: true, text: x.text });
      merged.sort((a, b) => a.at - b.at);
      for (const x of merged) items.push({ mine: x.mine, text: x.text });
    }
    // DOM 方向偶尔判反：发送登记里有的，一律算我（她）
    for (const m of items) {
      if (!m.mine && sentKeys.has(normText(m.text))) m.mine = true;
    }
    const added = appendToLog(person, items, seenSet);
    if (added) person.absorbed += added;
    if (added || groupChanged) {
      if (added) person.lastSeenAt = Date.now();
      person.seen = person.log.slice(-LOG_CAP).map(x => x.h);
      savePerson(person);
      if (added) { touched++; addedTotal += added; }
    }
  }
  const sl = absorbSendLog();
  return { ok: true, touched: touched + sl.touched, addedTotal: addedTotal + sl.added, fromSendLog: sl.added, convs: Object.keys(convs).length };
}

function apiKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  try {
    const gateway = process.env.OPENCLAW_GATEWAY_CMD || join(HOME, ".openclaw", "gateway.cmd");
    const cmd = readFileSync(gateway, "utf8");
    const m = cmd.match(/set "DEEPSEEK_API_KEY=([^"]+)"/);
    return m ? m[1] : null;
  } catch { return null; }
}

async function callLLM(messages, maxTokens = 300, temp = 0.4) {
  const key = apiKey();
  if (!key) throw new Error("no DEEPSEEK_API_KEY");
  const r = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
    body: JSON.stringify({ model: "deepseek-flash", messages, temperature: temp, max_tokens: maxTokens, stream: false, thinking: { type: "disabled" } }),
    signal: AbortSignal.timeout(45000),
  });
  const j = await r.json();
  return j?.choices?.[0]?.message?.content || "";
}

function parseJson(txt) {
  const m = String(txt).match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

function transcript(person, n = 40) {
  const other = person.group ? "群里：" : "对方：";
  return person.log.slice(-n).map(x => (x.mine ? "我：" : other) + x.text).join("\n");
}

async function buildProfile(person) {
  const lines = transcript(person, 40);
  if (person.log.length < 4) return null;
  const kind = person.group ? "群聊（对面是好几个人）" : "私聊（对面就是这一个人）";
  const fields = person.group
    ? [
        '{"who":"群里都有谁、各自怎么称呼（能认出几个写几个）",',
        ' "relation":"群里对 522 的态度、氛围（热不热闹、有没有人起哄）",',
        ' "style":"群里常见说法：谁爱@人、谁话多、用不用表情/图",',
        ' "topics":"最近反复出现的话题，2-3 个，顿号隔开",',
        ' "lastState":"上次群里说到哪、有没有点名 522 的话"}',
      ]
    : [
        '{"who":"对面是谁：身份或称呼、跟522什么关系（同学/网友/群友/不认识）",',
        ' "relation":"熟不熟、他会不会主动找522、说话客不客气",',
        ' "style":"他的固定说法：几个字、常用词、爱不爱用表情/图片/语音",',
        ' "topics":"最近反复出现的话题，2-3 个，顿号隔开",',
        ' "lastState":"上次说到哪、有没有没回的话、他求没求过522什么事"}',
      ];
  const prev = person.profile || {};
  const prevBits = ["who", "relation", "style"]
    .filter(k => prev[k])
    .map(k => ({ who: "是谁", relation: "关系", style: "说话习惯" }[k] + "：" + prev[k]));
  const prompt = [
    "下面是 522 和「" + person.name + "」的抖音聊天记录，" + kind + "。",
    "给 522 整理一份档案：她下次跟这人说话前扫一眼，就能接上话，不露怯。",
    prevBits.length ? "\n以前记过的（只是背景，记录里没矛盾就沿用，被推翻就改）：\n" + prevBits.join("\n") : "",
    "",
    lines,
    "",
    "输出 JSON。只写从记录里真能看出来的、对下次说话有用的事；",
    "看不出来就写空字符串 \"\"，不要写「不清楚」「不确定」「可能」「也许」。",
    ...fields,
    "每个字段不超过 40 字。不要编。",
  ].join("\n");
  const txt = await callLLM([
    { role: "system", content: "你是资料整理员，只根据给定聊天记录写人物档案：不确定的一律留空，不许编造。" },
    { role: "user", content: prompt },
  ], 340, 0.4);
  const j = parseJson(txt);
  if (!j) return null;
  const cut = (s, n = 60) => String(s || "").replace(/\s+/g, " ").trim().slice(0, n);
  const p = {
    who: cut(j.who), relation: cut(j.relation), style: cut(j.style),
    topics: cut(j.topics), lastState: cut(j.lastState),
    updatedAt: Date.now(), basedOn: person.log.length,
  };
  if (!p.who && !p.lastState) return null;
  return p;
}

export async function tick(opts = {}) {
  ensureDir();
  const ab = absorb();
  const files = (() => { try { return readdirSync(PEOPLE).filter(f => f.endsWith(".json")); } catch { return []; } })();
  let built = 0, failed = 0;
  for (const f of files) {
    let p;
    try { p = JSON.parse(readFileSync(join(PEOPLE, f), "utf8")); } catch { continue; }
    if (!p || !p.name) continue;
    if (p.name === "你") continue;
    if (p.absorbed == null) { p.absorbed = p.log.length; savePerson(p); }
    const absorbed = p.absorbed;
    const newSince = absorbed - (p.profiledCount || 0);
    if (!opts.force && newSince < MIN_NEW_FOR_PROFILE) continue;
    if (p.log.length < 4) continue;
    if (built >= 8) break;
    try {
      const prof = await buildProfile(p);
      if (prof) {
        p.profile = prof;
        p.profiledCount = absorbed;
        p.absorbed = absorbed;
        savePerson(p);
        built++;
      }
    } catch (e) {
      failed++;
      logLine("build fail " + p.name + ": " + String((e && e.message) || e).slice(0, 150));
    }
    await new Promise(r => setTimeout(r, 400));
  }
  const out = { ...ab, profilesBuilt: built, profilesFailed: failed, people: files.length };
  if (out.addedTotal || out.profilesBuilt || failed) logLine("tick " + JSON.stringify(out));
  return out;
}

export function memoryFor(name) {
  try {
    if (!name) return "";
    const p = loadPerson(name);
    if (!p || (!p.profile && !p.log.length)) return "";
    const out = [];
    const pr = p.profile || {};
    if (p.profile) {
      out.push(p.group
        ? "【关于群「" + name + "」（群里聊过 " + p.log.length + " 句）】"
        : "【关于「" + name + "」这个人（你俩聊过 " + p.log.length + " 句）】");
      if (pr.who) out.push((p.group ? "群里：" : "谁：") + pr.who);
      if (!p.group && pr.relation) out.push("关系：" + pr.relation);
      if (pr.style) out.push((p.group ? "群里说话：" : "对方说话：") + pr.style);
      if (pr.topics) out.push("常聊：" + pr.topics);
      if (pr.lastState) out.push("上次：" + pr.lastState);
      out.push("（这些是你记得的，别一条条念，也别问对方有没有这回事。）");
    }
    const days = p.lastSeenAt ? Math.floor((Date.now() - p.lastSeenAt) / 86400000) : 0;
    if (days >= 7) out.push("（你们有 " + days + " 天没说话了）");
    if (p.log.length) {
      out.push("");
      out.push(p.group ? "群里最近说的：" : "你俩最近说的：");
      out.push(p.log.slice(-8).map(x => (x.mine ? "我：" : (p.group ? "群里：" : "对方：")) + x.text).join("\n"));
    }
    // 硬截断：草稿模型一次两段，prompt 越长越贵
    const MEM_CAP = 400;
    const txt = out.join("\n");
    return txt.length > MEM_CAP ? txt.slice(0, MEM_CAP).trimEnd() + "…" : txt;
  } catch { return ""; }
}

// ---------------- CLI ----------------
const argv1 = process.argv[1];
const isMain = !!argv1 && import.meta.url === (await import("node:url")).pathToFileURL(argv1).href;
if (isMain) {
  const args = process.argv.slice(2);
  if (args.includes("--stats")) {
    ensureDir();
    const st = readState();
    const convs = Object.keys((st && st.convs) || {});
    const files = (() => { try { return readdirSync(PEOPLE).filter(f => f.endsWith(".json")); } catch { return []; } })();
    const have = new Set();
    console.log("state 会话 " + convs.length + " 个，人物档案 " + files.length + " 份");
    for (const f of files) {
      let p;
      try { p = JSON.parse(readFileSync(join(PEOPLE, f), "utf8")); } catch { continue; }
      have.add(p.name);
      const mem = memoryFor(p.name);
      const age = p.profile && p.profile.updatedAt ? Math.round((Date.now() - p.profile.updatedAt) / 60000) + "分钟前" : "-";
      console.log("· " + String(p.name).padEnd(20) + " 句=" + String(p.log.length).padStart(3) + " 档案=" + (p.profile ? "Y" : "-") + "(" + age + ")" + " 注入=" + String(mem.length).padStart(3) + "字" + (p.group ? " [群]" : "") + (p.alias && p.alias.length ? " 别名=" + p.alias.join("/") : ""));
    }
    const missing = convs.filter(n => n !== "你" && !have.has(n));
    console.log("没记忆的会话 " + missing.length + " 个" + (missing.length ? "：" + missing.join("、") : ""));
    const resolved = new Set(convs.map(n => { try { return loadPerson(n).name; } catch { return ""; } }).filter(Boolean));
    const orphans = [...have].filter(n => !resolved.has(n));
    if (orphans.length) console.log("孤儿档案 " + orphans.length + " 份（state 里没这个标题了，可能对方改名）：" + orphans.join("、") + "，用 --alias 能把它们接回新名字");
  } else if (args.includes("--alias")) {
    const a = args[args.indexOf("--alias") + 1];
    const b = args[args.indexOf("--alias") + 2];
    if (!a || !b) console.log("用法: node people.mjs --alias 原名 新名");
    else {
      const p = loadPerson(a);
      if (!p.log.length && !p.profile) console.log("（没找到这个人的记忆：" + a + "）");
      else {
        p.alias = Array.from(new Set((p.alias || []).concat(b)));
        savePerson(p);
        console.log("已记下别名：" + p.name + " ← " + b);
      }
    }
  } else if (args.includes("--show")) {
    const name = args[args.indexOf("--show") + 1];
    console.log(memoryFor(name) || "（没有这个人的记忆）");
  } else if (args.includes("--list")) {
    const files = readdirSync(PEOPLE).filter(f => f.endsWith(".json"));
    for (const f of files) {
      const p = JSON.parse(readFileSync(join(PEOPLE, f), "utf8"));
      console.log((p.profile ? "✅ " : "·  ") + p.name + "  " + p.log.length + " 句" + (p.profile ? "  档案:" + (p.profile.lastState || "").slice(0, 30) : ""));
    }
    console.log("共 " + files.length + " 个会话");
  } else {
    const r = await tick({ force: args.includes("--force") });
    console.log(JSON.stringify(r));
  }
}
