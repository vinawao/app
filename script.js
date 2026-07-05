/**
 * ================================
 * DPLAY REFACTORED PLAYER v2.0
 * 
 * Improvements:
 * - Unified caching system
 * - Encapsulated player state
 * - Extracted DRM key validation
 * - Better error handling with race conditions
 * - Centralized configuration (loaded from PHP)
 * ================================
 */

shaka.polyfill.installAll();

/* ================= 🎛️ LOAD CONFIG FROM PHP ================= */

let CONFIG = {};

async function loadConfig() {
  try {
    const response = await fetch('./config.php');
    CONFIG = await response.json();
    console.log('Configuration loaded from PHP:', CONFIG);
    return CONFIG;
  } catch (err) {
    console.error('Failed to load config from PHP:', err);
    // Fallback config if PHP endpoint fails
    CONFIG = {
      cache: { playlist: 1800000, epg: 900000 },
      hls: { maxBufferLength: 9, maxMaxBufferLength: 20 },
      dash: { streaming: { preferredAudioLanguage: 'en' } },
      shaka: { streaming: { bufferingGoal: 12 } },
      ui: { controlFadeDelay: 4000, epgUpdateInterval: 10000 },
      fallback: { timeout: 2500 },
      playlists: [],
      epgSources: [],
      referer: 'https://m.rctiplus.com/'
    };
    return CONFIG;
  }
}

/* ================= DOM ELEMENTS ================= */

const video = document.getElementById('video');
const grid = document.getElementById('playlistGrid');
const groupBar = document.getElementById('groupBar');
const msg = document.getElementById('msg');

/* ================= GLOBAL STATE ================= */

let CHANNELS = [];
let EPG_DATA = {};
let CURRENT_GROUP = '🟢 ALL CHANNELS';
let currentChannel = null;
let loadToken = 0;
let referer = 'https://m.rctiplus.com/';

/* ================= 🎯 UNIFIED CACHE SYSTEM ================= */

class CacheManager {
  constructor() {
    this.prefix = 'dplay_cache_';
  }

  /**
   * Get cached data
   * @param {string} key - Cache key
   * @param {string} type - Data type (playlist|epg)
   * @returns {any|null}
   */
  get(key, type = 'playlist') {
    try {
      const cacheKey = `${this.prefix}${type}_${btoa(key)}`;
      const raw = localStorage.getItem(cacheKey);
      if (!raw) return null;

      const { timestamp, data } = JSON.parse(raw);
      const maxAge = CONFIG.cache[type] || CONFIG.cache.playlist;

      if (Date.now() - timestamp > maxAge) {
        localStorage.removeItem(cacheKey);
        return null;
      }

      return data;
    } catch (err) {
      console.warn(`Cache read error for ${key}:`, err);
      return null;
    }
  }

  /**
   * Set cache data
   * @param {string} key - Cache key
   * @param {any} data - Data to cache
   * @param {string} type - Data type (playlist|epg)
   */
  set(key, data, type = 'playlist') {
    try {
      const cacheKey = `${this.prefix}${type}_${btoa(key)}`;
      localStorage.setItem(cacheKey, JSON.stringify({
        timestamp: Date.now(),
        data
      }));
    } catch (err) {
      console.warn('Cache write error:', err);
    }
  }

  /**
   * Clear all cache
   */
  clear() {
    try {
      const keys = Object.keys(localStorage);
      keys.forEach(key => {
        if (key.startsWith(this.prefix)) {
          localStorage.removeItem(key);
        }
      });
      console.log('Cache cleared');
    } catch (err) {
      console.warn('Cache clear error:', err);
    }
  }
}

const cache = new CacheManager();

/* ================= 🛡️ DRM KEY VALIDATOR ================= */

