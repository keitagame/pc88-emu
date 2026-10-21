/* =====================================================================
 * quasi88-worker.js
 *   QUASI88 (PC-8801 emulator, Emscripten/SDL2 build) を Web Worker 上で動かすホスト。
 *
 *   - OffscreenCanvas へ WebGL 描画 (index.html から transferControlToOffscreen で受け取る)
 *   - Worker には DOM が無いので、Emscripten/SDL2 が要求する document / window /
 *     screen / AudioContext を最小限のスタブで用意する
 *   - ROM・ディスクイメージ・ステートは IndexedDB に保存し、起動時に MEMFS へ展開
 *   - キーボード/マウス入力はメインスレッドから postMessage で受け取り、
 *     スタブの EventTarget 経由で SDL2 に配送する
 *   - 音声: SDL2 の ScriptProcessor を模した偽 AudioContext で PCM を生成し、
 *     MessageChannel 経由でメインスレッドの AudioWorklet へ直接送る
 *
 *   必要ファイル(同じディレクトリ):
 *     quasi88-worker.js (このファイル) / quasi88.js (または quasi88__4_.js) / quasi88.wasm
 * ===================================================================== */
"use strict";

/* glue(quasi88.js)がグローバルに err / out / FS 等を宣言するため、
 * こちらの名前が上書きされないよう全体をスコープで隔離する */
(function () {

/* ---------- 設定 ---------- */
var GLUE_CANDIDATES = ["quasi88.js", "quasi88__4_.js"]; // Emscripten が出力した JS
var DB_NAME = "quasi88-web";
var DB_STORE = "files";
var PERSIST_DIRS = ["disk", "state", "tape"]; // 実行中に変更され得るので定期保存する
var ROM_RE = /\.ROM$/i;

/* ---------- 状態 ---------- */
var canvas = null;
var screenInfo = {};
var hostSampleRate = 48000;
var started = false;
var fsReady = false;

var store = new Map(); // "rom/N88.ROM" -> Uint8Array
var knownSig = new Map(); // 永続化済みシグネチャ (path -> "size:mtime")
var diskOrder = []; // 読み込んだ順のディスク名(起動時引数に使う)

function post(msg, transfer) {
  self.postMessage(msg, transfer || []);
}
function log(t) { post({ type: "log", text: String(t) }); }
function err(t) { post({ type: "err", text: String(t) }); }
function status(t, isError) { post({ type: "status", text: String(t), isError: !!isError }); }

/* =====================================================================
 * IndexedDB
 * ===================================================================== */
var dbPromise = null;
function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise(function (resolve, reject) {
    if (typeof indexedDB === "undefined") return reject(new Error("IndexedDB unavailable"));
    var req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = function () { req.result.createObjectStore(DB_STORE); };
    req.onsuccess = function () { resolve(req.result); };
    req.onerror = function () { reject(req.error); };
  });
  return dbPromise;
}
function idbPut(key, u8) {
  return openDB().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(DB_STORE, "readwrite");
      // 共有バッファを避けるためコピーして保存
      tx.objectStore(DB_STORE).put(u8.slice().buffer, key);
      tx.oncomplete = resolve;
      tx.onerror = function () { reject(tx.error); };
    });
  }).catch(function (e) { err("保存に失敗: " + key + " (" + (e && e.message ? e.message : e) + ")"); });
}
function idbLoadAll() {
  return openDB().then(function (db) {
    return new Promise(function (resolve, reject) {
      var out = new Map();
      var tx = db.transaction(DB_STORE, "readonly");
      var req = tx.objectStore(DB_STORE).openCursor();
      req.onsuccess = function () {
        var c = req.result;
        if (c) { out.set(String(c.key), new Uint8Array(c.value)); c.continue(); }
        else resolve(out);
      };
      req.onerror = function () { reject(req.error); };
    });
  }).catch(function () { return new Map(); });
}
function idbClear() {
  return openDB().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(DB_STORE, "readwrite");
      tx.objectStore(DB_STORE).clear();
      tx.oncomplete = resolve;
      tx.onerror = function () { reject(tx.error); };
    });
  }).catch(function () {});
}

/* =====================================================================
 * 一覧通知
 * ===================================================================== */
