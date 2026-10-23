// selftest.mjs —— 纯函数回归（不连抖音、不发消息）
process.env.WATCHER_TEST = "1";
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const m = await import("./watcher10.mjs");
const { card, mediaQueue, autoEligible, inQuietRange, inQuietAt, cmpKey, stripBubble, cleanListPreview, fullIncoming, norm, state, isNoisePreview, MEDIA_PREVIEW, isMediaPreview, herNowLine, usableDrafts, looksLikeGroup, rollStats, parseMod, noteConvUid, shapeDrafts, humanPenalty, needRescue, keepLock, replyDelayMs, rhythmCfg, sceneOpts, addTok, normalizeCmd, loadStateFile, extraIncomingFromRows, knownForCapture, isNewPreview, sanitizeOutgoing, hasUnansweredIncoming, latestRealRow, lastRealIsMine, readBeforeDraft, sameName, parseInitiateCommand, resolveWhitelistDm, proactiveTargets, cleanProactiveCtx, noteRecentIncoming, clearRecentIncoming, recentIncomingTarget, takeMediaPending, videoAckAllowed, isSharedVideoPreview, VIDEO_ACK_TEXT, pendingReminderText, PENDING_TTL } = m;
if (!state.convs) state.convs = {};

let pass = 0, fail = 0;
function eq(name, got, want) {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; }
  else { fail++; console.log("✗ " + name + "\n   got  " + JSON.stringify(got) + "\n   want " + JSON.stringify(want)); }
}
function ok(name, cond) { eq(name, !!cond, true); }

// 1. 气泡时间前缀
eq("strip 刚刚", stripBubble("刚刚 测试A5"), "测试A5");
eq("strip 7分钟前", stripBubble("7分钟前 在吗"), "在吗");
eq("strip HH:mm", stripBubble("18:21 校验A1"), "校验A1");
eq("strip 昨天", stripBubble("昨天 晚安"), "晚安");
eq("strip 无前缀", stripBubble("在吗"), "在吗");

// 2. cmpKey 保数字字母
ok("cmpKey 区分 A2/A3", cmpKey("测试A2") !== cmpKey("测试A3"));
eq("cmpKey 去标点空格", cmpKey("你 好，啊"), "你好啊");

// 2.5 非消息预览
eq("噪音 2小时内在线", isNoisePreview("2小时内在线"), true);
eq("噪音 火花", isNoisePreview("1 天后火花消失，当日互聊可恢复火花"), true);
eq("噪音 分享", isNoisePreview("分享[评论]"), false);
eq("噪音 作品", isNoisePreview("我发布了新作品"), true);
eq("噪音 空", isNoisePreview(""), true);
eq("正常消息", isNoisePreview("等我把bug修完就好了"), false);
eq("正常消息2", isNoisePreview("在线吗"), false);

// 2.6 媒体占位符
eq("媒体 分享视频", MEDIA_PREVIEW.test("[分享视频]"), true);
eq("媒体 图片", MEDIA_PREVIEW.test("[图片]"), true);
eq("媒体 普通文本", MEDIA_PREVIEW.test("[早上好]"), false);
eq("媒体 带内容", MEDIA_PREVIEW.test("[分享视频] 好看"), false);
// 列表里视频会带描述，宽版要认出来；否则会走文字匹配 → 判不出 → 默认对方
ok("媒体宽版 视频带描述", isMediaPreview("[分享视频]2025年的第一场雪"));
ok("媒体宽版 图片带描述", isMediaPreview("[图片] 今天拍的"));
eq("媒体宽版 普通文本", isMediaPreview("[早上好]"), false);
ok("媒体宽版 暂不支持", isMediaPreview("暂不支持该消息类型"));
ok("媒体宽版 视频无法查看", isMediaPreview("视频无法查看"));
ok("媒体宽版 分享", isMediaPreview("分享[视频]"));
eq("分享不是噪音", isNoisePreview("分享[视频]"), false);
const _cm = card({ conv: "测试会话", incoming: "[分享视频]2025年的第一场雪", media: true, dirUnknown: true });
ok("媒体卡 不说是对方发的", !_cm.includes("发来一条") && _cm.includes("方向没判准"));
const _cm2 = card({ conv: "测试会话", incoming: "[图片]", media: true });
ok("媒体卡 也不默认对方", !_cm2.includes("发来一条") && _cm2.includes("方向没标"));
ok("媒体卡 判成我发的就说是我", card({ conv: "测试会话", incoming: "[图片]", media: true, mine: true }).includes("你自己发的"));
ok("媒体卡 判成对方就说对方", card({ conv: "测试会话", incoming: "[图片]", media: true, mine: false }).includes("对方发的"));
// mediaQueue 以前引用主循环块级 dir，媒体卡一生成就 ReferenceError
const _mq1 = mediaQueue({ _dirMine: true }, "x", "[图片]");
eq("媒体排队 方向已知", [_mq1.mine, _mq1.dirUnknown], [true, false]);
const _mq2 = mediaQueue({ _dirUnknown: true, _dirMine: true }, "x", "[图片]");
eq("媒体排队 方向没判准不猜自己", [_mq2.mine, _mq2.dirUnknown], [false, true]);
const _mq3 = mediaQueue(null, "x", "[图片]");
eq("媒体排队 空状态不崩", [_mq3.mine, _mq3.dirUnknown], [false, false]);

