/**
 * app.js — OTA Support Web UI
 * Handles: welcome screen, chat, call state machine (fixed),
 *          history, feedback, stats, report download, audio recording
 */

// ══════════════════════════════════════════════════════
// STATE
// ══════════════════════════════════════════════════════
const state = {
  mode:              'chat',
  callActive:        false,
  callSeconds:       0,
  callTimer:         null,
  callStartTimeout:  null,   // setTimeout handle for the "connecting" delay
  typewriterIv:      null,   // setInterval handle for transcript typewriter
  muted:             false,
  speakerOn:         true,
  starRating:        0,
  sessions:          0,
  resolved:          0,
  history:           [],     // { id, snippet, time, type, status }
  chatLog:           [],     // { role, text, time } — for report export
  callTranscriptText:'',     // captured transcript text for the report
  mediaRecorder:     null,   // records the WHOLE call (customer mic)
  audioChunks:       [],
  callStream:        null,   // MediaStream from the microphone
  audioCtx:          null,
  analyser:          null,
  vadThreshold:      0.02,
  callRunId:         0,      // invalidates a running call loop when it ends
  callLive:          false,  // true once the mic is open and the loop runs
  callTurns:         [],     // booleans: was each customer turn resolved?
  speechToken:       0,
};

// ══════════════════════════════════════════════════════
// DOM REFS
// ══════════════════════════════════════════════════════
const $ = id => document.getElementById(id);

const welcomeScreen   = $('welcome-screen');
const appWrapper      = $('app-wrapper');
const btnEnter        = $('btn-enter');

const chatMessages    = $('chat-messages');
const chatInput       = $('chat-input');
const btnSend         = $('btn-send');
const btnChatMode     = $('btn-chat-mode');
const btnCallMode     = $('btn-call-mode');
const panelChat       = $('panel-chat');
const panelCall       = $('panel-call');
const btnCallToggle   = $('btn-call-toggle');
const callIcon        = $('call-icon');
const callStateLabel  = $('call-state-label');
const callTimerEl     = $('call-timer');
const callAvatarRing  = $('call-avatar-ring');
const waveform        = $('waveform');
const callTranscript  = $('call-transcript');
const btnMute         = $('btn-mute');
const btnSpeaker      = $('btn-speaker');
const btnDownloadCall = $('btn-download-call');
const historyList     = $('history-list');
const historyEmpty    = $('history-empty');
const btnClearHistory = $('btn-clear-history');
const starsRow        = $('stars-row');
const feedbackText    = $('feedback-text');
const btnSubmitFb     = $('btn-submit-feedback');
const feedbackConfirm = $('feedback-confirm');
const statSessions    = $('stat-sessions');
const statResolved    = $('stat-resolved');
const statRating      = $('stat-rating');
const quickActions    = $('quick-actions');
const btnExportChat   = $('btn-export-chat');
const toastEl         = $('toast');
const statusDot       = $('status-dot');
const statusLabel     = $('status-label');
const settingsModal   = $('settings-modal');
const setName         = $('set-name');
const setLang         = $('set-lang');
const setRead         = $('set-read');

// ══════════════════════════════════════════════════════
// SETTINGS (saved in this browser)
// ══════════════════════════════════════════════════════
const SETTINGS_KEY = 'ag_settings';
const settings = { name: '', language: 'en', readReplies: false };
try {
  Object.assign(settings, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'));
} catch (_) { /* storage unavailable — keep defaults */ }

function customerName() { return (settings.name || '').trim() || 'Web User'; }
function sttLanguage()  { return settings.language === 'auto' ? '' : settings.language; }

function openSettings() {
  setName.value    = settings.name;
  setLang.value    = settings.language;
  setRead.checked  = settings.readReplies;
  settingsModal.classList.remove('hidden');
  setName.focus();
}
function closeSettings() { settingsModal.classList.add('hidden'); }

$('btn-settings').addEventListener('click', openSettings);
$('set-cancel').addEventListener('click', closeSettings);
settingsModal.addEventListener('click', e => { if (e.target === settingsModal) closeSettings(); });
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !settingsModal.classList.contains('hidden')) closeSettings();
});
$('set-save').addEventListener('click', () => {
  settings.name        = setName.value.trim().slice(0, 40);
  settings.language    = setLang.value;
  settings.readReplies = setRead.checked;
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (_) {}
  closeSettings();
  showToast('✓ Settings saved');
});

