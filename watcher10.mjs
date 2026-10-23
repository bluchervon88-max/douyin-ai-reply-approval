
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, existsSync, appendFileSync, unlinkSync, readdirSync, statSync, renameSync, mkdirSync, copyFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeDrafts, revise } from "./draft2.mjs";
import { classifyMsgs, parseMessages, conversationMessages } from "./classify.mjs";
import { plan as proactivePlan, pickConv as proactivePick, makeOpening as makeProactiveOpening, makeOpenings, recordProactive } from "./proactive.mjs";

const require = createRequire(import.meta.url);
let _chromium = null;
function getChromium() {
  if (!_chromium) {
    try { _chromium = require("playwright-core").chromium; }
    catch { throw new Error("缺少 playwright-core，请先在仓库根目录执行 npm install"); }
  }
  return _chromium;
}

const DIR = process.env.DOUYIN_DM_DIR || dirname(fileURLToPath(import.meta.url));
const LOG = join(DIR, "watcher.log");
const STATE = join(DIR, "state.json");
const LOCK = join(DIR, "watcher.lock");
const PORT = Number(process.env.WATCHER_PORT || 8899);
const POLL_MS = 10000;
const BATCH_MS = 8000;
const PENDING_TTL = 30 * 60 * 1000;
const PENDING_REMIND_MS = 10 * 60 * 1000;
const QUEUE_TTL = 20 * 60 * 1000;
const CHAT = process.env.FEISHU_CHAT_ID || "";
const WORKSPACE = process.env.OPENCLAW_WORKSPACE || join(homedir(), ".openclaw", "workspace");
const STICKERS = process.env.STICKERS_DIR || join(WORKSPACE, "stickers-v2");
const APP = { id: process.env.FEISHU_APP_ID || "", secret: process.env.FEISHU_APP_SECRET || "" };

let LOG_SIZE = 0;
try { LOG_SIZE = statSync(LOG).size; } catch {}
function log(m) {
  const line = new Date().toISOString() + "  " + m;
  console.log(line);
  // 测试进程（selftest / regress / proactive-selftest）只打印，不写生产日志：
  // 它们 import watcher 时会跑顶层 log("watching ...")，写进去会污染 doctor 的启动计数。
  if (process.env.WATCHER_TEST) return;
  try {
    if (LOG_SIZE > 5 * 1024 * 1024) { renameSync(LOG, LOG + ".1"); LOG_SIZE = 0; }
    appendFileSync(LOG, line + "\n", "utf8");
    LOG_SIZE += Buffer.byteLength(line) + 1;
  } catch {}
}

// 锁只有真身能碰：selftest / regress / 任何 WATCHER_TEST 进程都不写也不删
// （2026-10-23 的事故：跑 selftest 时把真身的锁顶成测试进程的 pid，退出又 unlink 掉 → 真身没锁，狗任务会再拉一个）
if (!process.env.WATCHER_TEST) {
  if (existsSync(LOCK)) {
    const pid = Number(readFileSync(LOCK, "utf8").trim());
    try { process.kill(pid, 0); log("已有实例 pid=" + pid + "，本进程(" + process.pid + ")退出"); process.exit(0); } catch {}
  }
  try { writeFileSync(LOCK, String(process.pid), "utf8"); } catch {}
  process.on("exit", () => { try { unlinkSync(LOCK); } catch {} });
}

function keepLock() {
  try {
    if (process.env.WATCHER_TEST) return false;
    if (existsSync(LOCK)) return false;
    writeFileSync(LOCK, String(process.pid), "utf8");
    return true;
  } catch (e) { return false; }
}

// state.json 损坏时不要直接崩：先改名为 .corrupt-* 留证据，再按日期倒序读 backups 最新一份。
// 读不到备份就从空状态起步：state.convs=null 会重新 baseline，不会把历史消息当新消息回。
function loadStateFile(mainPath = STATE, backupDir = DIR + "/backups") {
  const readObj = (p) => {
    const v = JSON.parse(readFileSync(p, "utf8"));
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object");
    return v;
  };
  try { return { state: readObj(mainPath), from: "main" }; }
  catch (e) {
    try { renameSync(mainPath, mainPath + ".corrupt-" + Date.now()); } catch {}
    let files = [];
    try { files = readdirSync(backupDir).filter(f => /^state-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort(); } catch {}
    for (let i = files.length - 1; i >= 0; i--) {
      try { return { state: readObj(backupDir + "/" + files[i]), from: "backup:" + files[i] }; } catch {}
    }
    return { state: {}, from: "empty" };
  }
}

const _loaded = loadStateFile();
let state = _loaded.state;
if (_loaded.from !== "main") log("state.json load fallback: " + _loaded.from);
state.convs = state.convs || null;
state.queue = state.queue || [];
state.pending = state.pending || null;
state.outbox = Array.isArray(state.outbox) ? state.outbox : [];
state.recentIncomings = Array.isArray(state.recentIncomings) ? state.recentIncomings : [];
state.lastBootCardAt = Number(state.lastBootCardAt || 0);
state.lastFeishuTs = state.lastFeishuTs || Date.now() - 60000;
state.feishuSeen = Array.isArray(state.feishuSeen) ? state.feishuSeen : [];

// 用了备份 = 主 state 坏了：绝不能拿旧游标去重放停机期间的飞书指令（尤其 1/12）。
// 游标推到当前，清掉旧 pending/outbox；宁可少发一条，不可发错人。
if (_loaded.from !== "main") {
  state.lastFeishuTs = Date.now();
  state.feishuSeen = [];
  state.outbox = [];
  if (state.pending) { log("state fallback drop pending: " + state.pending.conv); state.pending = null; }
  log("state fallback: cursor reset to now, pending/outbox cleared");
}

state.muted = state.muted || [];
state.blocked = state.blocked || [];
state.allowedGroups = state.allowedGroups || [];
state.mentionNames = state.mentionNames || ["522"];

// 「改」的方向词：改短 / 改狠 / 改软 / 改别问 / 改夸
const MODS = [
  { re: /^(短|简短|精简|短一点|短点)/, short: "短", hint: "这次要更短：每条 1-8 个字，别丢原意，能一个字回就别两个字，别解释" },
  { re: /^(狠|凶|硬|冲|狠一点|凶一点)/, short: "狠", hint: "这次要更狠：可以顶回去、可以带一句脏话（别过火），别讨好、别解释" },
  { re: /^(软|温柔|甜|好听|软一点)/, short: "软", hint: "这次软一点：还带点刺但别真伤人，别像客服，别比原来那句长" },
  { re: /^(别问|不问|不要问|没问号)/, short: "不问", hint: "这次一条问句都不要：全是陈述句，别反问" },
  { re: /^(夸|彩虹屁|嘴甜)/, short: "夸", hint: "这次嘴甜一点点：可以夸对方一句，但要像她，别像舔狗" },
];
function parseMod(s) {
  const t = String(s || "").trim().replace(/^[个条次的\s]+/, "");
  if (!t) return null;
  for (const m of MODS) if (m.re.test(t)) return { short: m.short, hint: m.hint };
  return null;
}
// 卡片上写「回 1」，但老解析只认「1」；「回1」「回复1」都应该等同。
function normalizeCmd(text) {
  return String(text || "").replace(/\s/g, "").replace(/^回(复)?/, "");
}

// 群判定：显式开了群 → 标题带「群/联盟/竞速/小队」→ 结尾 (3) / … → 多人会话（"A, B, C" 或 "A、B、C"）
// 以前只认关键词，临时多人会话（"张三, 李四, 王五, Backf1ow"）会被当成一对一。
function looksLikeGroup(title) {
  const t = String(title || "");
  if (!t) return false;
  if ((state.allowedGroups || []).some(n => sameName(n, t))) return true;
  if (/群|联盟|竞速|小队/.test(t)) return true;
  if (/[（(]\d+[）)]$|…$/.test(t)) return true;
  const names = t.split(/[,，、]/).map(x => x.trim()).filter(Boolean);
  return names.length >= 2;
}
// 用户先看到了（手机/网页已读），就别再弹草稿。
// 只有单聊 + unreadCount 明确为 0 才跳过；群聊、读不到字段、刚被 watcher 自己点开过，一律照旧出卡。
// 刚点开的 30 秒窗口是防误判：watcher 切会话本身会把 unread 抹成 0，不能当成用户已读。
const WATCHER_OPEN_GUARD_MS = 30000;
const watcherOpenedAt = new Map();
// 预览相同不代表没新消息：对方连发两条一样的「嗯」时 preview 不变，lastMessageIndex 会变。
// 有 lastKey 时用它兜底；没有就保持原逻辑，避免旧 state 一升级就重复弹卡。
export function isNewPreview(prevPreview, prevKey, preview, key) {
  if (!preview) return false;
  if (preview !== prevPreview) return true;
  return !!(key && prevKey && String(key) !== String(prevKey));
}

export function readBeforeDraft(unread, isGroup, openedAt = 0, now = Date.now(), active = false, unreadByIndex = false) {
  if (isGroup) return false;
  // watcher 正停在这个会话上时，抖音会把 unread 自动抹成 0；这个 0 不代表用户读过。
  if (active) return false;
  // unreadCount 有时不涨（分享/表情/系统类型），但 readIndex 还停在旧消息上；以位置为准。
  if (unreadByIndex) return false;
  if (typeof unread !== "number" || !Number.isFinite(unread) || unread !== 0) return false;
  if (openedAt && now - openedAt < WATCHER_OPEN_GUARD_MS) return false;
  return true;
}
state.allowedDMs = state.allowedDMs || [];
// 会话列表里那些"不是消息"的预览（在线状态/火花/分享卡片），别当新消息
function isNoisePreview(p) {
  const t = String(p || "").trim();
  if (!t) return true;
  if (/^\d+\s*(分钟|小时|天)(内|后)?在线$/.test(t)) return true;
  if (/^(在线|离线|刚刚在线)$/.test(t)) return true;
  if (/火花/.test(t)) return true;
  if (/合养精灵/.test(t)) return true;
  if (/(发布了新作品|更新了作品)/.test(t)) return true;
  return false;
}

// 会话标题会变（对方改昵称、加 emoji），uid 不会变。
// 给 people.mjs 认人用：只补不改，读不到（DOM 结构变了）就当没有，绝不清空。
// 返回值 = 这次有没有改动（调用方决定要不要 save）。
function noteConvUid(st, uid) {
  const u = uid == null ? "" : String(uid).trim();
  if (!st || !u) return false;
  if (st.uid === u) return false;
  st.uid = u;
  return true;
}

function save() {
  if (process.env.WATCHER_TEST) return;
  const body = JSON.stringify(state, null, 1);
  try { writeFileSync(STATE + ".tmp", body, "utf8"); renameSync(STATE + ".tmp", STATE); }
  catch (e) { try { writeFileSync(STATE, body, "utf8"); } catch (e2) { log("!! save fail: " + String(e2.message).slice(0, 80)); } }
}

// 每日备份 state.json（保留 7 份），损坏时可直接复制覆盖回来
function backupState() {
  if (process.env.WATCHER_TEST) return;
  try {
    const dir = DIR + "/backups";
    if (!existsSync(dir)) mkdirSync(dir);
    if (!existsSync(STATE)) return;
    const day = today();
    const dst = dir + "/state-" + day + ".json";
    if (existsSync(dst)) return;
    copyFileSync(STATE, dst);
    const files = readdirSync(dir).filter((f) => /^state-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
    while (files.length > 7) { try { unlinkSync(dir + "/" + files.shift()); } catch (e) {} }
    log("backup state → backups/state-" + day + ".json");
  } catch (e) { log("backup fail: " + String(e.message).slice(0, 60)); }
}

// 重启前 pending 停在发送流程里：可能已经发出去，也可能没有。
// 不自动重发（防重复），改成重新出一张卡，让你回 1/2 或 0。
async function recoverPending() {
  if (process.env.WATCHER_TEST || !state.pending) return;
  const p = state.pending;
  if (Date.now() - (p.at || 0) > PENDING_TTL) {
    state.pending = null; save();
    log("startup pending expired: " + p.conv);
    return;
  }
  if (p.cardSent) return; // 正常审批卡已经发出去了，别重复
  p.cardSent = true;
  p._cardAt = Date.now();
  p._recoveredAt = Date.now();
  save();
  const drafts = (p.drafts || []).slice(0, 2);
  const who = p.group ? "群「" + p.conv + "」" : "「" + p.conv + "」";
  const text = "⚠️ 重启前有份草稿停在发送流程里（可能已发/可能没发）\n" + who + "：" +
    String(p.incoming || "").slice(0, 120) +
    (drafts.length ? "\n草稿：\n" + drafts.map((d, i) => (i + 1) + ". " + d).join("\n") : "\n（没有草稿）") +
    "\n回 1/2 重发，0 丢掉。";
  try { await sendCard(text); } catch (e) { log("pending recover card err: " + String(e.message || e).slice(0, 80)); }
  log("startup pending recovered card: " + p.conv);
}

// 每 10 分钟提醒一次还没处理的草稿；没有 pending 就什么都不做。
// 纯函数方便自测：到点、没草稿、初始卡还没发出、已过期、刚提醒过都不发。
export function pendingReminderText(p, now = Date.now(), gap = PENDING_REMIND_MS, ttl = PENDING_TTL) {
  if (!p || !Array.isArray(p.drafts) || !p.drafts.length) return "";
  if (p.cardSent === false) return "";
  const born = Number(p.at || 0);
  const cardAt = Number(p._cardAt || born);
  const last = Number(p._lastRemindAt || 0);
  const since = Math.max(cardAt, last);
  if (!since || now - since < gap) return "";
  const age = Math.max(0, now - (born || cardAt));
  if (age >= ttl) return "";
  const ageMin = Math.max(0, Math.floor(age / 60000));
  const leftMin = Math.max(1, Math.ceil((ttl - age) / 60000));
  const lines = p.drafts.map((d, i) => (i + 1) + ". " + (p.tags && p.tags[i] ? "[" + p.tags[i] + "] " : "") + d).join("\n");
  const who = p.group ? "群「" + p.conv + "」" : "「" + p.conv + "」";
  return "⏰ 当前有一条草稿待回复（已放 " + ageMin + " 分钟，约 " + leftMin + " 分钟后自动作废）\n" +
    who + "：" + String(p.incoming || "").slice(0, 120) + "\n\n草稿：\n" + lines + "\n\n回 1 / 2 发，0 跳过，改 重写。";
}

async function maybeRemindPending() {
  if (TESTING || !state.pending) return;
  const text = pendingReminderText(state.pending);
  if (!text) return;
  const conv = state.pending.conv;
  state.pending._lastRemindAt = Date.now();
  save();
  try {
    const ok = await sendCard(text);
    log("pending reminder " + (ok ? "sent" : "queued") + ": " + conv);
  } catch (e) { log("pending reminder err: " + String(e.message || e).slice(0, 80)); }
}

// 开机后发一张健康卡：pid / 实际会话数 / 登录态 / 自动范围。
// 10 分钟内重复启动不重复发，避免崩溃循环刷屏。
async function sendBootCard(convCount) {
  if (process.env.WATCHER_TEST) return;
  const last = Number(state.lastBootCardAt || 0);
  if (Date.now() - last < 10 * 60 * 1000) { log("boot card skip (recent)"); return; }
  state.lastBootCardAt = Date.now();
  save();
  const n = Object.keys(state.convs || {}).length;
  const autoList = (state.autoConvs || []).length ? (state.autoConvs || []).join("、") : "白名单全部（注意）";
  const text = (convCount ? "✅" : "⚠️") + " watcher 已启动 pid=" + process.pid +
    "\n会话：" + convCount + " 个（记录 " + n + " 个）" +
    "\n登录：" + (selfUid ? "有 selfUid" : "没有 selfUid") +
    "\n自动：" + (state.autoOn ? "开 · " + autoList : "关") +
    "\n静默：" + (state.autoQuiet || "23:30-07:00") +
    (convCount ? "" : "\n⚠️ 一个会话都没读到，可能掉登录/页面没加载，先别信自动回复。");
  try {
    const ok = await sendCard(text);
    log("boot card " + (ok ? "sent" : "queued/failed") + " convs=" + convCount);
  } catch (e) { log("boot card err: " + String(e.message || e).slice(0, 80)); }
}

// ---------- feishu ----------
let token = null, tokenExp = 0, lastTokenErrAt = 0, lastNetErrAt = 0;
async function getToken(force = false) {
  if (!APP.id || !APP.secret) throw new Error("FEISHU_APP_ID / FEISHU_APP_SECRET 未配置");
  if (!force && token && Date.now() < tokenExp) return token;
  const r = await (await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: APP.id, app_secret: APP.secret }), signal: AbortSignal.timeout(10000),
  })).json();
  // 以前不校验 code，token 失效时会把 null 当 Bearer 发出去，告警静默丢
  if (!r || r.code !== 0 || !r.tenant_access_token) {
    token = null; tokenExp = 0;
    throw new Error("feishu token code=" + (r && r.code) + " " + String((r && r.msg) || "").slice(0, 60));
  }
  token = r.tenant_access_token; tokenExp = Date.now() + 30 * 60 * 1000;
  return token;
}
async function feishu(path, method = "GET", body) {
  const call = async (tk) => {
    try {
      const r = await fetch("https://open.feishu.cn" + path, {
        method, headers: { Authorization: "Bearer " + tk, "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10000),
      });
      return await r.json().catch(() => null);
    } catch (e) {
      if (Date.now() - lastNetErrAt > 5 * 60 * 1000) {
        lastNetErrAt = Date.now();
        log("feishu net fail: " + String(e.message || e).slice(0, 80));
      }
      return null;
    }
  };
  let t;
  try { t = await getToken(); } catch (e) {
    if (Date.now() - lastTokenErrAt > 5 * 60 * 1000) {
      lastTokenErrAt = Date.now();
      log("feishu token fail: " + String(e.message || e).slice(0, 80));
    }
    return null;
  }
  let r = await call(t);
  // token 被踢/过期：清缓存重取一次，别整个 watcher 卡在失效 token 上
  if (r && (r.code === 99991663 || r.code === 99991664)) {
    log("feishu token rejected(" + r.code + ")，重取一次");
    token = null; tokenExp = 0;
    try { t = await getToken(true); } catch (e) {
      log("feishu token retry fail: " + String(e.message || e).slice(0, 80));
      return null;
    }
    r = await call(t);
  }
  return r;
}
async function sendCardRaw(text) {
  if (!CHAT) { log("FEISHU_CHAT_ID 未配置，跳过发卡"); return false; }
  const r = await feishu("/open-apis/im/v1/messages?receive_id_type=chat_id", "POST", {
    receive_id: CHAT, msg_type: "text", content: JSON.stringify({ text }),
  });
  if (!r) return false;
  if (r.code !== 0) {
    log("feishu card fail: code=" + r.code + " msg=" + String(r.msg || "").slice(0, 60) + " text=" + String(text).slice(0, 30));
    return false;
  }
  return true;
}

// 卡片发不出去不要只 log：先入 outbox，主循环每 30 秒试一次，最多 3 次。
// 这样你睡觉时飞书抖一下/断网，告警和审批卡不会静默丢。
function outboxPush(text) {
  try {
    state.outbox = Array.isArray(state.outbox) ? state.outbox : [];
    const t = String(text == null ? "" : text).slice(0, 3000);
    if (!t) return;
    if (state.outbox.some(o => o && o.text === t && Date.now() - (o.at || 0) < 5 * 60 * 1000)) return;
    state.outbox.push({ text: t, at: Date.now(), tries: 0, lastAt: 0 });
    if (state.outbox.length > 20) state.outbox = state.outbox.slice(-20);
    save();
  } catch {}
}

async function sendCard(text) {
  const ok = await sendCardRaw(text);
  if (!ok) outboxPush(text);
  return ok;
}

let outboxBusy = false, lastOutboxAt = 0;
async function flushOutbox() {
  if (outboxBusy || !Array.isArray(state.outbox) || !state.outbox.length) return;
  if (Date.now() - lastOutboxAt < 30 * 1000) return;
  outboxBusy = true;
  lastOutboxAt = Date.now();
  try {
    for (let i = 0; i < 3 && state.outbox.length; i++) {
      const o = state.outbox[0];
      if (!o || !o.text) { state.outbox.shift(); continue; }
      if ((o.tries || 0) >= 3) {
        state.outbox.shift();
        log("outbox drop after 3: " + String(o.text).slice(0, 30));
        save();
        continue;
      }
      if (o.lastAt && Date.now() - o.lastAt < 30 * 1000) break;
      const ok = await sendCardRaw(o.text);
      if (ok) {
        state.outbox.shift();
        log("outbox sent: " + String(o.text).slice(0, 30));
      } else {
        o.tries = (o.tries || 0) + 1;
        o.lastAt = Date.now();
        log("outbox fail (" + o.tries + "/3): " + String(o.text).slice(0, 30));
      }
      save();
      if (!ok) break;
    }
  } finally { outboxBusy = false; }
}
async function readGroup(limit = 50) {
  if (!CHAT) return [];
  const r = await feishu("/open-apis/im/v1/messages?container_id_type=chat&container_id=" + CHAT + "&sort_type=ByCreateTimeDesc&page_size=" + limit);
  if (!r || !r.data) {
    if (r && r.code !== 0) log("feishu read fail: code=" + r.code + " msg=" + String(r.msg || "").slice(0, 60));
    return [];
  }
  return (r.data.items || []).slice().reverse();
}

// ---------- douyin ----------
const norm = (s) => String(s || "").replace(/[\s\p{P}\p{S}\d]+/gu, "");

// 白名单/自动名单按名字比较：去掉所有空白（含抖音名字里的 NBSP）再小写。
// 「Past lives」和「past\u00a0lives」是同一个会话，不能让空格字符把自动回复挡掉。
function nameKey(s) { return String(s || "").replace(/\s+/g, "").toLowerCase(); }
export function sameName(a, b) { const ka = nameKey(a); return !!ka && ka === nameKey(b); }

// 「让 某人 说：话题」：用户主动指定白名单私聊，先生成候选再出卡审批。
// 只解析命令；是否在白名单、真实会话名由 resolveWhitelistDm 负责。
export function parseInitiateCommand(text) {
  const t = String(text || "").trim().replace(/^[「『【\[]+/, "");
  const m = t.match(/^让\s*(.+?)\s*说\s*[：:]\s*([\s\S]+)$/);
  if (!m) return null;
  const target = m[1].trim().replace(/^@/, "");
  const topic = m[2].trim().replace(/^[「『【\[\s]+/, "").replace(/[」』】\]\s]+$/, "").trim();
  return target && topic ? { target, topic } : null;
}

// 白名单私聊解析：返回真实会话名（兼容 NBSP/空格），不在名单/群 → null。
export function resolveWhitelistDm(s, input) {
  const raw = String(input || "").trim().replace(/^@/, "");
  if (!raw) return null;
  const allowed = Array.isArray(s.allowedDMs) ? s.allowedDMs : [];
  if (allowed.length && !allowed.some(n => sameName(n, raw))) return null;
  if ((s.allowedGroups || []).some(n => sameName(n, raw))) return null;
  const keys = Object.keys(s.convs || {}).filter(k => sameName(k, raw));
  keys.sort((a, b) => Number((s.convs[b] || {}).lastActivityAt || 0) - Number((s.convs[a] || {}).lastActivityAt || 0));
  if (keys.length) return keys[0];
  const exact = allowed.find(n => sameName(n, raw));
  return exact || (allowed.length ? null : raw);
}

// 「用：内容」没写收件人时，只能回到最近一条还没被处理的消息。
// 不能直接拿 lastConv：自动发出去/手动发出去之后，它可能是任意一个会话，发错人代价太大。
const RECENT_INCOMING_TTL = 10 * 60 * 1000;
// 媒体卡不进 state.pending（否则会堵后面的文本卡），但飞书回 0 还得能跳过它。
// 只记最近一张媒体卡，一小时有效；回 0 时取走并清空。
const MEDIA_PENDING_TTL = 60 * 60 * 1000;
export function takeMediaPending(s, now = Date.now(), ttl = MEDIA_PENDING_TTL) {
  const p = s && s.mediaPending;
  if (!p) return null;
  s.mediaPending = null;
  const at = Number(p.at);
  if (!Number.isFinite(at) || now - at > ttl) return null;
  return p;
}
export function noteRecentIncoming(s, conv, text, group = false, at = Date.now()) {
  if (!s || !conv) return;
  const list = Array.isArray(s.recentIncomings) ? s.recentIncomings : (s.recentIncomings = []);
  const i = list.findIndex(x => x && sameName(x.conv, conv));
  if (i >= 0) list.splice(i, 1);
  list.push({ conv, text: String(text || ""), group: !!group, at });
  while (list.length > 10) list.shift();
}
export function clearRecentIncoming(s, conv) {
  if (!s || !Array.isArray(s.recentIncomings)) return;
  s.recentIncomings = s.recentIncomings.filter(x => !(x && sameName(x.conv, conv)));
}
export function recentIncomingTarget(s, now = Date.now(), ttl = RECENT_INCOMING_TTL) {
  if (!s || !Array.isArray(s.recentIncomings)) return null;
  const allowed = Array.isArray(s.allowedDMs) ? s.allowedDMs : [];
  for (let i = s.recentIncomings.length - 1; i >= 0; i--) {
    const x = s.recentIncomings[i];
    if (!x || !x.conv || x.group) continue;
    if (!(now - Number(x.at || 0) <= ttl)) continue;
    if (allowed.length && !allowed.some(n => sameName(n, x.conv))) continue;
    if (!s.convs || !s.convs[x.conv]) continue;
    return x;
  }
  return null;
}
const cut10 = (s) => norm(s).slice(0, 10);
// 比对用：保留数字（原来的 norm 会把数字剥掉，"测试A2" 和 "测试A3" 会撞车）
const cmpKey = (s) => String(s || "").replace(/[\s\p{P}\p{S}]+/gu, "").toLowerCase().slice(0, 12);
// 气泡文字前面会带时间戳（"刚刚 测试A5" / "13:05 呃呃"），比对前先剥掉
const BUBBLE_TIME = /^(刚刚|昨天|前天|今天|周[一二三四五六日]|\d{1,2}:\d{2}|\d+\s*秒前|\d+\s*分钟前|\d+\s*小时前|\d+\s*天前|\d{1,2}月\d{1,2}日|\d{1,2}\/\d{1,2})\s*/;
const stripBubble = (s) => String(s || "").replace(BUBBLE_TIME, "").trim();
// 预览里像 [分享视频]/[图片]/[视频] 这种占位符：气泡上的文字是视频标题，跟预览对不上，
// 只能靠"最新那条气泡"判方向（仅整页刷新之后再取，避免读到上个会话的残留）
const MEDIA_PREVIEW = /^\[(分享|图片|视频|表情|语音|文件|音乐|商品|直播|评论|小程序|位置|链接)[^\]]{0,10}\]$/;
// 会话列表对视频/图文常把描述接在占位符后面（[分享视频]2025年的第一场雪…）。
// 严格版 MEDIA_PREVIEW 只给「完全就是占位符」的路径用；判向/媒体分流要用宽版。
const MEDIA_LOOSE = /^\[(分享|图片|视频|表情|语音|文件|音乐|商品|直播|评论|小程序|位置|链接)[^\]]{0,10}\]/;
// 抖音 web 对语音/卡片等类型只在列表里给一句「暂不支持该消息类型」；这不是噪音，是一条真消息。
const UNSUPPORTED_PREVIEW = /^(暂不支持该消息类型|该消息类型暂不支持|视频无法查看)$/;
// 列表里的分享是「分享[视频]」，气泡里的标题对不上，也只能按媒体判。
const SHARE_LOOSE = /^分享\[[^\]]{0,10}\]/;
// 用户明确要求：所有分享视频统一回这一句，不经过草稿审批。
export const VIDEO_ACK_TEXT = "别分享视频 我看不见";
const SHARED_VIDEO = /^(分享\[视频\]|\[分享视频\])/;
export function isSharedVideoPreview(text) { return SHARED_VIDEO.test(String(text == null ? "" : text).trim()); }
export function isMediaPreview(text) { const t = String(text == null ? "" : text).trim(); return MEDIA_LOOSE.test(t) || SHARE_LOOSE.test(t) || UNSUPPORTED_PREVIEW.test(t); }

