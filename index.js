/**
 * Host half of the conversation-cost bundle.
 *
 * Registers the client-visible `conversationCost` Session projection: a pure
 * fold over committed Session events that splits provider-reported token usage
 * by
 *   - model route (provider/model), so mixed-model Sessions price each leg at
 *     its own rate, and
 *   - DeepSeek's peak / off-peak price period, so time-of-day pricing is
 *     reflected per request instead of at one flat rate.
 *
 * The pricing calendar (peak windows + Chinese statutory holidays) is resolved
 * at activation:
 *   - built-in defaults cover the years the package shipped with;
 *   - the profile patch may override or extend them (`holidays`,
 *     `extraHolidays`, `peakWindows`, `timeZoneOffsetMinutes`);
 *   - years the built-in table does not cover are fetched automatically from
 *     the maintained `NateScarlet/holiday-cn` dataset (GitHub Contents API
 *     first, then jsDelivr, then raw.githubusercontent), validated, and
 *     cached in the profile storage so a normal start makes no request.
 *
 * Peak rule (DeepSeek API pricing, effective 2026-08-17):
 *   peak     = Beijing time Monday-Friday 09:00-12:00 and 14:00-18:00,
 *              excluding Chinese statutory holidays;
 *   off-peak = every other moment (weekends and holidays included);
 *   off-peak price = 50% of the peak price.
 *
 * A request is priced by the period in effect when it STARTED: the fold bills
 * an Assistant settlement at its step's `step/start` time, falling back to the
 * settlement event's own time when no step start is in the log.
 *
 * The wire view carries token buckets plus the resolved calendar rule; the
 * Client half turns buckets into money with its own rate card and uses the
 * rule to show the current period and the next switch.
 *
 * @module @local/dsh-conversation-cost
 */

/** Required service: the Session projection registry drives this unit. */
export const inject = ['sessionProjections'];

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** Beijing time has no DST, so a fixed offset converts durable event times. */
const DEFAULT_TIME_ZONE_OFFSET_MINUTES = 8 * 60;

/** Peak windows as Beijing minutes-of-day, half-open [start, end). */
const DEFAULT_PEAK_WINDOWS = [
  ['09:00', '12:00'],
  ['14:00', '18:00'],
];

/**
 * Built-in Chinese statutory holidays for the years this package shipped
 * with. Later years are fetched automatically (see `holidaySources` below) and
 * fall back to this table plus `extraHolidays` when the network is
 * unavailable.
 *
 * Sources: the State Council holiday arrangements for 2026 and 2027. Weekends
 * are off-peak regardless, so only holidays that fall Monday-Friday change the
 * result. Replaced workdays that fall on a weekend stay off-peak because the
 * peak rule requires a weekday.
 */
export const DEFAULT_HOLIDAYS = [
  // 2026
  '2026-01-01', '2026-01-02', '2026-01-03',
  '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19',
  '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23',
  '2026-04-04', '2026-04-05', '2026-04-06',
  '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
  '2026-06-19', '2026-06-20', '2026-06-21',
  '2026-09-25', '2026-09-26', '2026-09-27',
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05',
  '2026-10-06', '2026-10-07',
  // 2027
  '2027-01-01', '2027-01-02', '2027-01-03',
  '2027-02-05', '2027-02-06', '2027-02-07', '2027-02-08', '2027-02-09',
  '2027-02-10', '2027-02-11', '2027-02-12', '2027-02-13',
  '2027-04-03', '2027-04-04', '2027-04-05',
  '2027-05-01', '2027-05-02', '2027-05-03', '2027-05-04', '2027-05-05',
  '2027-06-09', '2027-09-15',
  '2027-10-01', '2027-10-02', '2027-10-03', '2027-10-04', '2027-10-05',
  '2027-10-06', '2027-10-07',
];

/** Years whose holiday data ships with the package and is never re-fetched. */
const BUILT_IN_YEARS = new Set(DEFAULT_HOLIDAYS.map((date) => date.slice(0, 4)));

/**
 * Public, annually maintained datasets of China's statutory holidays.
 * `{year}` is replaced with the calendar year. The GitHub Contents API is
 * first because it works where raw CDN hosts are blocked; it answers with a
 * base64-wrapped JSON document.
 */
export const DEFAULT_HOLIDAY_SOURCES = [
  'https://api.github.com/repos/NateScarlet/holiday-cn/contents/{year}.json?ref=master',
  'https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/{year}.json',
  'https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/{year}.json',
];

