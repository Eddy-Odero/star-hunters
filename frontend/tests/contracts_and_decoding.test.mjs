import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import * as ContractsModule from '../src/types/contracts.ts';
import {
  BINARY_DETECTOR_FLOAT16_BYTES,
  BINARY_DETECTOR_FLOAT32_BYTES,
  BINARY_FLAGS_UINT8_BYTES,
  DEFAULT_MOLECULAR_BANDS,
  TRACKING_SQUARE_COLORS,
  WORLD_CAPITAL_CITIES,
} from '../src/types/contracts.ts';
import {
  decodeDetectorBinaryBuffer,
  decodeFlagsBinaryBuffer,
  decodeFloat16Word,
} from '../src/utils/binaryDecoder.ts';
import { formatSpectrumCsv } from '../src/utils/csvExport.ts';
import {
  getDefaultCheckedObjectIds,
  WAVELENGTH_PRESETS,
} from '../src/utils/knownObjectSelection.ts';
import {
  computeGridKey,
  pixelToSkyWcs,
  quantizeGridCenter,
  screenToImageCoordinates,
} from '../src/utils/wcsViewport.ts';
import {
  PRESET_SLUGS,
  PRESETS_DIR,
  readArrayBuffer,
  readPresetManifest,
  readPresetSpectrum,
} from './helpers/fixtures.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test('Preset manifests, KnownCelestialObjects, and binary buffers match Phase 0 contracts', () => {
  const slugs = [
    'wise_0855',
    'barnards_star',
    'epsilon_indi_b',
    'rw_aurigae',
    'r_draconis',
    'comet_3i_atlas',
  ];

  for (const slug of slugs) {
    const manifest = readPresetManifest(slug);

    assert.equal(manifest.target_metadata.slug, slug);
    assert.equal(manifest.wcs.width, 256);
    assert.equal(manifest.wcs.height, 256);
    assert.ok(Array.isArray(manifest.catalog_overlays.known_objects));
    assert.ok(manifest.catalog_overlays.known_objects.length >= 2);

    const defaultChecked = getDefaultCheckedObjectIds(manifest.catalog_overlays.known_objects);
    assert.ok(defaultChecked.length >= 1, `Expected at least 1 default_checked object in ${slug}`);
    assert.ok(
      defaultChecked.length < manifest.catalog_overlays.known_objects.length,
      `Expected stationary background stars to have default_checked=false in ${slug}`,
    );

    const p1Buf = readArrayBuffer(path.join(PRESETS_DIR, slug, 'pass_1.bin'));
    assert.equal(p1Buf.byteLength, BINARY_DETECTOR_FLOAT32_BYTES);
    const planes = decodeDetectorBinaryBuffer(p1Buf, 'float32');
    assert.equal(planes.length, 6);
    assert.equal(planes[0].length, 256 * 256);

    const f1Buf = readArrayBuffer(path.join(PRESETS_DIR, slug, 'pass_1_flags.bin'));
    assert.equal(f1Buf.byteLength, BINARY_FLAGS_UINT8_BYTES);
    const flags = decodeFlagsBinaryBuffer(f1Buf);
    assert.equal(flags.length, 256 * 256);
  }
});

test('Float16 3G binary detector buffer decoding produces finite 6x256x256 Float32Array planes', () => {
  const words = new Uint16Array(6 * 256 * 256);
  // 0x3C00 is IEEE 754 float16 for 1.0
  words.fill(0x3c00);
  const decoded = decodeDetectorBinaryBuffer(words.buffer, 'float16');
  assert.equal(decoded.length, 6);
  assert.equal(decoded[0][0], 1.0);
  assert.equal(decoded[5][65535], 1.0);

  assert.throws(() => decodeDetectorBinaryBuffer(new ArrayBuffer(128), 'float16'));
  assert.throws(() => decodeDetectorBinaryBuffer(new ArrayBuffer(128), 'float32'));
});

test('ISS-10: decodeFloat16Word matches IEEE-754 binary16 reference values including subnormals, infinity and NaN', () => {
  assert.equal(decodeFloat16Word(0x0000), 0);
  assert.ok(Object.is(decodeFloat16Word(0x8000), -0));
  assert.equal(decodeFloat16Word(0x3c00), 1.0);
  assert.equal(decodeFloat16Word(0xbc00), -1.0);
  assert.equal(decodeFloat16Word(0x4000), 2.0);
  assert.equal(decodeFloat16Word(0xc000), -2.0);
  assert.equal(decodeFloat16Word(0x3800), 0.5);
  assert.equal(decodeFloat16Word(0x7bff), 65504);
  // Smallest positive subnormal: 2^-24
  assert.equal(decodeFloat16Word(0x0001), Math.pow(2, -24));
  // 0x3555 => (1 + 341/1024) * 2^-2
  assert.equal(decodeFloat16Word(0x3555), (1 + 341 / 1024) * 0.25);
  assert.equal(decodeFloat16Word(0x7c00), Infinity);
  assert.equal(decodeFloat16Word(0xfc00), -Infinity);
  assert.ok(Number.isNaN(decodeFloat16Word(0x7e00)));
  assert.equal(BINARY_DETECTOR_FLOAT16_BYTES, 786432);
  assert.equal(BINARY_DETECTOR_FLOAT32_BYTES, 1572864);
});