// ══════════════════════════════════════════════════════
// WELCOME SCREEN
// ══════════════════════════════════════════════════════
btnEnter.addEventListener('click', () => {
  welcomeScreen.classList.add('fade-out');
  // Show app simultaneously
  appWrapper.style.display = 'flex';
  setTimeout(() => {
    welcomeScreen.style.display = 'none';
  }, 650);
});

// ══════════════════════════════════════════════════════
// TOAST
// ══════════════════════════════════════════════════════
let toastTimeout = null;
function showToast(msg, duration = 3000) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => toastEl.classList.remove('show'), duration);
}

// ══════════════════════════════════════════════════════
// UTILITY
// ══════════════════════════════════════════════════════
function nowTime() {
  return new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}
function nowFull() {
  return new Date().toLocaleString('en-GB', {
    day:'2-digit', month:'short', year:'numeric',
    hour:'2-digit', minute:'2-digit', second:'2-digit'
  });
}
function formatSeconds(s) {
  const m   = String(Math.floor(s / 60)).padStart(2, '0');
  const sec = String(s % 60).padStart(2, '0');
  return `${m}:${sec}`;
}
function uid() {
  return Math.random().toString(36).slice(2, 9);
}

// ══════════════════════════════════════════════════════
// FILE DOWNLOAD HELPER
// ══════════════════════════════════════════════════════
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href     = url;
  a.download  = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ══════════════════════════════════════════════════════
// CHAT REPORT EXPORT
// ══════════════════════════════════════════════════════
function exportChatReport() {
  if (!state.chatLog.length) {
    showToast('No conversation to export yet.');
    return;
  }
  const lines = state.chatLog.map(m =>
    `[${m.time}]  ${m.role === 'agent' ? 'OTA Support' : 'You'}: ${m.text}`
  ).join('\n');

  const report = [
    'OTA SUPPORT — CONVERSATION REPORT',
    '═'.repeat(50),
    `Generated  : ${nowFull()}`,
    `Agent      : OTA Support AI`,
    `Channel    : Chat`,
    `Sessions   : ${state.sessions}`,
    `Resolved   : ${state.resolved} / ${state.sessions}`,
    `Rating     : ${state.starRating > 0 ? state.starRating + '/5 stars' : 'Not rated'}`,
    '═'.repeat(50),
    'CONVERSATION TRANSCRIPT',
    '─'.repeat(50),
    lines,
    '─'.repeat(50),
    '',
    'OTA Support v1.0 — Confidential',
  ].join('\n');

  const blob = new Blob([report], { type: 'text/plain;charset=utf-8' });
  downloadBlob(blob, `ota-chat-report-${Date.now()}.txt`);
  showToast('✓ Chat report downloaded');
}

btnExportChat.addEventListener('click', exportChatReport);

// ══════════════════════════════════════════════════════
// CALL REPORT EXPORT
// ══════════════════════════════════════════════════════
function exportCallReport(durationSecs) {
  const dur = formatSeconds(durationSecs);
  const report = [
    'OTA SUPPORT — CALL REPORT',
    '═'.repeat(50),
    `Generated  : ${nowFull()}`,
    `Duration   : ${dur}`,
    `Agent      : OTA Support AI`,
    `Channel    : Voice Call`,
    '═'.repeat(50),
    'LIVE TRANSCRIPT',
    '─'.repeat(50),
    state.callTranscriptText || 'No transcript captured.',
    '─'.repeat(50),
    '',
    'OTA Support v1.0 — Confidential',
  ].join('\n');

  const blob = new Blob([report], { type: 'text/plain;charset=utf-8' });
  downloadBlob(blob, `ota-call-report-${Date.now()}.txt`);
  showToast('✓ Call report downloaded');
}

