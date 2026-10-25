#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""娅娅桌宠 ↔ MaiBot 适配层（外挂进程版）

职责：
  1. 对桌宠实现 5 个 HTTP 接口（契约见 娅娅桌宠 docs/接口总览.md）：
       GET  /api/status                    探活
       POST /api/socialV2/pet-chat         核心：发一句话，同步等她的回复
       GET  /api/socialV2/recent           她主动说的话（桌宠 4 秒轮询）
       POST /api/socialV2/screen-permission 看屏幕许可（记录开关，见 TODO）
       POST /api/socialV2/voice-preview    语音合成（默认未实现，见 TODO）
  2. 经 maim_message 经典 WebSocket（默认 ws://127.0.0.1:8000/ws）与 MaiBot 通信：
       - 把桌宠的话包装成"私聊消息"注入 MaiBot 对话管线（不填 group_info 即私聊，
         additional_config.platform_io_target_user_id 指定回复对象）；
       - 收 MaiBot 推来的出站消息：本轮请求等待期内的算"回复"，其余进 /recent 缓冲。

协议依据（官方文档，2026-10-25 抓取）：
  - docs zh/develop/adapters/protocol.md        报文格式 / 握手 / 保留平台名
  - docs zh/examples/adapter-minimal/adapter.py MessageClient 官方最小用法
  - docs zh/manual/configuration/bot-config.md  [maim_message] 配置段

运行：
  pip install maim_message==0.6.8
  python deskpet_adapter.py            # 读同目录 config.toml
  python deskpet_adapter.py --selftest # 不连 MaiBot 的内置自测（模拟消息流）

已知边界 / TODO（详见同目录 README.md）：
  - voice-preview 未接 TTS（桌宠联机模式没有系统 TTS 兜底，无声是预期，见 README 出路②）
  - screen-permission 只记录开关；"看屏幕"在 MaiBot 侧无现成挂点
  - 单主人设计：所有 key 一律路由给 config [owner].user_id 这一个私聊对象
  - 主动说话依赖 MaiBot 在 deskpet 平台上的自发行为，可能长期为空（契约允许空）
