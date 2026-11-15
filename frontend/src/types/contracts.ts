/**
 * Phase 0 Immutable Shared Contracts for Star Hunters (Planet X & SPHEREx Blinker).
 *
 * Shared between Frontend Lead (atienosharzy-boop), Fullstack (Eddy-Odero, carsonak),
 * and Backend (14Emanuel, paowuor).
 */

import worldCapitalCities from './world_capital_cities.json' with { type: 'json' };

export type MissionName = 'SPHEREx' | 'WISE';
export type BinaryDtype = 'float32' | 'float16';
export type ComparisonMode = 'blink' | 'subtract' | 'coadd';
export type ContrastStretch = 'asinh' | 'linear' | 'zscale';
export type CatalogSourceType = 'gaia_dr3' | 'wise' | 'most' | 'simbad' | 'jpl_horizons';
export type CelestialObjectCategory =
  | 'star'
  | 'high_pm_star'
  | 'brown_dwarf_candidate'
  | 'solar_system'
  | 'variable_star'
  | 'infrared_source';
export type CelestialObjectClass =
  | 'star'
  | 'brown_dwarf'
  | 'planet'
  | 'moon'
  | 'comet'
  | 'asteroid'
  | 'galaxy'
  | 'nebula'
  | 'variable_star'
  | 'infrared_source';

export const GRID_WIDTH = 256;
export const GRID_HEIGHT = 256;
export const NUM_DETECTORS = 6;
export const PIXELS_PER_PLANE = GRID_WIDTH * GRID_HEIGHT; // 65,536
export const TOTAL_DETECTOR_VALUES = NUM_DETECTORS * PIXELS_PER_PLANE; // 393,216
export const BINARY_DETECTOR_FLOAT32_BYTES = TOTAL_DETECTOR_VALUES * 4; // 1,572,864
export const BINARY_DETECTOR_FLOAT16_BYTES = TOTAL_DETECTOR_VALUES * 2; // 786,432
export const BINARY_FLAGS_UINT8_BYTES = PIXELS_PER_PLANE; // 65,536

export const DETECTOR_WAVELENGTH_BOUNDS_UM: ReadonlyArray<readonly [number, number]> = [
  [0.75, 1.1], // Detector 1
  [1.1, 1.6], // Detector 2
  [1.6, 2.42], // Detector 3
  [2.42, 3.8], // Detector 4 (WISE W1 3.4 um fallback)
  [3.8, 4.4], // Detector 5 (WISE W2 4.6 um fallback)
  [4.4, 5.0], // Detector 6 (WISE W2 4.6 um fallback)
];

export const TRACKING_SQUARE_COLORS: readonly string[] = [
  '#00F5D4', // Cyan-Mint
  '#FFBE0B', // Solar Amber
  '#FF006E', // Magenta Pulse
  '#3A86FF', // Azure Blue
  '#FB5607', // Neon Tangerine
  '#8338EC', // Ultraviolet
  '#06D6A0', // Emerald
  '#FF9F1C', // Gold
  '#F15BB5', // Rose Pink
  '#00BBF9', // Sky Cyan
  '#9B5DE5', // Amethyst
  '#FEE440', // Lemon Flare
  '#2EC4B6', // Teal Glow
  '#E71D36', // Crimson Nova
  '#70E000', // Lime Pulsar
  '#FF5400', // Flame Orange
  '#4CC9F0', // Ice Blue
  '#F72585', // Hot Fuchsia
  '#B5179E', // Deep Orchid
  '#AACC00', // Chartreuse
] as const;

/**
 * Randomly select `count` distinct highlighter colors from `TRACKING_SQUARE_COLORS`,
 * prioritizing colors not currently in `usedColors` before cycling.
 */
export function pickDistinctHighlighterColors(
  count: number,
  usedColors: Iterable<string> = [],
  rng: () => number = Math.random,
): string[] {
  const usedSet = new Set(usedColors);
  const available = TRACKING_SQUARE_COLORS.filter((c) => !usedSet.has(c));
  const shuffle = (arr: string[]): string[] => {
    const copy = [...arr];
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = copy[i];
      copy[i] = copy[j];
      copy[j] = tmp;
    }
    return copy;
  };

  const result: string[] = [];
  let pool = shuffle(available);
  while (result.length < count) {
    if (pool.length === 0) {
      pool = shuffle([...TRACKING_SQUARE_COLORS]);
    }
    const nextColor = pool.pop();
    if (nextColor) {
      result.push(nextColor);
    }
  }
  return result;
}

export interface WorldCapitalCity {
  slug: string;
  city_name: string;
  country: string;
  lat: number;
  lon: number;
}

export const WORLD_CAPITAL_CITIES: ReadonlyArray<WorldCapitalCity> = worldCapitalCities;

export type WaypointTrackingStatus = 'tracked' | 'lost' | 'out_of_bounds' | 'low_snr';
export type TrackSummaryStatus = 'tracked' | 'partially_lost' | 'no_body_found';

export interface QueryInfo {
  ra: number;
  dec: number;
  fov_arcmin: number;
  grid_key: string;
  cached: boolean;
}

export interface TargetMetadata {
  slug: string;
  name: string;
  category: string;
  description: string;
  constellation: string;
}

export interface DataSourceSummary {
  primary_mission: MissionName;
  has_multi_epoch_spherex: boolean;
  uses_wise_fallback: boolean;
  baseline_days: number;
  status_note: string;
}

export interface WcsHeader {
  width: number;
  height: number;
  crval: [number, number];
  crpix: [number, number];
  cdelt: [number, number];
}

export interface EpochManifestEntry {
  epoch_id: string;
  label: string;
  mission: MissionName;
  mjd: number;
  iso_date: string;
  detectors_data_url: string;
  flags_mask_url: string;
  available_detectors: number[];
  binary_dtype?: BinaryDtype;
}

export interface KnownObjectEpochPosition {
  epoch_id: string;
  mjd: number;
  ra: number;
  dec: number;
  x: number;
  y: number;
}

export interface MotionVector {
  dx_px: number;
  dy_px: number;
  dra_arcsec: number;
  ddec_arcsec: number;
}

export interface KnownCelestialObject {
  object_id: string;
  label: string;
  catalog: CatalogSourceType;
  object_type: CelestialObjectCategory;
  object_class?: CelestialObjectClass | null;
  canonical_name?: string | null;
  otype?: string | null;
  ra: number;
  dec: number;
  x: number;
  y: number;
  magnitude: number | null;
  proper_motion_arcsec_yr: number | null;
  pmra_mas_yr?: number | null;
  pmdec_mas_yr?: number | null;
  parallax_mas?: number | null;
  w1_w2_color: number | null;
  default_checked: boolean;
  epoch_positions: KnownObjectEpochPosition[];
  motion_vector?: MotionVector | null;
  data_source?: string | null;
}

export interface GlobalKnownObjectEntry extends KnownCelestialObject {
  target_slug?: string;
  target_name?: string;
  constellation?: string;
  patch_ra?: number;
  patch_dec?: number;
  match_score?: number;
}

export interface GaiaDr3OverlayItem {
  source_id: string;
  ra: number;
  dec: number;
  x: number;
  y: number;
  g_mag: number;
  bp_rp: number | null;
  pmra: number | null;
  pmdec: number | null;
}

export interface WiseOverlayItem {
  source_id: string;
  ra: number;
  dec: number;
  x: number;
  y: number;
  w1_mag: number;
  w2_mag: number;
  w1_w2_color: number;
}

export interface MostOverlayItem {
  object_name: string;
  epoch_id: string;
  ra: number;
  dec: number;
  x: number;
  y: number;
  v_mag: number;
}

export interface CatalogOverlays {
  known_objects?: KnownCelestialObject[];
  gaia_dr3: GaiaDr3OverlayItem[];
  wise_sources: WiseOverlayItem[];
  most_solar_system: MostOverlayItem[];
  source_status?: Record<string, string> | null;
}

export interface SkyPatchManifest {
  query: QueryInfo;
  target_metadata: TargetMetadata;
  data_source_summary: DataSourceSummary;
  wcs: WcsHeader;
  epochs: EpochManifestEntry[];
  default_spectrum_url: string | null;
  catalog_overlays: CatalogOverlays;
}

export interface CatalogsResponse {
  query: QueryInfo;
  wcs: WcsHeader;
  catalog_overlays: CatalogOverlays;
}

