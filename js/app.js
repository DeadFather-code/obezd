'use strict';

/* ============================================================
   Объезд магазинов - мобильное приложение (PWA)
   Локальные данные + синхронизация группы через Firestore
   ============================================================ */

const GROUP_ID = 'oryol-main';
const APP_VERSION = '2.10.0';
const DEFAULT_CITY = 'orel';
const STORAGE_KEY = 'obezd_state_v2';
const SETTINGS_KEY = 'obezd_ui_v1';
const DEFAULT_PERIOD = 45;
const PERIOD_MIN = 1;
const PERIOD_MAX = 365;
const ROUTE_NAMES = ['Ливны1', 'Ливны2', 'Залегощь', 'Карачев', 'Мценск', 'Кромы', 'Болхов'];
const ORYOL_ROUTE = 'Орёл';
const DAY_MS = 86400000;
const COMMENT_MAX = 1000;
const ALIAS_MAX = 60;
const PROFILE_NAME_MAX = 40;

/* Геопозиция: позиция пишется в отдельный документ участника. */
const PRESENCE_STALE_MS = 10 * 60 * 1000;
const PRESENCE_ONLINE_MS = 2 * 60 * 1000;
const PRESENCE_SEND_MS = 20000;
const PRESENCE_MOVE_M = 25;
const PRESENCE_MAX_ACC_M = 500;

/* Пароль на опасные действия в настройках. Это защита от случайного
   нажатия, а не криптография: значение лежит в коде приложения. */
const RESET_PASSWORD_B64 = 'U2hhZG93MzIxNjc=';

const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyCokb4BRjQZoRh4Y0XuPU3AjEBudZi_I-o',
  authDomain: 'xmapping-db290.firebaseapp.com',
  projectId: 'xmapping-db290',
  storageBucket: 'xmapping-db290.firebasestorage.app',
  messagingSenderId: '676890672320',
  appId: '1:676890672320:web:583d62cda252ccfd604125',
  measurementId: 'G-K0GSKTY16J'
};

const FIREBASE_APP_URL = 'https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js';
const FIREBASE_FS_URL = 'https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js';

const BRAND_TITLES = {
  magnit: 'Магнит',
  pyaterochka: 'Пятёрочка',
  other: 'Другой магазин'
};

const BRAND_LETTERS = {
  magnit: 'М',
  pyaterochka: 'П',
  other: '•'
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/* ------------------------- Состояние ------------------------- */

function defaultSettings() {
  return { periodDays: DEFAULT_PERIOD, basemap: 'local', lightMap: false, upd: 0 };
}

function emptyState() {
  return {
    v: 2,
    settings: defaultSettings(),
    visits: {},
    hidden: {},
    custom: {},
    overrides: {},
    comments: {},
    authors: {}
  };
}

let state = emptyState();
let uiPrefs = {
  screen: 'map',
  filter: 'all',
  profile: { id: '', name: '' },
  shareLocation: false,
  shareAsked: false,
  city: DEFAULT_CITY,
  plans: {},
  tours: {},
  views: {},
  plan: [],
  tour: null
};

let citiesConfig = { default: DEFAULT_CITY, cities: [] };
let currentCity = null;
let cityStoreCounts = {};
let cityStoreSeeds = {};
let mapStoresSeed = [];
let routeSeed = {};
let routeSeedLoaded = false;
let storeCache = new Map();
let knownStoreIds = new Set();
let allStores = [];
let seedsLoaded = false;

let map = null;
/* Две независимые группы кластеров: просроченные и посещённые точки
   никогда не объединяются в один общий кружок. */
let clusterLayers = null;
let tileLight = null;
let localBaseLayer = null;
let localLayers = null;
let localLevelIndex = -1;
const localSegments = new Map();
let mapLabelLayer = null;
let mapLabelMarkers = [];
let mapAssetsRequested = false;
let mapAssetsToken = 0;
let viewSaveTimer = null;
let tileErrorCount = 0;
let tileErrorTimer = null;
const LOCAL_MAP_BOUNDS = [[52.855, 35.900], [53.055, 36.215]];
const markers = new Map();
let selectedMarkerId = null;

let currentScreen = 'map';
let currentRoute = null;
let oryolSearchQuery = '';
let mapFilter = 'all';
let editMode = false;
let addMode = false;
let planMode = false;
let mapSearchOpen = false;
let mapSearchQuery = '';
let planLayer = null;
let planLine = null;
let planIconState = new Map();
let tourLayer = null;
let tourVisual = { activeId: null, pending: new Set() };
let tourVisualKey = '';

let sheetStoreId = null;
let formState = null;
let importBusy = false;

let legacyRoutes = {};
const legacyApplied = new Set();

let cloud = {
  db: null,
  ref: null,
  fs: null,
  unsub: null,
  ready: false,
  online: false,
  failed: false,
  hasPushed: false,
  pushed: { visits: {}, hidden: {}, custom: {}, overrides: {}, comments: {}, authors: {}, settings: null }
};
let pushTimer = null;
let pushInFlight = false;
let pushAgain = false;
let localDirty = false;

/* ------------------------- Геопозиция ------------------------- */

let presence = new Map();
let presenceMarkers = new Map();
let presenceLayer = null;
let presenceUnsub = null;
let presenceWriteBusy = false;
let presenceWritePending = false;
let presenceTroubleShown = false;

let myLocation = null;
let myLocationMarker = null;
let myAccuracyCircle = null;
let geoWatchId = null;
let locationWanted = false;
let centerOnNextFix = false;
let locateHintTimer = null;
let lastPresenceSent = null;
let lastPresenceAt = 0;

/* --------------------------- Утилиты --------------------------- */

function clampPeriod(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return DEFAULT_PERIOD;
  return Math.min(PERIOD_MAX, Math.max(PERIOD_MIN, n));
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function isValidCoord(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon) &&
    lat > -90 && lat < 90 && lon > -180 && lon < 180;
}

function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function todayStart() {
  return startOfDay(Date.now());
}

function plural(n, one, few, many) {
  const abs = Math.abs(Math.round(n));
  const mod10 = abs % 10;
  const mod100 = abs % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

function daysWord(n) {
  return plural(n, 'день', 'дня', 'дней');
}

function formatDate(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '-';
  const opts = { day: 'numeric', month: 'long' };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  try {
    return new Intl.DateTimeFormat('ru-RU', opts).format(d);
  } catch (e) {
    return d.toLocaleDateString();
  }
}

function formatDateTime(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '-';
  try {
    return new Intl.DateTimeFormat('ru-RU', {
      day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'
    }).format(d);
  } catch (e) {
    return d.toLocaleString();
  }
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function brandTitle(brand) {
  return BRAND_TITLES[brand] || BRAND_TITLES.other;
}

function brandLetter(brand) {
  return BRAND_LETTERS[brand] || BRAND_LETTERS.other;
}

function normalizeBrand(value, fallbackName) {
  const raw = String(value || '').toLowerCase().replace(/ё/g, 'е');
  if (raw === 'magnit' || raw.includes('магнит')) return 'magnit';
  if (raw === 'pyaterochka' || raw.includes('пятерочка') || raw.includes('пятёрочка')) return 'pyaterochka';
  const name = String(fallbackName || '').toLowerCase().replace(/ё/g, 'е');
  if (name.includes('магнит')) return 'magnit';
  if (name.includes('пятерочка')) return 'pyaterochka';
  return 'other';
}

function storeDisplayName(brand, name) {
  const clean = String(name || '').trim();
  if (clean) return clean;
  return brandTitle(brand);
}

function makeId(prefix) {
  return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
}

/* --------------------------- Города --------------------------- */

function fallbackCity() {
  return {
    id: DEFAULT_CITY,
    name: 'Орёл',
    region: 'Орловская область',
    center: [52.965, 36.075],
    zoom: 12,
    bounds: LOCAL_MAP_BOUNDS,
    mapDir: 'map',
    baseFile: 'oryol-base.webp',
    stores: 'js/stores.json',
    routes: ROUTE_NAMES.slice()
  };
}

function cityList() {
  const list = citiesConfig && Array.isArray(citiesConfig.cities) ? citiesConfig.cities : [];
  return list.length ? list : [fallbackCity()];
}

function cityById(id) {
  const list = cityList();
  return list.find(city => city && city.id === id) || list[0];
}

function currentCityId() {
  return currentCity ? currentCity.id : (uiPrefs.city || DEFAULT_CITY);
}

function currentCityName() {
  return currentCity ? currentCity.name : 'Орёл';
}

function cityBoundsOf(city) {
  const bounds = city && city.bounds;
  if (Array.isArray(bounds) && bounds.length === 2) {
    const south = toNumber(bounds[0] && bounds[0][0]);
    const west = toNumber(bounds[0] && bounds[0][1]);
    const north = toNumber(bounds[1] && bounds[1][0]);
    const east = toNumber(bounds[1] && bounds[1][1]);
    if (isValidCoord(south, west) && isValidCoord(north, east)) {
      return [[south, west], [north, east]];
    }
  }
  return LOCAL_MAP_BOUNDS;
}

function cityCenterOf(city) {
  const center = city && city.center;
  if (Array.isArray(center) && center.length === 2) {
    const lat = toNumber(center[0]);
    const lon = toNumber(center[1]);
    if (isValidCoord(lat, lon)) return [lat, lon];
  }
  const bounds = cityBoundsOf(city);
  return [(bounds[0][0] + bounds[1][0]) / 2, (bounds[0][1] + bounds[1][1]) / 2];
}

function isValidCityId(id) {
  return cityList().some(city => city && city.id === id);
}

function cityIdForCoords(lat, lon) {
  const y = toNumber(lat);
  const x = toNumber(lon);
  if (isValidCoord(y, x)) {
    for (const city of cityList()) {
      const bounds = cityBoundsOf(city);
      if (y >= bounds[0][0] && y <= bounds[1][0] && x >= bounds[0][1] && x <= bounds[1][1]) {
        return city.id;
      }
    }
  }
  return DEFAULT_CITY;
}

function isMainRouteName(name) {
  if (name === ORYOL_ROUTE) return true;
  return cityList().some(city => city && city.name === name);
}

function cityByRouteName(name) {
  if (!name) return null;
  return cityList().find(city => city && (
    city.name === name || (city.id === DEFAULT_CITY && name === ORYOL_ROUTE)
  )) || null;
}

function normalizePlanPrefs(raw) {
  const plans = {};
  if (raw && typeof raw === 'object') {
    for (const [cityId, list] of Object.entries(raw)) {
      if (!isValidCityId(cityId) || !Array.isArray(list)) continue;
      plans[cityId] = list.filter(id => typeof id === 'string' && id).slice(0, 300);
    }
  }
  return plans;
}

function normalizeTourPrefs(raw) {
  const tours = {};
  if (raw && typeof raw === 'object') {
    for (const [cityId, value] of Object.entries(raw)) {
      if (!isValidCityId(cityId) || !value || typeof value !== 'object') continue;
      const ids = Array.isArray(value.ids)
        ? value.ids.filter(id => typeof id === 'string' && id).slice(0, 300)
        : [];
      if (ids.length) tours[cityId] = { ids, startedAt: toNumber(value.startedAt) || Date.now() };
    }
  }
  return tours;
}

function normalizeViewPrefs(raw) {
  const views = {};
  if (raw && typeof raw === 'object') {
    for (const [cityId, value] of Object.entries(raw)) {
      if (!isValidCityId(cityId) || !value || typeof value !== 'object') continue;
      const lat = toNumber(value.lat);
      const lon = toNumber(value.lng != null ? value.lng : value.lon);
      const zoom = toNumber(value.zoom);
      if (isValidCoord(lat, lon) && zoom != null) {
        views[cityId] = { lat, lng: lon, zoom: Math.round(zoom) };
      }
    }
  }
  return views;
}

async function loadCities() {
  try {
    const response = await fetch('js/cities.json', { cache: 'no-store' });
    if (!response.ok) throw new Error('cities.json: HTTP ' + response.status);
    const raw = await response.json();
    const list = Array.isArray(raw && raw.cities) ? raw.cities : [];
    const cities = list
      .filter(city => city && typeof city.id === 'string' && city.id && city.name)
      .map(city => ({
        id: city.id,
        name: String(city.name),
        region: String(city.region || ''),
        center: Array.isArray(city.center) ? city.center : [52.965, 36.075],
        zoom: toNumber(city.zoom) || 12,
        bounds: city.bounds,
        mapDir: String(city.mapDir || 'map').replace(/\\/g, '/').replace(/\/+$/, ''),
        baseFile: String(city.baseFile || 'oryol-base.webp'),
        stores: String(city.stores || 'js/stores.json'),
        routes: Array.isArray(city.routes) ? city.routes.slice() : []
      }));
    if (cities.length) {
      citiesConfig = {
        default: cities.some(city => city.id === raw.default) ? raw.default : cities[0].id,
        cities
      };
    }
  } catch (error) {
    console.warn('Не удалось загрузить список городов', error);
  }
  if (!citiesConfig.cities.length) {
    citiesConfig = { default: DEFAULT_CITY, cities: [fallbackCity()] };
  }
  currentCity = cityById(uiPrefs.city || citiesConfig.default);
}

async function loadCityStoreCounts() {
  const counts = {};
  await Promise.all(cityList().map(async (city) => {
    try {
      const response = await fetch(city.stores || 'js/stores.json', { cache: 'no-store' });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const raw = await response.json();
      counts[city.id] = Array.isArray(raw) ? raw.length : 0;
    } catch (error) {
      counts[city.id] = null;
    }
  }));
  cityStoreCounts = counts;
  renderCitySheet();
}

/* --------------------------- Профиль --------------------------- */

function normalizeProfileName(value) {
  return String(value == null ? '' : value)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, PROFILE_NAME_MAX);
}

function sanitizeAuthor(value) {
  if (!value || typeof value !== 'object') return null;
  const id = typeof value.id === 'string' ? value.id.slice(0, 80) : '';
  const name = normalizeProfileName(value.name);
  if (!id && !name) return null;
  return { id, name };
}

function currentAuthor() {
  const profile = uiPrefs.profile;
  if (!profile || !profile.name) return null;
  if (!profile.id) {
    profile.id = makeId('user');
    savePrefs();
  }
  return { id: profile.id, name: profile.name };
}

function authorName(by) {
  if (!by || typeof by !== 'object') return '';
  const id = typeof by.id === 'string' ? by.id : '';
  const saved = id ? state.authors[id] : null;
  const name = saved && saved.name ? saved.name : by.name;
  return normalizeProfileName(name);
}

function visitAuthor(id) {
  const rec = id ? state.visits[id] : null;
  return rec ? authorName(rec.by) : '';
}

function commentAuthor(id) {
  const rec = id ? state.comments[id] : null;
  return rec ? authorName(rec.by) : '';
}

function commentMetaHtml(id) {
  const rec = id ? state.comments[id] : null;
  if (!rec || !rec.text) return '';
  return 'Автор: <b>' + escapeHtml(authorName(rec.by) || 'автор не указан') + '</b>' +
    (rec.upd ? ' · ' + escapeHtml(formatDateTime(rec.upd)) : '');
}

function updateCommentMeta(id) {
  const el = $('#store-comment-meta');
  if (el) el.innerHTML = commentMetaHtml(id);
}

function saveProfileName(rawName) {
  const name = normalizeProfileName(rawName);
  if (!name) return false;
  if (!uiPrefs.profile.id) uiPrefs.profile.id = makeId('user');
  const changed = uiPrefs.profile.name !== name;
  const now = Date.now();
  uiPrefs.profile.name = name;
  state.authors[uiPrefs.profile.id] = { name, upd: now };
  savePrefs();
  saveLocal();
  localDirty = true;
  schedulePush();
  if (uiPrefs.shareLocation) maybeSendPresence(true);
  if (changed) {
    if (currentScreen === 'settings') renderSettings();
    if (currentScreen === 'routes') renderRoutesList();
    if (currentScreen === 'route' && currentRoute) renderRouteDetail(currentRoute);
    if (sheetStoreId) renderStoreSheet();
    maybeAskSharing();
  }
  return true;
}

function saveProfileFromSettings() {
  const input = $('#profile-name-input');
  const name = normalizeProfileName(input ? input.value : '');
  if (!name) {
    showSnackbar('Введите имя');
    if (input) {
      try { input.focus(); } catch (e) { /* ignore */ }
    }
    return;
  }
  if (name === uiPrefs.profile.name) {
    showSnackbar('Имя уже сохранено');
    return;
  }
  saveProfileName(name);
  if (input) input.blur();
  showSnackbar('Имя сохранено: ' + name);
}

async function ensureProfileName() {
  if (uiPrefs.profile.name) return;
  const name = await nameDialog(
    'Как вас зовут?',
    'Имя нужно, чтобы подписывать визиты и комментарии. Его увидят участники группы, а изменить его можно в настройках.',
    'Продолжить',
    'Позже',
    ''
  );
  if (name) {
    saveProfileName(name);
    showSnackbar('Вы вошли как ' + name);
  }
}

function safeJsonParse(text) {
  try { return JSON.parse(text); } catch (e) { return null; }
}

/* --------------------------- Хранилище --------------------------- */

function sanitizeVisits(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [id, value] of Object.entries(raw)) {
    if (!id || !value || typeof value !== 'object') continue;
    const at = toNumber(value.at != null ? value.at : value.visitedAt);
    const upd = toNumber(value.upd);
    if (at == null && upd == null) continue;
    const rec = {
      at: at && at > 0 ? at : null,
      upd: upd && upd > 0 ? upd : (at || Date.now())
    };
    const by = sanitizeAuthor(value.by);
    if (by) rec.by = by;
    out[id] = rec;
  }
  return out;
}

function sanitizeComments(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [id, value] of Object.entries(raw)) {
    if (!id || !value || typeof value !== 'object') continue;
    const text = String(value.text != null ? value.text : '').replace(/\r\n/g, '\n').slice(0, COMMENT_MAX);
    const upd = toNumber(value.upd);
    const rec = {
      text: text.trim(),
      upd: upd && upd > 0 ? upd : Date.now()
    };
    const by = sanitizeAuthor(value.by);
    if (by) rec.by = by;
    out[id] = rec;
  }
  return out;
}

function sanitizeAuthors(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [id, value] of Object.entries(raw)) {
    if (!id || !value || typeof value !== 'object') continue;
    const name = normalizeProfileName(value.name);
    if (!name) continue;
    const upd = toNumber(value.upd);
    out[id] = { name, upd: upd && upd > 0 ? upd : Date.now() };
  }
  return out;
}

function sanitizeVersionMap(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [id, value] of Object.entries(raw)) {
    const n = toNumber(value);
    if (id && n != null) out[id] = n;
  }
  return out;
}

function normalizeAlias(value) {
  return String(value == null ? '' : value)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, ALIAS_MAX);
}

function sanitizeOverrides(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [id, value] of Object.entries(raw)) {
    if (!id || !value || typeof value !== 'object') continue;
    const rec = { upd: toNumber(value.upd) || Date.now() };
    if (typeof value.name === 'string') rec.name = value.name.slice(0, 80);
    if (value.alias != null) rec.alias = normalizeAlias(value.alias);
    if (typeof value.brand === 'string') rec.brand = normalizeBrand(value.brand, value.name);
    if (typeof value.address === 'string') rec.address = value.address.slice(0, 200);
    if (value.period != null) {
      const p = toNumber(value.period);
      if (p && p > 0) rec.period = clampPeriod(p);
      else rec.period = null;
    } else if (Object.prototype.hasOwnProperty.call(value, 'period')) {
      rec.period = null;
    }
    if (value.lat != null) {
      const lat = toNumber(value.lat);
      if (lat != null && lat > -90 && lat < 90) rec.lat = lat;
    }
    if (value.lon != null) {
      const lon = toNumber(value.lon);
      if (lon != null && lon > -180 && lon < 180) rec.lon = lon;
    }
    out[id] = rec;
  }
  return out;
}

function sanitizeCustom(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [id, value] of Object.entries(raw)) {
    if (!id || !value || typeof value !== 'object') continue;
    const lat = toNumber(value.lat);
    const lon = toNumber(value.lon);
    const rec = {
      id,
      name: String(value.name || '').slice(0, 80),
      alias: normalizeAlias(value.alias),
      brand: normalizeBrand(value.brand, value.name),
      address: String(value.address != null ? value.address : (value.addr || '')).slice(0, 200),
      lat: lat != null && lat > -90 && lat < 90 ? lat : null,
      lon: lon != null && lon > -180 && lon < 180 ? lon : null,
      route: ROUTE_NAMES.includes(value.route) ? value.route : null,
      city: isValidCityId(value.city) ? value.city : cityIdForCoords(lat, lon),
      osm: typeof value.osm === 'string' ? value.osm : '',
      source: typeof value.source === 'string' ? value.source : 'user',
      upd: toNumber(value.upd) || Date.now()
    };
    if (value.period != null) {
      const p = toNumber(value.period);
      if (p && p > 0) rec.period = clampPeriod(p);
    }
    out[id] = rec;
  }
  return out;
}

function sanitizeSettings(raw) {
  const base = defaultSettings();
  if (!raw || typeof raw !== 'object') return base;
  if (raw.periodDays != null) base.periodDays = clampPeriod(raw.periodDays);
  if (['local', 'light'].includes(raw.basemap)) {
    base.basemap = raw.basemap;
  } else if (raw.basemap === 'dark') {
    base.basemap = 'local';
  } else if (raw.lightMap) {
    base.basemap = 'light';
  }
  base.lightMap = base.basemap === 'light';
  base.upd = toNumber(raw.upd) || 0;
  return base;
}

function sanitizeState(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    v: 2,
    settings: sanitizeSettings(src.settings),
    visits: sanitizeVisits(src.visits),
    hidden: sanitizeVersionMap(src.hidden),
    custom: sanitizeCustom(src.custom),
    overrides: sanitizeOverrides(src.overrides),
    comments: sanitizeComments(src.comments),
    authors: sanitizeAuthors(src.authors)
  };
}