// SOUL.md 教模型用 [[语音:内容|情绪]]；抖音 web 输入框没有语音条，直接把标记塞进去会原样露出来。
// 现在先把里面的文字发出去（情绪丢弃），以后真做语音发送时再从这个标记解析内容/情绪。
const VOICE_TAG = /\[\[语音\s*[:：]\s*([^\]|]*?)(?:\|([^\]]*?))?\]\]/g;
export function sanitizeOutgoing(text) {
  const s = String(text == null ? "" : text);
  if (!s) return "";
  return s.replace(VOICE_TAG, (_, content) => String(content || "").trim())
    .replace(/[ \t\u3000]{2,}/g, " ")
    .replace(/\s+([，。！？、；：])/g, "$1")
    .replace(/([（(])\s+/g, "$1")
    .replace(/\s+([）)])/g, "$1")
    .trim();
}
// 会话列表的预览会带时间前缀：inline 的「昨天 23:39 测试C1」/ 单独一行的「23:39 测试C1」。
// 只剥「相对日 + 钟点」或「单独钟点」，别把「今天 好累」这种正文剥了。
const LIST_TIME = /^(?:(刚刚|昨天|前天|今天|周[一二三四五六日])\s+)?(\d{1,2}:\d{2}|\d{1,2}\/\d{1,2}|\d{4}\/\d{1,2}\/\d{1,2})\s+/;
function cleanListPreview(p) {
  const s = String(p || "").trim();
  const m = s.match(LIST_TIME);
  if (!m) return { text: s, time: "" };
  return { text: s.slice(m[0].length).trim(), time: (m[1] ? m[1] + " " : "") + m[2] };
}

// 预览是会话列表截出来的，可能比气泡里的原文短。只有「气泡原文以预览开头」才采用全文，
// 否则宁可留着预览，别把另一条消息的全文塞进这条 incoming。
function fullIncoming(preview, hitText) {
  const p = String(preview || "").trim();
  const h = stripBubble(hitText || "");
  if (!p || !h || isMediaPreview(p) || isMediaPreview(h)) return "";
  const cp = cmpKey(p), ch = cmpKey(h);
  if (!cp || !ch) return "";
  return (ch === cp || ch.startsWith(cp)) ? h : "";
}

async function readAll(page) {
  const rows = await page.evaluate(() => {
    const TIME = /^(刚刚|昨天|前天|今天|周[一二三四五六日]|\d{1,2}:\d{2}|\d+\s*分钟前|\d+\s*小时前|\d+\s*天前|\d{1,2}\/\d{1,2}|\d{4}\/\d{1,2}\/\d{1,2})$/;
    const out = [];
    for (const el of document.querySelectorAll(".conversationConversationItemwrapper")) {
      const lines = (el.innerText || "").split("\n").map(s => s.trim()).filter(Boolean);
      if (!lines.length) continue;
      const title = lines[0];
      const rest = lines.slice(1).filter(l => !/^\d{1,3}$/.test(l));
      const time = rest.find(l => TIME.test(l)) || "";
      const preview = rest.filter(l => l !== time).join(" ");
      let targetUid = null, unread = null, convType = null, lastKey = "", unreadByIndex = false;
      try {
        const rk = Object.keys(el).find(k => k.startsWith("__reactFiber"));
        let f = rk ? el[rk] : null;
        for (let d = 0; d < 6 && f; d++) {
          const cv = f.memoizedProps && f.memoizedProps.conversation;
          if (cv) {
            targetUid = cv.toParticipantSecUserId || cv._toParticipantSecUserId || null;
            try { if (typeof cv.unreadCount === "number") unread = cv.unreadCount; } catch {}
            try { convType = cv.type == null ? null : cv.type; } catch {}
            // 最后一条消息的排序键：同一句话连发两次时预览不变，但 lastMessageIndex 会变。
            // 注意：已读不会改这个键（readIndex 才是已读位置），所以能用它区分「新消息」和「我刚读过」。
            try { if (cv.lastMessageIndex != null) lastKey = String(cv.lastMessageIndex); } catch {}
            // unreadCount 会漏（分享/表情/系统消息），readIndex 没追上 lastMessageIndex 才是真的还有没读的。
            try {
              const _last = cv.lastMessageIndex, _read = cv.readIndex;
              if (_last != null && _read != null) unreadByIndex = BigInt(String(_last)) > BigInt(String(_read));
            } catch {}
            break;
          }
          f = f.return;
        }
      } catch {}
      const active = String(el.className || "").includes("curConversation");
      out.push({ title, time, preview, targetUid, unread, convType, lastKey, active, unreadByIndex });
    }
    return out;
  });
  return rows.map((o) => {
    const cl = cleanListPreview(o.preview);
    let time = o.time || "";
    if (cl.time && time && !time.includes(":")) time = time + " " + cl.time;
    else if (!time) time = cl.time;
    return { ...o, preview: cl.text, time };
  });
}

async function ensureConversation(page, title) {
  const idx = await page.evaluate((n) => {
    const items = [...document.querySelectorAll(".conversationConversationItemwrapper")];
    for (let i = 0; i < items.length; i++) {
      const lines = (items[i].innerText || "").split("\n").map(s => s.trim()).filter(Boolean);
      if (lines[0] === n) return i;
    }
    return -1;
  }, title);
  if (idx < 0) return false;
  const click = async () => {
    await page.locator(".conversationConversationItemwrapper").nth(idx).click();
    await page.waitForTimeout(1000);
  };
  const confirm = async () => await page.evaluate((n) => {
    const items = [...document.querySelectorAll(".conversationConversationItemwrapper")];
    const active = items.find(it => String(it.className).includes("curConversation"));
    const activeTitle = active ? ((active.innerText || "").split("\n")[0] || "").trim() : "";
    const hdr = document.querySelector(".RightPanelHeadertitleContainer");
    const hdrTitle = hdr ? (hdr.innerText || "").trim().split("\n")[0] : "";
    return { activeTitle, hdrTitle, ok: hdrTitle === n || activeTitle === n };
  }, title);
  await click();
  let r = await confirm();
  if (!r.ok) { await click(); r = await confirm(); }
  if (!r.ok) log("!! 会话没切过去 目标=" + title + " active=" + r.activeTitle + " header=" + r.hdrTitle);
  if (r.ok) { try { watcherOpenedAt.set(String(title).trim(), Date.now()); } catch {} }
  return r.ok;
}

// 抖音改版后，选择器一失效，readAll 会安静地返回 0 会话：不报错、不出卡，像是我没在干活。
// 每 30 分钟摸一次要害，坏了就在飞书喊一声。
async function structureCheck(page) {
  const out = { ok: true, why: [], soft: [] };
  try {
    const n = await page.$$eval('[class*="conversationConversationItem"]', els => els.length).catch(() => -1);
    if (n < 0) { out.ok = false; out.why.push("会话列表选择器失效"); }
    else if (n === 0) { out.ok = false; out.why.push("会话列表读到 0 项"); }
    // 只有"已经点开某个会话"时，输入框/标题区才有意义；没点开时的缺失不是问题
    const cur = await page.$('[class*="curConversation"]').catch(() => null);
    if (cur) {
      const ed = await page.$('[contenteditable="true"]').catch(() => null);
      if (!ed) out.soft.push("输入框没找到");
      const hd = await page.$('[class*="RightPanelHeader"], [class*="titleContainer"]').catch(() => null);
      if (!hd) out.soft.push("会话标题区没找到");
    }
  } catch (e) {
    out.ok = false; out.why.push("检查异常 " + String(e.message || e).slice(0, 60));
  }
  out.why = out.why.join("；"); out.soft = out.soft.join("；");
  return out;
}

