
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { memoryFor } from "./people.mjs";

const HOME = homedir();
const DIR = process.env.DOUYIN_DM_DIR || dirname(fileURLToPath(import.meta.url));
const SOUL = process.env.SOUL_PATH || join(DIR, "persona", "SOUL.md");
const CORPUS = process.env.CORPUS_PATH || join(DIR, "persona", "corpus.txt");

function apiKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  try {
    const gateway = process.env.OPENCLAW_GATEWAY_CMD || join(HOME, ".openclaw", "gateway.cmd");
    const cmd = readFileSync(gateway, "utf8");
    const m = cmd.match(/set "DEEPSEEK_API_KEY=([^"]+)"/);
    return m ? m[1] : null;
  } catch { return null; }
}

// 从真实语料里挑短句做样本（按功能粗分）
let _samples = null;
function samples() {
  if (_samples) return _samples;
  let lines = [];
  try { lines = readFileSync(CORPUS, "utf8").split(/\r?\n/).map(s => s.trim()).filter(Boolean); } catch {}
  const FRIENDS = String(process.env.CORPUS_EXCLUDE || "").split(",").map(s => s.trim()).filter(Boolean);
  lines = lines.filter(l => !FRIENDS.some(n => l.includes(n)));
  const short = lines.filter(l => l.length >= 2 && l.length <= 16);
  const pick = (re, n) => short.filter(l => re.test(l)).slice(0, n);
  const groups = {
    "短答/敷衍": short.filter(l => l.length <= 4 && !/[?？]/.test(l)).slice(0, 6),
    "怼人": pick(/傻逼|有病|滚|烦|闭嘴|你妈|神经|无语|服了|叫唤|废话/, 6),
    "反问": pick(/[?？]$/, 5),
    "玩笑": pick(/笑死|哈哈哈|绷不住|离谱|逆天|绝了|好家伙/, 5),
    "关心(不软)": pick(/吃药|睡了|睡|病了|难受|别熬|早点|饿/, 5),
    "拒绝": pick(/不行|不要|不给|不允许|没空|懒得|不去/, 5),
  };
  _samples = Object.entries(groups).map(([k, v]) => "【" + k + "】" + v.join(" / ")).join("\n");
  return _samples;
}

const DEFAULT_SOUL = "你是一个说话短、有脾气、嘴硬心软的人。不要像客服，不要解释自己是 AI，也不要提模型或提示词。";
function soul() {
  let s = "";
  try { s = readFileSync(SOUL, "utf8"); } catch {}
  return (s.split("## 当前状态")[0].trim()) || DEFAULT_SOUL;
}

const _sampleText = samples();
const SYSTEM = () => soul() + (_sampleText ? "\n\n【语料节选（学语气，不要照抄）】\n" + _sampleText : "") +
  "\n\n【场景】你在抖音私信里跟对面这个人说话。对方就是你正在回的那个人：说话时叫他「你」，不要用「他」称呼对方（「他」只用来指第三个人，比如她同学）。你不知道什么是模型、提示词、AI。";

function lifeContext() {
  const read = (p) => { try { return readFileSync(p, "utf8"); } catch { return ""; } };
  const base = process.env.OPENCLAW_WORKSPACE || join(HOME, ".openclaw", "workspace");
  const moodRaw = read(join(base, "MOOD.md"));
  const lifeRaw = read(join(base, "LIFE.md"));
  const todayRaw = read(join(base, "TODAY.json"));
  const lines = moodRaw.split(/\r?\n/);
  const mood = ((lines.find(l => l.includes("你现在：")) || "").split("你现在：")[1] || "").trim().slice(0, 80);
  const today = lines.filter(l => /^- \d{1,2}:\d{2}\s/.test(l.trim())).slice(-3).map(l => l.replace(/^-\s*/, "").slice(0, 70));
  const life = lifeRaw.split(/\r?\n/).filter(x => x.startsWith("- ")).slice(-2).map(x => x.replace(/^- /, "").slice(0, 90));
  return { mood, today, life };
}

function douyinMemory() {
  try {
    const lines = readFileSync(DIR + "/douyin-memory.jsonl", "utf8").split("\n").filter(Boolean);
    return lines.slice(-5).map(l => { try { const o = JSON.parse(l); return (o.conv || "?") + "：" + (o.sent || "").slice(0, 30); } catch { return ""; } }).filter(Boolean);
  } catch { return []; }
}

