// --- Application State ---
const state = {
  ra: 133.786245,
  dec: -7.244372,
  fov: 'medium', // small (2.5'), medium (5'), large (10')
  band: 'W2',
  slidingWindow: 0.30,
  blinkInterval: 650,
  zoom: 1.0,
  stretch: 1.15,
  blackPoint: -22,
  invert: false,
  maxDynamic: true,
  neowiseOnly: true,
  smoothScan: false,
  gaiaOverlay: true,
  diffImaging: false,
  vectorOverlay: true,
  currentEpochIndex: 0,
  isPlaying: true,
  speedMultiplier: 1,
  flagMode: false,
  flaggedObjects: [],
  panX: 0,
  panY: 0,
  isDragging: false,
  dragStartX: 0,
  dragStartY: 0
};

// --- SPHEREx / WISE Epoch Dataset ---
const epochs = [
  { id: 1, mjd: 57918.18, date: '2017-06-14 04:18 UTC', exp: 132.4, flux: 42843913.43 },
  { id: 2, mjd: 58102.40, date: '2017-12-15 19:42 UTC', exp: 130.1, flux: 42842617.23 },
  { id: 3, mjd: 58284.92, date: '2018-06-16 10:15 UTC', exp: 135.0, flux: 43843775.93 },
  { id: 4, mjd: 58470.20, date: '2018-12-18 01:22 UTC', exp: 128.8, flux: 42842377.37 },
  { id: 5, mjd: 58652.75, date: '2019-06-19 15:50 UTC', exp: 133.2, flux: 43842377.57 },
  { id: 6, mjd: 58838.05, date: '2019-12-21 07:05 UTC', exp: 131.5, flux: 43842577.57 }
];

// --- DOM Elements ---
const canvas = document.getElementById('skyCanvas');
const ctx = canvas.getContext('2d');
const raInput = document.getElementById('raInput');
const decInput = document.getElementById('decInput');
const searchSkyBtn = document.getElementById('searchSkyBtn');
const applyDefaultsBtn = document.getElementById('applyDefaultsBtn');
const bandSelect = document.getElementById('bandSelect');
const bandWavelengthBadge = document.getElementById('bandWavelengthBadge');
const slidingWindowSlider = document.getElementById('slidingWindowSlider');
const slidingWindowVal = document.getElementById('slidingWindowVal');
const blinkIntervalSlider = document.getElementById('blinkIntervalSlider');
const blinkIntervalVal = document.getElementById('blinkIntervalVal');
const zoomSlider = document.getElementById('zoomSlider');
const zoomVal = document.getElementById('zoomVal');
const stretchSlider = document.getElementById('stretchSlider');
const stretchVal = document.getElementById('stretchVal');
const blackPointSlider = document.getElementById('blackPointSlider');
const blackPointVal = document.getElementById('blackPointVal');
const chkInvert = document.getElementById('chkInvert');
const chkMaxDynamic = document.getElementById('chkMaxDynamic');
const chkNeowiseOnly = document.getElementById('chkNeowiseOnly');
const chkSmoothScan = document.getElementById('chkSmoothScan');
const chkGaiaOverlay = document.getElementById('chkGaiaOverlay');
const chkDiffImaging = document.getElementById('chkDiffImaging');
const chkVectorOverlay = document.getElementById('chkVectorOverlay');

const playPauseBtn = document.getElementById('playPauseBtn');
const pauseIcon = document.getElementById('pauseIcon');
const playIcon = document.getElementById('playIcon');
const playPauseText = document.getElementById('playPauseText');
const prevFrameBtn = document.getElementById('prevFrameBtn');
const nextFrameBtn = document.getElementById('nextFrameBtn');
const frameIndicatorLabel = document.getElementById('frameIndicatorLabel');
const frameTimestampLabel = document.getElementById('frameTimestampLabel');
const timelineNodesContainer = document.getElementById('timelineNodesContainer');
const timelineProgressFill = document.getElementById('timelineProgressFill');
const observationsList = document.getElementById('observationsList');