async function readBubbles(page, limit = 15) {
  try {
    return await page.evaluate((lim) => {
      // 抖音的消息列表是「最新的在 DOM 最前面」，所以取头部才是最近的 lim 条
      const boxes = [...document.querySelectorAll(".messageMessageBoxmessageBox")];
      // 面板宽度：用来判左右。抖音自己的消息靠右，对方靠左
      let panel = null;
      try {
        let el = boxes[0];
        for (let i = 0; i < 12 && el; i++) {
          const r = el.getBoundingClientRect();
          if (r.width > 400) { panel = r; break; }
          el = el.parentElement;
        }
      } catch {}
      return boxes.slice(0, lim).map(b => {
        let txt = (b.innerText || "").replace(/\s+/g, " ").trim();
        // 引用消息：引用块和回复正文在同一个气泡里（zero0 实测结构）。
        // 直接取 innerText 会把「引用的原文」拼进正文，模型和卡片会当成对方连说了两句话。
        // 先把引用块单独摘出来，再从 clone 里删掉它，只留回复正文。
        let quote = "";
        try {
          const qEl = b.querySelector(".MessageItemTextsplitReferContainer, .MessageBoxRefContainerrefTextContainer");
          if (qEl) {
            quote = (qEl.innerText || "").replace(/\s+/g, " ").trim();
            const clone = b.cloneNode(true);
            // 连气泡自己的时间标签一起摘掉：clone 脱离布局后 innerText 会把「16:54」和正文粘成「16:54这篇」
            clone.querySelectorAll(".MessageItemTextsplitReferContainer, .MessageBoxRefContainerrefTextContainer, .MessageBoxTimetimeLayout").forEach(x => x.remove());
            txt = (clone.textContent || "").replace(/\s+/g, " ").trim();
          }
        } catch {}
        // 去掉气泡里混进来的时间戳和「已读」，别污染上下文
        txt = txt.replace(/^(刚刚|昨天|今天|\d{1,2}:\d{2}|\d+\s*(?:分钟|小时|天)前)\s+/, "").replace(/\s*已读$/, "").trim();
        let mine = !!b.querySelector(".messageMessageBoxisFromMe") || /isFromMe/.test(String(b.className));
        let how = mine ? "class" : "";
        if (!mine) {
          try {
            const inner = b.firstElementChild || b;
            const r = inner.getBoundingClientRect();
            const pr = panel || inner.parentElement.getBoundingClientRect();
            if (pr && pr.width > 200 && r.width > 0 && r.width < pr.width * 0.92) {
              const center = r.left + r.width / 2;
              const mid = pr.left + pr.width / 2;
              if (center > mid + 2) { mine = true; how = "right"; }
              else if (center < mid - 2) { mine = false; how = "left"; }
            }
          } catch {}
        }
        // 时间分隔条/系统提示也是 .messageMessageBox，但里面没有 contentBox；
        // 判向时不能拿它当「最新气泡」（否则 mine=false 会把图片/视频误判成对方发的）。
        const isTime = !b.querySelector(".messageMessageBoxcontentBox");
        // 真正的图片/视频/分享卡；判向时媒体不能拿相邻文字气泡凑数。
        // 只认内容图（commonMyImageimgReal）或 video，别把头像/表情小图算进来；
        // 已读回执头像（ContentBottomHasReadheadPhoto）也是一张 img，必须排除，否则会把普通文字行当成媒体。
        const hasMedia = [...b.querySelectorAll("video, img")].some(el => {
          try {
            if (el.tagName === "VIDEO") return !el.closest(".commonIMAvataravatarContainer, .semi-avatar, .TextMessageTextemoji");
            if (!el.classList.contains("commonMyImageimgReal")) return false;
            if (el.closest('[class*="ContentBottomHasRead"]')) return false;
            if (el.closest(".MessageItemShareAwemeauthorAvatar, .MessageItemShareAwemephotosTag")) return false;
            return true;
          } catch { return false; }
        });
        return { mine, text: txt, quote, how, cls: String(b.className || "").slice(0, 60), isTime, hasMedia };
      });
    }, limit);
  } catch { return []; }
}

// 消息列表最新在前；跳过时间分隔条/系统提示，取第一条真正的消息。
export function latestRealRow(rows, mediaOnly = false) {
  return (rows || []).find(r => r && !r.isTime && (!mediaOnly || r.hasMedia)) || null;
}

// 自动回复等待期间，用户可能已经拿手机自己回了。最新一条真实气泡是我发的，就别再补一句。
export function lastRealIsMine(rows) {
  const top = latestRealRow(rows);
  return !!(top && top.mine);
}

function extraIncomingFromRows(rows, answeredText, knownTexts) {
  const ans = String(answeredText || "").split(" / ").map(cmpKey).filter(k => k.length >= 2);
  if (!ans.length) return [];
  let idx = -1;
  for (let i = 0; i < (rows || []).length; i++) {
    const t = stripBubble(rows[i] && rows[i].text);
    const k = cmpKey(t);
    if (!k) continue;
    if (ans.some(a => k === a || k.includes(a) || a.includes(k))) { idx = i; break; }
  }
  if (idx < 0) return [];
  const known = new Set((knownTexts || []).map(cmpKey).filter(Boolean));
  const out = [];
  for (let i = 0; i < idx; i++) {
    const r = rows[i];
    if (!r || r.mine || r.isTime) continue;
    const t = stripBubble(r.text);
    const k = cmpKey(t);
    if (!t || !k || known.has(k) || isNoisePreview(t)) continue;
    if (out.some(x => cmpKey(x.text) === k)) continue;
    out.push({ text: t, at: Date.now() });
  }
  return out.reverse();
}
// 补抓的「已知」不能收 ctx：判向会用 DOM 覆盖 ctx，里面可能正好是还没进 buffer 的新消息。
export function knownForCapture(st, detectTexts = []) {
  const known = [];
  for (const k of ["recent", "sent", "buffer"]) for (const x of ((st && st[k]) || [])) known.push(x.text);
  for (const t of (detectTexts || [])) known.push(t);
  return known;
}
async function captureExtraIncoming(page, title, answeredText) {
  try {
    const st = state.convs && state.convs[title];
    if (!st || st._group) return 0;
    const rows = await readBubbles(page, 30);
    const known = knownForCapture(st, (state.detect || []).filter(d => d.conv === title).map(d => d.text));
    if (state.pending && state.pending.conv === title) known.push(state.pending.incoming);
    const extras = extraIncomingFromRows(rows, answeredText, known);
    if (!extras.length) return 0;
    for (const e of extras) {
      st.buffer = st.buffer || [];
      st.buffer.push(e);
      state.detect = state.detect || [];
      state.detect.push({ conv: title, text: e.text, at: e.at, group: false, sender: "", uid: st.uid || "" });
    }
    st.lastBufferAt = Date.now();
    st.lastActivityAt = Date.now();
    save();
    log("extra incoming [" + title + "] " + extras.map(e => e.text).join(" / "));
    return extras.length;
  } catch (e) {
    log("extra scan err: " + String(e.message || e).slice(0, 80));
    return 0;
  }
}

// 出草稿前补一次：列表预览只带最后一条，同一轮连发的前面几条会丢。
// 用「上一条我发出去的话」当锚点，只补它之后、还没登记过的对方消息；找不到锚点就什么都不做。
// 只在非群、单条 buffer、没有 pending/queue 时跑，避免打乱正在审批/发送的状态。
async function captureMissedIncoming(page, title, st) {
  try {
    if (!st || st._group) return 0;
    if (state.pending || (state.queue || []).length) return 0;
    if ((st.buffer || []).length !== 1) return 0;
    // 媒体消息有单独的卡片路径，别把文字/别的消息拼进去
    if (isMediaPreview((st.buffer || [])[0].text)) return 0;
    const lastSent = (st.sent || []).slice(-1)[0];
    if (!lastSent || !lastSent.text || Date.now() - (lastSent.at || 0) > 2 * 3600e3) return 0;
    if (!(await ensureConversation(page, title))) return 0;
    const rows = await readBubbles(page, 30);
    const known = knownForCapture(st, (state.detect || []).filter(d => d.conv === title).map(d => d.text));
    const extras = extraIncomingFromRows(rows, lastSent.text, known);
    if (!extras.length) return 0;
    st.buffer = extras.concat(st.buffer || []);
    state.detect = state.detect || [];
    for (const e of extras) state.detect.push({ conv: title, text: e.text, at: e.at, group: false, sender: "", uid: st.uid || "" });
    st.lastBufferAt = Date.now();
    st.lastActivityAt = Date.now();
    save();
    log("missed incoming [" + title + "] " + extras.map(e => e.text).join(" / "));
    return extras.length;
  } catch (e) {
    log("missed scan err: " + String(e.message || e).slice(0, 80));
    return 0;
  }
}

async function scrollBottom(page) {
  try {
    await page.evaluate(() => {
      const boxes = [...document.querySelectorAll(".messageMessageBoxmessageBox")];
      const first = boxes[0];
      if (first && first.scrollIntoView) first.scrollIntoView({ block: "start" });
      const pane = document.querySelector('[class*="messageList"],[class*="MessageList"],[class*="chatScroll"]');
      if (pane) pane.scrollTop = 0;
    });
  } catch {}
}

async function matchPreviewBubble(page, preview, tries = 4, gap = 1200, allowLastForMedia = false) {
  const key = cmpKey(preview);
  let rows = [];
  for (let i = 0; i < tries; i++) {
    rows = await readBubbles(page, 25);
    // rows[0] 是最新的一条，命中就以最新的那条为准
    let hit = null;
    for (const r of rows) {
      const x = cmpKey(stripBubble(r.text));
      if (!x) continue;
      if (x === key) { hit = r; break; }
      if (!hit && key.length >= 2 && x.includes(key)) hit = r;
    }
    if (hit) return { hit, rows, tries: i + 1 };
    // 分享视频/图片这类：比对不上就取最新真实气泡。
    // 注意不能直接用 rows[0]：时间分隔条（"11分钟前"）也在同一个选择器里，
    // 它没有 contentBox、mine=false，会把「我刚发的图」判成对方发的。
    // 也不能拿相邻的文字气泡凑数：媒体没渲染出来时，最新气泡可能是对方上一句话。
    if (allowLastForMedia && isMediaPreview(preview)) {
      // 只认「最新一条真实气泡本身就是媒体」。
      // 如果最新是文字，说明目标媒体还没渲染，不能往下翻出旧媒体来凑方向。
      const last = latestRealRow(rows);
      if (last && last.hasMedia) {
        log("dom[" + (last.text ? String(last.text).slice(0, 20) : "空") + "] 媒体预览按最新媒体气泡判方向 mine=" + last.mine);
        return { hit: last, rows, tries: i + 1 };
      }
    }
    await page.waitForTimeout(gap);
  }
  return { hit: null, rows, tries };
}

async function directionByDom(page, title, preview) {
  try {
    if (!(await ensureConversation(page, title))) return { dir: "unknown", rows: [], hit: null };
    const media = isMediaPreview(preview);
    // 图片/视频预览的文字是占位符，不能按文字匹配；多给页面一点时间，然后取最新媒体气泡。
    await page.waitForTimeout(media ? 1500 : 900);
    await scrollBottom(page);
    let m = await matchPreviewBubble(page, preview, media ? 4 : 4, media ? 1000 : 1200, media);
    if (!m.hit && media) {
      // 媒体消息刚发出时 DOM 可能晚一拍；不要立刻 reload（reload 会清掉正在上传的预览），
      // 先等几轮。只认最新媒体气泡；最新只是文字说明媒体还没渲染，别拿它当方向。
      for (let i = 0; i < 6 && !m.hit; i++) {
        await page.waitForTimeout(1000);
        const rows2 = await readBubbles(page, 30);
        const last = latestRealRow(rows2);
        if (last && last.hasMedia) m = { hit: last, rows: rows2, tries: m.tries + i + 1 };
      }
    }
    if (!m.hit && !media) {
      // 刚切会话时消息面板可能还是旧的，整页刷一次再来
      log("dom[" + title + "] 首次没匹配到，刷新重试（预览=" + preview.slice(0, 12) + "）");
      const buf = await reloadAndInit();
      try { if (buf) writeFileSync(DIR + "/last-payload.bin", buf); } catch {}
      if (!(await ensureConversation(page, title))) return { dir: "unknown", rows: [], hit: null };
      await page.waitForTimeout(1200);
      await scrollBottom(page);
      m = await matchPreviewBubble(page, preview, 5, 1400, true);
    }
    const rows = m.rows || [];
    if (!m.hit) {
      log("dom[" + title + "] 还是没匹配到预览=" + preview.slice(0, 12) + " 最后一条=" + JSON.stringify(rows[rows.length - 1] || {}).slice(0, 90));
      return { dir: "unknown", rows, hit: null };
    }
    log("dom[" + title + "] hit=" + JSON.stringify(m.hit).slice(0, 100) + " rows=" + rows.length + " try=" + m.tries + (media ? " media" : ""));
    return { dir: m.hit.mine ? "mine" : "theirs", rows, hit: m.hit };
  } catch (e) {
    log("dom[" + title + "] 判向异常: " + String(e.message || e).slice(0, 90));
    return { dir: "unknown", rows: [], hit: null };
  }
}

async function previewOf(page, title) {
  try {
    const all = await readAll(page);
    const c = all.find(x => x.title === title);
    return c ? c.preview : "";
  } catch { return ""; }
}

async function sendToDouyin(page, title, text) {
  const payload = sanitizeOutgoing(text);
  if (!payload) return { ok: false, why: "内容为空（语音标记里没字）" };
  if (!(await ensureConversation(page, title))) return { ok: false, why: "没切到「" + title + "」，没敢发" };
  if (state.pending && state.pending.conv === title) {
    try { await captureExtraIncoming(page, title, state.pending.incoming); } catch (e) { log("extra scan err: " + String(e.message || e).slice(0, 80)); }
  }
  const afterSend = async (r) => {
    if (r && r.ok && state.pending && state.pending.conv === title) {
      try { await captureExtraIncoming(page, title, payload); } catch (e) { log("extra scan err: " + String(e.message || e).slice(0, 80)); }
    }
    return r;
  };
  const before = await page.evaluate(() => document.querySelectorAll(".messageMessageBoxmessageBox .messageMessageBoxisFromMe").length);
  const prevPreview = await previewOf(page, title);
  const input = page.locator('[contenteditable="true"].messageEditorinputArea').first();
  await input.click();
  await page.waitForTimeout(350);
  await page.keyboard.insertText(payload);
  await page.waitForTimeout(450);
  await page.keyboard.press("Enter");
  const want = payload.replace(/\s/g, "");
  for (let i = 0; i < 25; i++) {
    await page.waitForTimeout(600);
    const pv = await previewOf(page, title);
    const pvNorm = pv.replace(/\s/g, "");
    if (pv !== prevPreview && pvNorm && (pvNorm === want || pvNorm.startsWith(want) || want.startsWith(pvNorm))) {
      return afterSend({ ok: true, how: "preview" });
    }
    const st = await page.evaluate(() => {
      const boxes = [...document.querySelectorAll(".messageMessageBoxmessageBox")];
      const mine = boxes.filter(b => b.querySelector(".messageMessageBoxisFromMe"));
      const last = mine[mine.length - 1];
      return { count: mine.length, lastText: last ? (last.innerText || "").trim().slice(0, 200) : "" };
    });
    if (st.count > before) return afterSend({ ok: true, how: "count" });
    const lt = stripBubble(st.lastText).replace(/\s*已读$/, "").replace(/\s/g, "");
    if (lt && want.length >= 2 && (lt === want || lt.startsWith(want))) return afterSend({ ok: true, how: "lastText" });
  }
  // 再等 1.5 秒补一次判定：抖音预览会延迟刷新，很多"没确认到"其实已经发出
  await page.waitForTimeout(1500);
  try {
    const pv2 = await previewOf(page, title);
    const pvNorm2 = pv2.replace(/\s/g, "");
    if (pv2 && pv2 !== prevPreview && pvNorm2 && want.length >= 2 && (pvNorm2 === want || pvNorm2.startsWith(want) || want.startsWith(pvNorm2))) return afterSend({ ok: true, how: "late-preview" });
    const st2 = await page.evaluate(() => document.querySelectorAll(".messageMessageBoxmessageBox .messageMessageBoxisFromMe").length);
    if (st2 > before) return afterSend({ ok: true, how: "late-count" });
  } catch {}
  return { ok: false, why: "20 秒内没在预览/气泡里确认到（可能发出去了，也可能没发）" };
}

async function sendWithRetry(page, title, text) {
  const r = await sendToDouyin(page, title, text);
  if (r.ok) return r;
  // 只有"根本没切到会话"这种确定没发出去的失败才重试，避免重复发送
  if (!/没切到/.test(String(r.why || ""))) return r;
  log("switch failed, retry once → " + title);
  await page.waitForTimeout(2200);
  const r2 = await sendToDouyin(page, title, text);
  return r2.ok ? r2 : r;
}

async function maybeSticker(page, conv, tags, chance = 0.3) {
  try {
    if (state.autoSticker === false) return null;
    if (Math.random() > chance) return null;
    const t = (tags || []).join(" ");
    if (!/怼|玩笑|敷衍|正常/.test(t)) return null;
    let files = [];
    try { files = readdirSync(STICKERS).filter(f => /\.(png|jpg|jpeg|gif|webp)$/i.test(f)); } catch {}
    if (!files.length) return null;
    const f = files[Math.floor(Math.random() * files.length)];
    const r = await sendSticker(page, conv, STICKERS + "/" + f);
    if (!r.ok) return null;
    try {
      const all = await readAll(page);
      const cc = all.find(x => x.title === conv);
      if (cc) {
        const st = state.convs[conv] || (state.convs[conv] = { lastPreview: "", buffer: [], lastBufferAt: 0, recent: [], sent: [], fails: 0 });
        st.lastPreview = cc.preview;
      }
    } catch {}
    save();
    log("auto sticker → " + conv + ": " + f);
    return f;
  } catch { return null; }
}

async function sendSticker(page, title, file) {
  if (!(await ensureConversation(page, title))) return { ok: false, why: "没切到「" + title + "」" };
  try {
    const input = page.locator('input[type="file"]').first();
    await input.setInputFiles(file);
    await page.waitForTimeout(1600);
    const btn = page.locator(".MsgInputSendFileModalbtnSure").first();
    if (!(await btn.count())) return { ok: false, why: "没弹出发送面板" };
    await btn.click();
    await page.waitForTimeout(2200);
    return { ok: true };
  } catch (e) { return { ok: false, why: String(e.message).slice(0, 60) }; }
}

function remember(conv, incoming, sent) {
  try {
    appendFileSync(DIR + "/douyin-memory.jsonl", JSON.stringify({ at: new Date().toISOString(), conv, incoming: String(incoming).slice(0, 80), sent: String(sent).slice(0, 80) }) + String.fromCharCode(10), "utf8");
  } catch {}
}

// 她此刻在干嘛（读 MOOD.md，缓存 5 分钟）：给卡片加一行"情绪来源"
let _herNow = { at: 0, line: "" };
function herNowLine() {
  if (Date.now() - _herNow.at < 5 * 60 * 1000) return _herNow.line;
  let line = "";
  try {
    const raw = readFileSync(join(WORKSPACE, "MOOD.md"), "utf8");
    const lines = raw.split(/\r?\n/);
    const mood = ((lines.find((l) => l.includes("你现在：")) || "").split("你现在：")[1] || "").trim();
    const sched = (lines.filter((l) => /^- \d{1,2}:\d{2}\s/.test(l.trim())).slice(-1)[0] || "").replace(/^-\s*/, "").trim();
    const mood1 = String(mood).split(/[。！？\n]/)[0].trim();
    const sched1 = String(sched).replace(/^\d{1,2}:\d{2}\s*/, "").trim();
    const bits = [sched1.slice(0, 30), mood1.slice(0, 26)].filter(Boolean);
    if (bits.length) line = "她此刻：" + bits.join(" · ") + "\n";
  } catch (e) {}
  _herNow = { at: Date.now(), line };
  return line;
}