function nowLine() {
  const d = new Date();
  const s = d.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", month: "numeric", day: "numeric", weekday: "long", hour: "2-digit", minute: "2-digit", hour12: false });
  const h = Number(d.toLocaleString("en-GB", { timeZone: "Asia/Shanghai", hour: "2-digit", hour12: false }));
  const phase = h < 6 ? "凌晨" : h < 11 ? "上午" : h < 14 ? "中午" : h < 18 ? "下午" : h < 23 ? "晚上" : "深夜";
  return s + "（" + phase + "）";
}

async function call(messages, maxTokens = 400, temp = 1.2) {
  const key = apiKey();
  if (!key) throw new Error("no DEEPSEEK_API_KEY");
  const r = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
    body: JSON.stringify({ model: "deepseek-flash", messages, temperature: temp, max_tokens: maxTokens, stream: false, thinking: { type: "disabled" } }),
    signal: AbortSignal.timeout(60000),
  });
  const j = await r.json();
  return { text: j?.choices?.[0]?.message?.content || "", usage: j?.usage || null };
}

function parseJson(txt) {
  const m = String(txt).match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

const BANNED = /怎么了|发生什么|需要我|需要帮|我理解|抱歉|不好意思|哈哈|嗯嗯|好的|在的|有什么事|有什么可以|别难过|加油哦|希望/;
const clean = (s) => String(s || "").trim()
  .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
  .replace(/^(\d{1,2}[.、)]\s+|[-*]\s+)/, "")
  .trim();

// 字符二元组相似度：用来量"是不是换汤不换药地重复自己刚说过的话"
function _bg(s) {
  const t = String(s || "").replace(/[\s，。！？!?、~～…,.]/g, "");
  const out = new Set();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}
