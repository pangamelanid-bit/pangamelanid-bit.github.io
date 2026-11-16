/**
 * PAN Gamelan Online Studio — Zero-Latency Web Audio Engine
 * Uses AudioBuffer pre-decoding, lazy per-instrument loading,
 * natural real-time auto-mithet (1-tabuh & 2-tabuh), manual damping,
 * and MediaStream recording bus.
 */

const MITHET_PROFILES = {
  // Instrumen 1 tabuh: nada baru otomatis me-mithet nada sebelumnya + natural release
  'saron-peking':    { maxVoices: 1, sustain: 1.1 },
  'saron-barung':    { maxVoices: 1, sustain: 1.5 },
  'saron-demung':    { maxVoices: 1, sustain: 2.0 },
  'slenthem':        { maxVoices: 1, sustain: 2.2 },
  'kenong':          { maxVoices: 1, sustain: 2.6 },
  'kempul':          { maxVoices: 1, sustain: 3.0 },
  // Instrumen 2 tabuh: dukung 2 nada bersamaan (gembyang/kempyung), nada ke-3 me-mithet yang terlama
  'bonang-penerus':  { maxVoices: 2, sustain: 1.1 },
  'bonang-barung':   { maxVoices: 2, sustain: 1.6 },
  'gender-penerus':  { maxVoices: 2, sustain: 1.3 },
  'gender-barung':   { maxVoices: 2, sustain: 1.8 },
  'kethuk-kempyang': { maxVoices: 2, sustain: 1.5 },
  // Instrumen perkusif (Suwukan & Gong Ageng tidak memakai auto-mithet agar bergaung penuh secara alami)
  'gambang':         { maxVoices: 4, sustain: 1.2 },
  'kendhang':        { maxVoices: 4, sustain: 1.5 }
};

export class GamelanAudioEngine {
  constructor() {
    this.ctx = null;
    this.masterGain = null;
    this.metronomeGain = null;
    this.recordDest = null;
    this.woodNoiseBuffer = null;
    this.buffers = new Map(); // url -> AudioBuffer
    this.loadingPromises = new Map(); // url -> Promise<AudioBuffer|null>
    this.loadedInstruments = new Set(); // `${instId}:${scaleKey}`
    this.activeVoices = new Map(); // `${instId}:${scaleKey}:${noteId}` -> [{ source, gainNode, startedAt, damped }]
    this.instrumentVoices = new Map(); // instId -> [{ source, gainNode, startedAt, damped }]
    this.instrumentVolumes = new Map(); // instId -> 0..1
    this.masterVolume = 0.9;
    this.globalTuneCents = 0; // -600..+600 cents
    this.autoMithet = true;
  }

  setAutoMithet(enabled) {
    this.autoMithet = Boolean(enabled);
  }

  setGlobalTune(cents) {
    const clamped = Math.max(-600, Math.min(600, Number(cents) || 0));
    this.globalTuneCents = clamped;
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    for (const voices of this.instrumentVoices.values()) {
      for (const v of voices) {
        if (!v.damped && v.source && v.source.detune) {
          try {
            v.source.detune.setTargetAtTime(clamped + (v.noteDetune || 0), now, 0.015);
          } catch (_) {}
        }
      }
    }
  }

  ensureContext() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AudioCtx({ latencyHint: 'interactive' });
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = this.masterVolume;

      // Dedicated metronome monitor bus (follows master volume without bleeding into session recordings)
      this.metronomeGain = this.ctx.createGain();
      this.metronomeGain.gain.value = this.masterVolume;
      this.metronomeGain.connect(this.ctx.destination);

      // Gentle compressor to prevent clipping when 6+ players jam together
      this.compressor = this.ctx.createDynamicsCompressor();
      this.compressor.threshold.value = -8;
      this.compressor.knee.value = 12;
      this.compressor.ratio.value = 4;
      this.compressor.attack.value = 0.002;
      this.compressor.release.value = 0.15;

      this.masterGain.connect(this.compressor);
      this.compressor.connect(this.ctx.destination);