// 主动开口用的「她此刻」：MOOD 的心情/今天 + LIFE 的近况。
// 之前 maybeProactive 只传 ctx，proactive.mjs 的「此刻」分支等于没数据；这里补上（读不到就是空，不影响开口）。
let _lifeBrief = { at: 0, v: null };
function lifeBrief() {
  if (_lifeBrief.v && Date.now() - _lifeBrief.at < 5 * 60 * 1000) return _lifeBrief.v;
  const read = (p) => { try { return readFileSync(p, "utf8"); } catch { return ""; } };
  const base = WORKSPACE;
  const moodRaw = read(base + "/MOOD.md");
  const lifeRaw = read(base + "/LIFE.md");
  const lines = moodRaw.split(/\r?\n/);
  const mood = ((lines.find((l) => l.includes("你现在：")) || "").split("你现在：")[1] || "").trim().slice(0, 80);
  const today = lines.filter((l) => /^- \d{1,2}:\d{2}\s/.test(l.trim())).slice(-3).map((l) => l.replace(/^-\s*/, "").slice(0, 70));
  const life = lifeRaw.split(/\r?\n/).filter((x) => x.startsWith("- ")).slice(-2).map((x) => x.replace(/^- /, "").slice(0, 90));
  const v = { mood, today, life };
  _lifeBrief = { at: Date.now(), v };
  return v;
}

// 只留下能发的草稿：空、纯标点（"？""。"）一律丢掉，宁可不出球也不发一个问号
// 模型偶尔会"自言自语"：把提示词里的指令复述出来（"上面第三条太长而且不规范。重来一遍："）。
// 这种句子绝不能发出去，直接丢掉。
const META_LEAK = /(重来一遍|重新来一遍|再来一遍|不规范|第[一二三四五六七八九十\d]+条|太长|换一个说法|我重新写|作为.{0,4}(AI|助手|模型)|抱歉|我无法|以上是|以下是)/;
// 「人味」二次检查：模型偶尔会冒出客服腔/书面语（"理解你的感受"、"其实"、"祝你"）。
// 这一层只在**同一次生成里重排**，不丢句子——丢多了可能一张卡都出不来，反而更糟。
// 罚分低的排前面：卡片里「1.」就是它，自动发也发这一条。
const HUMAN_TELL = [
  [/(理解你的感受|我能理解|希望|祝你|加油|没关系|别担心|支持你|辛苦啦|要注意身体)/, 4],
  [/(有什么(可以|能)帮|需要我|我可以帮|随时(找|告诉)我|有问题(随时|就))/, 5],
  [/(其实|因此|所以呢|而且|不过呢|首先|其次|总之|总的来说|不得不说)/, 2],
  [/(作为一个|身为一个)/, 3],
  [/(哈哈|嗯嗯|呵呵|嘿嘿|好的呢|是呢)/, 2],
  [/(😊|🙏|❤|😂|🤣|👍|～～)/, 2],
  [/[。！]\s*$/, 1],
  [/^[「『"]|[」』"]$/, 1],
  [/[，,].{0,3}[，,]/, 1],
];
function humanPenalty(t) {
  const s = String(t == null ? "" : t).trim();
  if (!s) return 99;
  let p = 0;
  for (const [re, w] of HUMAN_TELL) if (re.test(s)) p += w;
  if (s.replace(/\s+/g, "").length > 20) p += 2;
  return p;
}
// 一次过滤 + 排序，drafts/tags 一起走，别让标签和句子错位
function shapeDrafts(list, tags) {
  const tg = tags || [];
  const keep = (list || []).map((d, i) => ({ d: sanitizeOutgoing(String(d == null ? "" : d)).trim(), tag: tg[i] || "" }))
    .filter((x) => x.d && !/^[？?！!。.…~～\s]+$/.test(x.d))
    .filter((x) => !META_LEAK.test(x.d))
    .filter((x) => !/[：:]\s*$/.test(x.d));
  keep.forEach((x) => { x.p = humanPenalty(x.d); });
  const before = keep.map((x) => x.d);
  keep.sort((a, b) => a.p - b.p); // V8 的 sort 是稳定的，同分保持模型原本的顺序
  const moved = before.length > 1 && before[0] !== keep[0].d;
  return { drafts: keep.map((x) => x.d), tags: keep.map((x) => x.tag), moved };
}
function usableDrafts(list) { return shapeDrafts(list).drafts; }

// 全都像客服（罚分都 >= 4）时，才值得再花一次调用把第一条改回她的口气。
// 只要有一条及格的就不动——大多数时候重排就够了，别为每张卡多花一次钱。
const RESCUE_AT = 4;
function needRescue(list) {
  if (!(list || []).length) return false;
  return (list || []).every((d) => humanPenalty(d) >= RESCUE_AT);
}
async function rescueDrafts(list, group) {
  if (group || !needRescue(list)) return list;
  try {
    const fixed = await revise(list[0], { hint: "别像客服、别安慰人，用她自己的口气，更短更冲一点", onUsage: addTok });
    const cand = shapeDrafts([fixed]).drafts;
    if (cand.length && humanPenalty(cand[0]) < humanPenalty(list[0])) {
      log("人味重写：" + list[0] + " → " + cand[0]);
      return [cand[0]].concat((list || []).slice(1));
    }
  } catch (e) { log("人味重写失败 " + String(e.message).slice(0, 60)); }
  return list;
}

// 成本分档：把 makeDrafts 的 opts 按场景调小（群最便宜，短句次之，正常/诉苦不动）
export function sceneOpts(q = {}) {
  const inc = String(q.incoming || "").replace(/\[[^\]]*\]/g, "").trim();
  if (q.group) return { cands: 4, skipRerank: true };   // 群：4 候选 + 不审稿
  if (inc.length <= 2) return { cands: 4 };             // 「嗯」「在吗」这种：4 候选
  if (inc.length <= 6) return { cands: 5 };             // 六个字以内的短句：5 候选
  return {};
}

// ---------- 她偶尔主动开口 ----------
let lastProactiveCheckAt = 0;
const PROC_START = Date.now();
const lastAt = (list) => (Array.isArray(list) ? list.reduce((m, x) => Math.max(m, Number(x && x.at || 0)), 0) : 0);
// 她最后一句还没被回（含刚检测到还没出卡的 buffer）：这时候别主动找她，
// 否则会把「她昨晚说的话」当成冷场，早上开机就补一句。
export function hasUnansweredIncoming(st) {
  if (!st || typeof st !== "object") return false;
  if ((st.buffer || []).length) return true;
  const inc = lastAt(st.recent), out = lastAt(st.sent);
  if (inc > 0 && inc > out) return true;
  // ctx 末尾可能是「撤回/空行」这种没有文字的占位，不能只看最后一项：
  // 否则 [对方: 2", 我: 撤回空行] 会被判成「已回」，主动开口就会去接那句没回的话。
  const said = (Array.isArray(st.ctx) ? st.ctx : []).filter(x => x && String(x.text || "").trim());
  const c = said[said.length - 1];
  if (c && !c.mine) return true;
  return false;
}

/**
 * 主动开口只认显式名单，绝不从 autoConvs 推导。
 * 2026-10-23 的事故：autoConvs 从 2 个扩到 7 个后，proactive 自动把新开的好友也当成了
 * 「可以主动搭话」的对象，给「我也选择随缘」发了一句接旧消息的怪话。
 * 自动回复是「她发我才回」，主动开口是「我没事找她」——两件事必须分开授权。
 */
export function proactiveTargets(s) {
  const a = Array.isArray(s && s.proactiveConvs) ? s.proactiveConvs : [];
  return a.map(x => String(x == null ? "" : x).trim()).filter(Boolean);
}

/** 给主动开口用的 ctx：去掉空行、撤回占位和纯数字/纯符号的短句，最多 8 条。 */
export function cleanProactiveCtx(ctx) {
  const arr = Array.isArray(ctx) ? ctx : [];
  return arr.filter(x => {
    const t = String((x && x.text) || "").replace(/\s+/g, " ").trim();
    if (!t) return false;
    if (/^(?:你|对方)?撤回了一条消息(?:\s*重新编辑)?$/.test(t)) return false;
    if (/^\d{1,3}["'“”‘’]?$/.test(t)) return false;
    return true;
  }).slice(-8);
}
async function maybeProactive(page) {
  if (Date.now() - PROC_START < 5 * 60 * 1000) return false; // 刚开机别急着主动补话
  if (inQuietRange(nowHM())) return false;
  if (state.proactiveOn !== true) return false;
  if (Date.now() - lastProactiveCheckAt < 3 * 60 * 1000) return false;
  lastProactiveCheckAt = Date.now();
  if (state.pending || (state.queue || []).length) return false;
  const targets = proactiveTargets(state);
  if (!targets.length) return false;
  let p;
  try { p = proactivePlan({ state }); } catch (e) { return false; }
  if (!p || !p.ok) return false;
  // 只从 proactiveConvs 里挑；autoConvs 只决定「她发来我自动回」，不授权主动搭话
  const conv = proactivePick({ state: { ...state, autoConvs: targets } });
  if (!conv) return false;
  const st = state.convs[conv] || {};
  if (hasUnansweredIncoming(st)) { log("proactive skip: 还有没回的话 → " + conv); return false; }
  if (st.lastActivityAt && inQuietAt(st.lastActivityAt)) { log("proactive skip: 上次动静在静默时段 → " + conv); return false; }
  let opening = null;
  try { opening = await makeProactiveOpening({ conv, ctx: cleanProactiveCtx(st.ctx), life: lifeBrief(), onUsage: addTok }); }
  catch (e) { log("proactive gen fail: " + String(e.message).slice(0, 70)); }
  opening = sanitizeOutgoing(opening);
  if (!opening) return false;
  const _n = String(opening).replace(/\s+/g, "").length;
  const waitMs = Math.max(1200, Math.min(9000, 1000 + _n * 120 + Math.floor(Math.random() * 1500)));
  log("proactive → " + conv + ": " + opening + " (delay " + waitMs + "ms)");
  await page.waitForTimeout(waitMs);
  const r = await sendWithRetry(page, conv, opening);
  if (!r || !r.ok) { log("proactive send fail: " + (r && r.why)); return false; }
  const c = state.convs[conv] || (state.convs[conv] = { lastPreview: "", buffer: [], lastBufferAt: 0, recent: [], sent: [], fails: 0 });
  c.sent = (c.sent || []).concat({ text: opening, at: Date.now(), trusted: true }).slice(-30);
  c.ctx = (c.ctx || []).concat({ mine: true, text: opening }).slice(-30);
  c.lastPreview = opening;
  c.proactiveAt = Date.now();
  state.lastConv = conv;
  state.lastCustom = { text: opening, target: conv, at: Date.now() };
  try { recordProactive({ state, conv }); } catch (e) {}
  bump("sent");
  state.stats.proactive = (state.stats.proactive || 0) + 1;
  save();
  try { remember(conv, "", opening); } catch (e) {}
  await sendCard("【主动】她先开口了 →「" + conv + "」：" + opening);
  log("proactive send ok(" + r.how + ") → " + conv);
  return true;
}

// 媒体卡排队信息单独成函数：以前在主循环里直接引用块级 `dir`，
// 媒体卡一生成就 ReferenceError。这里只读 st 上的标记，测试也能覆盖。
function mediaQueue(st, title, incoming) {
  const s = st || {};
  return {
    conv: title,
    incoming,
    drafts: [],
    media: true,
    dirUnknown: !!s._dirUnknown,
    mine: !s._dirUnknown && !!s._dirMine,
    at: Date.now()
  };
}

// 分享视频固定回复的闸门：只回私聊、只回确实由对方发来的、自动开着、未静音、非静默。
// 不要求会话在 autoConvs 里——用户要的是「所有分享视频」都统一回。
export function videoAckAllowed(s, title, mq, now = Date.now()) {
  if (!s || !s.autoOn) return false;
  if (!mq || mq.dirUnknown || mq.mine !== false) return false;
  if (looksLikeGroup(title)) return false;
  const allowed = Array.isArray(s.allowedDMs) ? s.allowedDMs : [];
  if (allowed.length && !allowed.some(n => sameName(n, title))) return false;
  if ((s.muted || []).some(n => sameName(n, title))) return false;
  if ((s.blocked || []).some(n => sameName(n, title))) return false;
  if (inQuietAt(now)) return false;
  return true;
}

function card(p) {
  if (p.media) {
    // 别默认「ta 发来」：媒体占位符不带方向时，这卡以前会把我自己分享的视频说成对方发的。
    // 只有方向确实判出来（mine 是布尔）才说是谁发的；没判出来就明说没判准。
    const who = p.dirUnknown ? "方向没判准，可能是我自己发的"
      : (typeof p.mine === "boolean" ? (p.mine ? "你自己发的" : "对方发的") : "方向没标");
    return "【需要你看一眼】\n" + p.conv + " 有一条" + p.incoming + "（" + who + "），我没瞎猜。\n\n回 0 跳过，「用：内容」自己回。";
  }
  if (p.empty) {
    return "【这次没生成出来】\n" + p.conv + "：" + String(p.incoming || "").slice(0, 80) + "\n\n模型没吐合规句子（空或只有标点），我没发。\n回「改」按这条重试，「用：内容」自己发。";
  }
  const RISKY = /见面|出来玩|借钱|地址|电话|在哪|几点|来接|约好|帮我/;
  const warn = RISKY.test(p.incoming) ? "⚠️ 涉及时间/地点/钱，自己看一眼再发\n" : "";
  const q = state.queue.length ? "（还有 " + state.queue.length + " 条在排队）" : "";
  const kindLine = (!p.initiate && p.kind) ? "（对方这句：" + p.kind + "）\n" : "";
  const _cc = (state.convs[p.conv] || {}).ctx || [];
  const _normIn = norm(p.incoming);
  const _recentRows = [];
  for (const x of _cc) {
    const t = String(x.text || "").replace(/\s+/g, " ").trim();
    if (!t) continue;
    // 卡片头上已经写了对方这句，最近里不再重复
    if (!x.mine && _normIn && norm(t).length >= 2 && _normIn.includes(norm(t))) continue;
    // 引用只作为同一行的注脚，不另起一条「ta：」——否则看起来像对方说了两句话
    const qRaw = String(x.quote || "").replace(/\s+/g, " ").trim();
    const qShort = qRaw.length > 22 ? qRaw.slice(0, 22) + "…" : qRaw;
    const shown = qShort ? t + "（引用 " + qShort + "）" : t;
    const prev = _recentRows[_recentRows.length - 1];
    if (prev && prev.mine === !!x.mine && prev.text === shown) continue;
    _recentRows.push({ mine: !!x.mine, text: shown });
  }
  const recent = _recentRows.slice(-3).map(x => (x.mine ? "我：" : "ta：") + x.text.slice(0, 42)).join("\n");
  const recentLine = recent ? "\n最近：\n" + recent + "\n" : "";
  const lines = p.drafts.map((d, i) => (i + 1) + ". " + (p.tags && p.tags[i] ? "[" + p.tags[i] + "] " : "") + d).join("\n");
  const _ageMin = Math.floor((Date.now() - (p.at || Date.now())) / 60000);
  const ageLine = _ageMin >= 2 ? "（这条消息是 " + _ageMin + " 分钟前的）\n" : "";
  // 长消息别把卡片撑爆
  const _inFull = String(p.incoming || "");
  const inShort = _inFull.length > 140 ? _inFull.slice(0, 140) + "…（共 " + _inFull.length + " 字）" : _inFull;
  const head = p.initiate
    ? "【主动开口·给「" + p.conv + "」】\n你想让她说的意思：" + inShort
    : p.group
    ? "【群消息草稿】\n群「" + p.conv + "」" + (p.sender ? "·" + p.sender + " @" + "了你" : "") + "\n" + inShort
    : "【抖音私信草稿】\n" + p.conv + "：" + inShort;
  const autoLine = (p.autoWhy && state.autoOn) ? "（没自动发：" + p.autoWhy + "）\n" : "";
  return ageLine + autoLine + warn + head + "\n" + kindLine + recentLine + "\n" +
    lines +
    "\n————\n回 1 / 2 发到「" + p.conv + "」，12 连发两条，0 跳过，「改」重写，「用：内容」直接发\n改短 / 改狠 / 改软 / 改别问 换个方向重写；1短 / 2狠 / 12短 按改过的发" + q;
}

// ---------- 自动回复 ----------
function nowHM() {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date()).split(":");
    return parts[0] + ":" + parts[1];
  } catch { return "12:00"; }
}
function inQuietRange(hm) {
  const q = String(state.autoQuiet || "23:30-07:00").split("-");
  const a = q[0] || "23:30", b = q[1] || "07:00";
  if (a <= b) return hm >= a && hm < b;
  return hm >= a || hm < b;
}
function nowHMAt(ts) {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(Number(ts))).split(":");
    return parts[0] + ":" + parts[1];
  } catch { return ""; }
}
// 某个时间点（消息收到的时间）是否落在静默时段；静默期收到的话不在早上补发
export function inQuietAt(ts) {
  const n = Number(ts || 0);
  if (!n) return false;
  const hm = nowHMAt(n);
  return !!hm && inQuietRange(hm);
}
let AUTO_WHY = "";
const AUTO_RISKY = /见面|出来玩|借钱|钱|地址|电话|在哪|几点|来接|约好|医院|考试|家长|老师|学校|投诉|举报|截图|身份证|转账|密码|银行卡/;
function autoEligible(q) {
  AUTO_WHY = "";
  const no = (why) => { AUTO_WHY = why; return false; };
  if (!state.autoOn) return no("自动回复是关着的");
  if (!q) return no("没有草稿");
  if (q.media) return no("这条不是文字");
  if (q.fromQuiet) return no("这条是静默时段收到的，早上不自动补");
  if (!(q.drafts || []).length || !q.drafts[0]) return no("没有草稿");
  if ((state.muted || []).includes(q.conv)) return no("这个会话被静音了");
  if (q.empty) return no("这次没生成出草稿");
  const _d0 = String((q.drafts || [])[0] || "").trim();
  if (!_d0) return no("草稿是空的");
  if (/^[？?！!。.…~～\s]+$/.test(_d0)) return no("草稿只有标点，不自动发");
  const m1 = String(q.incoming || "").match(AUTO_RISKY);
  if (m1) return no("对方这句里有「" + m1[0] + "」，涉及时间/地点/钱，得你自己看");
  const m2 = (q.drafts || []).join(" ").match(AUTO_RISKY);
  if (m2) return no("草稿里有「" + m2[0] + "」，涉及时间/地点/钱，得你自己看");
  if (inQuietRange(nowHM())) return no("现在在静默时段 " + (state.autoQuiet || "23:30-07:00"));
  const day = today();
  if (q.group) {
    if (!(state.autoGroups || []).some(n => sameName(n, q.conv))) return no("这个群没开自动（自动 群 开 群名）");
    const gcap = Number(state.autoGroupDailyCap || 10);
    if (state.gDay !== day) { state.gDay = day; state.gCount = 0; save(); }
    if ((state.gCount || 0) >= gcap) return no("群今日额度用完了 " + gcap + " 条");
    return true;
  }
  const list = state.autoConvs || [];
  if (list.length && !list.some(n => sameName(n, q.conv))) return no("这个人不在自动范围里（自动 开 昵称）");
  const cap = Number(state.autoDailyCap || 80);
  if (state.autoDay !== day) { state.autoDay = day; state.autoCount = 0; save(); }
  if ((state.autoCount || 0) >= cap) return no("今日额度用完了 " + cap + " 条");
  return true;
}

