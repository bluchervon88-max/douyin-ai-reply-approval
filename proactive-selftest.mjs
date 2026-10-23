// proactive-selftest.mjs — 只测纯函数，不调 API。
// 用法：node proactive-selftest.mjs
process.env.PROACTIVE_DRY = "1";                 // 万一 dry 分支被碰到也不会真的发请求

const P = await import("./proactive.mjs");
const { inActiveHours, plan, pickConv, recordProactive, todayStr, nowHM, makeOpening, makeOpenings, parseOpenings } = P;

let passed = 0, failed = 0;
const results = [];
function t(name, fn) {
  try { fn(); passed++; results.push("PASS  " + name); }
  catch (e) { failed++; results.push("FAIL  " + name + "  →  " + (e && e.message ? e.message : e)); }
}
function eq(a, b, msg) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((msg || "") + " 期望 " + JSON.stringify(b) + " 实际 " + JSON.stringify(a));
}

// 上海时间 → 时间戳（UTC+8）
const SH = (y, mo, d, h, mi) => Date.UTC(y, mo - 1, d, h - 8, mi, 0);
const DAY = 24 * 60 * 60 * 1000;

/* ---------------- inActiveHours ---------------- */
t("inActiveHours 21:05 在默认时段", () => eq(inActiveHours("21:05"), true));
t("inActiveHours 08:59 不在默认时段", () => eq(inActiveHours("08:59"), false));
t("inActiveHours 23:30 端点算在内", () => eq(inActiveHours("23:30"), true));
t("inActiveHours 23:31 已出界", () => eq(inActiveHours("23:31"), false));
t("inActiveHours 跨午夜 01:30 ∈ 23:00-02:00", () => eq(inActiveHours("01:30", "23:00-02:00"), true));
t("inActiveHours 跨午夜 23:00 起点", () => eq(inActiveHours("23:00", "23:00-02:00"), true));
t("inActiveHours 跨午夜 02:00 终点", () => eq(inActiveHours("02:00", "23:00-02:00"), true));
t("inActiveHours 跨午夜 02:01 出界", () => eq(inActiveHours("02:01", "23:00-02:00"), false));
t("inActiveHours 跨午夜 12:00 出界", () => eq(inActiveHours("12:00", "23:00-02:00"), false));
t("inActiveHours 坏区间 fail-open", () => eq(inActiveHours("12:00", "oops"), true));
t("inActiveHours 坏时刻 → false", () => eq(inActiveHours("25:99"), false));

/* ---------------- todayStr / nowHM ---------------- */
const NOW = SH(2026, 10, 22, 21, 5);             // 2026-10-22 21:05 上海
t("todayStr 上海日期", () => eq(todayStr(NOW), "2026-10-22"));
t("nowHM 补零", () => eq(nowHM(NOW), "21:05"));
t("nowHM 午夜是 00:05 不是 24:05", () => eq(nowHM(SH(2026, 10, 23, 0, 5)), "00:05"));
t("todayStr 午夜归属当天", () => eq(todayStr(SH(2026, 10, 23, 0, 5)), "2026-10-23"));

/* ---------------- plan ---------------- */
const base = () => ({ proactiveOn: true, proactiveHours: "09:00-23:30" });

