/**
 * PAN Gamelan Online Studio — 2D Ornate SVG Instrument Renderer
 * Supports multi-touch pointer events (Android/iOS), glissando swipe-to-play,
 * traditional Javanese Bonang 2-row ergonomics, and keyboard shortcuts (Desktop).
 */

const SOLMISASI = {
  '1': 'Ji',
  '2': 'Ro',
  '3': 'Lu',
  '4': 'Pat',
  '5': 'Ma',
  '6': 'Nem',
  '7': 'Pi'
};

const BONANG_LAYOUTS = {
  // Slendro Tradisional: baris atas 6̇-5̇-3̇-2̇-1̇̇-2̇̇, baris bawah 1̇-2-3-5-6-1
  slendro: {
    top: ['6h', '5h', '3h', '2h', '1hh', '2hh'],
    bottom: ['1h', '2', '3', '5', '6', '1']
  },
  // Pelog Nem/Lima: posisi 1 di dalam (dekat 2), 7 di luar (1 rendah di Y, 1 tinggi di S)
  pelog: {
    top: ['4h', '6h', '5h', '3h', '2h', '1', '7h'],
    bottom: ['7', '1h', '2', '3', '5', '6', '4']
  },
  // Pelog Barang: tukar pencon 1 <-> 7 agar 7 berada di dalam (dekat 2) dan 1 di luar
  pelogBarang: {
    top: ['4h', '6h', '5h', '3h', '2h', '7h', '1'],
    bottom: ['1h', '7', '2', '3', '5', '6', '4']
  }
};

const BONANG_KEYS_TOP = ['Q', 'W', 'E', 'R', 'T', 'Y', 'U'];
const BONANG_KEYS_BOTTOM = ['A', 'S', 'D', 'F', 'G', 'H', 'J'];

// Split 2-Hand Panerusan keyboard (Kiri = Rendah, Kanan = Tinggi), 5-column aligned
const PANERUSAN_LEFT_LOW = ['Z', 'X', 'C', 'V', 'B'];
const PANERUSAN_LEFT_HOME = ['A', 'S', 'D', 'F', 'G'];
const PANERUSAN_RIGHT_HOME = ['H', 'J', 'K', 'L', ';'];
const PANERUSAN_RIGHT_TOP = ['Y', 'U', 'I', 'O', 'P'];
const PANERUSAN_STANDARD_KEYS = [
  'A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L', ';',
  'Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P',
];
// Pelog Barang pada Gambang mengganti bilah nada 1 menjadi 7 (+145 ct dari bilah 6 di bawahnya)
const GAMBANG_BARANG_MAP = {
  '1l':  { id: '7ll', label: '7\u0323\u0323\u0323', url: 'audio/studio/pelog/gambang/6ll.pga', detune: 145 },
  '1':   { id: '7l',  label: '7\u0323\u0323',       url: 'audio/studio/pelog/gambang/6l.pga',  detune: 145 },
  '1h':  { id: '7',   label: '7\u0323',             url: 'audio/studio/pelog/gambang/6.pga',   detune: 145 },
  '1hh': { id: '7h',  label: '7',                   url: 'audio/studio/pelog/gambang/6h.pga',  detune: 145 },
};

export class InstrumentStage {
  constructor(containerEl, { onHit, onDamp, onRender } = {}) {
    this.container = containerEl;
    this.onHit = onHit || (() => {});
    this.onDamp = onDamp || (() => {});
    this.onRender = onRender || (() => {});
    this.currentInstrument = null;
    this.currentScale = 'slendro';
    this.notes = [];
    this.noteById = new Map();
    this.keyMap = new Map(); // KeyboardEvent.key.toUpperCase() -> note
    this.padElements = new Map(); // note.id -> HTMLElement
    this.dampMode = false;
    this.bonangTraditionalOrder = true;
    this.bonangPelogVariant = 'nem'; // 'nem' (Nem/Lima) | 'barang' (tukar 1 <-> 7)
    this.panerusanSplitKeys = true; // true: Split 2 Tangan (Kiri Z-B/A-G, Kanan H-;/Y-P) | false: Standar manifest
    this.panerusanPelogPathet = 'bem'; // 'bem' (Nem/Lima) | 'barang'
    this.gambangGembyang = false; // khusus Gambang: bunyikan pasangan 1 oktaf bersamaan
    this.saronBarungBilahCount = 12; // khusus Saron Barung Pelog: 7 bilah (1-7) | 12 bilah (6l-3h)

    // Glissando / swipe-to-play state
    this.isPointerDragging = false;
    this.lastDraggedNoteId = null;
    this.lastPointerX = 0;
    this.lastPointerY = 0;

    this.bindDragListeners();
  }

