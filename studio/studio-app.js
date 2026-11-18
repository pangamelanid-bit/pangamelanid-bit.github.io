import { GamelanAudioEngine } from './audio-engine.js';
import { InstrumentStage } from './instruments-svg.js';
import { MultiplayerManager } from './multiplayer.js';

const engine = new GamelanAudioEngine();

let manifest = null;
let currentInst = null;
let currentScale = 'slendro';

// Metronome state
let metroTimer = null;
let metroRunning = false;
let metroBpm = 72;
let metroBeat = 0;
let metroAnchorHostMs = 0;
let metroLastScheduledIndex = -1;
let metroVisualTimers = [];
let metroDragBroadcastTimer = null;

// Recorder state
let mediaRecorder = null;
let recordedChunks = [];
let isRecording = false;
let recordStartTime = 0;
let recordTimer = null;

// DOM Refs
const el = {
  instSelect: document.getElementById('instSelect'),
  scaleBtns: document.querySelectorAll('.scale-btn'),
  instTitle: document.getElementById('instTitle'),
  instDesc: document.getElementById('instDesc'),
  loadBadge: document.getElementById('loadBadge'),
  saronBarungBilahBtn: document.getElementById('saronBarungBilahBtn'),
  bonangOrderBtn: document.getElementById('bonangOrderBtn'),
  bonangPathetBtn: document.getElementById('bonangPathetBtn'),
  panerusanKeyModeBtn: document.getElementById('panerusanKeyModeBtn'),
  panerusanPathetBtn: document.getElementById('panerusanPathetBtn'),
  gambangGembyangBtn: document.getElementById('gambangGembyangBtn'),
  autoMithetBtn: document.getElementById('autoMithetBtn'),
  stageContainer: document.getElementById('stageContainer'),
  stageScrollCue: document.getElementById('stageScrollCue'),
  dampBtn: document.getElementById('dampBtn'),
  masterVol: document.getElementById('masterVol'),
  tuneRange: document.getElementById('tuneRange'),
  tuneResetBtn: document.getElementById('tuneResetBtn'),
  // Multiplayer
  roomStatusPill: document.getElementById('openRoomBtn'),
  roomModal: document.getElementById('roomModal'),
  rotatePrompt: document.getElementById('rotatePrompt'),
  dismissRotateBtn: document.getElementById('dismissRotateBtn'),
  openRoomBtn: document.getElementById('openRoomBtn'),
  closeRoomBtn: document.getElementById('closeRoomBtn'),
  playerNameInput: document.getElementById('playerNameInput'),
  roomCodeInput: document.getElementById('roomCodeInput'),
  createRoomBtn: document.getElementById('createRoomBtn'),
  joinRoomBtn: document.getElementById('joinRoomBtn'),
  leaveRoomBtn: document.getElementById('leaveRoomBtn'),
  copyCodeBtn: document.getElementById('copyCodeBtn'),
  copyInviteBtn: document.getElementById('copyInviteBtn'),
  roomCopyStatus: document.getElementById('roomCopyStatus'),
  roomActiveBox: document.getElementById('roomActiveBox'),
  roomActiveCode: document.getElementById('roomActiveCode'),
  roomModalStatus: document.getElementById('roomModalStatus'),
  rosterBar: document.getElementById('rosterBar'),
  // Metronome & Recorder & Emotes
  bpmRange: document.getElementById('bpmRange'),
  bpmVal: document.getElementById('bpmVal'),
  metroToggleBtn: document.getElementById('metroToggleBtn'),
  gatraDots: document.querySelectorAll('#gatraBeats .gatra-dot'),
  recordBtn: document.getElementById('recordBtn'),
  recordTime: document.getElementById('recordTime'),
  emoteBtns: document.querySelectorAll('.emote-btn'),
  toastWrap: document.getElementById('toastWrap')
};

const PREFS_KEY = 'pan_studio_prefs';
const ROOM_SESSION_KEY = 'pan_studio_room_session';
let _guestRetryTimer = null;
let _guestRetryCount = 0;

function loadPrefs() {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') || {};
  } catch (_) {
    return {};
  }
}

function savePrefs(partial = {}) {
  try {
    const next = {
      ...loadPrefs(),
      instrument: currentInst?.id || loadPrefs().instrument || 'saron-barung',
      scale: currentScale,
      playerName: el.playerNameInput?.value?.trim() || loadPrefs().playerName || '',
      ...partial
    };
    localStorage.setItem(PREFS_KEY, JSON.stringify(next));
  } catch (_) {}
}

