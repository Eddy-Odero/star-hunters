import type React from 'react';
import { useEffect } from 'react';
import type { GlobalKnownObjectEntry } from '../types/contracts';
import { defaultClientPatchCache } from '../services/clientPatchCache';
import { loadPresetPatchFlow } from '../services/progressivePatchLoader';
import { BENCHMARK_TARGET_OPTIONS } from '../utils/observatoryMath';
import { observatoryLogger } from '../utils/observatoryLogger';

/** Wake backend health, hydrate global catalog entries, and pre-warm benchmark presets on mount. */
export function useObservatoryWarmup(
  setGlobalKnownObjects: React.Dispatch<React.SetStateAction<GlobalKnownObjectEntry[]>>,
): void {
  useEffect(() => {
    let cancelled = false;

    const wakeHealthAndGlobalCatalog = async () => {
      observatoryLogger.info('warmup', 'Waking backend /health and loading global object catalog');
      fetch('/health')
        .then((res) => {
          observatoryLogger.info('warmup', 'Backend health check complete', { status: res.status });
        })
        .catch(() => {
          observatoryLogger.warn(
            'warmup',
            'Backend health ping unreachable; operating offline/cached',
          );
        });

      let baselineObjects: GlobalKnownObjectEntry[] = [];
      try {
        const res = await fetch('/presets/global_known_objects.json');
        if (res.ok) {
          const payload = (await res.json()) as GlobalKnownObjectEntry[];
          if (!cancelled && Array.isArray(payload) && payload.length > 0) {
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

      try {
        const apiRes = await fetch('/api/v1/catalogs/search?limit=200');
        if (apiRes.ok) {
          const apiData = (await apiRes.json()) as { results?: GlobalKnownObjectEntry[] };
          if (!cancelled && Array.isArray(apiData.results) && apiData.results.length > 0) {
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
      cancelled = true;
    };
  }, [setGlobalKnownObjects]);

  useEffect(() => {
    let cancelled = false;
    const warmupController = new AbortController();

    const prewarmBenchmarks = async () => {
      for (const target of BENCHMARK_TARGET_OPTIONS) {
        if (cancelled) return;
        try {
          await loadPresetPatchFlow(target.slug, {
            cache: defaultClientPatchCache,
            signal: warmupController.signal,
            onStageChange: () => undefined,
            onReady: () => undefined,
          });
        } catch {
          // Warmup skips individual failures silently so user navigation stays unaffected
        }
      }
    };

    void prewarmBenchmarks();
    return () => {
      cancelled = true;
      warmupController.abort();
    };
  }, []);
}
