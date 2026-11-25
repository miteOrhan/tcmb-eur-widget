"use strict";

const { app, BrowserWindow, Menu, Tray, nativeImage, screen, ipcMain, powerMonitor } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { createService } = require("./rates");
const { istanbulDay, nextCheckpoint } = require("./schedule");

const WIDTH = 324;
const HEIGHT = 172;
const EDGE = 8;
const REFRESH_MS = 15 * 60 * 1000;

let win = null;
let tray = null;
let service = null;
let stateFile = null;
let quitting = false;
let moveTimer = null;
let refreshTimer = null;
let bulletinTimer = null;
let lastDay = null;
let lastPayload = null;
let captured = false;

const captureMode = process.argv.includes("--capture");

const nf = new Intl.NumberFormat("tr-TR", { minimumFractionDigits: 4, maximumFractionDigits: 4 });

function fmt(v) {
  return v == null || !Number.isFinite(v) ? "—" : nf.format(v);
}

function pctText(v) {
  if (v == null || !Number.isFinite(v)) return "";
  const arrow = v > 0 ? "▲" : v < 0 ? "▼" : "•";
  return `${arrow} %${Math.abs(v).toFixed(2).replace(".", ",")}`;
}

/* ------------------------------------------------------------------ */
/* pencere konumu                                                      */
/* ------------------------------------------------------------------ */

function defaultBounds() {
  const wa = screen.getPrimaryDisplay().workArea;
  return {
    x: Math.round(wa.x + wa.width - WIDTH - EDGE),
    y: Math.round(wa.y + wa.height - HEIGHT - EDGE),
    width: WIDTH,
    height: HEIGHT,
  };
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch {
    return {};
  }
}

function saveState(patch) {
  try {
    fs.writeFileSync(stateFile, JSON.stringify({ ...readState(), ...patch }));
  } catch {
    /* konum kaydı kritik değil */
  }
}

function visibleOnSomeDisplay(bounds) {
  return screen.getAllDisplays().some(({ workArea }) => {
    const overlapX = Math.min(bounds.x + WIDTH, workArea.x + workArea.width) - Math.max(bounds.x, workArea.x);
    const overlapY = Math.min(bounds.y + HEIGHT, workArea.y + workArea.height) - Math.max(bounds.y, workArea.y);
    return overlapX > 60 && overlapY > 30;
  });
}

function initialBounds() {
  const saved = readState().bounds;
  if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y) && visibleOnSomeDisplay(saved)) {
    return { ...defaultBounds(), x: Math.round(saved.x), y: Math.round(saved.y) };
  }
  return defaultBounds();
}

function resetPosition() {
  if (!win) return;
  const b = defaultBounds();
  win.setBounds(b);
  saveState({ bounds: b });
}

/* ------------------------------------------------------------------ */
/* window                                                              */
/* ------------------------------------------------------------------ */

function createWindow() {
  const bounds = initialBounds();

  win = new BrowserWindow({
    ...bounds,
    width: WIDTH,
    height: HEIGHT,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: true,
    roundedCorners: true,
    show: false,
    title: "TCMB EUR Widget",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.setAlwaysOnTop(true);
  win.loadFile(path.join(__dirname, "src", "index.html"));

  win.webContents.on("did-finish-load", () => console.log("[win] did-finish-load"));
  win.webContents.on("did-fail-load", (_e, code, desc) => console.warn("[win] did-fail-load", code, desc));
  win.webContents.on("preload-error", (_e, file, error) => console.warn("[preload]", file, error.message));
  win.webContents.on("render-process-gone", (_e, details) => console.warn("[win] render-process-gone", details.reason));

  win.once("ready-to-show", () => win.showInactive());

  win.on("moved", () => {
    clearTimeout(moveTimer);
    moveTimer = setTimeout(() => {
      if (win && !win.isDestroyed()) saveState({ bounds: win.getBounds() });
    }, 500);
  });

  win.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    win.hide();
  });

  win.on("closed", () => {
    win = null;
  });
}

function toggleWindow() {
  if (!win || win.isDestroyed()) {
    createWindow();
    return;
  }
  if (win.isVisible()) {
    win.hide();
  } else {
    win.showInactive();
    win.setAlwaysOnTop(true);
  }
}

/* ------------------------------------------------------------------ */
/* tray                                                                */
/* ------------------------------------------------------------------ */

function setLogin(enable) {
  try {
    const exe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
    app.setLoginItemSettings({ openAtLogin: enable, path: exe, args: [] });
  } catch {
    /* desteklenmiyorsa yoksay */
  }
}

