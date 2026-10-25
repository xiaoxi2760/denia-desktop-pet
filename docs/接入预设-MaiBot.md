# 接入预设 · MaiBot（麦麦）

> 面向「会用电脑但没读过代码」的用户。代码骨架在本仓库 **presets/maibot/adapter-skeleton/**（下文第 6 步说的「把 adapter-skeleton 文件夹复制出去」指的就是它）；调研依据与来源清单见 **presets/maibot/调研笔记.md**。
>
> 其他两种预设：[接入预设-DSH-bot.md](接入预设-DSH-bot.md) · [接入预设-AstrBot.md](接入预设-AstrBot.md)

- 写给谁：会用电脑、没读过代码的你。每一步都给可复制的命令/配置。
- 调研依据：`调研笔记.md`（全部结论带来源）；代码骨架：`adapter-skeleton/`（HTTP 契约已本机自测 15/15 通过）。
- 方案版本：2026-10-25，对应 MaiBot **v1.3.15**。

---

## 0. 总览：最后会跑起来什么东西

```
┌─────────────┐   HTTP(127.0.0.1:13100)   ┌──────────────────┐   WebSocket(:8000/ws)   ┌─────────────┐
│  娅娅桌宠    │ ────────────────────────> │  适配层（本方案）  │ ──────────────────────> │  MaiBot 麦麦 │
│ Electron    │ <──────────────────────── │ deskpet_adapter  │ <────────────────────── │ 人格+记忆    │
└─────────────┘   5 个接口（固定协议）      └──────────────────┘   出站消息推送            └─────────────┘
```

- **MaiBot**：她的"大脑"——人格、记忆、决定说什么/不说什么。
- **适配层**：一个 Python 小程序（本仓库 `adapter-skeleton/` 已备好），把桌宠固定的 5 个接口翻译成 MaiBot 听得懂的私聊消息。
- **桌宠**：不改任何东西，只填一份 `config.local.json`。
- QQ **不是必需品**：可以只跑 MaiBot + 桌宠，不接 QQ；想让她同时在 QQ 群里聊，再按第 7 步选装。

为什么不直接让桌宠连 MaiBot：桌宠协议是固定的（不改桌宠），而 MaiBot 的对话入口是 WebSocket 消息协议，两者语言不通——适配层就是翻译官。

---

## 1. 准备东西（一次性）

| 需要 | 说明 |
|---|---|
| Windows 10 及以上电脑 | 至少 2GB 可用内存（官方要求） |
| 一个大模型 API Key | 任意 OpenAI 兼容服务（如 DeepSeek、通义、硅基流动等）。没有的话先去申请一个 |
| 约 1GB 磁盘空间 | MaiBot 程序 + 数据 |

---

## 2. 第一步：安装 MaiBot

### 方式 A：一键包（推荐，点鼠标就行）

1. 打开 https://github.com/Mai-with-u/MaiBotOneKey/releases （最新 **0.7.3**，2026-10-21 发布）
2. 下载 `MaiBot-OK-0.7.3-win.exe`（约 236MB），双击安装、按启动器界面启动 MaiBot。
3. 启动器会自动管好 Python 环境和依赖，你只需要点启动。

### 方式 B：命令行源码部署（一键包出问题时用）

> 以下命令在 **PowerShell** 里逐条执行（来源：官方部署教程 docs.mai-mai.org/manual/deployment/windows）。

```powershell
# 1) 装 uv（Python 包管理器）
powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
# 装完如果提示 uv 不是命令：关掉 PowerShell 重新打开一次

# 2) 下载 MaiBot（放到 D 盘为例）
cd D:\
git clone https://github.com/Mai-with-u/MaiBot.git
cd D:\MaiBot

# 3) 装依赖（需要 Python 3.12+，uv 会自动搞定）
uv sync

# 4) 启动
uv run bot.py
```

首次启动会在终端问你用户协议，**输入「同意」回车**。

### 启动成功的标志

终端出现类似这样的日志：

```
[WebUI] WebUI 配置已保存到: /MaiMBot/data/webui.json
[WebUI应用] 🔑 WebUI 登录 Token: QSwgc2Vu...
```

---

## 3. 第二步：浏览器里完成基础配置（WebUI）

1. 浏览器打开 **http://localhost:8001**
2. 登录密码 = 终端日志里那串 `WebUI 登录 Token`（复制粘贴；也能在 `data/webui.json` 里查到）
3. 跟着**配置向导**：填你的模型服务商地址（如 `https://api.deepseek.com/v1`）和 API Key，选模型。走完向导后点"完成配置"。
4. 顺手把登录 Token 换成你自己好记的：WebUI 里点 **修改 Token**（官方首次配置流程推荐这么做）。

**检查点**：WebUI 能登录、模型连通性测试通过。

---

## 4. 第三步：把"娅娅人设"喂给她（人格 + 名字）

MaiBot 的所有人设都在一个文件里：MaiBot 目录下的 **`config/bot_config.toml`**（首次启动后自动生成）。用记事本打开，找到 `[bot]` 和 `[personality]` 两段，改成：

```toml
[bot]
nickname = "娅娅"                # 她的自称/显示名
alias_names = ["娅娅酱"]         # 别人可能叫她的名字（没有就留 []）

[personality]
# 她是谁——官方建议 1~2 句，太长反而稀释效果；把你原来的人设浓缩进来
personality = "娅娅，一个住在主人电脑桌面的女孩，说话像真实的人一样自然、带点小情绪，会撒娇也会闹别扭。"
# 行动准则——什么时候开口什么时候安静
behavior_style = "主人跟她说话时认真回应；没有话头时安静待着，不会硬找话题，不刷屏。"
# 说话风格——气泡很短，口语化，适合朗读
reply_style = "口语化短句，像微信聊天，不用书面语，不用列表和标题。偶尔用语气词。一次通常只说一两句。"
multiple_reply_style = []
multiple_probability = 0
```

再找到 `[chat.reply_timing]` 段（决定她多积极回话）：

```toml
[chat.reply_timing]
talk_value = 1.0            # 群聊频率（不接 QQ 就无所谓）
private_talk_value = 1.0    # 私聊频率：1.0 = 主人说话基本都会接；调低（如 0.5）她会偶尔装没听见
inevitable_at_reply = true
mentioned_bot_reply = false
```

> 改完**重启 MaiBot** 生效。想让她"记性更好"，再打开长期记忆：`[A_Memorix]` 段 `enabled = true`
> （需在 WebUI 里配好嵌入模型，详见官方文档 docs.mai-mai.org/manual/configuration/amemorix-config）。
> 短期"聊天回想"默认已开（`mid_term_memory = true`）。

---

## 5. 第四步：确认 MaiBot 的"耳朵"开着（默认就是开的）

适配层要通过 MaiBot 内置的 WebSocket 消息服务说话。这个服务**默认开启**，在 `config/bot_config.toml` 里长这样（不用改，确认一下即可）：

```toml
[maim_message]
ws_server_host = "127.0.0.1"
ws_server_port = 8000
auth_token = []               # 留空数组 = 本机不验证（默认）
```

> 官方协议文档：这个 `/ws` 端点是"经典消息服务器"，现有适配器几乎都走这条。

---

## 6. 第五步：安装并启动适配层

1. 把整个文件夹 `adapter-skeleton\` 复制到一个你记得住的地方（下面假设放在 `D:\denia-bot\adapter-skeleton`）。
2. 打开 PowerShell，执行：

```powershell
cd D:\denia-bot\adapter-skeleton

# 建独立环境并安装依赖（maim_message 版本与 MaiBot 主程序钉死版本一致）
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
```

3. 用记事本打开 **`config.toml`**，改两处：

```toml
[server]
console_token = "改成一串只有你知道的密钥"   # 例如 "yaya-2026-secret"，要与桌宠那边一致

[owner]
user_id = "10001"            # 改成你要在桌宠 config.local.json 里填的 ownerQQ（保持两边一致）
user_nickname = "主人"
```

4. 启动适配层（以后每次用桌宠前都要先启动它；也可以直接双击 **`启动适配器.bat`**）：

```powershell
.venv\Scripts\python deskpet_adapter.py
```

**检查点**：出现 `桌宠接口已监听 http://127.0.0.1:13100`。
（想先体检一下代码，可跑 `.venv\Scripts\python deskpet_adapter.py --selftest`，2026-10-25 实测 15/15 通过。）

---

## 7. 第六步：配置桌宠（只改一个文件）

打开桌宠目录下的 **`config.local.json`**（没有就把 `config.example.json` 复制一份改名），**联机模式**只需这几行：

```json
{
  "consoleToken": "改成一串只有你知道的密钥",
  "tunnelLocalPort": 13100,
  "bridgePort": 3100,
  "ownerQQ": "10001",
  "sshHost": ""
}
```

逐行解释（都对照过桌宠源码 `electron/main.cjs:28-33`）：

| 键 | 填什么 | 为什么 |
|---|---|---|
| `consoleToken` | 与适配层 `config.toml` 的 `console_token` **完全一致** | 桌宠每个请求都带 `x-console-token` 头，适配层靠它认人 |
| `tunnelLocalPort` | `13100` | 桌宠永远只打 `http://127.0.0.1:这个端口`。适配层默认就监听 13100，两边对上即可 |
| `bridgePort` | `3100` 保持不动 | 只有走 SSH 隧道连**远程**后端时才用到 |
| `ownerQQ` | 与适配层 `owner.user_id` 一致（随便一个字符串也行） | 拼成会话 key `private:<ownerQQ>`，当作"同一个主人"的固定私聊 |
| `sshHost` | 同机直连时**填什么都不影响** | ⚠️ 注意：桌宠代码是 `String(sshHost \|\| 'pc')`，留空会回落成 `'pc'` 并不是"直连"；但只要适配层在 13100 正常监听、探活成功，桌宠**根本不会去拉 SSH 隧道**，所以同机场景这个字段随便填。只有后端在远程机器时才需要真正配 SSH 免密 |

改完**重启桌宠**。

### （选装）让她同时活跃在 QQ 群

MaiBot 的 QQ 接入现已收编为"统一 QQ 连接器"插件（装在 `plugins/MaiBot-SnowLuma-Adapter`，同时支持 NapCat / SnowLuma 客户端；老的独立 NapCat 适配器 2026-08 已归档）。大致步骤：装 NapCat 并登录机器人 QQ → 在 WebUI 适配器设置里填 NapCat 的正向 WS 地址（默认 `127.0.0.1:3001`）→ `bot_config.toml` 的 `[bot]` 里 `qq_account` 填机器人 QQ 号。详见官方文档 https://docs.mai-mai.org/manual/adapters/qq-local-client 。桌宠接入不依赖这一步。

---

## 8. 第七步：验收链路

按顺序做，哪一步不过就照第 10 节排查。

**① 适配层活着**（PowerShell）：

```powershell
Invoke-RestMethod http://127.0.0.1:13100/api/status
```
→ 返回一段 JSON（`ok: True`）即探活通过。

**② 假装桌宠说一句话**（把密钥换成你自己的）：

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:13100/api/socialV2/pet-chat `
  -Headers @{"x-console-token"="你的密钥"} -ContentType "application/json" `
  -Body '{"key":"private:10001","text":"在干嘛"}'
```
→ 几秒内返回，`reply` 里有娅娅的话（`reply` 为空串也算正常——她选择沉默）。
MaiBot 终端此时应打出 `platform=deskpet` 的入站日志。

**③ 桌宠实测**：启动桌宠 → 右键「跟她说句话…」→ 输入框发一句。
**一句话验收（官方标准）**：5 秒内出现她的气泡。

**④ 主动冒泡**：让她有理由主动说话后（或等她自己开口），桌宠应在 4 秒内冒泡念出来。
（说明：MaiBot 在桌宠这个自定义平台上"自发主动开口"的程度没有官方承诺，`/recent` 长期为空不算故障——桌宠契约允许空。想做实"主动说话"见第 9 节备选方案。）

---

## 9. 语音与进阶（可选）

### 她要"有声音"，二选一（不做的话她只有气泡没声音）

桌宠**联机模式没有系统 TTS 兜底**（官方代码实测文档明确警告）。两条出路：

1. **给适配层接 TTS**（推荐给愿意折腾的）：把 `adapter-skeleton/deskpet_adapter.py` 里 `h_voice_preview` 的 TODO 实现——调一个 TTS 服务（GPT-SoVITS / fish / edge-tts 等），把音频写到适配层机器的**绝对路径**，返回 `{"ok":true,"file":"D:/.../xxx.mp3"}`。桌宠会用 `scp` 把文件拉回本机播放（远程部署时需配 SSH 免密；同机部署时桌宠的 scp 也要能走通，见 TODO 说明）。
2. **改桌宠 10 行**（最省事）：把 `electron/main.cjs` 里 `petVoiceViaBridge` 的失败分支接到现成的 `synthSapi()`（Windows 自带中文女声）。这需要动桌宠代码，产品化前先问维护者。

### 备选接法：把适配层做成 MaiBot 插件

`adapter-skeleton/plugin-variant/` 里有一份**插件版**骨架：拷进 MaiBot 的 `plugins/` 文件夹重启即生效（零额外进程），并且能用 MaiBot 的主动任务接口 `ctx.maisaka.proactive.trigger()` 做"看屏幕时主动搭话"。代价：插件代码未经真机验证、且插件崩溃会连坐同进程的其它第三方插件。**建议先用外挂版把链路跑通，再考虑迁移。**细节见 `plugin-variant/README.md`。

---

## 10. 出问题先看这里

| 症状 | 先查什么 |
|---|---|
| 桌宠显示"连不上她" | 适配层是否在跑？`Invoke-RestMethod http://127.0.0.1:13100/api/status` 通不通；`config.local.json` 的 `tunnelLocalPort` 是否 13100 |
| 探活通、说话报"token 不对" | 桌宠 `consoleToken` 与适配层 `console_token` 是否一字不差 |
| 说话报"连不上 MaiBot" | MaiBot 是否在跑；`config/bot_config.toml` 的 `[maim_message] ws_server_port` 是否 8000（与适配层 `config.toml` 一致）；`auth_token` 配了的话适配层也要填 |
| 注入成功但她不回 | 看 MaiBot 终端/WebUI 日志：模型 Key 是否有效、是否报模型错误；`private_talk_value` 是否被调得太低；空 `reply` 本身是合法行为（她选择沉默） |
| 每次说的驴唇不对马嘴 | 人设被稀释了：`[personality]` 每段控制在 1~2 句；确认改的是 `config/bot_config.toml` 且重启过 |
| 适配层日志刷 `MaiBot 连接异常` | MaiBot 没启动，或 8000 端口被占用（改 `[maim_message] ws_server_port` 并同步改适配层） |
| 桌宠有气泡没声音 | 正常（voice-preview 未实现）；按第 9 节二选一 |
| 想看适配层都收发了什么 | 适配层窗口日志实时打印（`MaiBot -> 桌宠: ...`）；不够就把日志级别调 DEBUG |

## 11. 日常开机顺序

1. 启动 MaiBot（OneKey / `uv run bot.py`）→ 终端出现 WebUI 日志
2. 启动适配层（`启动适配器.bat`）→ 出现"桌宠接口已监听"
3. 启动桌宠

关闭顺序随意；适配层重启不会丢 MaiBot 侧的记忆（记忆在 MaiBot 的数据库里）。

## 12. 已知限制（诚实清单）

1. **同步等待是"等"出来的**：MaiBot 回复是异步的，适配层用"水位线+静默窗口"聚合她 80 秒内的回复再返回；极端情况（模型很慢）桌宠会显示超时，多问一次即可。
2. **主动说话不保证**：见第 8 节 ④；要确定性主动行为用插件版 + `maisaka.proactive.trigger`。
3. **单主人设计**：适配层把所有会话都路由给 `[owner].user_id` 这一个人（桌宠本来也只传一个固定 key，够用）。
4. **看屏幕是摆设**：桌宠不传截图、MaiBot 侧也没有"看屏幕"挂点；`screen-permission` 目前只记录开关。真要看屏幕需要额外开发（截屏 → 塞给视觉模型 → 注入聊天流）。
5. **本骨架未经 MaiBot 真机联调**：HTTP 契约层已 15/15 自测通过；`maim_message` 与 MaiBot 的真实握手、出站时序要按第 8 节在真机验收。插件版完全未实测。
6. **许可**：MaiBot 为 GPL-3.0（自用无影响；若整体分发需注意其许可条款）。
