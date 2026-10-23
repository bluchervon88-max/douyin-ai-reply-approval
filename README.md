# 抖音私信 AI 审批助手

把抖音私信接到飞书：对方发来消息 → 生成两条候选回复 → 飞书卡片审批 → 你在飞书回 `1` / `2` → 自动发回抖音。

也可以只开白名单里的几个人做全自动，其余人仍然逐条审批。

> **请先读 [安全说明](docs/SECURITY.md)。** 这个项目会操作你的真实抖音账号，也会把聊天摘要发给模型。建议只在个人账号、熟人聊天里使用，不要群发、骚扰或冒充他人。自动化可能触发平台风控，风险自负。

## 功能

- **私信监听**：轮询抖音会话列表，识别新消息；支持私聊白名单、群聊 @、静默时段。
- **判向**：用 DOM 气泡判断最后一条是对方发的还是自己发的；媒体消息、引用消息有单独处理。
- **候选回复**：一次生成多条候选，带「正常接话 / 怼或玩笑 / 反问 / 看情况」等标签；可重写、改短、改狠、改软。
- **飞书审批**：卡片显示上下文和候选；回 `1` / `2` 发送，`12` 连发，`0` 跳过，`改` 重写，`用：内容` 直接发。
- **自动回复**：按会话白名单、每日额度、静默时段、敏感词闸门自动发；发送前会检查你是不是已经自己回了。
- **媒体兜底**：图片/表情/分享视频出卡片；分享视频可按固定话术自动回。
- **主动开口**：给指定的人生成「主动搭话」候选，仍然先出卡审批。
- **持久化**：state 原子替换 + 每日备份；飞书发卡失败进 outbox；重启恢复待审草稿。

## 架构

~~~text
抖音网页 (Edge, CDP/Playwright)
        │  轮询会话列表 + 读气泡
        ▼
  watcher10.mjs ──► draft2.mjs (DeepSeek) ──► 候选
        │                                      │
        │  飞书卡片 ◄──────────────────────────┘
        │      │ 回 1/2/0/改/用：
        ▼      ▼
   发送到抖音（带判向、手动接管、防重）
        │
        └──► state.json / watcher.log / people/
~~~

更细的模块说明见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 快速开始

### 1. 环境

- Windows 10/11（当前主要在 Windows 上验证）
- Node.js 20.6+
- Microsoft Edge
- 一个飞书自建应用（需要机器人能力）和一个飞书群
- DeepSeek API Key

### 2. 安装

~~~bash
git clone https://github.com/bluchervon88-max/douyin-ai-reply-approval.git
cd douyin-ai-reply-approval
npm install
~~~

### 3. 配置

复制模板并填写：

~~~bash
copy .env.example .env
copy persona\corpus.example.txt persona\corpus.txt
~~~

至少填这几项：

~~~dotenv
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
FEISHU_CHAT_ID=oc_xxx
DEEPSEEK_API_KEY=sk-xxx
~~~

说明：

- 飞书应用需要开启机器人能力，并把机器人拉进目标群；`FEISHU_CHAT_ID` 是群 id（`oc_` 开头）。
- `DEEPSEEK_API_KEY` 也可以不填，代码会尝试从 `OPENCLAW_GATEWAY_CMD` 或 `~/.openclaw/gateway.cmd` 读取（兼容旧环境）。
- 第一次登录抖音建议 `HEADLESS=false`，会打开 Edge 窗口让你扫码；登录成功后可以改回 `true`。

### 4. 首次启动

~~~bash
npm start
~~~

第一次没有 `state.json` 时会自动建立基线，不会把历史消息当成新消息。启动后 Edge 会打开抖音创作者/私信页面；扫码登录。

检查本地状态接口：

~~~bash
curl http://127.0.0.1:8899/api
~~~

### 5. 在飞书里配置

给机器人发消息（或直接在群里发）：

~~~text
开私聊 某人        加入私聊白名单
私聊列表           看白名单
自动 开 某人       只自动回这个人
自动 状态          看自动范围/额度/静默
自动 静默 23:30-07:00
自动 上限 30
状态               看运行状态
帮助               看全部指令
~~~

> 白名单为空时等于「所有私聊」；自动范围为空时等于「白名单里所有私聊」。第一次用建议先设白名单，再逐个开自动。

## 配置

