from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from pathlib import Path
import json
import time

BASE_DIR = Path(__file__).resolve().parent.parent
FRONTEND_DIR = BASE_DIR / "frontend"

app = FastAPI(title="Tutor Copilot Audio Receiver")

@app.get("/health")
async def health():
    return {"ok": True, "ts": time.time()}

@app.websocket("/ws/audio")
async def audio_ws(websocket: WebSocket):
    await websocket.accept()
    total_bytes = 0
    chunk_count = 0
    mime_type = "unknown"

    await websocket.send_json({
        "type": "connected",
        "message": "FastAPI WebSocket connected"
    })

    try:
        while True:
            message = await websocket.receive()

            if message.get("text") is not None:
                try:
                    data = json.loads(message["text"])
                except json.JSONDecodeError:
                    data = {"type": "text", "value": message["text"]}

                if data.get("type") == "meta":
                    mime_type = data.get("mimeType", "unknown")
                    print(f"[META] mimeType={mime_type}", flush=True)
                    await websocket.send_json({
                        "type": "meta_ack",
                        "mimeType": mime_type
                    })
                elif data.get("type") == "ping":
                    await websocket.send_json({"type": "pong", "ts": time.time()})
                continue

            if message.get("bytes") is not None:
                chunk = message["bytes"]
                chunk_count += 1
                total_bytes += len(chunk)

                print(
                    f"[AUDIO] chunk={chunk_count} bytes={len(chunk)} "
                    f"total={total_bytes} mime={mime_type}",
                    flush=True,
                )

                await websocket.send_json({
                    "type": "audio_ack",
                    "chunk_count": chunk_count,
                    "chunk_bytes": len(chunk),
                    "total_bytes": total_bytes,
                    "mimeType": mime_type,
                })

    except WebSocketDisconnect:
        print(
            f"[DISCONNECT] chunks={chunk_count} total_bytes={total_bytes}",
            flush=True,
        )

app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
