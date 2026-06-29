const { app, BrowserWindow, Menu, Notification, Tray, ipcMain, nativeImage, screen } = require('electron');
const path = require('path');

const isDev = !app.isPackaged;
const MINI_SIZE = { width: 52, height: 52 };
const EXPANDED_SIZE = { width: 420, height: 620 };
const MIN_WINDOW_SIZE = { width: 52, height: 52 };
const MAX_WINDOW_SIZE = { width: 900, height: 900 };
const DEFAULT_BACKEND_URL = isDev ? 'http://127.0.0.1:8000' : 'https://promptlyai.onrender.com';
const BACKEND_URL = process.env.VITE_API_BASE_URL || DEFAULT_BACKEND_URL;

let mainWindow;
let tray;
let lastShowRequestId = null;

function createTrayIcon() {
  const svg = `
    <svg width="64" height="64" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="g" x1="0" x2="1" y1="0" y2="1">
          <stop stop-color="#22d3ee"/>
          <stop offset="1" stop-color="#6366f1"/>
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="20" fill="url(#g)"/>
      <path d="M32 13l18 19-18 19-18-19 18-19z" fill="white" fill-opacity=".92"/>
    </svg>`;
  return nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`);
}

function positionWindow(win, size = MINI_SIZE) {
  const display = screen.getPrimaryDisplay();
  const { width, height } = display.workAreaSize;
  win.setBounds({
    x: width - size.width - 28,
    y: height - size.height - 28,
    ...size,
  });
}

async function markDesktopWidgetHidden(hidden) {
  try {
    await fetch(`${BACKEND_URL}/desktop-widget/hidden`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hidden }),
    });
  } catch {
    // The widget can still hide/show locally if the backend is not available.
  }
}

function showWindow() {
  if (!mainWindow) return;
  setWidgetMode('mini', { keepPosition: false });
  mainWindow.webContents.send('widget:show');
  mainWindow.setAlwaysOnTop(true, 'floating');
  mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  markDesktopWidgetHidden(false);
}

function parkWindow() {
  if (!mainWindow) return;
  setWidgetMode('mini', { keepPosition: false });
  mainWindow.setAlwaysOnTop(false);
  mainWindow.show();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    ...MINI_SIZE,
    frame: false,
    transparent: true,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    vibrancy: 'under-window',
    visualEffectState: 'active',
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.setAlwaysOnTop(true, 'floating');
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  positionWindow(mainWindow, MINI_SIZE);

  if (isDev) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL || 'http://127.0.0.1:5173');
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    markDesktopWidgetHidden(false);
  });

  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      parkWindow();
    }
  });
}

function createTray() {
  tray = new Tray(createTrayIcon());
  tray.setToolTip('Promptly');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show Promptly', click: () => showWindow() },
      { label: 'Mini Mode', click: () => showWindow() },
      { label: 'Expanded Mode', click: () => {
        setWidgetMode('expanded');
        mainWindow?.show();
        markDesktopWidgetHidden(false);
      } },
      { type: 'separator' },
      {
        label: 'Launch at Login',
        type: 'checkbox',
        checked: app.getLoginItemSettings().openAtLogin,
        click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          app.isQuitting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on('click', () => {
    if (mainWindow?.isVisible()) parkWindow();
    else showWindow();
  });
}

function startDesktopWidgetRequestPolling() {
  setInterval(async () => {
    try {
      const response = await fetch(`${BACKEND_URL}/desktop-widget/status`);
      if (!response.ok) return;
      const status = await response.json();
      const nextRequestId = Number(status.show_request_id || 0);
      if (lastShowRequestId === null) {
        lastShowRequestId = nextRequestId;
        return;
      }
      if (nextRequestId !== lastShowRequestId) {
        lastShowRequestId = nextRequestId;
        showWindow();
      }
    } catch {
      // Polling resumes automatically when the local backend is back.
    }
  }, 1000);
}

function setWidgetMode(mode, options = {}) {
  if (!mainWindow) return;
  const size = mode === 'expanded' ? EXPANDED_SIZE : MINI_SIZE;
  mainWindow.setResizable(mode === 'expanded');
  mainWindow.setMinimumSize(mode === 'expanded' ? 380 : MINI_SIZE.width, mode === 'expanded' ? 560 : MINI_SIZE.height);
  mainWindow.setSize(size.width, size.height, true);
  if (!options.keepPosition && mode === 'mini') {
    positionWindow(mainWindow, MINI_SIZE);
  }
  if (mode === 'expanded') {
    mainWindow.setAlwaysOnTop(true, 'floating');
  }
  mainWindow.webContents.send('widget:mode', mode);
}

function sanitizeDimension(value, fallback, min, max) {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function resizeWindow(width, height) {
  if (!mainWindow) return { ok: false };
  const nextWidth = sanitizeDimension(width, EXPANDED_SIZE.width, MIN_WINDOW_SIZE.width, MAX_WINDOW_SIZE.width);
  const nextHeight = sanitizeDimension(height, EXPANDED_SIZE.height, MIN_WINDOW_SIZE.height, MAX_WINDOW_SIZE.height);
  mainWindow.setResizable(true);
  mainWindow.setMinimumSize(MIN_WINDOW_SIZE.width, MIN_WINDOW_SIZE.height);
  mainWindow.setSize(nextWidth, nextHeight, true);
  return { ok: true, width: nextWidth, height: nextHeight };
}

app.whenReady().then(() => {
  app.setName('Promptly');
  app.setLoginItemSettings({
    openAtLogin: true,
    openAsHidden: false,
  });
  createWindow();
  createTray();
  startDesktopWidgetRequestPolling();
});

app.on('window-all-closed', (event) => {
  event.preventDefault();
});

app.on('activate', () => {
  if (!mainWindow) createWindow();
  showWindow();
});

ipcMain.handle('widget:set-mode', (_event, mode) => {
  setWidgetMode(mode);
  return { ok: true, mode };
});

ipcMain.handle('widget:move-by', (_event, payload = {}) => {
  if (!mainWindow) return { ok: false };
  const deltaX = Number(payload.deltaX) || 0;
  const deltaY = Number(payload.deltaY) || 0;
  const [x, y] = mainWindow.getPosition();
  mainWindow.setPosition(Math.round(x + deltaX), Math.round(y + deltaY), false);
  return { ok: true };
});

ipcMain.handle('widget:resize', (_event, payload = {}) => {
  return resizeWindow(payload.width, payload.height);
});

ipcMain.handle('widget:hide', async () => {
  if (!mainWindow) return { ok: false };
  await markDesktopWidgetHidden(true);
  mainWindow.setAlwaysOnTop(false);
  mainWindow.setResizable(false);
  mainWindow.setMinimumSize(1, 1);
  mainWindow.setBounds({ x: -10000, y: -10000, width: 1, height: 1 }, false);
  mainWindow.hide();
  return { ok: true, hidden: true };
});

ipcMain.handle('widget:unhide', async () => {
  showWindow();
  return { ok: true, hidden: false };
});

ipcMain.handle('widget:minimize', () => {
  if (!mainWindow) return { ok: false };
  mainWindow.minimize();
  return { ok: true };
});

ipcMain.handle('widget:toggle-always-on-top', () => {
  if (!mainWindow) return { ok: false };
  const next = !mainWindow.isAlwaysOnTop();
  mainWindow.setAlwaysOnTop(next, 'floating');
  return { ok: true, alwaysOnTop: next };
});

ipcMain.handle('widget:notify', (_event, payload = {}) => {
  if (!Notification.isSupported()) return { ok: false };
  const notification = new Notification({
    title: String(payload.title || 'Promptly'),
    body: String(payload.body || 'Your focus session is complete.'),
  });
  notification.show();
  return { ok: true };
});