  bindDragListeners() {
    this.container.addEventListener(
      'pointermove',
      (e) => {
        if (!this.isPointerDragging) return;
        if (
          Math.abs(e.clientX - this.lastPointerX) < 6 &&
          Math.abs(e.clientY - this.lastPointerY) < 6
        ) {
          return;
        }
        this.lastPointerX = e.clientX;
        this.lastPointerY = e.clientY;

        const target = document.elementFromPoint(e.clientX, e.clientY);
        const pad = target && target.closest ? target.closest('.gamelan-pad') : null;
        if (!pad) return;
        const noteId = pad.dataset.noteId;
        if (!noteId || noteId === this.lastDraggedNoteId) return;

        this.lastDraggedNoteId = noteId;
        const note = this.noteById.get(noteId);
        if (!note) return;

        if (this.dampMode) {
          this.onDamp(note);
          this.triggerDampVisual(note.id);
        } else {
          this.triggerStrike(note, 0.92, { shiftKey: e.shiftKey });
        }
      },
      { passive: true }
    );

    const resetDrag = () => {
      this.isPointerDragging = false;
      this.lastDraggedNoteId = null;
    };
    window.addEventListener('pointerup', resetDrag);
    window.addEventListener('pointercancel', resetDrag);
  }

  setDampMode(active) {
    this.dampMode = active;
    this.container.classList.toggle('is-damping', active);
  }

  setBonangOrder(isTraditional) {
    this.bonangTraditionalOrder = Boolean(isTraditional);
    if (this.currentInstrument && this.currentInstrument.layout === 'bonang') {
      this.render(this.currentInstrument, this.currentScale);
    }
  }

  setBonangPelogVariant(variant) {
    this.bonangPelogVariant = variant === 'barang' ? 'barang' : 'nem';
    if (
      this.currentInstrument &&
      this.currentInstrument.layout === 'bonang' &&
      this.currentScale === 'pelog'
    ) {
      this.render(this.currentInstrument, this.currentScale);
    }
  }

  setPanerusanSplitKeys(enabled) {
    this.panerusanSplitKeys = Boolean(enabled);
    if (
      this.currentInstrument &&
      this.currentInstrument.category === 'Panerusan' &&
      this.currentInstrument.layout === 'bilah'
    ) {
      this.render(this.currentInstrument, this.currentScale);
    }
  }

  setGambangGembyang(enabled) {
    this.gambangGembyang = Boolean(enabled);
  }

  setPanerusanPelogPathet(pathet) {
    this.panerusanPelogPathet = pathet === 'barang' ? 'barang' : 'bem';
    if (
      this.currentInstrument &&
      this.currentInstrument.category === 'Panerusan' &&
      this.currentScale === 'pelog'
    ) {
      this.render(this.currentInstrument, this.currentScale);
    }
  }

  getPanerusanPelogNotes(instrument, rawNotes) {
    if (instrument.id === 'gambang') {
      if (this.panerusanPelogPathet !== 'barang') return rawNotes;
      return rawNotes.map((n) => {
        const rep = GAMBANG_BARANG_MAP[n.id];
        return rep ? { ...n, ...rep } : n;
      });
    }

    // Gender Barung & Penerus: Bem menghilangkan nada 7, Barang menghilangkan nada 1 (masing-masing 14 bilah)
    const excludedPrefix = this.panerusanPelogPathet === 'barang' ? '1' : '7';
    return rawNotes
      .filter((n) => !n.id.startsWith(excludedPrefix))
      .map((n, idx) => ({
        ...n,
        key: PANERUSAN_STANDARD_KEYS[idx] || n.key,
      }));
  }