btnDownloadCall.addEventListener('click', () => {
  exportCallReport(state.callSeconds);
});

// ══════════════════════════════════════════════════════
// AUDIO RECORDING (via MediaRecorder API)
// ══════════════════════════════════════════════════════
function pickMime() {
  const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
  return (window.MediaRecorder && types.find(t => MediaRecorder.isTypeSupported(t))) || '';
}

// Records the whole call (customer microphone) for the downloadable file
function startAudioRecording(stream) {
  try {
    const mime = pickMime();
    state.mediaRecorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    state.audioChunks   = [];
    state.mediaRecorder.ondataavailable = e => {
      if (e.data.size > 0) state.audioChunks.push(e.data);
    };
    state.mediaRecorder.start();
  } catch (err) {
    console.warn('[OTA] Call recording unavailable:', err.message);
    state.mediaRecorder = null;
  }
}

function stopAudioRecording() {
  return new Promise(resolve => {
    const rec = state.mediaRecorder;
    if (!rec || rec.state === 'inactive') { resolve(null); return; }
    rec.onstop = () => {
      const blob = new Blob(state.audioChunks, { type: rec.mimeType || 'audio/webm' });
      state.mediaRecorder = null;
      resolve(blob);
    };
    rec.stop();
  });
}

// ══════════════════════════════════════════════════════
// CHAT — render messages
// ══════════════════════════════════════════════════════
function renderMessage(role, text, time = nowTime()) {
  // Log for report export
  state.chatLog.push({ role, text, time });

  const row = document.createElement('div');
  row.className = `bubble-row ${role}`;

  const avatar = document.createElement('div');
  avatar.className = 'bubble-avatar';
  avatar.textContent = role === 'agent' ? 'OA' : 'ME';

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = text;

  const meta = document.createElement('div');
  meta.className = 'bubble-meta';
  meta.textContent = time;

  const inner = document.createElement('div');
  inner.appendChild(bubble);
  inner.appendChild(meta);

  if (role === 'agent') {
    row.appendChild(avatar);
    row.appendChild(inner);
  } else {
    row.appendChild(inner);
    row.appendChild(avatar);
  }

  chatMessages.appendChild(row);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  return row;
}

function showTyping() {
  const row = document.createElement('div');
  row.className = 'bubble-row agent';
  row.id = 'typing-row';

  const avatar = document.createElement('div');
  avatar.className = 'bubble-avatar';
  avatar.textContent = 'OA';

  const indicator = document.createElement('div');
  indicator.className = 'typing-indicator';
  for (let i = 0; i < 3; i++) {
    const d = document.createElement('div');
    d.className = 'typing-dot';
    indicator.appendChild(d);
  }

  row.appendChild(avatar);
  row.appendChild(indicator);
  chatMessages.appendChild(row);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function removeTyping() {
  const t = $('typing-row');
  if (t) t.remove();
}

// Same origin as the page (python main.py --api serves both)
const API_URL = '';

async function apiCall(text) {
  const res = await fetch(`${API_URL}/call`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ customer_input: text, customer_name: customerName() })
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function sendMessage(text) {
  if (!text.trim()) return;
  text = text.trim();

  renderMessage('user', text);
  chatInput.value = '';
  chatInput.style.height = '';
  if (quickActions) quickActions.style.display = 'none';

  showTyping();

  try {
    const data = await apiCall(text);
    removeTyping();
    renderMessage('agent', data.reply);

    if (settings.readReplies && state.speakerOn) speakText(data.reply);

    addHistoryItem({
      id:      data.call_id,
      snippet: text.slice(0, 45),
      time:    nowTime(),
      type:    'chat',
      status:  data.resolved ? 'resolved' : 'escalated'
    });
    updateStats(data.resolved);
  } catch (err) {
    console.error('[API] /call failed:', err);
    removeTyping();
    renderMessage('agent', "Sorry, I can't reach the server right now. Please try again in a moment.");
  }
}

// Auto-resize textarea
chatInput.addEventListener('input', () => {
  chatInput.style.height = 'auto';
  chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + 'px';
});

chatInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage(chatInput.value);
  }
});

