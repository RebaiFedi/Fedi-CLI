export interface RateLimitWindow {
  /** Epoch ms when the rate-limit window ends. */
  resetAtMs: number;
  /** IANA timezone used for parsing/evaluation (ex: Africa/Tunis). */
  timezone: string;
  /** Human-readable reset label for UI messages. */
  resetLabel: string;
}

interface LocalParts {
  dateKey: string;
  hour: number;
  minute: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function getFormatter(timezone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timezone);
  if (cached) return cached;
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  formatterCache.set(timezone, fmt);
  return fmt;
}

function isValidTimeZone(timezone: string): boolean {
  try {
    // Throws RangeError on invalid IANA timezone.
    getFormatter(timezone).format(0);
    return true;
  } catch {
    return false;
  }
}

function localPartsAt(ms: number, timezone: string): LocalParts {
  const parts = getFormatter(timezone).formatToParts(new Date(ms));
  const map = new Map<string, string>();
  for (const p of parts) map.set(p.type, p.value);
  const year = map.get('year') ?? '1970';
  const month = map.get('month') ?? '01';
  const day = map.get('day') ?? '01';
  const hour = Number(map.get('hour') ?? '0');
  const minute = Number(map.get('minute') ?? '0');
  return {
    dateKey: `${year}-${month}-${day}`,
    hour,
    minute,
  };
}

function nextDateKey(nowMs: number, timezone: string, currentKey: string): string {
  const candidates = [24, 30, 36, 48].map((h) => nowMs + h * 60 * 60 * 1000);
  for (const ts of candidates) {
    const k = localPartsAt(ts, timezone).dateKey;
    if (k !== currentKey) return k;
  }
  return currentKey;
}

function to12hLabel(hour24: number, minute: number): string {
  const ampm = hour24 >= 12 ? 'pm' : 'am';
  const h12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  if (minute === 0) return `${h12}${ampm}`;
  return `${h12}:${String(minute).padStart(2, '0')}${ampm}`;
}

/** Find the next UTC epoch matching a local clock time in the given timezone. */
function findResetEpoch(
  targetHour24: number,
  targetMinute: number,
  timezone: string,
  nowMs: number,
): number {
  const nowLocal = localPartsAt(nowMs, timezone);
  const nowMinutes = nowLocal.hour * 60 + nowLocal.minute;
  const targetMinutes = targetHour24 * 60 + targetMinute;
  const targetDateKey =
    nowMinutes < targetMinutes
      ? nowLocal.dateKey
      : nextDateKey(nowMs, timezone, nowLocal.dateKey);

  // Minute-level scan over 72h. This runs only when a limit message appears.
  const endMs = nowMs + 72 * 60 * 60 * 1000;
  for (let ts = nowMs; ts <= endMs; ts += 60_000) {
    const p = localPartsAt(ts, timezone);
    if (p.dateKey === targetDateKey && p.hour === targetHour24 && p.minute === targetMinute) {
      return ts;
    }
  }

  // Fallback guard: keep window active for 12h instead of failing open.
  return nowMs + 12 * 60 * 60 * 1000;
}

/**
 * Parse strings like:
 * - "You've hit your limit · resets 12pm (Africa/Tunis)"
 * - "quota epuise (reset: 12:30pm (Africa/Tunis))"
 */
export function parseRateLimitWindow(
  text: string,
  nowMs = Date.now(),
  fallbackTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
): RateLimitWindow | null {
  const m = text.match(
    /resets?\s*[:\-]?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b(?:\s*\(([^)]+)\))?/i,
  );
  if (!m) return null;

  const hour12 = Number(m[1]);
  const minute = Number(m[2] ?? '0');
  const ampm = m[3].toLowerCase();
  const rawTimezone = (m[4] ?? fallbackTimezone).trim();
  const timezone = isValidTimeZone(rawTimezone) ? rawTimezone : fallbackTimezone;

  if (!Number.isFinite(hour12) || hour12 < 1 || hour12 > 12) return null;
  if (!Number.isFinite(minute) || minute < 0 || minute > 59) return null;

  const hour24 = (hour12 % 12) + (ampm === 'pm' ? 12 : 0);
  const resetAtMs = findResetEpoch(hour24, minute, timezone, nowMs);
  const resetLabel = `${to12hLabel(hour24, minute)} (${timezone})`;

  return { resetAtMs, timezone, resetLabel };
}

export function isRateLimitActive(window: RateLimitWindow, nowMs = Date.now()): boolean {
  return nowMs < window.resetAtMs;
}