const flagModeBtn = document.getElementById('flagModeBtn');
const flagModeBtnText = document.getElementById('flagModeBtnText');
const flagModeIndicator = document.getElementById('flagModeIndicator');
const flaggedList = document.getElementById('flaggedList');
const flaggedCountBadge = document.getElementById('flaggedCountBadge');

const tutorialToggleBtn = document.getElementById('tutorialToggleBtn');
const tutorialBanner = document.getElementById('tutorialBanner');
const closeTutorialBtn = document.getElementById('closeTutorialBtn');

const infoModalBtn = document.getElementById('infoModalBtn');
const infoModal = document.getElementById('infoModal');
const closeInfoModalBtn = document.getElementById('closeInfoModalBtn');
const closeInfoModalBtnBottom = document.getElementById('closeInfoModalBtnBottom');

const samplePresetBtn = document.getElementById('samplePresetBtn');
const sampleMenu = document.getElementById('sampleMenu');
const currentSampleLabel = document.getElementById('currentSampleLabel');

const hudRaDec = document.getElementById('hudRaDec');
const hudFov = document.getElementById('hudFov');
const hudBandLabel = document.getElementById('hudBandLabel');
const hudEpochCounter = document.getElementById('hudEpochCounter');
const hudScaleBar = document.getElementById('hudScaleBar');
const hudObsDate = document.getElementById('hudObsDate');
const cursorCoordReadout = document.getElementById('cursorCoordReadout');
const resetViewBtn = document.getElementById('resetViewBtn');
const toggleLeftDrawerBtn = document.getElementById('toggleLeftDrawerBtn');
const leftSidebar = document.getElementById('leftSidebar');

let animationTimer = null;

// --- Initialization & Event Listeners ---
function init() {
  setupCanvasSize();
  renderTimelineNodes();
  renderObservationsList();
  bindEvents();
  startPlaybackLoop();
  drawSky();
}

function setupCanvasSize() {
  const container = canvas.parentElement;
  canvas.width = container.clientWidth * window.devicePixelRatio;
  canvas.height = container.clientHeight * window.devicePixelRatio;
  ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
}

window.addEventListener('resize', () => {
  setupCanvasSize();
  drawSky();
});

function showToast(message, isSuccess = true) {
  const banner = document.getElementById('toastBanner');
  const toastMsg = document.getElementById('toastMessage');
  const toastIcon = document.getElementById('toastIcon');
  toastMsg.textContent = message;
  toastIcon.className = `w-2.5 h-2.5 rounded-full shrink-0 ${isSuccess ? 'bg-teal-400' : 'bg-amber-400'}`;
  banner.classList.remove('opacity-0', 'translate-y-[-10px]');
  banner.classList.add('opacity-100', 'translate-y-0');
  setTimeout(() => {
    banner.classList.remove('opacity-100', 'translate-y-0');
    banner.classList.add('opacity-0', 'translate-y-[-10px]');
  }, 3500);
}