class DrmKeyValidator {
  /**
   * Validate and normalize key pair
   * @param {string} kid - Key ID
   * @param {string} key - Key value
   * @returns {object|null} { kid, key } or null if invalid
   */
  static validateAndNormalize(kid, key) {
    // Hex format (32 chars)
    if (/^[0-9a-f]{32}$/i.test(kid) && /^[0-9a-f]{32}$/i.test(key)) {
      return { kid: kid.toLowerCase(), key: key.toLowerCase() };
    }

    // Base64 URL-safe format
    if (/^[A-Za-z0-9_-]+$/.test(kid) && /^[A-Za-z0-9_-]+$/.test(key)) {
      return { kid, key };
    }

    return null;
  }

  /**
   * Parse ClearKey format from string
   * @param {string} str - Key string (format: "kid:key" or JSON)
   * @returns {object} { kid: key } pairs
   */
  static parseKeyString(str) {
    if (!str) return {};

    // Try "kid:key" format
    if (typeof str === 'string' && str.includes(':')) {
      const [kid, key] = str.split(':').map(v => v.trim());
      const validated = this.validateAndNormalize(kid, key);
      return validated ? { [validated.kid]: validated.key } : {};
    }

    // Try JSON format
    if (typeof str === 'string') {
      try {
        const parsed = JSON.parse(str);
        if (typeof parsed === 'object' && parsed !== null) {
          return parsed;
        }
      } catch {}
    }

    return {};
  }

  /**
   * Extract ClearKeys from channel config
   * @param {object} ch - Channel object
   * @returns {object} clearKeys dictionary
   */
  static extractClearKeys(ch) {
    let clearKeys = {};

    // Priority 1: New format (ch.keys object)
    if (ch.keys && typeof ch.keys === 'object') {
      Object.entries(ch.keys).forEach(([kid, key]) => {
        const validated = this.validateAndNormalize(kid, key);
        if (validated) {
          clearKeys[validated.kid] = validated.key;
        }
      });
    }
    // Priority 2: Legacy format (ch.key)
    else if (ch.key) {
      // String format
      if (typeof ch.key === 'string') {
        const parsed = this.parseKeyString(ch.key);
        Object.entries(parsed).forEach(([kid, key]) => {
          const validated = this.validateAndNormalize(kid, key);
          if (validated) {
            clearKeys[validated.kid] = validated.key;
          }
        });
      }
      // Object format
      else if (typeof ch.key === 'object' && ch.key !== null) {
        Object.entries(ch.key).forEach(([kid, key]) => {
          const validated = this.validateAndNormalize(kid, key);
          if (validated) {
            clearKeys[validated.kid] = validated.key;
          }
        });
      }
    }

    return clearKeys;
  }

  /**
   * Extract Widevine server URL from channel
   * @param {object} ch - Channel object
   * @returns {string|null} Server URL or null
   */
  static extractWidevineServer(ch) {
    if (ch.license && typeof ch.license === 'string' && ch.license.startsWith('http')) {
      return ch.license.trim();
    }

    if (ch.key && typeof ch.key === 'string' && ch.key.startsWith('http')) {
      return ch.key.trim();
    }

    return null;
  }
}

/* ================= 🎮 PLAYER STATE MANAGER ================= */

class PlayerState {
    constructor() {
        this.player = null;
        this.hls = null;
        this.isInitialized = false;
        this.controlsHideTimeout = null;
    }

    async initialize() {
        if (this.player) return;

        try {
            const ui = video.ui;
            // ✅ BENAR: Ambil instance controls dari ui, BUKAN dari this.player
            const uiControls = ui.getControls(); 
            this.player = uiControls.getPlayer();

            ui.configure({
                tapToToggleFullscreen: false,
                doubleClickForFullscreen: false,
                enableFullscreenOnRotate: false,
                singleClickBehavior: 'controls',
                addSeekBar: false,
                controlPanelElements: CONFIG.controlPanelElements || ['play_pause', 'time_and_duration', 'spacer', 'mute', 'volume', 'quality', 'fullscreen', 'overflow_menu'],
                overflowMenuButtons: CONFIG.overflowMenuButtons || ['captions', 'language_audio', 'language', 'playback_rate'],
                fadeDelay: CONFIG.ui.controlFadeDelay
            });

            // ✅ Teruskan instance uiControls ke fungsi setup
            this._setupControls(uiControls);

            this.player.configure({
                drm: { servers: {}, clearKeys: {}, reuseDrmSessions: true },
                streaming: {
                    bufferingGoal: CONFIG.shaka.streaming.bufferingGoal,
                    rebufferingGoal: CONFIG.shaka.streaming.rebufferingGoal,
                    jumpLargeGaps: true
                }
            });

            this.player.getNetworkingEngine().registerRequestFilter((type, request) => {
                request.headers['Referer'] = referer;
                request.headers['Origin'] = new URL(referer).origin;
            });

            this.player.addEventListener('error', this._onPlayerError.bind(this));
            this.isInitialized = true;
        } catch (err) {
            console.error('Player initialization failed:', err);
            throw err;
        }
    }

