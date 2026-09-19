const $ = (id) => document.getElementById(id);

const startBtn = $('startBtn');
const stopBtn = $('stopBtn');
const testBtn = $('testBtn');
const refreshMicsBtn = $('refreshMicsBtn');
const micSelect = $('micSelect');
const logEl = $('log');

let ws = null;
let stream = null;
let audioContext = null;
let source = null;
let analyser = null;
let processor = null;
let keepAliveGain = null;
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
  micSelect.disabled = live;
  refreshMicsBtn.disabled = live;
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
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buffer;
}

function rmsOf(float32) {
  let sum = 0;
  for (let i = 0; i < float32.length; i++) sum += float32[i] * float32[i];
  return Math.sqrt(sum / Math.max(1, float32.length));
}

async function populateMicrophones() {
  try {
    // Request permission once so device labels become visible.
    const temp = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    temp.getTracks().forEach((t) => t.stop());

    const devices = await navigator.mediaDevices.enumerateDevices();
    const mics = devices.filter((d) => d.kind === 'audioinput');

    micSelect.innerHTML = '';

    if (!mics.length) {
      const option = document.createElement('option');
      option.textContent = '没有检测到麦克风';
      option.value = '';
      micSelect.appendChild(option);
      log('❌ 没有检测到音频输入设备');
      return;
    }

    mics.forEach((mic, idx) => {
      const option = document.createElement('option');
      option.value = mic.deviceId;
      option.textContent = mic.label || `麦克风 ${idx + 1}`;
      micSelect.appendChild(option);
    });

    log(`✅ 检测到 ${mics.length} 个麦克风输入设备`);
  } catch (err) {
    log(`❌ 读取麦克风列表失败：${err.message}`);
  }
}

async function testBackend() {
  try {
    const res = await fetch('/health', { cache: 'no-store' });
    const data = await res.json();
    log(data.model_loaded
      ? '✅ 服务器正常，Paraformer 中文识别模型已加载'
      : `❌ 模型未加载：${data.model_error || 'unknown'}`);
  } catch (err) {
    log(`❌ 测试失败：${err.message}`);
  }
}

async function setupAudioGraph(mediaStream) {
  audioContext = new (window.AudioContext || window.webkitAudioContext)();
  await audioContext.resume();

  source = audioContext.createMediaStreamSource(mediaStream);
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 256;

  processor = audioContext.createScriptProcessor(4096, 1, 1);

  // Keep graph alive with an inaudible-but-nonzero output path.
  keepAliveGain = audioContext.createGain();
  keepAliveGain.gain.value = 0.000001;

  source.connect(processor);
  source.connect(analyser);
  processor.connect(keepAliveGain);
  keepAliveGain.connect(audioContext.destination);

  ws.send(JSON.stringify({
    type: 'audio_meta',
    sample_rate: audioContext.sampleRate,
    device_label: stream.getAudioTracks()[0]?.label || ''
  }));

  let diagnosticCounter = 0;

  processor.onaudioprocess = (event) => {
    if (!running || !ws || ws.readyState !== WebSocket.OPEN) return;

    const input = event.inputBuffer.getChannelData(0);
    const browserRms = rmsOf(input);
    const pcm = floatToPCM16(input);

    ws.send(pcm);
    totalChunks += 1;
    totalSentBytes += pcm.byteLength;
    diagnosticCounter += 1;

    $('chunks').textContent = totalChunks;
    $('bytes').textContent = formatBytes(totalSentBytes);
    $('mime').textContent = `PCM16 · ${audioContext.sampleRate}Hz`;
    $('clientRms').textContent = `RMS ${browserRms.toFixed(5)}`;

    // Use direct RMS for the visual meter, not only the AnalyserNode.
    $('meterFill').style.width = `${Math.min(100, browserRms * 900)}%`;

    if (diagnosticCounter % 25 === 0) {
      ws.send(JSON.stringify({
        type: 'client_audio_diag',
        rms: browserRms,
        device_label: stream.getAudioTracks()[0]?.label || ''
      }));
      log(`浏览器采音 RMS：${browserRms.toFixed(5)}`);
    }
  };
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
  keepAliveGain = null;
  stream = null;
  audioContext = null;
  timerId = null;
  pingId = null;

  $('meterFill').style.width = '0%';
  $('clientRms').textContent = 'RMS 0.00000';
}

async function startListening() {
  try {
    const selectedDeviceId = micSelect.value;

    if (!selectedDeviceId) {
      throw new Error('请先选择一个麦克风设备');
    }

    log('请求选定麦克风...');

    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: { exact: selectedDeviceId }
      },
      video: false,
    });

    const track = stream.getAudioTracks()[0];
    const settings = track?.getSettings ? track.getSettings() : {};

    log(`✅ 当前麦克风：${track?.label || '未知'}`);
    log(`🎤 设置：${JSON.stringify(settings)}`);

    ws = new WebSocket(wsUrl());
    ws.binaryType = 'arraybuffer';

    ws.onopen = async () => {
      log('✅ 已连接自托管 ASR');
      running = true;
      updateLiveUI(true);
      startTimer();

      await setupAudioGraph(stream);

      log(`🎙️ AudioContext 采样率：${audioContext.sampleRate} Hz`);

      pingId = setInterval(() => {
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'ping' }));
        }
      }, 20000);
    };

    ws.onmessage = (event) => {
      let data;
      try { data = JSON.parse(event.data); } catch { return; }

      if (data.type === 'connected') log(`✅ ${data.message}`);
      if (data.type === 'audio_meta_ack') log(`✅ 服务器按 ${data.sample_rate} Hz 接收音频`);
      if (data.type === 'model_error') log(`❌ 模型：${data.message}`);
      if (data.type === 'asr_error') log(`❌ ASR：${data.message}`);

      if (data.type === 'transcript_partial') {
        partialText = data.text || '';
        renderTranscript();
      }

      if (data.type === 'transcript_final') {
        const text = (data.text || '').trim();
        if (text) finalSegments.push(text);
        partialText = '';
        renderTranscript();
      }

      if (data.type === 'audio_ack') {
        log(`服务器处理 ${data.chunk_count} 块 · RMS ${Number(data.rms).toFixed(4)} · Peak ${Number(data.peak).toFixed(3)} · decode ${data.decodes}`);
      }

      if (data.type === 'finished') {
        log('✅ 最后一段识别完成');
        if (ws?.readyState === WebSocket.OPEN) ws.close();
      }
    };

    ws.onerror = () => log('❌ WebSocket 出错');

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
      if (ws?.readyState === WebSocket.OPEN) ws.close();
    }, 1500);
  } else {
    ws = null;
  }

  renderTranscript();
  log('■ 停止采集，正在完成最后一段识别');
}

testBtn.addEventListener('click', testBackend);
refreshMicsBtn.addEventListener('click', populateMicrophones);
startBtn.addEventListener('click', startListening);
stopBtn.addEventListener('click', stopListening);

$('clearBtn').addEventListener('click', () => { logEl.textContent = ''; });
$('clearTranscriptBtn').addEventListener('click', () => {
  finalSegments = [];
  partialText = '';
  totalChunks = 0;
  totalSentBytes = 0;
  $('chunks').textContent = '0';
  $('bytes').textContent = '0 KB';
  renderTranscript();
});

window.addEventListener('load', populateMicrophones);