// 3. 静默时段
state.autoQuiet = "23:30-07:00";
eq("静默 23:45", inQuietRange("23:45"), true);
eq("静默 03:00", inQuietRange("03:00"), true);
eq("静默 12:00", inQuietRange("12:00"), false);
eq("静默 07:00", inQuietRange("07:00"), false);
eq("静默 23:00", inQuietRange("23:00"), false);

// 4. 自动发送资格
state.autoOn = true;
state.autoConvs = ["测试人"];
state.autoGroups = [];
state.muted = [];
state.autoDailyCap = 30;
state.autoDay = new Date().toISOString().slice(0, 10);
state.autoCount = 0;
state.autoQuiet = "00:00-00:01";
const q1 = { conv: "测试人", drafts: ["嗯嗯"], incoming: "在吗", group: false };
eq("auto 正常放行", autoEligible(q1), true);
eq("auto 静默来源不补发", autoEligible({ ...q1, fromQuiet: true }), false);
eq("auto 静默拦截", (state.autoQuiet = "00:00-23:59", autoEligible({ ...q1, conv: "其他人" })), false);
state.autoQuiet = "00:00-00:01";
eq("auto 名单外", autoEligible({ ...q1, conv: "名单外" }), false);
eq("auto 敏感词", autoEligible({ ...q1, incoming: "你几点下课" }), false);
eq("auto 敏感词草稿", autoEligible({ ...q1, drafts: ["我明天去学校"] }), false);
state.autoOn = false;
eq("auto 总开关关", autoEligible(q1), false);
state.autoOn = true;

// 5. 卡片：最近不重复 incoming、相邻去重
state.queue = [];
state.autoOn = false;
state.convs["测试人"] = { ctx: [
  { mine: true, text: "测到B几才能歇啊" },
  { mine: false, text: "等我把bug修完就好了" },
  { mine: false, text: "等我把bug修完就好了" },
] };
const c1 = card({ conv: "测试人", incoming: "等我把bug修完就好了", drafts: ["那得修到几点啊", "累了就歇会"], tags: ["正常接话", "看情况"], at: Date.now() });
const recentPart = c1.split("最近：")[1].split("————")[0];
const occurrences = (recentPart.match(/等我把bug修完就好了/g) || []).length;
eq("卡片最近不重复 incoming", occurrences, 0);
ok("卡片显示第一条草稿", c1.includes("1. [正常接话] 那得修到几点啊"));
ok("卡片无自动行(关)", !c1.includes("没自动发"));

// 引用消息：引用块挂在同一行，不能变成第二条「ta：」
state.convs["引用测试"] = { ctx: [
  { mine: true, text: "我的原话" },
  { mine: false, text: "我回的正文", quote: "某人：被引用的原话" },
] };
const cQuote = card({ conv: "引用测试", incoming: "你继续说", drafts: ["嗯"], tags: ["x"], at: Date.now() });
ok("引用挂在回复同一行", cQuote.includes("ta：我回的正文（引用 某人：被引用的原话）"));
ok("引用不单独成一条 ta", !cQuote.includes("ta：某人：被引用的原话"));

state.autoOn = true;
state.autoConvs = ["测试会话"];
const c2 = card({ conv: "测试会话", incoming: "在吗", drafts: ["嗯"], tags: ["x"], autoWhy: "名单外", at: Date.now() });
ok("卡片显示没自动发原因", c2.includes("（没自动发：名单外）"));
state.autoOn = false;

const longIn = "啊".repeat(300);
const c3 = card({ conv: "测试人", incoming: longIn, drafts: ["嗯"], tags: ["x"], at: Date.now() });
// 3.4 草稿过滤：纯标点不许发
eq("纯问号被丢", usableDrafts(["？", "嗯哼"]), ["嗯哼"]);
eq("空串被丢", usableDrafts(["", "  ", "行"]), ["行"]);
eq("全是标点就空", usableDrafts(["？", "。", "！"]), []);
eq("正常问句保留", usableDrafts(["你还知道回来啊？"]), ["你还知道回来啊？"]);
eq("提示词复述被丢", usableDrafts(["上面第三条太长而且不规范。重来一遍：", "有啊 咋了"]), ["有啊 咋了"]);
eq("句尾冒号被丢", usableDrafts(["我说：", "行吧"]), ["行吧"]);

// 3.6 群判定：多人会话必须当群，正常昵称不能误判
const _ag = state.allowedGroups; state.allowedGroups = ["爱情失意者联盟🇨🇳🇹🇼"];
ok("群名命中", looksLikeGroup("爱情失意者联盟🇨🇳🇹🇼"));
ok("带群的标题", looksLikeGroup("某某同学群"));
ok("结尾(3)", looksLikeGroup("G2电子竞技俱乐部的粉丝群 3"));
ok("多人会话当群", looksLikeGroup("测试会话, 乌鱼, 测试会话, Backf1ow"));
ok("顿号多人会话当群", looksLikeGroup("甲、乙、丙"));
ok("一对一是人", !looksLikeGroup("测试会话"));
ok("一对一带标点不是群", !looksLikeGroup("從嘉."));
ok("一对一带符号不是群", !looksLikeGroup("🍀"));
state.allowedGroups = _ag;

