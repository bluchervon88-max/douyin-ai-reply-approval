
// 从 get_message_by_init 的 protobuf+JSON 里解析消息，并判断最后一条是谁发的
// 规律：每条消息内容 JSON 前面紧挨着一个 sec_uid —— 那是这条消息的【接收方】
// 接收方 == 自己  → 对方发来的
// 接收方 == 对方  → 自己发出去的

const UID_RE = /MS4wLjABAAAA[\w-]{20,70}/g;

function expandJSON(str, idx) {
  let start = str.lastIndexOf("{", idx);
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  const limit = Math.min(str.length, start + 4000);
  for (let i = start; i < limit; i++) {
    const c = str[i];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") { depth--; if (!depth) return { start, end: i, json: str.slice(start, i + 1) }; }
  }
  return null;
}

const norm = (s) => String(s || "").replace(/[\s\p{P}\p{S}]/gu, "");

export function parseMessages(buf) {
  const s = Buffer.isBuffer(buf) ? buf.toString("utf8") : String(buf);
  const out = [];
  const re = /"text":"/g;
  let m, guard = 0;
  while ((m = re.exec(s)) && guard++ < 4000) {
    const e = expandJSON(s, m.index);
    if (!e) continue;
    let o;
    try { o = JSON.parse(e.json); } catch { continue; }
    if (!o || !o.text) continue;
    const before = s.slice(Math.max(0, e.start - 320), e.start);
    const after = s.slice(e.end, e.end + 600);
    const uids = before.match(UID_RE) || [];
    const cids = before.match(/\d{1,6}:\d{1,6}:\d{6,20}:\d{6,20}/g) || [];
    out.push({ text: String(o.text), to: uids[uids.length - 1] || "", cid: cids[cids.length - 1] || "", web: /douyin_web/.test(after), at: e.start });
  }
  return out;
}

// preview 可能是截断的，用前 12 个字比对；取最后一次出现（最新的）
export function classifyMsgs(msgs, preview, selfUid, targetUid) {
  let pool = msgs;
  if (targetUid) pool = pool.filter(m => m.to === selfUid || m.to === targetUid);
  const key = norm(preview).slice(0, 12);
  if (!key) return { dir: "unknown", reason: "empty preview" };
  let hit = null;
  // 先找完全相等的，再退回前缀匹配（避免 "噢" 命中 "噢啥噢…"）
  for (const m of pool) if (norm(m.text) === norm(preview)) hit = m;
  if (!hit && key.length >= 3) {
    for (const m of pool) {
      const t = norm(m.text);
      if (t.slice(0, key.length) === key && t.length >= key.length) hit = m;
    }
  }
  if (!hit) return { dir: "unknown", reason: "not found in payload" };
  // web 客户端发出的消息，接收方字段可能指回自己；但对方用网页发消息也会带这个标记
  // 所以不直接判定，交给上层用「本地发送记录」再确认
  if (hit.web && hit.to === selfUid) return { dir: "web-self", text: hit.text, uid: hit.to, cid: hit.cid, how: "douyin_web" };
  if (hit.web) return { dir: "theirs", text: hit.text, uid: hit.to, cid: hit.cid, how: "douyin_web-other" };
  if (hit.to === selfUid) return { dir: "theirs", text: hit.text, uid: hit.to, cid: hit.cid };
  if (hit.to) return { dir: "mine", text: hit.text, uid: hit.to, cid: hit.cid };
  return { dir: "unknown", reason: "no uid before message", text: hit.text, cid: hit.cid };
}

export function classify(buf, preview, selfUid, targetUid) {
  return classifyMsgs(parseMessages(buf), preview, selfUid, targetUid);
}

// 取某个会话最近 N 条真实消息（按 payload 顺序）
export function conversationMessages(msgs, cid, selfUid, limit = 10) {
  if (!cid) return [];
  const arr = msgs.filter(m => m.cid === cid);
  const uniq = [...new Map(arr.map(m => [m.text + "|" + m.to, m])).values()].sort((a, b) => a.at - b.at);
  return uniq.slice(-limit).map(m => ({ mine: m.to !== selfUid, text: m.text }));
}
