# 接入预设 · DSH bot（联机模式，标准预设）

> 这是「把娅娅接到你自己后端（DSH bot）」的**标准预设**。DSH bot 指部署在你自己主机/服务器上、
> 能按 [`桌宠对接接口文档.md`](桌宠对接接口文档.md) 提供 5 个 HTTP 接口的"大脑"服务。
> 娅娅原生就是为这种架构设计的——这是三种接入预设里**功能最全**的一种（主动搭话、
> 看屏幕许可、远端语音合成都支持）。
>
> 其他两种预设：[接入预设-AstrBot.md](接入预设-AstrBot.md) · [接入预设-MaiBot.md](接入预设-MaiBot.md)

---

## 一、你的 bot 需要提供什么

一张表说清（完整字段与行为契约见 [`桌宠对接接口文档.md`](桌宠对接接口文档.md)，本文只做速查）：

| 接口 | 必需 | 干什么 | 关键约束 |
|---|:--:|---|---|
| `GET /api/status` | ✅ | 探活 | 200 即可 |
| `POST /api/socialV2/pet-chat` | ✅ | 对话核心 | 同步阻塞，**90 秒内必须返回**（没话说也返回 `"reply": ""`）；`recent` 字段恒 `[]` |
| `GET /api/socialV2/recent` | 建议 | 她主动找你 | `ts` 用毫秒且严格递增；`self:true` 才会被念 |
| `POST /api/socialV2/screen-permission` | 可选 | 陪看开关 | 不实现 = 她看不到屏幕，其余不受影响 |
| `POST /api/socialV2/voice-preview` | 可选 | 远端 TTS | 返回 JSON 里 `file` 是**后端机器上的绝对路径**，桌宠会 `scp` 拉回来播放 |

**最容易踩的三个坑**（都来自接口文档的"血泪更正"）：
1. `pet-chat` 响应里的 `recent` **必须恒为空数组**——出现任何条目都会推高桌宠的水位线，把没念过的主动消息永久吞掉（无报错）。
2. 本轮 `reply` 不要再写进消息表——会被念两遍。
3. `voice-preview` 返回的是路径不是音频二进制；且要求 `sshHost` **免密登录**（桌宠用 `BatchMode=yes` 的 scp 拉文件，没配免密秒退）。

---

## 二、桌宠侧配置（config.local.json）

在桌宠目录复制 `config.example.json` 为 `config.local.json`，按场景二选一：

### 场景 A · bot 在远程主机上（走 SSH 隧道，默认形态）

```json
{
  "tunnelLocalPort": 13100,
  "bridgePort": 3100,
  "ownerQQ": "你的QQ号（bot 与你私聊用的那个号的意义）",
  "sshHost": "myserver",
  "consoleToken": "一段你自定的密钥，两边一致"
}
```

- 桌宠会自动执行：
  `ssh -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=20 -N -L 13100:127.0.0.1:3100 myserver`
  然后打 `http://127.0.0.1:13100`。
- **前提**：本机能 `ssh myserver` 免密登录（`~/.ssh/config` 里配好别名和密钥）。
- bot 侧只需监听 `127.0.0.1:3100`（不用对公网开端口，安全）。

### 场景 B · bot 与桌宠同机（或局域网直连）

```json
{
  "bridgePort": 3100,
  "ownerQQ": "你的用户名",
  "sshHost": "",
  "consoleToken": "同上"
}
```

`sshHost` 留空 = 不拉隧道，直接连 `127.0.0.1:3100`。局域网机器请自行把 `bridgePort`
对应的地址写进配置（当前实现默认连本机；跨机直连最省事的做法仍是在 bot 机器上跑、
桌宠机器上配 `sshHost` 指过去）。

> 鉴权：所有请求带请求头 `x-console-token: <consoleToken>`——bot 侧校验它，别用空值。

---

## 三、后端（DSH bot 侧）实现清单

按顺序打勾即可：

- [ ] HTTP 服务监听 `127.0.0.1:3100`（或你 `bridgePort` 指定的端口）
- [ ] 校验 `x-console-token`
- [ ] `GET /api/status` → 200
- [ ] `POST /api/socialV2/pet-chat`：
  - 入参 `{key, text, image?, timeoutMs?}`；`key` 形如 `private:123456`，**用它做会话记忆的主键**
  - 调你的模型（人设注入、上下文按 `key` 维护都在你这边）
  - 90s 内返回 `{ok:true, reply:"…", recent:[], waitedMs, impl:"你的版本号"}`
- [ ] （建议）`GET /api/socialV2/recent`：返回 `{ok:true, messages:[{ts, self:true, text}]}`
  ——只有"她主动发起"的消息进这个表；`ts` 毫秒、严格递增
- [ ] （可选）`POST /api/socialV2/screen-permission`：收 `{watch, minutes, mode}` 当开关
- [ ] （可选）`POST /api/socialV2/voice-preview`：合成音频存到 bot 机器磁盘，返回
  `{ok:true, file:"/绝对路径/xxx.mp3", ms, kb, label}`

**实现模式**（接口文档"附"一节的摘要）：
- **直接话术型**：收到 pet-chat → 调模型 → 输出放 `reply`。简单，先做这个。
- **主动话术型**：模型靠"发消息"工具说话 → 后端记时间戳水位线 → 投递后轮询自己的
  消息表捞 `isSelf && time>水位线` → `join("\n")` 放 `reply`。适合你的 bot 已经有一套
  消息管线的情形（**水位线必须用时间戳，不能数条数**——环形缓冲会挤掉旧消息）。

---

## 四、验收（按顺序）

1. **探活**：桌宠启动后气泡不再提示"连不上她"（托盘右键 → 看看屏幕 等功能可用）。
   不通时先手动验证：`ssh myserver "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3100/api/status"` 应为 200。
2. **对话**：桌宠输入框发一句"在吗"——90 秒内出气泡（+语音如果实现了 5 号接口）。
3. **主动搭话**（实现了 3 号接口）：在 bot 侧往消息表插一条 `self:true` 的消息，
   桌宠 4 秒内应该把它念出来。
4. **退出不留垃圾**：退出桌宠，`tasklist | findstr ssh` 不应残留隧道进程
   （v1.0-2026-10-25 起桌宠退出会自己杀掉隧道）。

---

## 五、常见问题

| 现象 | 多半是 |
|---|---|
| 启动后一直"连不上她" | `ssh <sshHost>` 没配免密；或 bot 没监听 127.0.0.1:3100；或 `consoleToken` 不一致（401/403） |
| 说话没气泡 | pet-chat 超过 90s 才返回；或返回了 `ok:false` |
| 她的话被念两遍 | 本轮 `reply` 又写进了 recent 消息表（见上文坑 2） |
| 主动消息永远不出现 | pet-chat 响应里 `recent` 不为空数组，推高了水位线（见上文坑 1） |
| 有气泡没声音 | 没实现 voice-preview，或 `file` 不是绝对路径，或 scp 免密没配 |
| 屏幕相关没反应 | 正常——桌宠不在请求里传截图，后端要么自己截要么忽略（接口 4） |

---

## 六、与另两种预设的关系

- **AstrBot / MaiBot**：你不想自己写后端时的开箱选择——用现成 bot 框架 + 官方插件/适配层
  提供同样的 5 个接口，桌宠侧配置完全一样（见对应预设文档）。
- **DSH bot（本预设）**：能力上限最高——主动话术、远端语音、屏幕许可都是为它设计的；
  代价是 5 个接口要自己实现或已有实现。