所有配置走环境变量，代码不读 `.env` 本身；用 `npm start`（内部是 `node --env-file=.env`）或 `scripts/start-watcher.ps1`。

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `FEISHU_APP_ID` | 空 | 飞书应用 App ID |
| `FEISHU_APP_SECRET` | 空 | 飞书应用 Secret |
| `FEISHU_CHAT_ID` | 空 | 审批群 chat id；为空时跳过发卡 |
| `DEEPSEEK_API_KEY` | 空 | DeepSeek Key；为空时尝试 gateway.cmd |
| `DOUYIN_DM_DIR` | 脚本目录 | state/log/people/rhythm 的根目录 |
| `DOUYIN_PROFILE` | `<DIR>/.profile` | Edge 持久化用户目录（登录态） |
| `EDGE_PATH` | 常见 Edge 路径 | msedge.exe 路径 |
| `HEADLESS` | `true` | `false` 显示浏览器窗口 |
| `CDP_PORT` | `9222` | 远程调试端口 |
| `WATCHER_PORT` | `8899` | 本地状态 API 端口（只绑 127.0.0.1） |
| `OPENCLAW_WORKSPACE` | `~/.openclaw/workspace` | MOOD/LIFE/表情等素材目录 |
| `STICKERS_DIR` | `<workspace>/stickers-v2` | 表情目录 |
| `SOUL_PATH` | `<DIR>/persona/SOUL.md` | 人设文件 |
| `CORPUS_PATH` | `<DIR>/persona/corpus.txt` | 语气语料 |
| `CORPUS_EXCLUDE` | 空 | 逗号分隔，生成语料时排除的词/人名 |

回复延迟、延迟分档在 `rhythm.json`；改完不用重启，下一次回复就会读新值。

## 自动回复的安全闸门

即使开了自动，以下情况仍然只出卡片、不自动发：

- 不在 `autoConvs` / 白名单 / 群自动名单
- 静默时段内收到，或消息来自静默时段（早上不补发）
- 媒体消息（分享视频按固定话术单独处理）
- 命中敏感词：见面、出来玩、借钱、地址、电话、在哪、几点、来接、医院、考试、家长、老师、学校、投诉、举报、截图、身份证、转账、密码、银行卡
- 草稿为空 / 纯标点
- 当天自动额度用完
- 会话被静音
- 发送前发现最新一条已经是自己发的（认为你已手动回）

这些闸门在 `watcher10.mjs` 的 `autoEligible` 和 `sendToDouyin` 附近；不要为了「全自动」随手删掉。

## 数据与隐私

公开仓库**不包含**任何真实聊天、联系人、登录态或密钥。运行时会产生以下文件，已被 `.gitignore` 排除：

- `state.json` / `state.json.*`：会话游标、待审草稿、白名单、统计
- `watcher.log` / `people.log`：运行日志，含聊天摘要
- `people/`：每个人的记忆档案
- `backups/`：state 每日备份
- `.profile/`：Edge 登录态（cookie）
- `*.png` / `*.bin` / `*.jsonl` 等抓取产物

不要把 `.env`、`state.json`、日志或 `people/` 提交到公开仓库。详见 [docs/SECURITY.md](docs/SECURITY.md)。

## 测试

~~~bash
npm test              # 纯函数自测，不连抖音、不调模型
npm run test:regress  # 可选：真实模型回归，会消耗 token
~~~

当前纯函数自测：`selftest.mjs` 264 项、`proactive-selftest.mjs` 54 项、`people-selftest.mjs` 12 项。

## 项目结构

~~~text
watcher10.mjs          主进程：轮询/判向/出卡/审批/发送/飞书/API
draft2.mjs             候选生成 + 审稿 + 重写
proactive.mjs          主动开口判定 + 开场白
people.mjs             人物档案（记忆注入）
classify.mjs           聊天记录解析/分类
selftest.mjs           纯函数自测
proactive-selftest.mjs 主动模块自测
people-selftest.mjs    人物档案自测
regress.mjs            真实模型回归（可选，耗 token）
rhythm.json            回复延迟配置
persona/               人设与语料模板
docs/                  架构/部署/安全
scripts/               Windows 启动脚本
~~~

## 已知限制

- 抖音网页 DOM 会变；气泡选择器坏了会导致判向/引用识别失败，需要更新选择器。
- 只在 Windows + Edge 上验证过；其他平台需要改 `EDGE_PATH` 和启动方式。
- 自动回复仍可能因为网络、登录失效、页面卡住而失败；失败会尽量落卡片/日志，但不能保证 100%。
- 模型会消耗 token；群聊/短句已做候选数分档，但仍建议设每日额度。
- 本项目不提供「绕过平台风控」的能力，也不建议多账号批量运行。

## License

MIT，见 [LICENSE](LICENSE)。