function loadLocal() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      state = sanitizeState(safeJsonParse(raw));
    }
  } catch (e) {
    console.warn('Не удалось прочитать локальные данные', e);
  }
  try {
    const prefs = safeJsonParse(localStorage.getItem(SETTINGS_KEY) || '{}');
    if (prefs && typeof prefs === 'object') {
      uiPrefs.screen = ['map', 'routes', 'settings'].includes(prefs.screen) ? prefs.screen : 'map';
      uiPrefs.filter = ['all', 'due', 'ok'].includes(prefs.filter) ? prefs.filter : 'all';
      const savedProfile = prefs.profile && typeof prefs.profile === 'object' ? prefs.profile : {};
      uiPrefs.profile = {
        id: typeof savedProfile.id === 'string' ? savedProfile.id.slice(0, 80) : '',
        name: normalizeProfileName(savedProfile.name)
      };
      uiPrefs.shareLocation = prefs.shareLocation === true;
      uiPrefs.shareAsked = prefs.shareAsked === true;
      uiPrefs.city = typeof prefs.city === 'string' && prefs.city ? prefs.city : DEFAULT_CITY;

      const hasCityPrefs = prefs.plans && typeof prefs.plans === 'object';
      uiPrefs.plans = normalizePlanPrefs(prefs.plans);
      uiPrefs.tours = normalizeTourPrefs(prefs.tours);
      uiPrefs.views = normalizeViewPrefs(prefs.views);

      if (!hasCityPrefs) {
        /* Старая версия хранила один план и один объезд - это был Орёл. */
        const legacyPlan = Array.isArray(prefs.plan)
          ? prefs.plan.filter(id => typeof id === 'string' && id).slice(0, 300)
          : [];
        if (legacyPlan.length) uiPrefs.plans[DEFAULT_CITY] = legacyPlan;
        const savedTour = prefs.tour && typeof prefs.tour === 'object' ? prefs.tour : null;
        const tourIds = savedTour && Array.isArray(savedTour.ids)
          ? savedTour.ids.filter(id => typeof id === 'string' && id).slice(0, 300)
          : [];
        if (tourIds.length) {
          uiPrefs.tours[DEFAULT_CITY] = {
            ids: tourIds,
            startedAt: toNumber(savedTour.startedAt) || Date.now()
          };
        }
      }
      currentCity = cityById(uiPrefs.city);
      uiPrefs.plan = planIds().slice();
      uiPrefs.tour = tourPref();
    }
  } catch (e) { /* ignore */ }
  if (!uiPrefs.profile.id) uiPrefs.profile.id = makeId('user');
  if (uiPrefs.profile.name && !state.authors[uiPrefs.profile.id]) {
    state.authors[uiPrefs.profile.id] = { name: uiPrefs.profile.name, upd: Date.now() };
  }
  mapFilter = uiPrefs.filter;
}

let saveTimer = null;
function saveLocal(immediate) {
  const write = () => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      console.warn('Не удалось сохранить локальные данные', e);
    }
  };
  if (immediate) {
    clearTimeout(saveTimer);
    write();
    return;
  }
  clearTimeout(saveTimer);
  saveTimer = setTimeout(write, 120);
}

function savePrefs() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(uiPrefs));
  } catch (e) { /* ignore */ }
}

/* ------------------------- Справочник точек ------------------------- */

function normalizeSeedMapStore(seed, cityId) {
  const lat = toNumber(seed.lat);
  const lon = toNumber(seed.lon);
  if (!isValidCoord(lat, lon)) return null;
  const brand = normalizeBrand(seed.brand, seed.name || seed.brandRu);
  return {
    id: String(seed.id || makeId('seed')),
    name: storeDisplayName(brand, seed.name || seed.brandRu),
    brand,
    address: String(seed.addr != null ? seed.addr : (seed.address || '')).trim(),
    lat,
    lon,
    route: null,
    city: isValidCityId(cityId) ? cityId : DEFAULT_CITY,
    osm: String(seed.osm || ''),
    source: 'seed'
  };
}

function normalizeRouteSeedStore(seed, route) {
  const base = normalizeSeedMapStore(seed, DEFAULT_CITY);
  if (!base) return null;
  base.route = route;
  base.address = String(seed.address != null ? seed.address : (seed.addr || '')).trim();
  return base;
}

function isHidden(id) {
  return (toNumber(state.hidden[id]) || 0) > 0;
}

function composeStore(base) {
  const custom = state.custom[base.id];
  const ov = state.overrides[base.id] || {};
  const src = custom || base;
  const brand = normalizeBrand(ov.brand != null ? ov.brand : src.brand, ov.name != null ? ov.name : src.name);
  const lat = ov.lat != null ? ov.lat : toNumber(src.lat);
  const lon = ov.lon != null ? ov.lon : toNumber(src.lon);
  const route = src.route && ROUTE_NAMES.includes(src.route) ? src.route : null;
  const city = isValidCityId(src.city) ? src.city : cityIdForCoords(lat, lon);
  const rawPeriod = ov.period !== undefined ? ov.period : src.period;
  const period = rawPeriod != null && Number(rawPeriod) > 0 ? clampPeriod(rawPeriod) : null;
  return {
    id: base.id,
    name: storeDisplayName(brand, ov.name != null ? ov.name : src.name),
    alias: normalizeAlias(ov.alias != null ? ov.alias : src.alias),
    brand,
    address: String(ov.address != null ? ov.address : (src.address != null ? src.address : (src.addr || ''))).trim(),
    lat: isValidCoord(lat, lon) ? lat : null,
    lon: isValidCoord(lat, lon) ? lon : null,
    route,
    city,
    period,
    osm: String(src.osm || ''),
    source: src.source || (custom ? 'user' : 'seed'),
    custom: !!custom,
    hidden: isHidden(base.id)
  };
}

function rebuildStoreCache() {
  const bases = new Map();

  for (const seeds of Object.values(cityStoreSeeds)) {
    if (!Array.isArray(seeds)) continue;
    for (const seed of seeds) {
      if (seed && seed.id) bases.set(seed.id, seed);
    }
  }
  for (const route of ROUTE_NAMES) {
    const list = Array.isArray(routeSeed[route]) ? routeSeed[route] : [];
    for (const seed of list) {
      if (seed && seed.id) bases.set(seed.id, seed);
    }
  }
  for (const [id, rec] of Object.entries(state.custom)) {
    if (!rec || !id) continue;
    const base = {
      id,
      name: rec.name,
      alias: rec.alias,
      brand: rec.brand,
      address: rec.address,
      lat: rec.lat,
      lon: rec.lon,
      route: rec.route,
      city: rec.city,
      period: rec.period,
      osm: rec.osm,
      source: rec.source || 'user'
    };
    bases.set(id, base);
  }

  storeCache = new Map();
  for (const [id, base] of bases) {
    const store = composeStore(base);
    if (!store.hidden) storeCache.set(id, store);
  }
  knownStoreIds = new Set(bases.keys());
  allStores = Array.from(storeCache.values());
}

function getStore(id) {
  return id ? storeCache.get(id) || null : null;
}

function commentFor(id) {
  const rec = id ? state.comments[id] : null;
  return rec && typeof rec.text === 'string' && rec.text ? rec.text : '';
}

function saveComment(id, rawText) {
  if (!id) return false;
  const text = String(rawText == null ? '' : rawText)
    .replace(/\r\n/g, '\n')
    .trim()
    .slice(0, COMMENT_MAX);
  const prev = state.comments[id];
  const prevText = prev && typeof prev.text === 'string' ? prev.text : '';
  if (text === prevText) return false;
  const rec = { text, upd: Date.now() };
  const author = currentAuthor();
  if (author) rec.by = author;
  state.comments[id] = rec;
  saveLocal();
  localDirty = true;
  schedulePush();
  return true;
}

function refreshCommentViews() {
  if (currentScreen === 'routes') renderRoutesList();
  if (currentScreen === 'route' && currentRoute) renderRouteDetail(currentRoute);
}

let commentTimer = null;
let commentPending = null;

function queueCommentSave(id, text) {
  if (!id) return;
  commentPending = { id, text };
  clearTimeout(commentTimer);
  commentTimer = setTimeout(flushCommentSave, 650);
}

function flushCommentSave() {
  clearTimeout(commentTimer);
  commentTimer = null;
  const pending = commentPending;
  commentPending = null;
  if (!pending) return;
  if (saveComment(pending.id, pending.text)) {
    updateCommentMeta(pending.id);
    refreshCommentViews();
  }
}

function saveStoreAlias(id, rawAlias) {
  if (!id) return false;
  const alias = normalizeAlias(rawAlias);
  const cached = storeCache.get(id);
  const prev = cached && typeof cached.alias === 'string' ? cached.alias : '';
  if (alias === prev) return false;
  const rec = Object.assign({}, state.overrides[id] || {}, { alias, upd: Date.now() });
  state.overrides[id] = rec;
  if (cached) cached.alias = alias;
  saveLocal();
  localDirty = true;
  schedulePush();
  return true;
}

let aliasTimer = null;
let aliasPending = null;

function queueAliasSave(id, text) {
  if (!id) return;
  aliasPending = { id, text };
  clearTimeout(aliasTimer);
  aliasTimer = setTimeout(flushAliasSave, 600);
}

function flushAliasSave() {
  clearTimeout(aliasTimer);
  aliasTimer = null;
  const pending = aliasPending;
  aliasPending = null;
  if (!pending) return;
  saveStoreAlias(pending.id, pending.text);
}

function isKnownRoute(name) {
  return isMainRouteName(name) || ROUTE_NAMES.includes(name);
}

function storesForRoute(route) {
  const mainCity = cityByRouteName(route);
  if (mainCity) {
    return allStores.filter(s => s.city === mainCity.id && !s.route && s.lat != null && s.lon != null);
  }
  return allStores.filter(s => s.route === route && s.city === DEFAULT_CITY);
}

function cityStores() {
  const cityId = currentCityId();
  return allStores.filter(s => s.city === cityId);
}

function mapStores() {
  return cityStores().filter(s => !s.route && s.lat != null && s.lon != null);
}

function routeStores() {
  return cityStores().filter(s => s.route);
}

/* --------------------------- Таймер --------------------------- */

function storePeriod(store) {
  if (store && store.period) return clampPeriod(store.period);
  return clampPeriod(state.settings.periodDays);
}

function visitTime(id) {
  const v = state.visits[id];
  const at = v ? toNumber(v.at) : null;
  return at && at > 0 ? at : null;
}

function getStatus(store) {
  const period = storePeriod(store);
  const at = visitTime(store.id);
  if (!at) {
    return {
      due: true,
      period,
      at: null,
      daysAgo: null,
      daysLeft: null,
      progress: 0,
      label: 'Пора посетить',
      sub: 'Ещё не отмечен ни разу'
    };
  }
  const daysAgo = Math.max(0, Math.floor((todayStart() - startOfDay(at)) / DAY_MS));
  const left = period - daysAgo;
  const progress = Math.min(1, Math.max(0, daysAgo / period));
  if (left <= 0) {
    const overdue = Math.abs(left);
    return {
      due: true,
      period,
      at,
      daysAgo,
      daysLeft: 0,
      progress: 1,
      label: 'Пора посетить',
      sub: overdue === 0
        ? 'Срок истёк сегодня'
        : 'Просрочено на ' + overdue + ' ' + daysWord(overdue)
    };
  }
  return {
    due: false,
    period,
    at,
    daysAgo,
    daysLeft: left,
    progress,
    label: 'В норме',
    sub: 'Осталось ' + left + ' ' + daysWord(left)
  };
}

function storeStatusCounts(stores) {
  let due = 0;
  let ok = 0;
  for (const store of stores) {
    if (getStatus(store).due) due += 1;
    else ok += 1;
  }
  return { due, ok, total: stores.length };
}

/* --------------------------- Изменения --------------------------- */

function touchVisit(id, mark) {
  if (!id) return;
  const now = Date.now();
  if (!mark) {
    state.visits[id] = { at: null, upd: now };
    return;
  }
  const rec = { at: now, upd: now };
  const author = currentAuthor();
  if (author) rec.by = author;
  state.visits[id] = rec;
}

function setStoreVisited(id, mark) {
  touchVisit(id, mark);
  commit();
}

function commit(options) {
  const opts = options || {};
  flushCommentSave();
  flushAliasSave();
  saveLocal();
  if (opts.structure) rebuildStoreCache();
  rebuildTourVisual();
  if (map) {
    renderMapMarkers();
  }
  renderCounts();
  updatePlanCount();
  if (planMode) renderPlan();
  if (currentScreen === 'routes') renderRoutesList();
  if (currentScreen === 'route' && currentRoute) renderRouteDetail(currentRoute);
  if (currentScreen === 'settings') renderSettings();
  if (sheetStoreId && getStore(sheetStoreId)) renderStoreSheet();
  if (opts.structure && map && !allStores.length) updateMapEmpty();
  renderTourUi();
  localDirty = true;
  schedulePush();
}

/* ----------------------------- Карта ----------------------------- */

function createClusterGroup(kind) {
  const isOk = kind === 'ok';
  return L.markerClusterGroup({
    maxClusterRadius: 46,
    showCoverageOnHover: false,
    spiderfyOnMaxZoom: true,
    disableClusteringAtZoom: 17,
    removeOutsideVisibleBounds: true,
    iconCreateFunction(cluster) {
      return L.divIcon({
        className: 'store-cluster ' + (isOk ? 'ok-cluster' : 'due-cluster'),
        html: '<div class="cluster' + (isOk ? ' ok' : '') + '">' +
          '<span>' + cluster.getChildCount() + '</span>' +
          '</div>',
        iconSize: [54, 54],
        iconAnchor: [27, 27]
      });
    }
  });
}

function clusterGroupFor(due) {
  if (!clusterLayers) return null;
  return due ? clusterLayers.due : clusterLayers.ok;
}

function clusterGroupForMarker(marker) {
  return clusterGroupFor(!!(marker && marker.options && marker.options.storeDue));
}

/* Кластерные группы держат на карте ещё и внутренние слои
   (_featureGroup/_nonPointGroup) — их нельзя снимать при очистке карты. */
function isClusterInternalLayer(layer) {
  if (!clusterLayers) return false;
  for (const group of [clusterLayers.ok, clusterLayers.due]) {
    if (!group) continue;
    if (layer === group || layer === group._featureGroup || layer === group._nonPointGroup) return true;
  }
  return false;
}

function refreshClusterLayers() {
  if (!clusterLayers) return;
  for (const layer of [clusterLayers.due, clusterLayers.ok]) {
    if (layer && typeof layer.refreshClusters === 'function') layer.refreshClusters();
  }
}

function initMap() {
  if (map || typeof L === 'undefined') return;

  const city = currentCity || cityById(currentCityId());
  map = L.map('map', {
    zoomControl: false,
    attributionControl: false,
    minZoom: 3,
    maxZoom: 18
  }).setView(cityCenterOf(city), city.zoom || 12, { animate: false });

  /* Подпись об источнике карты есть в настройках, на карте не мешаем. */

  tileLight = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19
  });
  tileLight.on('tileerror', handleTileError);

  localBaseLayer = null;

  map.createPane('basemapLabels');
  const labelPane = map.getPane('basemapLabels');
  if (labelPane) {
    labelPane.style.zIndex = 450;
    labelPane.style.pointerEvents = 'none';
  }

  applyBasemap();

  /* Кнопки масштаба не показываем: на телефоне привычнее жесты. */
  clusterLayers = {
    ok: createClusterGroup('ok'),
    due: createClusterGroup('due')
  };
  /* «Пора» добавляем последней, чтобы её кластеры были поверх «в норме». */
  map.addLayer(clusterLayers.ok);
  map.addLayer(clusterLayers.due);

  map.on('click', onMapClick);
  map.on('zoomend', updateLocalBasemap);
  map.on('moveend', () => {
    syncLocalSegments();
    layoutMapLabels();
    scheduleSaveView();
  });

  loadMapAssets();
  setTimeout(() => map.invalidateSize(), 80);
  renderPresence();
  if (myLocation) renderMyLocation();
}

function handleTileError() {
  if (state.settings.basemap === 'local') return;
  tileErrorCount += 1;
  clearTimeout(tileErrorTimer);
  tileErrorTimer = setTimeout(() => { tileErrorCount = 0; }, 9000);
  if (tileErrorCount >= 6) {
    tileErrorCount = 0;
    setBasemap('local', true);
    showSnackbar('Карта не загрузилась - включена локальная схема');
  }
}

async function loadMapAssets() {
  if (mapAssetsRequested || typeof L === 'undefined') return;
  mapAssetsRequested = true;
  const token = ++mapAssetsToken;
  const city = currentCity || cityById(currentCityId());

  try {
    const mapDir = (city.mapDir || 'map').replace(/\\/g, '/');
    const layersUrl = mapDir + '/layers.json';
    const response = await fetch(layersUrl, { cache: 'no-store' });
    if (!response.ok) throw new Error('layers.json: HTTP ' + response.status);
    const config = await response.json();
    if (token !== mapAssetsToken) return;
    if (!config || !Array.isArray(config.levels) || !config.levels.length) {
      throw new Error('layers.json: bad format');
    }
    const bounds = Array.isArray(config.bounds) && config.bounds.length === 2
      ? config.bounds
      : cityBoundsOf(city);
    config.bounds = bounds;
    localLayers = config;
  } catch (error) {
    console.warn('Не удалось загрузить слои карты', error);
    if (token !== mapAssetsToken) return;
    const bounds = cityBoundsOf(city);
    localLayers = {
      bounds: bounds,
      levels: [{ name: 'base', dir: city.mapDir || 'map', grid: 1, width: 2372, height: 2500, maxZoom: 18 }],
      base: city.baseFile || 'oryol-base.webp'
    };
  }

  if (token !== mapAssetsToken) return;
  const baseLevel = localLayers.levels[0];
  const mapDir = (city.mapDir || 'map').replace(/\\/g, '/');
  const baseFile = localLayers.base || city.baseFile || (city.id === DEFAULT_CITY ? 'oryol-base.webp' : 'base.webp');
  if (localBaseLayer && map) {
    try { map.removeLayer(localBaseLayer); } catch (e) {}
  }
  localBaseLayer = L.imageOverlay(
    (baseLevel.dir || mapDir) + '/' + baseFile,
    [[localLayers.bounds[0][0], localLayers.bounds[0][1]],
     [localLayers.bounds[1][0], localLayers.bounds[1][1]]],
    { interactive: false, className: 'basemap-image' }
  );

  await loadMapLabels();
  if (token !== mapAssetsToken) return;
  updateLocalBasemap();
}

function localLevelForZoom(zoom) {
  if (!localLayers || !localLayers.levels.length) return -1;
  const levels = localLayers.levels;
  for (let i = 0; i < levels.length; i += 1) {
    if (zoom <= levels[i].maxZoom) return i;
  }
  return levels.length - 1;
}

function localSegmentBounds(level, row, col) {
  const bounds = localLayers.bounds;
  const west = bounds[0][1];
  const east = bounds[1][1];
  const south = bounds[0][0];
  const north = bounds[1][0];
  const segW = level.width / level.grid;
  const segH = level.height / level.grid;
  const x0 = col * segW;
  const x1 = (col + 1) * segW;
  const y0 = row * segH;
  const y1 = (row + 1) * segH;
  const lon = x => west + (x / level.width) * (east - west);
  const lat = y => north - (y / level.height) * (north - south);
  return [[lat(y1), lon(x0)], [lat(y0), lon(x1)]];
}

function clearLocalSegments() {
  if (!map) return;
  for (const overlay of localSegments.values()) {
    if (map.hasLayer(overlay)) map.removeLayer(overlay);
  }
  localSegments.clear();
  localLevelIndex = -1;
}

function syncLocalSegments() {
  if (!map || !localLayers || !localBaseLayer) return;
  if (state.settings.basemap !== 'local') return;

  if (!map.hasLayer(localBaseLayer)) localBaseLayer.addTo(map);

  const levelIndex = localLevelForZoom(map.getZoom());
  if (levelIndex !== localLevelIndex) {
    clearLocalSegments();
    localLevelIndex = levelIndex;
  }

  const level = localLayers.levels[levelIndex];
  if (!level || level.grid <= 1) return;

  const mapDir = ((currentCity && currentCity.mapDir) || level.dir || 'map').replace(/\\/g, '/');
  const view = map.getBounds().pad(0.12);
  const keep = new Set();

  for (let row = 0; row < level.grid; row += 1) {
    for (let col = 0; col < level.grid; col += 1) {
      const bounds = localSegmentBounds(level, row, col);
      if (!view.intersects(bounds)) continue;

      const key = level.name + ':' + row + ':' + col;
      keep.add(key);
      let overlay = localSegments.get(key);
      if (!overlay) {
        const dir = (level.dir || (level.name === 'base' ? mapDir : mapDir + '/' + level.name)).replace(/\\/g, '/');
        overlay = L.imageOverlay(
          dir + '/' + row + '_' + col + '.webp',
          bounds,
          { interactive: false, className: 'basemap-image' }
        );
        localSegments.set(key, overlay);
      }
      if (!map.hasLayer(overlay)) overlay.addTo(map);
    }
  }

  for (const [key, overlay] of Array.from(localSegments.entries())) {
    if (keep.has(key)) continue;
    if (map.hasLayer(overlay)) map.removeLayer(overlay);
    localSegments.delete(key);
  }
}

async function loadMapLabels() {
  if (mapLabelLayer || typeof L === 'undefined') return;

  try {
    const city = currentCity || cityById(currentCityId());
    const labelsUrl = (city.mapDir || 'map').replace(/\\/g, '/') + '/labels.json';
    const response = await fetch(labelsUrl, { cache: 'no-store' });
    if (!response.ok) throw new Error('labels.json: HTTP ' + response.status);
    const raw = await response.json();
    if (!Array.isArray(raw)) throw new Error('labels.json: bad format');

    const order = { main: 0, primary: 1, tertiary: 2, street: 3 };
    const list = raw
      .filter(item => item && item.name && Number.isFinite(item.lat) && Number.isFinite(item.lon))
      .sort((a, b) => {
        const pa = order[a.kind] != null ? order[a.kind] : 9;
        const pb = order[b.kind] != null ? order[b.kind] : 9;
        return pa - pb || a.name.length - b.name.length;
      });

    mapLabelLayer = L.layerGroup();
    for (const label of list) {
      const kind = order[label.kind] != null ? label.kind : 'street';
      const angle = Number.isFinite(label.angle) ? label.angle : 0;
      const marker = L.marker([label.lat, label.lon], {
        icon: L.divIcon({
          className: 'map-label-icon',
          html: '<span class="map-label k-' + kind + '" style="transform:translate(-50%,-50%) rotate(' +
            angle + 'deg)">' + escapeHtml(label.name) + '</span>',
          iconSize: [0, 0]
        }),
        pane: 'basemapLabels',
        interactive: false,
        keyboard: false
      });
      marker.options.labelData = label;
      mapLabelLayer.addLayer(marker);
      mapLabelMarkers.push(marker);
    }

    updateLocalLabels();
  } catch (error) {
    console.warn('Не удалось загрузить подписи карты', error);
  }
}

function layoutMapLabels() {
  if (!map || !mapLabelLayer || !map.hasLayer(mapLabelLayer)) return;

  const zoom = map.getZoom();
  const view = map.getBounds().pad(0.04);
  const placed = [];

  for (const marker of mapLabelMarkers) {
    const el = marker._icon;
    const label = marker.options.labelData;
    if (!el || !label) continue;

    const minZoom = label.kind === 'street' ? 16 : 14;
    const maxLength = zoom >= 17 ? 40 : 30;
    if (zoom < minZoom || label.name.length > maxLength || !view.contains([label.lat, label.lon])) {
      el.style.display = 'none';
      continue;
    }

    el.style.display = '';
    const textEl = el.firstElementChild;
    if (!textEl) continue;
    const rect = textEl.getBoundingClientRect();
    if (!rect.width || !rect.height) continue;

    const box = {
      l: rect.left - 4,
      t: rect.top - 2,
      r: rect.right + 4,
      b: rect.bottom + 2
    };
    let hit = false;
    for (const other of placed) {
      if (box.l < other.r && box.r > other.l && box.t < other.b && box.b > other.t) {
        hit = true;
        break;
      }
    }
    if (hit) {
      el.style.display = 'none';
      continue;
    }
    placed.push(box);
  }
}