// ---------- 回复节奏（只分档延迟；挑着回已按用户要求删除）----------
// 配置 douyin-dm/rhythm.json（缺省用默认）；每次回之前现读，改完不用重启
const RHYTHM_PATH = DIR + "/rhythm.json";
const RHYTHM_DEF = {
  q: [2500, 7000],      // 问句：快
  casual: [5000, 15000],
  heavy: [4000, 11000], // 诉苦
  group: [4000, 10000],
  perChar: 110, typedMin: 1200, typedMax: 6000,
  lateMul: 1.25,        // 0-6 点慢一点
  cap: 26000
};
function rhythmCfg() {
  try { return { ...RHYTHM_DEF, ...JSON.parse(readFileSync(RHYTHM_PATH, "utf8")) }; }
  catch { return { ...RHYTHM_DEF }; }
}
const ASK_RE = /[？?]|吗|什么|啥|谁|哪|怎么|干嘛|干啥|几点|多久|在不在/;
function replyDelayMs(q, cfg) {
  const inc = String(q.incoming || "").trim();
  const n = String((q.drafts || [])[0] || "").replace(/\s+/g, "").length;
  let band = cfg.casual;
  if (q.group) band = cfg.group;
  else if (String(q.kind || "") === "诉苦") band = cfg.heavy;
  else if (ASK_RE.test(inc)) band = cfg.q;
  let ms = band[0] + Math.random() * Math.max(0, band[1] - band[0]);
  // 打字时间跟句子长短走（短句别拖，长句别秒回）
  ms += Math.max(cfg.typedMin, Math.min(cfg.typedMax, 400 + n * cfg.perChar)) * (0.6 + Math.random() * 0.6);
  const h = Number(nowHM().slice(0, 2));
  if (h >= 0 && h < 6) ms *= cfg.lateMul;
  return Math.max(1500, Math.min(cfg.cap, Math.round(ms)));
}
async function manualTookOver(page, conv) {
  try {
    if (!(await ensureConversation(page, conv))) return false;
    return lastRealIsMine(await readBubbles(page, 8));
  } catch { return false; }
}

async function autoSend(page, q) {
  const draft = sanitizeOutgoing(q.drafts[0]);
  if (!draft) { state.pending = null; save(); log("skip empty draft [" + q.conv + "]"); return; }
  const outText = (q.group && q.sender) ? "@" + q.sender.replace(/^@/, "").replace(/\s+/g, "") + " " + draft : draft;
  // 有消息就必回：不再随机挑着回，只保留「隔多久回」的节奏。
  const _cfg = rhythmCfg();
  const waitMs = replyDelayMs(q, _cfg);
  log("auto delay " + waitMs + "ms → " + q.conv + ": " + draft);
  await page.waitForTimeout(waitMs);
  // 等这几秒里用户可能已经手动回了；最新一条是我发的就收手，别把同一句补第二遍。
  if (!q.force && await manualTookOver(page, q.conv)) {
    state.pending = null;
    save();
    log("auto cancel：最新一条是我发的，像是你已经自己回了 → " + q.conv);
    try { await sendCard("【自动】「" + q.conv + "」最新一条已经是你的消息，这条草稿没发。"); } catch {}
    return;
  }
  const r = await sendWithRetry(page, q.conv, outText);
  const c = state.convs[q.conv] || (state.convs[q.conv] = { lastPreview: "", buffer: [], lastBufferAt: 0, recent: [], sent: [], fails: 0 });
  if (r.ok) {
    c.lastPreview = draft;
    c.sent = (c.sent || []).concat({ text: draft, at: Date.now(), trusted: true }).slice(-30);
    c.ctx = (c.ctx || []).concat({ mine: true, text: draft }).slice(-30);
    state.pending = null; state.lastConv = q.conv; bump("sent");
    clearRecentIncoming(state, q.conv);
    state.stats.auto = (state.stats.auto || 0) + 1;
    if (q.group) { state.gDay = today(); state.gCount = (state.gCount || 0) + 1; }
    else { state.autoDay = today(); state.autoCount = (state.autoCount || 0) + 1; }
    state.lastCustom = { text: draft, target: q.conv, at: Date.now() };
    save();
    try { remember(q.conv, q.incoming, outText); } catch {}
    await sendCard((q.group ? "【自动·群】" : "【自动】") + "已发「" + q.conv + "」：" + outText + (q.kind ? "（" + q.kind + "）" : ""));
    await maybeSticker(page, q.conv, q.tags || []);
    log("auto send ok(" + r.how + ") → " + q.conv);
  } else {
    state.pending = q;
    q._autoTryAt = 0;
    save();
    await sendCard("【自动】没确认到「" + q.conv + "」，退回手动：" + draft);
    q.cardSent = true;
    q._cardAt = Date.now();
    q._lastRemindAt = 0;
    save();
    log("auto send fail → " + q.conv + " " + r.why);
  }
}

// ---------- web ----------
let HB = { beat: 0, cycle: 0, convs: 0, top: [] };
const srv = createServer((req, res) => {
  if (req.url.startsWith("/api")) {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    const _mem = process.memoryUsage();
    res.end(JSON.stringify({
      pending: state.pending, mediaPending: state.mediaPending || null, queue: state.queue.length, hb: HB,
      pid: process.pid,
      autoOn: !!state.autoOn,
      autoCount: state.autoDay === today() ? (state.autoCount || 0) : 0,
      autoConvs: state.autoConvs || [],
      autoGroups: state.autoGroups || [],
      proactiveOn: !!state.proactiveOn,
      proactiveConvs: state.proactiveConvs || [],
      uptimeMin: Math.round(process.uptime() / 60),
      memMB: Math.round(_mem.rss / 1048576),
      boots, detect: (state.detect || []).length,
      buffers: Object.entries(state.convs || {}).filter(([, v]) => (v.buffer || []).length).map(([k, v]) => k + ":" + v.buffer.length),
      refreshedMinAgo: lastRefreshAt ? Math.round((Date.now() - lastRefreshAt) / 60000) : null,
    }));
  } else {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end("<meta charset=utf-8><body style='background:#111;color:#eee;font:15px sans-serif;padding:16px'><pre id=o></pre><script>setInterval(async()=>{document.getElementById('o').textContent=JSON.stringify(await (await fetch('/api')).json(),null,1)},3000)</script>");
  }
});
if (!process.env.WATCHER_TEST) srv.listen(PORT, "127.0.0.1");

// ---------- browser ----------
let ctx = null, page = null;
let initBuf = null;
let selfUid = null;

async function reloadAndInit() {
  initBuf = null;
  try {
    const waitResp = page.waitForResponse(r => r.url().includes("get_message_by_init") && r.status() === 200, { timeout: 25000 }).catch(() => null);
    await page.reload({ waitUntil: "domcontentloaded", timeout: 45000 });
    const resp = await waitResp;
    if (resp) { try { initBuf = Buffer.from(await resp.body()); } catch {} }
  } catch (e) { log("reload err: " + String(e.message).slice(0, 80)); }
  for (let i = 0; i < 12 && !initBuf; i++) await page.waitForTimeout(500);
  log("init payload: " + (initBuf ? (initBuf.length / 1024).toFixed(0) + "KB" : "none"));
  return initBuf;
}

async function fetchSelfUid() {
  try {
    const t = await page.evaluate(async () => {
      const r = await fetch("/aweme/v1/web/user/profile/self/?device_platform=webapp&aid=6383", { credentials: "include" });
      return await r.text();
    });
    const j = JSON.parse(t);
    selfUid = j?.user?.sec_uid || null;
  } catch { selfUid = null; }
  log("selfUid: " + (selfUid ? selfUid.slice(0, 24) : "null"));
}
let bootAt = 0;