// --- Bind UI Events ---
function bindEvents() {
  toggleLeftDrawerBtn.addEventListener('click', () => {
    leftSidebar.classList.toggle('hidden');
  });

  samplePresetBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    sampleMenu.classList.toggle('hidden');
  });
  document.addEventListener('click', () => sampleMenu.classList.add('hidden'));

  document.querySelectorAll('.preset-item').forEach(item => {
    item.addEventListener('click', (e) => {
      const preset = e.currentTarget.getAttribute('data-preset');
      loadPreset(preset);
    });
  });

  document.querySelectorAll('.fov-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      document.querySelectorAll('.fov-btn').forEach(b => {
        b.className = 'fov-btn px-2.5 py-1 rounded-md text-[11px] font-medium text-slate-400 hover:text-white transition';
      });
      e.currentTarget.className = 'fov-btn px-2.5 py-1 rounded-md text-[11px] font-semibold bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 transition';
      state.fov = e.currentTarget.getAttribute('data-fov');
      updateHudInfo();
      drawSky();
    });
  });

  searchSkyBtn.addEventListener('click', () => {
    state.ra = parseFloat(raInput.value) || 0;
    state.dec = parseFloat(decInput.value) || 0;
    updateHudInfo();
    drawSky();
    showToast(`Centered viewport to RA: ${state.ra.toFixed(4)}°, Dec: ${state.dec.toFixed(4)}°`);
  });

  slidingWindowSlider.addEventListener('input', (e) => {
    state.slidingWindow = parseFloat(e.target.value);
    slidingWindowVal.textContent = state.slidingWindow.toFixed(2) + ' yrs';
  });

  blinkIntervalSlider.addEventListener('input', (e) => {
    state.blinkInterval = parseInt(e.target.value);
    blinkIntervalVal.textContent = state.blinkInterval + ' ms';
    if (state.isPlaying) {
      restartPlaybackLoop();
    }
  });

  zoomSlider.addEventListener('input', (e) => {
    state.zoom = parseFloat(e.target.value);
    zoomVal.textContent = state.zoom.toFixed(1) + 'x';
    drawSky();
  });

  stretchSlider.addEventListener('input', (e) => {
    state.stretch = parseFloat(e.target.value);
    stretchVal.textContent = state.stretch.toFixed(2);
    drawSky();
  });

  blackPointSlider.addEventListener('input', (e) => {
    state.blackPoint = parseInt(e.target.value);
    blackPointVal.textContent = `${state.blackPoint} to ${347 + state.blackPoint}`;
    drawSky();
  });

  chkInvert.addEventListener('change', (e) => { state.invert = e.target.checked; drawSky(); });
  chkMaxDynamic.addEventListener('change', (e) => { state.maxDynamic = e.target.checked; drawSky(); });
  chkNeowiseOnly.addEventListener('change', (e) => { state.neowiseOnly = e.target.checked; drawSky(); });
  chkSmoothScan.addEventListener('change', (e) => { state.smoothScan = e.target.checked; drawSky(); });
  chkGaiaOverlay.addEventListener('change', (e) => { state.gaiaOverlay = e.target.checked; drawSky(); });
  chkDiffImaging.addEventListener('change', (e) => { state.diffImaging = e.target.checked; drawSky(); });
  chkVectorOverlay.addEventListener('change', (e) => { state.vectorOverlay = e.target.checked; drawSky(); });

  bandSelect.addEventListener('change', (e) => {
    state.band = e.target.value;
    const wMap = { 'W2': '4.6 µm', 'W1': '3.4 µm', 'SPHEREx-B2': '1.63 µm', 'SPHEREx-B3': '2.41 µm' };
    bandWavelengthBadge.textContent = wMap[state.band] || '4.6 µm';
    hudBandLabel.textContent = `SPHEREx / ${state.band} · ${bandWavelengthBadge.textContent}`;
    drawSky();
  });

  applyDefaultsBtn.addEventListener('click', () => {
    state.zoom = 1.0;
    state.stretch = 1.15;
    state.blackPoint = -22;
    zoomSlider.value = 1.0;
    zoomVal.textContent = '1.0x';
    stretchSlider.value = 1.15;
    stretchVal.textContent = '1.15';
    blackPointSlider.value = -22;
    blackPointVal.textContent = '-22 to 347';
    state.panX = 0; state.panY = 0;
    drawSky();
    showToast('Reset viewer parameters to default science calibration.');
  });

  playPauseBtn.addEventListener('click', togglePlayback);
  prevFrameBtn.addEventListener('click', () => {
    state.currentEpochIndex = (state.currentEpochIndex - 1 + epochs.length) % epochs.length;
    updateEpochDisplay();
  });
  nextFrameBtn.addEventListener('click', () => {
    state.currentEpochIndex = (state.currentEpochIndex + 1) % epochs.length;
    updateEpochDisplay();
  });

  document.querySelectorAll('.speed-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      document.querySelectorAll('.speed-btn').forEach(b => {
        b.className = 'speed-btn px-2 py-1 rounded-md text-slate-400 hover:text-white transition';
      });
      e.currentTarget.className = 'speed-btn px-2 py-1 rounded-md bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 font-semibold transition';
      state.speedMultiplier = parseFloat(e.currentTarget.getAttribute('data-speed'));
      restartPlaybackLoop();
    });
  });

  flagModeBtn.addEventListener('click', () => {
    state.flagMode = !state.flagMode;
    if (state.flagMode) {
      flagModeBtn.className = 'px-3 py-1.5 rounded-lg bg-amber-500 text-space-950 font-bold text-xs flex items-center gap-1.5 shadow-lg shadow-amber-500/20 transition';
      flagModeBtnText.textContent = 'Exit Flag Mode';
      flagModeIndicator.classList.remove('hidden');
      canvas.classList.add('canvas-crosshair');
      canvas.classList.remove('canvas-grab');
    } else {
      flagModeBtn.className = 'px-3 py-1.5 rounded-lg bg-space-800 hover:bg-space-700 border border-space-600 text-xs font-semibold text-slate-100 flex items-center gap-1.5 transition';
      flagModeBtnText.textContent = 'Flag Moving Object';
      flagModeIndicator.classList.add('hidden');
      canvas.classList.remove('canvas-crosshair');
      canvas.classList.add('canvas-grab');
    }
  });

  tutorialToggleBtn.addEventListener('click', () => tutorialBanner.classList.toggle('hidden'));
  closeTutorialBtn.addEventListener('click', () => tutorialBanner.classList.add('hidden'));

  infoModalBtn.addEventListener('click', () => infoModal.classList.remove('hidden'));
  closeInfoModalBtn.addEventListener('click', () => infoModal.classList.add('hidden'));
  closeInfoModalBtnBottom.addEventListener('click', () => infoModal.classList.add('hidden'));
  infoModal.addEventListener('click', (e) => { if (e.target === infoModal) infoModal.classList.add('hidden'); });

  canvas.addEventListener('mousedown', (e) => {
    if (state.flagMode) {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      registerFlag(x, y);
      return;
    }
    state.isDragging = true;
    state.dragStartX = e.clientX - state.panX;
    state.dragStartY = e.clientY - state.panY;
  });

  window.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    if (mouseX >= 0 && mouseX <= rect.width && mouseY >= 0 && mouseY <= rect.height) {
      const approxRa = state.ra + (mouseX - rect.width / 2) * (0.002 / state.zoom);
      const approxDec = state.dec - (mouseY - rect.height / 2) * (0.002 / state.zoom);
      cursorCoordReadout.textContent = `Cursor: ${approxRa.toFixed(4)}°, ${approxDec.toFixed(4)}°`;
    }

    if (!state.isDragging || state.flagMode) return;
    state.panX = e.clientX - state.dragStartX;
    state.panY = e.clientY - state.dragStartY;
    drawSky();
  });

  window.addEventListener('mouseup', () => { state.isDragging = false; });

  resetViewBtn.addEventListener('click', () => {
    state.panX = 0; state.panY = 0; state.zoom = 1.0;
    zoomSlider.value = 1.0;
    zoomVal.textContent = '1.0x';
    drawSky();
    showToast('Reset viewport framing.');
  });
}