test('ISS-10: decodeDetectorBinaryBuffer decodes both 786,432 B float16 and 1,572,864 B float32 wire frames into Float32Array[6]', () => {
  const words = new Uint16Array(6 * 256 * 256);
  const pattern = [0x0000, 0x3c00, 0xbc00, 0x4000, 0x3800, 0x7bff, 0x0001, 0xc000];
  for (let i = 0; i < words.length; i += 1) {
    words[i] = pattern[i % pattern.length];
  }

  const float16Buffer = words.buffer;
  assert.equal(float16Buffer.byteLength, BINARY_DETECTOR_FLOAT16_BYTES);
  const decoded16 = decodeDetectorBinaryBuffer(float16Buffer, 'float16');
  assert.equal(decoded16.length, 6);
  assert.ok(decoded16.every((plane) => plane instanceof Float32Array));
  assert.ok(decoded16.every((plane) => plane.length === 256 * 256));
  // First and last values of every plane follow the exact same pattern.
  for (const plane of decoded16) {
    assert.equal(plane[0], 0);
    assert.equal(plane[1], 1);
    assert.equal(plane[2], -1);
    assert.equal(plane[65535], decodeFloat16Word(pattern[65535 % pattern.length]));
  }
  // Auto-detection by wire size also works when no dtype hint is supplied.
  const autoDecoded = decodeDetectorBinaryBuffer(float16Buffer);
  assert.equal(autoDecoded[3][1000], decodeFloat16Word(pattern[1000 % pattern.length]));

  const float32 = new Float32Array(6 * 256 * 256);
  for (let i = 0; i < float32.length; i += 1) {
    float32[i] = (i % 17) - 8 + 0.25;
  }
  assert.equal(float32.buffer.byteLength, BINARY_DETECTOR_FLOAT32_BYTES);
  const decoded32 = decodeDetectorBinaryBuffer(float32.buffer, 'float32');
  assert.equal(decoded32.length, 6);
  assert.ok(decoded32.every((plane) => plane.length === 256 * 256));
  assert.equal(decoded32[0][0], -7.75);
  assert.equal(decoded32[0][16], 8.25);
  assert.equal(decoded32[5][65535], float32[5 * 65536 + 65535]);
  // Planes reference the correct detector slices in the raw frame.
  assert.equal(decoded32[1][0], float32[65536]);
  assert.equal(decoded32[5][0], float32[5 * 65536]);

  assert.throws(() => decodeDetectorBinaryBuffer(new ArrayBuffer(786431), 'float16'));
  assert.throws(() => decodeDetectorBinaryBuffer(new ArrayBuffer(1572863), 'float32'));
});

test('ISS-17: formatSpectrumCsv produces 103-line CSV with header and 102 spectral channels', () => {
  const channels = Array.from({ length: 102 }, (_, idx) => ({
    band_index: idx + 1,
    detector: Math.floor(idx / 17) + 1,
    wavelength_um: 0.75 + (idx / 101) * (5.0 - 0.75),
    flux: 12.5 + idx * 0.1,
    variance: 0.04,
    flagged: idx === 10 || idx === 55,
  }));

  const csv = formatSpectrumCsv({
    target_id: 'barnards_star',
    ra: 269.452,
    dec: 4.693,
    aperture_radius_px: 2.5,
    channels,
  });

  const lines = csv.trimEnd().split('\n');
  assert.equal(lines.length, 103);
  assert.equal(lines[0], 'band_index,detector,wavelength_um,flux,variance,flagged');
  assert.ok(lines[1].startsWith('1,1,0.7500,'));
  assert.ok(lines[11].endsWith(',true'));
  assert.ok(lines[12].endsWith(',false'));
});

test('Phase 1 SpectraModal contract: preset spectrum channels use 1-based band_index 1..102', () => {
  for (const slug of PRESET_SLUGS) {
    const spectrum = readPresetSpectrum(slug);
    assert.equal(spectrum.channels.length, 102, `${slug}: expected 102 spectral channels`);
    assert.equal(spectrum.channels[0].band_index, 1, `${slug}: first band_index must be 1`);
    assert.equal(spectrum.channels[101].band_index, 102, `${slug}: last band_index must be 102`);
  }
});