"""

from __future__ import annotations

import asyncio
import json
import logging
import sys
import time
import uuid
from pathlib import Path

# maim_message 缺失时仍允许 --selftest 跑通逻辑自测
try:
    from maim_message import MessageClient  # type: ignore
    MAIM_MESSAGE_OK = True
except Exception:  # pragma: no cover - 环境缺依赖时
    MessageClient = None  # type: ignore
    MAIM_MESSAGE_OK = False

from aiohttp import web

log = logging.getLogger("deskpet-adapter")
IMPL = "maibot-deskpet-adapter/0.1"

# ---------------------------------------------------------------------------
# 配置
# ---------------------------------------------------------------------------

DEFAULTS = {
    "server": {
        "host": "127.0.0.1",
        "port": 13100,            # 必须等于桌宠 config.local.json 的 tunnelLocalPort（桌宠 BASE 端口）
        "console_token": "",      # 与桌宠 consoleToken 一致；留空 = 不校验
    },
    "maibot": {
        "ws_url": "ws://127.0.0.1:8000/ws",
        "token": "",              # bot_config.toml [maim_message].auth_token 非空时填其中一项
        "platform": "deskpet",    # 平台名：全局唯一；勿用 webui / bot_console / maisaka_cli
        "self_id": "deskpet_bot", # 本适配器的账号标识（多账号路由用）
    },
    "owner": {
        "user_id": "10001",       # 建议填桌宠 config.local.json 的 ownerQQ
        "user_nickname": "主人",   # 非空即可，MaiBot 侧会断言非空
    },
    "timing": {
        "reply_quiet_ms": 4000,   # 收到回复后，静默多久视为"这轮说完了"
        "reply_deadline_ms": 80000,  # 整体上限：桌宠客户端 90s 硬超时，必须先于它返回
        "recent_max": 200,        # /recent 缓冲上限（防止无人轮询时堆积）
    },
}


def _deep_merge(base: dict, override: dict) -> dict:
    out = dict(base)
    for k, v in (override or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _deep_merge(out[k], v)
        else:
            out[k] = v
    return out


def load_config(path: Path) -> dict:
    cfg = DEFAULTS
    if path.exists():
        import tomllib
        with open(path, "rb") as f:
            cfg = _deep_merge(DEFAULTS, tomllib.load(f))
    return cfg


# ---------------------------------------------------------------------------
# 小工具
# ---------------------------------------------------------------------------

_last_ts = 0


def now_ms_unique() -> int:
    """桌宠要求 /recent 的 ts 毫秒、严格递增且唯一（接口总览.md §5.3）。"""
    global _last_ts
    ts = int(time.time() * 1000)
    if ts <= _last_ts:
        ts = _last_ts + 1
    _last_ts = ts
    return ts


def extract_text(segment) -> str:
    """从 MaiBot 出站的 message_segment 里取纯文本。

    出站正文通常是 seglist（协议文档：出站几乎都是这个形态）；
    image/at/emoji 等分段对桌宠没意义，跳过（at 可在 TODO 里考虑转成文本）。
    """
    if not isinstance(segment, dict):
        return ""
    stype, sdata = segment.get("type"), segment.get("data")
    if stype == "text":
        return str(sdata)
    if stype == "seglist" and isinstance(sdata, list):
        return "".join(extract_text(s) for s in sdata)
    return ""


# ---------------------------------------------------------------------------
# 待回复请求（水位线 + 静默窗口）
# ---------------------------------------------------------------------------

class PendingReply:
    """一轮 pet-chat 的回复收集器。

    桌宠契约：90s 内必须同步返回；多条回复按顺序 join("\n")；
    收到第一条后若静默超过 quiet_ms 视为说完，提前返回（桌宠文档"附 B"的思路）。
    """

    def __init__(self, quiet_ms: int, deadline_ms: int):
        self.quiet_s = quiet_ms / 1000.0
        self.deadline_s = deadline_ms / 1000.0
        self.buffer: list[str] = []
        self.last_append = 0.0
        self.created = time.monotonic()

    def feed(self, text: str) -> None:
        if not text:
            return
        self.buffer.append(text)
        self.last_append = time.monotonic()

    async def result(self) -> tuple[str, int]:
        loop = asyncio.get_running_loop()
        deadline = self.created + self.deadline_s
        while True:
            now = time.monotonic()
            if self.buffer and now - self.last_append >= self.quiet_s:
                break
            if now >= deadline:
                break
            await asyncio.sleep(0.05)
        waited_ms = int((time.monotonic() - self.created) * 1000)
        return "\n".join(self.buffer), waited_ms


# ---------------------------------------------------------------------------
# 适配器主体
# ---------------------------------------------------------------------------

class DeskPetAdapter:
    def __init__(self, cfg: dict, sender=None):
        self.cfg = cfg
        # sender: 提供 await send_message(dict) 的对象；正式运行是 MessageClient 包装，
        # --selftest 时注入 FakeClient。抽出来是为了让全部 HTTP/收发逻辑可脱离 maim_message 测试。
        self._sender = sender
        self.pending: PendingReply | None = None
        self.pending_lock = asyncio.Lock()
        self.recent: list[dict] = []          # {ts:int(ms), self:True, text:str}
        self.watch_state: dict = {}           # screen-permission 最近一次请求（TODO 语义）

    # ---- MaiBot 侧 ------------------------------------------------------

    def build_inbound(self, text: str) -> dict:
        """把桌宠的一句话包装成 MaiBot 统一消息格式的私聊消息。

        依据官方最小适配器示例（adapter-minimal.py:61-88）：
        不填 group_info => 私聊；platform_io_target_user_id 指定回复对象。
        """
        c = self.cfg["maibot"]
        owner = self.cfg["owner"]
        return {
            "message_info": {
                "platform": c["platform"],
                "message_id": f"{time.time():.3f}-{uuid.uuid4().hex[:6]}",
                "time": time.time(),
                "user_info": {
                    "platform": c["platform"],
                    "user_id": str(owner["user_id"]),
                    "user_nickname": str(owner["user_nickname"]),  # MaiBot 断言非空
                },
                "additional_config": {
                    "platform_io_account_id": c["self_id"],
                    "platform_io_target_user_id": str(owner["user_id"]),
                },
            },
            "message_segment": {"type": "text", "data": str(text)},
        }

    async def send_to_maibot(self, text: str) -> None:
        if self._sender is None:
            raise RuntimeError("MaiBot 连接尚未建立")
        await self._sender.send_message(self.build_inbound(text))

    async def on_outbound(self, message: dict) -> None:
        """MaiBot 出站回调：本轮等待期内 => 回复；否则 => 主动消息进 /recent。

        注意桌宠契约（接口总览.md §5.2 红色警告）：
        作为 reply 返回的消息绝不能再进 /recent，否则会重复念/吞消息。
        """
        try:
            info = message.get("message_info", {})
            if info.get("platform") != self.cfg["maibot"]["platform"]:
                return  # 不是发给本适配器平台的
            target = (info.get("additional_config") or {}).get("platform_io_target_user_id", "")
            if str(target) != str(self.cfg["owner"]["user_id"]):
                return  # 单主人设计：只认桌宠主人这个收件人
            text = extract_text(message.get("message_segment")).strip()
            if not text:
                return
            log.info("MaiBot -> 桌宠: %s", text[:60])
            if self.pending is not None:
                self.pending.feed(text)
            else:
                self.recent.append({"ts": now_ms_unique(), "self": True, "text": text})
                max_n = int(self.cfg["timing"]["recent_max"])
                if len(self.recent) > max_n:
                    del self.recent[: len(self.recent) - max_n]
        except Exception:  # 出站处理绝不抛出，避免打挂 WS 回调
            log.exception("处理 MaiBot 出站消息失败")

    # ---- HTTP 侧 --------------------------------------------------------

    def _check_token(self, request: web.Request) -> bool:
        want = str(self.cfg["server"]["console_token"] or "")
        if not want:
            return True  # 未配置 = 不校验（本机回环场景）
        got = request.headers.get("x-console-token", "")
        return got == want

    async def h_status(self, request: web.Request) -> web.Response:
        # 桌宠只看状态码；bridgeStatus 会透传 {mode, role, dshReady}（接口总览.md §5.1）
        return web.json_response({"ok": True, "mode": "bridge", "role": "maibot-adapter",
                                  "dshReady": False, "impl": IMPL})

    async def h_pet_chat(self, request: web.Request) -> web.Response:
        if not self._check_token(request):
            return web.json_response({"ok": False, "error": "token 不对"}, status=401)
        try:
            body = await request.json()
        except Exception:
            return web.json_response({"ok": False, "error": "body 不是 JSON"}, status=400)
        # 桌宠实际只发 key/text 两个字段（接口总览.md D8）；其余一律忽略
        text = str(body.get("text", "")).strip()
        key = str(body.get("key", ""))
        if not text:
            return web.json_response({"ok": False, "error": "text 不能为空"}, status=400)

        if self.pending is not None or self.pending_lock.locked():
            # 桌宠自己就是串行发送（同时仅 1 条在途），正常到不了这里
            return web.json_response({"ok": False, "error": "上一句话还没回完"}, status=409)

        async with self.pending_lock:
            pending = PendingReply(int(self.cfg["timing"]["reply_quiet_ms"]),
                                   int(self.cfg["timing"]["reply_deadline_ms"]))
            self.pending = pending
            try:
                await self.send_to_maibot(text)
            except Exception as e:
                self.pending = None
                log.error("注入 MaiBot 失败：%s", e)
                return web.json_response(
                    {"ok": False, "error": f"连不上 MaiBot：{e}"}, status=502)
            try:
                reply, waited_ms = await pending.result()
            finally:
                self.pending = None
        # recent 恒为 []（桌宠高水位去重契约）；reply 为空串 = 她选择沉默，正常
        return web.json_response({"ok": True, "key": key, "reply": reply,
                                  "recent": [], "waitedMs": waited_ms, "impl": IMPL})

    async def h_recent(self, request: web.Request) -> web.Response:
        if not self._check_token(request):
            return web.json_response({"ok": False, "error": "token 不对"}, status=401)
        try:
            limit = int(request.query.get("limit", "20"))
        except ValueError:
            limit = 20
        limit = max(1, min(limit, 100))
        msgs, self.recent = self.recent[:limit], self.recent[limit:]
        return web.json_response({"ok": True, "messages": msgs})

    async def h_screen_permission(self, request: web.Request) -> web.Response:
        if not self._check_token(request):
            return web.json_response({"ok": False, "error": "token 不对"}, status=401)
        try:
            body = await request.json()
        except Exception:
            body = {}
        # TODO(语义)：桌宠只发 watch:true（从不发 watch:false，停看靠聊天文本「别看了」，
        # 见接口总览.md D4）。"看屏幕"需要把截屏喂给模型，MaiBot 侧无现成挂点，
        # 当前仅记录。要让她"有反应"，可在此向 MaiBot 注入一条文本（如「（在陪你看屏幕）」）。
        self.watch_state = {"watch": bool(body.get("watch")), "mode": body.get("mode", "quiet"),
                            "at": now_ms_unique()}
        log.info("screen-permission: %s", self.watch_state)
        return web.json_response({"ok": True})

    async def h_voice_preview(self, request: web.Request) -> web.Response:
        if not self._check_token(request):
            return web.json_response({"ok": False, "error": "token 不对"}, status=401)
        # TODO(TTS)：契约要求返回 JSON {ok,file 后端机绝对路径,...}，桌宠会 scp 拉取（接口总览.md §5.5）。
        # 可接 GPT-SoVITS / fish / edge-tts 等，落盘到可 scp 的目录后返回绝对路径。
        # 注意：联机模式没有系统 TTS 兜底——本接口返回 ok:false 时她只有气泡没声音。
        # 出路②：改桌宠 main.cjs 的 petVoiceViaBridge 失败分支接 synthSapi()（约 10 行）。
        return web.json_response({"ok": False, "error": "voice-preview 未实现（见 README 出路）"})

    # ---- 应用组装 -------------------------------------------------------

    def make_app(self) -> web.Application:
        app = web.Application()
        app.router.add_get("/api/status", self.h_status)
        app.router.add_post("/api/socialV2/pet-chat", self.h_pet_chat)
        app.router.add_get("/api/socialV2/recent", self.h_recent)
        app.router.add_post("/api/socialV2/screen-permission", self.h_screen_permission)
        app.router.add_post("/api/socialV2/voice-preview", self.h_voice_preview)
        return app


# ---------------------------------------------------------------------------
# 正式模式：maim_message 客户端（含断线重连）
# ---------------------------------------------------------------------------

class MaibotClientWrapper:
    """MessageClient 的最小包装：把 send_message 暴露给适配器，并管理连接。"""

    def __init__(self, cfg: dict, on_outbound):
        if not MAIM_MESSAGE_OK:
            raise RuntimeError("未安装 maim_message，请先: pip install maim_message==0.6.8")
        self.cfg = cfg
        self.client = MessageClient()
        self.client.register_message_handler(on_outbound)

    async def send_message(self, payload: dict) -> None:
        await self.client.send_message(payload)

    async def run_forever(self) -> None:
        c = self.cfg["maibot"]
        token = c.get("token") or None
        while True:
            try:
                await self.client.connect(url=c["ws_url"], platform=c["platform"], token=token)
                log.info("已连接 MaiBot：%s（platform=%s）", c["ws_url"], c["platform"])
                await self.client.run()
            except asyncio.CancelledError:
                raise
            except Exception as e:
                log.warning("MaiBot 连接异常（%s），3 秒后重连", e)
                await asyncio.sleep(3)


async def run_real(cfg_path: Path) -> None:
    cfg = load_config(cfg_path)
    adapter = DeskPetAdapter(cfg)
    wrapper = MaibotClientWrapper(cfg, adapter.on_outbound)
    adapter._sender = wrapper
    runner = web.AppRunner(adapter.make_app())
    await runner.setup()
    site = web.TCPSite(runner, cfg["server"]["host"], int(cfg["server"]["port"]))
    await site.start()
    log.info("桌宠接口已监听 http://%s:%s（桌宠 tunnelLocalPort 需与此一致）",
             cfg["server"]["host"], cfg["server"]["port"])
    try:
        await wrapper.run_forever()
    finally:
        await runner.cleanup()


# ---------------------------------------------------------------------------
# 自测模式（不需要 MaiBot / 不需要 maim_message）
# ---------------------------------------------------------------------------

class FakeClient:
    def __init__(self) -> None:
        self.last: dict | None = None

    async def send_message(self, payload: dict) -> None:
        self.last = payload


async def _selftest() -> int:
    import aiohttp

    cfg = load_config(Path(__file__).with_name("config.toml"))
    cfg["server"]["port"] = 13101          # 测试端口，避免与真服务冲突
    cfg["server"]["console_token"] = "test-token"
    cfg["timing"]["reply_quiet_ms"] = 300
    cfg["timing"]["reply_deadline_ms"] = 2000

    fake = FakeClient()
    adapter = DeskPetAdapter(cfg, sender=fake)
    runner = web.AppRunner(adapter.make_app())
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", cfg["server"]["port"])
    await site.start()
    base = f"http://127.0.0.1:{cfg['server']['port']}"
    failures: list[str] = []

    def check(name: str, cond: bool, detail: str = "") -> None:
        print(f"[{'PASS' if cond else 'FAIL'}] {name} {detail}")
        if not cond:
            failures.append(name)

    async with aiohttp.ClientSession(
            headers={"x-console-token": "test-token"}) as sess:
        # 1. 探活
        async with sess.get(f"{base}/api/status") as r:
            check("GET /api/status = 200", r.status == 200)

        # 2. 缺 text -> 400
        async with sess.post(f"{base}/api/socialV2/pet-chat", json={"key": "private:1", "text": " "}) as r:
            check("pet-chat 空 text = 400", r.status == 400)

        # 3. 正常一轮：请求挂起 -> 模拟 MaiBot 推两条回复 -> 静默窗口后聚合返回
        task = asyncio.create_task(sess.post(
            f"{base}/api/socialV2/pet-chat", json={"key": "private:123456", "text": "在干嘛"}))
        await asyncio.sleep(0.2)
        injected = fake.last
        check("注入消息为私聊格式（无 group_info）", bool(injected) and "group_info" not in injected["message_info"])
        check("注入 user_id/user_nickname 非空",
              bool(injected) and injected["message_info"]["user_info"]["user_id"] == "10001"
              and injected["message_info"]["user_info"]["user_nickname"])
        check("注入 platform_io_target_user_id 指向主人",
              bool(injected) and injected["message_info"]["additional_config"]["platform_io_target_user_id"] == "10001")
        check("注入正文一致", bool(injected) and injected["message_segment"]["data"] == "在干嘛")

        await adapter.on_outbound({"message_info": {"platform": cfg["maibot"]["platform"],
                                                    "additional_config": {"platform_io_target_user_id": "10001"}},
                                   "message_segment": {"type": "seglist",
                                                       "data": [{"type": "text", "data": "没干嘛。"}]}})
        await adapter.on_outbound({"message_info": {"platform": cfg["maibot"]["platform"],
                                                    "additional_config": {"platform_io_target_user_id": "10001"}},
                                   "message_segment": {"type": "text", "data": "你呢？"}})
        async with await task as r:
            data = await r.json()
            check("pet-chat 聚合两条回复", data.get("reply") == "没干嘛。\n你呢？", f"reply={data.get('reply')!r}")
            check("pet-chat recent 恒为 []", data.get("recent") == [])
            check("pet-chat ok=True", data.get("ok") is True)

        # 4. 主动消息：无挂起请求时进入 /recent
        await adapter.on_outbound({"message_info": {"platform": cfg["maibot"]["platform"],
                                                    "additional_config": {"platform_io_target_user_id": "10001"}},
                                   "message_segment": {"type": "text", "data": "喂"}})
        async with sess.get(f"{base}/api/socialV2/recent?key=private%3A123456&limit=20") as r:
            data = await r.json()
            msgs = data.get("messages", [])
            check("recent 收到 1 条主动消息", len(msgs) == 1, f"messages={msgs}")
            check("recent ts 为毫秒且 self=true",
                  bool(msgs) and isinstance(msgs[0]["ts"], int) and msgs[0]["ts"] > 1_700_000_000_000
                  and msgs[0]["self"] is True)
        async with sess.get(f"{base}/api/socialV2/recent?key=private%3A123456") as r:
            data = await r.json()
            check("recent 取走后为空（drain 语义）", data.get("messages") == [])

        # 5. 错误 token -> 401
        async with sess.post(f"{base}/api/socialV2/pet-chat", json={"text": "hi"},
                             headers={"x-console-token": "wrong"}) as r:
            check("token 错误 = 401", r.status == 401)

        # 6. 可选接口兜底
        async with sess.post(f"{base}/api/socialV2/screen-permission",
                             json={"watch": True, "mode": "quiet"}) as r:
            check("screen-permission 返回 200", r.status == 200)
        async with sess.post(f"{base}/api/socialV2/voice-preview", json={"text": "测试"}) as r:
            data = await r.json()
            check("voice-preview 明确返回 ok:false", r.status == 200 and data.get("ok") is False)

    await runner.cleanup()
    print()
    if failures:
        print(f"自测失败 {len(failures)} 项：{failures}")
        return 1
    print("自测全部通过。")
    return 0


def main() -> None:
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(name)s %(message)s")
    if "--selftest" in sys.argv:
        sys.exit(asyncio.run(_selftest()))
    if not MAIM_MESSAGE_OK:
        print("缺少依赖：pip install maim_message==0.6.8  （或先跑 python deskpet_adapter.py --selftest）")
        sys.exit(2)
    cfg_path = Path(__file__).with_name("config.toml")
    asyncio.run(run_real(cfg_path))


if __name__ == "__main__":
    main()