function listKind(kind) {
  var prefix = kind + "/";
  var out = [];
  store.forEach(function (_v, k) { if (k.indexOf(prefix) === 0) out.push(k.slice(prefix.length)); });
  return out.sort();
}
function sendRomList(addedCount) {
  post({ type: "romList", list: listKind("rom"), addedCount: addedCount || 0 });
}
function sendDiskList() {
  post({ type: "diskList", list: diskOrder.slice() });
}

/* =====================================================================
 * MEMFS 連携 (glue 読み込み後にのみ有効)
 * ===================================================================== */
function fsEnsureDir(path) {
  try { FS.mkdir(path); } catch (e) { /* exists */ }
}
function fsWrite(path, u8) {
  try { FS.unlink(path); } catch (e) { /* none */ }
  FS.writeFile(path, u8);
  try {
    var st = FS.stat(path);
    knownSig.set(path, st.size + ":" + (+st.mtime));
  } catch (e) { /* ignore */ }
}
function materialize(key, u8) {
  // key = "kind/NAME"
  var i = key.indexOf("/");
  var kind = key.slice(0, i), name = key.slice(i + 1);
  if (kind === "rom") {
    // QUASI88 は大文字/小文字どちらのROM名も探すため、両方を置く
    fsWrite("/rom/" + name.toUpperCase(), u8);
    if (name.toLowerCase() !== name.toUpperCase()) fsWrite("/rom/" + name.toLowerCase(), u8);
  } else {
    fsWrite("/" + kind + "/" + name, u8);
  }
}
function materializeAll() {
  ["rom", "disk", "state", "tape", "snap"].forEach(function (d) { fsEnsureDir("/" + d); });
  store.forEach(function (u8, key) { materialize(key, u8); });
  fsReady = true;
}

/* 実行中に変更されたディスク/ステート等を IndexedDB へ反映 */
function syncDirs() {
  if (!fsReady) return;
  PERSIST_DIRS.forEach(function (dir) {
    var names;
    try { names = FS.readdir("/" + dir); } catch (e) { return; }
    names.forEach(function (n) {
      if (n === "." || n === "..") return;
      var path = "/" + dir + "/" + n;
      try {
        var st = FS.stat(path);
        if (!FS.isFile(st.mode)) return;
        var sig = st.size + ":" + (+st.mtime);
        if (knownSig.get(path) === sig) return;
        var data = FS.readFile(path);
        knownSig.set(path, sig);
        store.set(dir + "/" + n, data.slice());
        idbPut(dir + "/" + n, data);
        if (dir === "disk" && diskOrder.indexOf(n) < 0) { diskOrder.push(n); sendDiskList(); }
      } catch (e) { /* 書き込み中などは次回に回す */ }
    });
  });
}

/* =====================================================================
 * DOM スタブ
 * ===================================================================== */
function noop() {}

/* 最小限の EventTarget。SDL2(emscripten) が登録するリスナーを保持し、
 * メインスレッドから届いた入力を手動で配送する。 */
function makeTarget(obj, name) {
  obj.__l = {};
  obj.__name = name;
  obj.nodeName = "#" + name;
  obj.addEventListener = function (type, fn) {
    (this.__l[type] || (this.__l[type] = [])).push(fn);
  };
  obj.removeEventListener = function (type, fn) {
    var a = this.__l[type];
    if (!a) return;
    var i = a.indexOf(fn);
    if (i >= 0) a.splice(i, 1);
  };
  obj.hasListener = function (type) {
    return !!(this.__l[type] && this.__l[type].length);
  };
  obj.emit = function (type, ev) {
    var a = this.__l[type];
    if (!a || !a.length) return false;
    ev.type = type;
    ev.target = this;
    ev.currentTarget = this;
    if (ev.timeStamp === undefined) ev.timeStamp = performance.now();
    if (!ev.preventDefault) ev.preventDefault = noop;
    if (!ev.stopPropagation) ev.stopPropagation = noop;
    a.slice().forEach(function (fn) {
      try { fn(ev); } catch (e) { err("イベント処理エラー(" + type + "): " + (e && e.message ? e.message : e)); }
    });
    return true;
  };
  return obj;
}

