# 娅娅桌宠 × AstrBot 接入指南（预设方案）

> 面向「会用电脑但没读过代码」的用户。插件骨架在本仓库 **presets/astrbot/plugin-skeleton/**（下文说的「把插件放进 data/plugins」就是复制它）；调研依据与 AstrBot 源码 file:line 核对清单见 **presets/astrbot/调研笔记.md**。
>
> 其他两种预设：[接入预设-DSH-bot.md](接入预设-DSH-bot.md) · [接入预设-MaiBot.md](接入预设-MaiBot.md)

给"会用电脑、没读过代码"的你。照着一步步复制粘贴，就能让桌宠里的她说上话。

> 本方案配套的插件代码在同级目录 `plugin-skeleton/`。技术细节与出处（版本号、API 来源、已验证/未验证项）全部在 `调研笔记.md`，这里只讲操作。

---

## 0. 原理：谁在跟谁说话

```
┌────────────┐  HTTP(本机 3100 端口)  ┌──────────────────────────────┐
│  娅娅桌宠   │ ─────────────────────→ │  AstrBot                     │
│ (Electron) │ ←───────────────────── │  └─ 桥接插件(本方案)          │
└────────────┘   5 个固定接口           │      └─ 你配的大模型(LLM)     │
                                        └──────────────────────────────┘
```

- 桌宠会**轮询/请求**这 5 个接口：探活、说话、她主动说的话、看屏幕许可、语音。
- 这 5 个接口由我们放进 AstrBot 的**桥接插件**提供（插件会在 AstrBot 里开一个 3100 端口的小服务）。
- "她"的回复由 **AstrBot 里配置的大模型**生成，她的性格由插件配置里的"人设"一段话决定。
- 两边要约定**同一个口令**（`consoleToken`），防止别人乱连。

预计耗时：网络通畅约 20–40 分钟。需要一个任意大模型服务的 API Key（下文用 DeepSeek 举例，注册就送额度）。

---

## 1. 安装 AstrBot（Windows）

**1.1** 按 `Win` 键，输入 `PowerShell`，回车打开蓝色窗口。

**1.2** 选一个固定住的工作目录（以后 AstrBot 的所有数据都在它下面），并安装：

```powershell
mkdir C:\astrbot; cd C:\astrbot
irm https://docs.astrbot.app/install.ps1 | iex
```

> 脚本会自动装好 uv、AstrBot 和 Python 3.12（官方安装脚本说明）。装完按提示**关掉 PowerShell 重开**（让命令生效），然后：

```powershell
cd C:\astrbot
astrbot init
astrbot run
```

**1.3** 看到 `🌈 管理面板已启动` 的日志后，浏览器打开 **http://127.0.0.1:6185** 。
- 用户名默认 `astrbot`；**初始密码在 `astrbot run` 的启动日志里**（往上翻日志找 `password` 字样）。登录后请改密码。
- 这个 PowerShell 窗口要一直开着（AstrBot 就跑在里面）。最小化别关。

> 说明：`astrbot init` 会在"你当时所在的目录"初始化数据（本文即 `C:\astrbot\data\`），以后重开都要 `cd C:\astrbot` 再 `astrbot run`。

---

## 2. 给她配一个"大脑"（大模型）

没有这步，她只能沉默。

**2.1** 拿一个 OpenAI 兼容的大模型 API Key。官方文档推荐新手用 DeepSeek（注册送额度、价格低、接口与 OpenAI 兼容）：去 [deepseek.com](https://deepseek.com) 注册 → `API Keys` 页 → 创建并复制 Key。

**2.2** 回到 AstrBot 网页管理面板 → 找到 **服务提供商 / 模型服务** 页（不同版本菜单名略有差异）→ **新增提供商** → 类型选 **OpenAI 兼容**，照官方文档的示例填：

| 配置项 | 填什么 |
|---|---|
| API Key | 你刚复制的 DeepSeek Key |
| API Base（节点地址） | `https://api.deepseek.com` |
| 模型名 | `deepseek-chat` |

保存。**记下这个提供商的名字/ID**（后面第 4 步的 `provider_id` 可以填它；不填则用默认，一般留空即可）。

**2.3** 自测一下：面板里通常有 WebChat/对话测试入口，随便发一句话，她能回，就说明"大脑"通了。

---

## 3. 安装桥接插件

**3.1** 把本方案目录里的 `plugin-skeleton` 文件夹，整个复制成 AstrBot 的插件（注意文件夹名必须一字不差）：

```powershell
Copy-Item -Recurse "D:\denia\research\bot-presets-2026-10-25\astrbot\plugin-skeleton" "C:\astrbot\data\plugins\astrbot_plugin_pet_bridge"
```

复制完后 `C:\astrbot\data\plugins\astrbot_plugin_pet_bridge\` 里应有三个文件：`main.py`、`metadata.yaml`、`_conf_schema.json`。

**3.2** 回到管理面板 → **插件** 页 → 找到 **娅娅桌宠桥接** 卡片（如果没出现，点页面上的刷新）。出现即安装成功。

**3.3** 点插件卡片上的 **配置**（或齿轮图标），按第 4 步填写；填完记得点卡片上的 **重载插件**（刷新图标）让配置生效。

> 不用装 QQ/微信等任何消息平台适配器——桥接插件不依赖它们。

---

## 4. 配置插件（4 个空）

| 配置项 | 填什么 | 说明 |
|---|---|---|
| `console_token`（桥接口令，必填） | 一串只有你知道的随机字符 | 下面 4.1 教你生成。**第 5 步桌宠那边要填一模一样的** |
| `host` | `127.0.0.1` | 桌宠和 AstrBot 在同一台电脑就别改 |
| `port` | `3100` | 和桌宠配置里的 `bridgePort` 一致，别改 |
| `persona`（她的人设） | 例如：`你是娅娅，主人的桌宠。说话简短、俏皮、带点傲娇，一般不超过两句话。` | 每次回话都会注入给大模型，写她的性格 |
| `provider_id`（可留空） | 第 2.3 步记下的提供商 ID | 留空 = 用 AstrBot 当前默认模型 |

其余两项（`history_limit` 记忆条数、`request_timeout_ms` 回话时限）保持默认即可。

**4.1 生成口令**：在 PowerShell 里运行两次下面命令（一次给插件、一次给桌宠配置，或生成一次复制到两边）：

```powershell
-join ((48..57)+(97..122) | Get-Random -Count 32 | ForEach-Object {[char]$_})
```

会输出类似 `k3n9x2qp8lz1mq4v7bwo6rc5dtuyea0h` 的字符串。

**4.2 保存后重载插件**。日志（面板"日志"页）出现这一行即成功：

```
[pet_bridge] 桌宠桥接已启动: http://127.0.0.1:3100 （等待桌宠探活）
```

---

## 5. 配置桌宠这边

找到桌宠目录下的 **`config.local.json`**（没有就新建），整个文件替换成：

```json
{
  "tunnelLocalPort": 13100,
  "bridgePort": 3100,
  "ownerQQ": "123456",
  "sshHost": "",
  "consoleToken": "k3n9x2qp8lz1mq4v7bwo6rc5dtuyea0h"
}
```

- `ownerQQ`：随便一个固定字符串（它是"她记你是谁"的记忆钥匙），习惯上填你的 QQ 号。
- `sshHost`：**本机直连，留空 `""`**（只有 AstrBot 部署在远程服务器时才填）。
  实现细节：留空时桌宠内部会回落成 `"pc"`，但只要插件在 13100 正常应答探活，
  桌宠根本不会去拉 SSH 隧道——同机场景这个字段填什么都无影响。
- `bridgePort`、`consoleToken`：必须与第 4 步插件配置**完全一致**。
- 改完保存，重启桌宠。

---

## 6. 验收（从命令到气泡的完整链路）

### 6.1 命令探活（先确认服务活着）

```powershell
Invoke-RestMethod http://127.0.0.1:3100/api/status
```

应返回 `ok : True`。

### 6.2 命令替你说一句话（核心接口验收）

把下面的 `k3n9...` 换成你的口令，整段运行：

```powershell
Invoke-RestMethod -Uri http://127.0.0.1:3100/api/socialV2/pet-chat -Method Post `
  -ContentType "application/json; charset=utf-8" `
  -Headers @{ "x-console-token" = "k3n9x2qp8lz1mq4v7bwo6rc5dtuyea0h" } `
  -Body ([System.Text.Encoding]::UTF8.GetBytes('{"key":"private:123456","text":"在干嘛"}'))
```

应返回 `reply : 她的一句话`（内容来自你配的大模型 + 人设）。返回 `reply : ""` 也是**正常**的——那是"她选择沉默"。
如果返回 `error : 未配置任何 LLM 提供商...` → 回第 2 步；`x-console-token 不匹配` → 两边口令没对上。

### 6.3 真验收：桌宠里跟她说话

启动桌宠 → 进入联机模式（它会自动探活 `http://127.0.0.1:13100→3100`）→ 输入框发一句 `在干嘛`。
**通过的标志：约 5 秒内出现她的气泡**（接口文档的"一句话验收"标准）。这就通了，剩下的都是加分项。

### 6.4 排错速查

| 症状 | 多半是 | 处理 |
|---|---|---|
| 6.1 探活失败（连不上） | AstrBot 没在跑 / 插件没重载 / 端口被占 | 重跑 `astrbot run`；插件卡片点重载；`port` 被占就换一个（插件和桌宠两边一起改） |
| 面板插件页找不到/加载失败 | 文件夹名不对（必须 `astrbot_plugin_pet_bridge`）、不是三个文件齐全 | 对照 3.1 重来；面板"加载失败插件"里点重载看报错 |
| pet-chat 返回 `未配置任何 LLM 提供商` | 第 2 步没做或没保存 | 去面板配好模型；或把 `provider_id` 填上再重载 |
| pet-chat 返回 401 | 两边口令不一致 | 第 4/5 步的 token 逐字核对（前后不能带空格） |
| 桌宠气泡报错信息 | 看桌宠气泡里显示的 `error` 文字 | 多为模型 Key 失效/余额不足，去第 2 步检查 |
| 她回话很慢甚至沉默 | 模型慢于 85 秒上限 | 换快一点的模型；或调低 `request_timeout_ms` 让她更快"放弃并沉默" |

---

## 7. 日常使用 & 当前边界（骨架 v1 的如实说明）

- **记忆**：她按 `ownerQQ` 记住最近 20 个来回，但**只在内存里**——重启 AstrBot 后从零开始。想要长期记忆需要扩展（调研笔记 §4.3 有路径）。
- **她不会主动找你**：`/api/socialV2/recent` 当前恒返回空数组（这正是协议要求的安全默认值）。想让她定时主动说话，需要扩展插件的"主动消息"队列（调研笔记 §3.3 的 `send_message`/`_push_recent` 通道已留好）。
- **她没有声音**：语音接口（`voice-preview`）当前是未实现的桩，桌宠只会显示气泡、不出声（联机模式不会回退到系统 TTS，这是桌宠侧行为）。接 GPT-SoVITS 之类的 TTS 后可补上。
- **看屏幕**：许可开关接口已实现（会记录"同意/停止"），但她**看不见**屏幕内容——桌宠当前也不传截图，属协议层现状。
- 改了插件配置 → 记得回面板**重载插件**；改了 `config.local.json` → 重启桌宠。

## 附：本方案交付了什么

| 文件 | 作用 |
|---|---|
| `调研笔记.md` | 所有技术结论 + 每条的来源链接/源码行号 + 已验证/未验证清单 |
| `plugin-skeleton/main.py` | 桥接插件代码（5 个接口；pet-chat 调 AstrBot 的 LLM） |
| `plugin-skeleton/metadata.yaml` | 插件元数据（AstrBot 靠它识别插件） |
| `plugin-skeleton/_conf_schema.json` | 插件配置表单的定义（第 4 步那 4 个空就是它生成的） |
