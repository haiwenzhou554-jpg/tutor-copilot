const $ = (id) => document.getElementById(id);

const startBtn = $('startBtn');
const stopBtn = $('stopBtn');
const testBtn = $('testBtn');
const logEl = $('log');

let ws = null;
let stream = null;
let audioContext = null;
let source = null;
let analyser = null;
let processor = null;
let silentGain = null;
let animationId = null;
let timerId = null;
let pingId = null;
let startedAt = null;
let running = false;

let totalSentBytes = 0;
let totalChunks = 0;
let finalSegments = [];
let partialText = '';

function log(message) {
  const t = new Date().toLocaleTimeString();
  logEl.textContent += `[${t}] ${message}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

function wsUrl() {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/ws/audio`;
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function updateLiveUI(live) {
  $('statusDot').className = `status-dot ${live ? 'live' : 'idle'}`;
  $('connectionText').textContent = live ? '正在识别' : '未开始';
  startBtn.disabled = live;
  stopBtn.disabled = !live;
}

function startTimer() {
  startedAt = Date.now();
  timerId = setInterval(() => {
    const s = Math.floor((Date.now() - startedAt) / 1000);
    $('timer').textContent =
      `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }, 250);
}

function renderTranscript() {
  $('transcriptFinal').textContent = finalSegments.join('\n');
  $('transcriptPartial').textContent =
    partialText || (running ? '正在听…' : '等待语音…');
  $('transcriptBox').scrollTop = $('transcriptBox').scrollHeight;
}

function floatToPCM16(float32) {
  const buffer = new ArrayBuffer(float32.length * 2);
  const view = new DataView(buffer);

  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    view.setInt16(
      i * 2,
      s < 0 ? s * 0x8000 : s * 0x7fff,
      true
    );
  }

  return buffer;
}

async function testBackend() {
  try {
    const res = await fetch('/health', { cache: 'no-store' });
    const data = await res.json();

    if (data.model_loaded) {
      log('✅ 服务器正常，Paraformer 中文识别模型已加载');
    } else {
      log(`❌ 模型未加载：${data.model_error || 'unknown'}`);
    }
  } catch (err) {
    log(`❌ 测试失败：${err.message}`);
  }
}

function setupAudioGraph(mediaStream) {
  audioContext = new (window.AudioContext || window.webkitAudioContext)();

  source = audioContext.createMediaStreamSource(mediaStream);
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 256;

  processor = audioContext.createScriptProcessor(4096, 1, 1);
  silentGain = audioContext.createGain();
  silentGain.gain.value = 0;

  source.connect(analyser);
  analyser.connect(processor);
  processor.connect(silentGain);
  silentGain.connect(audioContext.destination);

  ws.send(JSON.stringify({
    type: 'audio_meta',
    sample_rate: audioContext.sampleRate
  }));

  processor.onaudioprocess = (event) => {
    if (!running || !ws || ws.readyState !== WebSocket.OPEN) return;

    const input = event.inputBuffer.getChannelData(0);
    const pcm = floatToPCM16(input);

    ws.send(pcm);
    totalChunks += 1;
    totalSentBytes += pcm.byteLength;

    $('chunks').textContent = totalChunks;
    $('bytes').textContent = formatBytes(totalSentBytes);
    $('mime').textContent = `PCM16 · ${audioContext.sampleRate}Hz`;
  };

  const meterData = new Uint8Array(analyser.frequencyBinCount);
  const draw = () => {
    analyser.getByteFrequencyData(meterData);
    const avg =
      meterData.reduce((a, b) => a + b, 0) / meterData.length;

    $('meterFill').style.width =
      `${Math.min(100, avg * 1.5)}%`;

    animationId = requestAnimationFrame(draw);
  };

  draw();
}

function stopAudioGraph() {
  if (processor) processor.onaudioprocess = null;
  if (animationId) cancelAnimationFrame(animationId);
  if (timerId) clearInterval(timerId);
  if (pingId) clearInterval(pingId);
  if (stream) stream.getTracks().forEach((t) => t.stop());

  if (audioContext) {
    audioContext.close().catch(() => {});
  }

  processor = null;
  analyser = null;
  source = null;
  silentGain = null;
  stream = null;
  audioContext = null;
  timerId = null;
  pingId = null;

  $('meterFill').style.width = '0%';
}

async function startListening() {
  try {
    log('请求麦克风权限...');

    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });

    log('✅ 麦克风已授权');

    ws = new WebSocket(wsUrl());
    ws.binaryType = 'arraybuffer';

    ws.onopen = async () => {
      log('✅ 已连接自托管 ASR');
      running = true;
      updateLiveUI(true);
      startTimer();

      setupAudioGraph(stream);
      await audioContext.resume();

      log(`🎙️ 浏览器采样率：${audioContext.sampleRate} Hz`);

      pingId = setInterval(() => {
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'ping' }));
        }
      }, 20000);
    };

    ws.onmessage = (event) => {
      let data;

      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }

      if (data.type === 'connected') {
        log(`✅ ${data.message}`);
      }

      if (data.type === 'audio_meta_ack') {
        log(`✅ 服务器按 ${data.sample_rate} Hz 接收音频`);
      }

      if (data.type === 'model_error') {
        log(`❌ 模型：${data.message}`);
      }

      if (data.type === 'asr_error') {
        log(`❌ ASR：${data.message}`);
      }

      if (data.type === 'transcript_partial') {
        partialText = data.text || '';
        renderTranscript();
      }

      if (data.type === 'transcript_final') {
        const text = (data.text || '').trim();

        if (text) {
          finalSegments.push(text);
        }

        partialText = '';
        renderTranscript();
      }

      if (data.type === 'audio_ack') {
        log(
          `服务器处理 ${data.chunk_count} 块 · RMS ${Number(data.rms).toFixed(4)} · Peak ${Number(data.peak).toFixed(3)} · decode ${data.decodes}`
        );
      }

      if (data.type === 'finished') {
        log('✅ 最后一段识别完成');
        if (ws?.readyState === WebSocket.OPEN) {
          ws.close();
        }
      }
    };

    ws.onerror = () => {
      log('❌ WebSocket 出错');
    };

    ws.onclose = () => {
      log('ASR 连接已断开');
      running = false;
      stopAudioGraph();
      updateLiveUI(false);
      renderTranscript();
    };

  } catch (err) {
    log(`❌ 启动失败：${err.name || 'Error'} - ${err.message}`);
    stopListening();
  }
}

function stopListening() {
  running = false;
  stopAudioGraph();
  updateLiveUI(false);

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'finish' }));

    setTimeout(() => {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.close();
      }
    }, 1500);
  } else {
    ws = null;
  }

  renderTranscript();
  log('■ 停止采集，正在完成最后一段识别');
}

testBtn.addEventListener('click', testBackend);
startBtn.addEventListener('click', startListening);
stopBtn.addEventListener('click', stopListening);

$('clearBtn').addEventListener('click', () => {
  logEl.textContent = '';
});

$('clearTranscriptBtn').addEventListener('click', () => {
  finalSegments = [];
  partialText = '';
  totalChunks = 0;
  totalSentBytes = 0;

  $('chunks').textContent = '0';
  $('bytes').textContent = '0 KB';

  renderTranscript();
});