export interface SpectrumChannel {
  band_index: number;
  detector: number;
  wavelength_um: number;
  flux: number;
  variance: number;
  flagged: boolean;
}

export interface MolecularFeature {
  molecule: string;
  min_um: number;
  max_um: number;
  label: string;
}

export interface SpectrumPayload {
  ra: number;
  dec: number;
  source_label: string;
  spectrum_origin: string;
  units: {
    wavelength: 'um';
    flux: 'MJy/sr';
  };
  channels: SpectrumChannel[];
  molecular_features: MolecularFeature[];
}

export interface EarthToSkyResponse {
  earth: {
    lat: number;
    lon: number;
    iso_time: string;
    city_name?: string | null;
    country?: string | null;
    is_fallback_capital?: boolean;
    cached?: boolean;
  };
  zenith_icrs: {
    ra: number;
    dec: number;
    constellation: string;
  };
}

export interface ViewportRenderSettings {
  mode: ComparisonMode;
  activeEpochIndex: number;
  passAIndex: number;
  passBIndex: number;
  coaddIndices: number[];
  wavelengthRangeUm: [number, number]; // [0.75, 5.0]
  contrastStretch: ContrastStretch;
  showGaiaOverlay: boolean;
  showWiseOverlay: boolean;
  showMostOverlay: boolean;
  showFlagsOverlay: boolean;
  checkedObjectIds: string[]; // IDs of known_objects checked in the Known Celestial Objects menu
  zoom: number; // Interactive viewport zoom factor (1.0 .. 8.0)
  panX: number; // Horizontal pan offset in 256x256 image pixels
  panY: number; // Vertical pan offset in 256x256 image pixels
}

export interface TracedWaypoint {
  epoch_id: string;
  epoch_index: number;
  mjd: number;
  iso_date: string;
  x: number;
  y: number;
  ra: number;
  dec: number;
  peak_flux: number;
  snr: number;
  status: WaypointTrackingStatus;
  visible: boolean;
}

export interface TracedObjectSummary {
  trackId: string;
  groupId: string; // Shared across branches when overlapped bodies at click separate across epochs
  branchIndex: number;
  totalBranchesInClick: number;
  isOverlappedAtOrigin: boolean;
  color: string; // Distinct color for this target's tracking square
  status: TrackSummaryStatus;
  statusMessage: string;
  originEpochIndex: number; // Frame index where the user clicked to detect the bright body
  clickX: number;
  clickY: number;
  originCentroidX: number;
  originCentroidY: number;
  ra: number;
  dec: number;
  x1: number;
  y1: number;
  xN: number;
  yN: number;
  waypoints: TracedWaypoint[]; // Backward (previous) and forward (future) frame detections
  lostEpochIds: string[]; // Epoch IDs where track was lost / low_snr / out_of_bounds
  properMotionArcsecPerYr: number;
  positionAngleDeg: number;
  matchedObjectId: string | null;
  matchedCatalog: CatalogSourceType | null;
  matchedLabel: string | null;
  isUncatalogedMover: boolean;
}

export interface ClickTrackingResult {
  status: TrackSummaryStatus;
  message: string;
  clickX: number;
  clickY: number;
  originEpochIndex: number;
  isOverlapped: boolean;
  tracks: TracedObjectSummary[];
}

export interface ClickDiagnosticInfo {
  clickX: number;
  clickY: number;
  epochIndex: number;
  status: TrackSummaryStatus;
  message: string;
  tracksAdded: number;
}

export interface SkyExplorerContextValue {
  // Active sky patch & progressive loading state
  activePresetSlug: string | null;
  coordinates: { ra: number; dec: number; fovArcmin: number };
  manifest: SkyPatchManifest | null;
  epochBuffers: Float32Array[][] | null; // [epochIndex][detector 0..5]
  flagsBuffers: Uint8Array[] | null; // [epochIndex]
  loadingState: {
    stage: 'idle' | 'loading_catalogs' | 'loading_cutouts' | 'ready' | 'error';
    message?: string;
    fromClientCache?: boolean;
  };
  // Playback & render settings (including pan & zoom)
  renderSettings: ViewportRenderSettings;
  updateRenderSettings: (partial: Partial<ViewportRenderSettings>) => void;
  setViewportZoomPan: (zoom: number, panX: number, panY: number) => void;
  resetViewportZoomPan: () => void;
  // Known celestial objects checkbox selection controls
  knownObjects: KnownCelestialObject[];
  objectHighlighterColors?: Record<string, string>;
  globalKnownObjects?: GlobalKnownObjectEntry[];
  toggleKnownObject: (objectId: string) => void;
  checkAllKnownObjects: () => void;
  uncheckAllKnownObjects: () => void;
  resetDefaultKnownObjects: () => void;
  focusAndTrackKnownObject?: (
    obj: KnownCelestialObject | GlobalKnownObjectEntry,
    targetSlug?: string,
  ) => void;
  // Playback transport
  playback: {
    isPlaying: boolean;
    isLooping: boolean; // MUST default to false
    fps: number;
    play: () => void;
    pause: () => void;
    stepForward: () => void;
    stepBackward: () => void;
    toggleLoop: () => void;
    setFps: (fps: number) => void;
  };
  // Selection, multi-spot & overlapped bright-body tracking & spectral inspection
  selectedObject: TracedObjectSummary | null;
  trackedTargets: TracedObjectSummary[];
  lastClickDiagnostic: ClickDiagnosticInfo | null;
  removeTrackedTarget: (trackId: string) => void;
  clearTrackedTargets: () => void;
  activeSpectrum: SpectrumPayload | null;
  isSpectrumLoading: boolean;
  // Navigation & interaction actions
  selectPreset: (slug: string) => void;
  navigateToCoordinates: (ra: number, dec: number, fovArcmin?: number) => void;
  inspectPixelOrCoord: (x: number, y: number, originEpochIndex?: number) => void;
}

// ---------------------------------------------------------------------------
// Pure Client-Side Helpers: 3G Float16/Float32 Decoding, Known-Object State,
// Pan/Zoom Coordinate Transforms, and Multi-Target / Overlapped Body Tracking
// ---------------------------------------------------------------------------

/**
 * Decode an IEEE 754 binary16 (uint16 bits) into a standard JS number (float32/float64).
 */
export function decodeFloat16Word(bits: number): number {
  const sign = (bits & 0x8000) !== 0 ? -1 : 1;
  const exp = (bits >> 10) & 0x1f;
  const frac = bits & 0x03ff;
  if (exp === 0) {
    // Subnormals (and signed zero). `sign * 0` preserves IEEE-754 negative zero.
    return frac === 0 ? sign * 0 : sign * Math.pow(2, -14) * (frac / 1024);
  }
  if (exp === 0x1f) {
    return frac === 0 ? sign * Infinity : NaN;
  }
  return sign * Math.pow(2, exp - 15) * (1 + frac / 1024);
}

/**
 * Lazily-built 65,536-entry lookup table so decoding a 786,432-byte float16
 * frame is a tight array lookup loop rather than 393,216 branch-heavy calls.
 */
let float16LookupTable: Float32Array | null = null;

function getFloat16LookupTable(): Float32Array {
  if (float16LookupTable) return float16LookupTable;
  const table = new Float32Array(0x10000);
  for (let bits = 0; bits < 0x10000; bits += 1) {
    table[bits] = decodeFloat16Word(bits);
  }
  float16LookupTable = table;
  return table;
}

/**
 * Decode a raw `pass_{N}.bin` ArrayBuffer (either float32 or 3G-compressed float16)
 * into 6 per-detector `Float32Array` planes of length 65,536 (256x256).
 */
export function decodeDetectorBinaryBuffer(
  buffer: ArrayBuffer,
  dtype: BinaryDtype = 'float32',
): Float32Array[] {
  let fullArray: Float32Array;
  if (dtype === 'float16' || buffer.byteLength === BINARY_DETECTOR_FLOAT16_BYTES) {
    if (buffer.byteLength !== BINARY_DETECTOR_FLOAT16_BYTES) {
      throw new Error(
        `Invalid float16 detector buffer length: expected ${BINARY_DETECTOR_FLOAT16_BYTES}, got ${buffer.byteLength}`,
      );
    }
    const words = new Uint16Array(buffer);
    const table = getFloat16LookupTable();
    fullArray = new Float32Array(TOTAL_DETECTOR_VALUES);
    for (let i = 0; i < TOTAL_DETECTOR_VALUES; i += 1) {
      fullArray[i] = table[words[i]];
    }
  } else {
    if (buffer.byteLength !== BINARY_DETECTOR_FLOAT32_BYTES) {
      throw new Error(
        `Invalid float32 detector buffer length: expected ${BINARY_DETECTOR_FLOAT32_BYTES}, got ${buffer.byteLength}`,
      );
    }
    fullArray = new Float32Array(buffer);
  }

  const planes: Float32Array[] = [];
  for (let d = 0; d < NUM_DETECTORS; d += 1) {
    const start = d * PIXELS_PER_PLANE;
    planes.push(fullArray.subarray(start, start + PIXELS_PER_PLANE));
  }
  return planes;
}

