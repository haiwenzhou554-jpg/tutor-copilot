FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl bzip2 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

RUN mkdir -p /app/model /tmp/asr-model \
    && curl -L --retry 3 \
      -o /tmp/asr-model/model.tar.bz2 \
      https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-paraformer-bilingual-zh-en.tar.bz2 \
    && tar -xjf /tmp/asr-model/model.tar.bz2 -C /tmp/asr-model \
    && cp /tmp/asr-model/sherpa-onnx-streaming-paraformer-bilingual-zh-en/encoder.int8.onnx /app/model/encoder.onnx \
    && cp /tmp/asr-model/sherpa-onnx-streaming-paraformer-bilingual-zh-en/decoder.int8.onnx /app/model/decoder.onnx \
    && cp /tmp/asr-model/sherpa-onnx-streaming-paraformer-bilingual-zh-en/tokens.txt /app/model/tokens.txt \
    && rm -rf /tmp/asr-model

COPY . /app

CMD ["sh", "-c", "uvicorn backend.main:app --host 0.0.0.0 --port ${PORT:-8080}"]