async function boot() {
  bootAt = Date.now();
  if (ctx) { try { await ctx.close(); } catch {} }
  ctx = await getChromium().launchPersistentContext(process.env.DOUYIN_PROFILE || join(DIR, ".profile"), {
    executablePath: process.env.EDGE_PATH || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    // [静默补丁] headless —— 不弹可见窗口（之前每重启一次就冒一个 Edge 窗口）
    headless: process.env.HEADLESS !== "false", viewport: { width: 1280, height: 900 },
    args: ["--no-first-run", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--remote-debugging-port=" + (process.env.CDP_PORT || "9222")],
  });
  page = ctx.pages()[0] || await ctx.newPage();
  if (!page.url().includes("douyin.com")) await page.goto("https://www.douyin.com/chat", { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForSelector(".conversationConversationItemwrapper", { timeout: 30000 });
  HB.beat = Date.now();
  bootAt = 0;
  log("browser ready: " + page.url());
}

// 主循环卡死自救：心跳 6 分钟没动就退出，交给 DouyinDMWatcherDog 重启
if (!process.env.WATCHER_TEST) setInterval(() => {
  if (bootAt) return;                              // 正在 boot，别打断
  const beat = HB.beat || Date.now();
  const age = Date.now() - beat;
  if (age > 6 * 60 * 1000) {
    log("!! 主循环卡死 " + Math.round(age / 60000) + " 分钟，退出等 watchdog 重启");
    process.exit(1);
  }
}, 60 * 1000);

// 被 import（WATCHER_TEST=1）时只导出纯函数，不起浏览器
const TESTING = !!process.env.WATCHER_TEST;
if (!TESTING) {
  // 开机时网络/Edge 可能还没就绪：登录任务只拉一次，失败就等狗任务 5 分钟。
  // 启动自己重试 3 次（8s/16s），大多数开机抖动能在 30 秒内过去。
  let bootErr = null;
  for (let i = 1; i <= 3; i++) {
    try { await boot(); bootErr = null; break; }
    catch (e) {
      bootErr = e;
      log("boot fail (" + i + "/3): " + String(e.message || e).slice(0, 140));
      if (i < 3) await new Promise(r => setTimeout(r, i * 8000));
    }
  }
  if (bootErr) {
    log("boot give up after 3 tries: " + String(bootErr.message || bootErr).slice(0, 140));
    process.exit(1);
  }
}
if (!TESTING) await fetchSelfUid();

// 启动时把所有会话的预览对齐，避免把停机期间的变化当成新消息
// 老版本 readAll 会把「昨天 23:39」留在预览里。新版本比较前先清洗，否则重启后
// 每个会话的 lastPreview 都对不上，会把历史消息全部当新消息重出一遍卡。
if (!TESTING && !state.migTimePrefix) {
  let _fixed = 0;
  const _clean = (s) => { const c = cleanListPreview(s); return c.text; };
  for (const st of Object.values(state.convs || {})) {
    const nv = _clean(st.lastPreview);
    if (nv !== st.lastPreview) { st.lastPreview = nv; _fixed++; }
    for (const x of (st.ctx || [])) { const v = _clean(x.text); if (v && v !== x.text) x.text = v; }
    for (const x of (st.sent || [])) { const v = _clean(x.text); if (v && v !== x.text) x.text = v; }
    for (const x of (st.recent || [])) { const v = _clean(x.text); if (v && v !== x.text) x.text = v; }
    for (const x of (st.buffer || [])) { const v = _clean(x.text); if (v && v !== x.text) x.text = v; }
  }
  for (const d of (state.detect || [])) { const v = _clean(d.text); if (v && v !== d.text) d.text = v; }
  for (const q of (state.queue || [])) { const v = _clean(q.incoming); if (v && v !== q.incoming) q.incoming = v; }
  if (state.pending) { const v = _clean(state.pending.incoming); if (v && v !== state.pending.incoming) state.pending.incoming = v; }
  state.migTimePrefix = true; // 只清洗一次：避免以后把「12:30 我在吃饭」这种正常开头也永久剥掉
  if (_fixed) log("migrate lastPreview: " + _fixed + " 个会话去掉时间前缀");
  save();
}

// 历史 state 里已经混进了 [[语音:...|...]] 原始标记：只清自己的话和预览，对方原文不动。
// 只跑一次，之后新生成的内容在 shapeDrafts/sendToDouyin 就已经转成纯文字。
if (!TESTING && !state.migVoice) {
  let _vf = 0;
  const _vs = (s) => { const t = sanitizeOutgoing(s); if (t !== s) _vf++; return t || s; };
  for (const st of Object.values(state.convs || {})) {
    if (!st) continue;
    if (st.lastPreview) st.lastPreview = _vs(st.lastPreview);
    for (const x of (st.sent || [])) if (x && x.text) x.text = _vs(x.text);
    for (const x of (st.ctx || [])) if (x && x.mine && x.text) x.text = _vs(x.text);
  }
  if (state.lastCustom && state.lastCustom.text) state.lastCustom.text = _vs(state.lastCustom.text);
  for (const o of (Array.isArray(state.outbox) ? state.outbox : [])) if (o && o.text) o.text = _vs(o.text);
  for (const q of [...(Array.isArray(state.queue) ? state.queue : []), ...(state.pending ? [state.pending] : [])]) {
    if (Array.isArray(q.drafts)) q.drafts = q.drafts.map(_vs);
    if (q.fromQuiet == null && inQuietAt(q.at)) q.fromQuiet = true;
  }
  state.migVoice = true;
  if (_vf) log("migrate voice tags: " + _vf);
  save();
}

let bootConvCount = 0;
if (!TESTING && state.convs) {
  try {
    const all0 = await readAll(page);
    bootConvCount = all0.length;
    const now0 = Date.now();
    state.detect = (state.detect || []).filter(d => now0 - (d.at || 0) < QUEUE_TTL);
    // 停机期间对方发来的消息：预览变了 + 时间标签是刚发生的，就先记进 detect，别被 baseline 吞掉
    for (const c of all0) {
      const st = state.convs[c.title];
      if (!st) continue;
      noteConvUid(st, c.targetUid);
      const isGroup = looksLikeGroup(c.title) || c.convType === 2;
      if (!isGroup && (state.allowedDMs || []).length && !state.allowedDMs.some(n => sameName(n, c.title))) continue;
      const changed = c.preview && c.preview !== st.lastPreview;
      const t = String(c.time || "");
      const fresh = /刚刚|秒前|分钟前/.test(t);
      const hm = t.match(/^(\d+)\s*分钟前/);
      const recentWithin = !!hm && Number(hm[1]) <= 10;
      // 群消息启动时不补：群要看 @，这里没有发送者和 @ 解析，补了会把群分享当私聊出卡。
      if (!isGroup && changed && (fresh || recentWithin) && !/^\[/.test(c.preview) && !isNoisePreview(c.preview)) {
        if (readBeforeDraft(c.unread, isGroup, 0, Date.now(), !!c.active, !!c.unreadByIndex)) {
          log("startup catch: [" + c.title + "] 已读，跳过（unread=0）");
        } else {
          const dup = (state.queue || []).some(q => q.conv === c.title) ||
            (state.detect || []).some(d => d.conv === c.title && cmpKey(d.text) === cmpKey(c.preview));
          if (!dup) {
            state.detect.push({ conv: c.title, text: c.preview, at: now0, group: false, sender: "", uid: c.targetUid || "" });
            log("startup catch: [" + c.title + "] " + c.preview.slice(0, 30) + " (" + t + ")");
          }
        }
      }
      st.lastPreview = c.preview;
      st.lastKey = c.lastKey || "";
    }
    // 把还没出卡的消息塞回缓冲：重启打断草稿也不再丢
    for (const d of state.detect) {
      const st = state.convs[d.conv];
      if (!st) continue;
      const hitRecent = (st.recent || []).some(r => cmpKey(r.text) === cmpKey(d.text));
      const inBuf = (st.buffer || []).some(b => cmpKey(b.text) === cmpKey(d.text));
      if (hitRecent || inBuf) continue;
      if (isNoisePreview(d.text)) continue;
      noteConvUid(st, d.uid);
      st.buffer = (st.buffer || []).concat({ text: d.text, at: d.at });
      st.lastBufferAt = 0;
      st._verify = true;
      if (d.group) st._group = true;
      if (d.sender) st._sender = d.sender;
      log("resume 待出卡: [" + d.conv + "] " + String(d.text).slice(0, 30));
    }
    // 启动时清掉过期草稿，避免把半小时前的旧消息当新消息推给你
    const _now = Date.now();
    const _qb = (state.queue || []).length;
    state.queue = (state.queue || []).filter(q => _now - (q.at || 0) < QUEUE_TTL);
    if (state.pending && _now - (state.pending.at || 0) > PENDING_TTL) state.pending = null;
    if (_qb !== state.queue.length) log("startup purge stale queue: " + (_qb - state.queue.length));
    save();
    log("startup baseline: " + all0.length + " convs");
  } catch {}
}

if (!TESTING && !state.convs) {
  const all = await readAll(page);
  bootConvCount = all.length;
  state.convs = {};
  for (const c of all) {
    const st = { lastPreview: c.preview, buffer: [], lastBufferAt: 0, recent: [], sent: [], fails: 0 };
    noteConvUid(st, c.targetUid);
    state.convs[c.title] = st;
  }
  save();
  log("baseline " + Object.keys(state.convs).length + " conversations");
}

// 重启时先处理上次没走完的 pending，再发启动健康卡（成功/0 会话都告诉你）
if (!TESTING) {
  await recoverPending();
  await sendBootCard(bootConvCount);
}

const STAT0 = () => ({ day: today(), msgs: 0, cards: 0, sent: 0, errs: 0, tokIn: 0, tokOut: 0, tokCalls: 0 });
state.stats = state.stats || STAT0();
// 老 state 里没有账单字段：启动时就补齐并落盘，别等第一次出卡
if (["tokIn", "tokOut", "tokCalls"].some(k => typeof state.stats[k] !== "number")) {
  for (const k of ["tokIn", "tokOut", "tokCalls"]) if (typeof state.stats[k] !== "number") state.stats[k] = 0;
  save();
}
function today() { return new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" }); }
// 跨天就滚：昨天那份留在 yStats 给日报用，不再依赖 9 点那一刻有没有跑到
function rollStats() {
  const t = today();
  if (!state.stats) { state.stats = STAT0(); return true; }
  if (!state.stats.day) { state.stats.day = t; return true; }
  for (const k of ["tokIn", "tokOut", "tokCalls"]) if (typeof state.stats[k] !== "number") state.stats[k] = 0;
  if (state.stats.day !== t) {
    state.yStats = Object.assign({}, state.stats);
    state.stats = STAT0();
    return true;
  }
  return false;
}
function bump(k) { rollStats(); state.stats[k] = (state.stats[k] || 0) + 1; }
// 模型账单：makeDrafts 返回的 usage（g1+g2 已合并）累加进今日 stats
function addTok(u) {
  if (!u) return;
  rollStats();
  const s = state.stats;
  s.tokIn = (s.tokIn || 0) + Number(u.prompt_tokens || 0);
  s.tokOut = (s.tokOut || 0) + Number(u.completion_tokens || 0);
  s.tokCalls = (s.tokCalls || 0) + 1;
}
log("watching " + Object.keys(state.convs || {}).length + " convs → feishu " + CHAT + " pid=" + process.pid);
backupState();
let loginFails = 0;
let boots = 0;
let lastRefreshAt = Date.now();
const REFRESH_MS = 90 * 60 * 1000;
let lastStructCheckAt = 0, lastStructAlertAt = 0;  // 0 = 启动就先自检一次
let errStreak = 0, lastAlertAt = 0;

while (!TESTING) {
  try {
    if (rollStats()) save();  // 跨天自动滚（不发消息也要滚，否则「状态」里的今日计数永远是昨天）
    if (!page || page.isClosed()) { log("page closed → reboot"); await boot(); boots++; }

    // 1) 飞书指令
    // 先清过期草稿：否则停机几小时后，旧指令「1」会把过期草稿发出去
    if (state.pending && Date.now() - state.pending.at > PENDING_TTL) {
      const old = state.pending;
      state.pending = null; save();
      log("pending expired: " + old.conv);
      await sendCard("「" + old.conv + "」那份草稿过期了（" + Math.round(PENDING_TTL / 60000) + " 分钟），没发。");
    }
    try { await flushOutbox(); } catch (e) { log("outbox flush err: " + String(e.message || e).slice(0, 80)); }
    const fSeen = new Set(Array.isArray(state.feishuSeen) ? state.feishuSeen : []);
    for (const m of await readGroup(50)) {
      const ts = Number(m.create_time);
      if (!Number.isFinite(ts) || ts <= state.lastFeishuTs) continue;
      const mid = String(m.message_id || (m.create_time + ":" + String(m.body?.content || "").slice(0, 80)));
      state.lastFeishuTs = ts;
      if (fSeen.has(mid)) { save(); continue; }
      fSeen.add(mid);
      state.feishuSeen = [...fSeen].slice(-30);
      save(); // 游标先落盘：命令处理到一半重启也不会重复执行
      if (m.sender?.sender_type === "app") continue;
      let text = "";
      try { text = (JSON.parse(m.body?.content || "{}").text || "").trim(); } catch {}
      if (!text) continue;
      const cmd = normalizeCmd(text);
      log("cmd: " + text);

      // 「让 某人 说：话题」：用户指定白名单私聊，先生成候选，再走和草稿一样的 1/2/0/改 审批。
      const initCmd = parseInitiateCommand(text);
      if (initCmd) {
        if (state.pending) { await sendCard("手上还有一张待审草稿，先回 1/2/0 处理掉，再让我主动发。"); continue; }
        const target = resolveWhitelistDm(state, initCmd.target);
        if (!target) { await sendCard("「" + initCmd.target + "」不在白名单私聊里（或者这是群）。先回「私聊列表」看名字。"); continue; }
        await sendCard("给「" + target + "」按 522 的口气写几句，等我十几秒…");
        let list = [];
        try {
          list = await makeOpenings({ conv: target, ctx: ((state.convs[target] || {}).ctx || []).slice(-8), life: lifeBrief(), topic: initCmd.topic, n: 4, onUsage: addTok });
        } catch (e) { log("initiate gen err: " + String(e.message || e).slice(0, 100)); }
        if (!list.length) { await sendCard("这次没生成出合规的句子。换个说法再试一次。"); continue; }
        const shaped = shapeDrafts(list, list.map((_, i) => i ? "备选" : "主动"));
        if (!shaped.drafts.length) { await sendCard("生成出来的句子都被过滤了（太像客服/空句/元信息）。换个说法再试。"); continue; }
        state.pending = {
          conv: target, incoming: initCmd.topic, drafts: shaped.drafts.slice(0, 2), tags: shaped.tags.slice(0, 2),
          kind: "主动", group: false, sender: "", at: Date.now(), initiate: true, cardSent: false
        };
        bump("cards"); save();
        await sendCard(card(state.pending));
        state.pending.cardSent = true;
        state.pending._cardAt = Date.now();
        save();
        log("initiate card → " + target + ": " + JSON.stringify(state.pending.drafts));
        continue;
      }

      if (cmd === "关表情") { state.autoSticker = false; save(); await sendCard("已关掉自动表情包"); continue; }
      if (cmd === "开表情") { state.autoSticker = true; save(); await sendCard("已打开自动表情包（三成概率）"); continue; }
      if (cmd.startsWith("表情")) {
        const who = text.replace(/^表情\s*/, "").trim() || (state.pending && state.pending.conv) || state.lastConv || "";
        if (!who) { await sendCard("用法：表情 昵称（或先发一条消息，我记住是哪个会话）"); continue; }
        let files = [];
        try { files = readdirSync(STICKERS).filter(f => /\.(png|jpg|jpeg|gif|webp)$/i.test(f)); } catch {}
        if (!files.length) { await sendCard("表情包目录是空的"); continue; }
        const f = files[Math.floor(Math.random() * files.length)];
        const r = await sendSticker(page, who, STICKERS + "/" + f);
        await sendCard(r.ok ? "已给「" + who + "」发了一张：" + f : "表情包发送失败：" + (r.why || ""));
        if (r.ok) {
          state.lastConv = who;
          try {
            const all = await readAll(page);
            const cc = all.find(x => x.title === who);
            if (cc) {
              const st = state.convs[who] || (state.convs[who] = { lastPreview: "", buffer: [], lastBufferAt: 0, recent: [], sent: [], fails: 0 });
              st.lastPreview = cc.preview;
            }
          } catch {}
          save();
          log("sticker → " + who + ": " + f);
        }
        continue;
      }
      if (cmd === "帮助" || cmd === "help" || cmd === "？") {
        await sendCard("指令：\n1 / 2 发草稿\n12 或 连 连发两条\n0 跳过\n改 重写（改短 / 改狠 / 改软 / 改别问 / 改夸）\n1短 / 2狠 / 12软 改一版再发\n用：内容 自己发（用 昵称：内容 指定人）\n让 昵称 说：话题 生成主动消息（先出卡，1/2 发）\n表情 昵称\n静音 昵称 / 恢复 昵称\n状态 / 刷新 / 备份\n主动 开 / 主动 关 / 主动 状态 / 主动 试 昵称\n自动 开 / 自动 关 / 自动 状态\n自动 群 开 群名 / 自动 群 上限 10\n刷新（重载抖音页面）\n私聊列表 / 群列表 / 状态 / 帮助");
        continue;
      }
      if (cmd.startsWith("静音")) {
        const who = text.replace(/^静音\s*/, "").trim();
        if (!who) { await sendCard("用法：静音 昵称"); continue; }
        if (!state.muted.includes(who)) state.muted.push(who);
        save(); await sendCard("已静音「" + who + "」，不再出草稿。回「恢复 " + who + "」解开。");
        log("muted " + who);
        continue;
      }
      if (cmd.startsWith("恢复")) {
        const who = text.replace(/^恢复\s*/, "").trim();
        state.muted = state.muted.filter(x => x !== who);
        save(); await sendCard("已恢复「" + who + "」");
        log("unmuted " + who);
        continue;
      }
      if (cmd.startsWith("艾特名")) {
        const nm = text.replace(/^艾特名\s*/, "").trim();
        if (!nm) { await sendCard("用法：艾特名 你在群里的昵称"); continue; }
        state.mentionNames = [nm, "522"];
        save(); await sendCard("已记住：群里 @「" + nm + "」才算叫你"); continue;
      }
      if (cmd === "私聊列表") {
        const list = state.allowedDMs || [];
        await sendCard("白名单（" + list.length + " 个）：\n" + (list.length ? list.map(x => "✅ " + x).join("\n") : "（空的，等于全放开）"));
        continue;
      }
      if (cmd.startsWith("开私聊")) {
        const nm = text.replace(/^开私聊\s*/, "").trim();
        if (!nm) { await sendCard("用法：开私聊 昵称"); continue; }
        if (!state.allowedDMs.some(x => sameName(x, nm))) state.allowedDMs.push(nm);
        save(); await sendCard("已加入白名单：" + nm);
        continue;
      }
      if (cmd.startsWith("关私聊")) {
        const nm = text.replace(/^关私聊\s*/, "").trim();
        state.allowedDMs = (state.allowedDMs || []).filter(x => !sameName(x, nm));
        save(); await sendCard("已移出白名单：" + nm);
        continue;
      }
      if (cmd === "群列表") {
        const gs = Object.keys(state.convs || {});
        const groups = gs.filter(t => looksLikeGroup(t));
        await sendCard("群列表：\n" + (groups.length ? groups.map(g => (state.allowedGroups.some(x => sameName(x, g)) ? "✅ " : "⬜ ") + g).join("\n") : "（没有）") + "\n\n开群/关群 后面跟群名");
        continue;
      }
      if (cmd.startsWith("开群")) {
        const g = text.replace(/^开群\s*/, "").trim();
        if (!g) { await sendCard("用法：开群 群名（先回「群列表」看名字）"); continue; }
        if (!state.allowedGroups.some(x0 => sameName(x0, g))) state.allowedGroups.push(g);
        save(); await sendCard("已开群：「" + g + "」，只在你被 @ 时触发");
        continue;
      }
      if (cmd.startsWith("关群")) {
        const g = text.replace(/^关群\s*/, "").trim();
        state.allowedGroups = state.allowedGroups.filter(x => !sameName(x, g));
        save(); await sendCard("已关群：「" + g + "」");
        continue;
      }
      if (cmd === "刷新" || cmd === "刷新页面") {
        await sendCard("刷新页面中…");
        try {
          await page.reload({ waitUntil: "domcontentloaded", timeout: 45000 });
          await page.waitForTimeout(4000);
          const chk = await readAll(page);
          lastRefreshAt = Date.now();
          HB = { ...HB, convs: chk.length };
          save();
          await sendCard("刷新好了，读到 " + chk.length + " 个会话\n内存：" + Math.round(process.memoryUsage().rss / 1048576) + "MB");
          log("manual refresh ok, " + chk.length + " convs");
        } catch (e) {
          await sendCard("刷新失败：" + String(e.message).slice(0, 80) + "\n我先自己重启一下");
          log("manual refresh err: " + String(e.message).slice(0, 80));
          try { await boot(); boots++; } catch {}
        }
        continue;
      }
      if (cmd === "备份") {
        backupState();
        let list = [];
        try { list = readdirSync(DIR + "/backups").filter((f) => f.endsWith(".json")).sort().reverse(); } catch (e) {}
        await sendCard("state.json 已备份（共 " + list.length + " 份，留 7 份）：\n" + (list.slice(0, 6).join("\n") || "没有备份"));
        continue;
      }
      if (cmd === "状态") {
        {
          const _mem = process.memoryUsage();
          const _bufs = Object.entries(state.convs || {}).filter(([, v]) => (v.buffer || []).length).map(([k, v]) => k + "×" + v.buffer.length);
          await sendCard("在跑：" + Object.keys(state.convs || {}).length + " 个会话\n" +
            "待审：" + (state.pending ? state.pending.conv : "无") + "\n" +
            "排队：" + state.queue.length + "\n" +
            "待出卡：" + (state.detect || []).length + "\n" +
            "缓冲中：" + (_bufs.length ? _bufs.join("、") : "无") + "\n" +
            "登录：" + (loginFails ? "读不到会话" : "正常") + "\n" +
            "重启次数：" + boots + "\n" +
            "内存：" + Math.round(_mem.rss / 1048576) + "MB　运行：" + Math.round(process.uptime() / 60) + " 分钟\n" +
            "上次整页刷新：" + (lastRefreshAt ? Math.round((Date.now() - lastRefreshAt) / 60000) + " 分钟前" : "还没") +
            ((state.stats && (state.stats.dirDom || state.stats.dirSent || state.stats.dirPayload))
              ? "\n判向(今日)：DOM " + (state.stats.dirDom || 0) + " / 登记 " + (state.stats.dirSent || 0) + " / 兜底 " + (state.stats.dirPayload || 0)
              : ""));
        }
        continue;
      }
      if (cmd.startsWith("主动")) {
        const rest = text.replace(/^主动\s*/, "").trim();
        const pst = () => "主动开口：" + (state.proactiveOn ? "开" : "关") +
          "\n时段：" + (state.proactiveHours || "09:00-23:30") +
          "\n冷却：" + (state.proactiveCooldownMin == null ? 180 : state.proactiveCooldownMin) + " 分钟" +
          "\n冷场门槛：" + (state.proactiveIdleMin == null ? 120 : state.proactiveIdleMin) + " 分钟" +
          "\n每天上限：" + (state.proactiveDailyCap == null ? 2 : state.proactiveDailyCap) + " 条（今日 " + ((state.proactiveDay === today()) ? (state.proactiveCount || 0) : 0) + "）" +
          "\n候选：" + ((state.autoConvs || []).join("、") || "空（先用 自动 开 昵称 指定）") +
          "\n最近：" + (((state.proactiveLog || []).slice(-3).map((x) => x.conv + " " + new Date(x.at).toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit" }))).join(" / ") || "还没开过口");
        if (!rest || rest === "状态") { await sendCard(pst()); continue; }
        if (rest === "开") {
          state.proactiveOn = true; save();
          await sendCard("已打开主动开口。\n" + pst() + "\n\n（要立刻看效果：主动 试 昵称）");
          continue;
        }
        if (rest === "关") { state.proactiveOn = false; save(); await sendCard("已关掉主动开口"); continue; }
        let rp = rest.match(/^时段\s*(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/);
        if (rp) { state.proactiveHours = rp[1].padStart(5, "0") + "-" + rp[2].padStart(5, "0"); save(); await sendCard("主动时段改成 " + state.proactiveHours); continue; }
        rp = rest.match(/^上限\s*(\d{1,2})$/);
        if (rp) { state.proactiveDailyCap = Number(rp[1]); save(); await sendCard("主动每天上限：" + state.proactiveDailyCap + " 条"); continue; }
        rp = rest.match(/^冷却\s*(\d{1,4})$/);
        if (rp) { state.proactiveCooldownMin = Number(rp[1]); save(); await sendCard("主动冷却：" + state.proactiveCooldownMin + " 分钟"); continue; }
        rp = rest.match(/^冷场\s*(\d{1,4})$/);
        if (rp) { state.proactiveIdleMin = Number(rp[1]); save(); await sendCard("主动冷场门槛：" + state.proactiveIdleMin + " 分钟没说话才开口"); continue; }
        rp = rest.match(/^试\s*(.+)$/);
        if (rp) {
          const who = rp[1].trim();
          if (!state.convs[who]) { await sendCard("没这个会话：「" + who + "」"); continue; }
          await sendCard("试一次主动开口 →「" + who + "」，等我十几秒…");
          const st1 = state.convs[who] || {};
          let op = null;
          try { op = await makeProactiveOpening({ conv: who, ctx: (st1.ctx || []).slice(-8), life: lifeBrief(), onUsage: addTok }); } catch (e) { op = null; }
          op = sanitizeOutgoing(op);
          if (!op) { await sendCard("这次没生成出来（模型没给合规的句子），等会儿再试"); continue; }
          await page.waitForTimeout(1500);
          const rr = await sendWithRetry(page, who, op);
          if (rr && rr.ok) {
            const cc = state.convs[who] || (state.convs[who] = { lastPreview: "", buffer: [], lastBufferAt: 0, recent: [], sent: [], fails: 0 });
            cc.sent = (cc.sent || []).concat({ text: op, at: Date.now(), trusted: true }).slice(-30);
            cc.ctx = (cc.ctx || []).concat({ mine: true, text: op }).slice(-30);
            cc.lastPreview = op;
            cc.proactiveAt = Date.now();
            state.lastConv = who;
            state.lastCustom = { text: op, target: who, at: Date.now() };
            try { recordProactive({ state, conv: who }); } catch (e) {}
            bump("sent"); state.stats.proactive = (state.stats.proactive || 0) + 1;
            save();
            try { remember(who, "", op); } catch (e) {}
            await sendCard("【主动·试】已发「" + who + "」：" + op);
          } else await sendCard("没确认到发出去（" + (rr && rr.why) + "），你自己看下抖音");
          continue;
        }
        await sendCard("用法：主动 开 / 关 / 状态 / 时段 09:00-23:30 / 上限 2 / 冷却 180 / 冷场 120 / 试 昵称");
        continue;
      }
      if (cmd.startsWith("自动")) {
        const arg = text.replace(/^自动\s*/, "").trim();
        const list = state.autoConvs || [];
        if (!arg || arg === "状态") {
          const sent = state.stats && state.stats.day === today() ? (state.stats.sent || 0) : 0;
          const autoUsed = state.autoDay === today() ? (state.autoCount || 0) : 0;
          await sendCard("自动回复：" + (state.autoOn ? "开着" : "关着") + "（今日自动 " + autoUsed + " / " + (state.autoDailyCap || 80) + "）" +
            "\n范围：" + (list.length ? list.join("、") : "白名单私聊（不限制具体人）") +
            "\n静默：" + (state.autoQuiet || "23:30-07:00") +
            "\n今日总发送：" + sent +
            "\n群自动：" + ((state.autoGroups || []).length ? (state.autoGroups || []).join("、") + "（今日 " + (state.gCount || 0) + "/" + (state.autoGroupDailyCap || 10) + "）" : "没开") +
            "\n自动发过：" + (state.stats && state.stats.day === today() ? (state.stats.auto || 0) : 0) +
            "\n\n自动 开 / 自动 关 / 自动 开 昵称 / 自动 关 昵称 / 自动 列表 / 自动 静默 23:30-07:00 / 自动 上限 80");
          continue;
        }
        if (arg === "开") { state.autoOn = true; save(); await sendCard("自动回复已开" + (list.length ? "，只在：" + list.join("、") : "（白名单里所有私聊）")); continue; }
        if (arg === "关") { state.autoOn = false; save(); await sendCard("自动回复已关，全部回到手动审批"); continue; }
        if (arg === "列表") { await sendCard("自动回复范围：\n" + (list.length ? list.map(x => "✅ " + x).join("\n") : "（不限制，白名单私聊全部自动）")); continue; }
        const mq = arg.match(/^静默\s*(\S+)$/);
        if (mq) { state.autoQuiet = mq[1]; save(); await sendCard("静默时段：" + mq[1] + "（这段时间不自动发）"); continue; }
        const mc = arg.match(/^上限\s*(\d+)$/);
        if (mc) { state.autoDailyCap = Number(mc[1]); save(); await sendCard("每日自动上限：" + mc[1] + " 条"); continue; }
        const mgc = arg.match(/^群\s*上限\s*(\d+)$/);
        if (mgc) { state.autoGroupDailyCap = Number(mgc[1]); save(); await sendCard("群里每日自动上限：" + mgc[1] + " 条"); continue; }
        const mg = arg.match(/^群\s*(开|关)\s*(.+)$/);
        if (mg) {
          const nm = mg[2].trim().replace(/^[「『]|[」』]$/g, "");
          const g = state.autoGroups || [];
          if (mg[1] === "开") {
            if (!g.some(x => sameName(x, nm))) state.autoGroups = g.concat(nm);
            save();
            await sendCard("群里自动回：加入「" + nm + "」（被 @ 才回，额度 " + (state.autoGroupDailyCap || 10) + " 条/天）");
          } else {
            state.autoGroups = g.filter(x => !sameName(x, nm));
            save();
            await sendCard("群里自动回：移出「" + nm + "」");
          }
          continue;
        }
        if (arg === "群" || arg === "群状态" || arg === "群 状态") {
          const gl = state.autoGroups || [];
          await sendCard("群里自动回：" + (state.autoOn ? "总开关开着" : "总开关关着") +
            "（今日 " + (state.gCount || 0) + " / " + (state.autoGroupDailyCap || 10) + "）\n" +
            (gl.length ? gl.map(x => "✅ " + x).join("\n") : "（还没有开着的群）") +
            "\n\n自动 群 开 群名 / 自动 群 关 群名 / 自动 群 上限 10");
          continue;
        }
        const ma = arg.match(/^开\s+(.+)$/);
        if (ma) { const nm = ma[1].trim(); if (!list.some(x => sameName(x, nm))) { state.autoConvs = list.concat(nm); save(); } await sendCard("自动回复加入：" + nm); continue; }
        const md = arg.match(/^关\s+(.+)$/);
        if (md) { const nm = md[1].trim(); state.autoConvs = list.filter(x => !sameName(x, nm)); save(); await sendCard("自动回复移出：" + nm); continue; }
        await sendCard("自动 开 / 关闭 / 列表 / 开 昵称 / 关 昵称 / 静默 23:30-07:00 / 上限 80");
        continue;
      }
      // 「用：内容」/「用 昵称：内容」直接发，不受待审草稿限制
      {
        const clean = text.replace(/^[「『【\[\s]+/, "").replace(/[」』】\]\s]+$/, "").trim();
        if (clean.startsWith("用")) {
          const rest = clean.replace(/^用\s*/, "");
          let target = "";
          let body = "";
          const m2 = rest.match(/^([^：:\n]{1,20}?)\s*[：:]\s*([\s\S]+)$/);
          if (m2) { target = m2[1].trim(); body = m2[2].trim(); }
          else { body = rest.replace(/^[：:]\s*/, "").trim(); }
          body = body.replace(/^[「『【\[\s]+/, "").replace(/[」』】\]\s]+$/, "").trim();
          const pendConv = state.pending ? state.pending.conv : "";
          if (!target) target = pendConv;
          // 没有待审草稿时，回到最近一条还没处理的私聊消息（自动跳过的那条）。
          // 只认 10 分钟内、白名单内、非群、会话还在的，避免把「用：内容」发到不相干的人。
          let fallbackIncoming = "";
          if (!target) {
            const li = recentIncomingTarget(state);
            if (li) { target = li.conv; fallbackIncoming = li.text; }
          }
          if (!target) { await sendCard("现在没有待审的草稿，也没找到最近要回的人。要发给谁？回「用 昵称：内容」"); continue; }
          if (!body) { await sendCard("内容是空的。格式：「用：内容」"); continue; }
          const lastCustom = state.lastCustom || {};
          if (lastCustom.text === body && lastCustom.target === target && Date.now() - lastCustom.at < 90000) {
            await sendCard("这句刚发过（" + Math.max(1, Math.round((Date.now() - lastCustom.at) / 1000)) + "秒前），跳过"); continue;
          }
          const pend = state.pending && state.pending.conv === target ? state.pending : null;
          const out = pend && pend.group && pend.sender ? "@" + pend.sender.replace(/^@/, "").replace(/\s+/g, "") + " " + body : body;
          const waitMs = 3000 + Math.floor(Math.random() * 12000);
          log("custom → " + target + ": " + body);
          await page.waitForTimeout(waitMs);
          const r = await sendWithRetry(page, target, out);
          const c = state.convs[target] || (state.convs[target] = { lastPreview: "", buffer: [], lastBufferAt: 0, recent: [], sent: [], fails: 0 });
          if (r.ok) {
            c.lastPreview = body;
            c.sent = (c.sent || []).concat({ text: body, at: Date.now(), trusted: true }).slice(-30);
            c.ctx = (c.ctx || []).concat({ mine: true, text: body }).slice(-30);
            if (state.pending && state.pending.conv === target) state.pending = null;
            clearRecentIncoming(state, target);
            state.lastConv = target; state.lastCustom = { text: body, target, at: Date.now() }; save();
            try { remember(target, pend ? pend.incoming : fallbackIncoming, out); } catch {}
            await sendCard("已发给「" + target + "」：" + body);
            log("send custom ok(" + r.how + ") → " + target);
          } else {
            save();
            await sendCard("没确认到（" + r.why + "）。看到就说 0，没看到再发一次。");
          }
          continue;
        }
      }
      if (!state.pending) {
        // 媒体卡没进 pending（怕堵文本卡），但飞书回 0 仍然要能跳过它。
        if (cmd === "0" && state.mediaPending) {
          const mp = takeMediaPending(state);
          save();
          if (mp) {
            log("skip media card [" + mp.conv + "] " + mp.incoming);
            await sendCard("已跳过「" + mp.conv + "」的分享");
            continue;
          }
        }
        await sendCard("现在没有待审的草稿");
        continue;
      }

      const p = state.pending;
      if (p.media) {
        if (cmd === "0") { state.pending = null; save(); await sendCard("跳过"); }
        else await sendCard("这条不是文字，没有草稿。回 0 跳过，或「用：内容」自己回。");
        continue;
      }
      const mSend = cmd.match(/^(12|1|2)(.*)$/);
      const sendMod = mSend ? parseMod(mSend[2]) : null;
      if (cmd === "12" || cmd === "连" || cmd === "连发" || (mSend && mSend[1] === "12" && sendMod)) {
        if ((p.drafts || []).length < 2) { await sendCard("只有一条草稿，回 1 就行"); continue; }
        const c = state.convs[p.conv] || (state.convs[p.conv] = { lastPreview: "", buffer: [], lastBufferAt: 0, recent: [], sent: [], fails: 0 });
        const two = [p.drafts[0], p.drafts[1]];
        if (sendMod) {
          for (let k = 0; k < 2; k++) { const rv = await revise(two[k], { ...sendMod, onUsage: addTok }); if (rv && rv !== two[k]) two[k] = rv; }
          log("modify both(" + sendMod.short + "): " + JSON.stringify(two));
        }
        let allOk = true;
        for (let i = 0; i < 2; i++) {
          if (i) await page.waitForTimeout(1200 + Math.floor(Math.random() * 2000));
          const one = p.group && p.sender ? "@" + p.sender.replace(/^@/, "").replace(/\s+/g, "") + " " + two[i] : two[i];
          const r = await sendToDouyin(page, p.conv, one);
          if (!r.ok) { allOk = false; await sendCard("第 " + (i + 1) + " 条没确认到：" + (r.why || "")); break; }
          c.sent = (c.sent || []).concat({ text: two[i], at: Date.now(), trusted: true }).slice(-30);
          c.ctx = (c.ctx || []).concat({ mine: true, text: two[i] }).slice(-30);
        }
        if (allOk) {
          c.lastPreview = two[1];
          state.pending = null; clearRecentIncoming(state, p.conv); bump("sent"); save();
          remember(p.conv, p.initiate ? "" : p.incoming, two.join(" / "));
          await sendCard("已连发给「" + p.conv + "」：" + (sendMod ? "（" + sendMod.short + "）" : "") + "\n1. " + two[0] + "\n2. " + two[1]);
          log("send both → " + p.conv);
        } else save();
        continue;
      }
      const oneIdx = (cmd === "1" || cmd === "2") ? Number(cmd) : (mSend && (mSend[1] === "1" || mSend[1] === "2") && sendMod ? Number(mSend[1]) : 0);
      if (oneIdx) {
        if (p.empty || !(p.drafts || []).length) { await sendCard("这条没草稿（模型那次没吐出来）。回「改」重试，「用：内容」自己发。"); continue; }
        let draft = p.drafts[oneIdx - 1];
        if (!draft) { await sendCard("没有第 " + oneIdx + " 条"); continue; }
        if (sendMod) {
          const rv = await revise(draft, { ...sendMod, onUsage: addTok });
          if (rv && rv !== draft) { log("modify one(" + sendMod.short + "): " + draft + " → " + rv); draft = rv; }
          else await sendCard("这次没改出来，就按原话发");
        }
        const outText = p.group && p.sender ? "@" + p.sender.replace(/^@/, "").replace(/\s+/g, "") + " " + draft : draft;
        const waitMs = 3000 + Math.floor(Math.random() * 12000);
        log("delay " + waitMs + "ms → " + p.conv);
        await page.waitForTimeout(waitMs);
        const r = await sendWithRetry(page, p.conv, outText);
        const c = state.convs[p.conv] || (state.convs[p.conv] = { lastPreview: "", buffer: [], lastBufferAt: 0, recent: [], sent: [], fails: 0 });
        if (r.ok) {
          c.lastPreview = draft;
          c.sent = (c.sent || []).concat({ text: draft, at: Date.now(), trusted: true }).slice(-30);
          c.ctx = (c.ctx || []).concat({ mine: true, text: draft }).slice(-30);
          state.pending = null; clearRecentIncoming(state, p.conv); bump("sent"); state.lastConv = p.conv; save();
          remember(p.conv, p.initiate ? "" : p.incoming, outText);
          await sendCard("已发给「" + p.conv + "」：" + outText);
          await maybeSticker(page, p.conv, p.tags || []);
          log("send ok(" + r.how + ") → " + p.conv + ": " + draft);
        } else {
          save();
          await sendCard("没确认到（" + r.why + "）。\n你在抖音里要是看到这条了，回 0 别重发；没看到就再回 1。");
          log("send unconfirmed → " + p.conv + ": " + draft);
        }
      } else if (cmd === "0") {
        state.pending = null; clearRecentIncoming(state, p.conv); save(); await sendCard("跳过");
      } else if (/^改/.test(cmd)) {
        const mod = parseMod(cmd.slice(1));
        const cc = state.convs[p.conv];
        if (p.initiate) {
          let list = [];
          try {
            list = await makeOpenings({ conv: p.conv, ctx: ((cc && cc.ctx) || []).slice(-8), life: lifeBrief(), topic: p.incoming, hint: mod ? mod.hint : "", n: 4, onUsage: addTok });
          } catch (e) { log("initiate regen err: " + String(e.message || e).slice(0, 100)); }
          const _ri = shapeDrafts(list, list.map((_, i) => i ? "备选" : "主动"));
          if (!_ri.drafts.length) { await sendCard("这次没生成出来。再回一次「改」试试。"); continue; }
          state.pending = { ...p, drafts: _ri.drafts.slice(0, 2), tags: _ri.tags.slice(0, 2), at: Date.now() };
          save(); await sendCard(card(state.pending) + (mod ? "\n（这次：" + mod.short + "）" : ""));
          state.pending.cardSent = true;
          state.pending._cardAt = Date.now();
          state.pending._lastRemindAt = 0;
          save();
          log("initiate regen" + (mod ? "/" + mod.short : "") + " " + JSON.stringify(state.pending.drafts));
          continue;
        }
        const out = await makeDrafts(((cc && cc.ctx) || []).slice(-12), p.incoming, { conv: p.conv, hint: mod ? mod.hint : "" });
        addTok(out.usage);
        const _rs = shapeDrafts(out.drafts, out.tags);
        if (!_rs.drafts.length) { await sendCard("这次没生成出来。再回一次「改」试试。"); continue; }
        state.pending = { ...p, drafts: _rs.drafts, tags: _rs.tags, kind: out.kind || "", at: Date.now() };
        save(); await sendCard(card(state.pending) + (mod ? "\n（这次：" + mod.short + "）" : ""));
        state.pending._cardAt = Date.now();
        state.pending._lastRemindAt = 0;
        save();
        log("regen" + (mod ? "/" + mod.short : "") + " " + JSON.stringify(out.drafts));
      } else {
        await sendCard("看不懂。回 1 / 2 发，0 跳过，「改」重写，「用：内容」发你写的");
      }
    }

    // 草稿提醒：每 10 分钟看一次；没有 pending 就什么都不做
    await maybeRemindPending();

    // 日报
    const hh = Number(new Date().toLocaleString("en-GB", { timeZone: "Asia/Shanghai", hour: "2-digit", hour12: false }).slice(0, 2));
    if (hh === 9 && state.lastDigestDay !== today()) {
      rollStats();
      const s = (state.yStats && state.yStats.day) ? state.yStats : state.stats;
      await sendCard("【抖音私信日报】" + (s.day || today()) + "\n新消息：" + (s.msgs || 0) + "\n出草稿：" + (s.cards || 0) + "\n已发出：" + (s.sent || 0) + "\n异常：" + (s.errs || 0) + "\n模型：in " + (s.tokIn || 0) + " / out " + (s.tokOut || 0) + " tokens（" + (s.tokCalls || 0) + " 次调用）\n在跑：" + Object.keys(state.convs || {}).length + " 个会话");
      state.lastDigestDay = today();
      save();
      backupState();
    }
    // 2) 扫所有会话
    const all = await readAll(page);
    HB = { beat: Date.now(), cycle: (HB.cycle || 0) + 1, convs: all.length, top: all.slice(0, 6).map(c => c.title + " | " + c.preview.slice(0, 18)) };
    { // 判向来源（今日），看真朋友的流量里 DOM 命中率
      const _s = state.stats || {};
      HB.dirs = { dom: _s.dirDom || 0, sent: _s.dirSent || 0, payload: _s.dirPayload || 0, none: _s.dirNone || 0, group: _s.dirGroup || 0 };
    }
    if (keepLock()) log("watcher.lock 不见了，已补写 pid=" + process.pid);
    if (!all.length) {
      loginFails++;
      log("no conversations, loginFails=" + loginFails);
      if (loginFails === 3) await sendCard("⚠️ 抖音网页掉登录了（读不到会话列表）。电脑上扫码登录，扫完我会自动恢复。");
      await page.waitForTimeout(POLL_MS);
      continue;
    }
    if (loginFails >= 3) { await sendCard("抖音登录恢复了"); log("login recovered"); }
    loginFails = 0;

    const checks = [];
    let uidTouched = false;
    for (const c of all) {
      const st = state.convs[c.title] || (state.convs[c.title] = { lastPreview: c.preview, lastKey: c.lastKey || "", buffer: [], lastBufferAt: 0, recent: [], sent: [], fails: 0 });
      if (noteConvUid(st, c.targetUid)) uidTouched = true;
      if (!isNewPreview(st.lastPreview, st.lastKey, c.preview, c.lastKey)) {
        if (!st.lastKey && c.lastKey) st.lastKey = c.lastKey;
        continue;
      }
      const blocked = (state.blocked || []).includes(c.title) || state.muted.includes(c.title);
      if (blocked) { st.lastPreview = c.preview; st.lastKey = c.lastKey || st.lastKey || ""; continue; }
      st.lastPreview = c.preview;
      st.lastKey = c.lastKey || st.lastKey || "";

      const SYS = /火花|重燃|合养精灵|发布了新作品|赞了你|互相关注|已成为朋友|撤回了一条消息|打个招呼|加入了群聊|\[戳一戳\]|在线$/;
      if (SYS.test(c.preview)) continue;

      const isGroup = looksLikeGroup(c.title);
      let preview = c.preview;
      let groupSender = "";
      if (isGroup) {
        if (!(state.allowedGroups || []).some(n => sameName(n, c.title))) continue;
        const mm = c.preview.match(/^(.{1,30}?)：([\s\S]*)$/);
        groupSender = mm ? mm[1] : "";
        const content = mm ? mm[2] : c.preview;
        const names = state.mentionNames || ["522"];
        const lc = content.toLowerCase();
        const mentioned = names.some(n => lc.includes("@" + String(n).toLowerCase()));
        if (!mentioned) continue;
        preview = groupSender ? groupSender + "：" + content : content;
      }

      if (!isGroup && (state.allowedDMs || []).length) {
        const key = c.title.trim();
        if (!state.allowedDMs.some(nm => sameName(nm, key))) continue;
      }
      // 群里自己发的消息预览会带「发送者：@xx 内容」的壳，用包含匹配兜住，避免把刚发的当成新消息
      if (isNoisePreview(preview)) { st.lastPreview = preview; st.lastKey = c.lastKey || st.lastKey || ""; log("[" + c.title + "] 忽略非消息预览：" + preview); continue; }
      const _watcherOpened = watcherOpenedAt.get(String(c.title).trim()) || 0;
      if (readBeforeDraft(c.unread, isGroup || c.convType === 2, _watcherOpened, Date.now(), !!c.active, !!c.unreadByIndex)) {
        log("[" + c.title + "] 已读，跳过草稿（unread=0, active=" + !!c.active + ", idx=" + !!c.unreadByIndex + "）");
        continue;
      }
      const sentHit = (st.sent || []).some(s => Date.now() - s.at < 2 * 3600e3 && (cmpKey(s.text) === cmpKey(preview) || (isGroup && cmpKey(s.text) && cmpKey(preview).includes(cmpKey(s.text)))));
      const recentHit = (st.recent || []).some(r => Date.now() - r.at < 90e3 && (cmpKey(r.text) === cmpKey(preview) || (isGroup && cmpKey(r.text) && cmpKey(preview).includes(cmpKey(r.text)))));
      log("[" + c.title + "] " + preview + " sent=" + sentHit + " recent=" + recentHit + (isGroup ? " [群]" : ""));
      // 不再用 sentHit 预先过滤：老的发送登记被 payload 误判污染过，会把对方的消息吞掉。
      // 自己发的消息交给 DOM 气泡判（isFromMe / 左右），判出来是我再跳过。
      if (!recentHit) checks.push({ st, title: c.title, preview, group: isGroup, sender: groupSender, targetUid: c.targetUid || null });
    }

    if (uidTouched) save();

    // 2.5) 一次 reload，判断这些新消息是谁发的
    if (checks.length) {
      // 先用 DOM 气泡判方向：payload 的接收方字段不可靠（对方用网页发也会指回自己）
      const domRes = new Map();
      for (const ck of checks) {
        if (ck.group) continue;
        const dr = await directionByDom(page, ck.title, ck.preview);
        domRes.set(ck, dr);
      }
      const needBuf = checks.some(ck => !ck.group && (!domRes.get(ck) || domRes.get(ck).dir === "unknown"));
      const buf = needBuf ? await reloadAndInit() : null;
      try { if (buf) writeFileSync(DIR + "/last-payload.bin", buf); } catch {}
      const parsed = buf ? parseMessages(buf) : [];
      let dirTouched = false;
      for (const ck of checks) {
        let dir = "unknown", why = "", cid = null, src = "none";
        const media = isMediaPreview(ck.preview);
        const _dr = domRes.get(ck);
        if (ck.group) { dir = "theirs"; why = "群消息"; src = "group"; }
        else if (_dr && _dr.dir !== "unknown") {
          dir = _dr.dir; why = "dom"; src = "dom";
          if (_dr.rows && _dr.rows.length > 1) {
            ck.st.ctx = _dr.rows.slice(0, 10).reverse().map(r => {
              const text = stripBubble(r.text);
              // 方向只信 DOM 气泡（isFromMe 实测可靠）；发送登记被污染过，不能拿它反着改
              const mine = !!r.mine;
              // 引用块单独存，不并进正文：一条引用消息仍然只是「一个人说的一句话」
              return { mine, text, quote: String(r.quote || "").trim() };
            });
            log("[" + ck.title + "] 上下文(dom) " + ck.st.ctx.filter(x => x.mine).length + "/" + ck.st.ctx.length + " 条是我");
          }
        }
        else if (buf && selfUid) {
          // payload 里的 to-uid 不可靠（对方用网页发来的消息里 to 也是自己），只当参考取 cid；
          // 方向用"发过的登记"兜底：登记过=我方，否则按对方处理（宁可多推一张卡也别吞消息）
          try {
            const r = classifyMsgs(parsed, ck.preview, selfUid, ck.targetUid);
            cid = r.cid || null;
            const known = (ck.st.sent || []).some(s => s.trusted && Date.now() - s.at < 2 * 3600e3 && cmpKey(s.text) === cmpKey(ck.preview));
            if (media && !known) {
              // 媒体占位符在 payload 里没有可匹配的 text，classifyMsgs 一定找不到；
              // 以前这里默认「按对方」，结果把我自己分享的视频/图片弹成 ta。宁可不猜。
              dir = "unknown";
              src = "none";
              why = "媒体预览，DOM 没等到媒体气泡；不按对方猜";
            } else {
              dir = known ? "mine" : "theirs";
              src = known ? "sent" : "payload";
              why = (known ? "sent登记" : "payload不可靠→按对方") + " payload说=" + r.dir;
            }
          } catch (e) { why = "payload err " + String(e.message).slice(0, 50); src = "err"; }
        } else { why = !buf ? "no payload" : "no selfUid"; src = "none"; }
        if (dir === "web-self") {
          const known = (ck.st.sent || []).some(s => s.trusted && Date.now() - s.at < 2 * 3600e3 && cmpKey(s.text) === cmpKey(ck.preview));
          dir = known ? "mine" : "theirs";
          src = "webself";
          why = "web-self→" + dir;
        }
        // 预览可能是截断/带时间前缀的；DOM 命中的气泡文本才是原文。只对「对方发的」补全文。
        let inText = ck.preview;
        if (dir === "theirs" && _dr && _dr.hit && _dr.hit.text) {
          const full = fullIncoming(ck.preview, _dr.hit.text);
          if (full) inText = full;
        }
        ck.st._dirUnknown = !!media && dir === "unknown";
        ck.st._dirMine = dir === "mine";
        if (dir === "mine") {
          ck.st.sent = (ck.st.sent || []).concat({ text: ck.preview, at: Date.now(), trusted: true }).slice(-30);
          ck.st.lastPreview = ck.preview;
          state.detect = (state.detect || []).filter(d => !(d.conv === ck.title && cmpKey(d.text) === cmpKey(ck.preview)));
          save();
          log("[" + ck.title + "] 是我自己发的，跳过（" + ck.preview.slice(0, 20) + "）" + why);
        } else {
          if (dir === "theirs") log("[" + ck.title + "] 判定：对方发的（" + ck.preview.slice(0, 20) + "）");
          // 注意：payload 里的 mine 判断不可靠（对方用网页发消息时 to 会指回自己，反过来的也见过），
          // 所以上下文只信 DOM 气泡；DOM 没拿到就只把这条 incoming 补进去，不再整段覆盖。
          if (!(_dr && _dr.rows && _dr.rows.length > 1)) {
            ck.st.ctx = (ck.st.ctx || []).concat({ mine: false, text: inText }).slice(-30);
          }
          ck.st._group = !!ck.group;
          ck.st._sender = ck.sender || "";
          ck.st.buffer.push({ text: inText, at: Date.now() });
          ck.st.lastBufferAt = Date.now();
      ck.st.lastActivityAt = Date.now();
          // 先登记再出草稿：草稿要跑十几秒，中途重启会丢消息
          (state.detect = state.detect || []).push({ conv: ck.title, text: inText, at: Date.now(), group: !!ck.group, sender: ck.sender || "", uid: ck.targetUid || "" });
          if (state.detect.length > 60) state.detect = state.detect.slice(-60);
          save();
          if (dir === "unknown") log("[" + ck.title + "] 判定未知（" + why + "），按对方发的处理");
        }
        // 判向来源计数：真朋友的流量里 DOM 命中率到底多少，靠这个看
        const _dk = { group: "dirGroup", dom: "dirDom", sent: "dirSent", payload: "dirPayload", webself: "dirWebSelf", err: "dirErr", none: "dirNone" }[src] || "dirNone";
        bump(_dk);
        dirTouched = true;
      }
      if (dirTouched) save();
    }

    // 3) 静默 8 秒 → 出草稿
    for (const [title, st] of Object.entries(state.convs || {})) {
      if (!st.buffer.length || Date.now() - st.lastBufferAt <= BATCH_MS) continue;
      const incoming0 = st.buffer.map(b => b.text).join(" / ");
      // 从 detect 恢复的消息没走过判向，出草稿前补一次
      if (st._verify) {
        st._verify = false;
        try {
          const dr = await directionByDom(page, title, incoming0);
          if (dr && dr.dir === "mine") {
            log("[" + title + "] 补检是自己发的，跳过（" + incoming0.slice(0, 20) + "）");
            st.buffer = []; st.lastBufferAt = 0;
            state.detect = (state.detect || []).filter(d => !(d.conv === title && incoming0.includes(d.text)));
            save();
            continue;
          }
        } catch (e) { log("verify err " + String(e.message).slice(0, 60)); }
      }
      // 列表预览只带最后一条；出草稿前用上一条我发的话当锚点，把同一轮漏掉的前几条补回来
      await captureMissedIncoming(page, title, st);
      const incoming = st.buffer.map(b => b.text).join(" / ");
      const _mediaCard = isMediaPreview(incoming);
      if (_mediaCard) {
        const mq = mediaQueue(st, title, incoming);
        // 分享视频：用户要求一律统一回一句，不走审批，也不占 pending。
        if (isSharedVideoPreview(incoming) && videoAckAllowed(state, title, mq)) {
          let rr;
          try { rr = await sendWithRetry(page, title, VIDEO_ACK_TEXT); }
          catch (e) { rr = { ok: false, why: String(e.message || e).slice(0, 60) }; }
          if (rr.ok) {
            st._dirUnknown = false;
            st._dirMine = false;
            for (const b of st.buffer) st.recent.push({ text: b.text, at: b.at });
            st.buffer = []; st.lastBufferAt = 0;
            st.ctx = st.ctx || [];
            const _ni = norm(incoming);
            while (st.ctx.length && !st.ctx[st.ctx.length - 1].mine && _ni.includes(norm(st.ctx[st.ctx.length - 1].text))) st.ctx.pop();
            st.ctx.push({ mine: false, text: incoming });
            st.ctx.push({ mine: true, text: VIDEO_ACK_TEXT });
            if (st.ctx.length > 30) st.ctx = st.ctx.slice(-30);
            st.sent = (st.sent || []).concat({ text: VIDEO_ACK_TEXT, at: Date.now() }).slice(-30);
            st.lastPreview = VIDEO_ACK_TEXT;
            st.lastActivityAt = Date.now();
            state.detect = (state.detect || []).filter(d => !(d.conv === title && cmpKey(d.text) === cmpKey(incoming)));
            state.lastConv = title;
            bump("sent");
            save();
            try { remember(title, incoming, VIDEO_ACK_TEXT); } catch {}
            try { await sendCard("已回「" + title + "」：" + VIDEO_ACK_TEXT); }
            catch (e) { log("video ack notice err " + String(e.message).slice(0, 60)); }
            log("video ack sent(" + rr.how + ") → " + title + " ← " + incoming);
            continue;
          }
          // 没确认到就退回普通媒体卡，不让它一直卡在 buffer 里重试。
          log("video ack fail [" + title + "] " + rr.why);
        }
        // 媒体/不支持的消息只发一张「看一眼」的通知，不占用审批 pending：
        // 否则一张没人理的分享卡会把后面真正要回的文本卡全堵住。
        st._dirUnknown = false;
        st._dirMine = false;
        for (const b of st.buffer) st.recent.push({ text: b.text, at: b.at });
        st.buffer = []; st.lastBufferAt = 0;
        state.detect = (state.detect || []).filter(d => !(d.conv === title && cmpKey(d.text) === cmpKey(incoming)));
        // 记录最近一张媒体卡，飞书回 0 才能跳过它
        state.mediaPending = { conv: title, incoming, at: Date.now() };
        save();
        try { await sendCard(card(mq)); bump("cards"); log("media card sent [" + title + "] " + incoming); }
        catch (e) { log("media card err " + String(e.message).slice(0, 60)); }
        continue;
      }
      st.ctx = st.ctx || [];
      // 判向那一步已经把这条 incoming 写进 ctx 了，这里先把它从末尾摘掉再整批补回去，
      // 否则上下文里同一条会出现两遍（卡片"最近"里 ta 的话重复就是这个）
      const normIn = norm(incoming);
      const isDupIn = (e) => e && !e.mine && norm(e.text).length >= 2 && normIn.includes(norm(e.text));
      while (st.ctx.length && isDupIn(st.ctx[st.ctx.length - 1])) st.ctx.pop();
      for (const b of st.buffer) st.ctx.push({ mine: false, text: b.text });
      if (st.ctx.length > 30) st.ctx = st.ctx.slice(-30);
      // incoming 是单独参数，喂上下文时不要再带一遍
      let ctxBefore = st.ctx.slice(-12);
      while (ctxBefore.length && isDupIn(ctxBefore[ctxBefore.length - 1])) ctxBefore = ctxBefore.slice(0, -1);
      // 引用块并回同一行喂模型：上下文里仍然是一句话，而不是「ta：引用原文」+「ta：回复」两条。
      ctxBefore = ctxBefore.map(x => {
        const q = String((x && x.quote) || "").replace(/\s+/g, " ").trim();
        if (!q) return x;
        const qs = q.length > 60 ? q.slice(0, 60) + "…" : q;
        return { ...x, text: String((x && x.text) || "") + "（引用 " + qs + "）" };
      });
      const _fromQuiet = (st.buffer || []).some(b => inQuietAt(b.at));
      let out;
      try {
        const _pro = Date.now() - (st.proactiveAt || 0) < 30 * 60 * 1000;
        if (_pro) log("（这条是她主动开头后的对话）");
        out = await makeDrafts(ctxBefore, incoming, { conv: title, group: !!st._group, proactive: _pro, ...sceneOpts({ group: !!st._group, incoming }) });
        addTok(out.usage);
        st.fails = 0;
      } catch (e) {
        st.fails = (st.fails || 0) + 1;
        log("draft fail (" + st.fails + ") " + String(e.message).slice(0, 120));
        if (st.fails >= 3) {
          st.fails = 0; st.buffer = []; st.lastBufferAt = 0; save();
          await sendCard("⚠️ 「" + title + "」连续 3 次生成草稿失败，先跳过这条。");
        }
        continue;
      }
      const _shape = shapeDrafts(out.drafts, out.tags);
      let _drafts = _shape.drafts;
      const _empty = !_drafts.length;
      if (_empty) log("没有可用草稿（空或只有标点），不自动发");
      else {
        if (_shape.moved) log("人味重排：1. " + _drafts[0]);
        // 一张卡全是客服腔时，花一次调用把「1.」改回她的口气；改不动就照原样出卡
        // 重写的是「1.」这一句，标签沿用原来的，不用动 _shape.tags
        const _res = await rescueDrafts(_drafts, !!st._group);
        if (_res !== _drafts) _drafts = _res;
      }
      noteRecentIncoming(state, title, incoming, !!st._group);
      state.queue.push({ conv: title, incoming, drafts: _drafts, empty: _empty, tags: _shape.tags, kind: out.kind || "", group: !!st._group, sender: st._sender || "", fromQuiet: _fromQuiet, at: Date.now() });
      st._group = false; st._sender = ""; st._dirUnknown = false; st._dirMine = false;
      bump("msgs");
      for (const b of st.buffer) st.recent.push({ text: b.text, at: b.at });
      st.buffer = []; st.lastBufferAt = 0;
      if (st.recent.length > 40) st.recent = st.recent.slice(-40);
      state.detect = (state.detect || []).filter(d => !(d.conv === title && incoming.includes(d.text)));
      save();
      log("queued [" + title + "]: " + JSON.stringify(out.drafts));
    }

    // 3.5) 清掉过期队列
    while (state.queue.length && Date.now() - state.queue[0].at > QUEUE_TTL) {
      const dead = state.queue.shift();
      log("queue expired: " + dead.conv + " " + dead.incoming);
    }

    // 3.9) 丢掉太旧的草稿，别拿半小时前的话当新消息
    {
      const STALE_MS = 12 * 60 * 1000;
      const n0 = state.queue.length;
      state.queue = state.queue.filter(q => Date.now() - (q.at || 0) <= STALE_MS);
      if (state.queue.length !== n0) { log("dropped stale queue: " + (n0 - state.queue.length)); save(); }
    }

    // 3.95) detect 里过期的条目清掉，别越积越多
    if ((state.detect || []).length) {
      const before = state.detect.length;
      state.detect = state.detect.filter(d => Date.now() - (d.at || 0) < QUEUE_TTL);
      if (state.detect.length !== before) save();
    }

    // 4) 推下一张卡
    if (!state.pending && state.queue.length) {
      const q0 = state.queue[0];
      if (autoEligible(q0)) {
        state.queue.shift();
        state.pending = q0;
        state.pending._autoTryAt = Date.now();
        save();
        try { await autoSend(page, q0); }
        catch (e) {
          const msg = String(e.message || e).slice(0, 120);
          log("autoSend err: " + msg);
          q0._autoTryAt = 0;
          q0.cardSent = true;
          state.pending = q0;
          save();
          try { await sendCard("⚠️ 自动回复执行出错，已退回手动（可能已发/可能没发）：\n" + String((q0.drafts || [])[0] || "").slice(0, 120)); } catch {}
        }
      } else {
        state.pending = state.queue.shift();
        state.pending.autoWhy = AUTO_WHY;
        save();
        await sendCard(card(state.pending));
        state.pending.cardSent = true;
        state.pending._cardAt = Date.now();
        state.pending._lastRemindAt = 0;
        save();
        bump("cards");
        log("card sent [" + state.pending.conv + "]");
      }
    }
  } catch (e) {
    const msg = String(e.message || e).slice(0, 160);
    log("err: " + msg); bump("errs");
    errStreak++;
    // 连续出错自动喊人：3 次以上、且 10 分钟内没喊过
    if (errStreak >= 3 && Date.now() - lastAlertAt > 10 * 60 * 1000) {
      lastAlertAt = Date.now();
      try { await sendCard("⚠️ 抖音这边连续出错 " + errStreak + " 次：\n" + msg + "\n\n我会自己重启，如果一直不好回「状态」看看。"); } catch {}
    }
    if (/closed|crash|disconnected|Target page|browser has been/i.test(msg)) {
      try { await boot(); boots++; errStreak = 0; log("reboot ok, boots=" + boots); }
      catch (e2) { log("reboot fail: " + String(e2.message).slice(0, 120)); await new Promise(r => setTimeout(r, 15000)); }
    }
  }
  errStreak = 0;

  // 5) 定期整页刷新：Edge 跑久了 DOM/内存会飘，空闲时刷一遍，出问题就重启
  try {
    const busy = state.pending || state.queue.length ||
      Object.values(state.convs || {}).some(v => (v.buffer || []).length);
    if (!busy && Date.now() - lastRefreshAt > REFRESH_MS) {
      log("periodic refresh (uptime " + Math.round(process.uptime() / 60) + "min, mem " + Math.round(process.memoryUsage().rss / 1048576) + "MB)");
      await page.reload({ waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForTimeout(4000);
      const chk = await readAll(page).catch(() => []);
      lastRefreshAt = Date.now();
      if (!chk.length) { log("refresh 后读不到会话，重启"); await boot(); boots++; }
      else log("refresh ok, " + chk.length + " convs");
    }
  } catch (e) { log("refresh err: " + String(e.message).slice(0, 80)); }

  // 5.5) 结构自检：每 30 分钟确认一次选择器还能用
  try {
    if (Date.now() - lastStructCheckAt > 30 * 60 * 1000) {
      lastStructCheckAt = Date.now();
      const chk = await structureCheck(page);
      if (!chk.ok) {
        log("structure check FAILED: " + chk.why + (chk.soft ? " / soft: " + chk.soft : ""));
        if (Date.now() - lastStructAlertAt > 60 * 60 * 1000) {
          lastStructAlertAt = Date.now();
          await sendCard("⚠️ 抖音页面结构变了\n" + chk.why + "\n\nwatcher 还在跑，但可能已经看不到新消息。回「状态」看现场，或者叫我排查。");
        }
      } else log("structure check ok" + (chk.soft ? " / soft: " + chk.soft : ""));
    }
  } catch (e) { log("structure check err: " + String(e.message || e).slice(0, 80)); }

  // 主动开口：只在完全空闲时试一次（内部还有冷却，不会每轮都调模型）
  try { await maybeProactive(page); } catch (e) { log("proactive err: " + String(e.message).slice(0, 80)); }

  await page.waitForTimeout(POLL_MS).catch(() => {});
}

// 供 selftest.mjs 复用纯函数（不影响正常运行）
export { card, mediaQueue, autoEligible, inQuietRange, nowHM, cmpKey, stripBubble, cleanListPreview, fullIncoming, norm, state, isNoisePreview, MEDIA_PREVIEW, herNowLine, usableDrafts, looksLikeGroup, rollStats, parseMod, noteConvUid, shapeDrafts, humanPenalty, needRescue, keepLock, replyDelayMs, rhythmCfg, addTok, normalizeCmd, loadStateFile, extraIncomingFromRows, PENDING_TTL, PENDING_REMIND_MS };
