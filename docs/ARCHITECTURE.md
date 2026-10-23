# 架构

## 进程与数据流

`watcher10.mjs` 是唯一常驻进程：

1. 用 Playwright 连接 / 启动持久化 Edge，打开抖音私信页。
2. 每 `POLL_MS`（默认 10 秒）读会话列表；有未读/预览变化时判定方向。
3. 新消息进入 `state.detect`，按 `BATCH_MS` 合并后生成候选。
4. `draft2.makeDrafts` 调模型，返回 2 条候选 + 标签。
5. 默认写 `state.pending` 并往飞书发审批卡；如果满足自动条件，走 `autoSend`。
6. 飞书轮询读指令，`1/2/0/改/用：` 操作 pending 或直接发送。
7. 发送前再次判向、防重、检查是否已手动回复；成功写 `state.convs[conv].sent`。

## 模块

### watcher10.mjs

- `readAll`：读会话列表，返回 `{title, preview, unread, active, unreadByIndex, ...}`。
- `readBubbles` / `latestRealRow` / `directionByDom`：读气泡、跳过时间条、判断最后一条是谁发的。
- `readBeforeDraft`：用未读数/索引决定是否跳过；当前打开会话的 0 未读不算已读。
- `extraIncomingFromRows` / `captureExtraIncoming`：发送前后补抓 pending 期间新到的消息。
- `card` / `mediaQueue`：生成飞书卡片；媒体卡单独排队，避免堵文本草稿。
- `autoEligible`：自动回复资格（白名单、静默、敏感词、额度、空草稿等）。
- `replyDelayMs` / `rhythmCfg`：回复延迟；读 `rhythm.json`。
- `sendToDouyin`：点开会话、输入、发送；多重校验发送结果。
- `sendCardRaw` / `sendCard` / `flushOutbox`：飞书发卡、失败重试、去重。
- `loadStateFile` / `save` / `backupState`：state 原子写、损坏回退、每日备份。
- HTTP `/api`：只读状态，绑定 `127.0.0.1`。

### draft2.mjs

- `makeDrafts(msgs, incoming, opts)`：生成候选；`opts.cands` 控制条数，`opts.skipRerank` 跳过审稿，`opts.group`/`opts.proactive` 切场景。
- `revise(text, {hint})`：按「改短/改狠/改软/别问/夸」重写。
- 人味过滤：`META_LEAK`、`HUMAN_TELL`、`humanPenalty`、`shapeDrafts`、`rescueDrafts`。
- 语料/人设分别读 `CORPUS_PATH` / `SOUL_PATH`。

### proactive.mjs

主动开口的计划、候选生成、频率控制；默认关闭，需在飞书 `主动 开`，且 `proactiveConvs` 为空时不会选人。

### people.mjs

把聊天记录蒸馏成人物档案，供 `makeDrafts` 注入。档案在 `people/`，属于私人数据，不进仓库。

### classify.mjs

解析聊天记录、分类消息，供 people 和摘要使用。

## state.json 关键字段

| 字段 | 说明 |
| --- | --- |
| `convs` | 每个会话的 `lastPreview` / `buffer` / `recent` / `sent` / `ctx` / `uid` |
| `allowedDMs` | 私聊白名单（空 = 全部） |
| `allowedGroups` / `autoGroups` | 群白名单 / 群自动范围 |
| `autoOn` / `autoConvs` / `autoDailyCap` / `autoQuiet` | 自动回复配置 |
| `pending` | 当前待审草稿（`conv/incoming/drafts/tags/cardSent/...`） |
| `queue` | 等待生成的草稿（合并窗口） |
| `recentIncomings` | 最近入站消息，供 `用：内容` 回退 |
| `outbox` / `feishuSeen` | 飞书失败重试 / 去重 |
| `stats` | 日统计（消息/卡片/发送/错误/token） |

## 设计取舍

- **审批优先**：默认所有回复先出卡；自动是可选白名单，不是默认。
- **发送前判向**：不信任列表预览，发送前用 DOM 再确认一次。
- **不自动补发静默期消息**：早上不把昨晚的消息自动回出去。
- **媒体不阻塞文本**：媒体卡不写 `pending`，避免一张图片卡住后续文字草稿。
- **state 损坏可回退**：主文件坏时读 backups，并重置飞书游标，宁可少发不可发错。