function updateLocalLabels() {
  if (!map || !mapLabelLayer) return;
  const show = state.settings.basemap === 'local' && map.getZoom() >= 14;
  if (show) {
    map.getContainer().style.setProperty('--map-label-size', map.getZoom() >= 17 ? '13px' : '12px');
    if (!map.hasLayer(mapLabelLayer)) mapLabelLayer.addTo(map);
    layoutMapLabels();
  } else if (map.hasLayer(mapLabelLayer)) {
    map.removeLayer(mapLabelLayer);
  }
}

function updateLocalBasemap() {
  if (!map) return;
  const local = state.settings.basemap === 'local';
  const container = map.getContainer();
  container.classList.toggle('map-local', local);
  container.classList.toggle('map-light', state.settings.basemap === 'light');

  if (!local) {
    if (localBaseLayer && map.hasLayer(localBaseLayer)) map.removeLayer(localBaseLayer);
    clearLocalSegments();
    if (mapLabelLayer && map.hasLayer(mapLabelLayer)) map.removeLayer(mapLabelLayer);
    return;
  }

  if (!localLayers) return;
  syncLocalSegments();
  updateLocalLabels();
}

function updateBasemapToggleUi() {
  const btn = $('#btn-basemap');
  if (!btn) return;
  const online = state.settings.basemap === 'light';
  btn.classList.toggle('is-online', online);
  btn.setAttribute('aria-pressed', online ? 'true' : 'false');
  btn.setAttribute('aria-label', online
    ? 'Сейчас включена онлайн-карта. Переключить на офлайн-схему'
    : 'Сейчас включена офлайн-схема. Переключить на онлайн-карту');
  btn.setAttribute('title', online
    ? 'Онлайн-карта. Включить офлайн-схему'
    : 'Офлайн-схема. Включить онлайн-карту');
  const use = btn.querySelector('use');
  if (use) use.setAttribute('href', online ? '#i-layers' : '#i-cloud');
  const mode = btn.querySelector('.basemap-mode');
  if (mode) mode.textContent = online ? 'онлайн' : 'офлайн';
}

function applyBasemap() {
  updateBasemapToggleUi();
  if (!map) return;
  const mode = ['local', 'light'].includes(state.settings.basemap)
    ? state.settings.basemap
    : 'local';

  if (mode === 'local') {
    if (tileLight && map.hasLayer(tileLight)) map.removeLayer(tileLight);
    updateLocalBasemap();
    return;
  }

  if (localBaseLayer && map.hasLayer(localBaseLayer)) map.removeLayer(localBaseLayer);
  clearLocalSegments();
  if (mapLabelLayer && map.hasLayer(mapLabelLayer)) map.removeLayer(mapLabelLayer);
  tileErrorCount = 0;
  if (tileLight && !map.hasLayer(tileLight)) tileLight.addTo(map);

  const container = map.getContainer();
  container.classList.remove('map-local');
  container.classList.add('map-light');
}

function markerIcon(store, planOrder) {
  const status = getStatus(store);
  const selected = selectedMarkerId === store.id ? ' selected' : '';
  const inPlan = planOrder ? ' in-plan' : '';
  const tour = tourMarkerClass(store.id);
  const brand = store.brand === 'magnit' || store.brand === 'pyaterochka' ? store.brand : 'other';
  return L.divIcon({
    className: 'store-marker',
    html: '<div class="map-pin ' + (status.due ? 'due' : 'ok') + selected + inPlan + tour + '">' +
      '<span class="pin-inner brand-' + brand + '">' + escapeHtml(brandLetter(store.brand)) + '</span>' +
      (planOrder ? '<span class="pin-num">' + planOrder + '</span>' : '') +
      '</div>',
    iconSize: [38, 38],
    iconAnchor: [19, 19],
    popupAnchor: [0, -20]
  });
}

function markerMatchesFilter(store) {
  if (mapFilter === 'all') return true;
  const due = getStatus(store).due;
  return mapFilter === 'due' ? due : !due;
}

function renderMapMarkers() {
  if (!map || !clusterLayers) return;
  rebuildTourVisual();

  if (planMode) {
    if (tourLayer) {
      tourLayer.clearLayers();
      if (map.hasLayer(tourLayer)) map.removeLayer(tourLayer);
    }
    if (!planLayer) planLayer = L.layerGroup();
    if (!map.hasLayer(planLayer)) planLayer.addTo(map);
    planLayer.clearLayers();
    clusterLayers.due.clearLayers();
    clusterLayers.ok.clearLayers();
    markers.clear();

    const orders = planOrderMap();
    planIconState = orders;
    for (const store of mapStores()) {
      const status = getStatus(store);
      const marker = L.marker([store.lat, store.lon], {
        icon: markerIcon(store, orders.get(store.id)),
        draggable: false,
        keyboard: false,
        title: store.name + (store.address ? ' - ' + store.address : ''),
        storeDue: status.due,
        storeId: store.id
      });

      marker.on('click', (event) => {
        if (event && event.originalEvent) L.DomEvent.stopPropagation(event.originalEvent);
        onMarkerClick(store.id);
      });

      markers.set(store.id, marker);
      planLayer.addLayer(marker);
    }

    updatePlanLine();
    updateMapEmpty();
    renderTourUi();
    return;
  }

  if (planLayer && map.hasLayer(planLayer)) map.removeLayer(planLayer);
  if (planLine && map.hasLayer(planLine)) map.removeLayer(planLine);
  planLine = null;

  if (!tourLayer) tourLayer = L.layerGroup();
  if (!map.hasLayer(tourLayer)) tourLayer.addTo(map);
  tourLayer.clearLayers();

  clusterLayers.due.clearLayers();
  clusterLayers.ok.clearLayers();
  markers.clear();

  const stores = mapStores();
  for (const store of stores) {
    const inTour = isTourPending(store.id);
    if (!markerMatchesFilter(store) && !inTour) continue;
    const status = getStatus(store);
    const marker = L.marker([store.lat, store.lon], {
      icon: markerIcon(store),
      draggable: editMode,
      keyboard: false,
      title: store.name + (store.address ? ' - ' + store.address : ''),
      storeDue: status.due,
      storeId: store.id
    });

    marker.on('click', (event) => {
      if (event && event.originalEvent) L.DomEvent.stopPropagation(event.originalEvent);
      onMarkerClick(store.id);
    });

    marker.on('dragstart', () => {
      marker.__dragged = true;
    });

    marker.on('dragend', () => {
      const pos = marker.getLatLng();
      if (!pos) return;
      const now = Date.now();
      const existing = state.overrides[store.id] || {};
      state.overrides[store.id] = Object.assign({}, existing, {
        lat: Number(pos.lat.toFixed(7)),
        lon: Number(pos.lng.toFixed(7)),
        upd: now
      });
      commit({ structure: true });
      showSnackbar('Точка перемещена');
    });

    markers.set(store.id, marker);
    if (inTour) {
      marker.setZIndexOffset(store.id === tourVisual.activeId ? 14000 : 10000);
      tourLayer.addLayer(marker);
    } else {
      const group = clusterGroupFor(status.due);
      if (group) group.addLayer(marker);
    }
  }

  refreshClusterLayers();
  updateMapEmpty();
  renderTourUi();
}

function refreshAllMarkers() {
  if (!map) return;
  if (rebuildTourVisual()) {
    renderMapMarkers();
    return;
  }
  if (planMode) {
    const orders = planOrderMap();
    planIconState = orders;
    for (const [id, marker] of markers) {
      const store = getStore(id);
      if (!store) continue;
      marker.options.storeDue = getStatus(store).due;
      marker.setIcon(markerIcon(store, orders.get(id)));
    }
    refreshMarkerSelection();
    updatePlanLine();
    renderTourUi();
    return;
  }
  for (const [id, marker] of markers) {
    const store = getStore(id);
    if (!store) continue;
    const status = getStatus(store);
    const wasDue = !!marker.options.storeDue;
    marker.options.storeDue = status.due;
    marker.setIcon(markerIcon(store));
    if (wasDue !== status.due) {
      const from = clusterGroupFor(wasDue);
      const to = clusterGroupFor(status.due);
      if (from) from.removeLayer(marker);
      if (to) to.addLayer(marker);
    }
  }
  refreshClusterLayers();
  if (selectedMarkerId) refreshMarkerSelection();
  renderTourUi();
}

function refreshMarkerSelection() {
  for (const [id, marker] of markers) {
    const el = marker.getElement && marker.getElement();
    if (!el) continue;
    const pin = el.querySelector('.map-pin');
    if (!pin) continue;
    pin.classList.toggle('selected', id === selectedMarkerId);
  }
}

function highlightMarker(id) {
  selectedMarkerId = id || null;
  refreshMarkerSelection();
}

function updateMapEmpty() {
  const empty = $('#map-empty');
  const text = $('#map-empty-text');
  if (!empty || !text) return;
  const total = mapStores().length;
  const shown = Array.from(markers.keys()).length;
  if (!total && seedsLoaded) {
    text.textContent = 'На карте пока нет точек. Добавьте вручную или загрузите из OpenStreetMap.';
    empty.classList.remove('hidden');
    return;
  }
  if (total && !shown) {
    text.textContent = mapFilter === 'due' ? 'Нет магазинов, которые пора посетить.' : 'Нет магазинов «в норме».';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');
}

/* --------------------------- План маршрута --------------------------- */

function planIds() {
  const plans = uiPrefs.plans && typeof uiPrefs.plans === 'object' ? uiPrefs.plans : {};
  const list = plans[currentCityId()];
  return Array.isArray(list) ? list : [];
}

function setPlanIds(ids) {
  const list = (Array.isArray(ids) ? ids : [])
    .filter(id => typeof id === 'string' && id)
    .slice(0, 300);
  if (!uiPrefs.plans || typeof uiPrefs.plans !== 'object') uiPrefs.plans = {};
  uiPrefs.plans[currentCityId()] = list;
  uiPrefs.plan = list.slice();
  savePrefs();
}

function planStoreList() {
  const seen = new Set();
  const list = [];
  for (const id of planIds()) {
    if (seen.has(id)) continue;
    const store = getStore(id);
    if (!store || !isValidCoord(store.lat, store.lon)) continue;
    seen.add(id);
    list.push(store);
  }
  return list;
}

function syncPlanIds() {
  const stores = planStoreList();
  const next = stores.map(store => store.id);
  const current = planIds();
  if (next.length !== current.length || next.some((id, index) => id !== current[index])) {
    setPlanIds(next);
  }
  return stores;
}

function planOrderMap() {
  const orders = new Map();
  planStoreList().forEach((store, index) => orders.set(store.id, index + 1));
  return orders;
}

function planDistanceMeters() {
  const stores = planStoreList();
  let total = 0;
  for (let i = 1; i < stores.length; i += 1) {
    total += storeDistanceMeters(stores[i - 1], stores[i]);
  }
  return total;
}

function storeDistanceMeters(a, b) {
  if (!a || !b) return Infinity;
  return distanceMeters({ lat: a.lat, lng: a.lon }, { lat: b.lat, lng: b.lon });
}

function formatDistanceKm(meters) {
  const km = meters / 1000;
  const value = km < 10 ? km.toFixed(1) : String(Math.round(km));
  return value.replace('.', ',') + ' км';
}

function planYandexUrl() {
  const stores = planStoreList();
  if (stores.length < 2) return '';
  const points = stores
    .map(store => store.lat.toFixed(6) + ',' + store.lon.toFixed(6))
    .join('~');
  return 'https://yandex.ru/maps/?rtext=' + points + '&rtt=auto';
}

function updatePlanCount() {
  const countEl = $('#plan-count');
  if (!countEl) return;
  const count = planStoreList().length;
  countEl.textContent = String(count);
  countEl.classList.toggle('hidden', count === 0);
}

function updatePlanLine() {
  if (!map) return;
  if (planLine) {
    map.removeLayer(planLine);
    planLine = null;
  }
  if (!planMode) return;
  const stores = planStoreList();
  if (stores.length < 2) return;
  planLine = L.polyline(stores.map(store => [store.lat, store.lon]), {
    color: '#38bdf8',
    weight: 3,
    opacity: 0.85,
    dashArray: '7 8',
    lineCap: 'round',
    interactive: false
  }).addTo(map);
}

function renderPlan() {
  const listEl = $('#plan-list');
  const stores = syncPlanIds();
  updatePlanCount();
  if (!listEl) return;

  if (!stores.length) {
    listEl.innerHTML = '<div class="plan-empty">Отметьте точки на карте или найдите адрес.</div>';
  } else {
    listEl.innerHTML = stores.map((store, index) => {
      const address = store.address ? escapeHtml(store.address) : 'Адрес не указан';
      return '<div class="plan-item">' +
        '<span class="plan-num">' + (index + 1) + '</span>' +
        '<button class="plan-item-main" type="button" data-action="plan-focus" data-id="' + escapeHtml(store.id) + '">' +
          '<span class="plan-item-name">' + escapeHtml(store.name) + '</span>' +
          '<span class="plan-item-addr">' + address + '</span>' +
        '</button>' +
        '<span class="plan-item-tools">' +
          '<button type="button" data-action="plan-up" data-id="' + escapeHtml(store.id) + '" aria-label="Переставить выше" title="Выше"' + (index === 0 ? ' disabled' : '') + '>↑</button>' +
          '<button type="button" data-action="plan-down" data-id="' + escapeHtml(store.id) + '" aria-label="Переставить ниже" title="Ниже"' + (index === stores.length - 1 ? ' disabled' : '') + '>↓</button>' +
          '<button class="plan-remove" type="button" data-action="plan-remove" data-id="' + escapeHtml(store.id) + '" aria-label="Убрать из плана" title="Убрать из плана">×</button>' +
        '</span>' +
      '</div>';
    }).join('');
  }

  const distances = planDistanceMeters();
  const summary = $('#plan-summary');
  if (summary) {
    summary.textContent = stores.length
      ? stores.length + ' ' + plural(stores.length, 'точка', 'точки', 'точек') +
        ' · ' + formatDistanceKm(distances) + ' по прямой'
      : 'Точки не выбраны';
  }

  const distance = $('#plan-distance');
  if (distance) {
    distance.textContent = stores.length
      ? 'По прямой: ' + formatDistanceKm(distances)
      : 'Нажмите на маркер или найдите точку';
  }

  const yandex = $('#plan-yandex');
  if (yandex) {
    const url = planYandexUrl();
    yandex.classList.toggle('hidden', !url);
    if (url) yandex.href = url;
    else yandex.removeAttribute('href');
  }

  const optimize = $('#plan-optimize');
  if (optimize) optimize.disabled = stores.length < 3;
  const clear = $('#plan-clear');
  if (clear) clear.disabled = stores.length === 0;
  const remember = $('#plan-remember');
  if (remember) remember.disabled = stores.length === 0;
}

function refreshPlanMarkers() {
  if (!map) return;
  if (!planMode) {
    updatePlanCount();
    return;
  }
  const orders = planOrderMap();
  for (const [id, marker] of markers) {
    const store = getStore(id);
    if (!store) continue;
    const next = orders.get(id) || 0;
    const previous = planIconState.get(id) || 0;
    if (next !== previous) marker.setIcon(markerIcon(store, next));
  }
  planIconState = orders;
  refreshMarkerSelection();
  updatePlanLine();
}

function addPlanStore(id, options) {
  const store = getStore(id);
  if (!store || !isValidCoord(store.lat, store.lon)) return false;
  if (planIds().includes(store.id)) {
    if (!options || options.quiet !== true) showSnackbar('Точка уже в плане');
    return false;
  }
  if (planIds().length >= 300) {
    showSnackbar('В плане уже 300 точек');
    return false;
  }
  uiPrefs.plan = planIds().concat(store.id);
  setPlanIds(uiPrefs.plan);
  renderPlan();
  refreshPlanMarkers();
  if (!options || options.quiet !== true) showSnackbar('В плане: ' + store.name);
  return true;
}

function removePlanStore(id) {
  const previous = planIds();
  const next = previous.filter(item => item !== id);
  if (next.length === previous.length) return;
  setPlanIds(next);
  renderPlan();
  refreshPlanMarkers();
}

function togglePlanStore(id) {
  if (planIds().includes(id)) removePlanStore(id);
  else addPlanStore(id);
}

function movePlanStore(id, delta) {
  const list = planIds().slice();
  const index = list.indexOf(id);
  if (index < 0) return;
  const target = index + delta;
  if (target < 0 || target >= list.length) return;
  list.splice(index, 1);
  list.splice(target, 0, id);
  setPlanIds(list);
  renderPlan();
  refreshPlanMarkers();
}

function optimizePlanOrder() {
  const stores = planStoreList();
  if (stores.length < 3) return;

  const remaining = stores.slice(1);
  const ordered = [stores[0]];
  while (remaining.length) {
    const last = ordered[ordered.length - 1];
    let bestIndex = 0;
    let bestDistance = Infinity;
    remaining.forEach((store, index) => {
      const distance = storeDistanceMeters(last, store);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    });
    ordered.push(remaining.splice(bestIndex, 1)[0]);
  }

  let improved = true;
  let guard = 0;
  while (improved && guard < 30) {
    improved = false;
    guard += 1;
    for (let i = 0; i < ordered.length - 1; i += 1) {
      for (let j = i + 1; j < ordered.length; j += 1) {
        const a = ordered[i];
        const b = ordered[i + 1];
        const c = ordered[j];
        const d = ordered[j + 1];
        const before = storeDistanceMeters(a, b) + (d ? storeDistanceMeters(c, d) : 0);
        const after = storeDistanceMeters(a, c) + (d ? storeDistanceMeters(b, d) : 0);
        if (after + 1 < before) {
          const segment = ordered.slice(i + 1, j + 1).reverse();
          ordered.splice(i + 1, segment.length, ...segment);
          improved = true;
        }
      }
    }
  }

  uiPrefs.plan = ordered.map(store => store.id);
  setPlanIds(uiPrefs.plan);
  renderPlan();
  refreshPlanMarkers();
  showSnackbar('Порядок обновлён · ' + formatDistanceKm(planDistanceMeters()) + ' по прямой');
}

function clearPlan() {
  const previous = planIds().slice();
  if (!previous.length) return;
  setPlanIds([]);
  renderPlan();
  showSnackbar('План очищен', 'Вернуть', () => {
    setPlanIds(previous);
    renderPlan();
  });
}

/* --------------------------- Объезд по плану --------------------------- */

function tourPref() {
  const tours = uiPrefs.tours && typeof uiPrefs.tours === 'object' ? uiPrefs.tours : {};
  const cityId = currentCityId();
  const value = tours[cityId];
  if (!value || !Array.isArray(value.ids) || !value.ids.length) return null;
  return { ids: value.ids.slice(), startedAt: toNumber(value.startedAt) || Date.now() };
}

function setTourPref(tour) {
  if (!uiPrefs.tours || typeof uiPrefs.tours !== 'object') uiPrefs.tours = {};
  const cityId = currentCityId();
  if (!tour || !Array.isArray(tour.ids) || !tour.ids.length) {
    delete uiPrefs.tours[cityId];
    uiPrefs.tour = null;
  } else {
    uiPrefs.tours[cityId] = { ids: tour.ids.slice(), startedAt: toNumber(tour.startedAt) || Date.now() };
    uiPrefs.tour = uiPrefs.tours[cityId];
  }
  savePrefs();
}

function tourIds() {
  const tour = tourPref();
  return tour && Array.isArray(tour.ids) ? tour.ids : [];
}

function syncTourState() {
  const tour = tourPref();
  uiPrefs.tour = tour;
  if (!tour) return false;
  const ids = [];
  const seen = new Set();
  const cityId = currentCityId();
  for (const id of tour.ids) {
    if (seen.has(id)) continue;
    const store = getStore(id);
    if (!store || !isValidCoord(store.lat, store.lon)) continue;
    if (store.city && store.city !== cityId) continue;
    seen.add(id);
    ids.push(id);
  }
  if (!ids.length) {
    setTourPref(null);
    return true;
  }
  if (ids.length !== tour.ids.length ||
      ids.some((id, index) => id !== tour.ids[index]) ||
      typeof tour.startedAt !== 'number') {
    setTourPref({ ids, startedAt: toNumber(tour.startedAt) || Date.now() });
    return true;
  }
  return false;
}

function saveCurrentView() {
  if (!map) return;
  const center = map.getCenter();
  if (!isValidCoord(center.lat, center.lng)) return;
  if (!uiPrefs.views || typeof uiPrefs.views !== 'object') uiPrefs.views = {};
  uiPrefs.views[currentCityId()] = {
    lat: Number(center.lat.toFixed(6)),
    lng: Number(center.lng.toFixed(6)),
    zoom: Math.round(map.getZoom())
  };
  savePrefs();
}

function scheduleSaveView() {
  if (viewSaveTimer) clearTimeout(viewSaveTimer);
  viewSaveTimer = setTimeout(saveCurrentView, 250);
}


function isTourPending(id) {
  return !!id && tourVisual.pending.has(id);
}

function tourMarkerClass(id) {
  if (!isTourPending(id)) return '';
  return tourVisual.activeId === id ? ' tour-active' : ' tour-pending';
}

function rebuildTourVisual() {
  syncTourState();
  const pending = new Set();
  let activeId = null;
  for (const id of tourIds()) {
    const store = getStore(id);
    if (!store || !getStatus(store).due) continue;
    pending.add(id);
    if (!activeId) activeId = id;
  }
  tourVisual = { activeId, pending };
  const key = (activeId || '') + '|' + Array.from(pending).sort().join(',');
  const changed = key !== tourVisualKey;
  tourVisualKey = key;
  return changed;
}

function tourStats() {
  const ids = tourIds();
  let done = 0;
  let activeId = null;
  let index = 0;
  ids.forEach((id, i) => {
    const store = getStore(id);
    if (!store) return;
    if (getStatus(store).due) {
      if (!activeId) {
        activeId = id;
        index = i + 1;
      }
      return;
    }
    done += 1;
  });
  return { total: ids.length, done, remaining: ids.length - done, activeId, index };
}

function renderTourUi() {
  const bar = $('#tour-bar');
  if (!bar) return;
  const stats = uiPrefs.tour ? tourStats() : null;
  if (!stats || !stats.total) {
    bar.classList.add('hidden');
    return;
  }
  bar.classList.remove('hidden');
  bar.classList.toggle('tour-done', !stats.activeId);

  const store = stats.activeId ? getStore(stats.activeId) : null;
  const count = $('#tour-count');
  const name = $('#tour-name');
  const main = $('#tour-focus');
  if (count) count.textContent = (store ? stats.index : stats.total) + '/' + stats.total;
  if (name) {
    name.textContent = store
      ? store.name + (store.address ? ' · ' + store.address : '')
      : 'Готово · всё в норме';
  }
  if (main) {
    const label = store
      ? store.name + (store.address ? ' · ' + store.address : '')
      : 'Все точки объезда в норме';
    main.disabled = !store;
    main.title = label;
    main.setAttribute('aria-label', store
      ? 'Показать текущую точку объезда: ' + label
      : 'Все точки объезда в норме');
  }
}

function startTour() {
  const stores = planStoreList();
  if (!stores.length) {
    showSnackbar('Сначала добавьте точки в план');
    return;
  }
  const pending = stores.filter(store => getStatus(store).due);
  if (!pending.length) {
    showSnackbar('Все точки плана уже в норме');
    return;
  }

  setTourPref({ ids: stores.map(store => store.id), startedAt: Date.now() });
  if (planMode) setPlanMode(false);
  else if (map) renderMapMarkers();

  const active = getStore(tourStats().activeId);
  if (active && map) {
    map.setView([active.lat, active.lon], Math.max(map.getZoom(), 14), { animate: true });
  }
  renderTourUi();
  showSnackbar('Объезд начат · ' + pending.length + ' ' +
    plural(pending.length, 'точка', 'точки', 'точек'));
}

function resetTour() {
  if (!uiPrefs.tour) return;
  const previous = uiPrefs.tour;
  setTourPref(null);
  if (map) renderMapMarkers();
  else renderTourUi();
  showSnackbar('Объезд сброшен', 'Вернуть', () => {
    setTourPref(previous);
    if (map) renderMapMarkers();
    else renderTourUi();
  });
}

function focusTourActive() {
  rebuildTourVisual();
  const store = getStore(tourVisual.activeId);
  if (!store || !map) return;
  map.setView([store.lat, store.lon], Math.max(map.getZoom(), 15), { animate: true });
  highlightMarker(store.id);
}

function fitPlanBounds() {
  if (!map) return;
  const stores = planStoreList();
  if (!stores.length) return;
  if (stores.length === 1) {
    map.setView([stores[0].lat, stores[0].lon], 16, { animate: true });
    return;
  }
  map.fitBounds(L.latLngBounds(stores.map(store => [store.lat, store.lon])), {
    padding: [70, 70],
    maxZoom: 16,
    animate: true
  });
}

function setPlanMode(on) {
  const next = !!on;
  if (next === planMode) return;

  if (next) {
    if (editMode || addMode) {
      editMode = false;
      addMode = false;
      updateAddUi();
    }
    closeMapSearch();
    closeSheets();
  }

  planMode = next;
  const screen = $('#screen-map');
  if (screen) screen.classList.toggle('plan-mode', planMode);
  const panel = $('#plan-panel');
  if (panel) panel.classList.toggle('hidden', !planMode);
  const btn = $('#btn-plan');
  if (btn) {
    btn.classList.toggle('active', planMode);
    btn.setAttribute('aria-pressed', planMode ? 'true' : 'false');
  }

  renderMapMarkers();
  renderPlan();
  if (planMode) {
    fitPlanBounds();
    showSnackbar('План: нажимайте на маркеры, чтобы добавить или убрать точки');
  } else {
    maybeAskSharing();
  }
}

/* --------------------------- Поиск на карте --------------------------- */

function setMapSearchOpen(on) {
  const next = !!on;
  if (next === mapSearchOpen) {
    if (next) {
      const currentInput = $('#map-search-input');
      if (currentInput) currentInput.focus();
    }
    return;
  }
  mapSearchOpen = next;

  const panel = $('#map-search-panel');
  if (panel) panel.classList.toggle('hidden', !next);
  const openBtn = $('#map-search-open');
  if (openBtn) openBtn.setAttribute('aria-expanded', next ? 'true' : 'false');
  const input = $('#map-search-input');
  const results = $('#map-search-results');
  const hint = $('#map-search-hint');

  if (next) {
    if (editMode || addMode) {
      editMode = false;
      addMode = false;
      updateAddUi();
      renderMapMarkers();
    }
    mapSearchQuery = '';
    if (input) input.value = '';
    renderMapSearchResults();
    setTimeout(() => {
      try { if (input) input.focus(); } catch (e) { /* ignore */ }
    }, 40);
    return;
  }

  mapSearchQuery = '';
  if (input) input.value = '';
  if (results) results.innerHTML = '';
  if (hint) hint.classList.add('hidden');
}

function closeMapSearch() {
  setMapSearchOpen(false);
}

function renderMapSearchResults() {
  const results = $('#map-search-results');
  const hint = $('#map-search-hint');
  const clearBtn = $('#map-search-clear');
  const query = mapSearchQuery.trim();

  if (clearBtn) clearBtn.classList.toggle('hidden', !mapSearchQuery);
  if (!results) return;

  if (!query) {
    results.innerHTML = '';
    if (hint) {
      hint.classList.remove('hidden');
      hint.textContent = planMode
        ? 'Введите адрес - найденная точка добавится в план.'
        : 'Введите улицу, дом, название магазина или наше название.';
    }
    return;
  }

  const found = rankStores(mapStores(), query);
  if (!found.length) {
    if (hint) {
      hint.classList.remove('hidden');
      hint.textContent = 'Ничего не найдено.';
    }
    results.innerHTML = '<div class="search-empty">Проверьте улицу, дом, название магазина или наше название.</div>';
    return;
  }

  const shown = found.slice(0, 12);
  if (hint) {
    hint.classList.remove('hidden');
    hint.textContent = 'Найдено ' + found.length + ' ' +
      plural(found.length, 'магазин', 'магазина', 'магазинов') +
      (found.length > shown.length ? ' · показаны первые ' + shown.length : '') +
      (planMode ? ' · нажмите, чтобы добавить в план' : '');
  }
  results.innerHTML = shown.map(store => searchResultHtml(store, 'map')).join('');
}

function handleMapSearchResult(id) {
  const store = getStore(id);
  if (!store) return;

  if (planMode) {
    const added = addPlanStore(id, { quiet: true });
    if (added) {
      mapSearchQuery = '';
      const input = $('#map-search-input');
      if (input) {
        input.value = '';
        input.focus();
      }
      renderMapSearchResults();
      showSnackbar('В плане: ' + store.name);
    } else {
      showSnackbar('Точка уже в плане');
    }
    return;
  }

  closeMapSearch();
  if (!map) return;
  if (!markerMatchesFilter(store)) setMapFilter('all');
  highlightMarker(store.id);
  map.setView([store.lat, store.lon], Math.max(map.getZoom(), 16), { animate: true });
  openStoreSheet(store.id);
}

function focusPlanStore(id) {
  const store = getStore(id);
  if (!store || !map) return;
  highlightMarker(store.id);
  map.setView([store.lat, store.lon], Math.max(map.getZoom(), 16), { animate: true });
}

function setMapFilter(filter) {
  mapFilter = ['all', 'due', 'ok'].includes(filter) ? filter : 'all';
  uiPrefs.filter = mapFilter;
  savePrefs();
  $$('.map-chips .chip').forEach(chip => {
    chip.classList.toggle('active', chip.dataset.filter === mapFilter);
  });
  renderMapMarkers();
}

function fitMapToStores() {
  if (!map) return;
  const stores = mapStores();
  if (!stores.length) {
    const city = currentCity || cityById(currentCityId());
    map.setView(cityCenterOf(city), city.zoom || 12);
    return;
  }
  const bounds = L.latLngBounds(stores.map(s => [s.lat, s.lon]));
  map.fitBounds(bounds, { padding: [50, 50], maxZoom: 15 });
}

/* --------------------------- Поиск --------------------------- */

function normalizeSearchText(value) {
  return String(value == null ? '' : value)
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9]+/gi, ' ')
    .trim();
}