// 3.65 「改」的方向词
eq("改短", parseMod("短") && parseMod("短").short, "短");
eq("改狠一点", parseMod("狠一点").short, "狠");
eq("改别问", parseMod("别问").short, "不问");
eq("改软点", parseMod("软一点").short, "软");
eq("改嘴甜", parseMod("嘴甜").short, "夸");
ok("空方向词=纯改", parseMod("") === null);
ok("乱七八糟不算方向", parseMod("啊这") === null);
ok("方向词带 hint", (parseMod("短") || {}).hint.indexOf("更短") >= 0);

// 3.7 跨天滚动：昨天留档、今天归零
const _keep = state.stats, _keepY = state.yStats;
state.stats = { day: "2000-01-01", msgs: 9, cards: 5, sent: 4, errs: 1 };
state.yStats = null;
rollStats();
const _t = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" });
eq("滚到今天的日期", state.stats.day, _t);
eq("今天计数归零", [state.stats.msgs, state.stats.sent], [0, 0]);
eq("昨天留档", [state.yStats && state.yStats.day, state.yStats && state.yStats.msgs], ["2000-01-01", 9]);
rollStats();
eq("同一天不重复滚", state.yStats.day, "2000-01-01");
state.stats = _keep; state.yStats = _keepY;

// 3.8 uid：只补不改、读不到不清空（people.mjs 按 uid 认人，防对方改昵称丢档案）
const _u1 = {};
eq("uid 首次补上", noteConvUid(_u1, "sec_123"), true);
eq("uid 写进去了", _u1.uid, "sec_123");
eq("uid 重复不写", noteConvUid(_u1, "sec_123"), false);
eq("uid 读不到不动", noteConvUid(_u1, null), false);
eq("uid 空串不动", noteConvUid(_u1, ""), false);
eq("uid 读不到不清空", _u1.uid, "sec_123");
eq("uid 变了会覆盖", noteConvUid(_u1, "sec_456"), true);
eq("uid 覆盖生效", _u1.uid, "sec_456");
eq("uid 无对象不崩", noteConvUid(null, "x"), false);

// 3.5 她此刻（函数保留，但不再进卡片；读 MOOD.md 缺文件时不崩）
const _hn = herNowLine();
ok("她此刻行格式", _hn === "" || (_hn.startsWith("她此刻：") && _hn.endsWith("\n")));
ok("她此刻不超长", _hn.length <= 80);
ok("卡片不带她此刻", _hn === "" ? true : !card({ conv: "测试会话", incoming: "在吗", drafts: ["x"], tags: ["a"], at: Date.now() }).includes("她此刻："));
ok("卡片截断长消息", c3.includes("…（共 300 字）") && c3.length < 400);

// 3.9 人味二次检查：只排不丢，罚分低的排前面，标签跟着走
const _hd = shapeDrafts(
  ["其实我觉得你可以试试", "你搁这报菜名呢", "理解你的感受 别难过", "？", "我说：", "希望你能开心"],
  ["软", "怼", "软", "反问", "看情况", "软"]
);
eq("人味 不丢句子（只丢纯标点和 META_LEAK）", _hd.drafts.length, 4);
eq("人味 第一句是罚分最低的", _hd.drafts[0], "你搁这报菜名呢");
ok("人味 发生了重排", _hd.moved);
eq("人味 标签跟着句子走", _hd.tags[0], "怼");
eq("人味 标签不丢", _hd.tags.length, _hd.drafts.length);
ok("人味 客服腔罚分更高", humanPenalty("理解你的感受") > humanPenalty("你搁这报菜名呢"));
ok("人味 书面语罚分高", humanPenalty("其实我知道") > 0);
ok("人味 句子太长扣分", humanPenalty("我今天上午一直在想这件事到底应该怎么说才好呢") > 0);
ok("人味 正常短句零罚分", humanPenalty("你在干嘛") === 0);
eq("人味 同分保持原顺序", shapeDrafts(["你在干嘛", "别闹了你"], []).drafts, ["你在干嘛", "别闹了你"]);
eq("人味 空输入不崩", shapeDrafts(null, null).drafts, []);
ok("人味 全客服腔才触发重写", needRescue(["理解你的感受 别难过", "希望你能开心 加油哦"]) === true);
ok("人味 有一条正常就不重写", needRescue(["理解你的感受 别难过", "你搁这报菜名呢"]) === false);
ok("人味 空列表不重写", needRescue([]) === false && needRescue(null) === false);
eq("人味 没有 tags 也不崩", shapeDrafts(["在吗"], undefined).tags, [""]);

// 3.95 锁文件：测试进程绝不能碰真身的锁（跑了 selftest 真身就没锁 = 狗任务会再拉一个实例）
ok("lock 测试进程不补写锁", keepLock() === false);
const _lkPath = new URL("./watcher.lock", import.meta.url);
const _lk = (() => { try { return readFileSync(_lkPath, "utf8").trim(); } catch { return ""; } })();
ok("lock 测试进程没把锁顶成自己的 pid", _lk !== String(process.pid));