      if (this.ctx.createMediaStreamDestination) {
        this.recordDest = this.ctx.createMediaStreamDestination();
        this.compressor.connect(this.recordDest);
      }
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  }

  async unlock() {
    const ctx = this.ensureContext();
    if (ctx.state === 'suspended') {
      await ctx.resume();
    }
  }

  setMasterVolume(val) {
    this.masterVolume = Math.max(0, Math.min(1.2, val));
    if (this.ctx) {
      const now = this.ctx.currentTime;
      if (this.masterGain) {
        this.masterGain.gain.setTargetAtTime(this.masterVolume, now, 0.015);
      }
      if (this.metronomeGain) {
        this.metronomeGain.gain.setTargetAtTime(this.masterVolume, now, 0.015);
      }
    }
  }

  setInstrumentVolume(instId, val) {
    this.instrumentVolumes.set(instId, Math.max(0, Math.min(1.2, val)));
  }

  getInstrumentVolume(instId) {
    return this.instrumentVolumes.has(instId) ? this.instrumentVolumes.get(instId) : 1.0;
  }

  normalizeUrl(url) {
    if (typeof url === 'string' && url.startsWith('audio/studio/')) {
      return url.replace(/\.mp3$/i, '.pga');
    }
    return url;
  }

  async fetchAndDecode(url) {
    const resolvedUrl = this.normalizeUrl(url);
    if (this.buffers.has(resolvedUrl)) return this.buffers.get(resolvedUrl);
    if (this.loadingPromises.has(resolvedUrl)) return this.loadingPromises.get(resolvedUrl);

    const ctx = this.ensureContext();
    const promise = fetch(resolvedUrl)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status} for ${resolvedUrl}`);
        return res.arrayBuffer();
      })
      .then((arr) => ctx.decodeAudioData(arr))
      .then((audioBuffer) => {
        this.buffers.set(resolvedUrl, audioBuffer);
        this.loadingPromises.delete(resolvedUrl);
        return audioBuffer;
      })
      .catch((err) => {
        console.warn('[AudioEngine] Failed to load:', resolvedUrl, err);
        this.loadingPromises.delete(resolvedUrl);
        return null;
      });

    this.loadingPromises.set(resolvedUrl, promise);
    return promise;
  }

  isInstrumentLoaded(instId, scaleKey) {
    return this.loadedInstruments.has(`${instId}:${scaleKey}`);
  }

  async loadInstrument(instId, scaleKey, notes, onProgress) {
    const key = `${instId}:${scaleKey}`;
    if (this.loadedInstruments.has(key)) {
      if (onProgress) onProgress(1);
      return true;
    }
    this.ensureContext();
    let done = 0;
    const total = notes.length || 1;
    // Batasi antrean fetch+decode agar CPU ponsel tidak tersendat saat pindah instrumen berbilah banyak
    const concurrency = Math.min(4, total);
    let cursor = 0;
    const worker = async () => {
      while (cursor < notes.length) {
        const note = notes[cursor++];
        await this.fetchAndDecode(note.url);
        done += 1;
        if (onProgress) onProgress(done / total);
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
    this.loadedInstruments.add(key);
    return true;
  }

  dampVoice(voice, now, fadeSec = 0.085) {
    if (!voice || voice.damped) return;
    voice.damped = true;
    try {
      voice.gainNode.gain.cancelScheduledValues(now);
      const currentVal = Math.max(0.0001, voice.gainNode.gain.value);
      voice.gainNode.gain.setValueAtTime(currentVal, now);
      voice.gainNode.gain.exponentialRampToValueAtTime(0.0001, now + fadeSec);
      voice.source.stop(now + fadeSec + 0.01);
    } catch (_) {}
  }

  play(instId, scaleKey, noteId, url, { velocity = 1.0, pan = 0, noteDetune = 0 } = {}) {
    const ctx = this.ensureContext();
    const resolvedUrl = this.normalizeUrl(url);
    const buffer = this.buffers.get(resolvedUrl);

    if (!buffer) {
      // Lazy-fetch in background (useful when a remote player hits an instrument we haven't opened yet)
      this.fetchAndDecode(resolvedUrl);
      return false;
    }

    const now = ctx.currentTime;
    const isFreeResonance = noteId === 'gong-ageng' || noteId.startsWith('suwukan');
    const mithetGroup = isFreeResonance ? 'gong-ageng' : instId;
    const profile = isFreeResonance ? null : MITHET_PROFILES[mithetGroup];

    // Auto-Mithet Natural: damp older active voices on the same voice group
    if (!this.instrumentVoices.has(mithetGroup)) {
      this.instrumentVoices.set(mithetGroup, []);
    }
    const instList = this.instrumentVoices.get(mithetGroup);
    // Prune already damped entries
    for (let i = instList.length - 1; i >= 0; i -= 1) {
      if (instList[i].damped) instList.splice(i, 1);
    }

    if (this.autoMithet && profile) {
      while (instList.length >= profile.maxVoices) {
        const oldest = instList[0];
        // Preserve simultaneous strikes within 45ms unless queue exceeds safety cap
        if (now - oldest.startedAt <= 0.045 && instList.length < profile.maxVoices + 1) {
          break;
        }
        instList.shift();
        this.dampVoice(oldest, now, 0.085);
      }
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const baseDetune = Number(noteDetune) || 0;
    const totalDetune = (this.globalTuneCents || 0) + baseDetune;
    if (source.detune && totalDetune !== 0) {
      source.detune.setValueAtTime(totalDetune, now);
    }

    const gainNode = ctx.createGain();
    const vol = Math.max(0.05, Math.min(1.2, velocity * this.getInstrumentVolume(instId)));
    gainNode.gain.setValueAtTime(vol, now);

    // Schedule natural mithet release at the end of instrument sustain when autoMithet is ON
    if (this.autoMithet && profile && buffer.duration > profile.sustain) {
      const fadeTail = Math.min(0.25, profile.sustain * 0.15);
      const releaseStart = Math.max(0.05, profile.sustain - fadeTail);
      gainNode.gain.setValueAtTime(vol, now + releaseStart);
      gainNode.gain.exponentialRampToValueAtTime(0.0001, now + profile.sustain);
    }

    if (ctx.createStereoPanner && pan !== 0) {
      const panner = ctx.createStereoPanner();
      panner.pan.setValueAtTime(Math.max(-0.8, Math.min(0.8, pan)), now);
      source.connect(gainNode);
      gainNode.connect(panner);
      panner.connect(this.masterGain);
    } else {
      source.connect(gainNode);
      gainNode.connect(this.masterGain);
    }

    const voiceKey = `${instId}:${scaleKey}:${noteId}`;
    if (!this.activeVoices.has(voiceKey)) {
      this.activeVoices.set(voiceKey, []);
    }
    const voiceRecord = { source, gainNode, startedAt: now, damped: false, noteDetune: baseDetune };
    const list = this.activeVoices.get(voiceKey);

    // Keep voice list bounded per note to avoid memory buildup on fast trills
    if (list.length >= 4) {
      const oldest = list.shift();
      this.dampVoice(oldest, now, 0.05);
    }
    list.push(voiceRecord);
    instList.push(voiceRecord);

    source.onended = () => {
      voiceRecord.damped = true;
      const arr = this.activeVoices.get(voiceKey);
      if (arr) {
        const idx = arr.indexOf(voiceRecord);
        if (idx !== -1) arr.splice(idx, 1);
      }
      const iArr = this.instrumentVoices.get(mithetGroup);
      if (iArr) {
        const idx = iArr.indexOf(voiceRecord);
        if (idx !== -1) iArr.splice(idx, 1);
      }
    };

    source.start(now);
    if (this.autoMithet && profile && buffer.duration > profile.sustain) {
      source.stop(now + profile.sustain + 0.02);
    }
    return true;
  }

  /**
   * Javanese 'mithet' damping: smoothly stops ringing bronze resonance
   */
  damp(instId, scaleKey, noteId) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const prefix = noteId ? `${instId}:${scaleKey}:${noteId}` : `${instId}:${scaleKey}:`;

    for (const [k, voices] of this.activeVoices.entries()) {
      if (noteId ? k === prefix : k.startsWith(prefix)) {
        for (const v of voices) {
          this.dampVoice(v, now, 0.075);
        }
        voices.length = 0;
      }
    }
    if (!noteId) {
      if (this.instrumentVoices.has(instId)) {
        this.instrumentVoices.get(instId).length = 0;
      }
      if (instId === 'kempul' && this.instrumentVoices.has('gong-ageng')) {
        this.instrumentVoices.get('gong-ageng').length = 0;
      }
    }
  }

  preloadMetronomeSamples() {
    // Suara Keprak/Cempala kayu disintesis langsung tanpa sampel kendhang agar tidak memicu audio tak-dibutuhkan
    return Promise.resolve([]);
  }

  getWoodNoiseBuffer(ctx) {
    if (this.woodNoiseBuffer && this.woodNoiseBuffer.sampleRate === ctx.sampleRate) {
      return this.woodNoiseBuffer;
    }
    const len = Math.max(1, Math.floor(ctx.sampleRate * 0.03));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < len; i += 1) {
      ch[i] = (Math.random() * 2 - 1) * Math.exp(-i / (len * 0.25));
    }
    this.woodNoiseBuffer = buf;
    return buf;
  }

  playMetronomeAccent(isSelehFourthBeat = false, delaySec = 0) {
    const ctx = this.ensureContext();
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
      if (delaySec > 0.005) return;
    }
    const now = ctx.currentTime + Math.max(0, Number(delaySec) || 0);
    const output = this.metronomeGain || this.masterGain;

    // 1. Lapisan serangan kayu kering (bandpass-filtered transient burst ~22ms)
    const noise = ctx.createBufferSource();
    noise.buffer = this.getWoodNoiseBuffer(ctx);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(isSelehFourthBeat ? 1250 : 1900, now);
    bp.Q.setValueAtTime(3.2, now);
    const noiseGain = ctx.createGain();
    noiseGain.gain.setValueAtTime(isSelehFourthBeat ? 0.55 : 0.38, now);
    noiseGain.gain.exponentialRampToValueAtTime(0.001, now + 0.024);
    noise.connect(bp);
    bp.connect(noiseGain);
    noiseGain.connect(output);
    noise.start(now);
    noise.stop(now + 0.028);

    // 2. Resonansi badan kotak kayu keprak / cempala (2 mode inharmonik singkat tanpa nada tonal)
    const decay = isSelehFourthBeat ? 0.062 : 0.042;
    const modes = isSelehFourthBeat
      ? [
          { fStart: 560, fEnd: 340, level: 0.42, type: 'triangle', dur: decay },
          { fStart: 830, fEnd: 590, level: 0.24, type: 'sine', dur: 0.045 },
        ]
      : [
          { fStart: 920, fEnd: 640, level: 0.28, type: 'triangle', dur: decay },
          { fStart: 1380, fEnd: 1080, level: 0.16, type: 'sine', dur: 0.032 },
        ];

    for (const m of modes) {
      const osc = ctx.createOscillator();
      const oscGain = ctx.createGain();
      osc.type = m.type;
      osc.frequency.setValueAtTime(m.fStart, now);
      osc.frequency.exponentialRampToValueAtTime(m.fEnd, now + 0.022);
      oscGain.gain.setValueAtTime(m.level, now);
      oscGain.gain.exponentialRampToValueAtTime(0.001, now + m.dur);
      osc.connect(oscGain);
      oscGain.connect(output);
      osc.start(now);
      osc.stop(now + m.dur + 0.005);
    }
  }

  getRecordingStream() {
    this.ensureContext();
    return this.recordDest ? this.recordDest.stream : null;
  }
}