// --- Load Preset Fields ---
function loadPreset(presetKey) {
  if (presetKey === 'wise0855') {
    state.ra = 133.786245;
    state.dec = -7.244372;
    currentSampleLabel.textContent = 'Sample: WISE 0855';
    showToast('Loaded WISE 0855-0714 Brown Dwarf field.');
  } else if (presetKey === 'asteroid') {
    state.ra = 214.512800;
    state.dec = +14.882100;
    currentSampleLabel.textContent = 'Sample: 2024 NEO-K7';
    showToast('Loaded Fast Moving Asteroid field.');
  } else if (presetKey === 'stationary') {
    state.ra = 301.240000;
    state.dec = +38.415000;
    currentSampleLabel.textContent = 'Sample: Cygnus Calibration';
    showToast('Loaded Cygnus Calibration Field.');
  }
  raInput.value = state.ra;
  decInput.value = state.dec;
  updateHudInfo();
  drawSky();
}

function updateHudInfo() {
  hudRaDec.textContent = `RA: ${state.ra.toFixed(4)}° | Dec: ${state.dec.toFixed(4)}°`;
  const fovMap = { 'small': '2.5\' × 2.5\' (Small · 88")', 'medium': '5\' × 5\' (Medium · 176")', 'large': '10\' × 10\' (Large · 352")' };
  const scaleMap = { 'small': '0.5\'', 'medium': '1.0\'', 'large': '2.0\'' };
  hudFov.textContent = `FoV: ${fovMap[state.fov]}`;
  hudScaleBar.textContent = scaleMap[state.fov];
}