// 3.96 回复节奏：只保留延迟分档；挑着回已删除（有消息就必回）
{
  const cfg = { ...rhythmCfg() };
  ok("节奏 只保留延迟档", Array.isArray(cfg.q) && Array.isArray(cfg.casual));
  ok("节奏 配置已无 skip", !("skip" in cfg));
  ok("节奏 配置已无 skipRepeat", !("skipRepeat" in cfg));
  ok("节奏 配置已无 askSkip", !("askSkip" in cfg));
  let lo = Infinity, hi = 0;
  for (let i = 0; i < 200; i++) {
    const d = replyDelayMs({ incoming: "在吗", drafts: ["在"] }, cfg);
    lo = Math.min(lo, d); hi = Math.max(hi, d);
  }
  ok("节奏 延迟在 1.5s–26s 内", lo >= 1500 && hi <= 26000);
  ok("节奏 两百次里有随机性", hi - lo > 1000);
  const big = replyDelayMs({ incoming: "今天好累啊", drafts: ["一".repeat(300)] }, { ...cfg, casual: [60000, 90000], typedMin: 0, typedMax: 0, lateMul: 1, cap: 26000 });
  ok("节奏 上限夹在 cap", big === 26000);
  const small = replyDelayMs({ incoming: "嗯", drafts: [""] }, { ...cfg, casual: [0, 1], typedMin: 0, typedMax: 0, lateMul: 1, cap: 26000 });
  ok("节奏 下限不小于 1.5s", small >= 1500);
}

// 3.97 成本分档（改进项 8）：场景调小候选数、群跳审稿、token 账单能累加
{
  const g = sceneOpts({ group: true, incoming: "在吗" });
  eq("分档 群候选 4 条", g.cands, 4);
  ok("分档 群跳过审稿", g.skipRerank === true);
  const s2 = sceneOpts({ incoming: "嗯" });
  eq("分档 两字候选 4 条", s2.cands, 4);
  ok("分档 两字不跳审稿", s2.skipRerank === undefined);
  eq("分档 六字内候选 5 条", sceneOpts({ incoming: "在干嘛呢" }).cands, 5);
  eq("分档 长句不动（默认 6）", sceneOpts({ incoming: "你昨天不是说要去打篮球吗" }), {});
  eq("分档 媒体占位按两字算", sceneOpts({ incoming: "[图片]" }).cands, 4);

  const _ks = state.stats; state.stats = { day: "2000-01-01", msgs: 0, cards: 0, sent: 0, errs: 0 };
  addTok({ prompt_tokens: 100, completion_tokens: 20 });
  addTok({ prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 });
  eq("账单 in 累加", state.stats.tokIn, 150);
  eq("账单 out 累加", state.stats.tokOut, 30);
  eq("账单 调用次数", state.stats.tokCalls, 2);
  addTok(null);
  eq("账单 无 usage 不计数", state.stats.tokCalls, 2);
  const _ks2 = state.stats, _ky2 = state.yStats;
  state.stats = { day: "2000-01-01", msgs: 0, cards: 0, sent: 0, errs: 0, tokIn: 7, tokOut: 3, tokCalls: 1 };
  rollStats();
  eq("账单 跨天归零", [state.stats.tokIn, state.stats.tokOut, state.stats.tokCalls], [0, 0, 0]);
  eq("账单 昨天留档", [state.yStats.tokIn, state.yStats.tokCalls], [7, 1]);
  state.stats = _ks; state.yStats = undefined;
  state.stats = _ks2; state.yStats = _ky2;
}


// 3.98 会话列表预览清洗 / 全量气泡（审计 1）：时间前缀不能当正文，预览截断才用气泡全文
{
  eq("列表 昨天+钟点", cleanListPreview("昨天 23:39 测试C1"), { text: "测试C1", time: "昨天 23:39" });
  eq("列表 单独钟点", cleanListPreview("23:39 你好"), { text: "你好", time: "23:39" });
  eq("列表 斜杠日期", cleanListPreview("2026/10/22 测试"), { text: "测试", time: "2026/10/22" });
  eq("列表 今天开头不是时间", cleanListPreview("今天 好累"), { text: "今天 好累", time: "" });
  eq("列表 普通预览不动", cleanListPreview("在吗"), { text: "在吗", time: "" });
  eq("列表 空值不崩", cleanListPreview(null), { text: "", time: "" });

  eq("全文 预览与气泡一致", fullIncoming("测试C1", "测试C1"), "测试C1");
  eq("全文 气泡带时间也认", fullIncoming("在吗", "刚刚 在吗"), "在吗");
  eq("全文 预览截断时用气泡", fullIncoming("这是一条很长很长的消息", "这是一条很长很长的消息，后面还有更多"), "这是一条很长很长的消息，后面还有更多");
  eq("全文 对不上就丢掉", fullIncoming("测试C1", "测试C2"), "");
  eq("全文 媒体不取标题", fullIncoming("[图片]", "视频标题"), "");
  eq("全文 没有命中不取", fullIncoming("在吗", ""), "");
}