btnSend.addEventListener('click', () => sendMessage(chatInput.value));

document.querySelectorAll('.quick-btn').forEach(btn => {
  btn.addEventListener('click', () => sendMessage(btn.dataset.msg));
});

// ══════════════════════════════════════════════════════
// MODE SWITCH
// ══════════════════════════════════════════════════════
function switchMode(mode) {
  state.mode = mode;
  btnChatMode.classList.toggle('active', mode === 'chat');
  btnCallMode.classList.toggle('active', mode === 'call');
  btnChatMode.setAttribute('aria-selected', mode === 'chat');
  btnCallMode.setAttribute('aria-selected', mode === 'call');
  panelChat.classList.toggle('hidden', mode !== 'chat');
  panelCall.classList.toggle('hidden', mode !== 'call');
}

btnChatMode.addEventListener('click', () => switchMode('chat'));
btnCallMode.addEventListener('click', () => switchMode('call'));

// ══════════════════════════════════════════════════════
// CALL STATE MACHINE   ← FIXED
// ══════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════
// TEXT-TO-SPEECH (browser voices)
// ══════════════════════════════════════════════════════
function pickLang(text) {
  if (/[\u0600-\u06FF]/.test(text)) return 'ar-SA';
  return settings.language === 'fr' ? 'fr-FR' : (settings.language === 'ar' ? 'ar-SA' : 'en-US');
}

function stopSpeaking() {
  state.speechToken++;
  if (window.speechSynthesis) window.speechSynthesis.cancel();
}

// Resolves when the whole text has been spoken (or was cancelled)
function speakText(text) {
  return new Promise(resolve => {
    const synth = window.speechSynthesis;
    if (!synth || !text) { resolve(); return; }

    synth.cancel();
    const token = ++state.speechToken;
    const parts = text.match(/[^.!?\n]+[.!?]*/g) || [text];
    let i = 0;

    const next = () => {
      if (token !== state.speechToken || i >= parts.length) { resolve(); return; }
      const part = parts[i++].trim();
      if (!part) { next(); return; }
      const u = new SpeechSynthesisUtterance(part);
      u.lang    = pickLang(part);
      u.onend   = next;
      u.onerror = next;
      synth.speak(u);
    };
    next();
  });
}

// ══════════════════════════════════════════════════════
// VOICE CALL  (mic → /transcribe → /call → spoken reply)
// ══════════════════════════════════════════════════════
const VAD = { silenceMs: 1300, minSpeechMs: 350, maxSpeechMs: 20000, idleResetMs: 30000 };

function setCallState(label) { callStateLabel.textContent = label; }

function appendCallLine(speaker, text) {
  state.callTranscriptText += `${speaker}: ${text}\n`;
  callTranscript.textContent = state.callTranscriptText.trim();
  callTranscript.scrollTop   = callTranscript.scrollHeight;
}

function micLevel(buf) {
  state.analyser.getFloatTimeDomainData(buf);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  return Math.sqrt(sum / buf.length);
}

// Measure room noise for ~0.6 s so the "is the customer talking?" threshold fits
async function calibrateNoise() {
  const buf = new Float32Array(state.analyser.fftSize);
  let total = 0, n = 0;
  for (let t = 0; t < 12; t++) {
    await new Promise(r => setTimeout(r, 50));
    total += micLevel(buf); n++;
  }
  const floor = total / Math.max(n, 1);
  state.vadThreshold = Math.min(0.08, Math.max(0.02, floor * 3.5));
}