// --- Playback Loop Management ---
function startPlaybackLoop() {
  if (animationTimer) clearInterval(animationTimer);
  const interval = state.blinkInterval / state.speedMultiplier;
  animationTimer = setInterval(() => {
    if (state.isPlaying) {
      state.currentEpochIndex = (state.currentEpochIndex + 1) % epochs.length;
      updateEpochDisplay();
    }
  }, interval);
}

function restartPlaybackLoop() {
  startPlaybackLoop();
}

function togglePlayback() {
  state.isPlaying = !state.isPlaying;
  if (state.isPlaying) {
    pauseIcon.classList.remove('hidden');
    playIcon.classList.add('hidden');
    playPauseText.textContent = 'Pause';
  } else {
    pauseIcon.classList.add('hidden');
    playIcon.classList.remove('hidden');
    playPauseText.textContent = 'Play';
  }
}

function updateEpochDisplay() {
  const ep = epochs[state.currentEpochIndex];
  frameIndicatorLabel.textContent = `Frame ${state.currentEpochIndex + 1} of ${epochs.length}`;
  frameTimestampLabel.textContent = `${ep.date} · Exp ${ep.exp} s`;
  hudEpochCounter.textContent = `Epoch ${state.currentEpochIndex + 1} / ${epochs.length}`;
  hudObsDate.textContent = `OBS: ${ep.date}`;
  
  const pct = (state.currentEpochIndex / (epochs.length - 1)) * 100;
  timelineProgressFill.style.width = `${pct}%`;

  document.querySelectorAll('.timeline-node').forEach((node, idx) => {
    if (idx === state.currentEpochIndex) {
      node.className = 'timeline-node w-6 h-6 rounded-full bg-cyan-400 border-2 border-space-950 shadow-lg shadow-cyan-400/50 flex items-center justify-center text-[10px] font-bold text-space-950 transition transform scale-110';
    } else {
      node.className = 'timeline-node w-4 h-4 rounded-full bg-space-800 border border-space-600 hover:border-cyan-400 transition cursor-pointer';
    }
  });

  document.querySelectorAll('.obs-row').forEach((row, idx) => {
    if (idx === state.currentEpochIndex) {
      row.className = 'obs-row w-full text-left p-2.5 rounded-lg bg-cyan-500/15 border border-cyan-500/40 transition flex items-center justify-between cursor-pointer';
    } else {
      row.className = 'obs-row w-full text-left p-2.5 rounded-lg bg-space-900/90 hover:bg-space-800 border border-space-700/80 transition flex items-center justify-between cursor-pointer';
    }
  });

  drawSky();
}