// 3.99 重启自愈：命令归一化（卡片写「回 1」，也应认「回1/回复1」）+ state 损坏读备份
{
  eq("命令 回 1", normalizeCmd("回 1"), "1");
  eq("命令 回1", normalizeCmd("回1"), "1");
  eq("命令 回复12", normalizeCmd("回复 12"), "12");
  eq("命令 回0", normalizeCmd("回0"), "0");
  eq("命令 普通1", normalizeCmd("1"), "1");
  eq("命令 不误伤改", normalizeCmd("改"), "改");

  const d = mkdtempSync(join(tmpdir(), "dsh-state-"));
  try {
    writeFileSync(join(d, "state.json"), "{broken", "utf8");
    mkdirSync(join(d, "backups"));
    writeFileSync(join(d, "backups", "state-2026-10-22.json"), JSON.stringify({ ok: 1 }), "utf8");
    const r = loadStateFile(join(d, "state.json"), join(d, "backups"));
    eq("state 坏文件读备份", r.state, { ok: 1 });
    ok("state 来源是备份", String(r.from).startsWith("backup:"));

    const d2 = mkdtempSync(join(tmpdir(), "dsh-state-"));
    try {
      writeFileSync(join(d2, "state.json"), "not json", "utf8");
      const r2 = loadStateFile(join(d2, "state.json"), join(d2, "backups"));
      eq("state 无备份回空状态", r2.state, {});
      eq("state 来源 empty", r2.from, "empty");
    } finally { rmSync(d2, { recursive: true, force: true }); }
  } finally { rmSync(d, { recursive: true, force: true }); }
}


// 3.100 pending 期间对方又发消息：回复前从当前气泡里补抓（rows 最新在前）
{
  const rows = [
    { text: "刚刚 你还没睡 睡去", mine: true },
    { text: "刚刚 明天出来玩吗", mine: false },
    { text: "刚刚 在干嘛", mine: false }
  ];
  eq("补抓 回复前的对方新气泡", extraIncomingFromRows(rows, "在干嘛", ["在干嘛"]).map(x => x.text), ["明天出来玩吗"]);
  eq("补抓 多条按时间顺序", extraIncomingFromRows([
    { text: "刚刚 第三条", mine: false },
    { text: "刚刚 第二条", mine: false },
    { text: "在干嘛", mine: false }
  ], "在干嘛", ["在干嘛"]).map(x => x.text), ["第二条", "第三条"]);
  eq("补抓 已知的不重复", extraIncomingFromRows(rows, "在干嘛", ["在干嘛", "明天出来玩吗"]), []);
  eq("补抓 找不到已答就不动", extraIncomingFromRows(rows, "没问过", []), []);
  eq("补抓 跳过自己的气泡", extraIncomingFromRows([
    { text: "刚刚 我的回复", mine: true },
    { text: "在干嘛", mine: false }
  ], "在干嘛", ["在干嘛"]), []);
  eq("补抓 跳过噪音", extraIncomingFromRows([
    { text: "刚刚 2小时内在线", mine: false },
    { text: "在干嘛", mine: false }
  ], "在干嘛", ["在干嘛"]), []);
  eq("补抓 跳过时间分隔条", extraIncomingFromRows([
    { text: "刚刚", mine: false, isTime: true },
    { text: "明天出来玩吗", mine: false },
    { text: "在干嘛", mine: false }
  ], "在干嘛", ["在干嘛"]).map(x => x.text), ["明天出来玩吗"]);
}

// 3.101 语音标记转文字 / 静默来源 / 未回消息
{
  eq("语音 带情绪和尾文", sanitizeOutgoing("[[语音:你不是要睡觉吗 咋还醒着|sleepy]] 昨晚说好玩 又不说几点"), "你不是要睡觉吗 咋还醒着 昨晚说好玩 又不说几点");
  eq("语音 纯标记", sanitizeOutgoing("[[语音:在吗|happy]]"), "在吗");
  eq("语音 普通句不变", sanitizeOutgoing("在干嘛"), "在干嘛");
  eq("语音 多条", sanitizeOutgoing("[[语音:第一句|a]] 中间 [[语音:第二句]]"), "第一句 中间 第二句");
  eq("语音 空内容", sanitizeOutgoing("[[语音:|x]]"), "");
  eq("草稿 语音转文字", shapeDrafts(["[[语音:在吗|a]]"]).drafts, ["在吗"]);
  state.autoQuiet = "23:30-07:00";
  eq("静默 01:00", inQuietAt(Date.UTC(2026, 9, 22, 17, 0)), true);
  eq("非静默 08:00", inQuietAt(Date.UTC(2026, 9, 23, 0, 0)), false);
  eq("未回 recent 新于 sent", hasUnansweredIncoming({ recent: [{ text: "在吗", at: 100 }], sent: [{ text: "嗯", at: 90 }], ctx: [{ mine: false, text: "在吗" }] }), true);
  eq("已回 sent 新于 recent", hasUnansweredIncoming({ recent: [{ text: "在吗", at: 100 }], sent: [{ text: "嗯", at: 110 }], ctx: [{ mine: true, text: "嗯" }] }), false);
  eq("未回 buffer 非空", hasUnansweredIncoming({ buffer: [{ text: "在吗" }], recent: [], sent: [], ctx: [] }), true);
  eq("未回 ctx 末 incoming", hasUnansweredIncoming({ buffer: [], recent: [], sent: [], ctx: [{ mine: true, text: "嗯" }, { mine: false, text: "明天出来玩吗" }] }), true);
  eq("未回 ctx 末尾空行不算已回", hasUnansweredIncoming({ buffer: [], recent: [], sent: [], ctx: [{ mine: false, text: "2\"" }, { mine: true, text: "" }] }), true);
  eq("ctx 全是空行不算未回", hasUnansweredIncoming({ buffer: [], recent: [], sent: [], ctx: [{ mine: true, text: "" }, { mine: true, text: "  " }] }), false);
  eq("主动名单默认不跟 autoConvs", proactiveTargets({ autoConvs: ["测试会话", "zero0"] }), []);
  eq("主动名单显式才生效", proactiveTargets({ autoConvs: ["测试会话"], proactiveConvs: ["测试会话", " zero0 "] }), ["测试会话", "zero0"]);
  eq("主动 ctx 去掉空/纯数字/撤回", cleanProactiveCtx([
    { mine: false, text: "2\"" },
    { mine: true, text: "" },
    { mine: false, text: "你撤回了一条消息 重新编辑" },
    { mine: false, text: "在干嘛" }
  ]), [{ mine: false, text: "在干嘛" }]);
  eq("主动 ctx 最多 8 条", cleanProactiveCtx(Array.from({ length: 12 }, (_, i) => ({ mine: i % 2 === 0, text: "第" + i + "句" }))).length, 8);
}