/**
 * Decode a raw `pass_{N}_flags.bin` ArrayBuffer into a 256x256 `Uint8Array`.
 */
export function decodeFlagsBinaryBuffer(buffer: ArrayBuffer): Uint8Array {
  if (buffer.byteLength !== BINARY_FLAGS_UINT8_BYTES) {
    throw new Error(
      `Invalid flags buffer length: expected ${BINARY_FLAGS_UINT8_BYTES}, got ${buffer.byteLength}`,
    );
  }
  return new Uint8Array(buffer);
}

/**
 * Compute the quantized 0.05-degree spatial grid key matching the backend `compute_grid_key`.
 */
export function computeGridKey(
  ra: number,
  dec: number,
  fovArcmin: number = 5.0,
  gridStepDeg: number = 0.05,
): string {
  const normalizedRa = ((ra % 360.0) + 360.0) % 360.0;
  const clampedDec = Math.max(-90.0, Math.min(90.0, dec));
  const raQ =
    ((Number((Math.round(normalizedRa / gridStepDeg) * gridStepDeg).toFixed(2)) % 360.0) + 360.0) %
    360.0;
  const decQ = Number((Math.round(clampedDec / gridStepDeg) * gridStepDeg).toFixed(2));
  const fovQ = Number(fovArcmin.toFixed(1));
  return `ra${raQ.toFixed(2)}_dec${decQ.toFixed(2)}_fov${fovQ.toFixed(1)}`;
}

/**
 * Compute default checked object IDs from `known_objects` (keeping only default_checked items).
 */
export function getDefaultCheckedObjectIds(knownObjects: KnownCelestialObject[]): string[] {
  return knownObjects.filter((obj) => obj.default_checked).map((obj) => obj.object_id);
}

/**
 * Clamp interactive viewport zoom (1.0 .. 8.0) and pan offsets (in 256x256 image pixels)
 * so the visible window stays within [0, 256] x [0, 256].
 */
export function clampViewportPanZoom(
  zoom: number,
  panX: number,
  panY: number,
): { zoom: number; panX: number; panY: number } {
  const safeZoom = Number.isFinite(zoom) ? Math.max(1.0, Math.min(8.0, zoom)) : 1.0;
  const maxPan = Math.max(0, (GRID_WIDTH - GRID_WIDTH / safeZoom) / 2);
  const safePanX = Number.isFinite(panX) ? Math.max(-maxPan, Math.min(maxPan, panX)) : 0;
  const safePanY = Number.isFinite(panY) ? Math.max(-maxPan, Math.min(maxPan, panY)) : 0;
  return {
    zoom: Number(safeZoom.toFixed(3)),
    panX: Number(safePanX.toFixed(2)),
    panY: Number(safePanY.toFixed(2)),
  };
}

/**
 * Compute the active visible sub-region in 256x256 image coordinates for a given (zoom, panX, panY).
 */
export function computeViewportViewBox(
  zoom: number = 1.0,
  panX: number = 0.0,
  panY: number = 0.0,
): {
  minX: number;
  minY: number;
  viewWidth: number;
  viewHeight: number;
  svgViewBox: string;
} {
  const clamped = clampViewportPanZoom(zoom, panX, panY);
  const viewWidth = GRID_WIDTH / clamped.zoom;
  const viewHeight = GRID_HEIGHT / clamped.zoom;
  const minX = GRID_WIDTH / 2 + clamped.panX - viewWidth / 2;
  const minY = GRID_HEIGHT / 2 + clamped.panY - viewHeight / 2;
  return {
    minX: Number(minX.toFixed(3)),
    minY: Number(minY.toFixed(3)),
    viewWidth: Number(viewWidth.toFixed(3)),
    viewHeight: Number(viewHeight.toFixed(3)),
    svgViewBox: `${minX.toFixed(3)} ${minY.toFixed(3)} ${viewWidth.toFixed(3)} ${viewHeight.toFixed(3)}`,
  };
}

/**
 * Inverse-transform a pointer click (clientX, clientY) on a zoomed/panned viewport element
 * back into exact (0..256, 0..256) sky patch image coordinates.
 */
export function screenToImageCoordinates(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number },
  zoom: number = 1.0,
  panX: number = 0.0,
  panY: number = 0.0,
): { x: number; y: number; inBounds: boolean } {
  if (rect.width <= 0 || rect.height <= 0) {
    return { x: 0, y: 0, inBounds: false };
  }
  const u = (clientX - rect.left) / rect.width;
  const v = (clientY - rect.top) / rect.height;
  const { minX, minY, viewWidth, viewHeight } = computeViewportViewBox(zoom, panX, panY);
  const x = Number((minX + u * viewWidth).toFixed(2));
  const y = Number((minY + v * viewHeight).toFixed(2));
  const inBounds =
    u >= 0 && u <= 1 && v >= 0 && v <= 1 && x >= 0 && x < GRID_WIDTH && y >= 0 && y < GRID_HEIGHT;
  return { x, y, inBounds };
}

/**
 * Convert pixel (x, y) to sky (ra, dec) using the patch's TAN WCS header.
 */
export function pixelToSkyWcs(x: number, y: number, wcs: WcsHeader): { ra: number; dec: number } {
  const [ra0, dec0] = wcs.crval;
  const [x0, y0] = wcs.crpix;
  const [cdeltX, cdeltY] = wcs.cdelt;
  const cosDec = Math.max(0.01, Math.cos((dec0 * Math.PI) / 180.0));
  const ra = (((ra0 + ((x - x0) * cdeltX) / cosDec) % 360.0) + 360.0) % 360.0;
  const dec = Math.max(-90.0, Math.min(90.0, dec0 + (y - y0) * cdeltY));
  return { ra: Number(ra.toFixed(5)), dec: Number(dec.toFixed(5)) };
}

/**
 * Compute detector weights for the active wavelength range [minUm, maxUm].
 */
export function computeDetectorWeights(wavelengthRangeUm: [number, number]): number[] {
  const [minUm, maxUm] = wavelengthRangeUm;
  return DETECTOR_WAVELENGTH_BOUNDS_UM.map(([dMin, dMax]) => {
    const overlap = Math.max(0, Math.min(maxUm, dMax) - Math.max(minUm, dMin));
    const width = dMax - dMin;
    const ratio = width > 0 ? overlap / width : 0;
    return 0.05 + 0.95 * ratio;
  });
}

interface CentroidDetection {
  x: number;
  y: number;
  peakFlux: number;
  netFlux: number;
  snr: number;
}

/**
 * Detect all bodies at or near (clickX, clickY) on `originEpochIndex` — including
 * "overlapped" bodies that are blended at `originEpochIndex` and separate in earlier
 * or later epochs — and track each body across all epochs with distinct tracking square
 * colors and full edge-case handling (`no_body_found`, `lost`, `low_snr`, `out_of_bounds`).
 */