function renderTimelineNodes() {
  timelineNodesContainer.innerHTML = '';
  epochs.forEach((ep, idx) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('data-index', idx);
    btn.className = idx === state.currentEpochIndex
      ? 'timeline-node w-6 h-6 rounded-full bg-cyan-400 border-2 border-space-950 shadow-lg shadow-cyan-400/50 flex items-center justify-center text-[10px] font-bold text-space-950 transition transform scale-110'
      : 'timeline-node w-4 h-4 rounded-full bg-space-800 border border-space-600 hover:border-cyan-400 transition cursor-pointer';
    btn.title = `Epoch ${idx + 1}: ${ep.date}`;
    btn.addEventListener('click', () => {
      state.currentEpochIndex = idx;
      updateEpochDisplay();
    });
    timelineNodesContainer.appendChild(btn);
  });
}

function renderObservationsList() {
  observationsList.innerHTML = '';
  epochs.forEach((ep, idx) => {
    const row = document.createElement('div');
    row.className = idx === state.currentEpochIndex
      ? 'obs-row w-full text-left p-2.5 rounded-lg bg-cyan-500/15 border border-cyan-500/40 transition flex items-center justify-between cursor-pointer'
      : 'obs-row w-full text-left p-2.5 rounded-lg bg-space-900/90 hover:bg-space-800 border border-space-700/80 transition flex items-center justify-between cursor-pointer';
    row.addEventListener('click', () => {
      state.currentEpochIndex = idx;
      updateEpochDisplay();
    });
    row.innerHTML = `
      <div class="flex flex-col gap-0.5">
        <span class="text-xs font-bold text-slate-200">Frame ${idx + 1}: ${ep.date.split(' ')[0]}</span>
        <span class="text-[10px] font-mono text-slate-400">MJD ${ep.mjd} · Exp ${ep.exp}s</span>
      </div>
      <span class="px-2 py-0.5 rounded bg-space-950 border border-space-700 text-[10px] font-mono text-cyan-300">${ep.flux}</span>
    `;
    observationsList.appendChild(row);
  });
}

// --- Flagging Candidate Objects ---
function registerFlag(mouseX, mouseY) {
  const rect = canvas.getBoundingClientRect();
  const cx = rect.width / 2 + state.panX;
  const cy = rect.height / 2 + state.panY;
  const relX = (mouseX - cx) / state.zoom;
  const relY = (mouseY - cy) / state.zoom;

  const flaggedRa = state.ra + relX * 0.002;
  const flaggedDec = state.dec - relY * 0.002;

  const newFlag = {
    id: state.flaggedObjects.length + 1,
    ra: flaggedRa.toFixed(5),
    dec: flaggedDec.toFixed(5),
    epoch: state.currentEpochIndex + 1,
    time: new Date().toLocaleTimeString()
  };

  state.flaggedObjects.push(newFlag);
  renderFlaggedList();
  showToast(`Flagged candidate #${newFlag.id} at RA ${newFlag.ra}°, Dec ${newFlag.dec}°`);
  
  state.flagMode = false;
  flagModeBtn.className = 'px-3 py-1.5 rounded-lg bg-space-800 hover:bg-space-700 border border-space-600 text-xs font-semibold text-slate-100 flex items-center gap-1.5 transition';
  flagModeBtnText.textContent = 'Flag Moving Object';
  flagModeIndicator.classList.add('hidden');
  canvas.classList.remove('canvas-crosshair');
  canvas.classList.add('canvas-grab');
  drawSky();
}