// Records ONE customer utterance. Resolves with an audio Blob, or null
// (call ended / muted / too short / nothing said → caller just listens again).
function listenForUtterance(alive) {
  return new Promise(resolve => {
    const mime = pickMime();
    const rec  = new MediaRecorder(state.callStream, mime ? { mimeType: mime } : undefined);
    const chunks = [];
    rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };

    const buf = new Float32Array(state.analyser.fftSize);
    const startedAt = Date.now();
    let speechStart = 0, lastVoice = 0, finished = false, iv = null;

    const finish = keep => {
      if (finished) return;
      finished = true;
      clearInterval(iv);
      waveform.classList.remove('active');
      if (rec.state === 'inactive') { resolve(null); return; }
      rec.onstop = () => resolve(keep ? new Blob(chunks, { type: rec.mimeType || 'audio/webm' }) : null);
      rec.stop();
    };

    rec.start();
    iv = setInterval(() => {
      if (!alive()) return finish(false);
      const now = Date.now();

      if (state.muted) {                       // muted: drop anything in progress
        if (speechStart) return finish(false);
        return;
      }

      if (micLevel(buf) > state.vadThreshold) {
        lastVoice = now;
        if (!speechStart) { speechStart = now; waveform.classList.add('active'); }
      }

      if (speechStart) {
        if (now - lastVoice  > VAD.silenceMs)   return finish(lastVoice - speechStart >= VAD.minSpeechMs);
        if (now - speechStart > VAD.maxSpeechMs) return finish(true);
      } else if (now - startedAt > VAD.idleResetMs) {
        return finish(false);                  // renew the recorder during long silences
      }
    }, 50);
  });
}

async function transcribeBlob(blob) {
  const res = await fetch(`${API_URL}/transcribe?language=${encodeURIComponent(sttLanguage())}`, {
    method:  'POST',
    headers: { 'Content-Type': blob.type || 'audio/webm' },
    body:    blob
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()).text || '';
}

// Agent line: show it in the transcript and speak it (if speaker is on)
async function agentSay(text) {
  setCallState('Agent speaking…');
  appendCallLine('OTA Support', text);
  if (state.speakerOn && window.speechSynthesis) {
    waveform.classList.add('active');
    await speakText(text);
    waveform.classList.remove('active');
  } else {
    await new Promise(r => setTimeout(r, 400));
  }
}

const NOISE_TEXT = /^(thank you\.?|thanks\.?|thanks for watching!?|you\.?|\.+)$/i;
const GOODBYE    = /\b(goodbye|good bye|bye|hang up)\b/i;

async function runCallLoop() {
  const myRun = ++state.callRunId;
  const alive = () => state.callActive && state.callRunId === myRun;

  await calibrateNoise();
  if (!alive()) return;
  await agentSay('Hello! Thank you for calling OTA Support. How can I help you today?');

  while (alive()) {
    setCallState(state.muted ? 'Muted — unmute to talk' : 'Listening…');
    const blob = await listenForUtterance(alive);
    if (!alive()) break;
    if (!blob) continue;

    setCallState('Thinking…');
    let text = '';
    try {
      text = (await transcribeBlob(blob)).trim();
    } catch (err) {
      console.error('[API] /transcribe failed:', err);
      showToast('Could not understand the audio — please try again');
      continue;
    }
    if (!alive()) break;
    if (text.length < 2 || NOISE_TEXT.test(text)) continue;

    appendCallLine('You', text);

    if (GOODBYE.test(text)) {
      await agentSay('Thank you for calling OTA Support. Have a wonderful day!');
      if (alive()) endCall();
      return;
    }

    let data;
    try {
      data = await apiCall(text);
    } catch (err) {
      console.error('[API] /call failed:', err);
      if (!alive()) break;
      await agentSay("I'm sorry, I'm having trouble reaching our system. Could you repeat that?");
      continue;
    }
    if (!alive()) break;

    state.callTurns.push(!!data.resolved);
    await agentSay(data.reply);
  }
}

async function startCall() {
  cleanupCall();

  state.callActive         = true;
  state.callLive           = false;
  state.callSeconds        = 0;
  state.callTranscriptText = '';
  state.callTurns          = [];

  callAvatarRing.classList.add('ringing');
  setCallState('Connecting...');
  callTimerEl.textContent  = '00:00';
  callTranscript.innerHTML = '<span class="transcript-placeholder">Connecting to OTA Support...</span>';
  btnDownloadCall.classList.add('hidden');
  setCallBtn('end');

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
  } catch (err) {
    console.error('[OTA] Microphone error:', err);
    if (state.callActive) {
      cleanupCall();
      resetCallUI();
      showToast('🎤 Microphone access is required for voice calls');
    }
    return;
  }

  if (!state.callActive) {                       // user hung up while the permission prompt was open
    stream.getTracks().forEach(t => t.stop());
    return;
  }

  state.callStream = stream;
  stream.getAudioTracks().forEach(t => { t.enabled = !state.muted; });

  const AC = window.AudioContext || window.webkitAudioContext;
  state.audioCtx = new AC();
  if (state.audioCtx.state === 'suspended') state.audioCtx.resume();
  state.analyser = state.audioCtx.createAnalyser();
  state.analyser.fftSize = 1024;
  state.audioCtx.createMediaStreamSource(stream).connect(state.analyser);

  startAudioRecording(stream);

  state.callLive = true;
  callTranscript.textContent = '';
  state.callTimer = setInterval(() => {
    state.callSeconds++;
    callTimerEl.textContent = formatSeconds(state.callSeconds);
  }, 1000);

  runCallLoop();
}

