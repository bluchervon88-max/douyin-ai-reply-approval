/**
 * people.mjs 自检：别名/归一化匹配、400 字封顶、群渲染。
 * 只往 people/ 里写 2 句以内的临时档案（tick 要求 ≥4 句才建档案，不会被定时任务吃掉），跑完删。
 * 用法：node people-selftest.mjs
 */
import { writeFileSync, readFileSync, unlinkSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { memoryFor } from "./people.mjs";

const P = process.env.PEOPLE_DIR || join(dirname(fileURLToPath(import.meta.url)), "people");
mkdirSync(P, { recursive: true });
const slug = (n) => createHash("sha1").update(String(n)).digest("hex").slice(0, 10);
const tmp = [];
let pass = 0, fail = 0;

function check(label, cond, extra) {
  if (cond) { pass++; console.log("  ok   " + label); }
  else { fail++; console.log("  FAIL " + label + (extra ? "  → " + extra : "")); }
}

function make(name, extra = {}) {
  const f = join(P, slug(name) + ".json");
  writeFileSync(f, JSON.stringify({
    name, alias: [], group: false, firstSeen: Date.now(), lastSeenAt: Date.now(),
    log: [{ mine: false, text: "在吗", h: "a" }, { mine: true, text: "在", h: "b" }],
    profile: { who: "自检对象", relation: "同事", style: "短", topics: "测试", lastState: "刚聊完" },
    profiledCount: 2, seen: ["a", "b"], ...extra,
  }), "utf8");
  tmp.push(f);
  return f;
}

try {
  console.log("别名 / 归一化匹配");
  make("自检甲", { alias: ["自检甲旧"] });
  check("原名命中", memoryFor("自检甲").includes("你俩聊过 2 句"));
  check("别名命中", memoryFor("自检甲旧").includes("你俩聊过 2 句"));
  check("改名加 emoji 后仍命中", memoryFor("自检甲🌊").includes("你俩聊过 2 句"));
  check("陌生人返回空", memoryFor("完全不存在的人") === "");

  console.log("四百字封顶");
  const long = "很长的一段描述".repeat(40);
  make("自检长档", { profile: { who: long, relation: long, style: long, topics: long, lastState: long } });
  const out = memoryFor("自检长档");
  check("长度 ≤ 401", out.length <= 401, String(out.length));
  check("结尾有省略号", out.endsWith("…"));

  console.log("群聊渲染");
  make("自检群", { group: true });
  const g = memoryFor("自检群");
  check("标题标明是群", g.includes("关于群「自检群」"));
  check("明细写「群里最近说的」", g.includes("群里最近说的"));
  check("群不输出「关系」行（那是私聊字段）", !/\n关系：/.test(g));

  console.log("文件可解析");
  for (const f of tmp) {
    const p = JSON.parse(readFileSync(f, "utf8"));
    check("读回 " + p.name, !!p.name);
  }
} finally {
  for (const f of tmp) { try { unlinkSync(f); } catch {} }
}
console.log("\n" + (fail ? "FAIL" : "全部通过") + "  " + pass + " ok / " + fail + " fail");
process.exit(fail ? 1 : 0);