function makeStyle() {
  var s = {
    setProperty: function (k, v) { this[k] = v; },
    removeProperty: function (k) { delete this[k]; },
    getPropertyValue: function (k) { return this[k] || ""; }
  };
  var cursor = "";
  Object.defineProperty(s, "cursor", {
    enumerable: true,
    get: function () { return cursor; },
    set: function (v) {
      if (v !== cursor) { cursor = v; post({ type: "cursor", value: String(v) }); }
    }
  });
  return s;
}

var diag = { ctx: "未作成", draws: 0 };

function prepareCanvas(c) {
  var origGetContext = c.getContext.bind(c);
  c.getContext = function (type, attrs) {
    var ctx = origGetContext(type, attrs);
    diag.ctx = type + (ctx ? "" : "(失敗)");
    if (ctx && !ctx.__diag) {
      ctx.__diag = true;
      ["drawArrays", "drawElements", "putImageData"].forEach(function (n) {
        var f = ctx[n];
        if (typeof f === "function") ctx[n] = function () { diag.draws++; return f.apply(this, arguments); };
      });
    }
    return ctx;
  };
  makeTarget(c, "canvas"); // addEventListener 等を上書きして自前で管理
  c.nodeName = "CANVAS";
  c.id = "canvas";
  c.style = makeStyle();
  c.controlTransferredOffscreen = false;
  c.getBoundingClientRect = function () {
    return { left: 0, top: 0, right: c.width, bottom: c.height, x: 0, y: 0, width: c.width, height: c.height };
  };
  c.focus = noop;
  c.blur = noop;
  c.requestPointerLock = noop;
  c.parentNode = null;
  c.getAttribute = function () { return null; };
  return c;
}

var fakeScreen = { width: 1920, height: 1080, availWidth: 1920, availHeight: 1080, colorDepth: 24, pixelDepth: 24 };
var fakeDocument = makeTarget({
  title: "PC-88",
  fullscreenEnabled: false,
  webkitFullscreenEnabled: false,
  fullscreenElement: null,
  pointerLockElement: null,
  hidden: false,
  visibilityState: "visible",
  body: {},
  documentElement: { style: {} },
  querySelector: function (sel) { return selectCanvas(sel); },
  getElementById: function (id) { return id === "canvas" ? canvas : null; },
  querySelectorAll: function (sel) { var c = selectCanvas(sel); return c ? [c] : []; },
  createElement: function (tag) {
    if (String(tag).toLowerCase() === "canvas") return prepareCanvas(new OffscreenCanvas(1, 1));
    return makeTarget({ style: makeStyle() }, String(tag));
  },
  exitFullscreen: noop,
  exitPointerLock: noop
}, "document");

var fakeWindow = makeTarget({
  innerWidth: 1000,
  innerHeight: 700,
  outerWidth: 1000,
  outerHeight: 700,
  devicePixelRatio: 1,
  prompt: function () { return null; },
  alert: noop,
  focus: noop
}, "window");

function selectCanvas(sel) {
  if (!canvas) return null;
  sel = String(sel);
  return (sel === "#canvas" || sel === "canvas" || sel === "#screen") ? canvas : null;
}

/* glue 読み込み前に用意するもの */
self.document = fakeDocument;
self.screen = fakeScreen;

/* =====================================================================
 * 音声: 偽 AudioContext + MessageChannel → AudioWorklet
 * ===================================================================== */