function resetCallUI() {
  setCallState('Ready to connect');
  callTimerEl.textContent = '00:00';
  waveform.classList.remove('active');
  callTranscript.innerHTML = '<span class="transcript-placeholder">Transcript will appear here during the call...</span>';
  setCallBtn('start');
}

async function endCall() {
  if (!state.callActive) return;
  const wasLive      = state.callLive;
  const durationSecs = state.callSeconds;
  const turns        = state.callTurns.slice();

  cleanupCall();
  waveform.classList.remove('active');
  setCallBtn('start');

  if (!wasLive) { resetCallUI(); return; }       // hung up before the mic was ready

  setCallState('Call ended');

  const audioBlob = await stopAudioRecording();
  releaseMic();

  if (audioBlob && audioBlob.size > 1000) {
    const ext = (audioBlob.type.includes('ogg') ? 'ogg' : audioBlob.type.includes('mp4') ? 'm4a' : 'webm');
    downloadBlob(audioBlob, `ota-call-audio-${Date.now()}.${ext}`);
  }

  btnDownloadCall.classList.remove('hidden');
  exportCallReport(durationSecs);

  if (turns.length) {
    const allResolved = turns.every(Boolean);
    addHistoryItem({
      id:      uid(),
      snippet: `Call · ${formatSeconds(durationSecs)}`,
      time:    nowTime(),
      type:    'call',
      status:  allResolved ? 'resolved' : 'escalated'
    });
    updateStats(allResolved);
  }

  setTimeout(() => {
    if (!state.callActive) {
      setCallState('Ready to connect');
      callTimerEl.textContent = '00:00';
    }
  }, 2500);
}

function releaseMic() {
  if (state.callStream) state.callStream.getTracks().forEach(t => t.stop());
  state.callStream = null;
  if (state.audioCtx) { state.audioCtx.close().catch(() => {}); state.audioCtx = null; }
  state.analyser = null;
}

// Stops timers, speech and the call loop (the mic is released by endCall)
function cleanupCall() {
  state.callActive = false;
  state.callLive   = false;
  state.callRunId++;                              // makes any running loop exit
  stopSpeaking();

  if (state.callTimer) { clearInterval(state.callTimer); state.callTimer = null; }
  callAvatarRing.classList.remove('ringing');
}