t("plan 默认关 → 没开", () => eq(plan({ state: {}, now: NOW }), { ok: false, why: "没开" }));
t("plan 没开时优先报没开（不用看时段）", () => {
  const s = { proactiveOn: false }; eq(plan({ state: s, now: SH(2026, 10, 22, 3, 0) }).why, "没开");
});
t("plan 不在时段", () => { const s = base(); eq(plan({ state: s, now: SH(2026, 10, 22, 3, 0) }).why, "不在时段"); });
t("plan 时段内 ok", () => { const s = base(); eq(plan({ state: s, now: NOW }), { ok: true, why: "ok" }); });
t("plan 刚说过（60 分钟 < 默认 180）", () => {
  const s = base(); s.lastProactiveAt = NOW - 60 * 60000;
  eq(plan({ state: s, now: NOW }).why, "刚说过");
});
t("plan 冷却过了就 ok（200 分钟）", () => {
  const s = base(); s.lastProactiveAt = NOW - 200 * 60000;
  eq(plan({ state: s, now: NOW }).ok, true);
});
t("plan 自定义冷却 30 分钟，40 分钟前说过 → ok", () => {
  const s = base(); s.proactiveCooldownMin = 30; s.lastProactiveAt = NOW - 40 * 60000;
  eq(plan({ state: s, now: NOW }).ok, true);
});
t("plan 今天说够了（2/2 默认上限）", () => {
  const s = base(); s.proactiveDay = todayStr(NOW); s.proactiveCount = 2;
  eq(plan({ state: s, now: NOW }).why, "今天说够了");
});
t("plan 今天 1/2 → 还能说", () => {
  const s = base(); s.proactiveDay = todayStr(NOW); s.proactiveCount = 1;
  eq(plan({ state: s, now: NOW }).ok, true);
});
t("plan 昨天的次数不占今天额度", () => {
  const s = base(); s.proactiveDay = "2026-10-21"; s.proactiveCount = 5;
  eq(plan({ state: s, now: NOW }).ok, true);
});
t("plan 自定义日上限 3", () => {
  const s = base(); s.proactiveDailyCap = 3; s.proactiveDay = todayStr(NOW); s.proactiveCount = 2;
  eq(plan({ state: s, now: NOW }).ok, true);
});
t("plan 字段先到先得：没开 > 不在时段", () => {
  const s = { proactiveOn: false, proactiveHours: "09:00-23:30" };
  eq(plan({ state: s, now: SH(2026, 10, 22, 3, 0) }).why, "没开");
});

/* ---------------- pickConv ---------------- */
const mk = (o = {}) => Object.assign({
  autoConvs: ["小A"],
  muted: [],
  allowedGroups: [],
  convs: { "小A": { lastActivityAt: NOW - 200 * 60000 } },
  proactiveLog: [],
}, o);

t("pickConv 空 autoConvs → null", () => eq(pickConv({ state: { autoConvs: [] }, now: NOW }), null));
t("pickConv 冷场 200 分钟 → 小A", () => eq(pickConv({ state: mk(), now: NOW }), "小A"));
t("pickConv 还没冷场（30 分钟 < 120）→ null", () => eq(pickConv({ state: mk({ convs: { "小A": { lastActivityAt: NOW - 30 * 60000 } } }), now: NOW }), null));
t("pickConv 用 lastBufferAt 兜底", () => eq(pickConv({ state: mk({ convs: { "小A": { lastBufferAt: NOW - 300 * 60000 } } }), now: NOW }), "小A"));
t("pickConv 没有时间戳 → 跳过", () => eq(pickConv({ state: mk({ convs: { "小A": {} } }), now: NOW }), null));
t("pickConv 静音的跳过", () => eq(pickConv({ state: mk({ muted: ["小A"] }), now: NOW }), null));
t("pickConv 群（allowedGroups）跳过", () => eq(pickConv({ state: mk({ allowedGroups: ["小A"] }), now: NOW }), null));
t("pickConv 7 天内已主动 2 次 → 跳过", () => {
  const s = mk({ proactiveLog: [{ conv: "小A", at: NOW - DAY }, { conv: "小A", at: NOW - 2 * DAY }] });
  eq(pickConv({ state: s, now: NOW }), null);
});
t("pickConv 7 天前的不占券（3 条旧记录）", () => {
  const s = mk({ proactiveLog: [{ conv: "小A", at: NOW - 8 * DAY }, { conv: "小A", at: NOW - 9 * DAY }, { conv: "小A", at: NOW - 10 * DAY }] });
  eq(pickConv({ state: s, now: NOW }), "小A");
});
t("pickConv 别人用掉的券不算小A头上", () => {
  const s = mk({ proactiveLog: [{ conv: "小B", at: NOW - DAY }, { conv: "小B", at: NOW - DAY }] });
  eq(pickConv({ state: s, now: NOW }), "小A");
});
t("pickConv 自定义额度 1 → 已 1 次就跳过", () => {
  const s = mk({ proactivePerConvWeek: 1, proactiveLog: [{ conv: "小A", at: NOW - DAY }] });
  eq(pickConv({ state: s, now: NOW }), null);
});
t("pickConv 自定义冷场 300 分钟 → 200 分钟还不够冷", () => {
  eq(pickConv({ state: mk({ proactiveIdleMin: 300 }), now: NOW }), null);
});
t("pickConv 多个候选取最冷的（rnd=0）", () => {
  const s = mk({
    autoConvs: ["小B", "小A"],
    convs: { "小A": { lastActivityAt: NOW - 200 * 60000 }, "小B": { lastActivityAt: NOW - 900 * 60000 } },
  });
  eq(pickConv({ state: s, now: NOW, rnd: () => 0 }), "小B");
});
t("pickConv rnd=0.99 取到最后一个候选", () => {
  const s = mk({
    autoConvs: ["小A", "小B"],
    convs: { "小A": { lastActivityAt: NOW - 200 * 60000 }, "小B": { lastActivityAt: NOW - 900 * 60000 } },
  });
  eq(pickConv({ state: s, now: NOW, rnd: () => 0.99 }), "小A");
});
t("pickConv 不读文件、不改 state（纯函数）", () => {
  const s = mk();
  const snap = JSON.stringify(s);
  pickConv({ state: s, now: NOW });
  eq(JSON.stringify(s), snap);
});