  getGambangGembyangPartner(note) {
    if (!note || !this.currentInstrument || this.currentInstrument.id !== 'gambang') {
      return null;
    }
    const idx = this.notes.findIndex((n) => n.id === note.id);
    if (idx === -1) return null;

    // Gambang memakai siklus 5 nada per oktaf (6 1 2 3 5); prioritaskan oktaf bawah (-5), fallback atas (+5)
    const pitchChar = note.id[0];
    const candidates = [this.notes[idx - 5], this.notes[idx + 5]].filter(Boolean);
    return candidates.find((c) => c.id[0] === pitchChar) || null;
  }

  setSaronBarungBilahCount(count) {
    this.saronBarungBilahCount = count === 7 ? 7 : 12;
    if (
      this.currentInstrument &&
      this.currentInstrument.id === 'saron-barung' &&
      this.currentScale === 'pelog'
    ) {
      this.render(this.currentInstrument, this.currentScale);
    }
  }

  triggerStrike(note, velocity = 1.0, { shiftKey = false } = {}) {
    this.onHit(note, velocity);
    this.triggerHitVisual(note.id);

    const useGembyang =
      this.currentInstrument?.id === 'gambang' && (this.gambangGembyang || shiftKey);
    if (!useGembyang) return;

    const partner = this.getGambangGembyangPartner(note);
    if (!partner) return;

    const scaleAtStrike = this.currentScale;
    setTimeout(() => {
      if (this.currentInstrument?.id !== 'gambang' || this.currentScale !== scaleAtStrike) return;
      this.onHit(partner, Math.max(0.75, velocity * 0.9));
      this.triggerHitVisual(partner.id);
    }, 12);
  }

  getPanerusanSplitInfo(totalNotes) {
    const leftCount = totalNotes >= 19 ? 10 : Math.floor(totalNotes / 2);
    const leftExtra = Math.max(0, leftCount - PANERUSAN_LEFT_HOME.length);
    const rightCount = Math.max(0, totalNotes - leftCount);
    const rightExtra = Math.max(0, rightCount - PANERUSAN_RIGHT_HOME.length);

    const leftKeys = [
      ...PANERUSAN_LEFT_LOW.slice(0, leftExtra),
      ...PANERUSAN_LEFT_HOME.slice(0, Math.min(leftCount, PANERUSAN_LEFT_HOME.length)),
    ];
    const rightKeys = [
      ...PANERUSAN_RIGHT_HOME.slice(0, Math.min(rightCount, PANERUSAN_RIGHT_HOME.length)),
      ...PANERUSAN_RIGHT_TOP.slice(0, rightExtra),
    ];

    return {
      keys: [...leftKeys, ...rightKeys],
      leftCount,
    };
  }

  getSolmisasi(noteId) {
    if (!noteId) return '';
    if (noteId.startsWith('suwukan-')) {
      const num = noteId.slice('suwukan-'.length)[0];
      return SOLMISASI[num] || '';
    }
    if (!/^[1-7]/.test(noteId)) return '';
    return SOLMISASI[noteId[0]] || '';
  }

