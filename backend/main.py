from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from pathlib import Path
import asyncio
import base64
import json
import os
import time

import websockets

BASE_DIR = Path(__file__).resolve().parent.parent
FRONTEND_DIR = BASE_DIR / "frontend"
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
OPENAI_WS_URL = "wss://api.openai.com/v1/realtime?intent=transcription"

app = FastAPI(title="Tutor Copilot Realtime Transcription")


@app.get("/health")
async def health():
    return {
        "ok": True,
        "openai_configured": bool(OPENAI_API_KEY),
        "ts": time.time(),
    }


async def relay_openai_events(openai_ws, client_ws: WebSocket):
    try:
        async for raw in openai_ws:
            event = json.loads(raw)
            event_type = event.get("type")

            if event_type == "conversation.item.input_audio_transcription.delta":
                await client_ws.send_json({
                    "type": "transcript_delta",
                    "item_id": event.get("item_id"),
                    "delta": event.get("delta", ""),
                })

            elif event_type == "conversation.item.input_audio_transcription.completed":
                await client_ws.send_json({
                    "type": "transcript_final",
                    "item_id": event.get("item_id"),
                    "transcript": event.get("transcript", ""),
                })

            elif event_type == "error":
                print(f"[OPENAI ERROR] {event}", flush=True)
                await client_ws.send_json({
                    "type": "openai_error",
                    "message": event.get("error", {}).get("message", "OpenAI realtime error"),
                })

            elif event_type in {"session.created", "session.updated"}:
                await client_ws.send_json({
                    "type": "transcription_status",
                    "status": event_type,
                })

    except Exception as exc:
        print(f"[OPENAI RELAY ERROR] {type(exc).__name__}: {exc}", flush=True)
        try:
            await client_ws.send_json({
                "type": "openai_error",
                "message": f"Realtime transcription disconnected: {exc}",
            })
        except Exception:
            pass


@app.websocket("/ws/audio")
async def audio_ws(websocket: WebSocket):
    await websocket.accept()

    if not OPENAI_API_KEY:
        await websocket.send_json({
            "type": "config_error",
            "message": "OPENAI_API_KEY is not configured on the server.",
        })
        await websocket.close(code=1011)
        return

    total_bytes = 0
    chunk_count = 0

    try:
        async with websockets.connect(
            OPENAI_WS_URL,
            additional_headers={
                "Authorization": f"Bearer {OPENAI_API_KEY}",
            },
            max_size=8 * 1024 * 1024,
        ) as openai_ws:
            await openai_ws.send(json.dumps({
                "type": "session.update",
                "session": {
                    "type": "transcription",
                    "audio": {
                        "input": {
                            "format": {
                                "type": "audio/pcm",
                                "rate": 24000
                            },
                            "transcription": {
                                "model": "gpt-live-transcribe",
                                "languages": ["zh-cn"],
                                "delay": "low",
                                "prompt": "一对一初中数学辅导课堂。请准确转录老师和学生的中文对话。",
                                "keywords": [
                                    "一次函数",
                                    "斜率",
                                    "截距",
                                    "方程",
                                    "等式",
                                    "分配律"
                                ]
                            },
                            "turn_detection": None
                        }
                    }
                }
            }, ensure_ascii=False))

            await websocket.send_json({
                "type": "connected",
                "message": "FastAPI + OpenAI realtime transcription connected",
            })

            relay_task = asyncio.create_task(relay_openai_events(openai_ws, websocket))

            try:
                while True:
                    message = await websocket.receive()

                    if message.get("type") == "websocket.disconnect":
                        break

                    if message.get("text") is not None:
                        try:
                            data = json.loads(message["text"])
                        except json.JSONDecodeError:
                            data = {}

                        if data.get("type") == "commit":
                            await openai_ws.send(json.dumps({
                                "type": "input_audio_buffer.commit"
                            }))
                        elif data.get("type") == "ping":
                            await websocket.send_json({"type": "pong", "ts": time.time()})
                        continue

                    if message.get("bytes") is not None:
                        chunk = message["bytes"]
                        chunk_count += 1
                        total_bytes += len(chunk)

                        await openai_ws.send(json.dumps({
                            "type": "input_audio_buffer.append",
                            "audio": base64.b64encode(chunk).decode("ascii"),
                        }))

                        if chunk_count % 10 == 0:
                            print(
                                f"[PCM] chunks={chunk_count} total_bytes={total_bytes}",
                                flush=True,
                            )

                        await websocket.send_json({
                            "type": "audio_ack",
                            "chunk_count": chunk_count,
                            "chunk_bytes": len(chunk),
                            "total_bytes": total_bytes,
                            "format": "pcm16/24000",
                        })

            finally:
                if not relay_task.done():
                    relay_task.cancel()
                try:
                    await relay_task
                except asyncio.CancelledError:
                    pass

    except WebSocketDisconnect:
        pass
    except Exception as exc:
        print(f"[SESSION ERROR] {type(exc).__name__}: {exc}", flush=True)
        try:
            await websocket.send_json({
                "type": "openai_error",
                "message": str(exc),
            })
        except Exception:
            pass
    finally:
        print(
            f"[DISCONNECT] chunks={chunk_count} total_bytes={total_bytes}",
            flush=True,
        )


app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