// 3.103 已读不再弹草稿
{
  eq("已读 单聊 unread=0", readBeforeDraft(0, false), true);
  eq("已读 单聊 unread=1", readBeforeDraft(1, false), false);
  eq("已读 单聊 unread 未知", readBeforeDraft(null, false), false);
  eq("已读 单聊 unread 字符串", readBeforeDraft("0", false), false);
  eq("已读 单聊 unread 小数", readBeforeDraft(0.5, false), false);
  eq("已读 单聊 unread 负数", readBeforeDraft(-1, false), false);
  eq("已读 群 unread=0", readBeforeDraft(0, true), false);
  eq("已读 群 unread=1", readBeforeDraft(1, true), false);
  eq("已读 watcher 刚点开 10 秒", readBeforeDraft(0, false, 1000000, 1010000), false);
  eq("已读 watcher 点开 29999ms", readBeforeDraft(0, false, 1000000, 1029999), false);
  eq("已读 watcher 点开满 30 秒", readBeforeDraft(0, false, 1000000, 1030000), true);
  eq("已读 watcher 点开 31 秒", readBeforeDraft(0, false, 1000000, 1031000), true);
  // watcher 正停在这个会话上时 unread 会被抖音抹成 0，这个 0 不能当成「用户已读」
  eq("已读 watcher 当前会话 unread=0", readBeforeDraft(0, false, 0, Date.now(), true), false);
  eq("已读 watcher 当前会话 30 秒前打开", readBeforeDraft(0, false, 1000000, 1031000, true), false);
  eq("已读 watcher 当前会话 群", readBeforeDraft(0, true, 0, Date.now(), true), false);
  eq("已读 watcher 不在该会话", readBeforeDraft(0, false, 0, Date.now(), false), true);
  // unreadCount 漏报时，readIndex 还停在旧消息上，也不能跳过
  eq("已读 位置晚于已读位置", readBeforeDraft(0, false, 0, Date.now(), false, true), false);
  eq("已读 位置晚于已读位置 打开超过 30 秒", readBeforeDraft(0, false, 1000000, 1031000, false, true), false);
  eq("已读 位置已追上", readBeforeDraft(0, false, 0, Date.now(), false, false), true);
}

// 3.104 同一句话连发两次：预览不变，靠 lastMessageIndex 兜底
{
  eq("同预览同键不是新消息", isNewPreview("嗯", "100", "嗯", "100"), false);
  eq("同预览键变了是新消息", isNewPreview("嗯", "100", "嗯", "101"), true);
  eq("预览变了就是新消息", isNewPreview("嗯", "100", "好的", "100"), true);
  eq("旧 state 没键不重复弹", isNewPreview("嗯", "", "嗯", "101"), false);
  eq("没键也没预览", isNewPreview("", "100", "", "101"), false);
  eq("数字键按字符串比", isNewPreview("嗯", 100, "嗯", "100"), false);
}

// 3.105 白名单名字归一化：NBSP（Past lives）/大小写/前后空格
{
  eq("名字 NBSP 相等", sameName("Past lives", "Past\u00a0lives"), true);
  eq("名字 大小写相等", sameName("Past Lives", "past lives"), true);
  eq("名字 前后空格相等", sameName(" zero0 ", "zero0"), true);
  eq("名字 emoji 相等", sameName("🍀", "🍀"), true);
  eq("名字 空不相等", sameName("", ""), false);
  eq("名字 不同不相等", sameName("你", "你们"), false);
}

