# -*- coding: utf-8 -*-
"""娅娅桌宠网关（MaiBot 插件变体，备选方案）

与外挂进程版（../deskpet_adapter.py）目标相同：承载桌宠的 5 个 HTTP 接口。
区别：本插件跑在 MaiBot 的插件 Runner 子进程里，消息注入走 ctx.gateway.route_message()，
出站回复由 @MessageGateway(duplex) 处理器接收，不需要独立进程。

⚠️ 未实测声明：本文件按官方文档 API（docs zh/plugin/*.md，2026-10-25 抓取）编写，
未在真实 MaiBot 1.3.x 环境联调。装机后按本目录 README.md 的验收步骤验证。

依据：
  - 插件骨架/生命周期：zh/plugin/index.md（on_load/on_unload/on_config_update 三件套必需）
  - 消息网关：zh/plugin/message-gateway.md（update_state / route_message / duplex）
  - 主动任务：zh/plugin/api-reference.md（ctx.maisaka.proactive.trigger）
  - HTTP 服务可行性：zh/develop/plugin.md（插件无沙箱、独立子进程、等同主程序权限）
"""

from __future__ import annotations

import asyncio
import logging
import time

from aiohttp import web

from maibot_sdk import MaiBotPlugin, MessageGateway, PluginConfigBase, Field

log = logging.getLogger("plugin.deskpet-gateway")

IMPL = "maibot-deskpet-plugin/0.1"
_last_ts = 0


def now_ms_unique() -> int:
    global _last_ts
    ts = int(time.time() * 1000)
    if ts <= _last_ts:
        ts = _last_ts + 1
    _last_ts = ts
    return ts


def extract_text(segment) -> str:
    """出站正文通常是 seglist，取纯文本（依据 zh/develop/adapters/protocol.md）。"""
    if not isinstance(segment, dict):
        return ""
    stype, sdata = segment.get("type"), segment.get("data")
    if stype == "text":
        return str(sdata)
    if stype == "seglist" and isinstance(sdata, list):
        return "".join(extract_text(s) for s in sdata)
    return ""


class DeskPetConfig(PluginConfigBase):
    enabled: bool = Field(default=True, description="是否启用桌宠网关")
    http_host: str = Field(default="127.0.0.1", description="HTTP 监听地址")
    http_port: int = Field(default=13100, description="监听端口（= 桌宠 tunnelLocalPort）")
    console_token: str = Field(default="", description="x-console-token；留空不校验")
    account_id: str = Field(default="deskpet_bot", description="网关声明的机器人账号")
    owner_user_id: str = Field(default="10001", description="桌宠主人（建议= ownerQQ）")
    owner_nickname: str = Field(default="主人", description="主人昵称（非空即可）")
    reply_quiet_ms: int = Field(default=4000, description="回复静默窗口")
    reply_deadline_ms: int = Field(default=80000, description="回复等待上限（<90000）")


