"""astrbot_plugin_pet_bridge —— 娅娅桌宠对接桥接插件（骨架 v1）

在 AstrBot 内起一个独立 aiohttp HTTP 服务（默认 127.0.0.1:3100），
实现桌宠联机模式要求的 5 个接口（协议见桌宠目录 docs/桌宠对接接口文档.md）：

  1. GET  /api/status                      探活，恒 200
  2. POST /api/socialV2/pet-chat           核心：调 AstrBot 的 LLM 回话
  3. GET  /api/socialV2/recent             她主动说的话（v1 恒返回空数组）
  4. POST /api/socialV2/screen-permission  看屏幕许可（仅记录开关）
  5. POST /api/socialV2/voice-preview      语音合成（v1 桩，返回 ok:false）

鉴权：所有业务接口校验请求头 x-console-token 与插件配置 console_token 相等。

所有对外 API 均已对照 AstrBot v4.29.3 master 源码核对：
  - astrbot/core/star/context.py   : Context.get_using_provider_async / get_provider_by_id
  - astrbot/core/provider/provider.py:100  Provider.text_chat(prompt, contexts, system_prompt, image_urls, ...)
  - astrbot/core/star/base.py:27,141,144 : Star(context, config) / initialize / terminate
  - astrbot/core/config/astrbot_config.py: AstrBotConfig(dict)

TODO 标注的部分为骨架未实现、需要按需扩展的地方。
"""

import asyncio
import hmac
import time
from collections import deque
from typing import Optional

import aiohttp
from aiohttp import web

from astrbot.api import AstrBotConfig, logger
from astrbot.api.event import filter, AstrMessageEvent  # noqa: F401  (filter 用于下方可选指令)
from astrbot.api.star import Context, Star, register

IMPL_TAG = "pet-chat/astrbot-plugin-pet_bridge-v1"