function renderFlaggedList() {
  flaggedCountBadge.textContent = `${state.flaggedObjects.length} logged`;
  if (state.flaggedObjects.length === 0) {
    flaggedList.innerHTML = '<p id="emptyFlagPlaceholder" class="text-[11px] text-slate-500 italic py-2 text-center">No objects flagged yet. Use "+ Flag Moving Object" to mark a candidate.</p>';
    return;
  }
  flaggedList.innerHTML = '';
  state.flaggedObjects.forEach((item) => {
    const div = document.createElement('div');
    div.className = 'flex items-center justify-between bg-space-900 border border-space-700 px-2.5 py-1.5 rounded-lg text-xs font-mono';
    div.innerHTML = `
      <div class="flex items-center gap-2">
        <span class="w-2 h-2 rounded-full bg-amber-400"></span>
        <div>
          <span class="text-amber-300 font-bold">#${item.id}</span>
          <span class="text-slate-300 ml-1.5">${item.ra}, ${item.dec}</span>
        </div>
      </div>
      <span class="text-[10px] text-slate-500">Ep ${item.epoch}</span>
    `;
    flaggedList.appendChild(div);
  });
}

// --- Realistic FITS Detector Sky Simulator Canvas Renderer ---
function drawSky() {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  ctx.clearRect(0, 0, width, height);

  ctx.fillStyle = state.invert ? '#f1f5f9' : '#070b14';
  ctx.fillRect(0, 0, width, height);

  ctx.save();
  ctx.translate(width / 2 + state.panX, height / 2 + state.panY);
  ctx.scale(state.zoom, state.zoom);

  const gridSize = 20;
  const cols = Math.ceil(width / gridSize / state.zoom) + 10;
  const rows = Math.ceil(height / gridSize / state.zoom) + 10;
  const startC = -Math.floor(cols / 2);
  const endC = Math.floor(cols / 2);
  const startR = -Math.floor(rows / 2);
  const endR = Math.floor(rows / 2);

  for (let r = startR; r < endR; r++) {
    for (let c = startC; c < endC; c++) {
      const noise = Math.sin(r * 12.9898 + c * 78.233 + state.currentEpochIndex * 3.14) * 43758.5453;
      const val = (noise - Math.floor(noise));
      
      if (!state.invert) {
        const shade = Math.floor(12 + val * 24 * state.stretch);
        ctx.fillStyle = `rgb(${shade}, ${shade + 6}, ${shade + 18})`;
      } else {
        const shade = Math.floor(230 - val * 22 * state.stretch);
        ctx.fillStyle = `rgb(${shade}, ${shade}, ${shade})`;
      }
      ctx.fillRect(c * gridSize, r * gridSize, gridSize - 1, gridSize - 1);
    }
  }

  const stars = [
    { x: -120, y: -80, size: 14, type: 'star' },
    { x: 180, y: -140, size: 22, type: 'galaxy', label: 'G' },
    { x: 90, y: 110, size: 12, type: 'star' },
    { x: -160, y: 130, size: 10, type: 'star' },
    { x: 220, y: 80, size: 16, type: 'star' }
  ];

  stars.forEach(s => {
    drawStarNode(ctx, s.x, s.y, s.size, s.type, s.label, !state.invert);
  });

  const stepX = (state.currentEpochIndex - 2.5) * 28;
  const stepY = (state.currentEpochIndex - 2.5) * 14;
  const targetX = -40 + stepX;
  const targetY = 50 + stepY;

  drawMovingTarget(ctx, targetX, targetY, !state.invert);

  if (state.gaiaOverlay) {
    drawGaiaOverlay(ctx, targetX, targetY);
  }

  state.flaggedObjects.forEach(f => {
    const fx = (parseFloat(f.ra) - state.ra) / 0.002;
    const fy = -(parseFloat(f.dec) - state.dec) / 0.002;
    drawFlagMarker(ctx, fx, fy, f.id);
  });

  ctx.restore();
}

