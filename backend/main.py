from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from pathlib import Path
import json
import time

BASE_DIR = Path(__file__).resolve().parent.parent
FRONTEND_DIR = BASE_DIR / "frontend"

app = FastAPI(title="Tutor Copilot Browser Speech MVP")


@app.get("/health")
async def health():
    return {
        "ok": True,
        "mode": "browser-speech-recognition",
        "ts": time.time(),
    }


@app.websocket("/ws/transcript")
async def transcript_ws(websocket: WebSocket):
    await websocket.accept()
    count = 0
    try:
        await websocket.send_json({
            "type": "connected",
            "message": "Transcript WebSocket connected"
        })

        while True:
            message = await websocket.receive()

            if message.get("type") == "websocket.disconnect":
                break

            if message.get("text") is None:
                continue

            try:
                data = json.loads(message["text"])
            except json.JSONDecodeError:
                continue

            if data.get("type") == "ping":
                await websocket.send_json({"type": "pong", "ts": time.time()})
                continue

            if data.get("type") == "transcript":
                count += 1
                text_value = data.get("text", "")
                is_final = bool(data.get("final", False))
                confidence = data.get("confidence")

                print(
                    f"[TRANSCRIPT] #{count} final={is_final} "
                    f"confidence={confidence} text={text_value}",
                    flush=True,
                )

                await websocket.send_json({
                    "type": "transcript_ack",
                    "count": count,
                    "text": text_value,
                    "final": is_final,
                    "confidence": confidence,
                })

    except WebSocketDisconnect:
        pass
    finally:
        print(f"[DISCONNECT] transcript_messages={count}", flush=True)


app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
