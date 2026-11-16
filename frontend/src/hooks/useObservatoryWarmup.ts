import type React from 'react';
import { useEffect } from 'react';
import { defaultClientPatchCache } from '../services/clientPatchCache.ts';
import { loadPresetPatchFlow } from '../services/progressivePatchLoader.ts';
import type { GlobalKnownObjectEntry } from '../types/contracts.ts';
import { observatoryLogger } from '../utils/observatoryLogger.ts';
import { BENCHMARK_TARGET_OPTIONS } from '../utils/observatoryMath.ts';

/** Default initial delay (ms) before scheduling the first idle benchmark prewarm. */
export const WARMUP_INITIAL_DELAY_MS = 1500;

/** Default stagger delay (ms) between consecutive benchmark prewarm targets. */
export const WARMUP_STAGGER_DELAY_MS = 250;

/** Maximum time (ms) `requestIdleCallback` may wait before running a warmup turn. */
export const WARMUP_IDLE_TIMEOUT_MS = 4000;

/** Fallback `setTimeout` delay (ms) when `requestIdleCallback` is unavailable. */
export const WARMUP_FALLBACK_DELAY_MS = 250;

/** Minimal timer and idle-callback host interface supporting browser `window` and test doubles. */
export interface IdleSchedulerHost {
  /** Browser `requestIdleCallback` scheduler, omitted when unavailable (e.g., Safari/Node). */
  requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number;
  /** Browser `cancelIdleCallback` canceller paired with `requestIdleCallback`. */
  cancelIdleCallback?: (handle: number) => void;
  /** Timer scheduler used for initial/stagger delays and idle-callback fallback. */
  setTimeout: typeof globalThis.setTimeout;
  /** Timer canceller paired with `setTimeout`. */
  clearTimeout: typeof globalThis.clearTimeout;
}

/** Configuration options for {@link prewarmBenchmarkTargets}. */
export interface PrewarmBenchmarksOptions {
  /** Target presets to prewarm sequentially during browser idle slices. */
  targets?: ReadonlyArray<{ slug: string }>;
  /** Abort signal cancelling pending delays, idle callbacks, and in-flight fetches. */
  signal: AbortSignal;
  /** Timer/idle scheduler host; defaults to `window` in browsers or `globalThis`. */
  host?: IdleSchedulerHost;
  /** Initial grace period (ms) so landing curtain and globe tiles load uncontended. */
  initialDelayMs?: number;
  /** Stagger pause (ms) inserted between successive benchmark target fetches. */
  staggerDelayMs?: number;
  /** Timeout budget (ms) passed to `requestIdleCallback`. */
  idleTimeoutMs?: number;
  /** Fallback delay (ms) used when `requestIdleCallback` is unavailable. */
  fallbackDelayMs?: number;
  /** Preset loader implementation; defaults to {@link loadPresetPatchFlow}. */
  loadPreset?: (slug: string, signal: AbortSignal) => Promise<unknown>;
}

/**
 * Resolve the active timer/idle scheduler host from `window` or `globalThis`.
 *
 * @returns Host providing `setTimeout`/`clearTimeout` and optional `requestIdleCallback`.
 */
function resolveDefaultSchedulerHost(): IdleSchedulerHost {
  const win =
    typeof window !== 'undefined'
      ? (window as typeof window & {
          requestIdleCallback?: IdleSchedulerHost['requestIdleCallback'];
          cancelIdleCallback?: IdleSchedulerHost['cancelIdleCallback'];
        })
      : null;
  const globalScope = globalThis as typeof globalThis & {
    requestIdleCallback?: IdleSchedulerHost['requestIdleCallback'];
    cancelIdleCallback?: IdleSchedulerHost['cancelIdleCallback'];
  };
  const timerScope =
    win && typeof win.setTimeout === 'function' && typeof win.clearTimeout === 'function'
      ? win
      : globalScope;
  const idleScope = win && typeof win.requestIdleCallback === 'function' ? win : globalScope;

  return {
    requestIdleCallback:
      typeof idleScope.requestIdleCallback === 'function'
        ? idleScope.requestIdleCallback.bind(idleScope)
        : undefined,
    cancelIdleCallback:
      typeof idleScope.cancelIdleCallback === 'function'
        ? idleScope.cancelIdleCallback.bind(idleScope)
        : undefined,
    setTimeout: timerScope.setTimeout.bind(timerScope),
    clearTimeout: timerScope.clearTimeout.bind(timerScope),
  };
}

