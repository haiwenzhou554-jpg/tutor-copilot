const $ = (id) => document.getElementById(id);
const startBtn = $('startBtn');
const stopBtn = $('stopBtn');
const testBtn = $('testBtn');
const logEl = $('log');

let ws = null;
let recorder = null;
let stream = null;
let audioContext = null;
let analyser = null;
let animationId = null;
let timerId = null;
let pingId = null;
let startedAt = null;

function log(message) {
  const t = new Date().toLocaleTimeString();
  logEl.textContent += `[${t}] ${message}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

function backendBase() {
  return window.location.origin;
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
  $('connectionText').textContent = live ? '正在监听' : '未开始';
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

function startMeter(mediaStream) {
  audioContext = new (window.AudioContext || window.webkitAudioContext)();
  const source = audioContext.createMediaStreamSource(mediaStream);
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 256;
  source.connect(analyser);
  const data = new Uint8Array(analyser.frequencyBinCount);

  const draw = () => {
    analyser.getByteFrequencyData(data);
    const avg = data.reduce((a, b) => a + b, 0) / data.length;
    $('meterFill').style.width = `${Math.min(100, avg * 1.5)}%`;
    animationId = requestAnimationFrame(draw);
  };
  draw();
}

async function testBackend() {
  try {
    log(`测试 ${backendBase()}/health`);
    const res = await fetch('/health');
    const data = await res.json();
    log(`✅ 后端正常：${JSON.stringify(data)}`);
  } catch (err) {
    log(`❌ 测试失败：${err.message}`);
  }
}

async function startListening() {
  try {
    log('请求麦克风权限...');
    stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    log('✅ 麦克风已授权');

    ws = new WebSocket(wsUrl());
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      log(`✅ WebSocket 已连接：${wsUrl()}`);

      recorder = new MediaRecorder(stream);
      $('mime').textContent = recorder.mimeType || 'browser-default';

      ws.send(JSON.stringify({
        type: 'meta',
        mimeType: recorder.mimeType || 'browser-default',
        userAgent: navigator.userAgent
      }));

      recorder.ondataavailable = async (event) => {
        if (event.data && event.data.size > 0 && ws?.readyState === WebSocket.OPEN) {
          const buffer = await event.data.arrayBuffer();
          ws.send(buffer);
        }
      };

      recorder.onerror = (event) => log(`❌ MediaRecorder：${event.error?.message || 'unknown error'}`);
      recorder.start(1000);
      updateLiveUI(true);
      startTimer();
      startMeter(stream);

      pingId = setInterval(() => {
        if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
      }, 20000);
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'connected') log(`✅ ${data.message}`);
        if (data.type === 'audio_ack') {
          $('chunks').textContent = data.chunk_count;
          $('bytes').textContent = formatBytes(data.total_bytes);
          log(`收到确认：chunk ${data.chunk_count} / ${formatBytes(data.chunk_bytes)}`);
        }
      } catch {
        log(`服务器：${event.data}`);
      }
    };

    ws.onerror = () => log('❌ WebSocket 出错');
    ws.onclose = () => {
      log('WebSocket 已断开');
      if (recorder && recorder.state !== 'inactive') recorder.stop();
      updateLiveUI(false);
    };

  } catch (err) {
    log(`❌ 启动失败：${err.name || 'Error'} - ${err.message}`);
    stopListening();
  }
}

function stopListening() {
  try {
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    if (stream) stream.getTracks().forEach((t) => t.stop());
    if (ws && ws.readyState <= WebSocket.OPEN) ws.close();
    if (animationId) cancelAnimationFrame(animationId);
    if (timerId) clearInterval(timerId);
    if (pingId) clearInterval(pingId);
    if (audioContext) audioContext.close().catch(() => {});
  } finally {
    recorder = null;
    stream = null;
    ws = null;
    $('meterFill').style.width = '0%';
    updateLiveUI(false);
    log('■ 已停止');
  }
}

testBtn.addEventListener('click', testBackend);
startBtn.addEventListener('click', startListening);
stopBtn.addEventListener('click', stopListening);
$('clearBtn').addEventListener('click', () => { logEl.textContent = ''; });

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js')
      .then(() => log('PWA Service Worker 已注册'))
      .catch((err) => log(`Service Worker 注册失败：${err.message}`));
  });
}
