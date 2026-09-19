const $ = (id) => document.getElementById(id);
const startBtn = $('startBtn');
const stopBtn = $('stopBtn');
const testBtn = $('testBtn');
const logEl = $('log');

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

let recognition = null;
let ws = null;
let running = false;
let timerId = null;
let pingId = null;
let startedAt = null;
let finalText = '';
let lastInterim = '';
let sentCount = 0;

function log(message) {
  const t = new Date().toLocaleTimeString();
  logEl.textContent += `[${t}] ${message}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

function wsUrl() {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/ws/transcript`;
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
  $('transcriptFinal').textContent = finalText;
  $('transcriptPartial').textContent = lastInterim || (running ? '正在听…' : '等待语音…');
  $('transcriptBox').scrollTop = $('transcriptBox').scrollHeight;
}

function sendTranscript(text, final, confidence = null) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  ws.send(JSON.stringify({
    type: 'transcript',
    text,
    final,
    confidence,
    ts: Date.now()
  }));

  sentCount += 1;
  $('chunks').textContent = sentCount;
}

async function testBackend() {
  try {
    const res = await fetch('/health');
    const data = await res.json();

    if (!SpeechRecognition) {
      log('⚠️ 服务器正常，但当前浏览器不支持 SpeechRecognition。请改用 Chrome。');
      return;
    }

    log(`✅ 服务器正常：${data.mode}`);
    log('✅ 当前浏览器支持 SpeechRecognition');
  } catch (err) {
    log(`❌ 测试失败：${err.message}`);
  }
}

function createRecognition() {
  if (!SpeechRecognition) {
    throw new Error('当前浏览器不支持 SpeechRecognition，请用 Chrome 打开。');
  }

  const rec = new SpeechRecognition();
  rec.lang = 'zh-CN';
  rec.continuous = true;
  rec.interimResults = true;
  rec.maxAlternatives = 1;

  rec.onstart = () => {
    log('✅ 浏览器语音识别已启动');
    $('mime').textContent = 'Web Speech · zh-CN';
  };

  rec.onspeechstart = () => {
    $('meterFill').style.width = '85%';
  };

  rec.onspeechend = () => {
    $('meterFill').style.width = '20%';
  };

  rec.onresult = (event) => {
    let interim = '';

    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      const transcript = result[0].transcript || '';
      const confidence = Number.isFinite(result[0].confidence) ? result[0].confidence : null;

      if (result.isFinal) {
        finalText += (finalText ? '\n' : '') + transcript.trim();
        sendTranscript(transcript.trim(), true, confidence);
      } else {
        interim += transcript;
      }
    }

    lastInterim = interim.trim();

    if (lastInterim) {
      sendTranscript(lastInterim, false, null);
    }

    renderTranscript();
  };

  rec.onerror = (event) => {
    log(`❌ 语音识别错误：${event.error}`);
    if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
      running = false;
      updateLiveUI(false);
    }
  };

  rec.onend = () => {
    $('meterFill').style.width = '0%';

    if (running) {
      try {
        rec.start();
        log('↻ 识别服务自动重连');
      } catch (_) {}
    } else {
      log('语音识别已停止');
    }
  };

  return rec;
}

function connectTranscriptSocket() {
  return new Promise((resolve, reject) => {
    ws = new WebSocket(wsUrl());

    ws.onopen = () => {
      log(`✅ FastAPI WebSocket 已连接：${wsUrl()}`);
      pingId = setInterval(() => {
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'ping' }));
        }
      }, 20000);
      resolve();
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'connected') {
          log(`✅ ${data.message}`);
        }
        if (data.type === 'transcript_ack') {
          $('bytes').textContent = `${data.count} 条`;
        }
      } catch (_) {}
    };

    ws.onerror = () => reject(new Error('WebSocket 连接失败'));

    ws.onclose = () => {
      if (pingId) clearInterval(pingId);
      log('FastAPI WebSocket 已断开');
    };
  });
}

async function startListening() {
  try {
    if (!SpeechRecognition) {
      throw new Error('当前浏览器不支持语音识别。请复制网址到 Chrome 打开，不要使用微信内置浏览器。');
    }

    await connectTranscriptSocket();

    recognition = createRecognition();
    running = true;
    recognition.start();

    updateLiveUI(true);
    startTimer();
    renderTranscript();

  } catch (err) {
    log(`❌ 启动失败：${err.message}`);
    stopListening();
  }
}

function stopListening() {
  running = false;

  try {
    if (recognition) recognition.stop();
  } catch (_) {}

  recognition = null;

  if (ws && ws.readyState <= WebSocket.OPEN) {
    ws.close();
  }
  ws = null;

  if (timerId) clearInterval(timerId);
  if (pingId) clearInterval(pingId);

  timerId = null;
  pingId = null;

  $('meterFill').style.width = '0%';
  updateLiveUI(false);
  renderTranscript();
  log('■ 已停止');
}

testBtn.addEventListener('click', testBackend);
startBtn.addEventListener('click', startListening);
stopBtn.addEventListener('click', stopListening);

$('clearBtn').addEventListener('click', () => {
  logEl.textContent = '';
});

$('clearTranscriptBtn').addEventListener('click', () => {
  finalText = '';
  lastInterim = '';
  sentCount = 0;
  $('chunks').textContent = '0';
  $('bytes').textContent = '0 条';
  renderTranscript();
});

window.addEventListener('load', () => {
  if (!SpeechRecognition) {
    log('⚠️ 当前浏览器没有 SpeechRecognition。建议使用 Android Chrome。');
  } else {
    log('✅ 浏览器语音识别能力已检测到');
  }
});