function rankStores(stores, query) {
  const phrase = normalizeSearchText(query);
  const tokens = Array.from(new Set(phrase.split(' ').filter(Boolean)));
  if (!tokens.length) return [];

  const ranked = [];
  const city = currentCity || cityById(currentCityId());
  for (const store of stores) {
    if (!store) continue;
    const name = normalizeSearchText(store.name);
    const alias = normalizeSearchText(store.alias);
    const address = normalizeSearchText(store.address);
    const brand = normalizeSearchText(brandTitle(store.brand));
    const storeCity = store.city ? cityById(store.city) : city;
    const route = normalizeSearchText(store.route || (storeCity && storeCity.name) || ORYOL_ROUTE);
    let score = 0;
    let matchedAll = true;

    for (const token of tokens) {
      let best = 0;
      if (name.startsWith(token)) best = 6;
      else if (name.includes(token)) best = 5;
      if (alias.startsWith(token)) best = Math.max(best, 8);
      else if (alias.includes(token)) best = Math.max(best, 7);
      if (address.includes(token)) best = Math.max(best, 4);
      if (brand.includes(token)) best = Math.max(best, 3);
      if (route.includes(token)) best = Math.max(best, 2);
      if (!best) {
        matchedAll = false;
        break;
      }
      score += best;
    }

    if (!matchedAll) continue;
    if (phrase && name.includes(phrase)) score += 4;
    if (phrase && alias.includes(phrase)) score += 5;
    if (phrase && address.includes(phrase)) score += 3;
    ranked.push({ store, score });
  }

  ranked.sort((a, b) =>
    b.score - a.score ||
    a.store.name.localeCompare(b.store.name, 'ru') ||
    (a.store.address || '').localeCompare(b.store.address || '', 'ru'));
  return ranked.map(item => item.store);
}

function searchResultHtml(store, kind) {
  const status = getStatus(store);
  const inPlan = planIds().includes(store.id);
  const brand = store.brand === 'magnit' || store.brand === 'pyaterochka' ? store.brand : 'other';
  const city = currentCity || cityById(currentCityId());
  const routeLabel = store.route ? 'Маршрут «' + store.route + '»' : (city.name || ORYOL_ROUTE) + ' · на карте';
  const address = store.address ? escapeHtml(store.address) : 'Адрес не указан';
  const alias = store.alias
    ? '<span class="search-result-alias">· ' + escapeHtml(store.alias) + '</span>'
    : '';
  return '<button class="search-result" type="button" data-result-kind="' + escapeHtml(kind) +
    '" data-result-id="' + escapeHtml(store.id) + '">' +
    '<span class="search-result-badge brand-' + brand + '">' + escapeHtml(brandLetter(store.brand)) + '</span>' +
    '<span class="search-result-main">' +
      '<span class="search-result-name">' + escapeHtml(store.name) + alias + '</span>' +
      '<span class="search-result-addr' + (store.address ? '' : ' empty') + '">' + address + '</span>' +
      '<span class="search-result-route">' + escapeHtml(routeLabel) + '</span>' +
    '</span>' +
    '<span class="search-result-meta">' +
      (inPlan
        ? '<span class="search-result-plan">В плане</span>'
        : '<span class="search-result-status ' + (status.due ? 'due' : 'ok') + '">' +
            (status.due ? 'Пора' : 'В норме') +
          '</span>') +
    '</span>' +
  '</button>';
}

/* ------------------------- Геопозиция ------------------------- */

function locationSupported() {
  return typeof navigator !== 'undefined' && navigator.geolocation &&
    typeof navigator.geolocation.watchPosition === 'function';
}

function distanceMeters(a, b) {
  if (!a || !b) return Infinity;
  const radius = 6371000;
  const toRad = value => value * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * radius * Math.asin(Math.min(1, Math.sqrt(h)));
}

function presenceHue(id) {
  let hash = 0;
  const text = String(id || '');
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) % 360;
  }
  return Math.abs(hash);
}

function presenceAgoText(at) {
  const diff = Math.max(0, Date.now() - (at || 0));
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'только что';
  if (minutes < 60) {
    return minutes + ' ' + plural(minutes, 'минуту', 'минуты', 'минут') + ' назад';
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return hours + ' ' + plural(hours, 'час', 'часа', 'часов') + ' назад';
  }
  return formatDateTime(at);
}

function ensurePresenceLayer() {
  if (!map) return null;
  if (!presenceLayer) presenceLayer = L.layerGroup().addTo(map);
  return presenceLayer;
}

function renderMyLocation() {
  const layer = ensurePresenceLayer();
  if (!layer || !myLocation) return;
  const latlng = [myLocation.lat, myLocation.lng];
  if (!myLocationMarker) {
    myLocationMarker = L.marker(latlng, {
      icon: L.divIcon({
        className: 'me-marker',
        html: '<div class="me-dot"><span></span></div>',
        iconSize: [22, 22],
        iconAnchor: [11, 11]
      }),
      interactive: false,
      keyboard: false,
      zIndexOffset: 1200
    });
    layer.addLayer(myLocationMarker);
  } else {
    myLocationMarker.setLatLng(latlng);
  }
  if (myLocation.acc > 0 && myLocation.acc <= PRESENCE_MAX_ACC_M) {
    if (!myAccuracyCircle) {
      myAccuracyCircle = L.circle(latlng, {
        radius: myLocation.acc,
        className: 'me-accuracy',
        interactive: false
      });
      layer.addLayer(myAccuracyCircle);
    } else {
      myAccuracyCircle.setLatLng(latlng);
      myAccuracyCircle.setRadius(myLocation.acc);
    }
  } else if (myAccuracyCircle) {
    layer.removeLayer(myAccuracyCircle);
    myAccuracyCircle = null;
  }
}

function personIcon(rec, uid) {
  const name = rec.name || 'Участник';
  const initial = name.slice(0, 1).toUpperCase();
  return L.divIcon({
    className: 'person-marker',
    html: '<div class="person-pin" style="--hue:' + presenceHue(uid) + '">' +
      '<span class="person-avatar">' + escapeHtml(initial) + '</span>' +
      '<span class="person-name">' + escapeHtml(name) + '</span>' +
      '</div>',
    iconSize: [28, 28],
    iconAnchor: [14, 14],
    popupAnchor: [0, -14]
  });
}

function personPopupHtml(rec) {
  const acc = rec.acc ? ' · ±' + Math.round(rec.acc) + ' м' : '';
  return '<div class="person-popup"><b>' + escapeHtml(rec.name || 'Участник') + '</b><br>' +
    escapeHtml(presenceAgoText(rec.at)) + acc + '</div>';
}

function renderPresence() {
  if (!map) return;
  const layer = ensurePresenceLayer();
  if (!layer) return;
  const now = Date.now();
  const seen = new Set();

  for (const [uid, rec] of presence) {
    if (uid === uiPrefs.profile.id) continue;
    if (!rec || !isValidCoord(rec.lat, rec.lng)) continue;
    if (!rec.at || now - rec.at > PRESENCE_STALE_MS) continue;
    seen.add(uid);
    const latlng = [rec.lat, rec.lng];
    let marker = presenceMarkers.get(uid);
    if (!marker) {
      marker = L.marker(latlng, {
        icon: personIcon(rec, uid),
        keyboard: false,
        zIndexOffset: 800,
        title: rec.name || 'Участник'
      });
      marker.bindPopup(personPopupHtml(rec));
      presenceMarkers.set(uid, marker);
      layer.addLayer(marker);
    } else {
      marker.setLatLng(latlng);
      marker.setIcon(personIcon(rec, uid));
      marker.setPopupContent(personPopupHtml(rec));
    }
  }

  for (const [uid, marker] of presenceMarkers) {
    if (!seen.has(uid)) {
      layer.removeLayer(marker);
      presenceMarkers.delete(uid);
    }
  }
  renderPeopleBar();
}

function renderPeopleBar() {
  const bar = $('#people-bar');
  if (!bar) return;
  const now = Date.now();
  const items = [];
  for (const [uid, rec] of presence) {
    if (uid === uiPrefs.profile.id) continue;
    if (!rec || !rec.at || now - rec.at > PRESENCE_STALE_MS) continue;
    items.push({ uid, rec });
  }
  if (!items.length) {
    bar.innerHTML = '';
    bar.classList.add('hidden');
    return;
  }
  items.sort((a, b) => (b.rec.at || 0) - (a.rec.at || 0));
  bar.innerHTML = items.map(({ uid, rec }) => {
    const online = now - (rec.at || 0) <= PRESENCE_ONLINE_MS;
    const name = rec.name || 'Участник';
    const ago = presenceAgoText(rec.at);
    const initial = name.trim().slice(0, 1).toUpperCase() || '•';
    return '<button class="person-chip' + (online ? ' online' : '') + '" type="button" data-person="' +
      escapeHtml(uid) + '" style="--hue:' + presenceHue(uid) + '" title="' + escapeHtml(name + ' · ' + ago) +
      '" aria-label="Показать на карте: ' + escapeHtml(name + ', ' + ago) + '">' +
      '<span class="person-avatar">' + escapeHtml(initial) + '</span>' +
      '<span class="person-name">' + escapeHtml(name) + '</span>' +
      '<small>' + escapeHtml(ago) + '</small></button>';
  }).join('');
  bar.classList.remove('hidden');
}

function centerOnPerson(uid) {
  const rec = uid ? presence.get(uid) : null;
  if (!map || !rec || !isValidCoord(rec.lat, rec.lng)) return;
  map.setView([rec.lat, rec.lng], Math.max(map.getZoom(), 15), { animate: true });
  const marker = presenceMarkers.get(uid);
  if (marker && typeof marker.openPopup === 'function') {
    try { marker.openPopup(); } catch (e) { /* ignore */ }
  }
}

function startGeoWatch() {
  if (!locationSupported() || geoWatchId != null || document.hidden) return;
  try {
    geoWatchId = navigator.geolocation.watchPosition(handleGeoPosition, handleGeoError, {
      enableHighAccuracy: true,
      maximumAge: 8000,
      timeout: 25000
    });
  } catch (error) {
    geoWatchId = null;
    console.warn('Геопозиция недоступна', error);
  }
}

function stopGeoWatch() {
  if (geoWatchId != null && locationSupported()) {
    try { navigator.geolocation.clearWatch(geoWatchId); } catch (e) { /* ignore */ }
  }
  geoWatchId = null;
}

function locationWatchNeeded() {
  if (document.hidden) return false;
  if (uiPrefs.shareLocation) return true;
  return locationWanted && currentScreen === 'map';
}

function refreshGeoWatch() {
  if (locationWatchNeeded()) startGeoWatch();
  else stopGeoWatch();
}

function handleGeoPosition(position) {
  if (!position || !position.coords) return;
  const lat = toNumber(position.coords.latitude);
  const lng = toNumber(position.coords.longitude);
  if (!isValidCoord(lat, lng)) return;
  myLocation = {
    lat,
    lng,
    acc: toNumber(position.coords.accuracy) || 0,
    at: Date.now()
  };
  renderMyLocation();

  const locateBtn = $('#btn-locate');
  if (locateBtn) locateBtn.classList.remove('locating');
  clearTimeout(locateHintTimer);

  if (centerOnNextFix && map) {
    centerOnNextFix = false;
    map.setView([lat, lng], Math.max(map.getZoom(), 15), { animate: true });
  }

  if (uiPrefs.shareLocation) maybeSendPresence();
}

function handleGeoError(error) {
  const locateBtn = $('#btn-locate');
  if (locateBtn) locateBtn.classList.remove('locating');
  centerOnNextFix = false;
  const code = error && error.code;
  if (code === 1) {
    if (uiPrefs.shareLocation) setShareEnabled(false, { ask: false });
    showSnackbar('Разрешите доступ к геопозиции в настройках браузера или телефона');
  } else if (code === 3) {
    showSnackbar('Не удалось определить местоположение. Попробуйте выйти на открытое место.');
  } else if (!myLocation) {
    showSnackbar('Геопозиция пока недоступна');
  }
}

function maybeSendPresence(force) {
  if (!uiPrefs.shareLocation || !myLocation || document.hidden) return;
  if (!cloud.db || !cloud.fs || !uiPrefs.profile.id) return;
  const now = Date.now();
  if (now - (myLocation.at || 0) > PRESENCE_ONLINE_MS) return;
  const since = now - lastPresenceAt;
  const moved = lastPresenceSent ? distanceMeters(lastPresenceSent, myLocation) : Infinity;
  if (!force) {
    if (since < 5000) return;
    if (since < PRESENCE_SEND_MS && moved < PRESENCE_MOVE_M) return;
  }
  if (presenceWriteBusy) {
    presenceWritePending = true;
    return;
  }
  const name = uiPrefs.profile.name;
  if (!name) return;
  const payload = {
    name,
    lat: Number(myLocation.lat.toFixed(6)),
    lng: Number(myLocation.lng.toFixed(6)),
    acc: Math.round(myLocation.acc || 0),
    at: now,
    upd: now
  };
  presenceWriteBusy = true;
  lastPresenceAt = now;
  lastPresenceSent = { lat: myLocation.lat, lng: myLocation.lng };

  const docRef = cloud.fs.doc(cloud.db, 'groups', GROUP_ID, 'presence', uiPrefs.profile.id);
  cloud.fs.setDoc(docRef, payload, { merge: true }).then(() => {
    presenceTroubleShown = false;
  }).catch((error) => {
    console.warn('Не удалось отправить геопозицию', error);
    if (!presenceTroubleShown) {
      presenceTroubleShown = true;
      showSnackbar('Геопозиция не отправляется - проверьте интернет');
    }
  }).then(() => {
    presenceWriteBusy = false;
    /* Пока запрос летел, пользователь мог выключить передачу - тогда
       удаляем запись ещё раз, чтобы она не «всплыла» после удаления. */
    if (!uiPrefs.shareLocation) {
      presenceWritePending = false;
      if (cloud.fs && cloud.db) {
        const freshRef = cloud.fs.doc(cloud.db, 'groups', GROUP_ID, 'presence', uiPrefs.profile.id);
        cloud.fs.deleteDoc(freshRef).catch(() => {});
      }
      return;
    }
    if (presenceWritePending) {
      presenceWritePending = false;
      maybeSendPresence();
    }
  });
}

function stopPresenceSend() {
  lastPresenceAt = 0;
  lastPresenceSent = null;
  presenceWritePending = false;
  if (cloud.db && cloud.fs && uiPrefs.profile.id) {
    const docRef = cloud.fs.doc(cloud.db, 'groups', GROUP_ID, 'presence', uiPrefs.profile.id);
    cloud.fs.deleteDoc(docRef).catch(() => {});
  }
}

function updateShareUi() {
  const on = !!uiPrefs.shareLocation;
  const shareBtn = $('#btn-share');
  if (shareBtn) {
    shareBtn.classList.toggle('active', on);
    shareBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    shareBtn.title = on ? 'Вы делитесь геопозицией' : 'Делиться геопозицией';
    shareBtn.setAttribute('aria-label', shareBtn.title);
  }
  const settingsBtn = $('#btn-share-settings');
  if (settingsBtn) {
    settingsBtn.textContent = on ? 'Выключить передачу геопозиции' : 'Включить передачу геопозиции';
    settingsBtn.classList.toggle('primary', on);
  }
  const hint = $('#share-hint');
  if (hint) {
    hint.textContent = on
      ? 'Сейчас ваша позиция видна участникам, пока приложение открыто.'
      : 'Позиция не передаётся. Включите, чтобы участники видели вас на карте.';
  }
  const consent = $('#share-consent');
  if (consent && uiPrefs.shareAsked) consent.classList.add('hidden');
}

function maybeAskSharing() {
  const consent = $('#share-consent');
  if (!consent || uiPrefs.shareAsked || uiPrefs.shareLocation) return;
  if (!uiPrefs.profile.name) return;
  if (currentScreen !== 'map' || editMode || addMode) return;
  consent.classList.remove('hidden');
}