export function detectAndTrackBodiesAtClick(params: {
  clickX: number;
  clickY: number;
  originEpochIndex: number;
  epochBuffers: Float32Array[][];
  manifest: SkyPatchManifest;
  wavelengthRangeUm: [number, number];
  localRadiusPx?: number;
  crossEpochSearchRadiusPx?: number;
  minSnrThreshold?: number;
  colorIndexOffset?: number;
}): ClickTrackingResult {
  const {
    clickX,
    clickY,
    originEpochIndex,
    epochBuffers,
    manifest,
    wavelengthRangeUm,
    localRadiusPx = 6,
    crossEpochSearchRadiusPx = 18,
    minSnrThreshold = 3.0,
    colorIndexOffset = 0,
  } = params;

  const numEpochs = Math.min(epochBuffers.length, manifest.epochs.length);
  const clampedOrigin = Math.max(0, Math.min(Math.max(0, numEpochs - 1), originEpochIndex));

  if (
    numEpochs === 0 ||
    !Number.isFinite(clickX) ||
    !Number.isFinite(clickY) ||
    clickX < 0 ||
    clickX >= GRID_WIDTH ||
    clickY < 0 ||
    clickY >= GRID_HEIGHT
  ) {
    return {
      status: 'no_body_found',
      message: 'Clicked coordinates are outside the 256x256 sky patch bounds.',
      clickX,
      clickY,
      originEpochIndex: clampedOrigin,
      isOverlapped: false,
      tracks: [],
    };
  }

  const weights = computeDetectorWeights(wavelengthRangeUm);

  // Build composite weighted brightness image for each epoch
  const compositeFrames: Float32Array[] = epochBuffers.slice(0, numEpochs).map((detPlanes) => {
    const comp = new Float32Array(PIXELS_PER_PLANE);
    for (let d = 0; d < Math.min(NUM_DETECTORS, detPlanes.length); d += 1) {
      const w = weights[d];
      const plane = detPlanes[d];
      for (let i = 0; i < PIXELS_PER_PLANE; i += 1) {
        comp[i] += w * plane[i];
      }
    }
    return comp;
  });

  const findLocalPeakAndCentroid = (
    comp: Float32Array,
    centerX: number,
    centerY: number,
    searchRadius: number,
  ): CentroidDetection => {
    const xMin = Math.max(1, Math.floor(centerX - searchRadius));
    const xMax = Math.min(GRID_WIDTH - 2, Math.ceil(centerX + searchRadius));
    const yMin = Math.max(1, Math.floor(centerY - searchRadius));
    const yMax = Math.min(GRID_HEIGHT - 2, Math.ceil(centerY + searchRadius));

    let peakX = Math.round(Math.max(0, Math.min(GRID_WIDTH - 1, centerX)));
    let peakY = Math.round(Math.max(0, Math.min(GRID_HEIGHT - 1, centerY)));
    let peakVal = -Infinity;
    const rSq = searchRadius * searchRadius;

    for (let py = yMin; py <= yMax; py += 1) {
      const dy = py - centerY;
      for (let px = xMin; px <= xMax; px += 1) {
        const dx = px - centerX;
        if (dx * dx + dy * dy <= rSq) {
          const val = comp[py * GRID_WIDTH + px];
          if (val > peakVal) {
            peakVal = val;
            peakX = px;
            peakY = py;
          }
        }
      }
    }

    if (!Number.isFinite(peakVal)) {
      peakVal = comp[peakY * GRID_WIDTH + peakX] ?? 0;
    }

    // Estimate local background from annulus (radius 5..8 around peak)
    let bgSum = 0;
    let bgSqSum = 0;
    let bgCount = 0;
    for (let py = Math.max(0, peakY - 8); py <= Math.min(GRID_HEIGHT - 1, peakY + 8); py += 1) {
      for (let px = Math.max(0, peakX - 8); px <= Math.min(GRID_WIDTH - 1, peakX + 8); px += 1) {
        const d2 = (px - peakX) * (px - peakX) + (py - peakY) * (py - peakY);
        if (d2 >= 25 && d2 <= 64) {
          const v = comp[py * GRID_WIDTH + px];
          bgSum += v;
          bgSqSum += v * v;
          bgCount += 1;
        }
      }
    }
    const bgMean = bgCount > 0 ? bgSum / bgCount : 0;
    const bgVar = bgCount > 1 ? Math.max(1e-6, bgSqSum / bgCount - bgMean * bgMean) : 1e-4;
    const bgStd = Math.sqrt(bgVar);

    // 5x5 flux-weighted centroid around peak
    let sumFlux = 0;
    let sumX = 0;
    let sumY = 0;
    let aperturePixelCount = 0;
    for (let py = Math.max(0, peakY - 2); py <= Math.min(GRID_HEIGHT - 1, peakY + 2); py += 1) {
      for (let px = Math.max(0, peakX - 2); px <= Math.min(GRID_WIDTH - 1, peakX + 2); px += 1) {
        const net = Math.max(0, comp[py * GRID_WIDTH + px] - bgMean);
        sumFlux += net;
        sumX += px * net;
        sumY += py * net;
        aperturePixelCount += 1;
      }
    }

    const centroidX = sumFlux > 1e-5 ? sumX / sumFlux : peakX;
    const centroidY = sumFlux > 1e-5 ? sumY / sumFlux : peakY;
    const netFlux = Math.max(0, peakVal - bgMean);

    // Aperture significance: a single-pixel noise spike must not clear the SNR gate.
    // Subtract the rectification bias of max(0, noise) over the 5x5 aperture, then
    // divide by the noise integrated over the aperture (bgStd * sqrt(N_pix)).
    const rectifiedNoiseBias = 0.3989422804014327 * bgStd * aperturePixelCount;
    const apertureSignal = Math.max(0, sumFlux - rectifiedNoiseBias);
    const apertureNoise = bgStd * Math.sqrt(Math.max(1, aperturePixelCount));
    const snr = Math.max(0, apertureSignal / apertureNoise);
    return {
      x: Number(centroidX.toFixed(2)),
      y: Number(centroidY.toFixed(2)),
      peakFlux: Number(peakVal.toFixed(4)),
      netFlux: Number(netFlux.toFixed(4)),
      snr: Number(snr.toFixed(2)),
    };
  };

  // 1. Detect the bright body on the clicked origin epoch
  const originDetection = findLocalPeakAndCentroid(
    compositeFrames[clampedOrigin],
    clickX,
    clickY,
    localRadiusPx,
  );

  // Edge Case: Unable to identify any bright body above background noise at the clicked location
  if (originDetection.snr < minSnrThreshold || originDetection.netFlux <= 0.04) {
    return {
      status: 'no_body_found',
      message: `No bright body identified near (${clickX.toFixed(1)}, ${clickY.toFixed(1)}) on Pass ${clampedOrigin + 1} (SNR ${originDetection.snr.toFixed(1)} < ${minSnrThreshold.toFixed(1)}).`,
      clickX,
      clickY,
      originEpochIndex: clampedOrigin,
      isOverlapped: false,
      tracks: [],
    };
  }

  // Positive difference frames relative to the origin epoch cancel stationary field stars (~98%)
  // when tracking a body (or multiple overlapped bodies) that moved away from the origin position.
  const transientDifferenceFrames: Float32Array[] = compositeFrames.map((comp, epIdx) => {
    if (numEpochs < 2 || epIdx === clampedOrigin) {
      return comp;
    }
    const diffFrame = new Float32Array(PIXELS_PER_PLANE);
    const originComp = compositeFrames[clampedOrigin];
    for (let i = 0; i < PIXELS_PER_PLANE; i += 1) {
      diffFrame[i] = Math.max(0, comp[i] - 0.98 * originComp[i]);
    }
    return diffFrame;
  });

  // Helper to find all distinct separated moving peaks in a target epoch's transient difference frame
  const findSeparatedMovingPeaks = (
    targetEpochIdx: number,
    searchCenterX: number,
    searchCenterY: number,
    searchRadius: number,
    minSeparationPx: number = 3.0,
  ): CentroidDetection[] => {
    const diffComp = transientDifferenceFrames[targetEpochIdx];
    const rawComp = compositeFrames[targetEpochIdx];
    const xMin = Math.max(2, Math.floor(searchCenterX - searchRadius));
    const xMax = Math.min(GRID_WIDTH - 3, Math.ceil(searchCenterX + searchRadius));
    const yMin = Math.max(2, Math.floor(searchCenterY - searchRadius));
    const yMax = Math.min(GRID_HEIGHT - 3, Math.ceil(searchCenterY + searchRadius));
    const rSq = searchRadius * searchRadius;

    const candidates: { px: number; py: number; diffVal: number }[] = [];
    const minDiffFlux = Math.max(0.05, 0.14 * originDetection.netFlux);

    for (let py = yMin; py <= yMax; py += 1) {
      const dy = py - searchCenterY;
      for (let px = xMin; px <= xMax; px += 1) {
        const dx = px - searchCenterX;
        if (dx * dx + dy * dy > rSq) continue;
        // Must have moved away from the origin centroid by at least 2.2 px
        if (Math.hypot(px - originDetection.x, py - originDetection.y) < 2.2) continue;

        const val = diffComp[py * GRID_WIDTH + px];
        if (val < minDiffFlux) continue;

        // Check 3x3 local maximum
        let isLocalMax = true;
        for (let ny = py - 1; ny <= py + 1 && isLocalMax; ny += 1) {
          for (let nx = px - 1; nx <= px + 1; nx += 1) {
            if (nx === px && ny === py) continue;
            if (diffComp[ny * GRID_WIDTH + nx] > val) {
              isLocalMax = false;
              break;
            }
          }
        }
        if (isLocalMax) {
          candidates.push({ px, py, diffVal: val });
        }
      }
    }

    candidates.sort((a, b) => b.diffVal - a.diffVal);

    const refinedPeaks: CentroidDetection[] = [];
    for (const cand of candidates) {
      const refined = findLocalPeakAndCentroid(rawComp, cand.px, cand.py, 2.2);
      if (
        refined.snr < minSnrThreshold ||
        refined.netFlux < Math.max(0.04, 0.14 * originDetection.netFlux) ||
        Math.hypot(refined.x - originDetection.x, refined.y - originDetection.y) < 2.2
      ) {
        continue;
      }
      const tooClose = refinedPeaks.some(
        (existing) => Math.hypot(existing.x - refined.x, existing.y - refined.y) < minSeparationPx,
      );
      if (!tooClose) {
        refinedPeaks.push(refined);
      }
    }
    return refinedPeaks;
  };

  // Check if a stationary body remains at a given (refX, refY) across other epochs
  const checkStationaryAtSpot = (
    targetEpochIdx: number,
    refX: number = originDetection.x,
    refY: number = originDetection.y,
    refNetFlux: number = originDetection.netFlux,
  ): CentroidDetection | null => {
    const cand = findLocalPeakAndCentroid(compositeFrames[targetEpochIdx], refX, refY, 2.2);
    const dist = Math.hypot(cand.x - refX, cand.y - refY);
    if (
      dist <= 1.4 &&
      cand.snr >= minSnrThreshold &&
      cand.netFlux >= Math.max(0.04, 0.15 * refNetFlux)
    ) {
      return cand;
    }
    return null;
  };

  // Also detect any secondary local peaks within the clicked area (`localRadiusPx`) on `originEpochIndex`
  // so partially separated / close overlapped bodies in the area of clicking are also tracked.
  const findSecondaryOriginPeaks = (): CentroidDetection[] => {
    const originComp = compositeFrames[clampedOrigin];
    const xMin = Math.max(2, Math.floor(clickX - localRadiusPx));
    const xMax = Math.min(GRID_WIDTH - 3, Math.ceil(clickX + localRadiusPx));
    const yMin = Math.max(2, Math.floor(clickY - localRadiusPx));
    const yMax = Math.min(GRID_HEIGHT - 3, Math.ceil(clickY + localRadiusPx));
    const rSq = localRadiusPx * localRadiusPx;
    const minPeakNet = Math.max(0.05, 0.2 * originDetection.netFlux);

    const rawCandidates: { px: number; py: number; val: number }[] = [];
    for (let py = yMin; py <= yMax; py += 1) {
      const dy = py - clickY;
      for (let px = xMin; px <= xMax; px += 1) {
        const dx = px - clickX;
        if (dx * dx + dy * dy > rSq) continue;
        if (Math.hypot(px - originDetection.x, py - originDetection.y) < 2.2) continue;
        const val = originComp[py * GRID_WIDTH + px];
        if (val < minPeakNet) continue;

        let isMax = true;
        for (let ny = py - 1; ny <= py + 1 && isMax; ny += 1) {
          for (let nx = px - 1; nx <= px + 1; nx += 1) {
            if (nx === px && ny === py) continue;
            if (originComp[ny * GRID_WIDTH + nx] > val) {
              isMax = false;
              break;
            }
          }
        }
        if (isMax) {
          rawCandidates.push({ px, py, val });
        }
      }
    }

    rawCandidates.sort((a, b) => b.val - a.val);
    const secondaries: CentroidDetection[] = [];
    for (const c of rawCandidates) {
      const refined = findLocalPeakAndCentroid(originComp, c.px, c.py, 1.8);
      if (
        refined.snr < minSnrThreshold ||
        refined.netFlux < minPeakNet ||
        Math.hypot(refined.x - originDetection.x, refined.y - originDetection.y) < 2.2
      ) {
        continue;
      }
      if (!secondaries.some((s) => Math.hypot(s.x - refined.x, s.y - refined.y) < 2.5)) {
        secondaries.push(refined);
      }
    }
    return secondaries;
  };

  // Discover trajectory branches (supporting single body OR overlapped bodies that separate in earlier/later epochs)
  interface BranchSeed {
    kind: 'moving' | 'stationary';
    originPeak: CentroidDetection;
    seedEpochIdx: number;
    seedDetection: CentroidDetection;
  }

  const branchSeeds: BranchSeed[] = [];

  if (numEpochs >= 2) {
    const secondaryOriginPeaks = findSecondaryOriginPeaks();
    const peaksByEpoch = new Map<number, CentroidDetection[]>();
    let bestSepEpochIdx = -1;
    let bestSepPeaks: CentroidDetection[] = [];
    let hasStationaryInAnyOtherEpoch = false;
    let stationaryDroppedFlux = false;

    for (let epIdx = 0; epIdx < numEpochs; epIdx += 1) {
      if (epIdx === clampedOrigin) continue;
      const stat = checkStationaryAtSpot(
        epIdx,
        originDetection.x,
        originDetection.y,
        originDetection.netFlux,
      );
      if (stat) {
        hasStationaryInAnyOtherEpoch = true;
        if (stat.netFlux <= 0.85 * originDetection.netFlux) {
          stationaryDroppedFlux = true;
        }
      }
      // Also check the departure difference (`originComp - 0.98 * comp[epIdx]`) inside `localRadiusPx`
      // of `(clickX, clickY)`: if a moving body was blended or partially overlapped with a stationary
      // star in the clicked area at `originEpochIndex` and departed in `epIdx`, subtracting `comp[epIdx]`
      // cancels the stationary star and reveals the departing body's positive flux residual in the click area.
      const originComp = compositeFrames[clampedOrigin];
      const targetComp = compositeFrames[epIdx];
      const xMin = Math.max(1, Math.floor(clickX - localRadiusPx));
      const xMax = Math.min(GRID_WIDTH - 2, Math.ceil(clickX + localRadiusPx));
      const yMin = Math.max(1, Math.floor(clickY - localRadiusPx));
      const yMax = Math.min(GRID_HEIGHT - 2, Math.ceil(clickY + localRadiusPx));
      const rSq = localRadiusPx * localRadiusPx;
      let maxDepartFlux = 0;
      for (let py = yMin; py <= yMax; py += 1) {
        const dy = py - clickY;
        for (let px = xMin; px <= xMax; px += 1) {
          const dx = px - clickX;
          if (dx * dx + dy * dy > rSq) continue;
          const dep = originComp[py * GRID_WIDTH + px] - 0.98 * targetComp[py * GRID_WIDTH + px];
          if (dep > maxDepartFlux) {
            maxDepartFlux = dep;
          }
        }
      }
      if (maxDepartFlux >= Math.max(0.05, 0.18 * originDetection.netFlux)) {
        stationaryDroppedFlux = true;
      }

      const stepFactor = Math.max(1, Math.abs(epIdx - clampedOrigin));
      const peaks = findSeparatedMovingPeaks(
        epIdx,
        originDetection.x,
        originDetection.y,
        crossEpochSearchRadiusPx * stepFactor,
      );
      peaksByEpoch.set(epIdx, peaks);
      if (peaks.length > bestSepPeaks.length) {
        bestSepPeaks = peaks;
        bestSepEpochIdx = epIdx;
      }
    }

    // Helper: check whether a candidate peak in `epIdx` is already explained by an existing moving BranchSeed
    const isExplainedByExistingMovingSeed = (
      candPeak: CentroidDetection,
      epIdx: number,
    ): boolean => {
      const mjdTarget = manifest.epochs[epIdx].mjd;
      const mjdOrigin = manifest.epochs[clampedOrigin].mjd;
      const predictions: Array<{ x: number; y: number }> = [];
      for (const existing of branchSeeds) {
        if (existing.kind !== 'moving') continue;
        if (existing.seedEpochIdx === epIdx) {
          if (
            Math.hypot(
              existing.seedDetection.x - candPeak.x,
              existing.seedDetection.y - candPeak.y,
            ) < 3.5
          ) {
            return true;
          }
          continue;
        }
        const dtSeed = manifest.epochs[existing.seedEpochIdx].mjd - mjdOrigin;
        const dtTarget = mjdTarget - mjdOrigin;
        if (Math.abs(dtSeed) > 1e-3) {
          const predX =
            existing.originPeak.x +
            ((existing.seedDetection.x - existing.originPeak.x) / dtSeed) * dtTarget;
          const predY =
            existing.originPeak.y +
            ((existing.seedDetection.y - existing.originPeak.y) / dtSeed) * dtTarget;
          if (Math.hypot(predX - candPeak.x, predY - candPeak.y) < 4.5) {
            return true;
          }
          predictions.push({ x: predX, y: predY });
        }
      }

      // A single widened detection can be the blended centroid of two already-known
      // branches (e.g. two overlapping movers that separate in the clicked epoch but
      // merge again in this one). If the candidate sits on the segment between two
      // predicted branch positions, treat it as the same bodies rather than a new one.
      for (let i = 0; i < predictions.length; i += 1) {
        for (let j = i + 1; j < predictions.length; j += 1) {
          const a = predictions[i];
          const b = predictions[j];
          const segX = b.x - a.x;
          const segY = b.y - a.y;
          const segLenSq = segX * segX + segY * segY;
          if (segLenSq < 20.0) continue;
          const t = Math.max(
            0,
            Math.min(1, ((candPeak.x - a.x) * segX + (candPeak.y - a.y) * segY) / segLenSq),
          );
          const closestX = a.x + t * segX;
          const closestY = a.y + t * segY;
          if (Math.hypot(candPeak.x - closestX, candPeak.y - closestY) <= 2.2) {
            return true;
          }
        }
      }
      return false;
    };

    // Match each separated moving peak to the closest origin peak in the clicked area
    const pickOriginPeakForMover = (
      moverPeak: CentroidDetection,
      epIdx: number,
    ): CentroidDetection => {
      if (secondaryOriginPeaks.length === 0) return originDetection;
      const allOriginPeaks = [originDetection, ...secondaryOriginPeaks];
      // Prefer an origin peak that lost flux in `epIdx` (because the mover departed from it)
      const departingOrigins = allOriginPeaks.filter((op) => {
        const st = checkStationaryAtSpot(epIdx, op.x, op.y, op.netFlux);
        return st === null || st.netFlux <= 0.85 * op.netFlux;
      });
      const pool = departingOrigins.length > 0 ? departingOrigins : allOriginPeaks;
      let bestOp = pool[0];
      let bestDist = Math.hypot(moverPeak.x - bestOp.x, moverPeak.y - bestOp.y);
      for (const op of pool.slice(1)) {
        const d = Math.hypot(moverPeak.x - op.x, moverPeak.y - op.y);
        if (d < bestDist) {
          bestDist = d;
          bestOp = op;
        }
      }
      return bestOp;
    };

    const hasSecondaryDepartingOrigin = secondaryOriginPeaks.some((op) => {
      for (let epIdx = 0; epIdx < numEpochs; epIdx += 1) {
        if (epIdx === clampedOrigin) continue;
        const st = checkStationaryAtSpot(epIdx, op.x, op.y, op.netFlux);
        if (st === null || st.netFlux <= 0.85 * op.netFlux) return true;
      }
      return false;
    });

    if (hasStationaryInAnyOtherEpoch && !stationaryDroppedFlux && !hasSecondaryDepartingOrigin) {
      // The clicked star remained stationary at (originDetection.x, originDetection.y) with >=85% of its
      // original flux and no secondary moving body was in the clicked area at origin.
      branchSeeds.push({
        kind: 'stationary',
        originPeak: originDetection,
        seedEpochIdx: clampedOrigin,
        seedDetection: originDetection,
      });
    } else if (bestSepPeaks.length >= 1 && bestSepEpochIdx >= 0) {
      // Seed moving branches from the primary separation epoch
      for (const pk of bestSepPeaks) {
        branchSeeds.push({
          kind: 'moving',
          originPeak: pickOriginPeakForMover(pk, bestSepEpochIdx),
          seedEpochIdx: bestSepEpochIdx,
          seedDetection: pk,
        });
      }
      // Also reconcile separated moving peaks from other non-origin epochs (e.g., when two bodies cross
      // at originEpochIndex and Branch A fades in Pass 3 while Branch B fades in Pass 1)
      if (!hasStationaryInAnyOtherEpoch || stationaryDroppedFlux || hasSecondaryDepartingOrigin) {
        for (const [epIdx, epPeaks] of peaksByEpoch.entries()) {
          if (epIdx === bestSepEpochIdx) continue;
          for (const candPk of epPeaks) {
            if (!isExplainedByExistingMovingSeed(candPk, epIdx)) {
              branchSeeds.push({
                kind: 'moving',
                originPeak: pickOriginPeakForMover(candPk, epIdx),
                seedEpochIdx: epIdx,
                seedDetection: candPk,
              });
            }
          }
        }
      }
      // If a stationary body also remained at originDetection alongside the moving body(s), track it too
      if (hasStationaryInAnyOtherEpoch && (stationaryDroppedFlux || hasSecondaryDepartingOrigin)) {
        const statSeed =
          checkStationaryAtSpot(
            bestSepEpochIdx,
            originDetection.x,
            originDetection.y,
            originDetection.netFlux,
          ) ?? originDetection;
        branchSeeds.push({
          kind: 'stationary',
          originPeak: originDetection,
          seedEpochIdx: bestSepEpochIdx,
          seedDetection: statSeed,
        });
      }
      // Also include any secondary stationary peaks in the clicked area if another body in the click moved
      for (const secOp of secondaryOriginPeaks) {
        const secSt = checkStationaryAtSpot(bestSepEpochIdx, secOp.x, secOp.y, secOp.netFlux);
        if (secSt && secSt.netFlux > 0.85 * secOp.netFlux) {
          branchSeeds.push({
            kind: 'stationary',
            originPeak: secOp,
            seedEpochIdx: bestSepEpochIdx,
            seedDetection: secSt,
          });
        }
      }
    } else {
      // Single stationary (or lost) body
      branchSeeds.push({
        kind: 'stationary',
        originPeak: originDetection,
        seedEpochIdx: clampedOrigin,
        seedDetection: originDetection,
      });
    }
  } else {
    branchSeeds.push({
      kind: 'stationary',
      originPeak: originDetection,
      seedEpochIdx: clampedOrigin,
      seedDetection: originDetection,
    });
  }

  const isOverlapped = branchSeeds.length > 1;
  const groupId = `group_ep${clampedOrigin}_x${Math.round(originDetection.x)}_y${Math.round(originDetection.y)}`;
  const originEpochMeta = manifest.epochs[clampedOrigin];

  // Build full multi-epoch TracedObjectSummary for each branch
  const buildBranchSummary = (seed: BranchSeed, branchIndex: number): TracedObjectSummary => {
    const waypoints: TracedWaypoint[] = new Array(numEpochs);
    const lostEpochIds: string[] = [];
    const branchOrigin = seed.originPeak;
    const branchOriginSky = pixelToSkyWcs(branchOrigin.x, branchOrigin.y, manifest.wcs);

    waypoints[clampedOrigin] = {
      epoch_id: originEpochMeta.epoch_id,
      epoch_index: clampedOrigin,
      mjd: originEpochMeta.mjd,
      iso_date: originEpochMeta.iso_date,
      x: branchOrigin.x,
      y: branchOrigin.y,
      ra: branchOriginSky.ra,
      dec: branchOriginSky.dec,
      peak_flux: branchOrigin.peakFlux,
      snr: branchOrigin.snr,
      status: 'tracked',
      visible: true,
    };

    const locateBranchInEpoch = (
      targetEpochIdx: number,
      fallbackX: number,
      fallbackY: number,
    ): TracedWaypoint => {
      const epMeta = manifest.epochs[targetEpochIdx];

      if (seed.kind === 'stationary') {
        const stat = checkStationaryAtSpot(
          targetEpochIdx,
          branchOrigin.x,
          branchOrigin.y,
          branchOrigin.netFlux,
        );
        if (stat) {
          const sky = pixelToSkyWcs(stat.x, stat.y, manifest.wcs);
          return {
            epoch_id: epMeta.epoch_id,
            epoch_index: targetEpochIdx,
            mjd: epMeta.mjd,
            iso_date: epMeta.iso_date,
            x: stat.x,
            y: stat.y,
            ra: sky.ra,
            dec: sky.dec,
            peak_flux: stat.peakFlux,
            snr: stat.snr,
            status: 'tracked',
            visible: true,
          };
        }
      }

      // Compute expected position using linear velocity from branchOrigin -> seedEpochIdx if available
      let searchX = fallbackX;
      let searchY = fallbackY;
      let searchRadius = crossEpochSearchRadiusPx;

      if (seed.kind === 'moving' && seed.seedEpochIdx !== clampedOrigin) {
        if (targetEpochIdx === seed.seedEpochIdx) {
          const sky = pixelToSkyWcs(seed.seedDetection.x, seed.seedDetection.y, manifest.wcs);
          return {
            epoch_id: epMeta.epoch_id,
            epoch_index: targetEpochIdx,
            mjd: epMeta.mjd,
            iso_date: epMeta.iso_date,
            x: seed.seedDetection.x,
            y: seed.seedDetection.y,
            ra: sky.ra,
            dec: sky.dec,
            peak_flux: seed.seedDetection.peakFlux,
            snr: seed.seedDetection.snr,
            status: 'tracked',
            visible: true,
          };
        }
        const dtSeed = manifest.epochs[seed.seedEpochIdx].mjd - originEpochMeta.mjd;
        const dtTarget = epMeta.mjd - originEpochMeta.mjd;
        if (Math.abs(dtSeed) > 1e-3) {
          searchX = branchOrigin.x + ((seed.seedDetection.x - branchOrigin.x) / dtSeed) * dtTarget;
          searchY = branchOrigin.y + ((seed.seedDetection.y - branchOrigin.y) / dtSeed) * dtTarget;
          searchRadius = isOverlapped ? 4.0 : crossEpochSearchRadiusPx;
        }
      }

      // Check if predicted trajectory left the 256x256 field of view
      if (searchX < 1 || searchX >= GRID_WIDTH - 1 || searchY < 1 || searchY >= GRID_HEIGHT - 1) {
        const clampedX = Number(Math.max(0, Math.min(GRID_WIDTH - 1, searchX)).toFixed(2));
        const clampedY = Number(Math.max(0, Math.min(GRID_HEIGHT - 1, searchY)).toFixed(2));
        const sky = pixelToSkyWcs(clampedX, clampedY, manifest.wcs);
        lostEpochIds.push(epMeta.epoch_id);
        return {
          epoch_id: epMeta.epoch_id,
          epoch_index: targetEpochIdx,
          mjd: epMeta.mjd,
          iso_date: epMeta.iso_date,
          x: clampedX,
          y: clampedY,
          ra: sky.ra,
          dec: sky.dec,
          peak_flux: 0,
          snr: 0,
          status: 'out_of_bounds',
          visible: false,
        };
      }

      // Search transient difference frame first, then refine on composite frame
      const diffPeak = findLocalPeakAndCentroid(
        transientDifferenceFrames[targetEpochIdx],
        searchX,
        searchY,
        searchRadius,
      );
      const refined = findLocalPeakAndCentroid(
        compositeFrames[targetEpochIdx],
        diffPeak.x,
        diffPeak.y,
        2.5,
      );

      if (
        diffPeak.netFlux >= Math.max(0.04, 0.12 * branchOrigin.netFlux) &&
        Math.hypot(refined.x - searchX, refined.y - searchY) <= searchRadius + 0.8 &&
        refined.snr >= minSnrThreshold &&
        refined.netFlux >= Math.max(0.04, 0.12 * branchOrigin.netFlux)
      ) {
        const sky = pixelToSkyWcs(refined.x, refined.y, manifest.wcs);
        return {
          epoch_id: epMeta.epoch_id,
          epoch_index: targetEpochIdx,
          mjd: epMeta.mjd,
          iso_date: epMeta.iso_date,
          x: refined.x,
          y: refined.y,
          ra: sky.ra,
          dec: sky.dec,
          peak_flux: refined.peakFlux,
          snr: refined.snr,
          status: 'tracked',
          visible: true,
        };
      }

      // Fallback: check if source is stationary at fallbackX/Y (only when not a diverging overlapped moving branch)
      const localCheck = findLocalPeakAndCentroid(
        compositeFrames[targetEpochIdx],
        fallbackX,
        fallbackY,
        2.5,
      );
      if (
        (!isOverlapped || seed.kind === 'stationary') &&
        localCheck.snr >= minSnrThreshold &&
        localCheck.netFlux >= Math.max(0.04, 0.15 * branchOrigin.netFlux)
      ) {
        const sky = pixelToSkyWcs(localCheck.x, localCheck.y, manifest.wcs);
        return {
          epoch_id: epMeta.epoch_id,
          epoch_index: targetEpochIdx,
          mjd: epMeta.mjd,
          iso_date: epMeta.iso_date,
          x: localCheck.x,
          y: localCheck.y,
          ra: sky.ra,
          dec: sky.dec,
          peak_flux: localCheck.peakFlux,
          snr: localCheck.snr,
          status: 'tracked',
          visible: true,
        };
      }

      // Edge case: lost track of the body in this epoch (faded below SNR or obscured)
      lostEpochIds.push(epMeta.epoch_id);
      const holdX = Number(Math.max(0, Math.min(GRID_WIDTH - 1, searchX)).toFixed(2));
      const holdY = Number(Math.max(0, Math.min(GRID_HEIGHT - 1, searchY)).toFixed(2));
      const sky = pixelToSkyWcs(holdX, holdY, manifest.wcs);
      const lossStatus: WaypointTrackingStatus = localCheck.snr >= 1.2 ? 'low_snr' : 'lost';
      return {
        epoch_id: epMeta.epoch_id,
        epoch_index: targetEpochIdx,
        mjd: epMeta.mjd,
        iso_date: epMeta.iso_date,
        x: holdX,
        y: holdY,
        ra: sky.ra,
        dec: sky.dec,
        peak_flux: localCheck.peakFlux,
        snr: localCheck.snr,
        status: lossStatus,
        visible: false,
      };
    };

    // Track backward (previous frames: originEpochIndex - 1 down to 0)
    let prevX = branchOrigin.x;
    let prevY = branchOrigin.y;
    for (let idx = clampedOrigin - 1; idx >= 0; idx -= 1) {
      const wp = locateBranchInEpoch(idx, prevX, prevY);
      waypoints[idx] = wp;
      if (wp.status === 'tracked') {
        prevX = wp.x;
        prevY = wp.y;
      }
    }

    // Track forward (future frames: originEpochIndex + 1 up to numEpochs - 1)
    let nextX = branchOrigin.x;
    let nextY = branchOrigin.y;
    for (let idx = clampedOrigin + 1; idx < numEpochs; idx += 1) {
      let predX = nextX;
      let predY = nextY;
      if (
        idx - 2 >= 0 &&
        waypoints[idx - 1]?.status === 'tracked' &&
        waypoints[idx - 2]?.status === 'tracked'
      ) {
        const wpPrev = waypoints[idx - 1];
        const wpPrev2 = waypoints[idx - 2];
        const dtPrev = wpPrev.mjd - wpPrev2.mjd;
        const dtCurr = manifest.epochs[idx].mjd - wpPrev.mjd;
        if (Math.abs(dtPrev) > 1e-3 && Math.abs(dtCurr) > 1e-3) {
          predX = wpPrev.x + ((wpPrev.x - wpPrev2.x) / dtPrev) * dtCurr;
          predY = wpPrev.y + ((wpPrev.y - wpPrev2.y) / dtPrev) * dtCurr;
        }
      }
      const wp = locateBranchInEpoch(idx, predX, predY);
      waypoints[idx] = wp;
      if (wp.status === 'tracked') {
        nextX = wp.x;
        nextY = wp.y;
      }
    }

    const trackedWaypoints = waypoints.filter((w) => w.status === 'tracked');
    const firstWp = trackedWaypoints[0] ?? waypoints[0];
    const lastWp = trackedWaypoints[trackedWaypoints.length - 1] ?? waypoints[numEpochs - 1];
    const dxPx = lastWp.x - firstWp.x;
    const dyPx = lastWp.y - firstWp.y;
    const distPx = Math.hypot(dxPx, dyPx);
    const pixelScaleArcsec = Math.abs(manifest.wcs.cdelt[1]) * 3600.0;
    const baselineYears = Math.max(1e-4, Math.abs(lastWp.mjd - firstWp.mjd) / 365.25);
    const properMotionArcsecPerYr =
      trackedWaypoints.length >= 2
        ? Number(((distPx * pixelScaleArcsec) / baselineYears).toFixed(3))
        : 0;
    const positionAngleDeg = Number(
      (((Math.atan2(dxPx, dyPx) * 180.0) / Math.PI + 360.0) % 360.0).toFixed(1),
    );

    // Cross-match against known_objects (matching both origin and target epoch positions)
    const knownObjects = manifest.catalog_overlays.known_objects ?? [];
    let matchedObjectId: string | null = null;
    let matchedCatalog: CatalogSourceType | null = null;
    let matchedLabel: string | null = null;
    let bestDist = 4.5;

    for (const obj of knownObjects) {
      const originPos =
        obj.epoch_positions.find((p) => p.epoch_id === originEpochMeta.epoch_id) ?? obj;
      const dOrigin = Math.hypot(originPos.x - branchOrigin.x, originPos.y - branchOrigin.y);
      if (dOrigin < bestDist) {
        // When overlapped, disambiguate using the final/seed waypoint position as well
        const lastPos = obj.epoch_positions.find((p) => p.epoch_id === lastWp.epoch_id) ?? obj;
        const dLast = Math.hypot(lastPos.x - lastWp.x, lastPos.y - lastWp.y);
        const combinedScore = isOverlapped ? Math.max(dOrigin, dLast) : dOrigin;
        if (combinedScore < bestDist) {
          bestDist = combinedScore;
          matchedObjectId = obj.object_id;
          matchedCatalog = obj.catalog;
          matchedLabel = obj.label;
        }
      }
    }

    const isUncatalogedMover = matchedObjectId === null && properMotionArcsecPerYr >= 0.2;
    const color =
      TRACKING_SQUARE_COLORS[(colorIndexOffset + branchIndex) % TRACKING_SQUARE_COLORS.length];
    const summaryStatus: TrackSummaryStatus =
      lostEpochIds.length > 0 ? 'partially_lost' : 'tracked';
    const statusMessage =
      lostEpochIds.length > 0
        ? `Tracked across ${numEpochs - lostEpochIds.length}/${numEpochs} epochs (lost in ${lostEpochIds.join(', ')})`
        : isOverlapped
          ? `Overlapped body branch #${branchIndex + 1} of ${branchSeeds.length} separated across epochs`
          : `Tracked across all ${numEpochs} epochs`;

    return {
      trackId: `${groupId}_b${branchIndex}`,
      groupId,
      branchIndex,
      totalBranchesInClick: branchSeeds.length,
      isOverlappedAtOrigin: isOverlapped,
      color,
      status: summaryStatus,
      statusMessage,
      originEpochIndex: clampedOrigin,
      clickX,
      clickY,
      originCentroidX: branchOrigin.x,
      originCentroidY: branchOrigin.y,
      ra: branchOriginSky.ra,
      dec: branchOriginSky.dec,
      x1: waypoints[0].x,
      y1: waypoints[0].y,
      xN: waypoints[numEpochs - 1].x,
      yN: waypoints[numEpochs - 1].y,
      waypoints,
      lostEpochIds,
      properMotionArcsecPerYr,
      positionAngleDeg,
      matchedObjectId,
      matchedCatalog,
      matchedLabel,
      isUncatalogedMover,
    };
  };

  const tracks = branchSeeds.map((seed, idx) => buildBranchSummary(seed, idx));
  const anyLost = tracks.some((t) => t.status === 'partially_lost');

  return {
    status: anyLost ? 'partially_lost' : 'tracked',
    message: isOverlapped
      ? `Detected ${tracks.length} overlapped bodies at (${originDetection.x}, ${originDetection.y}) that separate across epochs.`
      : tracks[0].statusMessage,
    clickX,
    clickY,
    originEpochIndex: clampedOrigin,
    isOverlapped,
    tracks,
  };
}

