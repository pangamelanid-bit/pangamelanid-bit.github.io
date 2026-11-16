/**
 * PAN Gamelan Online Studio — WebRTC P2P Multiplayer (PeerJS)
 * Uses a lightweight Host-Relayed Star topology so mobile Android clients
 * only maintain 1 low-latency DataChannel connection.
 */
const ROOM_PREFIX = 'pangamelan-studio-';
const CONNECT_TIMEOUT_MS = 15000;
const PEER_CONFIG = {
  debug: 1,
  pingInterval: 15000,
  config: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' }
    ]
  }
};

export class MultiplayerManager {
  constructor({
    onStatusChange,
    onRosterChange,
    onRemoteHit,
    onRemoteDamp,
    onRemoteTempo,
    onRemoteTune,
    onEmote,
    onGuestConnected,
    onTempoRequest,
    onClockSync
  } = {}) {
    this.onStatusChange = onStatusChange || (() => {});
    this.onRosterChange = onRosterChange || (() => {});
    this.onRemoteHit = onRemoteHit || (() => {});
    this.onRemoteDamp = onRemoteDamp || (() => {});
    this.onRemoteTempo = onRemoteTempo || (() => {});
    this.onRemoteTune = onRemoteTune || (() => {});
    this.onEmote = onEmote || (() => {});
    this.onGuestConnected = onGuestConnected || (() => {});
    this.onTempoRequest = onTempoRequest || (() => {});
    this.onClockSync = onClockSync || (() => {});

    this.peer = null;
    this.eventSource = null;
    this.roomCode = null;
    this.isHost = false;
    this._manuallyLeaving = false;
    this._reconnectAttempts = 0;
    this.clockOffsetMs = 0;
    this._bestRttMs = Infinity;
    this._clockPingTimer = null;
    this._clockBurstTimers = [];
    this.connections = new Map(); // peerId -> DataConnection | RelayConnection
    this.roster = new Map(); // peerId -> { id, name, instId, scale, isHost }

    this.localProfile = {
      id: 'local',
      name: 'Pemain',
      instId: 'saron-barung',
      scale: 'slendro',
      isHost: false
    };

    if (typeof window !== 'undefined') {
      const releasePeerOnUnload = () => {
        if (this.peer && !this.peer.destroyed) {
          try {
            this.peer.destroy();
          } catch (_) {}
        }
      };
      window.addEventListener('pagehide', releasePeerOnUnload);
      window.addEventListener('beforeunload', releasePeerOnUnload);
    }
  }

  setLocalProfile(partial) {
    Object.assign(this.localProfile, partial);
    if (this.peer && this.peer.id) {
      this.localProfile.id = this.peer.id;
      this.roster.set(this.peer.id, { ...this.localProfile });
      this.emitRoster();
      this.broadcast({ type: 'profile', profile: this.localProfile });
    }
  }

  generateRoomCode() {
    const num = Math.floor(1000 + Math.random() * 9000);
    return `PAN-${num}`;
  }