const DEFAULT_FETCH_TIMEOUT_MS = 5 * 1000;
/** A successful calendar is effectively final; refresh it once a month. */
const CACHE_OK_TTL_MS = 30 * DAY_MS;
/** A 404 before the State Council publishes next year's schedule is retried. */
const CACHE_MISS_TTL_MS = 3 * DAY_MS;

/** A schema the registry can `.parse`; cached data and view are already JSON. */
const PASS_THROUGH = { parse: (value) => value };

/** Profile storage domain holding fetched calendars (one JSON document). */
const CACHE_SPEC = {
  name: 'conversation_cost',
  version: 1,
  layout: 'single',
  tables: { years: { valueSchema: PASS_THROUGH } },
};

/** Parse "HH:MM" (or a minute count) into Beijing minutes-of-day. */
function minutesOfDay(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const minutes = Math.round(value);
    return minutes >= 0 && minutes < 1440 ? minutes : undefined;
  }
  if (typeof value === 'string') {
    const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
    if (match !== null) {
      const hours = Number(match[1]);
      const minutes = Number(match[2]);
      if (hours >= 0 && hours < 24 && minutes >= 0 && minutes < 60) {
        return hours * 60 + minutes;
      }
    }
  }
  return undefined;
}

/** Parse one `[start, end]` pair list into minutes-of-day windows. */
function windowsOf(input) {
  if (!Array.isArray(input)) return undefined;
  const windows = [];
  for (const entry of input) {
    if (!Array.isArray(entry) || entry.length !== 2) continue;
    const start = minutesOfDay(entry[0]);
    const end = minutesOfDay(entry[1]);
    if (start === undefined || end === undefined || start >= end) continue;
    windows.push([start, end]);
  }
  return windows.length > 0 ? windows : undefined;
}

/** Parse a "YYYY-MM-DD" Beijing date list (invalid entries are dropped). */
function datesOf(input) {
  if (!Array.isArray(input)) return undefined;
  const dates = [];
  for (const entry of input) {
    if (typeof entry !== 'string') continue;
    const date = entry.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) dates.push(date);
  }
  return dates;
}

/** A usable fixed UTC offset, in minutes. */
function offsetOf(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const minutes = Math.trunc(value);
  return minutes >= -840 && minutes <= 840 ? minutes : undefined;
}

/** Positive integer option or undefined. */
function positiveInt(value, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const number = Math.trunc(value);
  return number >= min && number <= max ? number : undefined;
}

/** URL template list from config, or undefined. */
function sourcesOf(value) {
  if (!Array.isArray(value)) return undefined;
  const sources = [];
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const template = entry.trim();
    if (/^https?:\/\//.test(template)) sources.push(template);
    if (sources.length >= 5) break;
  }
  return sources.length > 0 ? sources : undefined;
}

/** Explicit holiday-year list from config, or undefined. */
function yearsOf(value) {
  if (!Array.isArray(value)) return undefined;
  const years = [];
  for (const entry of value) {
    const year = typeof entry === 'number' ? Math.trunc(entry) : Number(entry);
    if (Number.isInteger(year) && year >= 2000 && year <= 2100) years.push(year);
  }
  return years.length > 0 ? [...new Set(years)] : undefined;
}

/**
 * Read the holiday-update settings out of raw row config.
 * @param config - raw plugin config from the Loader row.
 * @returns auto-update toggle, source templates, timeout, explicit years.
 */
export function holidaySettingsOf(config) {
  const settings = config !== null && typeof config === 'object' && !Array.isArray(config) ? config : {};
  return {
    auto: settings.autoHolidayUpdate !== false,
    sources: sourcesOf(settings.holidaySources) ?? DEFAULT_HOLIDAY_SOURCES,
    timeoutMs: positiveInt(settings.holidayFetchTimeoutMs, 100, 60 * 1000) ?? DEFAULT_FETCH_TIMEOUT_MS,
    years: yearsOf(settings.holidayYears),
  };
}

/**
 * Resolve the pricing calendar from raw row config.
 *
 * `holidays` replaces the built-in table; `extraHolidays` appends to it, so a
 * manual yearly update is one entry. `peakWindows` accepts
 * `["09:00", "12:00"]` pairs (or minute counts) and `timeZoneOffsetMinutes`
 * overrides the Beijing fixed offset. Invalid values fall back to the built-in
 * defaults.
 *
 * @param config - raw plugin config from the Loader row.
 * @returns the normalized rule used by the fold and published to clients.
 */