    // ✅ DIPERBAIKI: Sinkronisasi timeout dengan Shaka Native UI
    _setupControls(uiControls) {
        if (!uiControls) return;

        const controlsContainer = uiControls.getControlsContainer();
        const videoElement = uiControls.getVideo();

        const showControls = () => {
            if (controlsContainer) {
                // Gunakan atribut bawaan Shaka UI agar sejalan dengan CSS internal
                controlsContainer.setAttribute('shown', 'true');
            }

            if (this.controlsHideTimeout) {
                clearTimeout(this.controlsHideTimeout);
            }

            this.controlsHideTimeout = setTimeout(() => {
                if (controlsContainer) {
                    controlsContainer.removeAttribute('shown');
                }
                this.controlsHideTimeout = null;
            }, CONFIG.ui.controlFadeDelay);
        };

        // Hapus e.stopPropagation() dan gunakan passive listener agar tidak memblokir Shaka
        ['click', 'touchstart', 'mousemove'].forEach(evt => {
            videoElement.addEventListener(evt, () => showControls(), { passive: true });
            if (controlsContainer) {
                controlsContainer.addEventListener(evt, () => showControls(), { passive: true });
            }
        });

        // Tampilkan controls segera saat inisialisasi / ganti channel
        showControls();
    }

    _onPlayerError(e) {
        console.error('Shaka error:', e);
        msg.textContent = 'Manifest error: ' + (e.detail?.message || 'Unknown');
        msg.style.display = 'block';
    }

  /**
   * Load and play stream
   * @param {object} channel - Channel object
   * @param {number} token - Load token for race condition prevention
   */
  async play(channel, token) {
    if (!this.player) throw new Error('Player not initialized');

    // Check token before loading
    if (token !== loadToken) return;

    // Apply DRM configuration
    const clearKeys = DrmKeyValidator.extractClearKeys(channel);
    const widevineServer = DrmKeyValidator.extractWidevineServer(channel);

    let drmConfig = {
      servers: {},
      clearKeys: clearKeys,
      reuseDrmSessions: true
    };

    if (widevineServer) {
      drmConfig.servers['com.widevine.alpha'] = widevineServer;
    }

    this.player.configure({ drm: drmConfig });

    if (Object.keys(clearKeys).length > 0) {
      console.log('ClearKey applied:', clearKeys);
    }

    // Check token before loading stream
    if (token !== loadToken) return;

    try {
      await this.player.load(channel.url);

      if (token !== loadToken) return;

      updatePlayerEpg(channel);
      msg.style.display = 'none';
    } catch (err) {
      if (token !== loadToken) return;

      console.error('Load failed:', err);
      msg.textContent = 'Gagal memuat metadata: ' + (err.message || 'Unknown error');
      msg.style.display = 'block';

      // Fallback to HLS for M3U8 streams without DRM
      if (channel.url?.includes('.m3u8') && !channel.drm) {
        this.fallbackToHls(channel.url, token);
      }
    }
  }