  render(instrument, scaleKey) {
    this.currentInstrument = instrument;
    this.currentScale = scaleKey;
    const rawNotes = instrument.scales[scaleKey] || instrument.scales.both || [];
    const layout = instrument.layout || 'bilah';
    let baseNotes = rawNotes;
    if (instrument.category === 'Panerusan' && scaleKey === 'pelog' && layout === 'bilah') {
      baseNotes = this.getPanerusanPelogNotes(instrument, rawNotes);
    } else if (
      instrument.id === 'saron-barung' &&
      scaleKey === 'pelog' &&
      this.saronBarungBilahCount === 7
    ) {
      baseNotes = rawNotes
        .filter((n) => /^[1-7]$/.test(n.id))
        .map((n, idx) => ({
          ...n,
          key: PANERUSAN_STANDARD_KEYS[idx] || n.key,
        }));
    }
    const usePanerusanSplit =
      this.panerusanSplitKeys &&
      instrument.category === 'Panerusan' &&
      layout === 'bilah';
    const splitInfo = usePanerusanSplit
      ? this.getPanerusanSplitInfo(baseNotes.length)
      : null;
    const renderNotes = splitInfo
      ? baseNotes.map((n, idx) => ({
          ...n,
          key: splitInfo.keys[idx] || n.key,
          hand: idx < splitInfo.leftCount ? 'left' : 'right',
          isHandSplitStart: idx === splitInfo.leftCount,
        }))
      : baseNotes;

    this.notes = renderNotes;
    this.noteById.clear();
    this.keyMap.clear();
    this.padElements.clear();

    this.container.innerHTML = '';

    const stageWrap = document.createElement('div');
    stageWrap.className = `instrument-rack rack-${layout} inst-${instrument.id}`;

    // Javanese decorative corner ornaments
    stageWrap.innerHTML = `
      <div class="rack-ornament rack-ornament-tl" aria-hidden="true"></div>
      <div class="rack-ornament rack-ornament-tr" aria-hidden="true"></div>
      <div class="rack-ornament rack-ornament-bl" aria-hidden="true"></div>
      <div class="rack-ornament rack-ornament-br" aria-hidden="true"></div>
    `;

    const grid = document.createElement('div');
    grid.className = `pads-grid layout-${layout}`;
    if (layout === 'bilah') {
      grid.tabIndex = 0;
      grid.setAttribute('role', 'region');
      grid.setAttribute('aria-label', 'Deretan Bilah Instrumen');
    }
    if (layout === 'bilah' && renderNotes.length > 10) {
      grid.classList.add('is-dense');
    }

    if (layout === 'bonang') {
      const byId = new Map(rawNotes.map((n) => [n.id, n]));
      let topNotes = [];
      let bottomNotes = [];

      if (this.bonangTraditionalOrder && BONANG_LAYOUTS[scaleKey]) {
        const layoutKey =
          scaleKey === 'pelog' && this.bonangPelogVariant === 'barang' ? 'pelogBarang' : scaleKey;
        const order = BONANG_LAYOUTS[layoutKey];
        topNotes = order.top.map((id) => byId.get(id)).filter(Boolean);
        bottomNotes = order.bottom.map((id) => byId.get(id)).filter(Boolean);
      } else {
        const mid = Math.ceil(rawNotes.length / 2);
        bottomNotes = rawNotes.slice(0, mid);
        topNotes = rawNotes.slice(mid);
      }

      const mappedTop = topNotes.map((n, idx) => ({
        ...n,
        key: BONANG_KEYS_TOP[idx] || ''
      }));
      const mappedBottom = bottomNotes.map((n, idx) => ({
        ...n,
        key: BONANG_KEYS_BOTTOM[idx] || ''
      }));

      [...mappedTop, ...mappedBottom].forEach((n) => {
        this.noteById.set(n.id, n);
        if (n.key) this.keyMap.set(n.key.toUpperCase(), n);
      });

      const topRow = document.createElement('div');
      topRow.className = 'bonang-row bonang-row-top';
      const bottomRow = document.createElement('div');
      bottomRow.className = 'bonang-row bonang-row-bottom';

      mappedTop.forEach((n, idx) =>
        topRow.appendChild(this.createPad(n, layout, idx, mappedTop.length + mappedBottom.length))
      );
      mappedBottom.forEach((n, idx) =>
        bottomRow.appendChild(
          this.createPad(n, layout, mappedTop.length + idx, mappedTop.length + mappedBottom.length)
        )
      );
      grid.appendChild(topRow);
      grid.appendChild(bottomRow);
    } else {
      renderNotes.forEach((n, idx) => {
        this.noteById.set(n.id, n);
        if (n.key) {
          this.keyMap.set(n.key.toUpperCase(), n);
        }
        grid.appendChild(this.createPad(n, layout, idx, renderNotes.length));
      });
    }

    stageWrap.appendChild(grid);
    this.container.appendChild(stageWrap);
    this.onRender(instrument, scaleKey);
  }