export function normalizeRule(config) {
  const settings = config !== null && typeof config === 'object' && !Array.isArray(config) ? config : {};
  const offset = offsetOf(settings.timeZoneOffsetMinutes);
  const windows = windowsOf(settings.peakWindows);
  const holidays = datesOf(settings.holidays);
  const extra = datesOf(settings.extraHolidays) ?? [];
  const base = holidays ?? DEFAULT_HOLIDAYS;
  return {
    timeZoneOffsetMinutes: offset ?? DEFAULT_TIME_ZONE_OFFSET_MINUTES,
    peakWindows: windows ?? windowsOf(DEFAULT_PEAK_WINDOWS),
    holidays: new Set([...base, ...extra]),
  };
}

/** Beijing calendar date of one instant, as "YYYY-MM-DD". */
function beijingDateKey(ms, offsetMinutes) {
  const clock = new Date(ms + offsetMinutes * MINUTE_MS);
  const month = clock.getUTCMonth() + 1;
  const day = clock.getUTCDate();
  return `${clock.getUTCFullYear()}-${month < 10 ? `0${month}` : month}-${day < 10 ? `0${day}` : day}`;
}

/** Beijing calendar year of one instant. */
function beijingYear(ms, offsetMinutes) {
  return new Date(ms + offsetMinutes * MINUTE_MS).getUTCFullYear();
}

/**
 * Years worth checking for a fetched calendar: the current year, the next year
 * once its schedule may be published (October onwards), and the previous year
 * in January so a Session straddling New Year is still priced correctly.
 * @param nowMs - epoch milliseconds.
 * @param offsetMinutes - fixed calendar offset.
 * @returns ascending distinct years.
 */
export function holidayYearsFor(nowMs, offsetMinutes) {
  const clock = new Date(nowMs + offsetMinutes * MINUTE_MS);
  const year = clock.getUTCFullYear();
  const month = clock.getUTCMonth();
  const years = [year];
  if (month >= 9) years.push(year + 1);
  if (month === 0) years.unshift(year - 1);
  return [...new Set(years)];
}

/**
 * Extract off-day dates from a holiday dataset payload. Accepts the
 * `holiday-cn` shape (`{days:[{date,isOffDay}]}`), GitHub's base64 Contents
 * wrapper, and timor.tech's `{holiday:{...}}` shape.
 * @param payload - parsed JSON payload.
 * @param year - calendar year the payload must describe.
 * @returns sorted distinct "YYYY-MM-DD" dates inside that year.
 */
export function extractHolidayDates(payload, year) {
  const collected = [];
  collect(payload, collected);
  const prefix = `${year}-`;
  return [...new Set(collected)]
    .filter((date) => date.startsWith(prefix))
    .sort();

  function collect(node, out) {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return;
    if (typeof node.content === 'string' && node.encoding === 'base64') {
      try {
        const decoded = Buffer.from(node.content, 'base64').toString('utf8');
        collect(JSON.parse(decoded), out);
      } catch (error) {
        // A malformed wrapper falls through to the other shapes.
      }
      return;
    }
    if (Array.isArray(node.days)) {
      for (const day of node.days) {
        if (day !== null && typeof day === 'object' && day.isOffDay === true) pushDate(day.date, out);
      }
      return;
    }
    if (node.holiday !== null && typeof node.holiday === 'object' && !Array.isArray(node.holiday)) {
      for (const entry of Object.values(node.holiday)) {
        if (entry !== null && typeof entry === 'object' && entry.holiday === true) pushDate(entry.date, out);
      }
    }
  }
}

/** Collect one validated holiday date. */
function pushDate(value, out) {
  if (typeof value !== 'string') return;
  const date = value.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (match === null) return;
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return;
  out.push(date);
}

/**
 * Fetch one year's off-day calendar from the first source that answers.
 * @param year - calendar year.
 * @param options - sources, timeout budget, fetch implementation, clock.
 * @returns `{ dates, source }`, or undefined when every source failed.
 */