  /**
   * Fallback to HLS.js
   * @param {string} url - Stream URL
   * @param {number} token - Load token
   */
  fallbackToHls(url, token) {
    if (token !== loadToken) return;

    // Cleanup previous HLS instance
    if (this.hls) {
      this.hls.destroy();
      this.hls = null;
    }

    if (!Hls.isSupported()) {
      // Try native HLS support (Safari)
      if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = url;
        video.addEventListener('loadedmetadata', () => {
          video.play().catch(err => console.error('Play error:', err));
        });
      }
      return;
    }

    try {
      const hls = new Hls(CONFIG.hls);
      this.hls = hls;

      hls.loadSource(url);
      hls.attachMedia(video);

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        video.play().catch(err => console.error('Play error:', err));
      });

      hls.on(Hls.Events.ERROR, (event, data) => {
        if (token !== loadToken) return;

        if (data.fatal) {
          msg.textContent = 'HLS error: ' + data.details;
          msg.style.display = 'block';
        } else {
          console.warn('Non-fatal HLS error:', data.details);
        }
      });

      console.log('Fallback to HLS.js');
    } catch (err) {
      console.error('HLS fallback failed:', err);
    }
  }

  /**
   * Cleanup resources
   */
  async cleanup() {
    try {
      // ✅ TAMBAHAN: Bersihkan timeout
      if (this.controlsHideTimeout) {
        clearTimeout(this.controlsHideTimeout);
        this.controlsHideTimeout = null;
      }

      if (this.hls) {
        this.hls.destroy();
        this.hls = null;
      }
      if (this.player) {
        await this.player.destroy();
        this.player = null;
      }

      video.pause();
      video.removeAttribute('src');
      video.load();

      this.isInitialized = false;
    } catch (err) {
      console.warn('Cleanup error:', err);
    }
  }
}

const playerState = new PlayerState();

/* ================= 📺 PLAY CHANNEL ================= */

async function playChannel(ch) {
  loadToken++;
  const token = loadToken;

  try {
    await playerState.initialize();

    if (token !== loadToken) return;

    await playerState.play(ch, token);
  } catch (err) {
    console.error('playChannel error:', err);
    if (token === loadToken) {
      msg.textContent = 'Error: ' + (err.message || 'Unknown');
      msg.style.display = 'block';
    }
  }
}

/* ================= 🔄 PLAYLIST LOADER ================= */