@register(
    "astrbot_plugin_pet_bridge",
    "denia",
    "娅娅桌宠联机模式对接桥：在插件内起 HTTP 服务实现桌宠 5 接口，pet-chat 走 AstrBot LLM",
    "1.0.0",
)
class PetBridgePlugin(Star):
    def __init__(self, context: Context, config: AstrBotConfig = None):
        super().__init__(context)
        self.config = config or {}
        # 每个 key（如 "private:123456"）一条 OpenAI 风格历史：[{"role","content"}, ...]
        self._history: dict[str, list[dict]] = {}
        self._locks: dict[str, asyncio.Lock] = {}
        # 她主动说的话队列：key -> deque[{ts, self, text}]。v1 默认没有任何东西写入，
        # 所以 /recent 恒返回 []（符合桌宠协议要求）。扩展方式见 _push_recent 注释。
        self._recent: dict[str, deque] = {}
        self._recent_last_ts: dict[str, int] = {}
        self._screen_watch: dict[str, dict] = {}
        self._runner: Optional[web.AppRunner] = None

    # ---------- 生命周期 ----------

    async def initialize(self):
        """AstrBot 实例化插件后自动调用（Star 基类钩子，base.py:141）。"""
        host = str(self.config.get("host", "127.0.0.1"))
        port = int(self.config.get("port", 3100))
        app = web.Application()
        app.router.add_get("/api/status", self._handle_status)
        app.router.add_post("/api/socialV2/pet-chat", self._handle_pet_chat)
        app.router.add_get("/api/socialV2/recent", self._handle_recent)
        app.router.add_post("/api/socialV2/screen-permission", self._handle_screen_permission)
        app.router.add_post("/api/socialV2/voice-preview", self._handle_voice_preview)

        self.app = app
        self._runner = web.AppRunner(self.app)
        await self._runner.setup()
        site = web.TCPSite(self._runner, host, port)
        await site.start()
        logger.info(f"[pet_bridge] 桌宠桥接已启动: http://{host}:{port} （等待桌宠探活）")

    async def terminate(self):
        """插件被卸载/停用时调用（Star 基类钩子，base.py:144）。"""
        if self._runner is not None:
            await self._runner.cleanup()
            self._runner = None
            logger.info("[pet_bridge] 桌宠桥接已停止")

    # ---------- HTTP handlers ----------

    async def _handle_status(self, request: web.Request) -> web.Response:
        """1) 探活：桌宠只看状态码，恒 200。"""
        return web.json_response({"ok": True, "impl": IMPL_TAG})

    async def _handle_pet_chat(self, request: web.Request) -> web.Response:
        """2) 核心：跟她说一句，拿回她的话。

        协议契约（桌宠对接接口文档.md §2）：
        - 同步阻塞，桌宠客户端硬超时 90s —— 本端必须在 90s 内返回；
        - text 缺失/为空 → 400；
        - reply 为 "" 表示她选择沉默，属正常返回；
        - recent 必须恒为 []（本轮 reply 不要写进 recent，否则主动冒泡高水位会吃掉后续消息）；
        - key（"private:<ownerQQ>"）不认识也要接受，用作上下文记忆 key。
        """
        err = self._check_auth(request)
        if err is not None:
            return err

        try:
            body = await request.json()
        except Exception:
            return web.json_response({"ok": False, "error": "invalid json"}, status=400)

        key = str(body.get("key", "")).strip()
        text = str(body.get("text", "")).strip()
        if not text:
            return web.json_response({"ok": False, "error": "text is required"}, status=400)
        if not key:
            key = "private:default"

        started = time.monotonic()
        # 服务端截止时间：尊重桌宠传的 timeoutMs，但硬上限不超过配置（默认 85s，先于桌宠 90s）
        client_ms = body.get("timeoutMs") or 100000
        deadline_s = min(int(client_ms), int(self.config.get("request_timeout_ms", 85000))) / 1000.0

        image_urls = self._normalize_image(body.get("image"))

        lock = self._locks.setdefault(key, asyncio.Lock())
        reply = ""
        try:
            async with lock:  # 同一个 key 的请求串行，避免历史交错
                reply = await asyncio.wait_for(
                    self._chat_once(key, text, image_urls), timeout=deadline_s
                )
        except asyncio.TimeoutError:
            logger.warning(f"[pet_bridge] pet-chat 超时（>{deadline_s:.0f}s），按协议返回沉默 reply=''")
            reply = ""
        except Exception as e:
            logger.error(f"[pet_bridge] pet-chat 出错: {e!r}")
            return web.json_response(
                {"ok": False, "error": f"llm error: {e}"}, status=200
            )

        waited_ms = int((time.monotonic() - started) * 1000)
        return web.json_response(
            {
                "ok": True,
                "key": key,
                "reply": reply,  # 空串 = 她选择沉默（正常）
                "recent": [],  # 🔴 协议要求恒为空数组，见文档 §2 警告框
                "waitedMs": waited_ms,
                "impl": IMPL_TAG,
            }
        )

    async def _handle_recent(self, request: web.Request) -> web.Response:
        """3) 她主动说的话（桌宠 4 秒轮询）。

        v1：队列恒空 → messages 恒 []。
        扩展路径（详见调研笔记 §3.3 / §5）：
          - 任何地方调用 self._push_recent(key, "想主动说的话")，
            桌宠就会在下一次轮询时逐条冒泡念出来；
          - 主动说话的内容可用 `await self.context.send_message(umo, MessageChain().message(text))`
            同步发到 IM 平台（umo 需另行配置/存储），桌宠侧则走本队列；
          - 定时触发可用插件里起 asyncio 任务或 AstrBot 的 cron 能力。
        """
        err = self._check_auth(request)
        if err is not None:
            return err
        key = request.query.get("key", "")
        limit = int(request.query.get("limit", 20) or 20)
        q = self._recent.get(key)
        messages = []
        if q:
            while q and len(messages) < limit:
                messages.append(q.popleft())  # 取走即出队：只念一次
        return web.json_response({"ok": True, "messages": messages})

    async def _handle_screen_permission(self, request: web.Request) -> web.Response:
        """4) 看屏幕许可（可选接口）：最小实现=记录开关并回执。

        桌宠当前并不会在请求里传截图（接口文档 §4 明示），所以这里没有"看"的能力；
        真正实现需要后端自己截屏 + 多模态模型，见 TODO。
        """
        err = self._check_auth(request)
        if err is not None:
            return err
        try:
            body = await request.json()
        except Exception:
            body = {}
        watch = bool(body.get("watch", False))
        minutes = int(body.get("minutes", 0) or 0)
        mode = str(body.get("mode", "quiet"))
        key = request.query.get("key", "private:default")
        self._screen_watch[key] = {"watch": watch, "minutes": minutes, "mode": mode, "since": int(time.time() * 1000)}
        logger.info(f"[pet_bridge] screen-permission: key={key} watch={watch} mode={mode} minutes={minutes}")
        # TODO: 实现真正"看屏幕"：定时截屏 → 交给支持图片的 provider
        #       （provider.text_chat(image_urls=[...]) 已支持，见 provider.py:104）
        return web.json_response({"ok": True, "watch": watch, "mode": mode})

    async def _handle_voice_preview(self, request: web.Request) -> web.Response:
        """5) 语音合成（可选接口）：v1 为桩，返回 ok:false。

        协议要求响应 JSON {ok, file:"后端机器上的绝对路径", ms, kb, label}，
        桌宠拿到 file 后用 scp 拉回本地播放；不实现时她只有气泡没有声音
        （联机模式不会退回系统 TTS，见接口文档 §5）。
        若桌宠侧对本响应出现错误气泡，直接注释掉 initialize() 里 add_post 的这一行即可
        （404 与"不实现"等价）。"""
        err = self._check_auth(request)
        if err is not None:
            return err
        # TODO: 对接 TTS（例如 AstrBot 插件生态里的 GPT-SoVITS 类方案或任意 OpenAI 兼容 TTS 端点），
        #       生成绝对路径文件后返回 {"ok": True, "file": "<绝对路径>", "ms": ..., "kb": ..., "label": "..."}
        return web.json_response({"ok": False, "error": "voice-preview not implemented in skeleton v1"})

    # ---------- LLM ----------

    async def _get_provider(self):
        """取一个文本生成 Provider。

        优先用插件配置里指定的 provider_id（Context.get_provider_by_id，context.py:452，
        同步方法，找不到返回 None）；否则取当前默认（Context.get_using_provider_async，
        context.py:519，umo 参数可空 → 不装任何消息平台也能拿到全局默认 provider）。
        """
        provider_id = str(self.config.get("provider_id", "") or "").strip()
        if provider_id:
            prov = self.context.get_provider_by_id(provider_id)
            if prov is None:
                raise RuntimeError(f"配置的 provider_id='{provider_id}' 不存在，请到 WebUI 检查模型提供商 ID")
            return prov
        prov = await self.context.get_using_provider_async()
        if prov is None:
            raise RuntimeError("未配置任何 LLM 提供商：请先在 AstrBot WebUI『服务提供商』里配好一个聊天模型")
        return prov

    async def _chat_once(self, key: str, text: str, image_urls: Optional[list[str]]) -> str:
        """一次完整对话：追加用户消息 → 调 LLM（人设注入 system）→ 记录回复。"""
        history = self._history.setdefault(key, [])
        limit = max(2, int(self.config.get("history_limit", 20)) * 2)  # user+assistant 成对，留 2 的倍数
        if len(history) > limit:
            del history[: len(history) - limit]

        prov = await self._get_provider()
        persona = str(self.config.get("persona", "") or "").strip() or None

        llm_resp = await prov.text_chat(
            prompt=text,  # 本轮输入；docstring：与 contexts 同传时自动追加到末尾
            contexts=history,  # ⚠️ 参数名是 contexts（provider.py:107），旧 wiki 文档的 context= 已过时
            system_prompt=persona,  # 人设注入；provider.py:108 原生支持
            image_urls=image_urls,  # 支持 http(s) URL / data URL / 本地路径（provider.py:104）
        )
        reply = (llm_resp.completion_text or "").strip()

        history.append({"role": "user", "content": text})
        if reply:
            # 她沉默（reply 为空）时只记用户侧，避免历史里堆积空气泡轮次
            history.append({"role": "assistant", "content": reply})

        # 等价的新式写法（v4.5.7+，需要 provider_id）：
        #   resp = await self.context.llm_generate(
        #       chat_provider_id=provider_id, prompt=text,
        #       system_prompt=persona, contexts=<Message 对象列表>)
        # 因 HTTP 场景没有消息事件/umo，本骨架选用 text_chat 直调路径。
        return reply

    # ---------- 工具 ----------

    def _check_auth(self, request: web.Request) -> Optional[web.Response]:
        """校验 x-console-token。未配置 token 时拒绝所有请求（安全默认）。"""
        expected = str(self.config.get("console_token", "") or "")
        if not expected:
            return web.json_response(
                {"ok": False, "error": "插件配置里还没设置 console_token，请到 AstrBot WebUI 插件配置中填写"},
                status=401,
            )
        got = request.headers.get("x-console-token", "")
        if not hmac.compare_digest(got, expected):  # 常量时间比较
            return web.json_response({"ok": False, "error": "x-console-token 不匹配"}, status=401)
        return None

    @staticmethod
    def _normalize_image(image) -> Optional[list[str]]:
        """桌宠传来的 image 字段（data URL / base64 / http(s) URL）归一成 image_urls 列表。

        TODO: data URL 与裸 base64 对各 Provider 的兼容性未逐一实测（OpenAI 兼容端一般收 data URL）；
              http(s) URL 直接透传；本地路径 text_chat 原生支持。
        """
        if not image or not isinstance(image, str):
            return None
        img = image.strip()
        if img.startswith(("http://", "https://", "data:")):
            return [img]
        return [f"data:image/png;base64,{img}"]  # 兜底当裸 base64 处理

    def _push_recent(self, key: str, text: str) -> dict:
        """扩展用：往某 key 的"她主动说的话"队列推一条（ts 为毫秒、同 key 严格递增唯一）。

        v1 骨架没有任何调用点，/recent 因此恒为空数组。未来做"她主动找你"时：
        定时/事件触发 → (可选)先 self.context.send_message(umo, MessageChain().message(text))
        发到 IM 平台 → self._push_recent(key, text) 推给桌宠冒泡。
        """
        now = int(time.time() * 1000)
        last = self._recent_last_ts.get(key, 0)
        ts = now if now > last else last + 1  # 保证同 key 严格递增且唯一
        self._recent_last_ts[key] = ts
        q = self._recent.setdefault(key, deque(maxlen=50))
        msg = {"ts": ts, "self": True, "text": text}
        q.append(msg)
        return msg

    # ---------- 可选：聊天指令（用于不开桌宠时快速自检） ----------

    @filter.command("pet_bridge_ping")
    async def pet_bridge_ping(self, event: AstrMessageEvent):
        """在任意聊天里发 /pet_bridge_ping，检查桥接服务是否在运行。"""
        alive = self._runner is not None and self._runner.addresses
        yield event.plain_result(
            f"pet_bridge 运行中：{alive}，地址 http://{self.config.get('host', '127.0.0.1')}:{self.config.get('port', 3100)}"
        )