  normalizeCode(code) {
    return String(code || '')
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9-]/g, '');
  }

  _formatPeerError(err, code, action = 'create') {
    const type = err?.type || 'network';
    if (type === 'unavailable-id') {
      return `Kode ${code} sudah dipakai. Coba kode lain.`;
    }
    if (type === 'peer-unavailable') {
      return `Room ${code} tidak ditemukan atau Host terputus (${type}). Pastikan Host sudah menekan Buat Room Baru & tab Host tetap aktif.`;
    }
    if (['network', 'socket-error', 'socket-closed', 'server-error', 'ssl-unavailable'].includes(type)) {
      return `Server room tidak terjangkau (${type}). Periksa koneksi internet pada laptop dan ponsel.`;
    }
    if (type === 'webrtc') {
      return `Jalur P2P terblokir jaringan (${type}). Jika memakai hotspot ponsel, pastikan AP Isolation mati atau coba pakai HTTPS.`;
    }
    return action === 'join'
      ? `Gagal masuk room ${code} (${type}).`
      : `Koneksi P2P bermasalah (${type}).`;
  }

  _attachReconnect(peer) {
    peer.on('disconnected', () => {
      if (this.peer !== peer || peer.destroyed || this._manuallyLeaving) return;
      if (this._reconnectAttempts >= 12) {
        if (this.connections.size === 0 && (typeof document === 'undefined' || !document.hidden)) {
          this.onStatusChange('error', 'Koneksi signaling terputus. Coba buat/gabung ulang room.');
        }
        return;
      }
      this._reconnectAttempts += 1;
      const delay = Math.min(4000, 800 * this._reconnectAttempts);
      setTimeout(() => {
        if (this.peer === peer && !peer.destroyed && peer.disconnected && !this._manuallyLeaving) {
          try {
            peer.reconnect();
          } catch (_) {}
        }
      }, delay);
    });
  }

  reconnectIfNeeded() {
    if (this.peer && !this.peer.destroyed && this.peer.disconnected && !this._manuallyLeaving) {
      this._reconnectAttempts = 0;
      try {
        this.peer.reconnect();
      } catch (_) {}
    }
  }

  async _probeRelay() {
    if (typeof fetch !== 'function' || typeof EventSource === 'undefined') return false;
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = setTimeout(() => ctrl?.abort(), 1200);
    try {
      const res = await fetch('/api/studio-health', {
        cache: 'no-store',
        signal: ctrl?.signal
      });
      if (!res.ok) return false;
      const data = await res.json();
      return Boolean(data && data.ok);
    } catch (_) {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  _postRelay(room, from, to, payload) {
    if (typeof fetch !== 'function') return;
    fetch('/api/studio-room/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ room, from, to, payload })
    }).catch((err) => {
      console.warn('[Multiplayer] Relay send error:', err);
    });
  }

  _createRelayConn(remotePeerId, roomCode, selfId) {
    const listeners = new Map();
    const conn = {
      peer: remotePeerId,
      open: false,
      on(ev, fn) {
        if (!listeners.has(ev)) listeners.set(ev, []);
        listeners.get(ev).push(fn);
      },
      emit(ev, ...args) {
        for (const fn of listeners.get(ev) || []) fn(...args);
      },
      send: (payload) => {
        if (!conn.open) return;
        this._postRelay(roomCode, selfId, remotePeerId, payload);
      },
      close() {
        if (!conn.open && conn._closed) return;
        conn.open = false;
        conn._closed = true;
        conn.emit('close');
      }
    };
    return conn;
  }

  async _createRelayRoom(code) {
    const id = 'host-' + Math.random().toString(36).slice(2, 8);
    return new Promise((resolve) => {
      let settled = false;
      const url = `/api/studio-room/events?room=${encodeURIComponent(code)}&peerId=${encodeURIComponent(id)}&role=host`;
      const es = new EventSource(url);
      this.eventSource = es;
      const peerShim = {
        id,
        destroyed: false,
        disconnected: false,
        reconnect() {},
        destroy() {
          this.destroyed = true;
        }
      };
      this.peer = peerShim;

      const timer = setTimeout(() => {
        if (settled || this.eventSource !== es) return;
        settled = true;
        es.close();
        this.onStatusChange('error', 'Timeout membuat room di server lokal.');
        resolve(null);
      }, CONNECT_TIMEOUT_MS);

      es.addEventListener('ready', (e) => {
        if (this.eventSource !== es) return;
        clearTimeout(timer);
        const info = JSON.parse(e.data || '{}');
        this.roomCode = info.room || code;
        this.localProfile.id = id;
        this.roster.clear();
        this.roster.set(id, { ...this.localProfile });
        this.emitRoster();
        this.onStatusChange('connected', `Room ${this.roomCode} Aktif (Host)`);
        if (!settled) {
          settled = true;
          resolve(this.roomCode);
        }
      });

      es.addEventListener('peer-open', (e) => {
        if (this.eventSource !== es) return;
        const { peerId } = JSON.parse(e.data || '{}');
        if (!peerId) return;
        const conn = this._createRelayConn(peerId, this.roomCode, id);
        this.setupConnection(conn);
        conn.open = true;
        conn.emit('open');
      });

      es.addEventListener('msg', (e) => {
        if (this.eventSource !== es) return;
        const { from, payload } = JSON.parse(e.data || '{}');
        const conn = this.connections.get(from);
        conn?.emit('data', payload);
      });

      es.addEventListener('peer-close', (e) => {
        if (this.eventSource !== es) return;
        const { peerId } = JSON.parse(e.data || '{}');
        const conn = this.connections.get(peerId);
        conn?.close();
      });

      es.addEventListener('room-error', (e) => {
        if (this.eventSource !== es || settled) return;
        clearTimeout(timer);
        settled = true;
        es.close();
        const err = JSON.parse(e.data || '{}');
        this.onStatusChange('error', err.message || `Gagal membuat room ${code}.`);
        resolve(null);
      });

      es.onerror = () => {
        if (this.eventSource !== es || this._manuallyLeaving) return;
        if (!settled && es.readyState === EventSource.CLOSED) {
          clearTimeout(timer);
          settled = true;
          this.onStatusChange('error', 'Server room lokal tidak terjangkau.');
          resolve(null);
        }
      };
    });
  }

  async _joinRelayRoom(primaryCode, fallbackCode) {
    const id = 'guest-' + Math.random().toString(36).slice(2, 8);
    return new Promise((resolve) => {
      let settled = false;
      let triedFallback = false;
      let activeEs = null;
      let hostConn = null;

      const peerShim = {
        id,
        destroyed: false,
        disconnected: false,
        reconnect() {},
        destroy() {
          this.destroyed = true;
        }
      };
      this.peer = peerShim;

      const failJoin = (message) => {
        clearTimeout(timer);
        if (settled || this.peer !== peerShim) return;
        settled = true;
        if (activeEs) {
          try { activeEs.close(); } catch (_) {}
        }
        this.onStatusChange('error', message);
        resolve(false);
      };

      const timer = setTimeout(() => {
        failJoin(`Timeout masuk ke ${this.roomCode}. Pastikan Host masih aktif.`);
      }, CONNECT_TIMEOUT_MS);

      const connectCode = (targetCode) => {
        if (activeEs) {
          try { activeEs.close(); } catch (_) {}
        }
        this.roomCode = targetCode;
        this.onStatusChange('connecting', `2/2 Membuka jalur studio ke ${targetCode}…`);
        const url = `/api/studio-room/events?room=${encodeURIComponent(targetCode)}&peerId=${encodeURIComponent(id)}&role=guest`;
        const es = new EventSource(url);
        activeEs = es;
        this.eventSource = es;

        es.addEventListener('ready', (e) => {
          if (this.eventSource !== es || this.peer !== peerShim) return;
          clearTimeout(timer);
          const info = JSON.parse(e.data || '{}');
          const resolvedRoom = info.room || targetCode;
          const hostId = info.hostId;
          this.roomCode = resolvedRoom;
          this.localProfile.id = id;
          hostConn = this._createRelayConn(hostId, resolvedRoom, id);
          this.setupConnection(hostConn, () => {
            if (this.peer !== peerShim) return;
            this.onStatusChange('connected', `Terhubung ke ${resolvedRoom}`);
            if (!settled) {
              settled = true;
              resolve(true);
            }
          });
          hostConn.open = true;
          hostConn.emit('open');
        });

        es.addEventListener('msg', (e) => {
          if (this.eventSource !== es) return;
          const { payload } = JSON.parse(e.data || '{}');
          hostConn?.emit('data', payload);
        });

        es.addEventListener('room-closed', () => {
          if (this.eventSource !== es) return;
          es.close();
          hostConn?.close();
        });

        es.addEventListener('room-error', (e) => {
          if (this.eventSource !== es || settled) return;
          const err = JSON.parse(e.data || '{}');
          es.close();
          if (err.type === 'peer-unavailable' && fallbackCode && !triedFallback) {
            triedFallback = true;
            connectCode(fallbackCode);
            return;
          }
          failJoin(err.message || `Gagal masuk room ${targetCode}.`);
        });

        es.onerror = () => {
          if (this.eventSource !== es || this._manuallyLeaving) return;
          if (!settled && es.readyState === EventSource.CLOSED) {
            failJoin(`Server room lokal untuk ${targetCode} terputus.`);
          }
        };
      };

      connectCode(primaryCode);
    });
  }

  async createRoom(playerName, customCode, opts = {}) {
    const retryOnUnavailableId = Boolean(opts.retryOnUnavailableId);
    const maxUnavailableRetries = typeof opts.maxRetries === 'number' ? opts.maxRetries : 4;
    const attempt = typeof opts._attempt === 'number' ? opts._attempt : 0;

    this.leaveRoom();
    const useRelay = await this._probeRelay();
    if (!useRelay && typeof window.Peer === 'undefined') {
      this.onStatusChange('error', 'PeerJS belum termuat. Periksa koneksi internet.');
      return null;
    }

    this._manuallyLeaving = false;
    this._reconnectAttempts = 0;
    const code = this.normalizeCode(customCode) || this.generateRoomCode();
    this.roomCode = code;
    this.isHost = true;
    this.localProfile.name = playerName || 'Host Studio';
    this.localProfile.isHost = true;
    this.onStatusChange(
      'connecting',
      attempt > 0 ? `Menyambung ulang room ${code}...` : `Membuat room ${code}...`
    );

    if (useRelay) {
      return this._createRelayRoom(code);
    }

    return new Promise((resolve) => {
      let settled = false;
      const peer = new window.Peer(ROOM_PREFIX + code, PEER_CONFIG);
      this.peer = peer;

      const timer = setTimeout(() => {
        if (settled || this.peer !== peer) return;
        settled = true;
        this.onStatusChange('error', 'Timeout membuat room. Periksa koneksi internet ke server PeerJS.');
        resolve(null);
      }, CONNECT_TIMEOUT_MS);

      this._attachReconnect(peer);

      peer.on('open', (id) => {
        if (this.peer !== peer) return;
        clearTimeout(timer);
        this._reconnectAttempts = 0;
        this.localProfile.id = id;
        this.roster.clear();
        this.roster.set(id, { ...this.localProfile });
        this.emitRoster();
        this.onStatusChange('connected', `Room ${code} Aktif (Host)`);
        if (!settled) {
          settled = true;
          resolve(code);
        }
      });

      peer.on('connection', (conn) => {
        if (this.peer !== peer) return;
        this.setupConnection(conn);
      });

      peer.on('error', (err) => {
        if (this.peer !== peer) return;
        clearTimeout(timer);
        if (retryOnUnavailableId && err?.type === 'unavailable-id' && attempt < maxUnavailableRetries) {
          if (!settled) {
            settled = true;
            setTimeout(() => {
              if (this._manuallyLeaving) {
                resolve(null);
                return;
              }
              this.createRoom(playerName, code, {
                ...opts,
                _attempt: attempt + 1
              }).then(resolve);
            }, 1200);
          }
          return;
        }
        console.warn('[Multiplayer] Peer error:', err);
        this.onStatusChange('error', this._formatPeerError(err, code, 'create'));
        if (!settled) {
          settled = true;
          resolve(null);
        }
      });
    });
  }

  async joinRoom(codeInput, playerName) {
    this.leaveRoom();
    const useRelay = await this._probeRelay();
    if (!useRelay && typeof window.Peer === 'undefined') {
      this.onStatusChange('error', 'PeerJS belum termuat. Periksa koneksi internet.');
      return false;
    }

    const rawCode = this.normalizeCode(codeInput);
    if (!rawCode) {
      this.onStatusChange('error', 'Masukkan Kode Room yang valid.');
      return false;
    }

    const isShortNumeric = /^\d{4}$/.test(rawCode);
    const primaryCode = isShortNumeric ? `PAN-${rawCode}` : rawCode;
    const fallbackCode = isShortNumeric ? rawCode : null;

    this._manuallyLeaving = false;
    this._reconnectAttempts = 0;
    this.roomCode = primaryCode;
    this.isHost = false;
    this.localProfile.name = playerName || 'Pemain';
    this.localProfile.isHost = false;
    this.onStatusChange('connecting', `1/2 Menghubungkan ke server untuk ${primaryCode}…`);

    if (useRelay) {
      return this._joinRelayRoom(primaryCode, fallbackCode);
    }

    return new Promise((resolve) => {
      let settled = false;
      let triedFallback = false;
      const peer = new window.Peer(PEER_CONFIG);
      this.peer = peer;

      const failJoin = (message) => {
        clearTimeout(timer);
        if (settled || this.peer !== peer) return;
        settled = true;
        this.onStatusChange('error', message);
        resolve(false);
      };

      const timer = setTimeout(() => {
        failJoin(
          `Timeout masuk ke ${this.roomCode}. Pastikan Host masih aktif & jika laptop memakai hotspot dari ponsel ini, pisahkan jaringan internetnya.`
        );
      }, CONNECT_TIMEOUT_MS);

      const connectToCode = (targetCode) => {
        this.roomCode = targetCode;
        this.onStatusChange('connecting', `2/2 Membuka jalur P2P ke ${targetCode}…`);
        const conn = peer.connect(ROOM_PREFIX + targetCode, { reliable: true });
        this.setupConnection(
          conn,
          () => {
            if (this.peer !== peer) return;
            clearTimeout(timer);
            this._reconnectAttempts = 0;
            this.onStatusChange('connected', `Terhubung ke ${targetCode}`);
            if (!settled) {
              settled = true;
              resolve(true);
            }
          },
          (iceReason) => {
            if (this.peer !== peer || settled) return;
            failJoin(iceReason);
          }
        );
      };

      this._attachReconnect(peer);

      peer.on('open', (id) => {
        if (this.peer !== peer) return;
        this.localProfile.id = id;
        connectToCode(primaryCode);
      });

      peer.on('error', (err) => {
        if (this.peer !== peer) return;
        if (err?.type === 'peer-unavailable' && fallbackCode && !triedFallback) {
          triedFallback = true;
          connectToCode(fallbackCode);
          return;
        }
        console.warn('[Multiplayer] Join error:', err);
        failJoin(this._formatPeerError(err, this.roomCode, 'join'));
      });
    });
  }

  getHostNowMs() {
    if (this.isHost || this.connections.size === 0) return Date.now();
    return Date.now() + this.clockOffsetMs;
  }

  _clearClockSync() {
    if (this._clockPingTimer) {
      clearInterval(this._clockPingTimer);
      this._clockPingTimer = null;
    }
    while (this._clockBurstTimers.length > 0) {
      clearTimeout(this._clockBurstTimers.pop());
    }
    this.clockOffsetMs = 0;
    this._bestRttMs = Infinity;
  }

  _startClockSync(conn) {
    this._clearClockSync();
    const sendPing = () => {
      if (!conn || !conn.open || this.isHost) return;
      try {
        conn.send({ type: 'clock_ping', clientTimeMs: Date.now() });
      } catch (_) {}
    };
    sendPing();
    for (const delay of [120, 280, 520]) {
      this._clockBurstTimers.push(setTimeout(sendPing, delay));
    }
    this._clockPingTimer = setInterval(sendPing, 10000);
  }

  setupConnection(conn, onOpenCb, onIceFailCb) {
    conn.on('open', () => {
      this.connections.set(conn.peer, conn);
      conn.send({ type: 'hello', profile: this.localProfile });
      if (this.isHost) {
        conn.send({
          type: 'roster_sync',
          roster: Array.from(this.roster.values())
        });
      } else {
        this._startClockSync(conn);
      }
      if (onOpenCb) onOpenCb();
    });

    conn.on('iceStateChanged', (state) => {
      if (state === 'failed' && onIceFailCb) {
        onIceFailCb(
          'Jalur P2P gagal menembus hotspot/NAT (ICE failed). Coba pisahkan jaringan internet laptop & ponsel.'
        );
      }
    });

    conn.on('data', (data) => {
      this.handleMessage(conn.peer, data);
    });

    conn.on('error', (err) => {
      console.warn('[Multiplayer] Connection error:', err);
    });

    conn.on('close', () => {
      if (this.connections.get(conn.peer) === conn) {
        this.connections.delete(conn.peer);
      }
      if (this.roster.has(conn.peer)) {
        this.roster.delete(conn.peer);
        this.emitRoster();
        if (this.isHost) {
          this.broadcast({ type: 'roster_sync', roster: Array.from(this.roster.values()) });
        }
      }
      if (!this.isHost && this.connections.size === 0 && !this._manuallyLeaving) {
        this.onStatusChange('error', 'Koneksi ke Host terputus atau room ditutup.');
      }
    });
  }

  handleMessage(fromPeerId, data) {
    if (!data || !data.type) return;

    // Host relays performance events to all other guests
    if (this.isHost && ['hit', 'damp', 'emote'].includes(data.type)) {
      this.broadcast(data, fromPeerId);
    }

    switch (data.type) {
      case 'clock_ping': {
        if (this.isHost && typeof data.clientTimeMs === 'number') {
          const replyConn = this.connections.get(fromPeerId);
          if (replyConn?.open) {
            try {
              replyConn.send({
                type: 'clock_pong',
                clientTimeMs: data.clientTimeMs,
                hostTimeMs: Date.now()
              });
            } catch (_) {}
          }
        }
        break;
      }
      case 'clock_pong': {
        if (!this.isHost && typeof data.clientTimeMs === 'number' && typeof data.hostTimeMs === 'number') {
          const now = Date.now();
          const rtt = now - data.clientTimeMs;
          if (rtt >= 0 && rtt < 2000) {
            const estOffset = Math.round(data.hostTimeMs + rtt / 2 - now);
            if (rtt <= this._bestRttMs + 6) {
              this._bestRttMs = Math.min(this._bestRttMs, rtt);
              this.clockOffsetMs = estOffset;
              this.onClockSync(estOffset, rtt);
            }
          }
        }
        break;
      }
      case 'hello':
      case 'profile': {
        if (data.profile) {
          this.roster.set(fromPeerId, { ...data.profile, id: fromPeerId });
          this.emitRoster();
          if (this.isHost) {
            this.broadcast({
              type: 'roster_sync',
              roster: Array.from(this.roster.values())
            });
            if (data.type === 'hello') {
              this.onGuestConnected(fromPeerId);
            }
          }
        }
        break;
      }
      case 'roster_sync': {
        if (Array.isArray(data.roster)) {
          this.roster.clear();
          data.roster.forEach((p) => this.roster.set(p.id, p));
          this.roster.set(this.localProfile.id, { ...this.localProfile });
          this.emitRoster();
        }
        break;
      }
      case 'hit': {
        this.onRemoteHit(data);
        break;
      }
      case 'damp': {
        this.onRemoteDamp(data);
        break;
      }
      case 'tempo': {
        this.onRemoteTempo(data);
        break;
      }
      case 'tempo_request': {
        if (this.isHost) {
          this.onTempoRequest(data);
        }
        break;
      }
      case 'tune': {
        this.onRemoteTune(data);
        break;
      }
      case 'emote': {
        this.onEmote(data);
        break;
      }
    }
  }

  broadcast(payload, excludePeerId = null) {
    for (const [peerId, conn] of this.connections.entries()) {
      if (peerId === excludePeerId) continue;
      if (conn.open) {
        try {
          conn.send(payload);
        } catch (_) {}
      }
    }
  }

  sendHit(instId, scale, noteId, url, velocity = 1.0) {
    if (!this.peer || this.connections.size === 0) return;
    this.broadcast({
      type: 'hit',
      senderId: this.localProfile.id,
      senderName: this.localProfile.name,
      instId,
      scale,
      noteId,
      url,
      velocity
    });
  }

  sendDamp(instId, scale, noteId) {
    if (!this.peer || this.connections.size === 0) return;
    this.broadcast({
      type: 'damp',
      senderId: this.localProfile.id,
      instId,
      scale,
      noteId
    });
  }

  sendTempo(bpm, running, anchorHostMs = Date.now(), targetPeerId = null) {
    if (!this.isHost || this.connections.size === 0) return;
    const payload = {
      type: 'tempo',
      bpm,
      running,
      anchorHostMs
    };
    if (targetPeerId) {
      const conn = this.connections.get(targetPeerId);
      if (conn?.open) {
        try {
          conn.send(payload);
        } catch (_) {}
      }
      return;
    }
    this.broadcast(payload);
  }

  sendTempoRequest(bpm, running) {
    if (this.isHost || !this.peer || this.connections.size === 0) return;
    this.broadcast({
      type: 'tempo_request',
      bpm,
      running
    });
  }

  sendTune(cents) {
    if (!this.isHost || this.connections.size === 0) return;
    this.broadcast({
      type: 'tune',
      cents
    });
  }

  sendEmote(text) {
    if (!this.peer || this.connections.size === 0) return;
    const msg = {
      type: 'emote',
      senderId: this.localProfile.id,
      senderName: this.localProfile.name,
      text
    };
    this.broadcast(msg);
  }

  emitRoster() {
    this.onRosterChange(Array.from(this.roster.values()));
  }

  leaveRoom() {
    this._manuallyLeaving = true;
    this._clearClockSync();
    for (const conn of this.connections.values()) {
      try {
        conn.close();
      } catch (_) {}
    }
    this.connections.clear();
    if (this.eventSource) {
      try {
        this.eventSource.close();
      } catch (_) {}
      this.eventSource = null;
    }
    if (this.peer) {
      try {
        this.peer.destroy();
      } catch (_) {}
      this.peer = null;
    }
    this.roomCode = null;
    this.isHost = false;
    this.roster.clear();
    this.emitRoster();
    this.onStatusChange('solo', 'Mode Solo (Offline)');
  }
}