export async function fetchHolidayYear(year, options = {}) {
  const sources = options.sources ?? DEFAULT_HOLIDAY_SOURCES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') return undefined;
  // Budget is wall-clock: a caller-supplied logical clock must not skew it.
  const deadline = Date.now() + timeoutMs;
  for (const template of sources) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const url = template.split('{year}').join(String(year));
    try {
      const response = await fetchImpl(url, {
        headers: { accept: 'application/json', 'user-agent': 'dsh-conversation-cost/1.3' },
        redirect: 'follow',
        signal: AbortSignal.timeout(Math.max(1, remaining)),
      });
      if (response === null || typeof response !== 'object' || response.ok !== true) continue;
      const payload = await response.json();
      const dates = extractHolidayDates(payload, year);
      if (dates.length > 0) return { dates, source: url };
    } catch (error) {
      // Try the next source; the last failure is reported by the caller.
    }
  }
  return undefined;
}

/** Whether a cached calendar record is still inside its refresh window. */
function cacheRecordFresh(record, now) {
  if (record === null || typeof record !== 'object') return false;
  const fetchedAt = record.fetchedAt;
  if (typeof fetchedAt !== 'number' || !Number.isFinite(fetchedAt)) return false;
  const age = now - fetchedAt;
  if (age < 0) return true;
  return record.status === 'ok' ? age < CACHE_OK_TTL_MS : age < CACHE_MISS_TTL_MS;
}

/**
 * Resolve the complete calendar: built-in + config dates + auto-fetched years.
 *
 * Fetched years are cached in the profile storage domain when one is
 * available; a fresh cache entry costs no request. Every network failure is
 * fail-soft: the affected year simply keeps the built-in/config data.
 *
 * @param config - raw plugin config from the Loader row.
 * @param options - storage domain handle, logger, clock, fetch implementation.
 * @returns the rule plus what happened for diagnostics.
 */
export async function resolveRule(config, options = {}) {
  const base = normalizeRule(config);
  const result = { rule: base, cachedYears: [], fetchedYears: [], failedYears: [] };
  const settings = holidaySettingsOf(config);
  if (!settings.auto) return result;
  const now = options.now ?? Date.now();
  const logger = options.logger;
  const cache = options.storageDomain;
  let table;
  if (cache !== undefined && cache !== null && typeof cache.table === 'function') {
    try {
      table = cache.table('years');
    } catch (error) {
      table = undefined;
    }
  }
  const explicitYears = settings.years;
  const years = explicitYears ?? holidayYearsFor(now, base.timeZoneOffsetMinutes)
    .filter((year) => !BUILT_IN_YEARS.has(String(year)));
  if (years.length === 0) return result;

  const extra = [];
  const pending = [];
  for (const year of years) {
    const record = table === undefined ? undefined : table.get(String(year));
    if (record !== undefined && cacheRecordFresh(record, now)) {
      result.cachedYears.push(year);
      if (record.status === 'ok' && Array.isArray(record.dates)) extra.push(...record.dates);
      continue;
    }
    pending.push(year);
  }
  if (pending.length > 0) {
    const fetched = await Promise.all(pending.map(async (year) => ({
      year,
      data: await fetchHolidayYear(year, {
        sources: settings.sources,
        timeoutMs: settings.timeoutMs,
        fetchImpl: options.fetchImpl,
        now,
      }),
    })));
    const writes = [];
    for (const { year, data } of fetched) {
      if (data === undefined) {
        result.failedYears.push(year);
        writes.push([String(year), { status: 'unavailable', fetchedAt: now }]);
        if (year >= beijingYear(now, base.timeZoneOffsetMinutes)) {
          warn(logger, `conversation-cost: no published holiday calendar found for ${year}; using the built-in table until it is available.`);
        }
        continue;
      }
      result.fetchedYears.push(year);
      extra.push(...data.dates);
      writes.push([String(year), { status: 'ok', dates: data.dates, source: data.source, fetchedAt: now }]);
    }
    if (table !== undefined) {
      for (const [key, value] of writes) {
        try {
          await table.put(key, value);
        } catch (error) {
          warn(logger, `conversation-cost: could not cache the ${key} holiday calendar: ${String(error)}`);
        }
      }
    }
  }
  if (extra.length > 0) {
    result.rule = { ...base, holidays: new Set([...base.holidays, ...extra]) };
  }
  return result;
}

/** Best-effort diagnostic logger. */
function warn(logger, message) {
  if (logger === undefined || logger === null) return;
  if (typeof logger.warn === 'function') logger.warn(message);
}

/**
 * Whether one instant falls in DeepSeek's peak-price window.
 * @param ms - epoch milliseconds of the billable request start.
 * @param rule - normalized rule from {@link normalizeRule} (or {@link resolveRule}).
 * @returns `true` for a weekday inside a peak window that is not a holiday.
 */