/**
 * Wait for a fixed millisecond delay with immediate `AbortSignal` cancellation.
 *
 * @param delayMs - Delay duration in milliseconds.
 * @param signal - Abort signal cancelling the timer early.
 * @param host - Timer scheduler host.
 * @returns `true` if the full delay elapsed, or `false` if aborted.
 */
function waitForAbortableDelay(
  delayMs: number,
  signal: AbortSignal,
  host: IdleSchedulerHost,
): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  if (delayMs <= 0) return Promise.resolve(true);

  return new Promise<boolean>((resolve) => {
    let settled = false;

    function onAbort() {
      if (settled) return;
      settled = true;
      host.clearTimeout(timerId);
      resolve(false);
    }

    const timerId = host.setTimeout(() => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      resolve(!signal.aborted);
    }, delayMs);

    if (!settled) {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/**
 * Wait for the browser's next idle slice via `requestIdleCallback`, falling back
 * to `setTimeout` when idle callbacks are unavailable (e.g., Safari or headless Node).
 *
 * @param signal - Abort signal cancelling any queued callback or timer.
 * @param host - Scheduler host providing `requestIdleCallback` and `setTimeout`.
 * @param idleTimeoutMs - Maximum wait budget (ms) passed to `requestIdleCallback`.
 * @param fallbackDelayMs - Delay (ms) used for the `setTimeout` fallback.
 * @returns `true` if the idle turn executed without cancellation, otherwise `false`.
 */
export function waitForIdleTurn(
  signal: AbortSignal,
  host: IdleSchedulerHost = resolveDefaultSchedulerHost(),
  idleTimeoutMs = WARMUP_IDLE_TIMEOUT_MS,
  fallbackDelayMs = WARMUP_FALLBACK_DELAY_MS,
): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);

  return new Promise<boolean>((resolve) => {
    let settled = false;

    if (typeof host.requestIdleCallback === 'function') {
      let handle = 0;
      const onAbort = () => {
        if (settled) return;
        settled = true;
        host.cancelIdleCallback?.(handle);
        resolve(false);
      };

      signal.addEventListener('abort', onAbort, { once: true });
      handle = host.requestIdleCallback(
        () => {
          if (settled) return;
          settled = true;
          signal.removeEventListener('abort', onAbort);
          resolve(!signal.aborted);
        },
        { timeout: idleTimeoutMs },
      );
      return;
    }

    function onAbortTimer() {
      if (settled) return;
      settled = true;
      host.clearTimeout(timerId);
      resolve(false);
    }

    const timerId = host.setTimeout(() => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbortTimer);
      resolve(!signal.aborted);
    }, fallbackDelayMs);

    if (!settled) {
      signal.addEventListener('abort', onAbortTimer, { once: true });
    }
  });
}

/**
 * Prewarm static benchmark preset payloads (~19 MB of binary frames and manifests)
 * using staggered idle scheduling so initial landing-curtain and Aladin Lite globe
 * rendering are never bandwidth-contended.
 *
 * @param options - Target list, abort signal, scheduler overrides, and timing budgets.
 * @returns Resolves once all targets finish prewarming or `signal` aborts.
 */
