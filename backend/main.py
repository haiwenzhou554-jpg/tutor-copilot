from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from pathlib import Path
import json
import math
import time

import numpy as np
import sherpa_onnx

BASE_DIR = Path(__file__).resolve().parent.parent
FRONTEND_DIR = BASE_DIR / "frontend"
MODEL_DIR = BASE_DIR / "model"

ENCODER = MODEL_DIR / "encoder.onnx"
DECODER = MODEL_DIR / "decoder.onnx"
TOKENS = MODEL_DIR / "tokens.txt"

app = FastAPI(title="Tutor Copilot Self-hosted ASR")

recognizer = None
model_error = None


@app.on_event("startup")
async def load_asr_model():
    global recognizer, model_error
    try:
        started = time.time()
        recognizer = sherpa_onnx.OnlineRecognizer.from_paraformer(
            tokens=str(TOKENS),
            encoder=str(ENCODER),
            decoder=str(DECODER),
            num_threads=1,
            sample_rate=16000,
            feature_dim=80,
            enable_endpoint_detection=True,
            rule1_min_trailing_silence=2.4,
            rule2_min_trailing_silence=1.2,
            rule3_min_utterance_length=300.0,
            decoding_method="greedy_search",
            provider="cpu",
            debug=False,
        )
        print(
            f"[MODEL] Paraformer loaded in {time.time() - started:.2f}s",
            flush=True,
        )
    except Exception as exc:
        model_error = f"{type(exc).__name__}: {exc}"
        print(f"[MODEL ERROR] {model_error}", flush=True)


@app.get("/health")
async def health():
    return {
        "ok": True,
        "mode": "sherpa-onnx-streaming-paraformer",
        "model_loaded": recognizer is not None,
        "model_error": model_error,
        "ts": time.time(),
    }


def pcm16_to_float32(chunk: bytes) -> np.ndarray:
    samples = np.frombuffer(chunk, dtype="<i2")
    return samples.astype(np.float32) / 32768.0


def audio_stats(samples: np.ndarray):
    if samples.size == 0:
        return 0.0, 0.0
    rms = float(np.sqrt(np.mean(np.square(samples), dtype=np.float64)))
    peak = float(np.max(np.abs(samples)))
    return rms, peak


def decode_available(stream):
    decode_count = 0
    while recognizer.is_ready(stream):
        recognizer.decode_stream(stream)
        decode_count += 1
    return recognizer.get_result(stream), decode_count


def finalize_stream(stream, sample_rate: int):
    tail = np.zeros(int(0.5 * sample_rate), dtype=np.float32)
    stream.accept_waveform(sample_rate, tail)
    stream.input_finished()

    while recognizer.is_ready(stream):
        recognizer.decode_stream(stream)

    return recognizer.get_result(stream)


@app.websocket("/ws/audio")
async def audio_ws(websocket: WebSocket):
    await websocket.accept()

    if recognizer is None:
        await websocket.send_json({
            "type": "model_error",
            "message": model_error or "ASR model is not loaded",
        })
        await websocket.close(code=1011)
        return

    stream = recognizer.create_stream()
    last_result = ""
    chunk_count = 0
    total_bytes = 0
    segment = 0
    input_sample_rate = 48000

    await websocket.send_json({
        "type": "connected",
        "message": "Self-hosted Paraformer ASR connected",
    })

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

                if data.get("type") == "audio_meta":
                    try:
                        input_sample_rate = int(data.get("sample_rate", 48000))
                    except (TypeError, ValueError):
                        input_sample_rate = 48000

                    print(
                        f"[AUDIO META] sample_rate={input_sample_rate}",
                        flush=True,
                    )
                    await websocket.send_json({
                        "type": "audio_meta_ack",
                        "sample_rate": input_sample_rate,
                    })
                    continue

                if data.get("type") == "ping":
                    await websocket.send_json({"type": "pong", "ts": time.time()})
                    continue

                if data.get("type") == "finish":
                    final_text = finalize_stream(stream, input_sample_rate).strip()
                    if final_text:
                        print(f"[ASR FINAL] segment={segment} text={final_text}", flush=True)
                        await websocket.send_json({
                            "type": "transcript_final",
                            "segment": segment,
                            "text": final_text,
                        })
                    await websocket.send_json({"type": "finished"})
                    break

                continue

            if message.get("bytes") is None:
                continue

            chunk = message["bytes"]
            chunk_count += 1
            total_bytes += len(chunk)

            samples = pcm16_to_float32(chunk)
            if samples.size == 0:
                continue

            stream.accept_waveform(input_sample_rate, samples)
            result, decode_count = decode_available(stream)
            result = result.strip()

            if result and result != last_result:
                last_result = result
                print(
                    f"[ASR PARTIAL] segment={segment} decodes={decode_count} text={result}",
                    flush=True,
                )
                await websocket.send_json({
                    "type": "transcript_partial",
                    "segment": segment,
                    "text": result,
                })

            if recognizer.is_endpoint(stream):
                final_text = recognizer.get_result(stream).strip()
                if final_text:
                    print(f"[ASR FINAL] segment={segment} text={final_text}", flush=True)
                    await websocket.send_json({
                        "type": "transcript_final",
                        "segment": segment,
                        "text": final_text,
                    })

                recognizer.reset(stream)
                segment += 1
                last_result = ""

            if chunk_count % 25 == 0:
                rms, peak = audio_stats(samples)
                print(
                    f"[PCM] chunks={chunk_count} total_bytes={total_bytes} "
                    f"sample_rate={input_sample_rate} rms={rms:.5f} "
                    f"peak={peak:.5f} decodes={decode_count}",
                    flush=True,
                )
                await websocket.send_json({
                    "type": "audio_ack",
                    "chunk_count": chunk_count,
                    "total_bytes": total_bytes,
                    "sample_rate": input_sample_rate,
                    "rms": rms,
                    "peak": peak,
                    "decodes": decode_count,
                })

    except WebSocketDisconnect:
        pass
    except Exception as exc:
        print(f"[ASR ERROR] {type(exc).__name__}: {exc}", flush=True)
        try:
            await websocket.send_json({
                "type": "asr_error",
                "message": f"{type(exc).__name__}: {exc}",
            })
        except Exception:
            pass
    finally:
        print(
            f"[DISCONNECT] chunks={chunk_count} total_bytes={total_bytes}",
            flush=True,
        )


app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