/* ---------------- recordProactive ---------------- */
t("recordProactive 首次：日切 + 计 1 次 + 记 last", () => {
  const s = {};
  const r = recordProactive({ state: s, conv: "小A", now: NOW });
  eq(r.proactiveCount, 1); eq(r.proactiveDay, "2026-10-22");
  eq(r.lastProactiveAt, NOW); eq(r.lastProactiveConv, "小A");
  eq(r.proactiveLog.length, 1); eq(r.proactiveLog[0], { conv: "小A", at: NOW });
});
t("recordProactive 同日累加", () => {
  const s = { proactiveDay: "2026-10-22", proactiveCount: 1, lastProactiveAt: 0 };
  eq(recordProactive({ state: s, conv: "小A", now: NOW }).proactiveCount, 2);
});
t("recordProactive 跨日重置到 1", () => {
  const s = { proactiveDay: "2026-10-21", proactiveCount: 5 };
  eq(recordProactive({ state: s, conv: "小B", now: NOW }).proactiveCount, 1);
});
t("recordProactive 日志只留最近 50 条", () => {
  const log = Array.from({ length: 60 }, (_, i) => ({ conv: "旧" + i, at: NOW - 100000 }));
  const s = { proactiveLog: log };
  const r = recordProactive({ state: s, conv: "小A", now: NOW });
  eq(r.proactiveLog.length, 50);
  eq(r.proactiveLog[49].conv, "小A");
  eq(r.proactiveLog[0].conv, "旧11");
});
t("recordProactive 就地改 state 且返回同一对象", () => {
  const s = {};
  eq(recordProactive({ state: s, conv: "x", now: NOW }) === s, true);
  eq(s.proactiveCount, 1);
});
t("recordProactive 之后 plan 会说刚说过", () => {
  const s = base();
  recordProactive({ state: s, conv: "小A", now: NOW });
  eq(plan({ state: s, now: NOW + 60 * 60000 }).why, "刚说过");
});

/* ---------------- parseOpenings / makeOpenings ---------------- */
t("parseOpenings 去编号、保留顺序", () => eq(parseOpenings("1. 在干嘛\n2. 睡了吗", 4), ["在干嘛", "睡了吗"]));
t("parseOpenings 过滤在吗/重复/超长", () => eq(parseOpenings("1. 在吗\n2. 在吗\n3. " + "很".repeat(41), 4), []));
t("parseOpenings 过滤客服腔/重复", () => eq(parseOpenings("1. 好的\n2. 你睡了吗\n3. 你睡了吗", 4), ["你睡了吗"]));
t("parseOpenings 限制 n 条", () => eq(parseOpenings("1. 一\n2. 二\n3. 三", 2), ["一", "二"]));

/* ---------------- makeOpening 的 dry 分支（不调 API） ---------------- */
const dry = await makeOpening({ conv: "小A", ctx: [{ mine: false, text: "睡了" }], life: { mood: "烦" } });
t("makeOpening PROACTIVE_DRY=1 返回固定样例", () => eq(dry, "在干嘛呢"));
const dryList = await makeOpenings({ conv: "小A", topic: "问她作业写完没" });
t("makeOpenings PROACTIVE_DRY=1 返回样例", () => eq(dryList, ["在干嘛呢"]));

console.log(results.join("\n"));
console.log("");
if (failed === 0) console.log("ALL PASS " + passed + " passed, 0 failed");
else console.log("FAILED " + passed + " passed, " + failed + " failed");
process.exit(failed === 0 ? 0 : 1);