function buildTrayMenu() {
  if (!tray) return;
  const started = app.getLoginItemSettings().openAtLogin;

  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Göster / Gizle", click: toggleWindow },
      { label: "Şimdi yenile", click: () => refresh(true) },
      { type: "separator" },
      {
        label: "Windows ile başlat",
        type: "checkbox",
        checked: started,
        click: (item) => {
          setLogin(item.checked);
          buildTrayMenu();
        },
      },
      { label: "Konumu sıfırla", click: resetPosition },
      { type: "separator" },
      {
        label: "Çıkış",
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ])
  );
}

function createTray() {
  const iconPath = path.join(__dirname, "build", "tray.png");
  let image = nativeImage.createFromPath(iconPath);
  if (image.isEmpty()) image = nativeImage.createFromPath(path.join(__dirname, "build", "icon.png"));
  tray = new Tray(image.resize({ width: 16, height: 16 }));
  tray.setToolTip("TCMB EUR/TRY · yükleniyor…");
  tray.on("click", toggleWindow);
  buildTrayMenu();
}

/* ------------------------------------------------------------------ */
/* veri                                                                */
/* ------------------------------------------------------------------ */

function updateTray(data) {
  if (!tray || !data || data.buy == null) return;
  const tip = `EUR/TRY · Alış ${fmt(data.buy)} · Satış ${fmt(data.sell)} · ${pctText(data.buyChangePct)}`;
  tray.setToolTip(tip.slice(0, 127));
}

function push(data) {
  lastPayload = data;
  if (win && !win.isDestroyed()) win.webContents.send("rates:update", data);
  updateTray(data);
}

async function refresh(force = false) {
  try {
    const data = await service.get(force);
    console.log(`[rates] ${data.date} ${data.buy}/${data.sell} stale=${!!data.stale}`);
    push(data);
    return data;
  } catch (err) {
    const data = { error: String(err.message || err), stale: true };
    push(data);
    if (tray) tray.setToolTip("TCMB EUR/TRY · veri alınamadı");
    return data;
  }
}

/* Bülten çıkış saatlerinde (15:31 / 15:35 / 15:40) zorunlu kontrol. */
function scheduleBulletinCheck() {
  clearTimeout(bulletinTimer);
  const next = nextCheckpoint();
  const delay = Math.max(1000, next.getTime() - Date.now());
  console.log(`[schedule] next bulletin check ${next.toISOString()} (${Math.round(delay / 1000)}s)`);

  bulletinTimer = setTimeout(async () => {
    await refresh(true);
    scheduleBulletinCheck();
  }, delay);
}

/* ------------------------------------------------------------------ */
/* capture (görsel doğrulama)                                          */
/* ------------------------------------------------------------------ */

async function captureWindow() {
  if (captured || !win) return;
  captured = true;
  setTimeout(async () => {
    try {
      const image = await win.webContents.capturePage();
      const file = path.join(app.getPath("temp"), "tcmb-widget.png");
      fs.writeFileSync(file, image.toPNG());
      console.log(`[capture] ${file}`);
      console.log(`[bounds] ${JSON.stringify(win.getBounds())}`);
    } catch (err) {
      console.warn("[capture]", err.message);
    }
    quitting = true;
    app.exit(0);
  }, 8000);
}

/* ------------------------------------------------------------------ */
/* app                                                                 */
/* ------------------------------------------------------------------ */

app.setAppUserModelId("com.local.tcmbeurwidget");

const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) {
      win.showInactive();
      win.setAlwaysOnTop(true);
    }
  });

  app.whenReady().then(() => {
    stateFile = path.join(app.getPath("userData"), "window.json");
    service = createService({ cacheFile: path.join(app.getPath("userData"), "rates.json") });

    createWindow();
    createTray();

    const cached = service.current();
    if (cached) {
      lastPayload = cached;
      updateTray(cached);
    }

    lastDay = istanbulDay();
    refresh(false);
    refreshTimer = setInterval(() => {
      const day = istanbulDay();
      const dayChanged = day !== lastDay;
      if (dayChanged) lastDay = day;
      refresh(dayChanged);
    }, REFRESH_MS);
    scheduleBulletinCheck();

    powerMonitor.on("resume", () => {
      refresh(true);
      scheduleBulletinCheck();
    });

    ipcMain.handle("rates:get", () => service.current() || lastPayload);
    ipcMain.handle("rates:refresh", () => refresh(true));
    ipcMain.handle("widget:hide", () => {
      if (win) win.hide();
    });
    ipcMain.on("widget:rendered", () => {
      console.log("[ipc] widget:rendered");
      if (captureMode) captureWindow();
    });
    ipcMain.on("widget:debug", (_event, message) => console.log("[renderer]", message));

    if (captureMode) {
      setTimeout(() => captureWindow(), 15000);
    }
  });

  app.on("before-quit", () => {
    quitting = true;
    clearInterval(refreshTimer);
    clearTimeout(bulletinTimer);
  });

  app.on("window-all-closed", () => {
    /* tepside kalmaya devam et */
  });
}