export async function prewarmBenchmarkTargets({
  targets = BENCHMARK_TARGET_OPTIONS,
  signal,
  host = resolveDefaultSchedulerHost(),
  initialDelayMs = WARMUP_INITIAL_DELAY_MS,
  staggerDelayMs = WARMUP_STAGGER_DELAY_MS,
  idleTimeoutMs = WARMUP_IDLE_TIMEOUT_MS,
  fallbackDelayMs = WARMUP_FALLBACK_DELAY_MS,
  loadPreset = (slug, abortSignal) =>
    loadPresetPatchFlow(slug, {
      cache: defaultClientPatchCache,
      signal: abortSignal,
      onStageChange: () => undefined,
      onReady: () => undefined,
    }),
}: PrewarmBenchmarksOptions): Promise<void> {
  if (signal.aborted || targets.length === 0) return;

  const readyAfterInitialDelay = await waitForAbortableDelay(initialDelayMs, signal, host);
  if (!readyAfterInitialDelay) return;

  for (let i = 0; i < targets.length; i += 1) {
    if (i > 0) {
      const readyAfterStagger = await waitForAbortableDelay(staggerDelayMs, signal, host);
      if (!readyAfterStagger) return;
    }

    const readyInIdleTurn = await waitForIdleTurn(signal, host, idleTimeoutMs, fallbackDelayMs);
    if (!readyInIdleTurn || signal.aborted) return;

    try {
      await loadPreset(targets[i].slug, signal);
    } catch {
      // Warmup skips individual failures silently so user navigation stays unaffected
    }

    if (signal.aborted) return;
  }
}

/**
 * Wake the backend `/health` endpoint, hydrate the global known-objects catalog
 * from static presets and live search, and schedule staggered idle prewarming of
 * benchmark presets with clean `AbortController` cancellation on unmount.
 *
 * @param setGlobalKnownObjects - State setter updating the global searchable object list.
 */
export function useObservatoryWarmup(
  setGlobalKnownObjects: React.Dispatch<React.SetStateAction<GlobalKnownObjectEntry[]>>,
): void {
  useEffect(() => {
    const catalogController = new AbortController();
    const { signal } = catalogController;

    const wakeHealthAndGlobalCatalog = async () => {
      observatoryLogger.info('warmup', 'Waking backend /health and loading global object catalog');
      fetch('/health', { signal })
        .then((res) => {
          observatoryLogger.info('warmup', 'Backend health check complete', { status: res.status });
        })
        .catch(() => {
          if (!signal.aborted) {
            observatoryLogger.warn(
              'warmup',
              'Backend health ping unreachable; operating offline/cached',
            );
          }
        });

      let baselineObjects: GlobalKnownObjectEntry[] = [];
      try {
        const res = await fetch('/presets/global_known_objects.json', { signal });
        if (res.ok) {
          const payload = (await res.json()) as GlobalKnownObjectEntry[];
          if (!signal.aborted && Array.isArray(payload) && payload.length > 0) {
            baselineObjects = payload;
            setGlobalKnownObjects(payload);
            observatoryLogger.info('catalogs', 'Loaded preset global known objects', {
              count: payload.length,
            });
          }
        }
      } catch {
        // Fallback below
      }

      if (signal.aborted) return;

      try {
        const apiRes = await fetch('/api/v1/catalogs/search?limit=200', { signal });
        if (apiRes.ok) {
          const apiData = (await apiRes.json()) as { results?: GlobalKnownObjectEntry[] };
          if (!signal.aborted && Array.isArray(apiData.results) && apiData.results.length > 0) {
            setGlobalKnownObjects((prev) => {
              const byId = new Map<string, GlobalKnownObjectEntry>();
              for (const item of prev.length > 0 ? prev : baselineObjects) {
                byId.set(item.object_id, item);
              }
              for (const liveItem of apiData.results ?? []) {
                byId.set(liveItem.object_id, liveItem);
              }
              return Array.from(byId.values());
            });
            observatoryLogger.info('catalogs', 'Merged live global known objects from backend', {
              count: apiData.results.length,
            });
          }
        }
      } catch {
        // Ignore offline startup failures
      }
    };

    void wakeHealthAndGlobalCatalog();
    return () => {
      catalogController.abort();
    };
  }, [setGlobalKnownObjects]);

  useEffect(() => {
    const warmupController = new AbortController();
    void prewarmBenchmarkTargets({ signal: warmupController.signal });
    return () => {
      warmupController.abort();
    };
  }, []);
}
