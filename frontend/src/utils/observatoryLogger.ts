export type LogLevelName = 'debug' | 'info' | 'warn' | 'error' | 'silent';

export interface ObservatoryLogEntry {
  id: number;
  timestamp: string;
  level: Exclude<LogLevelName, 'silent'>;
  scope: string;
  event: string;
  detail?: Record<string, unknown>;
}

export interface ObservatoryLogConfig {
  level: LogLevelName;
  bufferSize: number;
}

const LEVEL_RANK: Record<LogLevelName, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

const STORAGE_LEVEL_KEY = 'star_hunters_log_level';
const STORAGE_BUFFER_KEY = 'star_hunters_log_buffer_size';

function normalizeLevel(raw: unknown, fallback: LogLevelName = 'info'): LogLevelName {
  if (typeof raw !== 'string') return fallback;
  const candidate = raw.trim().toLowerCase();
  if (
    candidate === 'debug' ||
    candidate === 'info' ||
    candidate === 'warn' ||
    candidate === 'error' ||
    candidate === 'silent'
  ) {
    return candidate;
  }
  if (candidate === 'warning') return 'warn';
  return fallback;
}

function normalizeBufferSize(raw: unknown, fallback = 250): number {
  const num = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return Math.max(20, Math.min(2000, Math.floor(num)));
}

function readRuntimeOverride(): Partial<ObservatoryLogConfig> {
  const g = globalThis as Record<string, unknown>;
  const globalCfg = g.__STAR_HUNTERS_LOG_CONFIG__ as Partial<ObservatoryLogConfig> | undefined;
  let storageLevel: string | null = null;
  let storageBuffer: string | null = null;
  try {
    if (typeof g.localStorage !== 'undefined') {
      const ls = g.localStorage as Storage;
      storageLevel = ls.getItem(STORAGE_LEVEL_KEY);
      storageBuffer = ls.getItem(STORAGE_BUFFER_KEY);
    }
  } catch {
    // Ignore storage access failures inside restricted sandboxes.
  }

  return {
    level: storageLevel
      ? normalizeLevel(storageLevel)
      : globalCfg?.level
        ? normalizeLevel(globalCfg.level)
        : undefined,
    bufferSize: storageBuffer
      ? normalizeBufferSize(storageBuffer)
      : globalCfg?.bufferSize
        ? normalizeBufferSize(globalCfg.bufferSize)
        : undefined,
  };
}

function readBuildEnv(): { level?: string; bufferSize?: string } {
  try {
    const meta = import.meta as unknown as { env?: Record<string, string | undefined> };
    return {
      level: meta?.env?.VITE_LOG_LEVEL,
      bufferSize: meta?.env?.VITE_LOG_BUFFER_SIZE,
    };
  } catch {
    return {};
  }
}

export class ObservatoryLogger {
  private config: ObservatoryLogConfig;
  private buffer: ObservatoryLogEntry[] = [];
  private seq = 0;

  constructor(initialConfig?: Partial<ObservatoryLogConfig>) {
    const env = readBuildEnv();
    const override = readRuntimeOverride();
    const level = normalizeLevel(initialConfig?.level ?? override.level ?? env.level, 'info');
    const bufferSize = normalizeBufferSize(
      initialConfig?.bufferSize ?? override.bufferSize ?? env.bufferSize,
      250,
    );
    this.config = { level, bufferSize };
    this.publishGlobals();
  }

  public getConfig(): ObservatoryLogConfig {
    return { ...this.config };
  }

  public configure(next: Partial<ObservatoryLogConfig>): ObservatoryLogConfig {
    if (next.level !== undefined) {
      this.config.level = normalizeLevel(next.level, this.config.level);
    }
    if (next.bufferSize !== undefined) {
      this.config.bufferSize = normalizeBufferSize(next.bufferSize, this.config.bufferSize);
      while (this.buffer.length > this.config.bufferSize) {
        this.buffer.shift();
      }
    }
    this.publishGlobals();
    return this.getConfig();
  }

  public getEntries(): ObservatoryLogEntry[] {
    return [...this.buffer];
  }

  public clear(): void {
    this.buffer = [];
    this.publishGlobals();
  }

  public shouldLog(level: Exclude<LogLevelName, 'silent'>): boolean {
    return LEVEL_RANK[level] >= LEVEL_RANK[this.config.level];
  }

  public log(
    level: Exclude<LogLevelName, 'silent'>,
    scope: string,
    event: string,
    detail?: Record<string, unknown>,
  ): ObservatoryLogEntry | null {
    if (!this.shouldLog(level)) {
      return null;
    }
    const entry: ObservatoryLogEntry = {
      id: ++this.seq,
      timestamp: new Date().toISOString(),
      level,
      scope,
      event,
      ...(detail && Object.keys(detail).length > 0 ? { detail } : {}),
    };
    this.buffer.push(entry);
    while (this.buffer.length > this.config.bufferSize) {
      this.buffer.shift();
    }
    this.publishGlobals();

    const prefix = `[StarHunters:${scope}] ${event}`;
    if (level === 'debug') {
      console.debug(prefix, detail ?? '');
    } else if (level === 'info') {
      console.info(prefix, detail ?? '');
    } else if (level === 'warn') {
      console.warn(prefix, detail ?? '');
    } else {
      console.error(prefix, detail ?? '');
    }
    return entry;
  }

  public debug(scope: string, event: string, detail?: Record<string, unknown>) {
    return this.log('debug', scope, event, detail);
  }

  public info(scope: string, event: string, detail?: Record<string, unknown>) {
    return this.log('info', scope, event, detail);
  }

  public warn(scope: string, event: string, detail?: Record<string, unknown>) {
    return this.log('warn', scope, event, detail);
  }

  public error(scope: string, event: string, detail?: Record<string, unknown>) {
    return this.log('error', scope, event, detail);
  }

  private publishGlobals(): void {
    const g = globalThis as Record<string, unknown>;
    g.__STAR_HUNTERS_LOGS__ = this.buffer;
    g.__STAR_HUNTERS_LOG_CONFIG__ = { ...this.config };
    g.__STAR_HUNTERS_SET_LOG_LEVEL__ = (level: LogLevelName) => this.configure({ level });
  }
}

export const observatoryLogger = new ObservatoryLogger();