export function isPeakTime(ms, rule) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return false;
  const clock = new Date(ms + rule.timeZoneOffsetMinutes * MINUTE_MS);
  const weekday = clock.getUTCDay();
  // 0 = Sunday, 6 = Saturday: the whole weekend is off-peak.
  if (weekday === 0 || weekday === 6) return false;
  if (rule.holidays.has(beijingDateKey(ms, rule.timeZoneOffsetMinutes))) return false;
  const minutes = clock.getUTCHours() * 60 + clock.getUTCMinutes();
  return rule.peakWindows.some(([start, end]) => minutes >= start && minutes < end);
}

/** Four disjoint provider buckets; the Client prices them by period. */
function zeroBuckets() {
  return { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

/** Read one provider-reported bucket without trusting its type. */
function countOf(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

/** Provider usage record → our four buckets. */
function bucketsOf(usage) {
  return {
    uncachedInputTokens: countOf(usage.inputTokens),
    outputTokens: countOf(usage.outputTokens),
    cacheReadTokens: countOf(usage.cacheReadTokens),
    cacheWriteTokens: countOf(usage.cacheWriteTokens),
  };
}

function sameBuckets(left, right) {
  return left.uncachedInputTokens === right.uncachedInputTokens
    && left.outputTokens === right.outputTokens
    && left.cacheReadTokens === right.cacheReadTokens
    && left.cacheWriteTokens === right.cacheWriteTokens;
}

/** Bucket-wise `base + sign × delta`, without mutating either input. */
function shiftBuckets(base, delta, sign) {
  return {
    uncachedInputTokens: base.uncachedInputTokens + sign * delta.uncachedInputTokens,
    outputTokens: base.outputTokens + sign * delta.outputTokens,
    cacheReadTokens: base.cacheReadTokens + sign * delta.cacheReadTokens,
    cacheWriteTokens: base.cacheWriteTokens + sign * delta.cacheWriteTokens,
  };
}

/** Clamp a bucket set for the wire (never publish a negative number). */
function clampedBuckets(buckets) {
  return {
    uncachedInputTokens: Math.max(0, buckets.uncachedInputTokens),
    outputTokens: Math.max(0, buckets.outputTokens),
    cacheReadTokens: Math.max(0, buckets.cacheReadTokens),
    cacheWriteTokens: Math.max(0, buckets.cacheWriteTokens),
  };
}

/** One route's two period buckets. */
function emptyRoute(provider, model) {
  return { provider, model, peak: zeroBuckets(), offpeak: zeroBuckets() };
}

/** Internal map key for one model route. */
function routeKeyOf(route) {
  return `${route.provider}/${route.model}`;
}

/**
 * The usage one durable settlement event reports for its attempt, if any.
 * Prefers the final `usage` record, then the last usage chunk of the stream,
 * matching the token-meter fold so both projections agree.
 */
export function usageOf(event) {
  if (event.type === 'assistant/message' && event.data.usage !== undefined && event.data.usage !== null) {
    return event.data.usage;
  }
  if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return undefined;
  const stream = event.data.stream;
  if (!Array.isArray(stream)) return undefined;
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const record = stream[index];
    if (record !== null && typeof record === 'object' && record.type === 'chunk'
      && record.chunk !== null && typeof record.chunk === 'object' && record.chunk.type === 'usage') {
      return record.chunk.usage;
    }
  }
  return undefined;
}

/** Route that produced one settlement: the message source wins over the last header. */
function routeOf(state, event) {
  if (event.type === 'assistant/message') {
    const source = event.data.message === undefined ? undefined : event.data.message.source;
    if (source !== undefined && source !== null
      && typeof source.provider === 'string' && typeof source.model === 'string') {
      return { provider: source.provider, model: source.model };
    }
  }
  if (state.currentRoute !== null) return state.currentRoute;
  return { provider: '', model: '' };
}

/** Bill one settlement sample at its step's start time. */
function foldUsage(state, event, rule) {
  const usage = usageOf(event);
  if (usage === undefined) return state;
  const turn = event.data.turn;
  const step = event.data.step;
  const previous = state.last !== null && state.last.turn === turn && state.last.step === step
    ? state.last
    : null;
  const route = routeOf(state, event);
  const routeKey = routeKeyOf(route);
  const billedAt = state.step !== null && state.step.turn === turn && state.step.step === step
    ? state.step.startTime
    : event.time;
  const period = isPeakTime(billedAt, rule) ? 'peak' : 'offpeak';
  const buckets = bucketsOf(usage);
  if (previous !== null && previous.routeKey === routeKey && previous.period === period
    && sameBuckets(previous.buckets, buckets)) {
    return state;
  }
  const routes = { ...state.routes };
  if (previous !== null) {
    const previousRoute = routes[previous.routeKey];
    if (previousRoute !== undefined) {
      routes[previous.routeKey] = {
        ...previousRoute,
        [previous.period]: shiftBuckets(previousRoute[previous.period], previous.buckets, -1),
      };
    }
  }
  const routeEntry = routes[routeKey] === undefined
    ? emptyRoute(route.provider, route.model)
    : routes[routeKey];
  routes[routeKey] = {
    ...routeEntry,
    [period]: shiftBuckets(routeEntry[period], buckets, 1),
  };
  return {
    ...state,
    routes,
    last: { turn, step, routeKey, period, buckets },
  };
}

/**
 * Build the `conversationCost` projection unit for one resolved calendar rule.
 * @param rule - normalized pricing calendar.
 * @returns the projection definition handed to `sessionProjections.register`.
 */
export function createConversationCostProjection(rule) {
  return {
    key: 'conversationCost',
    stateVersion: 1,
    stateSchema: PASS_THROUGH,
    init: () => ({ routes: {}, currentRoute: null, step: null, last: null }),
    apply: (state, event) => {
      switch (event.type) {
        case 'step/start': {
          const turn = event.data.turn;
          const step = event.data.step;
          if (state.step !== null && state.step.turn === turn && state.step.step === step) return state;
          return { ...state, step: { turn, step, startTime: event.time } };
        }
        case 'request/header': {
          const config = event.data.header === undefined ? undefined : event.data.header.config;
          if (config === undefined || config === null) return state;
          const route = { provider: String(config.provider), model: String(config.model) };
          if (state.currentRoute !== null
            && state.currentRoute.provider === route.provider
            && state.currentRoute.model === route.model) {
            return state;
          }
          return { ...state, currentRoute: route };
        }
        case 'llm/retry-started': {
          if (state.last === null || state.last.turn !== event.data.turn || state.last.step !== event.data.step) {
            return state;
          }
          // A retried attempt is billed separately; stop replacing the sample.
          return { ...state, last: null };
        }
        case 'assistant/message':
        case 'assistant/attempt':
          return foldUsage(state, event, rule);
        default:
          return state;
      }
    },
    wire: {
      // Session list rows do not render this figure.
      summary: false,
      viewSchema: PASS_THROUGH,
      view: (state) => ({
        routes: Object.keys(state.routes)
          .sort()
          .map((key) => {
            const entry = state.routes[key];
            return {
              provider: entry.provider,
              model: entry.model,
              peak: clampedBuckets(entry.peak),
              offpeak: clampedBuckets(entry.offpeak),
            };
          }),
        // The resolved calendar travels with the value, so the Client half can
        // show the live period/countdown without duplicating the holiday table.
        rule: {
          timeZoneOffsetMinutes: rule.timeZoneOffsetMinutes,
          peakWindows: rule.peakWindows.map(([start, end]) => [start, end]),
          holidays: [...rule.holidays].sort(),
        },
      }),
    },
  };
}

/**
 * Register the projection unit; the registration is an effect on this
 * plugin's fiber, so unloading removes the key.
 *
 * The holiday calendar is resolved first: cached years read from the profile
 * storage domain, missing years fetched from the public dataset (fail-soft).
 *
 * @param ctx - registrant context carrying the projection registry.
 * @param config - raw row config carrying the pricing calendar overrides.
 * @returns when the plugin is ready.
 */
export async function apply(ctx, config) {
  let cache;
  const storageDomain = ctx.get('storageDomain');
  if (storageDomain !== undefined && storageDomain !== null && typeof storageDomain.open === 'function') {
    try {
      cache = await storageDomain.open(CACHE_SPEC);
      ctx.effect(() => () => cache.close(), 'conversation-cost: holiday calendar cache');
    } catch (error) {
      warn(ctx.logger, `conversation-cost: holiday cache unavailable: ${String(error)}`);
      cache = undefined;
    }
  }
  const resolved = await resolveRule(config, {
    storageDomain: cache,
    logger: ctx.logger,
  });
  await ctx.sessionProjections.register(createConversationCostProjection(resolved.rule));
}