// 3.102 媒体判向：最新真实气泡不能是时间分隔条
{
  eq("媒体 最新是时间条", latestRealRow([{ text: "刚刚", mine: false, isTime: true }]), null);
  eq("媒体 跳过时间条取消息", latestRealRow([
    { text: "刚刚", mine: false, isTime: true },
    { text: "", mine: true, isTime: false }
  ]).mine, true);
  eq("媒体 首条就是消息", latestRealRow([{ text: "", mine: true, isTime: false }]).mine, true);
  eq("媒体 空列表", latestRealRow([]), null);
  eq("媒体 null", latestRealRow(null), null);
  eq("媒体 时间条在后也跳过", latestRealRow([
    { text: "", mine: true, isTime: false },
    { text: "11:38", mine: false, isTime: true }
  ]).text, "");
  // 新消息是文字时，往下翻到的旧媒体不能拿来凑方向
  ok("媒体 最新是文字时不拿旧媒体", !latestRealRow([
    { text: "ta 刚说的", mine: false, isTime: false, hasMedia: false },
    { text: "", mine: true, isTime: false, hasMedia: true }
  ]).hasMedia);
}

// 3.105 补抓 known 不能收 ctx：判向会把 DOM 里还没进 buffer 的新消息塞进 ctx
{
  eq("补抓 known 不收 ctx", knownForCapture({
    ctx: [{ mine: false, text: "在吗" }],
    recent: [{ text: "上一句" }],
    sent: [{ text: "我发的" }],
    buffer: [{ text: "晚上出来吗" }]
  }, ["detect里的"]), ["上一句", "我发的", "晚上出来吗", "detect里的"]);
  eq("补抓 known 空状态", knownForCapture(null), []);
}


// 3.106 「用：内容」回退目标 + 跳过提示：不能发错人，也不能跳过硬安静
{
  const S = {
    allowedDMs: ["zero0", "Past lives"],
    convs: { zero0: {}, "Past lives": {}, "群": {} },
    recentIncomings: []
  };
  eq("最近消息 空", recentIncomingTarget(S), null);
  noteRecentIncoming(S, "zero0", "在吗", false, 1000);
  eq("最近消息 只有一条", recentIncomingTarget(S, 2000).conv, "zero0");
  noteRecentIncoming(S, "Past lives", "哦坤", false, 3000);
  eq("最近消息 取最新", recentIncomingTarget(S, 4000).conv, "Past lives");
  noteRecentIncoming(S, "Past lives", "哦坤哦坤", false, 5000);
  eq("最近消息 同会话去重", S.recentIncomings.length, 2);
  eq("最近消息 同会话取后一条", recentIncomingTarget(S, 6000).text, "哦坤哦坤");
  clearRecentIncoming(S, "Past lives");
  eq("最近消息 清掉最新回退前一条", recentIncomingTarget(S, 7000).conv, "zero0");
  noteRecentIncoming(S, "群", "群消息", true, 8000);
  eq("最近消息 跳过群", recentIncomingTarget(S, 9000).conv, "zero0");
  noteRecentIncoming(S, "陌生人", "你好", false, 10000);
  eq("最近消息 跳过非白名单", recentIncomingTarget(S, 11000).conv, "zero0");
  noteRecentIncoming(S, "不存在", "你好", false, 12000);
  eq("最近消息 跳过没有会话记录的", recentIncomingTarget(S, 13000).conv, "zero0");
  eq("最近消息 过期不取", recentIncomingTarget(S, 1000 + 10 * 60 * 1000 + 1), null);
  const S3 = { allowedDMs: [], convs: {}, recentIncomings: [] };
  for (let i = 0; i < 12; i++) { S3.convs["c" + i] = {}; noteRecentIncoming(S3, "c" + i, "m" + i, false, 200000 + i); }
  eq("最近消息 最多留 10 个会话", S3.recentIncomings.length, 10);
  eq("最近消息 丢最老的", S3.recentIncomings[0].conv, "c2");
  // 3.108 主动指定人：命令解析 + 白名单解析 + 卡片不能冒充「对方发来」
  {
    const S = { allowedDMs: ["测试会话", "Past lives"], allowedGroups: ["群"], convs: { "测试会话": { lastActivityAt: 1 }, "Past\u00a0lives": { lastActivityAt: 2 }, "群": {} } };
    eq("主动 解析 带空格", parseInitiateCommand("让 测试会话 说：明天出来玩吗"), { target: "测试会话", topic: "明天出来玩吗" });
    eq("主动 解析 不带空格", parseInitiateCommand("让测试会话说：在干嘛"), { target: "测试会话", topic: "在干嘛" });
    eq("主动 解析 普通文本", parseInitiateCommand("随便说说"), null);
    eq("主动 白名单 命中", resolveWhitelistDm(S, "测试会话"), "测试会话");
    eq("主动 白名单 兼容 NBSP", resolveWhitelistDm(S, "Past lives"), "Past\u00a0lives");
    eq("主动 白名单 群拒绝", resolveWhitelistDm(S, "群"), null);
    eq("主动 白名单 名单外", resolveWhitelistDm(S, "陌生人"), null);
    const c = card({ conv: "测试会话", initiate: true, incoming: "问她明天出不出来玩", drafts: ["明天出来玩吗", "你明天有空没"], tags: ["主动", "备选"], at: Date.now(), group: false });
    ok("主动 卡头写清楚", c.includes("主动开口") && c.includes("问她明天"));
    ok("主动 卡不冒充对方回复", !c.includes("抖音私信草稿"));
  }
  eq("手动回了 最新是我", lastRealIsMine([{ mine: true, text: "我自己回了" }, { mine: false, text: "在吗" }]), true);
  eq("手动回了 最新是对方", lastRealIsMine([{ mine: false, text: "在吗" }, { mine: true, text: "我上一句" }]), false);
  eq("手动回了 跳过时间条", lastRealIsMine([{ isTime: true, text: "12:00" }, { mine: true, text: "回了" }]), true);
  eq("手动回了 空列表", lastRealIsMine([]), false);
}