test('Phase 2 decomposed modules: DEFAULT_MOLECULAR_BANDS, unified grid quantization, WCS edge cases, and binary flags validation', () => {
  // Consolidated DEFAULT_MOLECULAR_BANDS covers H2O, CH4, CO2, and CO within [0.75, 5.0] um
  assert.equal(DEFAULT_MOLECULAR_BANDS.length, 4);
  assert.deepEqual(
    DEFAULT_MOLECULAR_BANDS.map((b) => b.molecule),
    ['h2o', 'ch4', 'co2', 'co'],
  );
  for (const band of DEFAULT_MOLECULAR_BANDS) {
    assert.ok(band.min_um >= 0.75 && band.max_um <= 5.0 && band.min_um < band.max_um);
    assert.ok(band.label.length > 0);
  }

  // Consolidated WAVELENGTH_PRESETS exposes shortLabel for BlinkerControlsSection pills
  for (const preset of WAVELENGTH_PRESETS) {
    assert.ok(typeof preset.shortLabel === 'string' && preset.shortLabel.length > 0);
  }

  // Unified quantizeGridCenter & computeGridKey handle RA wraparound and Dec clamping
  assert.deepEqual(quantizeGridCenter(-10.02, 95.0), { raQ: 350.0, decQ: 90.0 });
  assert.deepEqual(quantizeGridCenter(359.99, -95.0), { raQ: 0.0, decQ: -90.0 });
  assert.equal(computeGridKey(-10.02, 95.0, 5.0), 'ra350.00_dec90.00_fov5.0');
  assert.equal(computeGridKey(359.99, -95.0, 5.0), 'ra0.00_dec-90.00_fov5.0');

  // pixelToSkyWcs wraps RA across 0/360 and clamps Dec to [-90, 90]
  const wcs = {
    width: 256,
    height: 256,
    crval: [0.001, 89.99],
    crpix: [128, 128],
    cdelt: [-0.0003255, 0.0003255],
  };
  const sky = pixelToSkyWcs(200, 200, wcs);
  assert.ok(sky.ra >= 0 && sky.ra < 360);
  assert.ok(sky.dec <= 90 && sky.dec >= -90);

  // screenToImageCoordinates rejects degenerate rects and out-of-rect clicks
  assert.equal(
    screenToImageCoordinates(50, 50, { left: 0, top: 0, width: 0, height: 100 }).inBounds,
    false,
  );
  assert.equal(
    screenToImageCoordinates(-10, 50, { left: 0, top: 0, width: 256, height: 256 }).inBounds,
    false,
  );

  // decodeFlagsBinaryBuffer enforces exact 65,536-byte length
  assert.throws(() => decodeFlagsBinaryBuffer(new ArrayBuffer(1024)));

  // WORLD_CAPITAL_CITIES static bundle remains non-empty with unique slugs
  assert.ok(WORLD_CAPITAL_CITIES.length > 0);
  assert.equal(
    new Set(WORLD_CAPITAL_CITIES.map((city) => city.slug)).size,
    WORLD_CAPITAL_CITIES.length,
  );

  // contracts.ts stays strictly pure (constants/types only; zero runtime function exports)
  const exportedFunctions = Object.entries(ContractsModule).filter(
    ([, value]) => typeof value === 'function',
  );
  assert.deepEqual(exportedFunctions, []);
});

test('Phase 4 cross-contract alignment: TRACKING_SQUARE_COLORS matches backend/app/models/contracts.py verbatim', () => {
  const canonicalPalette = [
    '#00F5D4',
    '#FFBE0B',
    '#FF006E',
    '#3A86FF',
    '#FB5607',
    '#8338EC',
    '#06D6A0',
    '#FF9F1C',
    '#AACC00',
    '#FF4D6D',
    '#F72585',
    '#4CC9F0',
    '#80ED99',
    '#C77DFF',
    '#FFEA00',
    '#00BBF9',
    '#FF6B6B',
    '#72EFDD',
    '#F15BB5',
    '#FEE440',
  ];

  assert.deepEqual([...TRACKING_SQUARE_COLORS], canonicalPalette);
  assert.equal(new Set(TRACKING_SQUARE_COLORS).size, 20);

  const backendContractsPath = path.resolve(__dirname, '../../backend/app/models/contracts.py');
  if (fs.existsSync(backendContractsPath)) {
    const pySource = fs.readFileSync(backendContractsPath, 'utf-8');
    const blockMatch = pySource.match(
      /TRACKING_SQUARE_COLORS:\s*tuple\[str,\s*\.\.\.\]\s*=\s*\(([\s\S]*?)\)/,
    );
    assert.ok(
      blockMatch,
      'Expected TRACKING_SQUARE_COLORS tuple in backend/app/models/contracts.py',
    );
    const backendHexes = Array.from(
      blockMatch[1].matchAll(/["'](#[0-9A-Fa-f]{6})["']/g),
      (m) => m[1],
    );
    assert.deepEqual([...TRACKING_SQUARE_COLORS], backendHexes);
  }
});
