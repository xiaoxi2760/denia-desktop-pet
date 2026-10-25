# 娅娅桌宠 ↔ MaiBot 适配层骨架

> 生成：2026-10-25。契约依据：`娅娅桌宠-v1.0-内存优化版/docs/接口总览.md`（代码实测版）。
> 调研结论见上级目录 `调研笔记.md`；分步装机指南见 `../预设方案.md`。

## 目录内容

```
adapter-skeleton/
├── deskpet_adapter.py    主推方案：外挂适配进程（5 个 HTTP 接口 → maim_message WS → MaiBot）
├── config.toml           适配层配置（端口 / token / 主人 / MaiBot 地址）
├── requirements.txt      maim_message==0.6.8（与 MaiBot 主程序钉死版本一致）
├── 启动适配器.bat         Windows 一键启动
└── plugin-variant/       备选方案：MaiBot 插件变体（拷进 plugins/ 即可，未实测）
    ├── _manifest.json
    ├── plugin.py
    └── README.md
```

## 已验证 / 未验证（如实声明）

| 项 | 状态 | 证据 |
|---|---|---|
| 语法编译 | ✅ 已跑 | `python -m py_compile deskpet_adapter.py` / `plugin-variant/plugin.py` 均通过 |
| 5 接口 HTTP 契约 | ✅ 已跑 | `python deskpet_adapter.py --selftest`，15/15 PASS（真实 aiohttp 服务 + 真实 HTTP 请求：探活 200、空 text 400、token 401、两条出站聚合为 `reply`、`recent` 恒 `[]`、主动消息进 `/recent` 且 ts 毫秒严格递增、drain 语义） |
| MessageClient API | ✅ 已跑 | 本机安装 `maim_message==0.6.8` 后 `inspect.signature` 实测：`connect(url, platform, token=None, ssl_verify=None)`、`send_message(dict)->bool`、`register_message_handler` 存在 |
| 注入格式 | ✅ 逻辑自测 | 私聊格式（无 group_info + `platform_io_target_user_id`）与官方示例 `adapter-minimal.py` 逐字段一致 |
| 与真实 MaiBot 联调 | ❌ 未跑 | 本机无 MaiBot 环境（需 LLM Key）；按 `../预设方案.md` 第 6 步在真机验收 |
| 插件变体 | ❌ 未跑 | 按官方文档 API 编写（`maibot_sdk` 未安装实测），装机后先看本目录 plugin-variant/README.md |

## 快速开始（主推：外挂进程版）

前置：装好 MaiBot 并至少完成模型配置（见 `../预设方案.md` 第 1–3 步）。

```bat
cd /d D:\denia\research\bot-presets-2026-10-25\maibot\adapter-skeleton
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
:: 改 config.toml：console_token 与桌宠一致、owner.user_id 填桌宠 ownerQQ
.venv\Scripts\python deskpet_adapter.py
```

看到 `桌宠接口已监听 http://127.0.0.1:13100` 即就绪。之后按 `../预设方案.md` 第 6 步验收。

也可以不建 venv 直接 `pip install -r requirements.txt && python deskpet_adapter.py`。

## 自测

```bat
python deskpet_adapter.py --selftest
```

自测不连接 MaiBot、不需要 `maim_message`（用 FakeClient 模拟出站），验证全部 HTTP 契约与
回复聚合逻辑。2026-10-25 本机实测 15/15 PASS（Python 3.12.10，aiohttp 3.14.5）。

## TODO 清单（代码内已标注位置）

| # | 事项 | 位置 | 说明 |
|---|---|---|---|
| 1 | **voice-preview 未接 TTS** | `h_voice_preview` | 契约：返回 JSON `{ok, file 后端机绝对路径}`，桌宠会 `scp` 拉取后播放（接口总览.md §5.5）。可接 GPT-SoVITS/fish/edge-tts，落盘后返回绝对路径。⚠️ 联机模式没有系统 TTS 兜底——不实现她就永远没声音。出路②：改桌宠 `electron/main.cjs` 的 `petVoiceViaBridge` 失败分支接现成 `synthSapi()`（约 10 行），最省事拿到 Windows 中文女声 |
| 2 | screen-permission 只是记录 | `h_screen_permission` | 桌宠只发 `watch:true`、从不发 `watch:false`（停看靠聊天文本「别看了」，接口总览.md D4）；"把截屏喂给模型"在 MaiBot 侧无现成挂点。可注入一条文本（如「（在陪你看屏幕）」）让她自然接话 |
| 3 | 主动说话可能为空 | `on_outbound` | 依赖 MaiBot 在 deskpet 平台上的自发行为（文档未承诺）；插件变体可用 `ctx.maisaka.proactive.trigger()` 主动触发（api-reference.md）。空 `/recent` 完全符合桌宠契约 |
| 4 | 出站非文本分段被丢弃 | `extract_text` | image/at/emoji 段目前跳过；at 可考虑转成 `@昵称` 文本 |
| 5 | 单主人设计 | `on_outbound` | 所有 key 一律路由给 `[owner].user_id`；桌宠本来就固定传 `private:<ownerQQ>`，够用 |
| 6 | MaiBot 掉线期间的请求 | `h_pet_chat` | 连不上时返回 502 `连不上 MaiBot`，桌宠会显示错误气泡；可考虑加请求排队 |
| 7 | `dshReady` 字段语义未知 | `h_status` | 接口总览.md §5.1 说 bridgeStatus 会读 `{mode, role, dshReady}` 透传渲染层，但没说取值含义；当前填 `false`，如桌宠界面出现异常提示再调 |
| 8 | 真·End-to-End 验收 | — | 见 `../预设方案.md` 第 6 步（curl 三连 + 桌宠实测 + 主动冒泡测试） |

## 插件变体（plugin-variant/）什么时候用

- 想要"零额外进程"部署（拷进 `plugins/` 重启 MaiBot 即自动加载）；
- 想要真正的主动说话（`ctx.maisaka.proactive.trigger()`）与聊天流操作（`ctx.chat`）。

风险（选型前必读，详见 `调研笔记.md` §7.5）：
- 第三方插件共用一个 Runner 子进程，插件崩溃会连坐其它第三方插件（含 QQ 连接器）；
- 本骨架按文档 API 编写、未经真机验证；manifest 的 `capabilities` 按 api-reference.md
  列了 `send.text / chat.open_session / message.get_recent / maisaka.proactive / maisaka.context`，
  网关本身未在文档中列出独立能力名，如启动报"未获授权能力"按提示补名字。