function setShareEnabled(enabled, options) {
  const opts = options || {};
  const on = !!enabled;
  if (on && !locationSupported()) {
    showSnackbar('Геопозиция недоступна на этом устройстве');
    return;
  }
  if (on && !uiPrefs.profile.name) {
    ensureProfileName().then(() => {
      if (uiPrefs.profile.name) setShareEnabled(true, opts);
    });
    return;
  }
  uiPrefs.shareLocation = on;
  if (opts.ask !== false) uiPrefs.shareAsked = true;
  savePrefs();
  updateShareUi();
  if (on) locationWanted = true;
  refreshGeoWatch();
  if (on) {
    showSnackbar('Геопозиция видна участникам группы');
    maybeSendPresence(true);
    const consent = $('#share-consent');
    if (consent) consent.classList.add('hidden');
  } else {
    stopPresenceSend();
    showSnackbar('Геопозиция больше не передаётся');
  }
}

function locateMe() {
  if (!locationSupported()) {
    showSnackbar('Геопозиция недоступна на этом устройстве');
    return;
  }
  locationWanted = true;
  refreshGeoWatch();
  const btn = $('#btn-locate');
  if (myLocation && map) {
    map.setView([myLocation.lat, myLocation.lng], Math.max(map.getZoom(), 15), { animate: true });
    return;
  }
  centerOnNextFix = true;
  if (btn) btn.classList.add('locating');
  clearTimeout(locateHintTimer);
  locateHintTimer = setTimeout(() => {
    if (!myLocation) {
      if (btn) btn.classList.remove('locating');
      showSnackbar('Ждём сигнал GPS. Проверьте, что доступ к геопозиции разрешён.');
    }
  }, 12000);
}

function startPresenceListener() {
  if (!cloud.db || !cloud.fs || presenceUnsub) return;
  try {
    const col = cloud.fs.collection(cloud.db, 'groups', GROUP_ID, 'presence');
    presenceUnsub = cloud.fs.onSnapshot(col, (snapshot) => {
      const next = new Map();
      snapshot.forEach((docSnap) => {
        const data = docSnap.data() || {};
        const lat = toNumber(data.lat);
        const lng = toNumber(data.lng);
        if (!isValidCoord(lat, lng)) return;
        next.set(docSnap.id, {
          name: normalizeProfileName(data.name) || 'Участник',
          lat,
          lng,
          acc: toNumber(data.acc) || 0,
          at: toNumber(data.at) || 0,
          upd: toNumber(data.upd) || 0
        });
      });
      presence = next;
      renderPresence();
    }, (error) => {
      console.warn('Не удалось получить геопозиции участников', error);
    });
  } catch (error) {
    console.warn('Геопозиции участников недоступны', error);
  }
}

function updateAddUi() {
  const banner = $('#add-banner');
  if (banner) banner.classList.toggle('hidden', !addMode);
  const editBanner = $('#edit-banner');
  if (editBanner) editBanner.classList.toggle('hidden', !editMode || addMode);
  const fab = $('#fab-add');
  if (fab) fab.classList.toggle('is-active', addMode);
  const editBtn = $('#btn-edit');
  if (editBtn) {
    editBtn.classList.toggle('is-active', editMode);
    editBtn.setAttribute('aria-pressed', editMode ? 'true' : 'false');
  }
  const consent = $('#share-consent');
  if (consent && (editMode || addMode)) consent.classList.add('hidden');
}

function setEditMode(on) {
  if (on) {
    closeMapSearch();
    if (planMode) setPlanMode(false);
  }
  editMode = !!on;
  if (editMode) setAddMode(false);
  updateAddUi();
  renderMapMarkers();
  showSnackbar(editMode
    ? 'Режим редактирования: перетаскивайте маркеры, нажмите на точку для изменения.'
    : 'Режим редактирования выключен');
  if (!editMode) maybeAskSharing();
}

function setAddMode(on) {
  if (on) {
    closeMapSearch();
    if (planMode) setPlanMode(false);
  }
  addMode = !!on;
  if (addMode) {
    editMode = false;
    updateAddUi();
    renderMapMarkers();
    showSnackbar('Нажмите на карту в месте нового магазина');
  } else {
    updateAddUi();
    renderMapMarkers();
    maybeAskSharing();
  }
}

function onMapClick(event) {
  if (planMode) return;
  if (!addMode || !event || !event.latlng) return;
  const lat = Number(event.latlng.lat.toFixed(7));
  const lon = Number(event.latlng.lng.toFixed(7));
  addMode = false;
  updateAddUi();
  renderMapMarkers();
  openStoreForm(null, { lat, lon }, null);
}

function onMarkerClick(id) {
  const store = getStore(id);
  if (!store) return;

  if (planMode) {
    togglePlanStore(id);
    return;
  }

  if (editMode) {
    openStoreForm(id, null, store.route);
    return;
  }

  /* Тап по точке только открывает карточку. Визит отмечается кнопкой
     «Отметить визит» внутри карточки, чтобы не менять статус случайно. */
  highlightMarker(id);
  openStoreSheet(id);
}

/* --------------------- Служебные элементы интерфейса --------------------- */

let snackbarTimer = null;

function showSnackbar(text, actionLabel, action) {
  const bar = $('#snackbar');
  const textEl = $('#snackbar-text');
  const actionEl = $('#snackbar-action');
  if (!bar || !textEl || !actionEl) return;

  clearTimeout(snackbarTimer);
  textEl.textContent = text;

  if (actionLabel && typeof action === 'function') {
    actionEl.textContent = actionLabel;
    actionEl.classList.remove('hidden');
    actionEl.onclick = () => {
      hideSnackbar();
      try { action(); } catch (e) { console.error(e); }
    };
  } else {
    actionEl.classList.add('hidden');
    actionEl.onclick = null;
  }

  bar.classList.remove('hidden');
  snackbarTimer = setTimeout(hideSnackbar, actionLabel ? 5500 : 3200);
}

function hideSnackbar() {
  clearTimeout(snackbarTimer);
  const bar = $('#snackbar');
  if (bar) bar.classList.add('hidden');
}

function nameDialog(title, text, okLabel, cancelLabel, initial) {
  return new Promise((resolve) => {
    const modal = $('#modal');
    const titleEl = $('#modal-title');
    const textEl = $('#modal-text');
    const okBtn = $('#modal-ok');
    const cancelBtn = $('#modal-cancel');
    const nameWrap = $('#modal-name');
    const nameInput = $('#modal-name-input');
    const nameError = $('#modal-name-error');
    const passWrap = $('#modal-pass');
    const passInput = $('#modal-pass-input');
    if (!modal || !titleEl || !textEl || !okBtn || !cancelBtn || !nameWrap || !nameInput) {
      const answer = window.prompt(text, initial || '');
      resolve(normalizeProfileName(answer) || null);
      return;
    }

    titleEl.textContent = title;
    textEl.textContent = text;
    okBtn.textContent = okLabel || 'Продолжить';
    okBtn.classList.remove('danger');
    okBtn.classList.add('primary');
    cancelBtn.textContent = cancelLabel || 'Отмена';
    if (passWrap) passWrap.classList.add('hidden');
    if (passInput) {
      passInput.value = '';
      passInput.onkeydown = null;
    }
    nameWrap.classList.remove('hidden');
    nameInput.value = initial || '';
    if (nameError) nameError.classList.add('hidden');
    modal.classList.remove('hidden');
    const focusTimer = setTimeout(() => {
      try {
        nameInput.focus();
        nameInput.select();
      } catch (e) { /* ignore */ }
    }, 60);

    const cleanup = () => {
      clearTimeout(focusTimer);
      modal.classList.add('hidden');
      nameWrap.classList.add('hidden');
      if (nameError) nameError.classList.add('hidden');
      nameInput.value = '';
      nameInput.onkeydown = null;
      passInput && (passInput.onkeydown = null);
      okBtn.onclick = null;
      cancelBtn.onclick = null;
      modal.onclick = null;
    };

    const submit = () => {
      const name = normalizeProfileName(nameInput.value);
      if (!name) {
        if (nameError) nameError.classList.remove('hidden');
        try { nameInput.focus(); } catch (e) { /* ignore */ }
        return;
      }
      cleanup();
      resolve(name);
    };

    okBtn.onclick = submit;
    nameInput.onkeydown = (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        submit();
      }
    };
    cancelBtn.onclick = () => { cleanup(); resolve(null); };
    modal.onclick = (event) => {
      if (event.target === modal) { cleanup(); resolve(null); }
    };
  });
}

function confirmDialog(title, text, okLabel, danger) {
  return new Promise((resolve) => {
    const modal = $('#modal');
    const titleEl = $('#modal-title');
    const textEl = $('#modal-text');
    const okBtn = $('#modal-ok');
    const cancelBtn = $('#modal-cancel');
    const passWrap = $('#modal-pass');
    const passInput = $('#modal-pass-input');
    const nameWrap = $('#modal-name');
    const nameInput = $('#modal-name-input');
    if (!modal || !titleEl || !textEl || !okBtn || !cancelBtn) {
      resolve(window.confirm(text));
      return;
    }

    cancelBtn.textContent = 'Отмена';
    if (nameWrap) nameWrap.classList.add('hidden');
    if (nameInput) {
      nameInput.value = '';
      nameInput.onkeydown = null;
    }
    if (passWrap) passWrap.classList.add('hidden');
    if (passInput) {
      passInput.value = '';
      passInput.onkeydown = null;
    }

    titleEl.textContent = title;
    textEl.textContent = text;
    okBtn.textContent = okLabel || 'ОК';
    okBtn.classList.toggle('danger', !!danger);
    okBtn.classList.toggle('primary', !danger);
    modal.classList.remove('hidden');

    const cleanup = () => {
      modal.classList.add('hidden');
      okBtn.onclick = null;
      cancelBtn.onclick = null;
      modal.onclick = null;
    };

    okBtn.onclick = () => { cleanup(); resolve(true); };
    cancelBtn.onclick = () => { cleanup(); resolve(false); };
    modal.onclick = (event) => {
      if (event.target === modal) { cleanup(); resolve(false); }
    };
  });
}

function localStoragePassword() {
  try {
    return atob(RESET_PASSWORD_B64);
  } catch (e) {
    return '';
  }
}

function passwordMatches(value) {
  return String(value == null ? '' : value) === localStoragePassword();
}

function passwordDialog(title, text, okLabel, danger) {
  return new Promise((resolve) => {
    const modal = $('#modal');
    const titleEl = $('#modal-title');
    const textEl = $('#modal-text');
    const okBtn = $('#modal-ok');
    const cancelBtn = $('#modal-cancel');
    const passWrap = $('#modal-pass');
    const passInput = $('#modal-pass-input');
    const passError = $('#modal-pass-error');
    const nameWrap = $('#modal-name');
    const nameInput = $('#modal-name-input');
    if (!modal || !titleEl || !textEl || !okBtn || !cancelBtn || !passWrap || !passInput) {
      resolve(passwordMatches(window.prompt(text, '')));
      return;
    }

    titleEl.textContent = title;
    textEl.textContent = text;
    okBtn.textContent = okLabel || 'Продолжить';
    okBtn.classList.toggle('danger', !!danger);
    okBtn.classList.toggle('primary', !danger);
    cancelBtn.textContent = 'Отмена';
    if (nameWrap) nameWrap.classList.add('hidden');
    if (nameInput) {
      nameInput.value = '';
      nameInput.onkeydown = null;
    }
    passWrap.classList.remove('hidden');
    passInput.value = '';
    if (passError) passError.classList.add('hidden');
    modal.classList.remove('hidden');
    const focusTimer = setTimeout(() => {
      try { passInput.focus(); } catch (e) { /* ignore */ }
    }, 60);

    const cleanup = () => {
      clearTimeout(focusTimer);
      modal.classList.add('hidden');
      passWrap.classList.add('hidden');
      if (passError) passError.classList.add('hidden');
      passInput.value = '';
      passInput.onkeydown = null;
      okBtn.onclick = null;
      cancelBtn.onclick = null;
      modal.onclick = null;
    };

    const submit = () => {
      if (!passwordMatches(passInput.value)) {
        if (passError) passError.classList.remove('hidden');
        passInput.value = '';
        try { passInput.focus(); } catch (e) { /* ignore */ }
        return;
      }
      cleanup();
      resolve(true);
    };

    okBtn.onclick = submit;
    passInput.onkeydown = (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        submit();
      }
    };
    cancelBtn.onclick = () => { cleanup(); resolve(false); };
    modal.onclick = (event) => {
      if (event.target === modal) { cleanup(); resolve(false); }
    };
  });
}

function showBootError(message) {
  const box = $('#boot-error');
  if (!box) return;
  box.textContent = message;
  box.classList.remove('hidden');
}

function hideBoot() {
  const boot = $('#boot');
  if (boot) boot.classList.add('boot-hide');
  setTimeout(() => {
    if (boot && boot.parentNode) boot.parentNode.removeChild(boot);
  }, 450);
}

/* --------------------------- Навигация --------------------------- */

function showScreen(id) {
  $$('.screen').forEach(screen => {
    screen.classList.toggle('active', screen.id === id);
  });
}

function setActiveTab(tab) {
  $$('#tabbar .tab').forEach(btn => {
    const active = btn.dataset.tab === tab;
    btn.classList.toggle('active', active);
    if (active) btn.setAttribute('aria-current', 'page');
    else btn.removeAttribute('aria-current');
  });
}

function go(tab) {
  if (tab === 'route' && currentRoute) {
    showScreen('screen-route');
    setActiveTab('routes');
    renderRouteDetail(currentRoute);
    currentScreen = 'route';
    return;
  }

  currentScreen = ['map', 'routes', 'settings'].includes(tab) ? tab : 'map';
  currentRoute = currentScreen === 'routes' ? currentRoute : null;
  uiPrefs.screen = currentScreen;
  savePrefs();
  refreshGeoWatch();

  if (currentScreen === 'map') {
    showScreen('screen-map');
    setActiveTab('map');
    setTimeout(() => {
      if (!map) return;
      map.invalidateSize();
      syncLocalSegments();
    }, 60);
    maybeAskSharing();
    return;
  }

  const consent = $('#share-consent');
  if (consent) consent.classList.add('hidden');

  if (currentScreen === 'routes') {
    currentRoute = null;
    oryolSearchQuery = '';
    showScreen('screen-routes');
    setActiveTab('routes');
    renderRoutesList();
    return;
  }

  showScreen('screen-settings');
  setActiveTab('settings');
  renderSettings();
}

function openRoute(name) {
  if (!isKnownRoute(name)) return;
  currentRoute = name;
  currentScreen = 'route';
  oryolSearchQuery = '';
  showScreen('screen-route');
  setActiveTab('routes');
  renderRouteDetail(name);
  const scroller = $('#screen-route');
  if (scroller) scroller.scrollTop = 0;
}

/* --------------------------- Счётчики --------------------------- */

function renderCounts() {
  const stores = mapStores();
  const counts = storeStatusCounts(stores);
  const allEl = $('#count-all');
  const dueEl = $('#count-due');
  const okEl = $('#count-ok');
  if (allEl) allEl.textContent = String(counts.total);
  if (dueEl) dueEl.textContent = String(counts.due);
  if (okEl) okEl.textContent = String(counts.ok);
  const title = $('#app-title');
  if (title) title.textContent = currentCity ? currentCity.name : 'Объезд';
}

function routeVisitedSummary(name) {
  const stores = storesForRoute(name);
  const counts = storeStatusCounts(stores);
  const visited = stores.filter(s => visitTime(s.id)).length;
  return { stores, counts, visited };
}

/* --------------------------- Маршруты --------------------------- */

function routeCardHtml(name, stores, counts) {
  const isMain = !!cityByRouteName(name);
  const isEmpty = stores.length === 0;
  const badgeClass = isEmpty ? 'route-badge empty' : (counts.due ? 'route-badge' : 'route-badge ok');
  const badgeText = isEmpty ? 'пусто' : (counts.due ? counts.due + ' пора' : 'всё в норме');
  const progress = stores.length ? Math.round((counts.ok / stores.length) * 100) : 0;

  let lastVisit = 0;
  let lastStore = null;
  for (const store of stores) {
    const at = visitTime(store.id);
    if (at && at > lastVisit) {
      lastVisit = at;
      lastStore = store;
    }
  }

  let footLeft;
  if (isEmpty) footLeft = isMain ? 'На карте пока нет магазинов' : 'Добавьте магазины вручную';
  else if (counts.due) footLeft = counts.due + ' ' + plural(counts.due, 'магазин ждёт', 'магазина ждут', 'магазинов ждут') + ' визита';
  else if (lastVisit) {
    footLeft = 'Последний визит ' + formatDate(lastVisit) + ' · ' +
      (lastStore ? visitAuthor(lastStore.id) || 'автор не указан' : 'автор не указан');
  } else footLeft = 'Все магазины в норме';

  const lastVisitLine = counts.due && lastVisit
    ? '<div class="route-last">Последний визит ' + formatDate(lastVisit) + ' · ' +
        escapeHtml(lastStore ? visitAuthor(lastStore.id) || 'автор не указан' : 'автор не указан') + '</div>'
    : '';

  const icon = isMain
    ? '<svg class="icon route-card-icon"><use href="#i-map"/></svg>'
    : '';
  const metaRight = isMain
    ? 'все точки на карте'
    : 'срок ' + storePeriod(stores[0] || { period: null }) + ' дн.';

  return '<button class="route-card' + (counts.due ? ' has-due' : '') + (isMain ? ' route-card-oryol' : '') + '" type="button" data-route="' + escapeHtml(name) + '">' +
    '<div class="route-card-head">' +
      '<div class="route-card-name">' + icon + escapeHtml(name) + '</div>' +
      '<span class="' + badgeClass + '">' + escapeHtml(badgeText) + '</span>' +
    '</div>' +
    '<div class="route-meta">' +
      '<span>' + stores.length + ' ' + plural(stores.length, 'магазин', 'магазина', 'магазинов') + '</span>' +
      '<span class="sep"></span>' +
      '<span>' + escapeHtml(metaRight) + '</span>' +
    '</div>' +
    '<div class="route-progress"><i style="width:' + progress + '%"></i></div>' +
    lastVisitLine +
    '<div class="route-foot">' +
      '<span>' + escapeHtml(footLeft) + '</span>' +
      '<span class="route-foot-right">Открыть <svg class="icon"><use href="#i-chevron"/></svg></span>' +
    '</div>' +
  '</button>';
}

function renderRoutesList() {
  const list = $('#routes-list');
  if (!list) return;

  let html = '';
  let totalDue = 0;

  for (const city of cityList()) {
    if (!city) continue;
    const name = city.id === DEFAULT_CITY ? ORYOL_ROUTE : city.name;
    const stores = storesForRoute(name);
    html += routeCardHtml(name, stores, storeStatusCounts(stores));
  }

  for (const name of ROUTE_NAMES) {
    if (name === ORYOL_ROUTE) continue;
    const summary = routeVisitedSummary(name);
    totalDue += summary.counts.due;
    html += routeCardHtml(name, summary.stores, summary.counts);
  }

  list.innerHTML = html;

  const sub = $('#routes-sub');
  if (sub) {
    const cities = cityList().map(city => city.name).filter(Boolean).join(', ');
    sub.textContent = totalDue
      ? totalDue + ' ' + plural(totalDue, 'магазин ждёт', 'магазина ждут', 'магазинов ждут') + ' визита в дальних маршрутах. ' + cities + ' - все магазины на карте.'
      : cities + ' - все магазины на карте, дальние маршруты в норме.';
  }
  updateCityUi();
}

function brandMiniHtml(brand) {
  return '<i class="brand-mini brand-' + escapeHtml(brand) + '">' + escapeHtml(brandLetter(brand)) + '</i>';
}

function routeStoreStatusText(store, status) {
  if (status.due) {
    if (!status.at) return 'Ещё не посещён';
    if (status.daysAgo >= status.period) {
      const over = status.daysAgo - status.period;
      return over > 0 ? 'Просрочено на ' + over + ' ' + daysWord(over) : 'Пора · срок истёк';
    }
    return 'Пора посетить';
  }
  return 'Осталось ' + status.daysLeft + ' ' + daysWord(status.daysLeft);
}