// ── Helper: swap call button icon/class ───────────────
function setCallBtn(mode) {
  if (mode === 'end') {
    btnCallToggle.classList.remove('call-start');
    btnCallToggle.classList.add('call-end');
    callIcon.innerHTML = `<path d="M4.293 4.293a1 1 0 011.414 0L10
      8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293
      4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1
      0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"/>`;
    btnCallToggle.setAttribute('aria-label', 'End call');
    btnCallToggle.title = 'End call';
  } else {
    btnCallToggle.classList.remove('call-end');
    btnCallToggle.classList.add('call-start');
    callIcon.innerHTML = `<path d="M2 3a1 1 0 011-1h2.153a1 1 0
      01.986.836l.74 4.435a1 1 0 01-.54 1.06l-1.548.773a11.037
      11.037 0 006.105 6.105l.774-1.548a1 1 0 011.059-.54l4.435.74a1
      1 0 01.836.986V17a1 1 0 01-1 1h-2C7.82 18 2 12.18 2 5V3z"/>`;
    btnCallToggle.setAttribute('aria-label', 'Start call');
    btnCallToggle.title = 'Start call';
  }
}

// Toggle
btnCallToggle.addEventListener('click', () => {
  if (!state.callActive) startCall();
  else endCall();
});

// Mute
btnMute.addEventListener('click', () => {
  state.muted = !state.muted;
  btnMute.classList.toggle('active', state.muted);
  btnMute.setAttribute('aria-label', state.muted ? 'Unmute microphone' : 'Mute microphone');
  btnMute.title = state.muted ? 'Unmute' : 'Mute';
  if (state.callStream) state.callStream.getAudioTracks().forEach(t => { t.enabled = !state.muted; });
  showToast(state.muted ? '🔇 Microphone muted' : '🎤 Microphone active');
});

// Speaker
btnSpeaker.addEventListener('click', () => {
  state.speakerOn = !state.speakerOn;
  btnSpeaker.classList.toggle('active', !state.speakerOn);
  btnSpeaker.setAttribute('aria-label', state.speakerOn ? 'Speaker on' : 'Speaker off');
  if (!state.speakerOn) stopSpeaking();
  showToast(state.speakerOn ? '🔊 Speaker on' : '🔈 Speaker off');
});

// ══════════════════════════════════════════════════════
// HISTORY
// ══════════════════════════════════════════════════════
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function addHistoryItem(item) {
  state.history.unshift(item);
  renderHistory();
}

function renderHistory() {
  if (historyEmpty) {
    historyEmpty.style.display = state.history.length ? 'none' : 'flex';
  }
  historyList.querySelectorAll('.history-item').forEach(n => n.remove());

  state.history.slice(0, 10).forEach(item => {
    const el = document.createElement('div');
    el.className = 'history-item';
    el.setAttribute('role', 'listitem');

    const iconSvg = item.type === 'call'
      ? `<svg viewBox="0 0 20 20" fill="currentColor" width="14" height="14"><path d="M2 3a1 1 0 011-1h2.153a1 1 0 01.986.836l.74 4.435a1 1 0 01-.54 1.06l-1.548.773a11.037 11.037 0 006.105 6.105l.774-1.548a1 1 0 011.059-.54l4.435.74a1 1 0 01.836.986V17a1 1 0 01-1 1h-2C7.82 18 2 12.18 2 5V3z"/></svg>`
      : `<svg viewBox="0 0 20 20" fill="currentColor" width="14" height="14"><path d="M2 5a2 2 0 012-2h12a2 2 0 012 2v8a2 2 0 01-2 2H6l-4 4V5z"/></svg>`;

    el.innerHTML = `
      <div class="history-icon">${iconSvg}</div>
      <div class="history-body">
        <div class="history-snippet">${escapeHtml(item.snippet)}</div>
        <div class="history-time">${item.time}</div>
      </div>
      <span class="history-badge badge-${item.status}">${item.status}</span>
    `;
    historyList.appendChild(el);
  });
}