var Audio = {
  port: null,
  node: null,
  sentFrames: 0,
  playedFrames: 0,
  t0: 0,
  timer: 0,
  target: 0,
  setPort: function (p) {
    var self_ = this;
    this.port = p;
    this.sentFrames = 0;
    this.playedFrames = 0;
    p.onmessage = function (e) {
      if (e.data && typeof e.data.played === "number") self_.playedFrames = e.data.played;
    };
  },
  levelFrames: function () {
    if (this.port) return this.sentFrames - this.playedFrames;
    // ポートが無い間は実時間で消費したことにして空回りを防ぐ
    var played = (performance.now() - this.t0) * hostSampleRate / 1000;
    return this.sentFrames - played;
  },
  pump: function () {
    var node = this.node;
    if (!node || !node.onaudioprocess) return;
    var n = node.bufferSize, ch = node.outChannels;
    var buf = new FakeAudioBuffer(ch, n, hostSampleRate);
    node.onaudioprocess({ outputBuffer: buf, playbackTime: 0 });
    if (this.port) {
      var inter = new Float32Array(n * ch);
      for (var c = 0; c < ch; c++) {
        var d = buf.getChannelData(c);
        for (var i = 0; i < n; i++) inter[i * ch + c] = d[i];
      }
      this.port.postMessage({ pcm: inter, channels: ch, frames: n }, [inter.buffer]);
    }
    this.sentFrames += n;
  },
  tick: function () {
    var a = Audio;
    if (!a.node) return;
    var guard = 0;
    while (a.levelFrames() < a.target && guard++ < 6) {
      try { a.pump(); } catch (e) { err("audio: " + (e && e.message ? e.message : e)); a.stop(); return; }
    }
  },
  start: function (node) {
    this.node = node;
    this.sentFrames = 0;
    this.playedFrames = 0;
    this.t0 = performance.now();
    this.target = node.bufferSize * 2 + Math.round(hostSampleRate * 0.04);
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(this.tick, 4);
  },
  stop: function () {
    if (this.timer) clearInterval(this.timer);
    this.timer = 0;
    this.node = null;
  }
};

function FakeAudioBuffer(ch, len, sr) {
  this.numberOfChannels = ch;
  this.length = len;
  this.sampleRate = sr;
  this.duration = len / sr;
  this._d = [];
  for (var i = 0; i < ch; i++) this._d.push(new Float32Array(len));
}
FakeAudioBuffer.prototype.getChannelData = function (c) { return this._d[c]; };

function FakeScriptProcessor(bufferSize, inCh, outCh) {
  this.bufferSize = bufferSize;
  this.inChannels = inCh;
  this.outChannels = outCh || 1;
  this.onaudioprocess = null;
}
FakeScriptProcessor.prototype.connect = function () { Audio.start(this); };
FakeScriptProcessor.prototype.disconnect = function () { if (Audio.node === this) Audio.stop(); };

function FakeAudioContext() {
  this.sampleRate = hostSampleRate;
  this.state = "running";
  this.destination = {};
  this.currentTime = 0;
}
FakeAudioContext.prototype.createScriptProcessor = function (bs, inCh, outCh) {
  return new FakeScriptProcessor(bs, inCh, outCh);
};
FakeAudioContext.prototype.createBuffer = function (ch, len, sr) {
  return new FakeAudioBuffer(ch, len, sr);
};
FakeAudioContext.prototype.resume = function () { return Promise.resolve(); };
FakeAudioContext.prototype.close = function () { Audio.stop(); return Promise.resolve(); };
FakeAudioContext.prototype.createMediaStreamSource = function () { throw new Error("capture unsupported"); };

self.AudioContext = FakeAudioContext;

/* =====================================================================
 * 入力配送
 * ===================================================================== */
var KEY_ORDER = function () { return [fakeWindow, fakeDocument, canvas]; };
var MOUSE_ORDER = function () { return [canvas, fakeDocument, fakeWindow]; };

function firstWithListener(type, order) {
  for (var i = 0; i < order.length; i++) {
    if (order[i] && order[i].hasListener(type)) return order[i];
  }
  return null;
}

function keyLocation(code) {
  if (!code) return 0;
  if (/Left$/.test(code)) return 1;
  if (/Right$/.test(code)) return 2;
  if (/^Numpad/.test(code)) return 3;
  return 0;
}

function dispatchKey(type, e) {
  if (!started) return;
  var ev = {
    key: e.key, code: e.code, keyCode: e.keyCode | 0, which: e.which | 0,
    shiftKey: !!e.shiftKey, ctrlKey: !!e.ctrlKey, altKey: !!e.altKey, metaKey: !!e.metaKey,
    repeat: !!e.repeat, location: keyLocation(e.code),
    charCode: 0, char: "", locale: ""
  };
  var t = firstWithListener(type, KEY_ORDER());
  if (t) t.emit(type, ev);
  if (type === "keydown" && e.key && e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
    var kp = {
      key: e.key, code: e.code, keyCode: e.keyCode | 0, which: e.which | 0,
      shiftKey: !!e.shiftKey, ctrlKey: !!e.ctrlKey, altKey: !!e.altKey, metaKey: !!e.metaKey,
      repeat: !!e.repeat, location: 0, charCode: e.key.charCodeAt(0), char: e.key, locale: ""
    };
    var t2 = firstWithListener("keypress", KEY_ORDER());
    if (t2) t2.emit("keypress", kp);
  }
}

