# Tutor Copilot PWA Starter

MVP 0.1: phone microphone -> MediaRecorder -> WebSocket -> FastAPI.

Deployed as a single Railway service. FastAPI serves both the PWA frontend and the WebSocket backend.

## Local run
```bash
pip install -r requirements.txt
uvicorn backend.main:app --reload
```

Open http://127.0.0.1:8000