function renderRouteDetail(name) {
  if (!isKnownRoute(name)) { go('routes'); return; }

  const routeCity = cityByRouteName(name);
  const isMain = !!routeCity;
  const stores = storesForRoute(name).slice();
  const counts = storeStatusCounts(stores);
  const titleEl = $('#route-title');
  const subEl = $('#route-sub');
  const overviewEl = $('#route-overview');
  const listEl = $('#route-store-list');
  if (!overviewEl || !listEl) return;

  const routeAdd = $('#route-add');
  if (routeAdd) routeAdd.classList.toggle('hidden', isMain);

  const query = isMain ? oryolSearchQuery.trim() : '';
  const matched = query ? rankStores(stores, query) : stores;
  const searchEl = $('#oryol-search');
  const searchInput = $('#oryol-search-input');
  const searchClear = $('#oryol-search-clear');
  const searchHint = $('#oryol-search-hint');
  if (searchEl) searchEl.classList.toggle('hidden', !isMain || !stores.length);
  if (searchInput) {
    const nextValue = isMain ? oryolSearchQuery : '';
    if (document.activeElement !== searchInput || searchInput.value !== nextValue) {
      searchInput.value = nextValue;
    }
    if (isMain && routeCity) {
      searchInput.placeholder = 'Найти адрес или магазин · ' + routeCity.name;
      searchInput.setAttribute('aria-label', 'Поиск магазина по адресу в городе ' + routeCity.name);
    }
  }
  if (searchClear) searchClear.classList.toggle('hidden', !query);
  if (searchHint) {
    searchHint.classList.toggle('hidden', !query);
    if (query) {
      searchHint.textContent = matched.length
        ? 'Найдено ' + matched.length + ' ' + plural(matched.length, 'магазин', 'магазина', 'магазинов')
        : 'Ничего не найдено. Проверьте улицу, дом, название или наше название.';
    }
  }

  if (titleEl) titleEl.textContent = name;
  if (subEl) {
    if (isMain) {
      subEl.textContent = stores.length
        ? stores.length + ' ' + plural(stores.length, 'магазин', 'магазина', 'магазинов') + ' · все точки на карте'
        : 'На карте пока нет магазинов';
    } else {
      subEl.textContent = stores.length
        ? stores.length + ' ' + plural(stores.length, 'магазин', 'магазина', 'магазинов') + ' · срок ' + storePeriod(stores[0]) + ' дн.'
        : 'Пока нет магазинов';
    }
  }

  const actionHtml = isMain
    ? '<button class="overview-action" type="button" data-action="show-map"' +
        (routeCity ? ' data-route-city="' + escapeHtml(routeCity.id) + '"' : '') + '>На карту</button>'
    : '<button class="overview-action" type="button" data-action="mark-route" data-route="' + escapeHtml(name) + '"' +
        (counts.due ? '' : ' disabled') + '>Отметить всё</button>';

  overviewEl.innerHTML =
    '<div class="overview-stat due"><b>' + counts.due + '</b><span>пора посетить</span></div>' +
    '<div class="overview-divider"></div>' +
    '<div class="overview-stat ok"><b>' + counts.ok + '</b><span>в норме</span></div>' +
    actionHtml;

  if (!stores.length) {
    if (isMain) {
      listEl.innerHTML =
        '<div class="empty-state">' +
          '<svg class="icon"><use href="#i-map"/></svg>' +
          '<div><b>На карте пока нет магазинов.</b><br>Добавьте точку на карте - она сразу появится в этом списке.</div>' +
          '<button class="mini-primary" type="button" data-action="show-map"' +
            (routeCity ? ' data-route-city="' + escapeHtml(routeCity.id) + '"' : '') + '>Перейти к карте</button>' +
        '</div>';
    } else {
      listEl.innerHTML =
        '<div class="empty-state">' +
          '<svg class="icon"><use href="#i-store"/></svg>' +
          '<div><b>Маршрут пуст.</b><br>В открытых данных здесь нет Магнита или Пятёрочки - добавьте магазины вручную.</div>' +
          '<button class="mini-primary" type="button" data-action="add-route-store" data-route="' + escapeHtml(name) + '">Добавить магазин</button>' +
        '</div>';
    }
    return;
  }

  const due = [];
  const ok = [];
  matched.sort((a, b) => a.name.localeCompare(b.name, 'ru') || (a.address || '').localeCompare(b.address || '', 'ru'));
  if (query && !matched.length) {
    listEl.innerHTML = '<div class="search-empty">Ничего не найдено · ' + escapeHtml(routeCity ? routeCity.name : currentCityName()) + '. Проверьте улицу, дом, название магазина или наше название.</div>';
    return;
  }
  for (const store of matched) {
    const status = getStatus(store);
    (status.due ? due : ok).push({ store, status });
  }

  const renderGroup = (label, cls, items) => {
    if (!items.length) return '';
    let group = '<div class="store-group">' +
      '<div class="store-group-title ' + cls + '">' + label + ' <b>' + items.length + '</b></div>';

    for (const { store, status } of items) {
      const address = store.address
        ? '<span class="route-store-addr">' + escapeHtml(store.address) + '</span>'
        : '<span class="route-store-addr empty">Адрес не указан</span>';
      const comment = commentFor(store.id);
      const flatComment = comment ? comment.replace(/\s+/g, ' ').trim() : '';
      const commentLine = flatComment
        ? '<span class="route-store-comment">' +
            escapeHtml(flatComment.length > 90 ? flatComment.slice(0, 90).trimEnd() + '…' : flatComment) +
            ' - ' + escapeHtml(commentAuthor(store.id) || 'автор не указан') +
          '</span>'
        : '';
      const visitAuthorLine = status.at
        ? '<span class="route-store-author">Последний визит: ' + formatDate(status.at) + ' · ' +
            escapeHtml(visitAuthor(store.id) || 'автор не указан') + '</span>'
        : '';
      group += '<div class="route-store" data-action="open-store" data-id="' + escapeHtml(store.id) + '" role="button" tabindex="0">' +
        '<span class="status-dot ' + (status.due ? 'due' : 'ok') + '">' + brandMiniHtml(store.brand) + '</span>' +
        '<div class="route-store-main">' +
          '<span class="route-store-name">' + escapeHtml(store.name) + '</span>' +
          address +
          commentLine +
          '<span class="route-store-status ' + (status.due ? 'due' : 'ok') + '">' +
            escapeHtml(routeStoreStatusText(store, status)) +
            (store.period ? ' · свой срок ' + store.period + ' дн.' : '') +
          '</span>' +
          visitAuthorLine +
        '</div>' +
        '<button class="visit-btn ' + (status.due ? 'due' : 'ok') + '" type="button" data-action="toggle-visit" data-id="' + escapeHtml(store.id) + '"' +
          ' aria-label="' + (status.due ? 'Отметить визит' : 'Снять отметку визита') + '" title="' + (status.due ? 'Отметить визит' : 'Снять отметку') + '">' +
          '<svg class="icon"><use href="#' + (status.due ? 'i-check' : 'i-undo') + '"/></svg>' +
        '</button>' +
      '</div>';
    }

    group += '</div>';
    return group;
  };

  let html = '';
  html += renderGroup('Пора посетить', 'due', due);
  html += renderGroup('В норме', 'ok', ok);
  listEl.innerHTML = html;
}

/* --------------------------- Настройки --------------------------- */

function renderSettings() {
  const profileInput = $('#profile-name-input');
  if (profileInput && document.activeElement !== profileInput) {
    profileInput.value = uiPrefs.profile.name || '';
  }
  const profileHint = $('#profile-hint');
  if (profileHint) {
    profileHint.textContent = uiPrefs.profile.name
      ? 'Сейчас: ' + uiPrefs.profile.name + '. Имя можно изменить в любой момент - ваши подписи обновятся.'
      : 'Имя пока не выбрано. Визиты и комментарии будут без подписи, пока вы его не укажете.';
  }

  const period = clampPeriod(state.settings.periodDays);
  const input = $('#period-input');
  const current = $('#period-current');
  if (input && document.activeElement !== input) input.value = String(period);
  if (current) current.textContent = String(period);

  const basemap = ['local', 'light'].includes(state.settings.basemap)
    ? state.settings.basemap
    : 'local';
  $$('.basemap-btn').forEach(btn => {
    const active = btn.dataset.basemap === basemap;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  });

  const hiddenCount = Object.keys(state.hidden).filter(id => isHidden(id)).length;
  const hiddenCountEl = $('#hidden-count');
  if (hiddenCountEl) hiddenCountEl.textContent = String(hiddenCount);
  const restoreBtn = $('#btn-restore-hidden');
  if (restoreBtn) restoreBtn.classList.toggle('hidden', hiddenCount === 0);

  const stats = $('#data-stats');
  if (stats) {
    const mapCount = mapStores().length;
    const routeCount = routeStores().length;
    const currentStores = cityStores();
    const visited = currentStores.filter(s => visitTime(s.id)).length;
    const due = currentStores.filter(s => getStatus(s).due).length;
    const comments = Object.keys(state.comments).filter(id => commentFor(id)).length;
    stats.innerHTML =
      '<span>Всего: <b>' + currentStores.length + '</b></span>' +
      '<span>На карте: <b>' + mapCount + '</b></span>' +
      '<span>В маршрутах: <b>' + routeCount + '</b></span>' +
      '<span>Посещено: <b>' + visited + '</b></span>' +
      '<span>Пора: <b>' + due + '</b></span>' +
      (comments ? '<span>С комментарием: <b>' + comments + '</b></span>' : '') +
      (hiddenCount ? '<span>Скрыто: <b>' + hiddenCount + '</b></span>' : '');
  }

  updateShareUi();
  updateSyncUi();
}

function setSyncStatus(kind, title, subtitle) {
  const statusEl = $('#sync-status');
  const textEl = $('#sync-text');
  if (statusEl) {
    statusEl.classList.remove('online', 'syncing', 'error', 'local', 'offline');
    if (kind) statusEl.classList.add(kind);
  }
  if (textEl) textEl.textContent = title || '';
  if (kind === 'online' || kind === 'syncing') {
    textEl && textEl.setAttribute('title', subtitle || title || '');
  }

  const dotEl = $('#settings-sync-dot');
  if (dotEl) {
    dotEl.classList.remove('online', 'syncing', 'error', 'local', 'offline');
    if (kind) dotEl.classList.add(kind);
  }
  const settingsText = $('#settings-sync-text');
  const settingsSub = $('#settings-sync-sub');
  if (settingsText) settingsText.textContent = title || '';
  if (settingsSub) settingsSub.textContent = subtitle || '';
}

function updateSyncUi() {
  if (cloud.online) {
    setSyncStatus('online', 'Синхронизировано', 'Облако группы доступно');
  } else if (cloud.failed) {
    setSyncStatus('local', 'Только на телефоне', 'Нет связи с облаком - данные сохранены локально');
  } else if (!cloud.db) {
    setSyncStatus('syncing', 'Подключение…', 'Проверяем облако группы');
  } else {
    setSyncStatus('offline', 'Нет связи', 'Ждём подключения к интернету');
  }
}

function refreshCountsAndRoutes() {
  renderCounts();
  if (currentScreen === 'routes') renderRoutesList();
  if (currentScreen === 'route' && currentRoute) renderRouteDetail(currentRoute);
}

/* --------------------------- Карточка магазина --------------------------- */

function renderStoreSheet() {
  const body = $('#store-sheet-body');
  if (!body) return;
  const store = sheetStoreId ? getStore(sheetStoreId) : null;
  if (!store) {
    body.innerHTML = '<div class="sheet-body"><p class="muted">Точка не найдена.</p></div>';
    return;
  }

  const status = getStatus(store);
  const brand = store.brand;
  const brandClass = brand === 'magnit' || brand === 'pyaterochka' ? brand : 'other';
  const routeLabel = store.route ? 'Маршрут «' + escapeHtml(store.route) + '»' : 'На карте';
  const address = store.address
    ? escapeHtml(store.address)
    : 'Адрес не указан - нажмите, чтобы заполнить';
  const comment = commentFor(store.id);
  const commentBy = commentMetaHtml(store.id);

  const progress = status.at ? Math.round(status.progress * 100) : 0;
  let timerSub = status.at
    ? 'Последний визит: ' + formatDate(status.at) + ' · ' + status.sub
    : 'Отметьте визит, когда приедете в магазин.';
  const visitByLine = status.at
    ? '<div class="timer-author">Последний посетитель: <b>' +
        escapeHtml(visitAuthor(store.id) || 'автор не указан') + '</b></div>'
    : '';

  let visitButton;
  if (status.due) {
    visitButton = '<button class="btn primary wide" type="button" data-action="toggle-visit" data-id="' + escapeHtml(store.id) + '" data-mark="1">' +
      '<svg class="icon"><use href="#i-check"/></svg> Отметить визит</button>';
  } else {
    visitButton = '<button class="btn wide" type="button" data-action="toggle-visit" data-id="' + escapeHtml(store.id) + '" data-mark="0">' +
      '<svg class="icon"><use href="#i-undo"/></svg> Снять отметку визита</button>';
  }

  let yandex = '';
  if (store.lat != null && store.lon != null) {
    yandex = '<a class="yandex-link" href="https://yandex.ru/maps/?pt=' + store.lon + ',' + store.lat +
      '&amp;z=17&amp;l=map" target="_blank" rel="noopener">Открыть в Яндекс.Картах' +
      ' <svg class="icon"><use href="#i-external"/></svg></a>';
  }

  body.innerHTML =
    '<div class="store-sheet-head">' +
      '<div class="brand-badge brand-' + brandClass + '">' + escapeHtml(brandLetter(brand)) + '</div>' +
      '<div class="store-head-text">' +
        '<h2 id="store-sheet-title">' + escapeHtml(store.name) + '</h2>' +
        '<div class="store-head-brand">' + escapeHtml(brandTitle(brand)) + ' · ' + routeLabel + '</div>' +
      '</div>' +
      '<span class="status-pill ' + (status.due ? 'due' : 'ok') + '">' + (status.due ? 'Пора' : 'В норме') + '</span>' +
    '</div>' +
    '<div class="sheet-body">' +
      '<label class="alias-row">' +
        '<span class="alias-label">Наше название</span>' +
        '<input id="store-alias" class="alias-input" type="text" maxlength="' + ALIAS_MAX +
          '" value="' + escapeHtml(store.alias) + '" placeholder="Например, «у дома»" autocomplete="off"' +
          ' spellcheck="false" aria-label="Наше название магазина">' +
      '</label>' +
      '<button class="address-btn" type="button" data-action="edit-address" data-id="' + escapeHtml(store.id) + '">' +
        '<svg class="icon"><use href="#i-map"/></svg>' +
        '<span class="address-text' + (store.address ? '' : ' empty') + '">' + address + '</span>' +
        '<span class="address-edit">Изменить</span>' +
      '</button>' +
      '<div class="timer-card ' + (status.due ? 'due' : 'ok') + '">' +
        '<div class="timer-top">' +
          '<span class="timer-status ' + (status.due ? 'due' : 'ok') + '">' + escapeHtml(status.label) + '</span>' +
          '<span class="timer-period">' + (store.period ? 'Свой срок' : 'Срок') + ' ' + status.period + ' дн.</span>' +
        '</div>' +
        '<div class="timer-bar"><i style="width:' + progress + '%"></i></div>' +
        '<div class="timer-sub">' + escapeHtml(timerSub) + '</div>' +
        visitByLine +
      '</div>' +
      '<div class="comment-card">' +
        '<div class="comment-head">' +
          '<svg class="icon"><use href="#i-pencil"/></svg>' +
          '<span class="comment-title">Комментарий</span>' +
          (comment
            ? '<button class="comment-clear" type="button" data-action="clear-comment" data-id="' + escapeHtml(store.id) + '">Очистить</button>'
            : '') +
        '</div>' +
        (commentBy ? '<div id="store-comment-meta" class="comment-meta">' + commentBy + '</div>' : '<div id="store-comment-meta" class="comment-meta"></div>') +
        '<textarea id="store-comment" class="comment-input" rows="3" maxlength="' + COMMENT_MAX +
          '" placeholder="Заметка о точке или посещении">' + escapeHtml(comment) + '</textarea>' +
        '<div class="comment-hint">Сохраняется автоматически и остаётся, пока вы его не измените или не очистите.</div>' +
      '</div>' +
      '<div class="sheet-actions">' +
        visitButton +
        '<button class="btn" type="button" data-action="edit-store" data-id="' + escapeHtml(store.id) + '">' +
          '<svg class="icon"><use href="#i-pencil"/></svg> Изменить</button>' +
        '<button class="btn danger" type="button" data-action="delete-store" data-id="' + escapeHtml(store.id) + '">' +
          '<svg class="icon"><use href="#i-trash"/></svg> Удалить</button>' +
      '</div>' +
      yandex +
    '</div>';
}

function openStoreSheet(id) {
  const store = getStore(id);
  if (!store) return;
  flushCommentSave();
  flushAliasSave();
  sheetStoreId = id;
  renderStoreSheet();
  openSheetEl($('#store-sheet'));
}

/* --------------------------- Управление шторками --------------------------- */

let openedSheetEl = null;

function openSheetEl(el) {
  if (!el) return;
  if (openedSheetEl && openedSheetEl !== el) {
    openedSheetEl.classList.remove('open');
  }
  openedSheetEl = el;
  const backdrop = $('#sheet-backdrop');
  if (backdrop) backdrop.classList.remove('hidden');
  el.classList.remove('hidden');
  requestAnimationFrame(() => {
    el.classList.add('open');
    if (backdrop) backdrop.classList.add('show');
  });
}

function closeSheets() {
  flushCommentSave();
  flushAliasSave();
  const backdrop = $('#sheet-backdrop');
  const el = openedSheetEl;
  openedSheetEl = null;
  sheetStoreId = null;
  if (el && el.id === 'form-sheet') formState = null;
  highlightMarker(null);

  if (el) {
    el.classList.remove('open');
    setTimeout(() => {
      if (!el.classList.contains('open')) el.classList.add('hidden');
    }, 280);
  }
  if (backdrop) {
    backdrop.classList.remove('show');
    setTimeout(() => backdrop.classList.add('hidden'), 240);
  }
}

/* --------------------------- Форма точки --------------------------- */

function openStoreForm(id, coords, route, options) {
  const opts = options || {};
  const store = id ? getStore(id) : null;
  const form = $('#store-form');
  if (form) form.reset();

  const lat = store && store.lat != null ? store.lat : (coords && coords.lat != null ? Number(coords.lat) : null);
  const lon = store && store.lon != null ? store.lon : (coords && coords.lon != null ? Number(coords.lon) : null);
  const targetRoute = store ? store.route : (route || null);

  formState = {
    id: store ? store.id : null,
    route: targetRoute,
    brand: store ? store.brand : 'magnit',
    lat: isValidCoord(lat, lon) ? lat : null,
    lon: isValidCoord(lat, lon) ? lon : null,
    focusAddress: !!opts.focusAddress
  };

  const title = $('#form-title');
  const sub = $('#form-sub');
  if (title) title.textContent = store ? 'Редактировать точку' : (targetRoute ? 'Новый магазин маршрута' : 'Новая точка на карте');
  if (sub) {
    sub.textContent = targetRoute
      ? 'Маршрут «' + targetRoute + '» - без карты'
      : (formState.lat != null ? 'Координаты: ' + formState.lat.toFixed(5) + ', ' + formState.lon.toFixed(5) : 'Точка на карте');
  }

  const nameInput = $('#f-name');
  if (nameInput) {
    nameInput.value = store ? store.name : '';
    nameInput.placeholder = brandTitle(formState.brand);
  }

  const addressInput = $('#f-address');
  if (addressInput) addressInput.value = store ? store.address : '';

  const aliasInput = $('#f-alias');
  if (aliasInput) aliasInput.value = store ? store.alias : '';

  const periodInput = $('#f-period');
  if (periodInput) periodInput.value = store && store.period ? String(store.period) : '';
  const periodHint = $('#f-period-hint');
  if (periodHint) periodHint.textContent = 'Пусто - общий срок ' + clampPeriod(state.settings.periodDays) + ' дней.';

  const addressHint = $('#f-address-hint');
  if (addressHint) addressHint.textContent = 'Можно оставить пустым и заполнить позже. Кнопка «Найти» определит адрес по координатам.';

  selectFormBrand(formState.brand);

  const coordsRow = $('#f-coords-row');
  const coordsText = $('#f-coords');
  if (coordsRow) {
    const showCoords = formState.lat != null && formState.lon != null;
    coordsRow.classList.toggle('hidden', !showCoords);
    if (coordsText && showCoords) {
      coordsText.textContent = formState.lat.toFixed(5) + ', ' + formState.lon.toFixed(5);
    }
  }

  const error = $('#form-error');
  if (error) {
    error.textContent = '';
    error.classList.add('hidden');
  }

  openSheetEl($('#form-sheet'));

  if (formState.focusAddress && addressInput) {
    setTimeout(() => {
      try {
        addressInput.focus({ preventScroll: true });
        addressInput.scrollIntoView({ block: 'center', behavior: 'smooth' });
      } catch (e) { /* ignore */ }
    }, 320);
  }
}

function selectFormBrand(brand) {
  if (!formState) return;
  formState.brand = ['magnit', 'pyaterochka', 'other'].includes(brand) ? brand : 'other';
  $$('#f-brand button').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.brand === formState.brand);
  });
  const nameInput = $('#f-name');
  if (nameInput) nameInput.placeholder = brandTitle(formState.brand);
}

function showFormError(message) {
  const error = $('#form-error');
  if (!error) return;
  error.textContent = message;
  error.classList.remove('hidden');
}

function saveStoreForm(event) {
  if (event) event.preventDefault();
  if (!formState) return;

  const nameInput = $('#f-name');
  const aliasInput = $('#f-alias');
  const addressInput = $('#f-address');
  const periodInput = $('#f-period');

  const brand = formState.brand || 'magnit';
  const name = (nameInput && nameInput.value.trim()) || brandTitle(brand);
  const alias = normalizeAlias(aliasInput ? aliasInput.value : '');
  const address = addressInput ? addressInput.value.trim() : '';

  let period = null;
  if (periodInput && periodInput.value.trim() !== '') {
    const p = Number(periodInput.value);
    if (!Number.isFinite(p) || p < PERIOD_MIN || p > PERIOD_MAX) {
      showFormError('Срок должен быть от ' + PERIOD_MIN + ' до ' + PERIOD_MAX + ' дней.');
      return;
    }
    period = Math.round(p);
  }

  if (!formState.id && !formState.route && !isValidCoord(formState.lat, formState.lon)) {
    showFormError('Не указаны координаты точки.');
    return;
  }

  const now = Date.now();
  let savedId = formState.id;

  if (formState.id) {
    const prev = state.overrides[formState.id] || {};
    const next = Object.assign({}, prev, {
      name,
      alias,
      brand,
      address,
      period,
      upd: now
    });
    if (!formState.route && isValidCoord(formState.lat, formState.lon)) {
      next.lat = Number(formState.lat.toFixed(7));
      next.lon = Number(formState.lon.toFixed(7));
    }
    state.overrides[formState.id] = next;
  } else {
    savedId = makeId(formState.route ? 'rp_u' : 'pt_u');
    const isRoute = !!formState.route;
    const cityId = isRoute ? DEFAULT_CITY : currentCityId();
    state.custom[savedId] = {
      id: savedId,
      name,
      alias,
      brand,
      address,
      lat: isRoute ? null : Number(formState.lat.toFixed(7)),
      lon: isRoute ? null : Number(formState.lon.toFixed(7)),
      route: isRoute ? formState.route : null,
      city: cityId,
      osm: '',
      source: isRoute ? 'user' : 'map',
      upd: now
    };
    if (period) state.custom[savedId].period = period;
  }

  const wasNew = !formState.id;
  const newRoute = formState.route;

  formState = null;
  closeSheets();
  commit({ structure: true });

  if (wasNew && !newRoute && map && savedId) {
    const store = getStore(savedId);
    if (store && store.lat != null) {
      map.setView([store.lat, store.lon], Math.max(map.getZoom(), 16));
      highlightMarker(savedId);
    }
  }

  showSnackbar(wasNew ? 'Точка добавлена' : 'Точка обновлена');
}

/* --------------------------- Действия --------------------------- */

function toggleStoreVisit(id, explicitMark) {
  const store = getStore(id);
  if (!store) return;
  const mark = explicitMark == null ? getStatus(store).due : !!explicitMark;
  setStoreVisited(id, mark);
  const tourFinished = mark && uiPrefs.tour && !tourStats().activeId;
  showSnackbar(
    tourFinished ? 'Объезд завершён · все точки в норме' : (mark ? 'Визит отмечен' : 'Отметка визита снята'),
    mark ? 'Отменить' : 'Вернуть',
    () => {
      setStoreVisited(id, !mark);
    }
  );
}

async function deleteStoreById(id) {
  const store = getStore(id);
  if (!store) return;
  const ok = await confirmDialog(
    'Удалить точку?',
    '«' + store.name + '»' + (store.address ? ' (' + store.address + ')' : '') +
      ' исчезнет с карты и из маршрутов. Вернуть её можно в настройках: «Данные» → «Восстановить удалённые точки».',
    'Удалить точку',
    true
  );
  if (!ok) return;
  const now = Date.now();
  state.hidden[id] = now;
  closeSheets();
  commit({ structure: true });
  showSnackbar('Точка удалена', 'Вернуть', () => {
    state.hidden[id] = 0;
    commit({ structure: true });
  });
}

