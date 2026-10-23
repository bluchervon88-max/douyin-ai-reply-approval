
import { makeDrafts, _jacForTest } from "./draft2.mjs";

const AI_WORDS = /(AI|ai|机器人|程序|模型|语言模型|助手)/;
const FRIENDS = String(process.env.CORPUS_EXCLUDE || "").split(",").map(s => s.trim()).filter(Boolean);
const ARTIFACT = new RegExp("[{}\u0060\"]|cands|json", "i");

const CASES = [
  { in: "你是AI吗", tag: "问AI", must: /522|想多了/, mustNot: AI_WORDS },
  { in: "你是不是机器人", tag: "问机器人", must: /522|想多了/, mustNot: AI_WORDS },
  { in: "你是真人吗", tag: "问真人", must: /522|想多了/, mustNot: AI_WORDS },
  { in: "明天来上课吗", tag: "问他的事", must: /问他/, mustNot: /^(来|去|行|可以|好)[啊呀]?$/ },
  { in: "帮我带个饭", tag: "求她办事（自己答）", mustNot: /你问他/, must: /.{2,}/ },
  { in: "你是谁啊", tag: "问身份（要带上他）", must: /(?=.*522)(?=.*他)/, mustNot: ARTIFACT },
  { in: "在干嘛", tag: "闲聊", must: /./, mustNot: ARTIFACT },
  { in: "今天好累啊", tag: "诉苦", must: /./, mustNot: ARTIFACT },
  { in: "晚安", tag: "结束语", must: /./, mustNot: ARTIFACT },
  { in: "有空吗", tag: "问她本人（自己答）", mustNot: /问他/, must: /.{1,}/ },
  // 同一件事连发/刷屏：她不该继续拿那个梗做文章
  { in: "测试B7", tag: "连发同一件事", msgs: [
      { mine: false, text: "测试B5" }, { mine: true, text: "B5啊 那你还得测一会儿" },
      { mine: false, text: "测试B6" }, { mine: true, text: "B6 那还早呢" } ],
    must: /./, mustNot: /测到第|那还早|还得测/,
    notLike: ["B6 那还早呢", "B5啊 那你还得测一会儿"] },
  // 普通重复：别把自己刚说过的话换个说法再说一遍
  { in: "在吗", tag: "重复自己", msgs: [
      { mine: false, text: "在吗" }, { mine: true, text: "在 干嘛" } ],
    must: /./, notLike: ["在 干嘛"] },
];

let fail = 0;
for (const c of CASES) {
  let out;
  try { out = await makeDrafts(c.msgs || [], c.in, { conv: "测试" }); }
  catch (e) { console.log("FAIL [" + c.tag + "] 生成失败: " + String(e.message).slice(0, 60)); fail++; continue; }
  const ds = out.drafts || [];
  const joined = ds.join(" / ");
  const problems = [];
  if (!ds.length) problems.push("没有草稿");
  if (joined.length > 60) problems.push("太长");
  if (c.must && !c.must.test(joined)) problems.push("缺少必需内容 " + c.must);
  if (c.mustNot && c.mustNot.test(joined)) problems.push("命中禁止 " + c.mustNot);
  if (ARTIFACT.test(joined)) problems.push("有 JSON 残渣");
  for (const prev of (c.notLike || [])) if (_jacForTest(joined, prev) >= 0.6) problems.push("跟刚才那句太像：「" + prev + "」");
  for (const n of FRIENDS) if (joined.includes(n)) problems.push("泄漏旧人名 " + n);
  if (AI_WORDS.test(joined) && !["问AI","问机器人","问真人"].includes(c.tag)) problems.push("提到 AI");
  if (problems.length) { fail++; console.log("FAIL [" + c.tag + "] " + c.in + " → " + JSON.stringify(ds) + " | " + problems.join("；")); }
  else console.log("ok   [" + c.tag + "] " + c.in + " → " + JSON.stringify(ds));
}
console.log("\n结果：" + (CASES.length - fail) + "/" + CASES.length + " 通过");
process.exit(fail ? 1 : 0);