function dispatchMouse(m) {
  if (!started || !canvas) return;
  var type = m.mouseType;
  var t = firstWithListener(type, MOUSE_ORDER());
  if (!t) return;
  var ev = {
    screenX: m.screenX | 0, screenY: m.screenY | 0,
    clientX: m.x | 0, clientY: m.y | 0,
    ctrlKey: !!m.ctrlKey, shiftKey: !!m.shiftKey, altKey: !!m.altKey, metaKey: !!m.metaKey,
    button: m.button | 0, buttons: m.buttons | 0,
    movementX: m.movementX | 0, movementY: m.movementY | 0,
    deltaX: +m.deltaX || 0, deltaY: +m.deltaY || 0, deltaZ: +m.deltaZ || 0, deltaMode: m.deltaMode | 0
  };
  t.emit(type, ev);
}

/* フォーカス: SDL2 はフォーカスイベントでキーボードフォーカスを得る */
var focusWanted = false;
var focusDelivered = true;
function deliverFocus() {
  if (!started || focusDelivered) return;
  var type = focusWanted ? "focus" : "blur";
  var any = false;
  [fakeWindow, fakeDocument, canvas].forEach(function (t) {
    if (t && t.emit(type, { relatedTarget: null })) any = true;
  });
  if (any) {
    focusDelivered = true;
    if (focusWanted && canvas && canvas.hasListener("mouseenter")) {
      canvas.emit("mouseenter", {
        screenX: 0, screenY: 0, clientX: 0, clientY: 0, button: 0, buttons: 0, movementX: 0, movementY: 0
      });
    }
  }
}
function setFocus(f) {
  focusWanted = !!f;
  focusDelivered = false;
  deliverFocus();
}
setInterval(deliverFocus, 100);

/* =====================================================================
 * 起動
 * ===================================================================== */
function splitArgs(s) {
  if (!s) return [];
  var out = [], re = /"([^"]*)"|'([^']*)'|(\S+)/g, m;
  while ((m = re.exec(s))) out.push(m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]);
  return out;
}

function loadGlue() {
  var lastError = null;
  for (var i = 0; i < GLUE_CANDIDATES.length; i++) {
    try {
      importScripts(GLUE_CANDIDATES[i]);
      return GLUE_CANDIDATES[i];
    } catch (e) {
      lastError = e;
      // 構文エラー等で読めたが壊れていた場合は、そのまま失敗として扱う
      if (!(e && (e.name === "NetworkError" || /NetworkError|Failed to execute 'importScripts'|load failed/i.test(String(e.message))))) {
        throw e;
      }
    }
  }
  throw lastError || new Error("glue script not found");
}

