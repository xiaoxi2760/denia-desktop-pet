# 变更记录

## 2026-10-22 · 第二轮内存优化

- 提前跳过未使用的表情缓冲，减少模型加载时的内存峰值。
- 使用稀疏表情数据，保留现有贴图、眨眼、视线与口型。
- 本地语音识别服务默认闲置 5 分钟后释放，下次使用时重新加载。
- 修复连续录音排队不结束，以及语音服务重启时的进程竞态和探测超时。

详细设置、回退与验收范围见 `docs/第二轮内存优化.md`。

## 2026-10-15 · 立项基线

这是本仓库的第一个提交。在此之前的改动都已折进这个基线里，逐一列在下面，方便追溯。

### 修复 · 启动失败（根因排查）

**现象**：双击 `启动娅娅.cmd` 进程立刻消失，退出码 `-2147483645`（`0x80000003`）。

**根因**：不是桌宠代码问题，也不是 Electron 装坏了 —— 是 **DSH（DeepSeek Harness）
的工作区沙箱**。它给工作区整条目录链写入 `S-1-4-*` 能力 SID，
Electron 初始化 Chromium 进程沙箱时失败 → DCHECK → `__debugbreak()`。

**决定性证据**：同一份 `electron.exe`（SHA256 与官方原版逐字节一致）两个位置对照：

| 位置 | 能力 SID 数 | `electron.exe --version` |
|---|:--:|:--:|
| `D:\denia\娅娅桌宠-v1.0\...`（工作区外） | 0 | ✅ `v43.7.11`, exit 0 |
| `D:\zhuochong\denia\...`（工作区内） | 2 | 💥 exit `-2147483645` |

已排除：中文路径、项目代码、最小应用、Electron 安装损坏、5 种 GPU 参数、
单实例锁 ACL、Electron 版本回归（43.7.11 与 44.7.2 都崩）。

**处理**：文档化到 `docs/启动故障排查.md`，README 加警告。**不加 `--no-sandbox`** ——
那是安全降级且掩盖真因。`electron/main.cjs` 顶部留了注释防止以后有人再走这条弯路。

### 修复 · 语音队列永久卡死（P0）

`app/main.js` 的 `playHerVoice()`：以前**只有 `ended` 一条路**做收尾。兜底里用
`currentAudio.pause()` 掐掉旧音频，但 `pause()` 不触发 `ended`，于是：

- 旧音频的计数不减、`blobUrl` 不回收；
- 若旧音频被顶掉、而新音频 `play()` 又失败，`voicePlaying` 永久停在 `true`，
  `pumpSpeech` 的 `if (voicePlaying || …) return;` 把整个说话队列卡死 —— **她再也不出声**。

**处理**：抽成幂等的 `retire(advanceQueue)`，让 `ended` / 被顶掉 / `play()` 失败
/ 解码失败四条路都走同一个收尾。同时给旧音频挂上 `__retire` 供顶替调用。

### 修复 · `synthSapi` 超时不 settle（P0）

`electron/main.cjs` 的 `synthSapi()`：超时只 `p.kill()` 不 `reject`，
完全指望 `exit` 事件兜底 —— 事件不来则 Promise 永远挂着。
这个教训本文件在 `copyFromHost()` 里已经总结过一次，当时漏了。

**处理**：超时回调里直接 `settled = true` 并 `reject`。

### 修复 · 开机自启不带应用目录

`setLoginItemSettings({ …, args: [] })` 传的是空数组，electron.exe 不知道要开哪个应用，
会开成默认示例页。改为 `args: [ROOT]`。

### 改动 · 渲染器

`preserveDrawingBuffer: true` → `false`。全文没有 `toDataURL` / `toBlob` / `getImageData`
（截屏走主进程 `desktopCapturer`，截的是屏幕不是这个 canvas），开着纯属浪费。

### 文档

- 新增 `docs/启动故障排查.md`
- `docs/接口总览.md`：新增 §0 启动前置；勘误头部版本号（`44.7.0` → 实际 `43.7.11`）；
  **新增两条 🔴 警告**：
  - `pet-chat` 的 `recent` 必须恒返回 `[]`（否则高水位线会静默吞掉主动冒泡）
  - 联机模式**没有** Windows 系统 TTS 兜底（`synthSapi` 只在独立模式分支里被调用）
- `docs/桌宠对接接口文档.md`：同上两处的旧描述一并更正
- `README.md`：安装章节加警告块；故障对照表重写

### 内存优化：未成功，如实记录

| 实验 | 工作集 | 私有内存 | 结论 |
|---|---:|---:|---|
| 基线 | 2118.9 MB | 2947.9 MB | — |
| `preserveDrawingBuffer` + 像素比 2→1.5 | 2125.1 MB | 2964.0 MB | 噪声级别，**像素比已回退**（画质白亏） |
| 加载后贴图降采样 2048→1024 | 2131.6 → 2136.7 MB | 3641.6 → **3759.2 MB** | **反而更差，已回退** |

**结论**：内存大头既不在帧缓冲、也不在贴图位图。贴图解码后约 580 MB（25 张 2048×2048），
但把它降下去内存反而涨 —— 说明主因是**渲染进程的 JS 堆**（约 2.8 GB 私有），
大概率来自 ammo 物理世界或每帧对象分配，**尚未定位**。

顺带记录：4 个进程累计 CPU 在 85 秒内烧了 85.9 秒 = **持续吃满一个核**（rAF 渲染循环）。

### 调研产物（不入库，在 `D:\zhuochong\astrbot开发套件\`）

- `astrbot接入方案.md`（联机模式，**已暂缓**）
- `独立模式接入评估.md`
- `音频链路调研.md`

### 当前状态

语音链路**两端都是断的**，这是配置问题不是代码问题：
- `config.local.json` 顶层只有 `standalone`，且 `enabled=false`、`apiKey` 为空，没有 `consoleToken`
- `whisperExe` / `whisperServerExe` / `whisperModel` / `whisperPort` 四个键全缺
- 默认 whisper 路径 `E:\beifen\whisper` 不存在，`voice/` 目录从未生成