function drawStarNode(context, x, y, size, type, label, isDarkSky) {
  context.save();
  context.shadowBlur = size * 1.5;
  context.shadowColor = isDarkSky ? 'rgba(56, 189, 248, 0.5)' : 'rgba(15, 23, 42, 0.3)';

  context.fillStyle = isDarkSky ? '#ffffff' : '#0f172a';
  context.beginPath();
  context.arc(x, y, size * 0.35, 0, Math.PI * 2);
  context.fill();

  context.strokeStyle = isDarkSky ? 'rgba(255, 255, 255, 0.7)' : 'rgba(15, 23, 42, 0.5)';
  context.lineWidth = 1.2;
  context.beginPath();
  context.moveTo(x - size, y); context.lineTo(x + size, y);
  context.moveTo(x, y - size); context.lineTo(x, y + size);
  context.stroke();

  if (label === 'G') {
    context.fillStyle = '#eab308';
    context.beginPath();
    context.arc(x + size + 6, y - size - 2, 8, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = '#000000';
    context.font = 'bold 9px Inter, sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText('G', x + size + 6, y - size - 2);
  }
  context.restore();
}

function drawMovingTarget(context, x, y, isDarkSky) {
  context.save();
  context.strokeStyle = '#38bdf8';
  context.lineWidth = 1.5;
  context.beginPath();
  context.arc(x, y, 16, 0, Math.PI * 2);
  context.stroke();

  context.fillStyle = '#38bdf8';
  context.beginPath();
  context.arc(x, y, 5, 0, Math.PI * 2);
  context.fill();

  context.fillStyle = '#0284c7';
  context.fillRect(x + 10, y - 18, 22, 14);
  context.fillStyle = '#ffffff';
  context.font = 'bold 9px Inter, sans-serif';
  context.textAlign = 'left';
  context.textBaseline = 'top';
  context.fillText('A1', x + 13, y - 16);

  context.strokeStyle = '#22d3ee';
  context.lineWidth = 2;
  context.beginPath();
  context.moveTo(x - 22, y + 22);
  context.lineTo(x - 8, y + 8);
  context.stroke();

  context.fillStyle = '#22d3ee';
  context.beginPath();
  context.moveTo(x - 8, y + 8);
  context.lineTo(x - 13, y + 6);
  context.lineTo(x - 6, y + 13);
  context.fill();

  context.restore();
}

function drawGaiaOverlay(context, x, y) {
  context.save();
  if (state.vectorOverlay) {
    context.strokeStyle = 'rgba(239, 68, 68, 0.7)';
    context.lineWidth = 1.5;
    context.setLineDash([3, 3]);
    context.beginPath();
    context.moveTo(x - 70, y + 35);
    context.lineTo(x, y);
    context.stroke();
  }

  context.strokeStyle = '#ef4444';
  context.lineWidth = 1.2;
  const boxSize = 14;
  context.strokeRect(x - boxSize, y - boxSize, boxSize * 2, boxSize * 2);

  context.fillStyle = '#0f172a';
  context.strokeStyle = '#ef4444';
  context.lineWidth = 1;
  context.fillRect(x + boxSize + 4, y - 10, 72, 18);
  context.strokeRect(x + boxSize + 4, y - 10, 72, 18);

  context.fillStyle = '#34d399';
  context.font = 'bold 9px JetBrains Mono, monospace';
  context.textAlign = 'left';
  context.textBaseline = 'middle';
  context.fillText('W18E 0855', x + boxSize + 8, y - 1);
  context.restore();
}

function drawFlagMarker(context, x, y, id) {
  context.save();
  context.strokeStyle = '#f59e0b';
  context.lineWidth = 2;
  context.beginPath();
  context.arc(x, y, 12, 0, Math.PI * 2);
  context.stroke();

  context.fillStyle = '#f59e0b';
  context.beginPath();
  context.arc(x, y, 3, 0, Math.PI * 2);
  context.fill();

  context.fillStyle = '#090d16';
  context.fillRect(x + 14, y - 8, 20, 14);
  context.strokeStyle = '#f59e0b';
  context.lineWidth = 1;
  context.strokeRect(x + 14, y - 8, 20, 14);

  context.fillStyle = '#f59e0b';
  context.font = 'bold 9px JetBrains Mono, monospace';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(`#${id}`, x + 24, y - 1);
  context.restore();
}

document.addEventListener('DOMContentLoaded', init);