// 3.110 分享视频固定回 + 媒体卡回 0
{
  eq("分享视频 识别", isSharedVideoPreview("分享[视频] 2025年的第一场雪"), true);
  eq("分享视频 旧格式", isSharedVideoPreview("[分享视频] 标题"), true);
  eq("分享图集 不是视频", isSharedVideoPreview("分享[图集] 旅行"), false);
  eq("普通视频占位 不是分享视频", isSharedVideoPreview("[视频]"), false);
  eq("视频固定文案", VIDEO_ACK_TEXT, "别分享视频 我看不见");

  const vs = { autoOn: true, allowedDMs: ["测试会话"], muted: [], blocked: [], autoQuiet: "23:30-07:00" };
  const vmq = { mine: false, dirUnknown: false };
  const noon = Date.parse("2026-10-23T12:00:00+08:00");
  const night = Date.parse("2026-10-23T23:45:00+08:00");
  eq("视频回 允许", videoAckAllowed(vs, "测试会话", vmq, noon), true);
  eq("视频回 自动关拒绝", videoAckAllowed({ ...vs, autoOn: false }, "测试会话", vmq, noon), false);
  eq("视频回 方向不明拒绝", videoAckAllowed(vs, "测试会话", { mine: false, dirUnknown: true }, noon), false);
  eq("视频回 自己发拒绝", videoAckAllowed(vs, "测试会话", { mine: true, dirUnknown: false }, noon), false);
  eq("视频回 群拒绝", videoAckAllowed(vs, "群聊", vmq, noon), false);
  eq("视频回 名单外拒绝", videoAckAllowed(vs, "陌生人", vmq, noon), false);
  eq("视频回 静音拒绝", videoAckAllowed({ ...vs, muted: ["测试会话"] }, "测试会话", vmq, noon), false);
  eq("视频回 静默拒绝", videoAckAllowed(vs, "测试会话", vmq, night), false);

  const ms = { mediaPending: { conv: "测试会话", incoming: "分享[视频] 标题", at: 1000 } };
  eq("媒体0 取到", takeMediaPending(ms, 2000), { conv: "测试会话", incoming: "分享[视频] 标题", at: 1000 });
  eq("媒体0 取完清空", ms.mediaPending, null);
  eq("媒体0 过期", takeMediaPending({ mediaPending: { conv: "x", incoming: "分享[视频]", at: 1000 } }, 1000 + 60 * 60 * 1000 + 1), null);
  eq("媒体0 没有", takeMediaPending({}, 1000), null);
}

// 3.111 草稿提醒（每 10 分钟；TTL 30 分钟）
{
  const now = Date.parse("2026-10-23T12:00:00+08:00");
  const p = { conv: "测试会话", incoming: "在干嘛", drafts: ["在呢", "干嘛"], tags: ["接话", "反问"], at: now, cardSent: true, _cardAt: now };
  eq("草稿提醒 TTL 30 分钟", PENDING_TTL, 30 * 60 * 1000);
  eq("草稿提醒 没草稿不提醒", pendingReminderText({ ...p, drafts: [] }, now + 10 * 60000, 10 * 60000, 30 * 60000), "");
  eq("草稿提醒 初始卡没发不提醒", pendingReminderText({ ...p, cardSent: false }, now + 10 * 60000, 10 * 60000, 30 * 60000), "");
  eq("草稿提醒 不到 10 分钟不提醒", pendingReminderText(p, now + 9 * 60000 + 59 * 1000, 10 * 60000, 30 * 60000), "");
  const t = pendingReminderText(p, now + 10 * 60000, 10 * 60000, 30 * 60000);
  ok("草稿提醒 到点有内容", t.includes("当前有一条草稿待回复") && t.includes("在呢") && t.includes("约 20 分钟"));
  eq("草稿提醒 过期不提醒", pendingReminderText(p, now + 30 * 60000, 10 * 60000, 30 * 60000), "");
  const reminded = { ...p, _lastRemindAt: now + 10 * 60000 };
  eq("草稿提醒 刚提醒过不重复", pendingReminderText(reminded, now + 15 * 60000, 10 * 60000, 30 * 60000), "");
  ok("草稿提醒 再过 10 分钟再提醒", pendingReminderText(reminded, now + 20 * 60000, 10 * 60000, 30 * 60000).includes("当前有一条草稿待回复"));
}

console.log("\n" + (fail ? "FAILED" : "ALL PASS") + "  " + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