async function loadPlaylist(url) {
  // Check cache first
  const cached = cache.get(url, 'playlist');
  if (cached) {
    console.log(`Playlist from cache: ${url}`);
    return cached;
  }

  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Fetch failed: ${resp.status}`);
    const txt = await resp.text();

    let channels = [];

    // JSON mode
    if (txt.trim().startsWith('{') || txt.trim().startsWith('[')) {
      channels = parseJsonPlaylist(txt);
    }
    // M3U mode
    else {
      channels = parseM3uPlaylist(txt);
    }

    console.log(`Loaded ${channels.length} channels from ${url}`);
    if (channels.length > 0) {
      console.log('First channel:', channels[0]);
    }

    cache.set(url, channels, 'playlist');
    return channels;
  } catch (err) {
    console.error('Playlist load error:', err, url);
    return [];
  }
}

/**
 * Parse JSON playlist format
 */
function parseJsonPlaylist(txt) {
  const channels = [];

  try {
    const j = JSON.parse(txt);
    let sourceArray = [];

    if (Array.isArray(j)) {
      sourceArray = j;
    } else if (Array.isArray(j.channels)) {
      sourceArray = j.channels;
    } else if (Array.isArray(j.streams)) {
      sourceArray = j.streams;
    } else {
      console.warn('JSON format not recognized');
      return [];
    }

    const globalGroups = Array.isArray(j.groups) 
      ? j.groups.map(g => String(g).trim()).filter(Boolean)
      : [];

    sourceArray.forEach(item => {
      let groups = [];

      if (Array.isArray(item.groups) && item.groups.length) {
        groups = item.groups;
      } else if (typeof item.group === 'string' && item.group.trim()) {
        groups = item.group.split(/[;,]/);
      } else if (typeof item.group_title === 'string' && item.group_title.trim()) {
        groups = item.group_title.split(/[;,]/);
      } else if (globalGroups.length) {
        groups = [...globalGroups];
      } else {
        groups = ['Other'];
      }

      groups = [...new Set(groups.map(g => String(g).trim()).filter(Boolean))];

      const channel = {
        name: item.name || item.title || item.channel || 'Unnamed',
        url: item.url || item.stream || item.link,
        groups,
        logo: item.logo || item.tvg_logo || item.icon,
        key: item.key || item.drm_key,
        keys: item.keys,
        license: item.license,
        drm: item.drm,
        id: item.id || item.epg_id || item.tvg_id || item.channel_id || item.name
      };

      if (channel.name && channel.url) {
        channels.push(channel);
      }
    });
  } catch (err) {
    console.error('JSON parse error:', err);
  }

  return channels;
}

/**
 * Parse M3U playlist format
 */
function parseM3uPlaylist(txt) {
  const channels = [];
  let current = {};
  const lines = txt.split('\n');

  for (let line of lines) {
    line = line.trim();
    if (!line) continue;

    if (line.startsWith('#EXTINF:')) {
      if (current.url && current.name) {
        channels.push({ ...current });
      }

      current = {};

      const content = line.slice(8).trim();
      const lastCommaIndex = content.lastIndexOf(',');

      let attrPart = '';
      let namePart = 'Unnamed';

      if (lastCommaIndex !== -1) {
        attrPart = content.slice(0, lastCommaIndex).trim();
        namePart = content.slice(lastCommaIndex + 1).trim();
      } else {
        attrPart = content;
      }

      current.name = namePart || 'No Name';

      // Parse attributes
      const attrRegex = /([a-zA-Z0-9\-]+?)=(?:"([^"]*)"|'([^']*)'|([^\s"']+))/g;
      let match;

      while ((match = attrRegex.exec(attrPart)) !== null) {
        const key = match[1].toLowerCase();
        const value = match[2] || match[3] || match[4] || '';

        if (key === 'tvg-name' && (!current.name || current.name === 'Unnamed')) {
          current.name = value;
        }
        if (key === 'group-title') current.group = value;
        if (key === 'tvg-logo' || key === 'logo') current.logo = value;
        if (key === 'license_key' || key === 'key' || key === 'drm') current.key = value;
        if (key === 'tvg-id') current.id = value;
      }
    } else if (line.startsWith('#') && line.toLowerCase().includes('license_key=')) {
      const rawKey = line.split('license_key=').pop().trim().split(' ')[0];
      try {
        current.key = JSON.parse(rawKey);
      } catch {
        current.key = rawKey;
      }
    } else if (!line.startsWith('#')) {
      current.url = line.split('|')[0].trim();

      if (current.name && current.name !== 'Unnamed' && current.name !== 'No Name' && current.url) {
        let groups = [];

        if (typeof current.group === 'string' && current.group.trim()) {
          groups = current.group.split(/[;,]/);
        } else {
          groups = ['Other'];
        }

        groups = [...new Set(groups.map(g => String(g).trim()).filter(Boolean))];

        channels.push({ ...current, groups });
      }

      current = {};
    }
  }

  // Push last channel if exists
  if (current.url && current.name && current.name !== 'Unnamed' && current.name !== 'No Name') {
    let groups = [];

    if (typeof current.group === 'string' && current.group.trim()) {
      groups = current.group.split(/[;,]/);
    } else {
      groups = ['Other'];
    }

    groups = [...new Set(groups.map(g => String(g).trim()).filter(Boolean))];

    channels.push({ ...current, groups });
  }

  return channels;
}

/* ================= 📡 EPG LOADER ================= */

function normalizeId(id) {
  if (!id) return '';
  return id.toLowerCase().trim();
}

async function loadEpg(url) {
  const cached = cache.get(url, 'epg');
  if (cached) return cached;

  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`EPG fetch failed: ${resp.status}`);
    const txt = await resp.text();

    const parser = new DOMParser();
    const xml = parser.parseFromString(txt, 'application/xml');

    const programs = {};
    const channelNodes = xml.querySelectorAll('programme');

    channelNodes.forEach(prog => {
      const channelId = normalizeId(prog.getAttribute('channel'));
      const startStr = prog.getAttribute('start');
      const endStr = prog.getAttribute('stop');
      const title = prog.querySelector('title')?.textContent || 'No Title';

      const start = parseEpgTime(startStr);
      const end = parseEpgTime(endStr);

      if (!programs[channelId]) programs[channelId] = [];
      programs[channelId].push({ start, end, title });
    });

    // Sort programs by start time
    Object.keys(programs).forEach(id => {
      programs[id].sort((a, b) => a.start - b.start);
    });

    cache.set(url, programs, 'epg');
    return programs;
  } catch (err) {
    console.error('EPG load error:', err, url);
    return {};
  }
}

function parseEpgTime(str) {
  if (!str) return 0;

  const match = str.match(/^(\d{14})\s*([+\-]\d{4})?/);
  if (!match) return 0;

  const datePart = match[1];
  const tzPart = match[2] || '+0000';

  const iso =
    datePart.slice(0, 4) + '-' +
    datePart.slice(4, 6) + '-' +
    datePart.slice(6, 8) + 'T' +
    datePart.slice(8, 10) + ':' +
    datePart.slice(10, 12) + ':' +
    datePart.slice(12, 14) +
    tzPart.slice(0, 3) + ':' +
    tzPart.slice(3, 5);

  return new Date(iso).getTime();
}

async function loadAllEpg() {
  EPG_DATA = {};
  for (const url of CONFIG.epgSources) {
    const data = await loadEpg(url);
    Object.entries(data).forEach(([id, progs]) => {
      if (!EPG_DATA[id]) EPG_DATA[id] = [];
      EPG_DATA[id].push(...progs);
      EPG_DATA[id].sort((a, b) => a.start - b.start);
    });
  }
}

/* ================= 📺 EPG DISPLAY ================= */

function getNowNext(channel) {
  if (!channel) return { now: null, next: null };

  const nowTime = Date.now();

  // Try by channel ID
  if (channel.id) {
    const id = normalizeId(channel.id);
    const programs = EPG_DATA[id];
    if (programs && programs.length) {
      return findNowNext(programs, nowTime);
    }
  }

  // Try by channel name
  if (channel.name) {
    const nameId = normalizeId(channel.name);
    const programs = EPG_DATA[nameId];
    if (programs && programs.length) {
      return findNowNext(programs, nowTime);
    }
  }

  return { now: null, next: null };
}

function findNowNext(programs, nowTime) {
  let now = null;
  let next = null;

  for (let i = 0; i < programs.length; i++) {
    const p = programs[i];

    if (p.start <= nowTime && p.end > nowTime) {
      now = p;
      next = programs[i + 1] || null;
      break;
    }
  }

  if (!now) {
    next = programs.find(p => p.start > nowTime) || null;
  }

  return { now, next };
}

function formatTime(ts) {
  if (!ts) return '';

  const d = new Date(ts);
  const h = d.getHours().toString().padStart(2, '0');
  const m = d.getMinutes().toString().padStart(2, '0');

  return `${h}:${m}`;
}

function updatePlayerEpg(channel) {
  const box = document.getElementById('epgInfo');
  if (!box) return;

  const nowNext = getNowNext(channel);

  if (!nowNext.now && !nowNext.next) {
    box.innerHTML = '<div style="padding: 5px 2px; font-size: 13px;"><b style="color: orange;">&nbsp;DENSTV INFO :<br>&nbsp;</b><b>Saat ini belum tersedia jadwal acara (EPG) untuk siaran ini</b></div>';
    return;
  }

  let html = '';

  if (nowNext.now) {
    html += `
      <div class="epg-now">
        NOW: ${nowNext.now.title}
        <span>
          (${formatTime(nowNext.now.start)} - ${formatTime(nowNext.now.end)})
        </span>
      </div>
    `;
  }

  if (nowNext.next) {
    html += `
      <div class="epg-next">
        NEXT: ${nowNext.next.title}
        <span>
          (${formatTime(nowNext.next.start)} - ${formatTime(nowNext.next.end)})
        </span>
      </div>
    `;
  }

  box.innerHTML = html;
}

/* ================= 🎨 UI RENDERING ================= */

function buildGroups() {
  const groups = new Map();

  CHANNELS.forEach(c => {
    if (Array.isArray(c.groups) && c.groups.length) {
      c.groups.forEach(groupName => {
        groups.set(groupName, (groups.get(groupName) || 0) + 1);
      });
    } else {
      groups.set('Other', (groups.get('Other') || 0) + 1);
    }
  });

  const totalChannels = CHANNELS.length;
  groups.set('🟢 ALL CHANNELS', totalChannels);

  groupBar.innerHTML = '<b>FILTER KATEGORI : </b>';
  const select = document.createElement('select');
  select.className = 'group-select';

  groups.forEach((count, g) => {
    const option = document.createElement('option');
    option.value = g;
    option.textContent = `${g} (${count} CH)`;

    if (g === CURRENT_GROUP) {
      option.selected = true;
    }
    select.appendChild(option);
  });

  select.onchange = (e) => {
    CURRENT_GROUP = e.target.value;
    renderGrid();
  };

  groupBar.appendChild(select);
}

function renderGrid() {
  grid.innerHTML = '';
  const filtered = CHANNELS.filter(c =>
    CURRENT_GROUP === '🟢 ALL CHANNELS' || 
    (Array.isArray(c.groups) && c.groups.includes(CURRENT_GROUP))
  );

  if (filtered.length === 0) {
    grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:20px;">Tidak ada channel di grup ini</div>';
    return;
  }

  filtered.forEach(c => {
    const d = document.createElement('div');
    d.className = 'channel';
    const safeName = (c.name || 'Unnamed').trim();

    d.innerHTML = `
      <img class="rotate" src="${c.logo || ''}" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('div'), { innerText: 'No Logo', style: 'display:flex;align-items:center;justify-content:center;width:100%;height:100%;background:#333;' }))">
      <div class="channel-name">${safeName}</div>
    `;

    d.onclick = () => {
      playChannel(c);
      const chLive = document.getElementById('chLive');
      if (chLive) {
        chLive.innerHTML = `Live: <strong style="color: lime">${safeName}</strong>`;
      }
    };

    grid.appendChild(d);
  });
}

/* ================= 🚀 INITIALIZATION ================= */

document.addEventListener('shaka-ui-loaded', async () => {
  // Load configuration from PHP
  await loadConfig();

  if (!CONFIG.playlists || CONFIG.playlists.length === 0) {
    msg.textContent = 'Server PLAYLISTS sedang bermasalah. Silakan kembali sesaat.';
    msg.style.display = 'block';
    return;
  }

  console.log('Loading playlists and EPG...');

  // Load playlists
  for (const p of CONFIG.playlists) {
    const ch = await loadPlaylist(p);
    CHANNELS.push(...ch);
  }

  // Load EPG
  await loadAllEpg();

  // Build UI
  buildGroups();
  renderGrid();

  console.log(`Initialized with ${CHANNELS.length} channels`);
});

/* ================= 🛑 UTILITIES ================= */

function clearErrorMessage() {
  msg.textContent = '';
  msg.style.display = 'none';
}

// Lazy load images
function lazyLoadImage(img, src) {
  const obs = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        img.src = src;
        obs.unobserve(img);
      }
    });
  });
  obs.observe(img);
}

// Export for external use if needed
window.playerApi = {
  play: playChannel,
  cleanup: () => playerState.cleanup(),
  clearCache: () => cache.clear(),
  getChannels: () => CHANNELS,
  getEpg: () => EPG_DATA,
  getConfig: () => CONFIG
};

console.log('DPLAY Player v2.0 loaded with dynamic configuration');
