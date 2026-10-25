# 插件变体：娅娅桌宠网关（备选方案）

把本目录整个拷进 MaiBot 的 `plugins/` 文件夹（保持目录名，如 `plugins/deskpet-gateway/`，
内含 `_manifest.json` + `plugin.py`），重启 MaiBot 后插件会自动被发现和加载
（官方文档：zh/plugin/index.md §"安装与运行"）。

插件加载后会在 **插件 Runner 子进程里** 监听 `config.http_port`（默认 13100），
桌宠直接按 `../预设方案.md` 的方式连它即可。

## 装机后验收（按顺序）

1. MaiBot 启动日志/WebUI 插件页里能看到「娅娅桌宠网关」且为启用状态；
   插件日志出现 `桌宠接口已监听 http://127.0.0.1:13100`。
2. `curl http://127.0.0.1:13100/api/status` → 200。
3. 桌宠发一句话 → MaiBot 控制台应出现 `platform=deskpet` 的入站消息，
   桌宠在数秒内收到 `reply`。
4. 若启动报「未获授权能力」：把日志里提示的能力名补进 `_manifest.json` 的
   `capabilities` 后重启（文档只逐项列出了 `send.text`、`chat.open_session`、
   `maisaka.proactive` 等名字，网关自身的能力名未在文档枚举，需按报错补齐）。
5. 若注入被拒（`route_message` 返回 False）：检查 `config/adapter_policy.toml`
   是否把 `deskpet` 平台 block 了（文件不存在 = 全部放行，zh/plugin/message-gateway.md 排错节）。

## 首次生成配置

插件带 `config_model`（`DeskPetConfig`），Runner 首次加载时会按模型在插件目录生成
`config.toml`，改端口/token/主人后重启生效（zh/plugin/index.md §配置模型）。

## 与外挂进程版怎么选

| | 外挂进程版（主推） | 插件版（本目录） |
|---|---|---|
| 部署 | 多一个 Python 进程要启动/保活 | 拷文件夹即装，零额外进程 |
| 故障隔离 | 崩了不影响 MaiBot/QQ | 崩了会连坐同 Runner 的其它第三方插件 |
| 主动说话 | 依赖 MaiBot 自发行为 | 可 `ctx.maisaka.proactive.trigger()` 主动触发 |
| 成熟度 | 基于官方最小适配器示例，HTTP 层已自测 15/15 | **未实测**，按文档 API 编写 |

结论：先跑外挂版验证链路；确认桌面场景稳定后，再考虑换插件版把"看屏幕/主动说话"
做深。两个方案共享同一套桌宠契约与配置语义，迁移成本只是挪端口。