function _jac(a, b) {
  const A = _bg(a), B = _bg(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}
export function _jacForTest(a, b) { return _jac(a, b); }

function score(c) {
  const t = c.t;
  let s = 0;
  if (t.length >= 2 && t.length <= 12) s += 3; else if (t.length <= 18) s += 1;
  if (!/[，,]/.test(t)) s += 2;
  if (/[?？!！]$/.test(t)) s += 1;
  if (BANNED.test(t)) s -= 6;
  if (/他/.test(t) && !/你/.test(t)) s -= 8; // 把对方叫成「他」的，降权
  if (c.s === "硬壳软芯") s += 1;
  return s;
}

// 单条改写：给「1 短 / 2 狠 / 12 软」用。只改一句话，便宜。
export async function revise(draft, mod = {}) {
  const hint = String((mod && mod.hint) || "").trim();
  const src = clean(String(draft || ""));
  if (!src || !hint) return "";
  const u = [
    "她（东筱涵，17 岁，说话短、口语、不客气，不高兴就顶回去）本来要发这一句：",
    "「" + src + "」",
    "",
    "现在按这个要求改一版：" + hint,
    "规则：意思别跑偏；1-16 字；口语；不用逗号串长句；结尾不写句号；不加引号；只输出改好的那一句，不要解释。",
  ].join("\n");
  try {
    const r = await call([
      { role: "system", content: "你只改写一句口语，只输出那一句，不解释、不加引号。" },
      { role: "user", content: u },
    ], 120, 1.0);
    if (mod.onUsage) { try { mod.onUsage(r.usage); } catch {} }
    let t = clean(r.text || "");
    t = t.replace(/^[「『"\s]+/, "").replace(/[」』"\s]+$/, "").trim();
    if (!t || t.length > 30 || /[{}"\\]/.test(t) || /cands|json/i.test(t)) return "";
    return t;
  } catch { return ""; }
}

// 两次调用的 usage 相加（thinking 关闭时就是 prompt+completion）
function addUsage(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  const sum = { ...a };
  for (const k of ["prompt_tokens", "completion_tokens", "total_tokens", "prompt_cache_hit_tokens", "prompt_cache_miss_tokens"]) {
    if (typeof b[k] === "number") sum[k] = (sum[k] || 0) + b[k];
  }
  return sum;
}

export async function makeDrafts(msgs, incoming, opts = {}) {
  // 成本分档：cands 默认 6（3-8 可调），skipRerank 省掉第二轮审稿（群/短句用）
  const NC = Math.max(3, Math.min(8, Number(opts.cands) || 6));
  const gTokens = Math.max(400, Math.min(900, Math.round(800 * NC / 6)));
  const struct = NC >= 6
    ? "1 条正常接话、1 条偷懒敷衍、2 条怼或玩笑、1 条反问、1 条看情况（诉苦时必须是硬壳软芯，不是纯骂）"
    : NC === 5
      ? "1 条正常接话、1 条偷懒敷衍、1 条怼或玩笑、1 条反问、1 条看情况（诉苦时必须是硬壳软芯，不是纯骂）"
      : "1 条正常接话、1 条偷懒敷衍、1 条怼或玩笑、1 条看情况（诉苦时必须是硬壳软芯，不是纯骂）";
  const who = opts.conv ? "「" + opts.conv + "」" : "他";
  const L = lifeContext();
  const P = memoryFor(opts.conv);
  const transcript = (msgs || []).slice(-12).map(m => (m.mine ? "我：" : "对方：") + String(m.text).replace(/\n/g, " ")).join("\n") || "（还没聊过）";
  // 我最近说过的 5 句：别换汤不换药地重复
  const _mine = (msgs || []).filter(m => m.mine).map(m => String(m.text || "").replace(/\n/g, " ").trim()).filter(Boolean).slice(-5);
  // 对方这句跟上几句几乎是同一件事（连发/刷屏/在测她）→ 别陪着玩同一个梗
  const _inRepeat = (() => {
    const prev = (msgs || []).filter(m => !m.mine).map(m => String(m.text || "").trim()).filter(Boolean)
      .filter(t => t !== String(incoming || "").trim());
    let best = 0;
    for (const t of prev.slice(-3)) best = Math.max(best, _jac(t, incoming));
    return best >= 0.5;
  })();

  const user = [
    "现在：" + nowLine(),
    "对方：" + who.replace(/[「」]/g, ""),
    "最近对话（「对方」就是正在跟你说话的这个人）：",
    transcript,
    "（上面「对方」= 你正在回的那个人，回复里直接叫「你」，不许写成「他」）",
    (_mine.length ? "你刚才已经说过（别换个说法再说一遍，也别接着同一个梗）：\n" + _mine.map(t => "- " + t.slice(0, 30)).join("\n") : ""),
    (_inRepeat ? "【注意】他这句跟上一句几乎是同一件事（在刷屏/重复/试你），别陪着玩这个梗：可以说他烦、说他啰嗦，或者干脆不接这茬。" : ""),
    "",
    "你的生活（能自然带一句就带，别每条都提，别硬塞）：",
    "现在心情：" + (L.mood || "（没记）"),
    "今天：" + (L.today.length ? L.today.join("；") : "（没记）"),
    // memoryFor() 已经自带【关于「X」这个人…】表头，别再套一层
    (P ? (P.startsWith("【") ? P : "【你记得的关于这个人】\n" + P) : "关于这个人：你还没什么印象（刚开始聊）"),
    "最近：" + (L.life.length ? L.life.join("；") : "（没记）"),
    "",
    "对方刚发：" + incoming,
    "",
    opts.group
      ? "【场景】你在他的抖音号上，这是在群里被人 @ 了。群里人多，你只接一句就走，别聊开、别透露自己的私事、别答应任何事；被问你是谁就说「522 这号是他的」；有人问到他就「你问他」（问你自己就自己答）；被问是不是 AI 就说「我是522」。"
      : "【场景】你在他的抖音号上回消息，对方是他的同学/朋友。被问你是谁就答「522」，顺带把他说出来（「这号是他的」「他懒得回 我替他回」），但别替他答他的事；被问是不是 AI 就说「我是522」。问到他的事（他来不来、他在哪、他几点回、他的安排、要花钱的）就说「你问他」；但问到你自己（你有空吗、帮我个忙、你在干嘛）必须自己答，别甩「你问他」。",
    opts.proactive ? "【注意】最后那句「我：…」是你自己主动先发的，不是他先开口。他在接你的话：别装没说过、别反问「什么」、别再说一遍原话，顺着你自己起的头往下接。" : "",
    opts.hint ? "【这一版的要求】" + opts.hint : "",
    opts.group ? "群里回话：口语、短、可以损一句，别像在私聊。" : "",
    "先判断对方这句的性质（随口一问 / 诉苦示弱 / 邀约 / 结束语 / 挑事），再写 " + NC + " 条候选。",
    "结构要求：" + struct + "。",
    "硬要求：",
    "- 每条 1-16 字，口语，不用逗号串长句，结尾不写句号",
    "- 允许只回一个字、一句脏话（别过火）；但不要只回一个问号「？」或「？」这类纯标点",
    "- 不能像客服：不解释、不问对方怎么了、不提供帮助、不说「哈哈/嗯嗯/好的」",
    "- 不许把对面的人叫成「他」——一律叫「你」；只有说到第三个人（她同学、别人）才用「他」",
    "- 不重复：上面「你刚才已经说过」的那些，同一个意思换个说法也不行；对方重复同一件事时，别再拿那件事做文章",

    "- 对方只是随口一问，别上来就骂；骂是留给他惹你的时候",
    "- 对方在诉苦时，攻击性的话最多一句，另一句要嘴上不饶人但实际在关心（例：累就睡 别硬撑）",
    '输出 JSON：{"cands":[{"s":"怼","t":"..."}]}',
  ].join("\n");

  const g1 = await call([{ role: "system", content: SYSTEM() }, { role: "user", content: user }], gTokens, 1.25);
  let usage = g1.usage;
  const parsed = parseJson(g1.text);
  let cands = (parsed?.cands || []).map(c => ({ s: String(c.s || "").slice(0, 6), t: clean(c.t) })).filter(c => c.t);
  if (cands.length < 3) {
    cands = g1.text.split("\n").map(l => ({ s: "", t: clean(l) })).filter(c => c.t && c.t.length <= 24 && !/[{}`"\\]/.test(c.t)).slice(0, NC);
  }
  if (!cands.length) {
    // 一次重试：多数失败是模型吐了非 JSON，重问一次比直接放弃有用
    const g1b = await call([
      { role: "system", content: "你只输出 JSON，不解释、不寒暄。" },
      { role: "user", content: user + "\n\n上一次输出不合规，重来。只回一个 JSON：{\"cands\":[{\"s\":\"怼\",\"t\":\"…\"}]}，cands 至少 " + NC + " 条。" },
    ], gTokens, 1.15);
    usage = addUsage(g1.usage, g1b.usage);
    const pb = parseJson(g1b.text);
    cands = (pb?.cands || []).map(c => ({ s: String(c.s || "").slice(0, 6), t: clean(c.t) })).filter(c => c.t);
    if (!cands.length) return { drafts: [], failed: true, raw: g1b.text, usage };
  }

  // 把「用他称呼对方」的句子纠正成「你」（只在私聊/群都适用，但群里保留描述第三人的情况）
  const fixAddr = (t) => (/他/.test(t) && !/你/.test(t) ? t.replace(/他/g, "你") : t);

  // 第二轮：让模型挑最像她的两条
  let picks = [], kind = "";
  if (!opts.skipRerank) try {
    const list = cands.map((c, i) => (i + 1) + ". [" + c.s + "] " + c.t).join("\n");
    const g2 = await call([
      { role: "system", content: "你是她的语言审稿人，只按她的说话习惯打分。" },
      { role: "user", content: "对方刚发：" + incoming + "\n最近对话：\n" + transcript + "\n\n候选：\n" + list + "\n\n她刚才已经说过这些（挑出来的不能是它们的翻版：同一个梗、同一个句式开头都不行）：\n" + (_mine.length ? _mine.join("\n") : "（没有）") + "\n\n第一步：判断对方这句是什么性质（随口/诉苦/邀约/结束/挑事）" + (_inRepeat ? "，注意他在重复同一件事，别挑继续玩这个梗的" : "") + "。\n第二步：挑最像她、也最贴这个性质的 2 条，且第一条不能是上面那些话的翻版。对方诉苦时不许挑纯攻击；对方随口问时不许挑骂人。别为了狠而狠，别像 AI 关心人，别像客服。候选里把对方叫成「他」的不挑（那是在说第三人），除非全都在说「他」。第一条是你最想发的。\n输出 JSON：{\"kind\":\"诉苦\",\"picks\":[3,1]}" },
    ], 60, 0.3);
    usage = addUsage(usage, g2.usage);
    const p = parseJson(g2.text);
    picks = (p?.picks || []).map(Number).filter(n => n >= 1 && n <= cands.length);
    kind = String(p?.kind || "").slice(0, 10);
  } catch {}

  const sane = (t) => t && t.length <= 30 && !/[{}`"\\]/.test(t) && !/cands|json/i.test(t);
  let picked = picks.map(i => cands[i - 1]).filter(Boolean);
  if (picked.length < 2) picked = cands.map((c) => ({ ...c, sc: score(c) })).sort((a, b) => b.sc - a.sc).slice(0, 2);
  // 硬规则：问 AI 不许骂人；问他的事必须"你问他"
  const AIQ = /(AI|ai|机器人|程序|模型|真人|假的)/;
  const ASK_ME = /(帮我|替我|给我|你帮|你能不能|你可以|借我)/;
  const HIS_SUBJ = /他(?!们)/;
  const HIS_SCHED = /(上课|放学|来不来|来吗|去不去|去吗|几点|什么时候回来|什么时候到|在哪|在不在|安排|接我|见我)/;
  const HISQ = () => HIS_SUBJ.test(incoming) || (HIS_SCHED.test(incoming) && !ASK_ME.test(incoming));
  const IDQ = /(你是谁|你谁啊|你谁？|你是哪位|你叫什么|你啥身份)/;
  let guarded = false;
  if (AIQ.test(incoming)) {
    picked = [{ s: "正常接话", t: "我是522" }, { s: "正常接话", t: "你想多了" }];
    guarded = true;
  } else if (IDQ.test(incoming)) {
    picked = [{ s: "正常接话", t: "我叫522 这号是他的" }, { s: "正常接话", t: "522 他懒得回 我替他回" }];
    guarded = true;
  } else if (HISQ()) {
    picked = [{ s: "正常接话", t: "你问他" }, { s: "正常接话", t: "我不知道 你问他" }];
    guarded = true;
  }
  // 挑中的两条如果又把对方叫成「他」，先换成没有这个毛病的候选，没得换就改写
  const addrHe = (t) => /他/.test(t) && !/你/.test(t);
  if (!guarded) picked = picked.map((p) => {
    if (!addrHe(p.t)) return p;
    const alt = cands
      .filter((c) => !addrHe(c.t) && !picked.some((q) => q.t === c.t))
      .map((c) => ({ ...c, sc: score(c) }))
      .sort((a, b) => b.sc - a.sc)[0];
    return alt ? { s: alt.s, t: alt.t } : { ...p, t: fixAddr(p.t) };
  });
  // 换汤不换药的重复：跟自己刚说过的太像，就换一条候选；全像就把第一条降级成第二条
  if (!guarded && _mine.length) {
    const tooClose = (t) => _mine.some(l => _jac(t, l) >= 0.45);
    picked = picked.map((p) => {
      if (!tooClose(p.t)) return p;
      const alt = cands
        .filter((c) => !tooClose(c.t) && !picked.some((q) => q.t === c.t))
        .map((c) => ({ ...c, sc: score(c) }))
        .sort((a, b) => b.sc - a.sc)[0];
      return alt ? { s: alt.s, t: alt.t } : p;
    });
    if (picked.length > 1 && tooClose(picked[0].t) && !tooClose(picked[1].t)) {
      picked = [picked[1], picked[0]];
    }
  }
  const seen = new Set();
  const outD = [];
  for (const c of picked) {
    const t = clean(c.t);
    if (!sane(t) || seen.has(t)) continue;
    seen.add(t);
    outD.push({ t, s: c.s || "" });
  }
  const uniq = outD.slice(0, 2).map(x => x.t);
  const tags = outD.slice(0, 2).map(x => x.s);
  return { drafts: uniq, tags, kind, cands, raw: g1.text, usage };
}

if (import.meta.url === (await import("node:url")).pathToFileURL(process.argv[1]).href) {
  const incoming = process.argv[2] || "在干嘛";
  const conv = process.argv[3] || "测试会话";
  const msgs = [{ mine: false, text: "中午好" }, { mine: true, text: "嗯" }];
  const out = await makeDrafts(msgs, incoming, { conv });
  console.log(JSON.stringify(out, null, 1));
}