function startEmulator(extraOpt) {
  if (started) return;
  started = true;

  if (!canvas) { status("Canvasが初期化されていません", true); started = false; return; }

  var args = [
    "-romdir", "/rom",
    "-diskdir", "/disk",
    "-statedir", "/state",
    "-tapedir", "/tape",
    "-snapdir", "/snap",
    "-noconfig",
    "-nouse_joy" // Worker では Gamepad API が使えない
  ];
  args = args.concat(splitArgs(extraOpt));
  // 読み込み済みディスクを Drive1/2 に自動セット
  diskOrder.slice(0, 2).forEach(function (n) { args.push("/disk/" + n); });

  self.Module = {
    canvas: canvas,
    arguments: args,
    print: function (t) { log(t); },
    printErr: function (t) {
      // SDL2 初期化時に必ず出る無害な警告は通常ログ扱いにする
      if (/emscripten_set_main_loop_timing: Cannot set timing mode/.test(String(t))) log(t);
      else err(t);
    },
    preRun: [function () { materializeAll(); }],
    onAbort: function (w) { err("Abort: " + w); },
    onExit: function (c) { status("エミュレータが終了しました (code " + c + ")", c !== 0); },
    locateFile: function (p, dir) { return dir + p; }
  };

  try {
    var used = loadGlue();
    log("loaded " + used);
  } catch (e) {
    started = false;
    status("quasi88.js の読み込みに失敗: " + (e && e.message ? e.message : e), true);
    return;
  }

  // glue が作った specialHTMLTargets / window を実体に差し替える
  try {
    self.window = fakeWindow;
    if (typeof specialHTMLTargets !== "undefined") {
      specialHTMLTargets[1] = fakeDocument;
      specialHTMLTargets[2] = fakeWindow;
    }
  } catch (e) { err("target patch: " + e.message); }

  setInterval(syncDirs, 5000);
  setFocus(true);

  // 起動直後の診断ログ(3秒おきに数回)
  var beats = 0, lastDraws = 0;
  var hb = setInterval(function () {
    var d = diag.draws - lastDraws;
    lastDraws = diag.draws;
    log("[診断] GL=" + diag.ctx + " 描画呼び出し=" + d + "/3s" +
      " キー待受=" + (firstWithListener("keydown", KEY_ORDER()) ? "有" : "無") +
      " 音声=" + (Audio.node ? "有" : "無") + " ROM=" + listKind("rom").length + "個");
    if (++beats >= 4) clearInterval(hb);
  }, 3000);
}

/* =====================================================================
 * ファイル受け取り
 * ===================================================================== */
function addFiles(kind, files) {
  var added = 0;
  var puts = [];
  files.forEach(function (f) {
    var name = String(f.name).replace(/[\\\/]/g, "_");
    var u8 = new Uint8Array(f.buffer);
    var key = kind + "/" + name;
    store.set(key, u8);
    if (kind === "disk" && diskOrder.indexOf(name) < 0) diskOrder.push(name);
    if (fsReady) materialize(key, u8);
    puts.push(idbPut(key, u8));
    added++;
  });
  return Promise.all(puts).then(function () { return added; });
}

self.addEventListener("error", function (e) { err("Worker例外: " + (e && e.message)); });
self.addEventListener("unhandledrejection", function (e) {
  var r = e && e.reason;
  err("Worker例外: " + (r && r.message ? r.message : r));
});

self.onmessage = function (e) {
  var m = e.data || {};
  switch (m.type) {
    case "init":
      canvas = prepareCanvas(m.canvas);
      screenInfo = m.screenInfo || {};
      if (m.sampleRate) hostSampleRate = m.sampleRate;
      ["width", "height", "availWidth", "availHeight", "colorDepth", "pixelDepth"].forEach(function (k) {
        if (typeof screenInfo[k] === "number") fakeScreen[k] = screenInfo[k];
      });
      fakeWindow.innerWidth = fakeScreen.availWidth;
      fakeWindow.innerHeight = fakeScreen.availHeight;
      // wasm のダウンロードを先行させてキャッシュに載せる
      try { fetch("quasi88.wasm").catch(noop); } catch (_) {}
      idbLoadAll().then(function (map) {
        map.forEach(function (v, k) {
          store.set(k, v);
          if (k.indexOf("disk/") === 0) diskOrder.push(k.slice(5));
        });
        diskOrder.sort();
        post({ type: "ready" });
        sendRomList(0);
        sendDiskList();
      });
      break;

    case "audioPort":
      if (m.sampleRate) hostSampleRate = m.sampleRate;
      Audio.setPort(m.port);
      break;

    case "loadRoms":
      addFiles("rom", m.files || []).then(function (n) { sendRomList(n); });
      break;

    case "loadDisks":
      addFiles("disk", m.files || []).then(function (n) {
        sendDiskList();
        status(n + "個のディスクを保存しました。" + (started ? "F12メニュー → Drive からマウントできます" : "Startで先頭2枚がDrive1/2に入ります"));
      });
      break;

    case "start":
      startEmulator(m.extraOpt);
      break;

    case "keyEvent":
      dispatchKey(m.keyType, m.event || {});
      break;

    case "mouseEvent":
      dispatchMouse(m);
      break;

    case "focus":
      setFocus(m.focused);
      break;

    case "clearAll":
      idbClear().then(function () { post({ type: "cleared" }); });
      break;
  }
};

})();