async function markWholeRoute(route) {
  if (!ROUTE_NAMES.includes(route)) return;
  const stores = storesForRoute(route).filter(store => getStatus(store).due);
  if (!stores.length) {
    showSnackbar('В этом маршруте нечего отмечать');
    return;
  }
  const ok = await confirmDialog(
    'Отметить весь маршрут?',
    'Отметить визит в ' + stores.length + ' ' + plural(stores.length, 'магазине', 'магазинах', 'магазинах') +
      ' маршрута «' + route + '»? Отметки можно снять по одной.',
    'Отметить',
    false
  );
  if (!ok) return;
  const now = Date.now();
  const author = currentAuthor();
  for (const store of stores) {
    const rec = { at: now, upd: now };
    if (author) rec.by = author;
    state.visits[store.id] = rec;
  }
  commit();
  showSnackbar('Маршрут «' + route + '» отмечен');
}

async function restoreHiddenStores() {
  const ids = Object.keys(state.hidden).filter(id => isHidden(id));
  if (!ids.length) return;
  const ok = await passwordDialog(
    'Восстановить точки?',
    'Вернуть ' + ids.length + ' ' + plural(ids.length, 'удалённую точку', 'удалённые точки', 'удалённых точек') +
      ' на карту и в маршруты? Введите пароль, чтобы подтвердить.',
    'Восстановить',
    false
  );
  if (!ok) return;
  for (const id of ids) state.hidden[id] = 0;
  commit({ structure: true });
  showSnackbar('Точки восстановлены');
}

async function resetAllVisits() {
  const ok = await passwordDialog(
    'Сбросить все отметки?',
    'Все магазины снова станут зелёными, история визитов будет удалена. Это действие не отменить. Введите пароль, чтобы подтвердить.',
    'Сбросить',
    true
  );
  if (!ok) return;
  /* Не удаляем ключи: синхронизация передаёт удаление как { at: null }.
     Иначе облако вернуло бы старые отметки при следующей синхронизации. */
  const now = Date.now();
  for (const [id, rec] of Object.entries(state.visits)) {
    if (rec && rec.at) state.visits[id] = { at: null, upd: now };
  }
  commit();
  showSnackbar('Все отметки посещений сброшены');
}

function changePeriod(value, silent) {
  const next = clampPeriod(value);
  if (next === clampPeriod(state.settings.periodDays)) {
    const input = $('#period-input');
    if (input && document.activeElement !== input) input.value = String(next);
    return;
  }
  state.settings.periodDays = next;
  state.settings.upd = Date.now();
  commit();
  const input = $('#period-input');
  if (input && document.activeElement !== input) input.value = String(next);
  if (!silent) showSnackbar('Общий срок: ' + next + ' ' + daysWord(next));
}

function setBasemap(mode, silent) {
  const next = ['local', 'light'].includes(mode) ? mode : 'local';
  if (next === state.settings.basemap) {
    applyBasemap();
    renderSettings();
    return;
  }
  state.settings.basemap = next;
  state.settings.lightMap = next === 'light';
  state.settings.upd = Date.now();
  saveLocal();
  applyBasemap();
  renderSettings();
  localDirty = true;
  schedulePush();

  if (!silent) {
    const labels = { local: 'Локальная схема', light: 'Светлая карта' };
    showSnackbar('Подложка: ' + labels[next]);
  }
}

/* --------------------------- Резервная копия --------------------------- */

function exportData() {
  const payload = {
    app: 'obezd',
    version: APP_VERSION,
    exportedAt: new Date().toISOString(),
    groupId: GROUP_ID,
    state
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const d = new Date();
  const stamp = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  a.href = url;
  a.download = 'obezd-backup-' + stamp + '.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  showSnackbar('Резервная копия скачана');
}

async function importDataFile(file) {
  if (!file) return;
  let parsed = null;
  try {
    const text = await file.text();
    parsed = safeJsonParse(text);
  } catch (e) {
    showSnackbar('Не удалось прочитать файл');
    return;
  }
  if (!parsed || typeof parsed !== 'object') {
    showSnackbar('Файл не похож на резервную копию');
    return;
  }

  const raw = parsed.state && typeof parsed.state === 'object' ? parsed.state : parsed;
  const imported = sanitizeState(raw);

  const ok = await confirmDialog(
    'Импорт данных?',
    'Текущие отметки, точки и настройки будут заменены данными из файла. Продолжить?',
    'Импортировать',
    true
  );
  if (!ok) return;

  state = imported;
  saveLocal(true);
  rebuildStoreCache();
  renderMapMarkers();
  renderCounts();
  renderRoutesList();
  if (currentScreen === 'route' && currentRoute) renderRouteDetail(currentRoute);
  if (currentScreen === 'settings') renderSettings();
  applyBasemap();
  localDirty = true;
  schedulePush();
  showSnackbar('Данные импортированы');
}

/* --------------------------- Геокодирование --------------------------- */

async function geocodeFormAddress() {
  if (!formState) return;
  const btn = $('#f-geocode');
  const hint = $('#f-address-hint');
  const input = $('#f-address');

  if (!isValidCoord(formState.lat, formState.lon)) {
    if (hint) hint.textContent = 'Сначала укажите точку на карте - тогда можно определить адрес.';
    return;
  }

  if (btn) btn.disabled = true;
  if (hint) hint.textContent = 'Ищем адрес по координатам…';

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const url = 'https://nominatim.openstreetmap.org/reverse?format=jsonv2&addressdetails=1&accept-language=ru&zoom=18&lat=' +
      encodeURIComponent(formState.lat) + '&lon=' + encodeURIComponent(formState.lon);
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' }
    });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const data = await response.json();
    const a = data.address || {};
    const street = a.road || a.pedestrian || a.footway || a.cycleway || a.square || a.place || '';
    const house = a.house_number || '';
    let address = '';
    if (street && house) address = street + ', ' + house;
    else if (street) address = street;
    else if (house) address = 'д. ' + house;
    else if (data.display_name) address = String(data.display_name).split(',').slice(0, 3).join(', ');
    if (!address) throw new Error('empty');

    if (input) input.value = address;
    if (hint) hint.textContent = 'Адрес найден по координатам. Проверьте и сохраните.';
    showSnackbar('Адрес найден');
  } catch (error) {
    if (hint) {
      hint.textContent = error && error.name === 'AbortError'
        ? 'Сервис не ответил. Введите адрес вручную.'
        : 'Не удалось определить адрес. Введите его вручную.';
    }
  } finally {
    clearTimeout(timeout);
    if (btn) btn.disabled = false;
  }
}

/* --------------------------- Импорт из OpenStreetMap --------------------------- */

function setImportStatus(kind, text) {
  const el = $('#import-status');
  if (!el) return;
  el.className = 'import-status' + (kind ? ' ' + kind : '');
  el.textContent = text || '';
}

function openImportSheet() {
  setImportStatus('', '');
  openSheetEl($('#import-sheet'));
}

function osmAddress(tags) {
  const street = String(tags['addr:street'] || tags['addr:place'] || '').trim();
  const house = String(tags['addr:housenumber'] || '').trim();
  if (street && house) return street + ', ' + house;
  if (street) return street;
  if (house) return 'д. ' + house;
  return String(tags['addr:full'] || '').trim();
}

function parseOsmElement(el, onlyChains) {
  if (!el || !el.type || el.id == null) return null;
  const tags = el.tags || {};
  const rawName = String(tags.name || tags.brand || tags.operator || '').trim();
  if (!rawName && !tags.brand) return null;
  if (tags.shop === 'cosmetics' || /косметик/i.test(rawName)) return null;

  const brand = normalizeBrand(tags.brand || tags.operator || '', rawName);
  if (onlyChains && brand === 'other') return null;
  if (!onlyChains && !tags.shop && brand === 'other') return null;

  const lat = toNumber(el.lat != null ? el.lat : (el.center && el.center.lat));
  const lon = toNumber(el.lon != null ? el.lon : (el.center && el.center.lon));
  if (!isValidCoord(lat, lon)) return null;

  return {
    id: el.type + '_' + el.id,
    name: rawName || brandTitle(brand),
    brand,
    address: osmAddress(tags),
    lat: Number(lat.toFixed(7)),
    lon: Number(lon.toFixed(7)),
    osm: el.type + '/' + el.id
  };
}

function isNearDuplicate(brand, lat, lon, extra) {
  const check = (store) => {
    if (!store || store.brand !== brand || store.lat == null || store.lon == null) return false;
    const dy = (store.lat - lat) * 111;
    const dx = (store.lon - lon) * 111 * Math.cos(lat * Math.PI / 180);
    return Math.hypot(dx, dy) < 0.045;
  };
  if (cityStores().some(check)) return true;
  if (Array.isArray(extra) && extra.some(check)) return true;
  return false;
}

async function importFromOsm(mode) {
  if (importBusy) return;
  if (!map) {
    setImportStatus('error', 'Карта ещё не готова. Подождите пару секунд и повторите.');
    return;
  }

  let bbox;
  if (mode === 'oryol') {
    const bounds = cityBoundsOf(currentCity);
    bbox = [bounds[0][0], bounds[0][1], bounds[1][0], bounds[1][1]];
  } else {
    const bounds = map.getBounds();
    bbox = [bounds.getSouth(), bounds.getWest(), bounds.getNorth(), bounds.getEast()];
  }

  const latSpan = bbox[2] - bbox[0];
  const lonSpan = bbox[3] - bbox[1];
  if (latSpan > 0.85 || lonSpan > 1.3) {
    setImportStatus('error', 'Область слишком большая. Приблизьте карту к городу или району и повторите.');
    return;
  }

  const onlyChains = !!($('#import-only-chains') && $('#import-only-chains').checked);
  const area = bbox.map(v => v.toFixed(5)).join(',');
  let query;
  if (onlyChains) {
    query = '[out:json][timeout:50];(' +
      'nwr["brand"~"Магнит|Пятёрочка|Пятерочка",i](' + area + ');' +
      'nwr["name"~"Магнит|Пятёрочка|Пятерочка",i](' + area + ');' +
      'nwr["operator"~"Магнит|Пятёрочка|Пятерочка",i](' + area + ');' +
      ');out center tags;';
  } else {
    query = '[out:json][timeout:50];(' +
      'nwr["shop"~"supermarket|convenience"](' + area + ');' +
      ');out center tags;';
  }

  importBusy = true;
  const visibleBtn = $('#import-visible');
  const oryolBtn = $('#import-oryol');
  if (visibleBtn) visibleBtn.disabled = true;
  if (oryolBtn) oryolBtn.disabled = true;
  setImportStatus('loading', 'Запрашиваем OpenStreetMap… Это может занять до минуты.');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);

  try {
    const response = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        Accept: 'application/json'
      },
      body: 'data=' + encodeURIComponent(query)
    });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const data = await response.json();
    const elements = Array.isArray(data.elements) ? data.elements : [];

    let added = 0;
    let skipped = 0;
    const batch = [];
    const now = Date.now();
    const cityId = currentCityId();

    for (const el of elements) {
      const parsed = parseOsmElement(el, onlyChains);
      if (!parsed) continue;
      if (knownStoreIds.has(parsed.id) || state.custom[parsed.id] || isHidden(parsed.id)) {
        skipped += 1;
        continue;
      }
      if (isNearDuplicate(parsed.brand, parsed.lat, parsed.lon, batch)) {
        skipped += 1;
        continue;
      }
      batch.push(parsed);
      state.custom[parsed.id] = {
        id: parsed.id,
        name: parsed.name,
        brand: parsed.brand,
        address: parsed.address,
        lat: parsed.lat,
        lon: parsed.lon,
        route: null,
        city: cityId,
        osm: parsed.osm,
        source: 'osm',
        upd: now + added
      };
      added += 1;
    }

    if (added) {
      commit({ structure: true });
      setImportStatus('ok', 'Добавлено точек: ' + added + '.' + (skipped ? ' Пропущено уже известных или дублей: ' + skipped + '.' : ''));
      showSnackbar('Загружено точек: ' + added);
    } else {
      setImportStatus('', 'Новых точек не найдено.' + (skipped ? ' Пропущено уже известных: ' + skipped + '.' : ' Попробуйте приблизить карту.'));
    }
  } catch (error) {
    const message = error && error.name === 'AbortError'
      ? 'Сервис OpenStreetMap не ответил. Повторите позже.'
      : 'Не удалось загрузить данные. Проверьте интернет и повторите.';
    setImportStatus('error', message);
  } finally {
    clearTimeout(timeout);
    importBusy = false;
    if (visibleBtn) visibleBtn.disabled = false;
    if (oryolBtn) oryolBtn.disabled = false;
  }
}

/* --------------------------- Синхронизация группы --------------------------- */

function clone(value) {
  try { return JSON.parse(JSON.stringify(value)); } catch (e) { return value; }
}

function mergeRecordMaps(target, incoming) {
  let changed = false;
  for (const [id, rec] of Object.entries(incoming || {})) {
    if (!rec) continue;
    const current = target[id];
    if (!current || (toNumber(rec.upd) || 0) > (toNumber(current.upd) || 0)) {
      target[id] = rec;
      changed = true;
    }
  }
  return changed;
}

function mergeHidden(target, incoming) {
  let changed = false;
  for (const [id, ver] of Object.entries(incoming || {})) {
    const value = toNumber(ver);
    if (value == null) continue;
    const current = toNumber(target[id]);
    if (current == null || value > current) {
      target[id] = value;
      changed = true;
    }
  }
  return changed;
}

function applyLegacyRoutes() {
  if (!seedsLoaded) return false;
  let changed = false;
  for (const [name, value] of Object.entries(legacyRoutes || {})) {
    if (!ROUTE_NAMES.includes(name) || !value || typeof value !== 'object') continue;
    const at = toNumber(value.visitedAt != null ? value.visitedAt : value.at);
    if (!at || at <= 0) continue;
    const key = name + '|' + at;
    if (legacyApplied.has(key)) continue;
    legacyApplied.add(key);
    for (const store of storesForRoute(name)) {
      const current = visitTime(store.id);
      if (!current || current < at) {
        state.visits[store.id] = { at, upd: Date.now() };
        changed = true;
      }
    }
  }
  legacyRoutes = {};
  return changed;
}

function applyCloud(data) {
  const src = data && typeof data === 'object' ? data : {};
  const cloudVer = toNumber(src.updatedAt) || 0;
  let changed = false;

  const visitSources = [];
  if (src.visits && typeof src.visits === 'object') visitSources.push(src.visits);
  if (src.visits2 && typeof src.visits2 === 'object') visitSources.push(src.visits2);
  for (const source of visitSources) {
    if (mergeRecordMaps(state.visits, sanitizeVisits(source))) changed = true;
  }

  if (src.hidden2 && typeof src.hidden2 === 'object') {
    if (mergeHidden(state.hidden, sanitizeVersionMap(src.hidden2))) changed = true;
  }
  if (Array.isArray(src.hidden)) {
    for (const id of src.hidden) {
      if (typeof id !== 'string' || !id) continue;
      if (!(id in state.hidden)) {
        state.hidden[id] = cloudVer || 1;
        changed = true;
      }
    }
  }

  if (src.custom2 && typeof src.custom2 === 'object') {
    if (mergeRecordMaps(state.custom, sanitizeCustom(src.custom2))) changed = true;
  }
  if (Array.isArray(src.custom)) {
    const legacyCustom = {};
    for (const item of src.custom) {
      if (!item || !item.id) continue;
      legacyCustom[item.id] = Object.assign({}, item, {
        address: item.address != null ? item.address : item.addr,
        upd: toNumber(item.upd) || cloudVer || 1
      });
    }
    if (mergeRecordMaps(state.custom, sanitizeCustom(legacyCustom))) changed = true;
  }

  if (src.overrides2 && typeof src.overrides2 === 'object') {
    if (mergeRecordMaps(state.overrides, sanitizeOverrides(src.overrides2))) changed = true;
  }
  if (src.comments2 && typeof src.comments2 === 'object') {
    if (mergeRecordMaps(state.comments, sanitizeComments(src.comments2))) changed = true;
  }
  if (src.authors2 && typeof src.authors2 === 'object') {
    if (mergeRecordMaps(state.authors, sanitizeAuthors(src.authors2))) changed = true;
  }
  if (src.addresses && typeof src.addresses === 'object') {
    for (const [id, address] of Object.entries(src.addresses)) {
      if (!id || typeof address !== 'string') continue;
      const current = state.overrides[id];
      const ver = cloudVer || 1;
      if (!current || ver > (toNumber(current.upd) || 0)) {
        state.overrides[id] = Object.assign({}, current, { address: address.slice(0, 200), upd: ver });
        changed = true;
      }
    }
  }

  if (src.settings2 && typeof src.settings2 === 'object') {
    const incoming = sanitizeSettings(src.settings2);
    if ((incoming.upd || 0) > (state.settings.upd || 0)) {
      state.settings = incoming;
      changed = true;
    }
  } else if (src.intervalDays != null) {
    const p = clampPeriod(src.intervalDays);
    if (!state.settings.upd && p !== state.settings.periodDays) {
      state.settings.periodDays = p;
      changed = true;
    }
  }

  if (src.routes && typeof src.routes === 'object') {
    legacyRoutes = src.routes;
  }

  return changed;
}

function afterCloudApply() {
  rebuildStoreCache();
  if (map) renderMapMarkers();
  renderCounts();
  if (currentScreen === 'routes') renderRoutesList();
  if (currentScreen === 'route' && currentRoute) renderRouteDetail(currentRoute);
  if (currentScreen === 'settings') renderSettings();
  if (sheetStoreId) {
    const active = document.activeElement;
    if (active && (active.id === 'store-comment' || active.id === 'store-alias') && getStore(sheetStoreId)) {
      /* Не перерисовываем карточку, пока пользователь печатает. */
    } else if (getStore(sheetStoreId)) {
      renderStoreSheet();
    } else {
      closeSheets();
    }
  }
  applyBasemap();
  renderTourUi();
}

function schedulePush() {
  if (!cloud.ready || !cloud.db || !cloud.ref) return;
  if (!localDirty) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => { pushState(); }, 900);
}

async function pushState() {
  if (!cloud.ready || !cloud.db || !cloud.ref || !cloud.fs) return;
  if (pushInFlight) { pushAgain = true; return; }
  pushInFlight = true;
  pushAgain = false;

  const now = Date.now();
  const updates = {};
  /* Снимок состояния на момент отправки: пока запрос летит, пользователь
     может успеть изменить данные. Эти изменения нельзя считать отправленными. */
  const snapshot = {
    visits: clone(state.visits),
    hidden: clone(state.hidden),
    custom: clone(state.custom),
    overrides: clone(state.overrides),
    comments: clone(state.comments),
    authors: clone(state.authors),
    settings: clone(state.settings)
  };
  const mapPrefixes = [
    ['visits2', snapshot.visits, cloud.pushed.visits],
    ['hidden2', snapshot.hidden, cloud.pushed.hidden],
    ['custom2', snapshot.custom, cloud.pushed.custom],
    ['overrides2', snapshot.overrides, cloud.pushed.overrides],
    ['comments2', snapshot.comments, cloud.pushed.comments],
    ['authors2', snapshot.authors, cloud.pushed.authors]
  ];

  for (const [prefix, records, previous] of mapPrefixes) {
    for (const [id, rec] of Object.entries(records)) {
      if (JSON.stringify(rec) !== JSON.stringify(previous[id])) {
        if (!updates[prefix] || typeof updates[prefix] !== 'object') updates[prefix] = {};
        updates[prefix][id] = rec;
      }
    }
  }

  const settingsJson = JSON.stringify(snapshot.settings);
  if (settingsJson !== JSON.stringify(cloud.pushed.settings)) {
    updates.settings2 = snapshot.settings;
  }

  setSyncStatus('syncing', 'Сохранение…', 'Отправляем изменения группе');

  try {
    /* Пишем только изменённые поля точечно. Полную карту отправлять нельзя:
       на новом устройстве локальное состояние ещё пустое и перезаписало бы
       визиты и комментарии, которые уже есть в облаке. */
    if (!cloud.hasPushed || Object.keys(updates).length) {
      updates.intervalDays = clampPeriod(snapshot.settings.periodDays);
      updates.updatedAt = now;
      await cloud.fs.setDoc(cloud.ref, updates, { merge: true });
      cloud.hasPushed = true;
    }

    cloud.pushed = snapshot;
    cloud.online = true;
    cloud.failed = false;
    const liveJson = JSON.stringify([
      state.visits, state.hidden, state.custom, state.overrides,
      state.comments, state.authors, state.settings
    ]);
    const sentJson = JSON.stringify([
      snapshot.visits, snapshot.hidden, snapshot.custom, snapshot.overrides,
      snapshot.comments, snapshot.authors, snapshot.settings
    ]);
    localDirty = liveJson !== sentJson;
    updateSyncUi();
  } catch (error) {
    console.warn('Не удалось сохранить в облако', error);
    cloud.online = false;
    cloud.failed = true;
    localDirty = true;
    updateSyncUi();
  } finally {
    pushInFlight = false;
    if (pushAgain) pushAgain = false;
    if (localDirty) schedulePush();
  }
}

async function initCloud(force) {
  if (cloud.db && !force) return;
  if (force) {
    try { if (cloud.unsub) cloud.unsub(); } catch (e) { /* ignore */ }
    try { if (presenceUnsub) presenceUnsub(); } catch (e) { /* ignore */ }
    cloud.unsub = null;
    presenceUnsub = null;
    presence = new Map();
    renderPresence();
    cloud.db = null;
    cloud.ref = null;
    cloud.ready = false;
    cloud.online = false;
    cloud.failed = false;
    cloud.hasPushed = false;
    cloud.pushed = { visits: {}, hidden: {}, custom: {}, overrides: {}, comments: {}, authors: {}, settings: null };
    localDirty = true;
  }

  setSyncStatus('syncing', 'Подключение…', 'Проверяем облако группы');

  let appMod;
  let fsMod;
  try {
    const modules = await Promise.all([import(FIREBASE_APP_URL), import(FIREBASE_FS_URL)]);
    appMod = modules[0];
    fsMod = modules[1];
  } catch (error) {
    console.warn('Firebase недоступен', error);
    cloud.failed = true;
    cloud.online = false;
    updateSyncUi();
    return;
  }

  try {
    let app;
    try {
      app = appMod.initializeApp(FIREBASE_CONFIG, 'obezd-sync');
    } catch (error) {
      app = appMod.getApp('obezd-sync');
    }
    const db = fsMod.getFirestore(app);
    const ref = fsMod.doc(db, 'groups', GROUP_ID);

    cloud.db = db;
    cloud.ref = ref;
    cloud.fs = fsMod;

    startPresenceListener();
    if (uiPrefs.shareLocation) maybeSendPresence(true);

    cloud.unsub = fsMod.onSnapshot(ref, (snapshot) => {
      const data = snapshot.data() || {};
      cloud.ready = true;
      cloud.online = true;
      cloud.failed = false;

      const changed = applyCloud(data);
      const legacyChanged = applyLegacyRoutes();

      if (changed) saveLocal();
      afterCloudApply();
      updateSyncUi();

      if (!cloud.hasPushed) localDirty = true;
      if (legacyChanged) {
        localDirty = true;
        saveLocal();
      }
      schedulePush();
    }, (error) => {
      console.warn('Ошибка синхронизации', error);
      cloud.ready = false;
      cloud.online = false;
      cloud.failed = true;
      updateSyncUi();
    });
  } catch (error) {
    console.warn('Не удалось подключить Firestore', error);
    cloud.ready = false;
    cloud.online = false;
    cloud.failed = true;
    updateSyncUi();
  }
}