btnClearHistory.addEventListener('click', () => {
  state.history  = [];
  state.chatLog  = [];
  state.sessions = 0;
  state.resolved = 0;
  renderHistory();
  statSessions.textContent = '0';
  statResolved.textContent = '0%';
  statRating.textContent   = '—';
  showToast('History cleared');
});

// ══════════════════════════════════════════════════════
// STATS
// ══════════════════════════════════════════════════════
function updateStats(resolved) {
  state.sessions++;
  if (resolved) state.resolved++;
  const pct = Math.round((state.resolved / state.sessions) * 100);
  statSessions.textContent = state.sessions;
  statResolved.textContent = pct + '%';
  statRating.textContent   = state.starRating > 0 ? state.starRating + '.0' : '—';
}

// ══════════════════════════════════════════════════════
// STARS / FEEDBACK
// ══════════════════════════════════════════════════════
starsRow.querySelectorAll('.star-btn').forEach(btn => {
  btn.addEventListener('mouseenter', () => highlightStars(+btn.dataset.val));
  btn.addEventListener('mouseleave', () => highlightStars(state.starRating));
  btn.addEventListener('click', () => {
    state.starRating = +btn.dataset.val;
    highlightStars(state.starRating);
    statRating.textContent = state.starRating + '.0';
  });
});

function highlightStars(n) {
  starsRow.querySelectorAll('.star-btn').forEach(b => {
    b.classList.toggle('active', +b.dataset.val <= n);
  });
}

btnSubmitFb.addEventListener('click', async () => {
  const msg = feedbackText.value.trim();
  if (!state.starRating && !msg) {
    feedbackText.focus();
    showToast('Please select a rating or leave a comment.');
    return;
  }

  btnSubmitFb.disabled = true;
  try {
    const res = await fetch(`${API_URL}/feedback`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ rating: state.starRating, comment: msg, channel: state.mode })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    console.error('[API] /feedback failed:', err);
    btnSubmitFb.disabled = false;
    showToast('Could not send feedback — please try again.');
    return;
  }

  feedbackConfirm.classList.remove('hidden');
  feedbackText.value     = '';
  feedbackText.disabled  = true;
  btnSubmitFb.style.opacity = '0.5';
  showToast('✓ Feedback submitted — thank you!');

  setTimeout(() => {
    feedbackConfirm.classList.add('hidden');
    feedbackText.disabled = false;
    btnSubmitFb.disabled  = false;
    btnSubmitFb.style.opacity = '';
    state.starRating = 0;
    highlightStars(0);
  }, 3500);
});

// ══════════════════════════════════════════════════════
// INIT
// ══════════════════════════════════════════════════════
function init() {
  // Welcome message in chat — added to DOM but NOT to chatLog
  const row = document.createElement('div');
  row.className = 'bubble-row agent';

  const avatar = document.createElement('div');
  avatar.className = 'bubble-avatar';
  avatar.textContent = 'OA';

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = "Hello! I'm OTA Support, your AI assistant. How can I help you today?";

  const meta = document.createElement('div');
  meta.className = 'bubble-meta';
  meta.textContent = nowTime();

  const inner = document.createElement('div');
  inner.appendChild(bubble);
  inner.appendChild(meta);
  row.appendChild(avatar);
  row.appendChild(inner);
  chatMessages.appendChild(row);
}

// ══════════════════════════════════════════════════════
// BACKEND STATUS
// ══════════════════════════════════════════════════════
async function checkHealth() {
  let online = false;
  try {
    const res = await fetch(`${API_URL}/health`, { cache: 'no-store' });
    online = res.ok;
  } catch (_) { /* offline */ }
  statusDot.classList.toggle('offline', !online);
  statusLabel.textContent = online ? 'Agent online' : 'Agent offline';
}

init();
checkHealth();
setInterval(checkHealth, 15000);
