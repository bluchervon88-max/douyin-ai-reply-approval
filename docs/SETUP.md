# 部署

## 前置

- Windows 10/11，Node.js 20.6+
- Microsoft Edge
- 飞书自建应用 + 一个群
- DeepSeek API Key

## 1. 飞书应用

1. 打开 [飞书开放平台](https://open.feishu.cn/)，创建「企业自建应用」。
2. 开启「机器人」能力。
3. 权限至少包含：发消息、读群信息（不同租户名称可能不同，搜索 `im:message`、`im:chat` 相关权限）。
4. 发布版本，把机器人拉进审批群。
5. 拿到 `App ID` / `App Secret`。
6. 拿到群 `chat_id`（`oc_` 开头）。可以在群设置/开放平台调试台查看，或调用 `GET /open-apis/im/v1/chats`。

## 2. 安装

~~~bash
git clone https://github.com/bluchervon88-max/douyin-ai-reply-approval.git
cd douyin-ai-reply-approval
npm install
copy .env.example .env
copy persona\corpus.example.txt persona\corpus.txt
notepad persona\SOUL.md
notepad .env
~~~

## 3. 首次登录抖音

先保持 `HEADLESS=false`，然后：

~~~bash
npm start
~~~

Edge 会打开并加载抖音私信页。扫码登录，确认能看到会话列表。登录态保存在 `DOUYIN_PROFILE`（默认 `.profile/`）。

登录成功后可以改成 `HEADLESS=true` 再启动。

## 4. 验证

~~~bash
curl http://127.0.0.1:8899/api
~~~

返回里应有 `pid`、`hb`、`convs`、`pending` 等字段。飞书应收到一张启动卡（若配置了 `FEISHU_CHAT_ID`）。

## 5. 配置白名单和自动范围

在飞书里发：

~~~text
开私聊 某人
自动 开 某人
自动 状态
~~~

建议顺序：

1. 先只开白名单，自动关着，人工审批几天。
2. 确认判向、引用、媒体都正常。
3. 再对 1 个人开自动，设 `自动 上限 30` 和 `自动 静默 23:30-07:00`。
4. 稳定后再加第二个人。

## 6. 开机自启

可用 Windows 任务计划程序：

- 程序：`powershell.exe`
- 参数：`-NoProfile -ExecutionPolicy Bypass -File "C:\path\to\scripts\start-watcher.ps1"`
- 起始于：仓库根目录
- 勾选「无论用户是否登录都运行」需要按你的环境配置；第一次建议先手动运行。

`scripts/start-watcher.ps1` 会读取仓库根目录的 `.env` 并启动 `watcher10.mjs`。

## 7. 常见问题

**飞书收不到卡**

- `FEISHU_APP_ID/SECRET/CHAT_ID` 是否都填了
- 机器人是否在群里
- 应用权限是否发布
- 看 `watcher.log` 里 `feishu token` / `send card` 报错

**抖音读不到会话**

- 是否掉登录；设 `HEADLESS=false` 看窗口
- 页面是否停在私信列表
- Edge 是否被其他实例占用同一个 `DOUYIN_PROFILE`

**判向老错**

- 抖音 DOM 改版；用 `HEADLESS=false` 看气泡，更新 `readBubbles` 选择器
- 媒体消息优先走媒体卡，不要指望文本判向

**自动回复没发**

- `自动 状态` 看范围/额度/静默
- 是否命中敏感词
- 是否发送前发现你已经手动回了
- 看 `watcher.log` 的 `auto cancel` / `skip`

## 8. 停止

结束 `node watcher10.mjs` 进程即可。不要手动删 `watcher.lock`：正常退出会自己清理；异常退出后新进程会检查 pid 并接管。
