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
let lastSpeechAt = 0;
let lastCommitAt = 0;
let heardSpeechSinceCommit = false;
let totalSentBytes = 0;
let totalChunks = 0;

const transcriptItems = new Map();
const transcriptOrder = [];

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
  $('connectionText').textContent = live ? '正在转录' : '未开始';
  startBtn.disabled = live;
  stopBtn.disabled = !live;
}

function startTimer() {
  startedAt = Date.now();
  timerId = setInterval(() => {
    const s = Math.floor((Date.now() - startedAt) / 1000);
    $('timer').textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }, 250);
}

function downsampleTo24k(input, inputRate) {
  const targetRate = 24000;
  if (inputRate === targetRate) return input;

  const ratio = inputRate / targetRate;
  const outputLength = Math.floor(input.length / ratio);
  const output = new Float32Array(outputLength);

  let offset = 0;
  for (let i = 0; i < outputLength; i++) {
    const nextOffset = Math.floor((i + 1) * ratio);
    let sum = 0;
    let count = 0;
    for (let j = offset; j < nextOffset && j < input.length; j++) {
      sum += input[j];
      count++;
    }
    output[i] = count ? sum / count : 0;
    offset = nextOffset;
  }

  return output;
}

function floatToPCM16(float32) {
  const buffer = new ArrayBuffer(float32.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buffer;
}

function rmsOf(data) {
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
  return Math.sqrt(sum / data.length);
}

function renderTranscript() {
  const finalLines = [];
  let partial = '';

  for (const id of transcriptOrder) {
    const item = transcriptItems.get(id);
    if (!item) continue;
    if (item.final) finalLines.push(item.final);
    else if (item.partial) partial += item.partial;
  }

  $('transcriptFinal').textContent = finalLines.join('\n');
  $('transcriptPartial').textContent = partial;
  $('transcriptBox').scrollTop = $('transcriptBox').scrollHeight;
}

function ensureTranscriptItem(id) {
  const safeId = id || `unknown-${Date.now()}`;
  if (!transcriptItems.has(safeId)) {
    transcriptItems.set(safeId, { partial: '', final: '' });
    transcriptOrder.push(safeId);
  }
  return [safeId, transcriptItems.get(safeId)];
}

function maybeCommit(rms) {
  const now = Date.now();
  const speechThreshold = 0.012;
  const silenceToCommitMs = 850;
  const maxTurnMs = 9000;

  if (rms > speechThreshold) {
    lastSpeechAt = now;
    heardSpeechSinceCommit = true;
  }

  const silentLongEnough = heardSpeechSinceCommit && now - lastSpeechAt > silenceToCommitMs;
  const turnTooLong = heardSpeechSinceCommit && now - lastCommitAt > maxTurnMs;

  if ((silentLongEnough || turnTooLong) && ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'commit' }));
    heardSpeechSinceCommit = false;
    lastCommitAt = now;
  }
}

async function testBackend() {
  try {
    const res = await fetch('/health');
    const data = await res.json();
    if (data.openai_configured) {
      log('✅ 服务器正常，OpenAI 已配置');
    } else {
      log('⚠️ 服务器正常，但还没有配置 OPENAI_API_KEY');
    }
  } catch (err) {
    log(`❌ 测试失败：${err.message}`);
  }
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
      log(`✅ WebSocket 已连接：${wsUrl()}`);

      audioContext = new (window.AudioContext || window.webkitAudioContext)();
      await audioContext.resume();

      source = audioContext.createMediaStreamSource(stream);
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;

      processor = audioContext.createScriptProcessor(4096, 1, 1);
      silentGain = audioContext.createGain();
      silentGain.gain.value = 0;

      source.connect(analyser);
      analyser.connect(processor);
      processor.connect(silentGain);
      silentGain.connect(audioContext.destination);

      lastCommitAt = Date.now();

      processor.onaudioprocess = (event) => {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;

        const input = event.inputBuffer.getChannelData(0);
        const rms = rmsOf(input);
        const downsampled = downsampleTo24k(input, audioContext.sampleRate);
        const pcm = floatToPCM16(downsampled);

        ws.send(pcm);
        totalChunks++;
        totalSentBytes += pcm.byteLength;

        $('chunks').textContent = totalChunks;
        $('bytes').textContent = formatBytes(totalSentBytes);
        $('mime').textContent = 'PCM16 · 24kHz';

        maybeCommit(rms);
      };

      const meterData = new Uint8Array(analyser.frequencyBinCount);
      const draw = () => {
        analyser.getByteFrequencyData(meterData);
        const avg = meterData.reduce((a, b) => a + b, 0) / meterData.length;
        $('meterFill').style.width = `${Math.min(100, avg * 1.5)}%`;
        animationId = requestAnimationFrame(draw);
      };
      draw();

      updateLiveUI(true);
      startTimer();

      pingId = setInterval(() => {
        if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
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

      if (data.type === 'config_error') {
        log(`❌ ${data.message}`);
      }

      if (data.type === 'transcription_status') {
        log(`OpenAI: ${data.status}`);
      }

      if (data.type === 'transcript_delta') {
        const [id, item] = ensureTranscriptItem(data.item_id);
        item.partial += data.delta || '';
        transcriptItems.set(id, item);
        renderTranscript();
      }

      if (data.type === 'transcript_final') {
        const [id, item] = ensureTranscriptItem(data.item_id);
        item.final = data.transcript || item.partial;
        item.partial = '';
        transcriptItems.set(id, item);
        renderTranscript();
      }

      if (data.type === 'openai_error') {
        log(`❌ OpenAI：${data.message}`);
      }
    };

    ws.onerror = () => log('❌ WebSocket 出错');
    ws.onclose = () => {
      log('WebSocket 已断开');
      stopAudioGraph();
      updateLiveUI(false);
    };

  } catch (err) {
    log(`❌ 启动失败：${err.name || 'Error'} - ${err.message}`);
    stopListening();
  }
}

function stopAudioGraph() {
  if (processor) processor.onaudioprocess = null;
  if (animationId) cancelAnimationFrame(animationId);
  if (timerId) clearInterval(timerId);
  if (pingId) clearInterval(pingId);
  if (stream) stream.getTracks().forEach((t) => t.stop());
  if (audioContext) audioContext.close().catch(() => {});

  processor = null;
  analyser = null;
  source = null;
  silentGain = null;
  stream = null;
  audioContext = null;
  $('meterFill').style.width = '0%';
}

function stopListening() {
  try {
    if (heardSpeechSinceCommit && ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'commit' }));
    }
    if (ws && ws.readyState <= WebSocket.OPEN) ws.close();
  } finally {
    stopAudioGraph();
    ws = null;
    updateLiveUI(false);
    log('■ 已停止');
  }
}

testBtn.addEventListener('click', testBackend);
startBtn.addEventListener('click', startListening);
stopBtn.addEventListener('click', stopListening);
$('clearBtn').addEventListener('click', () => { logEl.textContent = ''; });
$('clearTranscriptBtn').addEventListener('click', () => {
  transcriptItems.clear();
  transcriptOrder.length = 0;
  renderTranscript();
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js')
      .then(() => log('PWA Service Worker 已注册'))
      .catch((err) => log(`Service Worker 注册失败：${err.message}`));
  });
}