/**
 * Merge a fresh click-tracking result into the accumulated multi-spot target list
 * (`trackedTargets`). Every retained/new target keeps a distinct color from
 * `TRACKING_SQUARE_COLORS`; re-clicking the same group or catalog object replaces
 * its previous branches instead of duplicating them.
 */
export function mergeTrackedTargets(
  existing: TracedObjectSummary[],
  incoming: TracedObjectSummary[],
  options: {
    checkedObjectIds?: Iterable<string>;
    objectHighlighterColors?: Record<string, string>;
    rng?: () => number;
  } = {},
): TracedObjectSummary[] {
  if (incoming.length === 0) return existing;

  const { checkedObjectIds = [], objectHighlighterColors = {}, rng = Math.random } = options;

  const incomingGroupId = incoming[0].groupId;
  const incomingMatchedIds = new Set(
    incoming.map((t) => t.matchedObjectId).filter((id): id is string => Boolean(id)),
  );
  const retained = existing.filter(
    (t) =>
      t.groupId !== incomingGroupId &&
      (!t.matchedObjectId || !incomingMatchedIds.has(t.matchedObjectId)),
  );

  // Colors already taken by retained tracking squares.
  const usedTargetColors = new Set(retained.map((t) => t.color));
  // Colors reserved by checked known objects (avoid random collisions in the viewport).
  const reservedObjectColors = new Set<string>();
  for (const id of checkedObjectIds) {
    const color = objectHighlighterColors[id];
    if (color) reservedObjectColors.add(color);
  }

  const colored = incoming.map((track) => {
    const preferred = track.matchedObjectId
      ? objectHighlighterColors[track.matchedObjectId]
      : undefined;
    const color =
      preferred && !usedTargetColors.has(preferred)
        ? preferred
        : pickDistinctHighlighterColors(
            1,
            new Set([...usedTargetColors, ...reservedObjectColors]),
            rng,
          )[0];
    usedTargetColors.add(color);
    return { ...track, color };
  });

  return [...retained, ...colored];
}