function loadRoomSession() {
  try {
    const raw = sessionStorage.getItem(ROOM_SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

function saveRoomSession(session) {
  try {
    sessionStorage.setItem(ROOM_SESSION_KEY, JSON.stringify(session));
  } catch (_) {}
}

function clearRoomSession() {
  if (_guestRetryTimer) {
    clearTimeout(_guestRetryTimer);
    _guestRetryTimer = null;
  }
  try {
    sessionStorage.removeItem(ROOM_SESSION_KEY);
  } catch (_) {}
}

function showToast(msg, variant = 'gold') {
  // Don't surface background toasts or announce in inert DOM while a modal dialog is open
  if (el.roomModal?.open) return;
  const item = document.createElement('div');
  item.className = `studio-toast toast-${variant}`;
  item.textContent = msg;
  el.toastWrap.appendChild(item);
  setTimeout(() => {
    item.classList.add('is-fading');
    setTimeout(() => item.remove(), 300);
  }, 2600);
}

function resolveSafeAudioUrl(instId, scaleKey, noteId, fallbackUrl) {
  const inst = manifest?.instruments?.find((i) => i.id === instId);
  const notes = inst?.scales?.[scaleKey] || inst?.scales?.both || [];
  const found = notes.find((n) => n.id === noteId);
  if (found?.url) return found.url;
  if (
    typeof fallbackUrl === 'string' &&
    /^audio\/studio\/[a-z0-9/_-]+\.(mp3|pga|wav|ogg)$/i.test(fallbackUrl)
  ) {
    return fallbackUrl;
  }
  return null;
}

function getNoteDetune(instId, scaleKey, noteId) {
  const inst = manifest?.instruments?.find((i) => i.id === instId);
  const notes = inst?.scales?.[scaleKey] || inst?.scales?.both || [];
  const found = notes.find((n) => n.id === noteId);
  if (found && typeof found.detune === 'number') return found.detune;
  if (instId === 'gambang' && scaleKey === 'pelog' && ['7ll', '7l', '7', '7h'].includes(noteId)) {
    return 145;
  }
  return 0;
}

let _scrollCueRaf = 0;
function updateScrollCue() {
  if (!el.stageScrollCue) return;
  if (_scrollCueRaf) cancelAnimationFrame(_scrollCueRaf);
  _scrollCueRaf = requestAnimationFrame(() => {
    _scrollCueRaf = 0;
    const grid = el.stageContainer.querySelector('.pads-grid.layout-bilah');
    if (!grid) {
      el.stageScrollCue.hidden = true;
      return;
    }
    const rotateVisible =
      el.rotatePrompt && window.getComputedStyle(el.rotatePrompt).display !== 'none';
    const overflows = grid.scrollWidth > grid.clientWidth + 2;
    el.stageScrollCue.hidden = rotateVisible || !overflows;
  });
}

const stage = new InstrumentStage(el.stageContainer, {
  onHit: (note, velocity) => {
    engine.unlock();
    const scaleKey = currentInst.scales[currentScale] ? currentScale : 'both';
    engine.play(currentInst.id, scaleKey, note.id, note.url, {
      velocity,
      noteDetune: note.detune || 0
    });
    mp.sendHit(currentInst.id, scaleKey, note.id, note.url, velocity);
    pulseRosterPlayer(mp.localProfile.id);
  },
  onDamp: (note) => {
    if (!currentInst || !currentInst.canDamp) return;
    const scaleKey = currentInst.scales[currentScale] ? currentScale : 'both';
    const noteId = note ? note.id : null;
    engine.damp(currentInst.id, scaleKey, noteId);
    mp.sendDamp(currentInst.id, scaleKey, noteId);
  },
  onRender: () => {
    updateScrollCue();
  }
});

const mp = new MultiplayerManager({
  onStatusChange: (state, text) => {
    el.roomStatusPill.dataset.state = state;
    el.roomStatusPill.querySelector('.status-text').textContent = text;
    if (el.roomModalStatus) {
      if (state === 'solo') {
        el.roomModalStatus.hidden = true;
      } else {
        el.roomModalStatus.hidden = false;
        el.roomModalStatus.dataset.state = state;
        el.roomModalStatus.textContent = text;
      }
    }
    if (state === 'connected') {
      el.roomActiveBox.hidden = false;
      el.roomActiveCode.textContent = mp.roomCode;
      el.leaveRoomBtn.hidden = false;
      _guestRetryCount = 0;
      if (_guestRetryTimer) {
        clearTimeout(_guestRetryTimer);
        _guestRetryTimer = null;
      }
      if (mp.roomCode) {
        saveRoomSession({
          role: mp.isHost ? 'host' : 'guest',
          roomCode: mp.roomCode,
          playerName: mp.localProfile.name
        });
      }
    } else if (state === 'solo') {
      el.roomActiveBox.hidden = true;
      el.leaveRoomBtn.hidden = true;
    } else if (state === 'error') {
      const saved = loadRoomSession();
      if (!mp.isHost && saved?.role === 'guest' && saved.roomCode && _guestRetryCount < 4) {
        _guestRetryCount += 1;
        if (_guestRetryTimer) clearTimeout(_guestRetryTimer);
        _guestRetryTimer = setTimeout(() => {
          const latest = loadRoomSession();
          if (latest?.role === 'guest' && latest.roomCode && !mp._manuallyLeaving) {
            mp.joinRoom(latest.roomCode, latest.playerName || el.playerNameInput.value.trim() || 'Pemain');
          }
        }, 2500);
      }
      showToast(text, 'warn');
    }
  },
  onRosterChange: (players) => {
    renderRoster(players);
  },
  onRemoteHit: (data) => {
    const safeUrl = resolveSafeAudioUrl(data.instId, data.scale, data.noteId, data.url);
    if (!safeUrl) return;
    // Play remote audio (auto lazy-fetches if not yet cached)
    engine.play(data.instId, data.scale, data.noteId, safeUrl, {
      velocity: data.velocity || 1.0,
      pan: 0.12,
      noteDetune: getNoteDetune(data.instId, data.scale, data.noteId)
    });
    pulseRosterPlayer(data.senderId);
    // If local player is viewing the same instrument & scale, show remote glow
    if (currentInst && currentInst.id === data.instId) {
      const localScale = currentInst.scales[currentScale] ? currentScale : 'both';
      if (localScale === data.scale) {
        stage.triggerHitVisual(data.noteId, true);
      }
    }
  },
  onRemoteDamp: (data) => {
    engine.damp(data.instId, data.scale, data.noteId || null);
  },
  onRemoteTempo: (data) => {
    const nextBpm = typeof data.bpm === 'number' ? data.bpm : metroBpm;
    const nextRunning = typeof data.running === 'boolean' ? data.running : metroRunning;
    const nextAnchor = typeof data.anchorHostMs === 'number' ? data.anchorHostMs : Date.now();
    const bpmChanged = nextBpm !== metroBpm;
    const anchorChanged = Math.abs(nextAnchor - metroAnchorHostMs) > 2;
    if (bpmChanged) {
      syncBpmUi(nextBpm);
    }
    if (nextRunning !== metroRunning || (nextRunning && (bpmChanged || anchorChanged))) {
      setMetronome(nextRunning, false, nextAnchor);
    }
  },
  onGuestConnected: (guestPeerId) => {
    if (!mp.isHost) return;
    mp.sendTempo(metroBpm, metroRunning, metroAnchorHostMs, guestPeerId);
    if (engine.globalTuneCents !== 0) {
      mp.sendTune(engine.globalTuneCents);
    }
  },
  onClockSync: () => {
    if (metroRunning && !mp.isHost) {
      clearMetroTimers();
      const beatMs = 60000 / metroBpm;
      const elapsed = mp.getHostNowMs() - metroAnchorHostMs;
      const floorIdx = elapsed >= 0 ? Math.floor(elapsed / beatMs) : -1;
      if (Math.abs(floorIdx - metroLastScheduledIndex) > 1) {
        metroLastScheduledIndex = floorIdx;
      }
      scheduleNextMetroBeats();
    }
  },
  onTempoRequest: (data) => {
    if (!mp.isHost) return;
    const reqBpm =
      typeof data.bpm === 'number' ? Math.max(40, Math.min(180, Math.round(data.bpm))) : metroBpm;
    const reqRunning = typeof data.running === 'boolean' ? data.running : metroRunning;
    if (reqRunning === metroRunning) {
      if (reqBpm !== metroBpm) {
        const oldBpm = metroBpm;
        syncBpmUi(reqBpm);
        applyPhasePreservingBpm(oldBpm, true);
      }
      return;
    }
    syncBpmUi(reqBpm);
    setMetronome(reqRunning, true);
  },
  onRemoteTune: (data) => {
    if (typeof data.cents === 'number') {
      applyGlobalTune(data.cents, false);
    }
  },
  onEmote: (data) => {
    showToast(`${data.senderName}: ${data.text}`, 'gold');
  }
});

function renderRoster(players) {
  if (!players || players.length === 0) {
    const chip = document.createElement('div');
    chip.className = 'roster-chip is-self';
    const dot = document.createElement('span');
    dot.className = 'roster-dot';
    const text = document.createElement('span');
    text.textContent = `Anda (${currentInst ? currentInst.name : 'Studio'}), Mode Solo`;
    chip.append(dot, text);
    el.rosterBar.replaceChildren(chip);
    return;
  }

  const chips = players.map((p) => {
    const instObj = manifest?.instruments.find((i) => i.id === p.instId);
    const instLabel = instObj ? instObj.name : p.instId;
    const isSelf = p.id === mp.localProfile.id;

    const chip = document.createElement('div');
    chip.className = isSelf ? 'roster-chip is-self' : 'roster-chip';
    chip.dataset.peerId = String(p.id || '');

    const dot = document.createElement('span');
    dot.className = 'roster-dot';

    const nameEl = document.createElement('strong');
    nameEl.textContent = String(p.name || 'Pemain');

    const instEl = document.createElement('span');
    instEl.className = 'roster-inst';
    instEl.textContent = String(instLabel || '');

    chip.append(dot, nameEl, instEl);

    if (p.isHost) {
      const hostBadge = document.createElement('span');
      hostBadge.className = 'roster-host';
      hostBadge.textContent = 'Host';
      chip.append(hostBadge);
    }

    return chip;
  });

  el.rosterBar.replaceChildren(...chips);
}

function pulseRosterPlayer(peerId) {
  const chip = el.rosterBar.querySelector(`[data-peer-id="${CSS.escape(peerId || 'local')}"]`);
  if (!chip) return;
  chip.classList.add('is-playing');
  clearTimeout(chip._pulseTimer);
  chip._pulseTimer = setTimeout(() => chip.classList.remove('is-playing'), 220);
}

async function selectInstrument(instId) {
  const inst = manifest.instruments.find((i) => i.id === instId);
  if (!inst) return;
  currentInst = inst;
  el.instSelect.value = inst.id;
  el.instTitle.textContent = inst.name;
  el.instDesc.textContent = inst.desc;
  savePrefs({ instrument: inst.id });

  // Toggle laras buttons availability if instrument uses 'both'
  const hasBoth = Boolean(inst.scales.both);
  el.scaleBtns.forEach((btn) => {
    btn.disabled = hasBoth;
    btn.classList.toggle('is-locked', hasBoth);
  });

  // Bonang layout order toggle, Pelog 1/7 pathet toggle, Panerusan keyboard split & Damp button visibility
  const scaleKey = inst.scales[currentScale] ? currentScale : 'both';
  el.saronBarungBilahBtn.hidden = !(inst.id === 'saron-barung' && scaleKey === 'pelog');
  el.bonangOrderBtn.hidden = inst.layout !== 'bonang';
  el.bonangPathetBtn.hidden = !(
    inst.layout === 'bonang' &&
    scaleKey === 'pelog' &&
    stage.bonangTraditionalOrder
  );
  el.panerusanKeyModeBtn.hidden = !(inst.category === 'Panerusan' && inst.layout === 'bilah');
  el.panerusanPathetBtn.hidden = !(inst.category === 'Panerusan' && scaleKey === 'pelog');
  el.gambangGembyangBtn.hidden = inst.id !== 'gambang';
  el.dampBtn.hidden = !inst.canDamp;

  const notes = inst.scales[scaleKey] || [];
  stage.render(inst, scaleKey);

  mp.setLocalProfile({ instId: inst.id, scale: scaleKey });
  if (!mp.peer || !mp.peer.id || mp.roster.size === 0) {
    renderRoster([]);
  }

  if (engine.isInstrumentLoaded(inst.id, scaleKey)) {
    el.loadBadge.textContent = 'Siap (0ms)';
    el.loadBadge.dataset.ready = 'true';
  } else {
    el.loadBadge.textContent = 'Memuat suara 0%';
    el.loadBadge.dataset.ready = 'false';
    await engine.loadInstrument(inst.id, scaleKey, notes, (pct) => {
      const p = Math.round(pct * 100);
      if (currentInst.id === inst.id) {
        el.loadBadge.textContent = p >= 100 ? 'Siap (0ms)' : `Memuat ${p}%`;
        el.loadBadge.dataset.ready = p >= 100 ? 'true' : 'false';
      }
    });
  }
}

function applyGlobalTune(cents, broadcast = true) {
  const clamped = Math.max(-600, Math.min(600, Math.round(Number(cents) || 0)));
  engine.setGlobalTune(clamped);
  el.tuneRange.value = clamped;
  el.tuneRange.setAttribute('aria-valuetext', `${clamped > 0 ? '+' + clamped : clamped} cents`);
  const label = clamped > 0 ? `+${clamped}` : `${clamped}`;
  el.tuneResetBtn.textContent = `${label} ct`;
  el.tuneResetBtn.setAttribute(
    'aria-description',
    clamped === 0 ? 'Klik untuk reset pitch ke 0 cent' : `Reset tune dari ${label} cent ke 0 cent`
  );
  el.tuneResetBtn.classList.toggle('is-tuned', clamped !== 0);
  if (broadcast && mp.isHost) {
    mp.sendTune(clamped);
  }
}

function setScale(scale) {
  if (scale !== 'slendro' && scale !== 'pelog') return;
  currentScale = scale;
  savePrefs({ scale });
  el.scaleBtns.forEach((b) => {
    const active = b.dataset.scale === scale;
    b.classList.toggle('active', active);
    b.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
  if (currentInst) {
    selectInstrument(currentInst.id);
  }
}

function updateGatraDots(beatNum) {
  el.gatraDots.forEach((dot) => {
    const b = parseInt(dot.dataset.beat, 10);
    dot.classList.toggle('is-active', beatNum > 0 && b === beatNum);
  });
}

function syncBpmUi(bpm) {
  metroBpm = bpm;
  el.bpmRange.value = String(bpm);
  el.bpmRange.style.setProperty('--control-value', String(bpm));
  el.bpmRange.setAttribute('aria-valuetext', `${bpm} BPM`);
  el.bpmVal.textContent = `${bpm} BPM`;
}

function clearMetroTimers() {
  if (metroTimer) {
    clearTimeout(metroTimer);
    metroTimer = null;
  }
  while (metroVisualTimers.length > 0) {
    clearTimeout(metroVisualTimers.pop());
  }
}

function scheduleNextMetroBeats() {
  if (!metroRunning) return;
  const hostNow = mp.getHostNowMs();
  const beatMs = 60000 / metroBpm;
  const lookaheadMs = 100;
  const elapsed = hostNow - metroAnchorHostMs;
  const currentFloorIdx = elapsed >= 0 ? Math.floor(elapsed / beatMs) : -1;

  if (currentFloorIdx > metroLastScheduledIndex + 1) {
    metroLastScheduledIndex = currentFloorIdx - 1;
    const currentGatra = (currentFloorIdx % 4) + 1;
    metroBeat = currentGatra;
    updateGatraDots(currentGatra);
  }

  const maxIdx = Math.floor((hostNow + lookaheadMs - metroAnchorHostMs) / beatMs);
  for (let idx = Math.max(0, metroLastScheduledIndex + 1); idx <= maxIdx; idx += 1) {
    const targetHostMs = metroAnchorHostMs + idx * beatMs;
    const rawDelta = targetHostMs - hostNow;
    if (rawDelta < -40) {
      metroLastScheduledIndex = idx;
      continue;
    }
    metroLastScheduledIndex = idx;
    const delayMs = Math.max(0, rawDelta);
    const gatraBeat = (idx % 4) + 1;
    engine.playMetronomeAccent(gatraBeat === 4, delayMs / 1000);
    const vt = setTimeout(() => {
      if (!metroRunning) return;
      metroBeat = gatraBeat;
      updateGatraDots(gatraBeat);
    }, Math.round(delayMs));
    metroVisualTimers.push(vt);
  }

  metroTimer = setTimeout(scheduleNextMetroBeats, 25);
}

function applyPhasePreservingBpm(oldBpm, broadcastNow = true) {
  if (metroRunning && metroAnchorHostMs > 0) {
    const now = Date.now();
    const oldBeatMs = 60000 / Math.max(1, oldBpm);
    const newBeatMs = 60000 / Math.max(1, metroBpm);
    const elapsedBeats = Math.max(0, (now - metroAnchorHostMs) / oldBeatMs);
    metroAnchorHostMs = now - elapsedBeats * newBeatMs;
    clearMetroTimers();
    metroLastScheduledIndex = Math.floor(elapsedBeats);
    scheduleNextMetroBeats();
  }
  if (broadcastNow && mp.isHost && mp.connections.size > 0) {
    mp.sendTempo(metroBpm, metroRunning, metroAnchorHostMs);
  }
}

function setMetronome(running, broadcast = true, anchorHostMs = null) {
  clearMetroTimers();
  metroRunning = running;
  el.metroToggleBtn.classList.toggle('is-active', running);
  el.metroToggleBtn.setAttribute('aria-pressed', running ? 'true' : 'false');
  el.metroToggleBtn.textContent = running ? 'Stop Ketukan' : 'Mulai Ketukan';

  if (running) {
    engine.unlock();
    if (typeof anchorHostMs === 'number' && anchorHostMs > 0) {
      metroAnchorHostMs = anchorHostMs;
    } else {
      const leadIn = mp.isHost && mp.connections.size > 0 ? 85 : 0;
      metroAnchorHostMs = Date.now() + leadIn;
    }
    const elapsed = mp.getHostNowMs() - metroAnchorHostMs;
    const beatMs = 60000 / metroBpm;
    metroLastScheduledIndex = elapsed >= 0 ? Math.floor(elapsed / beatMs) - 1 : -1;
    if (metroLastScheduledIndex < 0) {
      metroBeat = 0;
      updateGatraDots(0);
    }
    scheduleNextMetroBeats();
  } else {
    metroBeat = 0;
    metroAnchorHostMs = 0;
    metroLastScheduledIndex = -1;
    updateGatraDots(0);
  }

  if (broadcast && mp.isHost) {
    mp.sendTempo(metroBpm, metroRunning, metroAnchorHostMs);
  }
}

function toggleRecording() {
  if (!isRecording) {
    const stream = engine.getRecordingStream();
    if (!stream || typeof window.MediaRecorder === 'undefined') {
      showToast('Browser ini belum mendukung perekaman audio.', 'warn');
      return;
    }
    engine.unlock();
    recordedChunks = [];
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : 'audio/webm';
    mediaRecorder = new MediaRecorder(stream, { mimeType });
    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) recordedChunks.push(e.data);
    };
    mediaRecorder.onstop = () => {
      const blob = new Blob(recordedChunks, { type: mimeType });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      a.href = url;
      a.download = `PAN-Gamelan-Jam-${stamp}.webm`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      showToast('Rekaman berhasil diunduh!', 'gold');
    };

    mediaRecorder.start(250);
    isRecording = true;
    recordStartTime = Date.now();
    el.recordBtn.classList.add('is-recording');
    el.recordBtn.setAttribute('aria-label', 'Stop & Simpan Rekaman');
    el.recordBtn.querySelector('.rec-label').textContent = 'Stop & Simpan';
    recordTimer = setInterval(() => {
      const sec = Math.floor((Date.now() - recordStartTime) / 1000);
      const m = String(Math.floor(sec / 60)).padStart(2, '0');
      const s = String(sec % 60).padStart(2, '0');
      el.recordTime.textContent = `${m}:${s}`;
    }, 500);
  } else {
    isRecording = false;
    clearInterval(recordTimer);
    el.recordBtn.classList.remove('is-recording');
    el.recordBtn.setAttribute('aria-label', 'Rekam Sesi Audio');
    el.recordBtn.querySelector('.rec-label').textContent = 'Rekam Sesi';
    el.recordTime.textContent = '00:00';
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
    }
  }
}

async function init() {
  try {
    const res = await fetch('audio/studio/manifest.json');
    manifest = await res.json();
  } catch (err) {
    el.instDesc.textContent = 'Gagal memuat katalog instrumen (manifest.json). Jalankan lewat local/web server.';
    return;
  }

  // Populate grouped instrument selector
  const categories = Object.groupBy(manifest.instruments, (inst) => inst.category);

  const groups = [];
  for (const [cat, items] of Object.entries(categories)) {
    const group = document.createElement('optgroup');
    group.label = cat;
    items.forEach((inst) => {
      const opt = document.createElement('option');
      opt.value = inst.id;
      opt.textContent = inst.name;
      group.appendChild(opt);
    });
    groups.push(group);
  }
  el.instSelect.replaceChildren(...groups);

  // Bind UI events
  el.instSelect.addEventListener('change', (e) => selectInstrument(e.target.value));
  el.scaleBtns.forEach((btn) =>
    btn.addEventListener('click', () => setScale(btn.dataset.scale))
  );

  el.masterVol.addEventListener('input', (e) => {
    engine.setMasterVolume(parseFloat(e.target.value));
  });

  el.tuneRange.addEventListener('input', (e) => {
    applyGlobalTune(parseInt(e.target.value, 10), true);
  });

  el.tuneResetBtn.addEventListener('click', () => {
    applyGlobalTune(0, true);
  });

  // Bonang Susunan Toggle (Tradisional vs Urut Angka)
  el.bonangOrderBtn.addEventListener('click', () => {
    const nextTraditional = !stage.bonangTraditionalOrder;
    stage.setBonangOrder(nextTraditional);
    el.bonangOrderBtn.textContent = nextTraditional
      ? 'Susunan: Tradisional'
      : 'Susunan: Urut Angka';
    el.bonangOrderBtn.classList.toggle('is-active', !nextTraditional);
    el.bonangOrderBtn.setAttribute('aria-pressed', !nextTraditional ? 'true' : 'false');
    el.bonangPathetBtn.hidden = !(
      currentInst &&
      currentInst.layout === 'bonang' &&
      currentScale === 'pelog' &&
      nextTraditional
    );
  });

  // Bonang Pelog 1/7 Pathet Swap (Pelog Nem/Lima vs Pelog Barang)
  el.bonangPathetBtn.addEventListener('click', () => {
    const nextVariant = stage.bonangPelogVariant === 'barang' ? 'nem' : 'barang';
    stage.setBonangPelogVariant(nextVariant);
    const isBarang = nextVariant === 'barang';
    el.bonangPathetBtn.textContent = isBarang ? 'Pencon 1/7: Barang' : 'Pencon 1/7: Nem/Lima';
    el.bonangPathetBtn.classList.toggle('is-active', isBarang);
    el.bonangPathetBtn.setAttribute('aria-pressed', isBarang ? 'true' : 'false');
  });

  // Panerusan Keyboard Split 2 Tangan vs Standar Toggle
  el.panerusanKeyModeBtn.addEventListener('click', () => {
    const nextSplit = !stage.panerusanSplitKeys;
    stage.setPanerusanSplitKeys(nextSplit);
    el.panerusanKeyModeBtn.textContent = nextSplit
      ? 'Keyboard: Split 2 Tangan'
      : 'Keyboard: Standar';
    el.panerusanKeyModeBtn.classList.toggle('is-active', nextSplit);
    el.panerusanKeyModeBtn.setAttribute('aria-pressed', nextSplit ? 'true' : 'false');
  });

  // Khusus Panerusan Pelog: Opsi Pelog Bem vs Pelog Barang
  el.panerusanPathetBtn.addEventListener('click', () => {
    const nextPathet = stage.panerusanPelogPathet === 'barang' ? 'bem' : 'barang';
    stage.setPanerusanPelogPathet(nextPathet);
    const isBarang = nextPathet === 'barang';
    el.panerusanPathetBtn.textContent = isBarang ? 'Pelog: Barang' : 'Pelog: Bem';
    el.panerusanPathetBtn.classList.toggle('is-active', isBarang);
    el.panerusanPathetBtn.setAttribute('aria-pressed', isBarang ? 'true' : 'false');
  });

  // Khusus Gambang: Opsi Auto-Gembyang (1 oktaf bersamaan)
  el.gambangGembyangBtn.addEventListener('click', () => {
    const nextGembyang = !stage.gambangGembyang;
    stage.setGambangGembyang(nextGembyang);
    el.gambangGembyangBtn.textContent = nextGembyang ? 'Gembyang: ON' : 'Gembyang: OFF';
    el.gambangGembyangBtn.classList.toggle('is-active', nextGembyang);
    el.gambangGembyangBtn.setAttribute('aria-pressed', nextGembyang ? 'true' : 'false');
  });

  // Saron Barung Pelog: Opsi 7 Bilah vs 12 Bilah
  el.saronBarungBilahBtn.addEventListener('click', () => {
    const nextCount = stage.saronBarungBilahCount === 7 ? 12 : 7;
    stage.setSaronBarungBilahCount(nextCount);
    const is12 = nextCount === 12;
    el.saronBarungBilahBtn.textContent = is12 ? 'Bilah: 12' : 'Bilah: 7';
    el.saronBarungBilahBtn.classList.toggle('is-active', is12);
    el.saronBarungBilahBtn.setAttribute('aria-pressed', is12 ? 'true' : 'false');
  });

  // Auto-Mithet Natural Toggle
  el.autoMithetBtn.addEventListener('click', () => {
    const nextEnabled = !engine.autoMithet;
    engine.setAutoMithet(nextEnabled);
    el.autoMithetBtn.textContent = nextEnabled ? 'Auto-Mithet: ON' : 'Auto-Mithet: OFF';
    el.autoMithetBtn.classList.toggle('is-active', nextEnabled);
    el.autoMithetBtn.setAttribute('aria-pressed', nextEnabled ? 'true' : 'false');
  });

  // Damp button (touch + click + keyboard Enter/Space)
  el.dampBtn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (currentInst && currentInst.canDamp) {
      const scaleKey = currentInst.scales[currentScale] ? currentScale : 'both';
      engine.damp(currentInst.id, scaleKey, null);
      mp.sendDamp(currentInst.id, scaleKey, null);
      el.dampBtn.classList.add('is-active');
    }
  });
  el.dampBtn.addEventListener('pointerup', () => el.dampBtn.classList.remove('is-active'));
  el.dampBtn.addEventListener('pointercancel', () => el.dampBtn.classList.remove('is-active'));
  el.dampBtn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.code === 'Space' || e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat) return;
      if (currentInst && currentInst.canDamp) {
        const scaleKey = currentInst.scales[currentScale] ? currentScale : 'both';
        engine.damp(currentInst.id, scaleKey, null);
        mp.sendDamp(currentInst.id, scaleKey, null);
        stage.setDampMode(true);
        el.dampBtn.classList.add('is-active');
      }
    }
  });
  el.dampBtn.addEventListener('keyup', (e) => {
    if (e.key === 'Enter' || e.code === 'Space' || e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      stage.setDampMode(false);
      el.dampBtn.classList.remove('is-active');
    }
  });

  // Keyboard shortcuts
  window.addEventListener('keydown', (e) => stage.handleKeyDown(e));
  window.addEventListener('keyup', (e) => stage.handleKeyUp(e));

  // Unlock WebAudio on any first tap (ensures Android receives remote metronome beats cleanly)
  document.addEventListener('pointerdown', () => engine.unlock(), {
    once: true,
    capture: true,
    passive: true
  });

  // Metronome
  function broadcastOrRequestBpm(immediate = false) {
    clearTimeout(metroDragBroadcastTimer);
    const sendFn = () => {
      if (!mp.isHost && mp.connections.size > 0) {
        mp.sendTempoRequest(metroBpm, metroRunning);
      } else if (mp.isHost && mp.connections.size > 0) {
        mp.sendTempo(metroBpm, metroRunning, metroAnchorHostMs);
      }
    };
    if (immediate) {
      sendFn();
    } else {
      metroDragBroadcastTimer = setTimeout(sendFn, 60);
    }
  }

  el.bpmRange.addEventListener('input', (e) => {
    const oldBpm = metroBpm;
    const nextBpm = parseInt(e.target.value, 10);
    syncBpmUi(nextBpm);
    if (!mp.isHost && mp.connections.size > 0) {
      broadcastOrRequestBpm(false);
    } else {
      applyPhasePreservingBpm(oldBpm, false);
      broadcastOrRequestBpm(false);
    }
  });
  el.bpmRange.addEventListener('change', () => {
    broadcastOrRequestBpm(true);
  });
  el.metroToggleBtn.addEventListener('click', () => {
    engine.unlock();
    if (!mp.isHost && mp.connections.size > 0) {
      mp.sendTempoRequest(metroBpm, !metroRunning);
    } else {
      setMetronome(!metroRunning, true);
    }
  });

  // Recorder
  el.recordBtn.addEventListener('click', toggleRecording);

  // Emotes
  el.emoteBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const text = btn.dataset.emote;
      showToast(`Anda: ${text}`, 'gold');
      mp.sendEmote(text);
    });
  });

  // Room Modal
  if (el.rotatePrompt) {
    try {
      if (sessionStorage.getItem('pan_rotate_dismissed') === '1') {
        el.rotatePrompt.classList.add('is-dismissed');
      }
    } catch (_) {}
    el.dismissRotateBtn?.addEventListener('click', () => {
      el.rotatePrompt.classList.add('is-dismissed');
      try {
        sessionStorage.setItem('pan_rotate_dismissed', '1');
      } catch (_) {}
      updateScrollCue();
    });
  }
  window.addEventListener('resize', updateScrollCue, { passive: true });

  el.openRoomBtn.addEventListener('click', () => {
    engine.unlock();
    if (!el.roomModal.open) el.roomModal.showModal();
  });
  el.closeRoomBtn.addEventListener('click', () => {
    if (el.roomModal.open) el.roomModal.close();
  });
  if (!('closedBy' in HTMLDialogElement.prototype)) {
    const isOutsideDialog = (e, dialog) => {
      const r = dialog.getBoundingClientRect();
      return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
    };
    let pressedOutside = false;
    el.roomModal.addEventListener('pointerdown', (e) => {
      pressedOutside = el.roomModal.open && isOutsideDialog(e, el.roomModal);
    });
    el.roomModal.addEventListener('pointerup', (e) => {
      if (pressedOutside && el.roomModal.open && isOutsideDialog(e, el.roomModal)) {
        el.roomModal.close();
      }
      pressedOutside = false;
    });
    el.roomModal.addEventListener('pointercancel', () => {
      pressedOutside = false;
    });
  }

  async function copyText(str) {
    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(str);
        return true;
      } catch (_) {}
    }
    const ta = document.createElement('textarea');
    ta.value = str;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch (_) {}
    ta.remove();
    return ok;
  }

  function setRoomActionsBusy(busy, activeAction = null) {
    el.createRoomBtn.disabled = busy;
    el.joinRoomBtn.disabled = busy;
    el.createRoomBtn.textContent = busy && activeAction === 'create' ? 'Membuat…' : 'Buat Room Baru';
    el.joinRoomBtn.textContent = busy && activeAction === 'join' ? 'Menghubungkan…' : 'Gabung Room';
  }

  el.createRoomBtn.addEventListener('click', async () => {
    if (el.createRoomBtn.disabled) return;
    engine.unlock();
    const name = el.playerNameInput.value.trim() || 'Host Studio';
    const custom = el.roomCodeInput.value.trim();
    setRoomActionsBusy(true, 'create');
    try {
      const code = await mp.createRoom(name, custom);
      if (code) {
        el.roomCodeInput.value = code;
      }
    } finally {
      setRoomActionsBusy(false);
    }
  });

  el.joinRoomBtn.addEventListener('click', async () => {
    if (el.joinRoomBtn.disabled) return;
    engine.unlock();
    const name = el.playerNameInput.value.trim() || 'Pemain';
    const code = el.roomCodeInput.value.trim();
    setRoomActionsBusy(true, 'join');
    try {
      const ok = await mp.joinRoom(code, name);
      if (ok && el.roomModal.open) el.roomModal.close();
    } finally {
      setRoomActionsBusy(false);
    }
  });

  el.roomCodeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && el.roomCodeInput.value.trim()) {
      if (e.isComposing || e.keyCode === 229) return;
      e.preventDefault();
      el.joinRoomBtn.click();
    }
  });

  el.leaveRoomBtn.addEventListener('click', () => {
    _guestRetryCount = 99;
    clearRoomSession();
    mp.leaveRoom();
  });

  el.playerNameInput?.addEventListener('change', () => {
    savePrefs({ playerName: el.playerNameInput.value.trim() });
  });

  const copyFeedbackTimers = new WeakMap();
  let copyStatusClearTimer = null;
  let lastCopyAnnouncement = '';

  function reportRoomCopy(button, ok, successMsg, fallbackMsg) {
    clearTimeout(copyFeedbackTimers.get(button));
    clearTimeout(copyStatusClearTimer);
    [el.copyCodeBtn, el.copyInviteBtn].forEach((b) => {
      if (!b) return;
      b.removeAttribute('data-copied');
      b.removeAttribute('data-failed');
    });
    let message = ok ? successMsg : fallbackMsg;
    if (message === lastCopyAnnouncement) message += '\u00A0';
    lastCopyAnnouncement = message;

    if (el.roomCopyStatus) {
      el.roomCopyStatus.textContent = '';
      void button.offsetWidth;
      button.setAttribute(ok ? 'data-copied' : 'data-failed', '');
      requestAnimationFrame(() => {
        el.roomCopyStatus.textContent = message;
      });
      copyStatusClearTimer = setTimeout(() => {
        if (el.roomCopyStatus) el.roomCopyStatus.textContent = '';
      }, 2400);
    }

    copyFeedbackTimers.set(
      button,
      setTimeout(() => {
        button.removeAttribute('data-copied');
        button.removeAttribute('data-failed');
      }, 2400)
    );
  }

  el.copyCodeBtn?.addEventListener('click', async () => {
    if (!mp.roomCode) return;
    const copied = await copyText(mp.roomCode);
    reportRoomCopy(
      el.copyCodeBtn,
      copied,
      `Kode ${mp.roomCode} disalin`,
      `Gagal menyalin. Kode room: ${mp.roomCode}`
    );
  });

  el.copyInviteBtn.addEventListener('click', async () => {
    if (!mp.roomCode) return;
    const url = new URL(window.location.href);
    url.searchParams.set('room', mp.roomCode);
    const copied = await copyText(url.toString());
    reportRoomCopy(
      el.copyInviteBtn,
      copied,
      `Link room ${mp.roomCode} disalin`,
      `Gagal menyalin. Bagikan kode room: ${mp.roomCode}`
    );
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      mp.reconnectIfNeeded();
    }
  });
  window.addEventListener('online', () => {
    mp.reconnectIfNeeded();
  });

  // Restore saved instrument, laras & player name (fallback to Saron Barung Slendro)
  const prefs = loadPrefs();
  if (prefs.playerName && el.playerNameInput) {
    el.playerNameInput.value = prefs.playerName;
  }
  if (prefs.scale === 'slendro' || prefs.scale === 'pelog') {
    currentScale = prefs.scale;
    el.scaleBtns.forEach((b) => {
      const active = b.dataset.scale === currentScale;
      b.classList.toggle('active', active);
      b.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  }
  const initialInst =
    prefs.instrument && manifest.instruments.some((i) => i.id === prefs.instrument)
      ? prefs.instrument
      : 'saron-barung';

  engine.preloadMetronomeSamples();
  await selectInstrument(initialInst);
  renderRoster([]);

  // Check ?room=PAN-XXXX invite parameter vs saved room session across reload
  const params = new URLSearchParams(window.location.search);
  const inviteRoom = params.get('room');
  const savedSession = loadRoomSession();
  const normalizedInvite = inviteRoom ? mp.normalizeCode(inviteRoom) : '';

  if (inviteRoom && (!savedSession || normalizedInvite !== savedSession.roomCode)) {
    el.roomCodeInput.value = inviteRoom;
    if (!el.roomModal.open) el.roomModal.showModal();
  } else if (savedSession?.roomCode) {
    const restoreName =
      savedSession.playerName ||
      el.playerNameInput.value.trim() ||
      (savedSession.role === 'host' ? 'Host Studio' : 'Pemain');
    el.playerNameInput.value = restoreName;
    el.roomCodeInput.value = savedSession.roomCode;
    showToast(`Menyambung kembali ke room ${savedSession.roomCode}...`, 'gold');
    if (savedSession.role === 'host') {
      mp.createRoom(restoreName, savedSession.roomCode, { retryOnUnavailableId: true });
    } else {
      mp.joinRoom(savedSession.roomCode, restoreName);
    }
  }
}

init();