class DeskPetGatewayPlugin(MaiBotPlugin):
    """桌宠网关插件。

    消息流：
      桌宠 pet-chat ──HTTP──> 本插件 ──ctx.gateway.route_message──> Host 对话管线
      Host 出站回复 ──@MessageGateway(duplex)──> 本插件 ──HTTP 响应 / recent──> 桌宠
    """

    config_model = DeskPetConfig

    def __init__(self):
        super().__init__()
        self._runner = None
        self._site = None
        self.pending: dict | None = None      # {"buffer": [...], "last_append": float, "created": float}
        self.recent: list[dict] = []
        self.watch_state: dict = {}

    # ---- 生命周期（SDK 必需三件套） -------------------------------------

    async def on_load(self) -> None:
        cfg = self.config
        await self.ctx.gateway.update_state(
            gateway_name="deskpet_gateway",
            ready=True,                       # ready=True 才会参与消息路由（message-gateway.md）
            platform="deskpet",
            account_id=cfg.account_id,
            scope="",
            metadata={"protocol": "deskpet-http"},
        )
        app = web.Application()
        app.router.add_get("/api/status", self.h_status)
        app.router.add_post("/api/socialV2/pet-chat", self.h_pet_chat)
        app.router.add_get("/api/socialV2/recent", self.h_recent)
        app.router.add_post("/api/socialV2/screen-permission", self.h_screen_permission)
        app.router.add_post("/api/socialV2/voice-preview", self.h_voice_preview)
        self._runner = web.AppRunner(app)
        await self._runner.setup()
        self._site = web.TCPSite(self._runner, cfg.http_host, cfg.http_port)
        await self._site.start()
        self.ctx.logger.info("桌宠接口已监听 http://%s:%s", cfg.http_host, cfg.http_port)

    async def on_unload(self) -> None:
        await self.ctx.gateway.update_state(gateway_name="deskpet_gateway", ready=False)
        if self._site:
            await self._runner.cleanup()
        self.ctx.logger.info("桌宠网关已下线")

    async def on_config_update(self, scope: str, config_data: dict, version: str) -> None:
        if scope == "self":
            # TODO：端口/token 变更需重启监听；v0.1 简化为提示
            self.ctx.logger.info("配置已更新到 %s（端口变更需重启 MaiBot 生效）", version)

    # ---- 出站：Host → 桌宠（duplex 网关处理器） --------------------------

    @MessageGateway(
        route_type="duplex",
        name="deskpet_gateway",
        platform="deskpet",
        account_id="deskpet_bot",   # 运行时以 on_load 的 update_state 为准
        scope="",
    )
    async def send_to_desktop(self, message: dict, route=None, metadata=None, **kwargs) -> dict:
        info = message.get("message_info", {})
        text = extract_text(message.get("message_segment")).strip()
        if text and self.pending is not None:
            self.pending["buffer"].append(text)
            self.pending["last_append"] = time.monotonic()
        elif text:
            self.recent.append({"ts": now_ms_unique(), "self": True, "text": text})
        return {"success": True}

    # ---- 入站：桌宠 → Host ---------------------------------------------

    async def _inject(self, text: str) -> bool:
        """把桌宠的话注入 MaiBot 对话管线（message-gateway.md 完整示例的消息格式）。"""
        cfg = self.config
        accepted = await self.ctx.gateway.route_message(
            gateway_name="deskpet_gateway",
            message={
                "message_id": f"{time.time():.3f}-deskpet",
                "platform": "deskpet",
                "account_id": cfg.account_id,          # 顶层正式归属字段
                "scope": "",
                "timestamp": str(int(time.time())),
                "message_info": {
                    "user_info": {
                        "user_id": cfg.owner_user_id,
                        "user_nickname": cfg.owner_nickname,
                    },
                    "additional_config": {},
                },
                "raw_message": text,
            },
        )
        return bool(accepted)

    # ---- HTTP 处理器（契约与外挂进程版一致） ----------------------------

    def _token_ok(self, request: web.Request) -> bool:
        want = self.config.console_token
        return (not want) or request.headers.get("x-console-token", "") == want

    async def h_status(self, request):
        return web.json_response({"ok": True, "mode": "bridge", "role": "maibot-plugin",
                                  "dshReady": False, "impl": IMPL})

    async def h_pet_chat(self, request: web.Request) -> web.Response:
        if not self._token_ok(request):
            return web.json_response({"ok": False, "error": "token 不对"}, status=401)
        try:
            body = await request.json()
        except Exception:
            return web.json_response({"ok": False, "error": "body 不是 JSON"}, status=400)
        text = str(body.get("text", "")).strip()
        if not text:
            return web.json_response({"ok": False, "error": "text 不能为空"}, status=400)
        if self.pending is not None:
            return web.json_response({"ok": False, "error": "上一句话还没回完"}, status=409)

        self.pending = {"buffer": [], "last_append": time.monotonic(), "created": time.monotonic()}
        try:
            accepted = await self._inject(text)
            if not accepted:
                return web.json_response(
                    {"ok": False, "error": "消息被拒绝（检查网关 ready 与 adapter_policy.toml）"}, status=502)
            # 水位线 + 静默窗口（与外挂版同一策略）
            while True:
                now = time.monotonic()
                p = self.pending
                if p["buffer"] and now - p["last_append"] >= self.config.reply_quiet_ms / 1000:
                    break
                if now - p["created"] >= self.config.reply_deadline_ms / 1000:
                    break
                await asyncio.sleep(0.05)
            reply = "\n".join(self.pending["buffer"])
        finally:
            self.pending = None
        return web.json_response({"ok": True, "key": str(body.get("key", "")), "reply": reply,
                                  "recent": [], "impl": IMPL})

    async def h_recent(self, request: web.Request) -> web.Response:
        if not self._token_ok(request):
            return web.json_response({"ok": False, "error": "token 不对"}, status=401)
        limit = max(1, min(int(request.query.get("limit", "20")), 100))
        msgs, self.recent = self.recent[:limit], self.recent[limit:]
        return web.json_response({"ok": True, "messages": msgs})

    async def h_screen_permission(self, request: web.Request) -> web.Response:
        if not self._token_ok(request):
            return web.json_response({"ok": False, "error": "token 不对"}, status=401)
        try:
            body = await request.json()
        except Exception:
            body = {}
        self.watch_state = {"watch": bool(body.get("watch")), "mode": body.get("mode", "quiet")}
        # TODO(主动)：这里最有价值的玩法——桌宠开始看屏幕时，用 ctx.chat 找到（或创建）
        # 与主人的聊天流，再 ctx.maisaka.proactive.trigger(intent="陪主人看屏幕", ...)
        # 让 Maisaka 自己决定说点什么。API 见 zh/plugin/api-reference.md maisaka 节。
        self.ctx.logger.info("screen-permission: %s", self.watch_state)
        return web.json_response({"ok": True})

    async def h_voice_preview(self, request: web.Request) -> web.Response:
        # TODO(TTS)：同外挂版——契约要求 {ok, file 后端机绝对路径}，桌宠会 scp 拉取。
        return web.json_response({"ok": False, "error": "voice-preview 未实现（见 README 出路）"})


def create_plugin():
    return DeskPetGatewayPlugin()