  createPad(note, layout, index, total) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `gamelan-pad pad-${layout}`;
    if (layout === 'bilah' && note.hand) {
      btn.classList.add(note.hand === 'left' ? 'is-left-hand' : 'is-right-hand');
      if (note.isHandSplitStart) {
        btn.classList.add('is-hand-split');
      }
      btn.title =
        note.hand === 'left'
          ? 'Tangan Kiri: Nada Rendah (Z-B / A-G)'
          : 'Tangan Kanan: Nada Tinggi (H-; / Y-P)';
    }
    if (layout === 'gong') {
      if (note.id === 'gong-ageng') {
        btn.classList.add('is-gong-ageng');
      } else if (note.id.startsWith('suwukan')) {
        btn.classList.add('is-suwukan');
      } else {
        btn.classList.add('is-kempul');
      }
    }
    btn.dataset.noteId = note.id;
    btn.setAttribute('aria-label', `${this.currentInstrument.name} nada ${note.label}`);

    // Graduated size for bilah
    if (layout === 'bilah') {
      const ratio = total > 1 ? index / (total - 1) : 0.5;
      const heightPct = 100 - ratio * 22; // lower notes taller, higher notes shorter
      btn.style.setProperty('--bilah-height', `${heightPct}%`);
    }

    let svgMarkup = '';
    if (layout === 'bonang' || layout === 'pencon') {
      svgMarkup = `
        <svg class="pad-svg" viewBox="0 0 120 120" aria-hidden="true">
          <defs>
            <radialGradient id="penconGrad-${index}" cx="45%" cy="38%" r="58%">
              <stop offset="0%" stop-color="#FFE66D"/>
              <stop offset="45%" stop-color="#D9A026"/>
              <stop offset="85%" stop-color="#7D5200"/>
              <stop offset="100%" stop-color="#3A2300"/>
            </radialGradient>
            <radialGradient id="bossGrad-${index}" cx="40%" cy="35%" r="55%">
              <stop offset="0%" stop-color="#FFF5B8"/>
              <stop offset="60%" stop-color="#F4C430"/>
              <stop offset="100%" stop-color="#8A5B00"/>
            </radialGradient>
          </defs>
          <circle cx="60" cy="60" r="52" fill="url(#penconGrad-${index})" stroke="#F4C430" stroke-width="2.5"/>
          <circle cx="60" cy="60" r="40" fill="none" stroke="rgba(255,230,109,0.35)" stroke-width="1.2" stroke-dasharray="4 3"/>
          <circle cx="60" cy="60" r="17" fill="url(#bossGrad-${index})" stroke="#5C3B00" stroke-width="1.5"/>
        </svg>
      `;
    } else if (layout === 'gong') {
      svgMarkup = `
        <svg class="pad-svg" viewBox="0 0 160 160" aria-hidden="true">
          <defs>
            <radialGradient id="gongGrad-${index}" cx="42%" cy="38%" r="58%">
              <stop offset="0%" stop-color="#FFE66D"/>
              <stop offset="35%" stop-color="#D9A026"/>
              <stop offset="78%" stop-color="#5E3C00"/>
              <stop offset="100%" stop-color="#1E1200"/>
            </radialGradient>
          </defs>
          <path d="M22 20 L138 20" stroke="#F4C430" stroke-width="5" stroke-linecap="round"/>
          <line x1="48" y1="20" x2="54" y2="36" stroke="#B48A28" stroke-width="2.5"/>
          <line x1="112" y1="20" x2="106" y2="36" stroke="#B48A28" stroke-width="2.5"/>
          <circle cx="80" cy="90" r="58" fill="url(#gongGrad-${index})" stroke="#F4C430" stroke-width="3"/>
          <circle cx="80" cy="90" r="44" fill="none" stroke="rgba(255,230,109,0.28)" stroke-width="1.5"/>
          <circle cx="80" cy="90" r="18" fill="#FFD700" stroke="#6E4700" stroke-width="2"/>
        </svg>
      `;
    } else if (layout === 'kendhang') {
      svgMarkup = `
        <svg class="pad-svg" viewBox="0 0 120 120" aria-hidden="true">
          <defs>
            <radialGradient id="skinGrad-${index}" cx="50%" cy="45%" r="55%">
              <stop offset="0%" stop-color="#FAF0DC"/>
              <stop offset="70%" stop-color="#DFC89E"/>
              <stop offset="100%" stop-color="#9A7945"/>
            </radialGradient>
          </defs>
          <circle cx="60" cy="60" r="50" fill="#2B1406" stroke="#F4C430" stroke-width="3"/>
          <circle cx="60" cy="60" r="42" fill="url(#skinGrad-${index})" stroke="#6B4423" stroke-width="2"/>
          <circle cx="60" cy="60" r="14" fill="rgba(58,34,12,0.14)"/>
        </svg>
      `;
    }