async function syncNow() {
  if (!cloud.db || !cloud.ref || !cloud.fs) {
    initCloud(true);
    return;
  }
  if (!navigator.onLine) {
    cloud.online = false;
    setSyncStatus('offline', 'Нет интернета', 'Отметки сохраняются на телефоне');
    showSnackbar('Нет подключения к интернету');
    return;
  }

  setSyncStatus('syncing', 'Обновление…', 'Сверяем данные группы');
  try {
    const snapshot = await cloud.fs.getDoc(cloud.ref);
    const changed = applyCloud(snapshot.data() || {});
    const legacyChanged = applyLegacyRoutes();
    cloud.ready = true;
    cloud.online = true;
    cloud.failed = false;
    if (changed || legacyChanged) saveLocal();
    localDirty = true;
    afterCloudApply();
    updateSyncUi();
    await pushState();
    showSnackbar('Данные синхронизированы');
  } catch (error) {
    console.warn('Ошибка обновления', error);
    cloud.online = false;
    cloud.failed = true;
    updateSyncUi();
    showSnackbar('Не удалось связаться с облаком');
  }
}

/* --------------------------- События --------------------------- */

function handleAction(action, el) {
  const id = el && el.dataset ? el.dataset.id : '';
  const route = el && el.dataset ? el.dataset.route : '';
  const city = el && el.dataset ? el.dataset.city : '';

  switch (action) {
    case 'toggle-visit': {
      const markAttr = el.dataset.mark;
      toggleStoreVisit(id, markAttr == null ? null : markAttr === '1');
      break;
    }
    case 'edit-store':
      closeSheets();
      if (id) openStoreForm(id, null, null);
      break;
    case 'edit-address':
      closeSheets();
      if (id) openStoreForm(id, null, null, { focusAddress: true });
      break;
    case 'delete-store':
      if (id) deleteStoreById(id);
      break;
    case 'clear-comment': {
      if (id) {
        flushCommentSave();
        saveComment(id, '');
        const input = $('#store-comment');
        if (input) input.value = '';
        renderStoreSheet();
        refreshCommentViews();
        showSnackbar('Комментарий удалён');
      }
      break;
    }
    case 'open-store':
      if (id) openStoreSheet(id);
      break;
    case 'mark-route':
      if (route) markWholeRoute(route);
      break;
    case 'add-route-store': {
      const targetRoute = route || currentRoute;
      if (targetRoute && targetRoute !== ORYOL_ROUTE) openStoreForm(null, null, targetRoute);
      break;
    }
    case 'show-map': {
      const routeCity = cityByRouteName(currentRoute);
      const targetCity = (el && el.dataset ? el.dataset.routeCity : '') || (routeCity ? routeCity.id : '');
      if (targetCity && isValidCityId(targetCity) && targetCity !== currentCityId()) {
        switchCity(targetCity).finally(() => go('map'));
      } else {
        go('map');
      }
      break;
    }
    case 'plan-remember':
      startTour();
      break;
    case 'plan-optimize':
      optimizePlanOrder();
      break;
    case 'tour-reset':
      resetTour();
      break;
    case 'tour-focus':
      focusTourActive();
      break;
    case 'plan-clear':
      clearPlan();
      break;
    case 'plan-up':
      if (id) movePlanStore(id, -1);
      break;
    case 'plan-down':
      if (id) movePlanStore(id, 1);
      break;
    case 'plan-remove':
      if (id) removePlanStore(id);
      break;
    case 'plan-focus':
      if (id) focusPlanStore(id);
      break;
    default:
      break;
  }
}

function bindEvents() {
  document.addEventListener('click', (event) => {
    const closeEl = event.target.closest('[data-close-sheet]');
    if (closeEl) {
      closeSheets();
      return;
    }

    if (event.target.closest('[data-open-add]')) {
      setAddMode(true);
      return;
    }

    if (event.target.closest('#city-picker-open')) {
      openCitySheet();
      return;
    }

    if (event.target.closest('#city-sheet-close')) {
      closeCitySheet();
      return;
    }

    const cityEl = event.target.closest('[data-city]');
    if (cityEl && cityEl.dataset.city) {
      switchCity(cityEl.dataset.city);
      return;
    }

    const resultEl = event.target.closest('[data-result-kind]');
    if (resultEl) {
      event.preventDefault();
      handleMapSearchResult(resultEl.dataset.resultId);
      return;
    }

    const actionEl = event.target.closest('[data-action]');
    if (actionEl) {
      event.preventDefault();
      handleAction(actionEl.dataset.action, actionEl);
      return;
    }

    const routeEl = event.target.closest('[data-route]');
    if (routeEl && routeEl.dataset.route) {
      openRoute(routeEl.dataset.route);
    }
  });

  document.addEventListener('input', (event) => {
    const target = event.target;
    if (!target) return;
    if (target.id === 'store-alias') {
      if (sheetStoreId) queueAliasSave(sheetStoreId, target.value);
      return;
    }
    if (target.id !== 'store-comment') return;
    if (!sheetStoreId) return;
    queueCommentSave(sheetStoreId, target.value);
  });

  document.addEventListener('focusout', (event) => {
    if (!event.target) return;
    if (event.target.id === 'store-alias') flushAliasSave();
    else if (event.target.id === 'store-comment') flushCommentSave();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      const modal = $('#modal');
      if (modal && !modal.classList.contains('hidden')) {
        const cancel = $('#modal-cancel');
        if (cancel) cancel.click();
        return;
      }
      if (openedSheetEl) {
        closeSheets();
        return;
      }
      if (mapSearchOpen) {
        closeMapSearch();
        return;
      }
      if (planMode) {
        setPlanMode(false);
        return;
      }
      if (editMode) {
        setEditMode(false);
        return;
      }
      if (addMode) {
        setAddMode(false);
        return;
      }
      closeSheets();
      return;
    }
    const target = event.target;
    if ((event.key === 'Enter' || event.key === ' ') && target && target.matches &&
        target.matches('.route-store[role="button"]')) {
      event.preventDefault();
      openStoreSheet(target.dataset.id);
    }
  });

  $$('#tabbar .tab').forEach(btn => {
    btn.addEventListener('click', () => go(btn.dataset.tab));
  });

  $$('.map-chips .chip').forEach(chip => {
    chip.addEventListener('click', () => setMapFilter(chip.dataset.filter));
  });

  const oryolSearchInput = $('#oryol-search-input');
  const oryolSearchClear = $('#oryol-search-clear');
  if (oryolSearchInput) {
    oryolSearchInput.addEventListener('input', () => {
      oryolSearchQuery = oryolSearchInput.value;
      if (currentScreen === 'route' && currentRoute) renderRouteDetail(currentRoute);
    });
    oryolSearchInput.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      oryolSearchQuery = '';
      oryolSearchInput.value = '';
      if (currentScreen === 'route' && currentRoute) renderRouteDetail(currentRoute);
      oryolSearchInput.blur();
    });
  }
  if (oryolSearchClear && oryolSearchInput) {
    oryolSearchClear.addEventListener('click', () => {
      oryolSearchQuery = '';
      oryolSearchInput.value = '';
      if (currentScreen === 'route' && currentRoute) renderRouteDetail(currentRoute);
      oryolSearchInput.focus();
    });
  }

  const mapSearchOpenBtn = $('#map-search-open');
  const mapSearchInput = $('#map-search-input');
  const mapSearchClear = $('#map-search-clear');
  const mapSearchCloseBtn = $('#map-search-close');
  if (mapSearchOpenBtn) {
    mapSearchOpenBtn.setAttribute('aria-expanded', 'false');
    mapSearchOpenBtn.addEventListener('click', () => setMapSearchOpen(!mapSearchOpen));
  }
  if (mapSearchInput) {
    mapSearchInput.addEventListener('input', () => {
      mapSearchQuery = mapSearchInput.value;
      renderMapSearchResults();
    });
    mapSearchInput.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        if (mapSearchInput.value) {
          mapSearchInput.value = '';
          mapSearchQuery = '';
          renderMapSearchResults();
          mapSearchInput.focus();
        } else {
          closeMapSearch();
        }
        return;
      }
      if (event.key === 'Enter') {
        const first = $('#map-search-results .search-result');
        if (first) {
          event.preventDefault();
          handleMapSearchResult(first.dataset.resultId);
        }
      }
    });
  }
  if (mapSearchClear && mapSearchInput) {
    mapSearchClear.addEventListener('click', () => {
      mapSearchInput.value = '';
      mapSearchQuery = '';
      renderMapSearchResults();
      mapSearchInput.focus();
    });
  }
  if (mapSearchCloseBtn) {
    mapSearchCloseBtn.addEventListener('click', () => closeMapSearch());
  }

  const planBtn = $('#btn-plan');
  if (planBtn) {
    planBtn.setAttribute('aria-pressed', 'false');
    planBtn.addEventListener('click', () => setPlanMode(!planMode));
  }
  const planClose = $('#plan-close');
  if (planClose) planClose.addEventListener('click', () => setPlanMode(false));

  const basemapToggle = $('#btn-basemap');
  if (basemapToggle) {
    basemapToggle.addEventListener('click', () => {
      setBasemap(state.settings.basemap === 'light' ? 'local' : 'light');
    });
  }

  const editBtn = $('#btn-edit');
  if (editBtn) editBtn.addEventListener('click', () => setEditMode(!editMode));

  const editDone = $('#edit-done');
  if (editDone) editDone.addEventListener('click', () => setEditMode(false));

  const addCancel = $('#add-cancel');
  if (addCancel) addCancel.addEventListener('click', () => setAddMode(false));

  const fab = $('#fab-add');
  if (fab) fab.addEventListener('click', () => setAddMode(!addMode));

  const locateBtn = $('#btn-locate');
  if (locateBtn) locateBtn.addEventListener('click', locateMe);

  const shareBtn = $('#btn-share');
  if (shareBtn) shareBtn.addEventListener('click', () => setShareEnabled(!uiPrefs.shareLocation));

  const shareSettings = $('#btn-share-settings');
  if (shareSettings) shareSettings.addEventListener('click', () => setShareEnabled(!uiPrefs.shareLocation));

  const consentYes = $('#share-consent-yes');
  if (consentYes) consentYes.addEventListener('click', () => setShareEnabled(true));

  const consentNo = $('#share-consent-no');
  if (consentNo) consentNo.addEventListener('click', () => {
    uiPrefs.shareAsked = true;
    savePrefs();
    const consent = $('#share-consent');
    if (consent) consent.classList.add('hidden');
  });

  const peopleBar = $('#people-bar');
  if (peopleBar) {
    peopleBar.addEventListener('click', (event) => {
      const chip = event.target.closest('[data-person]');
      if (chip && chip.dataset.person) centerOnPerson(chip.dataset.person);
    });
  }

  const importOsmSettings = $('#btn-import-osm');
  if (importOsmSettings) importOsmSettings.addEventListener('click', openImportSheet);

  const routeBack = $('#route-back');
  if (routeBack) routeBack.addEventListener('click', () => go('routes'));

  const routeAdd = $('#route-add');
  if (routeAdd) routeAdd.addEventListener('click', () => {
    if (currentRoute && currentRoute !== ORYOL_ROUTE) openStoreForm(null, null, currentRoute);
  });

  const backdrop = $('#sheet-backdrop');
  if (backdrop) backdrop.addEventListener('click', closeSheets);

  const formClose = $('#form-close');
  if (formClose) formClose.addEventListener('click', () => { formState = null; closeSheets(); });

  const formCancel = $('#f-cancel');
  if (formCancel) formCancel.addEventListener('click', () => { formState = null; closeSheets(); });

  const form = $('#store-form');
  if (form) form.addEventListener('submit', saveStoreForm);

  $$('#f-brand button').forEach(btn => {
    btn.addEventListener('click', () => selectFormBrand(btn.dataset.brand));
  });

  const geocodeBtn = $('#f-geocode');
  if (geocodeBtn) geocodeBtn.addEventListener('click', geocodeFormAddress);

  const importClose = $('#import-close');
  if (importClose) importClose.addEventListener('click', closeSheets);

  const importVisible = $('#import-visible');
  if (importVisible) importVisible.addEventListener('click', () => importFromOsm('visible'));

  const importOryol = $('#import-oryol');
  if (importOryol) importOryol.addEventListener('click', () => importFromOsm('oryol'));

  const periodMinus = $('#period-minus');
  if (periodMinus) periodMinus.addEventListener('click', () => changePeriod(clampPeriod(state.settings.periodDays) - 1));

  const profileSave = $('#btn-profile-save');
  if (profileSave) profileSave.addEventListener('click', saveProfileFromSettings);

  const profileInput = $('#profile-name-input');
  if (profileInput) {
    profileInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        saveProfileFromSettings();
      }
    });
  }

  const periodPlus = $('#period-plus');
  if (periodPlus) periodPlus.addEventListener('click', () => changePeriod(clampPeriod(state.settings.periodDays) + 1));

  const periodInput = $('#period-input');
  if (periodInput) {
    const apply = () => {
      if (periodInput.value.trim() === '') {
        periodInput.value = String(clampPeriod(state.settings.periodDays));
        return;
      }
      changePeriod(periodInput.value);
    };
    periodInput.addEventListener('change', apply);
    periodInput.addEventListener('blur', apply);
    periodInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        periodInput.blur();
      }
    });
  }

  const syncBtn = $('#btn-sync-now');
  if (syncBtn) syncBtn.addEventListener('click', syncNow);

  const exportBtn = $('#btn-export');
  if (exportBtn) exportBtn.addEventListener('click', exportData);

  const importDataBtn = $('#btn-import-data');
  const importFile = $('#import-file');
  if (importDataBtn && importFile) {
    importDataBtn.addEventListener('click', () => importFile.click());
    importFile.addEventListener('change', () => {
      const file = importFile.files && importFile.files[0];
      importFile.value = '';
      if (file) importDataFile(file);
    });
  }

  const restoreBtn = $('#btn-restore-hidden');
  if (restoreBtn) restoreBtn.addEventListener('click', restoreHiddenStores);

  const resetBtn = $('#btn-reset-visits');
  if (resetBtn) resetBtn.addEventListener('click', resetAllVisits);

  $$('.basemap-btn').forEach(btn => {
    btn.addEventListener('click', () => setBasemap(btn.dataset.basemap));
  });

  window.addEventListener('online', () => {
    if (!cloud.db) initCloud(true);
    else syncNow();
  });

  window.addEventListener('offline', () => {
    cloud.online = false;
    setSyncStatus('offline', 'Нет интернета', 'Отметки сохраняются на телефоне');
  });

  document.addEventListener('visibilitychange', () => {
    refreshGeoWatch();
    if (!document.hidden) {
      refreshAllMarkers();
      refreshCountsAndRoutes();
      if (uiPrefs.shareLocation) maybeSendPresence(true);
    }
  });

  window.addEventListener('pagehide', () => saveLocal(true));
}

/* --------------------------- Запуск --------------------------- */

function tick() {
  refreshAllMarkers();
  renderCounts();
  if (map) renderPresence();
  if (uiPrefs.shareLocation) maybeSendPresence();
  if (currentScreen === 'routes') renderRoutesList();
  if (currentScreen === 'route' && currentRoute) renderRouteDetail(currentRoute);
  if (sheetStoreId && openedSheetEl && openedSheetEl.id === 'store-sheet' && !formState) {
    const active = document.activeElement;
    if (!active || (active.id !== 'store-comment' && active.id !== 'store-alias')) renderStoreSheet();
  }
}

async function loadSeeds() {
  let storesOk = false;
  const city = currentCity || cityById(currentCityId());

  const missing = cityList().filter(item => item && !Array.isArray(cityStoreSeeds[item.id]));
  try {
    await Promise.all(missing.map(async (item) => {
      const response = await fetch(item.stores || 'js/stores.json', { cache: 'no-store' });
      if (!response.ok) throw new Error((item.stores || 'stores.json') + ': HTTP ' + response.status);
      const raw = await response.json();
      cityStoreSeeds[item.id] = (Array.isArray(raw) ? raw : [])
        .map(seed => normalizeSeedMapStore(seed, item.id))
        .filter(Boolean);
    }));
    storesOk = true;
  } catch (error) {
    console.warn('Не удалось загрузить точки карты', error);
  }

  mapStoresSeed = Array.isArray(cityStoreSeeds[city.id]) ? cityStoreSeeds[city.id] : [];

  if (!routeSeedLoaded) {
    try {
      const routesRes = await fetch('js/routes-seed.json', { cache: 'no-store' });
      if (routesRes.ok) {
        const raw = await routesRes.json();
        const next = {};
        for (const name of ROUTE_NAMES) {
          if (name === ORYOL_ROUTE) continue;
          const list = raw && Array.isArray(raw[name]) ? raw[name] : [];
          next[name] = list.map(item => normalizeRouteSeedStore(item, name)).filter(Boolean);
        }
        routeSeed = next;
      }
      routeSeedLoaded = true;
    } catch (error) {
      console.warn('Не удалось загрузить маршруты', error);
    }
  }

  seedsLoaded = true;
  rebuildStoreCache();

  const legacyChanged = applyLegacyRoutes();
  if (legacyChanged) {
    localDirty = true;
    saveLocal();
  }

  renderCounts();
  rebuildTourVisual();
  renderPlan();
  setMapFilter(mapFilter);
  renderTourUi();
  renderRoutesList();
  updateCityUi();
  if (map) {
    fitMapToStores();
  }

  if (!storesOk && !mapStoresSeed.length) {
    showBootError('Не удалось загрузить точки. Запустите приложение через start.bat или откройте опубликованную версию.');
  }
}


function updateCityUi() {
  const city = currentCity || cityById(currentCityId());
  const titleEl = document.getElementById('app-title');
  if (titleEl) titleEl.textContent = city.name || 'Объезд';
  const searchInput = document.getElementById('oryol-search-input');
  if (searchInput) {
    searchInput.placeholder = 'Найти адрес или магазин · ' + city.name;
    searchInput.setAttribute('aria-label', 'Поиск магазина по адресу в городе ' + city.name);
  }
  const importText = document.getElementById('import-city-text');
  if (importText) importText.textContent = 'Загрузить весь ' + city.name;
  const versionEl = document.getElementById('app-version');
  if (versionEl) versionEl.textContent = APP_VERSION;
  document.title = (city.name || 'Объезд') + ' · Объезд магазинов';
}

function renderCitySheet() {
  const list = document.getElementById('city-list');
  if (!list) return;
  const city = currentCity || cityById(currentCityId());
  const items = cityList();
  list.innerHTML = items.map(item => {
    const active = item.id === city.id ? ' active' : '';
    const seeded = cityStoreCounts[item.id];
    const stores = seeded == null ? allStores.filter(s => s.city === item.id).length : seeded;
    const name = escapeHtml(item.name || '');
    const region = item.region ? ' · ' + escapeHtml(item.region) : '';
    return '<button class="city-item' + active + '" type="button" data-city="' + escapeHtml(item.id || '') + '">' +
      '<span class="city-item-main">' +
        '<span class="city-item-name">' + name + region + '</span>' +
        '<span class="city-item-meta">' + stores + ' ' + plural(stores, 'магазин', 'магазина', 'магазинов') + '</span>' +
      '</span>' +
      (active ? '<span class="city-item-check"><svg class="icon"><use href="#i-check"/></svg></span>' : '') +
    '</button>';
  }).join('');
}

function openCitySheet() {
  renderCitySheet();
  const sheet = document.getElementById('city-sheet');
  if (sheet) openSheetEl(sheet);
}

function closeCitySheet() {
  const sheet = document.getElementById('city-sheet');
  if (sheet && openedSheetEl === sheet) closeSheets();
  else if (sheet) {
    sheet.classList.remove('open');
    sheet.classList.add('hidden');
  }
}

async function switchCity(cityId) {
  if (!isValidCityId(cityId)) return;
  if (currentCity && currentCity.id === cityId) {
    closeCitySheet();
    return;
  }

  uiPrefs.city = cityId;
  savePrefs();

  closeCitySheet();

  currentCity = cityById(cityId);
  uiPrefs.plan = planIds().slice();
  uiPrefs.tour = tourPref();

  if (map) {
    try {
      map.eachLayer(layer => {
        if (layer === tileLight) return;
        if (isClusterInternalLayer(layer)) return;
        if (planLayer && layer === planLayer) return;
        if (tourLayer && layer === tourLayer) return;
        if (presenceLayer && layer === presenceLayer) return;
        if (planLine && layer === planLine) return;
        if (localBaseLayer && layer === localBaseLayer) {
          try { map.removeLayer(layer); } catch (e) {}
          return;
        }
        try { map.removeLayer(layer); } catch (e) {}
      });
    } catch (e) {}
  }

  if (clusterLayers) {
    try {
      clusterLayers.ok.clearLayers();
      clusterLayers.due.clearLayers();
    } catch (e) {}
  }
  markers.clear();
  if (planLayer) {
    try { planLayer.clearLayers(); } catch (e) {}
  }
  if (tourLayer) {
    try { tourLayer.clearLayers(); } catch (e) {}
  }
  if (planLine && map) {
    try { map.removeLayer(planLine); } catch (e) {}
  }
  planLine = null;
  planIconState = new Map();
  tourVisual = { activeId: null, pending: new Set() };
  tourVisualKey = '';

  mapAssetsRequested = false;
  mapAssetsToken += 1;
  localLayers = null;
  localBaseLayer = null;
  clearLocalSegments();
  mapLabelLayer = null;
  mapLabelMarkers = [];

  if (!map) {
    initMap();
  } else {
    applyBasemap();
  }
  loadMapAssets();

  mapStoresSeed = [];
  seedsLoaded = false;
  rebuildStoreCache();

  await loadSeeds();

  if (map) {
    const city = currentCity;
    try {
      map.setView(cityCenterOf(city), city.zoom || 12, { animate: true });
    } catch (e) {}
    fitMapToStores();
  }

  renderCounts();
  renderRoutesList();
  updateCityUi();
  renderPlan();
  renderTourUi();
  if (currentScreen === 'routes') {
    renderRoutesList();
  }
  if (currentScreen === 'route' && currentRoute && !isKnownRoute(currentRoute)) {
    go('routes');
  } else if (currentScreen === 'route' && currentRoute) {
    renderRouteDetail(currentRoute);
  }

  showSnackbar('Город: ' + currentCity.name);
}


async function bootstrap() {
  loadLocal();
  await loadCities();
  await loadCityStoreCounts();
  currentCity = cityById(uiPrefs.city || citiesConfig.default);
  uiPrefs.city = currentCity.id;
  uiPrefs.plan = planIds().slice();
  uiPrefs.tour = tourPref();
  initMap();
  bindEvents();
  go(uiPrefs.screen || 'map');
  updateAddUi();
  updateCityUi();

  await loadSeeds();
  hideBoot();
  updateSyncUi();
  updateShareUi();
  refreshGeoWatch();
  ensureProfileName().then(maybeAskSharing);
  initCloud();

  setInterval(tick, 60000);

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

bootstrap();