/**
 * Detect the primary "bright" body near (clickX, clickY) on `originEpochIndex`
 * and automatically track its position backward (previous epochs) and forward (future epochs).
 * (For multi-branch overlapped body tracking at a click, see `detectAndTrackBodiesAtClick`.)
 */
export function detectAndTrackBrightBodyAcrossEpochs(params: {
  clickX: number;
  clickY: number;
  originEpochIndex: number;
  epochBuffers: Float32Array[][];
  manifest: SkyPatchManifest;
  wavelengthRangeUm: [number, number];
  localRadiusPx?: number;
  crossEpochSearchRadiusPx?: number;
  minSnrThreshold?: number;
  colorIndexOffset?: number;
}): TracedObjectSummary {
  const result = detectAndTrackBodiesAtClick(params);
  if (result.tracks.length > 0) {
    return result.tracks[0];
  }

  // Edge case fallback when no bright body was found at the clicked spot
  const clampedOrigin = result.originEpochIndex;
  const fallbackSky = pixelToSkyWcs(
    Math.max(0, Math.min(GRID_WIDTH - 1, params.clickX)),
    Math.max(0, Math.min(GRID_HEIGHT - 1, params.clickY)),
    params.manifest.wcs,
  );
  return {
    trackId: `no_body_ep${clampedOrigin}_x${Math.round(params.clickX)}_y${Math.round(params.clickY)}`,
    groupId: `no_body_ep${clampedOrigin}`,
    branchIndex: 0,
    totalBranchesInClick: 0,
    isOverlappedAtOrigin: false,
    color: TRACKING_SQUARE_COLORS[0],
    status: 'no_body_found',
    statusMessage: result.message,
    originEpochIndex: clampedOrigin,
    clickX: params.clickX,
    clickY: params.clickY,
    originCentroidX: params.clickX,
    originCentroidY: params.clickY,
    ra: fallbackSky.ra,
    dec: fallbackSky.dec,
    x1: params.clickX,
    y1: params.clickY,
    xN: params.clickX,
    yN: params.clickY,
    waypoints: [],
    lostEpochIds: params.manifest.epochs.map((e) => e.epoch_id),
    properMotionArcsecPerYr: 0,
    positionAngleDeg: 0,
    matchedObjectId: null,
    matchedCatalog: null,
    matchedLabel: null,
    isUncatalogedMover: false,
  };
}