    const solmisasi = this.getSolmisasi(note.id);
    btn.innerHTML = `
      ${svgMarkup}
      <span class="pad-glow" aria-hidden="true"></span>
      <span class="pad-label-group">
        <span class="pad-label">${note.label}</span>
        ${solmisasi ? `<span class="pad-solmisasi">${solmisasi}</span>` : ''}
      </span>
      ${note.key ? `<span class="pad-key" aria-hidden="true">${note.key}</span>` : ''}
    `;

    // Instant multi-touch & mouse response + glissando drag start
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.isPointerDragging = true;
      this.lastDraggedNoteId = note.id;
      this.lastPointerX = e.clientX;
      this.lastPointerY = e.clientY;
      if (this.dampMode) {
        this.onDamp(note);
        this.triggerDampVisual(note.id);
      } else {
        this.triggerStrike(note, 1.0, { shiftKey: e.shiftKey });
      }
    });

    // Keyboard Enter activation on focused pad button
    btn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        if (e.repeat) return;
        if (this.dampMode) {
          this.onDamp(note);
          this.triggerDampVisual(note.id);
        } else {
          this.triggerStrike(note, 1.0, { shiftKey: e.shiftKey });
        }
      }
    });

    this.padElements.set(note.id, btn);
    return btn;
  }

  handleKeyDown(e) {
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    if (
      e.target &&
      (e.target.tagName === 'INPUT' ||
        e.target.tagName === 'TEXTAREA' ||
        e.target.isContentEditable)
    ) {
      return;
    }

    if (e.code === 'Space') {
      e.preventDefault();
      this.setDampMode(true);
      if (this.currentInstrument && this.currentInstrument.canDamp) {
        this.onDamp(null); // damp all ringing notes of current instrument
      }
      return;
    }

    let k = e.key.toUpperCase();
    if (k === ':' || e.code === 'Semicolon') {
      k = ';';
    }
    let note = this.keyMap.get(k);
    // Kemudahan notasi Kepatihan: tombol angka 1-7 pada keyboard ikut membunyikan nada pokok 1-7 untuk kategori Balungan
    if (!note && this.currentInstrument?.category === 'Balungan' && /^[1-7]$/.test(k)) {
      note = this.noteById.get(k);
    }
    if (note) {
      e.preventDefault();
      this.triggerStrike(note, 1.0, { shiftKey: e.shiftKey });
    }
  }

  handleKeyUp(e) {
    if (e.code === 'Space') {
      this.setDampMode(false);
    }
  }

  triggerHitVisual(noteId, isRemote = false) {
    const el = this.padElements.get(noteId);
    if (!el) return;
    const cls = isRemote ? 'is-remote-hit' : 'is-hit';
    clearTimeout(el._hitTimer);
    if (el._hitRaf) {
      cancelAnimationFrame(el._hitRaf);
      el._hitRaf = 0;
    }

    if (el.classList.contains('is-hit') || el.classList.contains('is-remote-hit')) {
      el.classList.remove('is-hit', 'is-remote-hit');
      el._hitRaf = requestAnimationFrame(() => {
        el._hitRaf = 0;
        el.classList.add(cls);
      });
    } else {
      el.classList.add(cls);
    }

    el._hitTimer = setTimeout(() => {
      el.classList.remove('is-hit', 'is-remote-hit');
    }, 220);
  }

  triggerDampVisual(noteId) {
    const el = this.padElements.get(noteId);
    if (!el) return;
    el.classList.add('is-damped');
    setTimeout(() => el.classList.remove('is-damped'), 180);
  }
}
