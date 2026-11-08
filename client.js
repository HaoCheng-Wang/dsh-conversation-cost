/**
 * Conversation cost pill — a Web UI decoration for the composer dock.
 *
 * Reads two client-visible Session projections:
 *   - `conversationCost` the Host fold of provider-reported usage, split by
 *     model route and by DeepSeek's peak/off-peak price period, plus the
 *     resolved pricing calendar;
 *   - `tokenUsage`      the flat whole-log usage total, used as a fallback
 *                       when the peak/off-peak projection is unavailable.
 * plus `modelSelection`, the current provider/model (fallback path only).
 *
 * The pill shows the estimated spend and the CURRENT price period (peak or
 * off-peak); its tooltip carries the next switch countdown, the per-period
 * breakdown, and the calendar rule.
 *
 * The spend is an ESTIMATE: tokens × the price card below. Peak is the
 * standard list price; off-peak is half. It is not a bill, and the Host
 * persists no billing data. Adjust `PRICES` to the rates a deployment is
 * actually charged, then reload the page.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-conversation-cost',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Client locale namespace owned by this plugin. */
    const NS = 'conversation-cost';

    /** English dictionary; flat dotted keys, the same shape the host uses. */
    const en = {
      'cost.pill': '≈{amount}',
      'cost.aria': 'Estimated conversation cost {amount}',
      'cost.tooltipTitle': 'Estimated conversation cost',
      'cost.peak': 'Peak',
      'cost.offpeak': 'Off-peak',
      'cost.input': 'input',
      'cost.cacheRead': 'cache hit',
      'cost.cacheWrite': 'cache write',
      'cost.output': 'output',
      'cost.total': 'Total',
      'cost.nowPeak': 'Now: peak (off-peak in {duration})',
      'cost.nowPeakOnly': 'Now: peak',
      'cost.nowOffpeak': 'Now: off-peak, half price (peak in {duration})',
      'cost.nowOffpeakOnly': 'Now: off-peak, half price',
      'cost.duration.hours': '{hours}h {minutes}m',
      'cost.duration.minutes': '{minutes}m',
      'cost.window': 'Peak: Beijing time, weekdays 09:00–12:00 and 14:00–18:00, statutory holidays excluded. Off-peak is half price; each request is priced by the period in effect when it started.',
      'cost.fallback': 'Peak/off-peak split is unavailable; every token is priced at the peak rate.',
      'cost.unknownModel': 'default price',
      'cost.note': 'Estimate = provider-reported tokens × configured price card. Not a bill; edit PRICES in client.js to match your provider.',
      'cost.perMillion': '/M tok',
    };

    /** Simplified Chinese dictionary. */
    const zh = {
      'cost.pill': '≈{amount}',
      'cost.aria': '当前对话估算花费 {amount}',
      'cost.tooltipTitle': '当前对话估算花费',
      'cost.peak': '高峰',
      'cost.offpeak': '空闲',
      'cost.input': '输入',
      'cost.cacheRead': '缓存命中',
      'cost.cacheWrite': '缓存写入',
      'cost.output': '输出',
      'cost.total': '合计',
      'cost.nowPeak': '当前：高峰（距空闲 {duration}）',
      'cost.nowPeakOnly': '当前：高峰',
      'cost.nowOffpeak': '当前：空闲，单价减半（距高峰 {duration}）',
      'cost.nowOffpeakOnly': '当前：空闲，单价减半',
      'cost.duration.hours': '{hours} 小时 {minutes} 分',
      'cost.duration.minutes': '{minutes} 分钟',
      'cost.window': '高峰时段：北京时间工作日 09:00–12:00、14:00–18:00（不含法定节假日）；空闲价为高峰价的一半，每次请求按开始时所处时段计价。',
      'cost.fallback': '缺少峰谷明细，暂按高峰价估算全部 token。',
      'cost.unknownModel': '默认价格',
      'cost.note': '估算 = 供应商上报 token × 本插件价目表；并非账单金额，可在 client.js 的 PRICES 中按实际价格修改。',
      'cost.perMillion': '/百万 tok',
    };

    /** Currency symbol used for every amount in this widget. */
    const CURRENCY = '¥';

    /** How often the period badge re-evaluates the clock. */
    const CLOCK_TICK_MS = 30 * 1000;

    /**
     * Peak and off-peak prices in `CURRENCY` per 1,000,000 tokens, keyed by
     * model id. Lookup tries the complete id first, then its last
     * `/`-separated segment, then a family rule, then `DEFAULT_RATES`.
     *
     * The cards below are DeepSeek's current list prices (effective
     * 2026-08-17): `deepseek-flash` and `deepseek-v4-pro`, per million tokens
     * of cache-hit input / cache-miss input / output. Off-peak is half price.
     * `cacheWrite` has no DeepSeek bucket of its own; keep it equal to `input`
     * so a provider that reports writes is charged like a cache miss.
     */
    const PRICES = {
      'deepseek-flash': {
        peak: { input: 2, cacheRead: 0.04, cacheWrite: 2, output: 8 },
        offpeak: { input: 1, cacheRead: 0.02, cacheWrite: 1, output: 4 },
      },
      'deepseek-v4-pro': {
        peak: { input: 9, cacheRead: 0.3, cacheWrite: 9, output: 27 },
        offpeak: { input: 4.5, cacheRead: 0.15, cacheWrite: 4.5, output: 13.5 },
      },
    };

    /** Rates for uncatalogued routes (shape matches one `PRICES` value). */
    const DEFAULT_RATES = PRICES['deepseek-flash'];

    const ZERO_BUCKETS = {
      uncachedInputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
    };

    const MINUTE_MS = 60 * 1000;
    const DAY_MS = 24 * 60 * MINUTE_MS;

    const amountFormat = new Intl.NumberFormat(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 4,
    });
    const tokenFormat = new Intl.NumberFormat(undefined);

    /** Format a token count for tooltips. */
    function formatTokens(tokens) {
      return tokenFormat.format(Math.max(0, Math.round(tokens || 0)));
    }

    /**
     * Compact currency text that keeps meaningful digits at conversation
     * scale (sub-cent amounts would otherwise read as ¥0.00).
     */
    function formatMoney(value) {
      if (!Number.isFinite(value) || value <= 0) return CURRENCY + '0.00';
      if (value < 0.0001) return CURRENCY + '<0.0001';
      if (value >= 1) return CURRENCY + value.toFixed(2);
      return CURRENCY + amountFormat.format(value);
    }

    function hasOwn(object, key) {
      return Object.prototype.hasOwnProperty.call(object, key);
    }

    /** Read one positive integer off the wire without trusting its type. */
    function countOf(value) {
      return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
    }

    /** Normalize one bucket record from either projection. */
    function bucketsOf(raw) {
      if (raw === null || typeof raw !== 'object') return ZERO_BUCKETS;
      return {
        uncachedInputTokens: countOf(raw.uncachedInputTokens),
        cacheReadTokens: countOf(raw.cacheReadTokens),
        cacheWriteTokens: countOf(raw.cacheWriteTokens),
        outputTokens: countOf(raw.outputTokens),
      };
    }

    /** Sum of the four disjoint buckets. */
    function tokenTotal(buckets) {
      return buckets.uncachedInputTokens + buckets.cacheReadTokens
        + buckets.cacheWriteTokens + buckets.outputTokens;
    }

    /** Resolve the peak/off-peak rate card for one model id. */
    function ratesFor(model) {
      if (typeof model !== 'string' || model === '') return DEFAULT_RATES;
      const candidates = [model];
      const tail = model.split('/').pop();
      if (tail && tail !== model) candidates.push(tail);
      for (const candidate of candidates) {
        if (hasOwn(PRICES, candidate)) return PRICES[candidate];
      }
      if (/flash/i.test(model)) return PRICES['deepseek-flash'];
      if (/v4[^\d]?pro/i.test(model)) return PRICES['deepseek-v4-pro'];
      return DEFAULT_RATES;
    }

    /** Price one bucket set with one rate card. */
    function costOf(buckets, card) {
      return (
        buckets.uncachedInputTokens * card.input
        + buckets.cacheReadTokens * card.cacheRead
        + buckets.cacheWriteTokens * card.cacheWrite
        + buckets.outputTokens * card.output
      ) / 1e6;
    }

    /** One compact "input 1,234×¥2 · … = ¥0.01" fragment. */
    function describeBuckets(buckets, card, cost, t) {
      const parts = [];
      const push = (label, tokens, rate) => {
        if (tokens > 0) parts.push(`${label} ${formatTokens(tokens)}×${CURRENCY}${rate}`);
      };
      push(t('cost.input'), buckets.uncachedInputTokens, card.input);
      push(t('cost.cacheRead'), buckets.cacheReadTokens, card.cacheRead);
      push(t('cost.cacheWrite'), buckets.cacheWriteTokens, card.cacheWrite);
      push(t('cost.output'), buckets.outputTokens, card.output);
      if (parts.length === 0) return formatMoney(0);
      return `${parts.join(' · ')} ${t('cost.perMillion')} = ${formatMoney(cost)}`;
    }

    /** Current provider/model, for the fallback path. */
    function currentModel(selection) {
      if (selection === undefined || selection === null) return null;
      if (selection.next !== undefined && selection.next !== null && typeof selection.next.model === 'string') {
        return selection.next.model;
      }
      if (selection.lastUsed !== undefined && selection.lastUsed !== null && typeof selection.lastUsed.model === 'string') {
        return selection.lastUsed.model;
      }
      return null;
    }

    /** Price the Host's per-route, per-period split. */
    function priceSplit(routes, t) {
      if (!Array.isArray(routes) || routes.length === 0) return null;
      const lines = [];
      let total = 0;
      for (const route of routes) {
        if (route === null || typeof route !== 'object') continue;
        const model = typeof route.model === 'string' ? route.model : '';
        const provider = typeof route.provider === 'string' ? route.provider : '';
        const label = model || provider || t('cost.unknownModel');
        const rates = ratesFor(model);
        for (const period of ['peak', 'offpeak']) {
          const buckets = bucketsOf(route[period]);
          if (tokenTotal(buckets) === 0) continue;
          const cost = costOf(buckets, rates[period]);
          total += cost;
          lines.push(`${label} · ${t(`cost.${period}`)}: ${describeBuckets(buckets, rates[period], cost, t)}`);
        }
      }
      return { total, lines };
    }

    /** Price the flat whole-log usage total at peak rates. */
    function priceFlat(usage, selection, t) {
      if (usage === undefined || usage === null) return null;
      const buckets = bucketsOf(usage);
      if (tokenTotal(buckets) === 0) return null;
      const model = currentModel(selection);
      const rates = ratesFor(model);
      const cost = costOf(buckets, rates.peak);
      const label = model || t('cost.unknownModel');
      return {
        total: cost,
        lines: [
          t('cost.fallback'),
          `${label} · ${t('cost.peak')}: ${describeBuckets(buckets, rates.peak, cost, t)}`,
        ],
      };
    }

    /**
     * Read the projection value: the Host currently publishes
     * `{ routes, rule }`; an older Host published a bare route array.
     */
    function splitOf(value) {
      if (Array.isArray(value)) return { routes: value, rule: null };
      if (value !== null && typeof value === 'object') {
        const routes = Array.isArray(value.routes) ? value.routes : [];
        return { routes, rule: ruleOf(value.rule) };
      }
      return { routes: null, rule: null };
    }

    /** Normalize the published pricing calendar, or null when unusable. */
    function ruleOf(raw) {
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
      const offset = raw.timeZoneOffsetMinutes;
      if (typeof offset !== 'number' || !Number.isFinite(offset)) return null;
      const windows = [];
      if (Array.isArray(raw.peakWindows)) {
        for (const entry of raw.peakWindows) {
          if (!Array.isArray(entry) || entry.length !== 2) continue;
          const [start, end] = entry;
          if (typeof start !== 'number' || typeof end !== 'number' || start < 0 || end > 1440 || start >= end) continue;
          windows.push([start, end]);
        }
      }
      if (windows.length === 0) return null;
      const holidays = new Set();
      if (Array.isArray(raw.holidays)) {
        for (const date of raw.holidays) if (typeof date === 'string') holidays.add(date);
      }
      return { timeZoneOffsetMinutes: offset, peakWindows: windows, holidays };
    }

    /** Beijing-style calendar date of one instant, as "YYYY-MM-DD". */
    function dateKeyAt(ms, offsetMinutes) {
      const clock = new Date(ms + offsetMinutes * MINUTE_MS);
      const month = clock.getUTCMonth() + 1;
      const day = clock.getUTCDate();
      return `${clock.getUTCFullYear()}-${month < 10 ? `0${month}` : month}-${day < 10 ? `0${day}` : day}`;
    }

    /** Whether one instant is inside the peak window. */
    function isPeakAt(ms, rule) {
      const clock = new Date(ms + rule.timeZoneOffsetMinutes * MINUTE_MS);
      const weekday = clock.getUTCDay();
      if (weekday === 0 || weekday === 6) return false;
      if (rule.holidays.has(dateKeyAt(ms, rule.timeZoneOffsetMinutes))) return false;
      const minutes = clock.getUTCHours() * 60 + clock.getUTCMinutes();
      return rule.peakWindows.some(([start, end]) => minutes >= start && minutes < end);
    }

    /** Next instant the period flips, or null when no switch is found. */
    function nextSwitchAt(ms, rule) {
      const offsetMs = rule.timeZoneOffsetMinutes * MINUTE_MS;
      const shifted = ms + offsetMs;
      const dayStart = Math.floor(shifted / DAY_MS) * DAY_MS;
      const clock = new Date(shifted);
      const minutes = clock.getUTCHours() * 60 + clock.getUTCMinutes();
      if (isPeakAt(ms, rule)) {
        const window = rule.peakWindows.find(([start, end]) => minutes >= start && minutes < end);
        if (window !== undefined) return dayStart + window[1] * MINUTE_MS - offsetMs;
      }
      for (let dayOffset = 0; dayOffset <= 21; dayOffset += 1) {
        const dayStartShifted = dayStart + dayOffset * DAY_MS;
        const dayClock = new Date(dayStartShifted);
        const weekday = dayClock.getUTCDay();
        if (weekday === 0 || weekday === 6) continue;
        const month = dayClock.getUTCMonth() + 1;
        const day = dayClock.getUTCDate();
        const key = `${dayClock.getUTCFullYear()}-${month < 10 ? `0${month}` : month}-${day < 10 ? `0${day}` : day}`;
        if (rule.holidays.has(key)) continue;
        for (const [start] of rule.peakWindows) {
          if (dayOffset === 0 && start <= minutes) continue;
          return dayStartShifted + start * MINUTE_MS - offsetMs;
        }
      }
      return null;
    }

    /** Phase-duration text for the tooltip. */
    function formatDuration(ms, t) {
      const totalMinutes = Math.max(1, Math.round(ms / MINUTE_MS));
      const hours = Math.floor(totalMinutes / 60);
      const minutes = totalMinutes % 60;
      return hours > 0
        ? t('cost.duration.hours', { hours, minutes })
        : t('cost.duration.minutes', { minutes });
    }

    /** A 30-second clock tick for the live period badge. */
    function useNow() {
      const [now, setNow] = React.useState(() => Date.now());
      React.useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
        return () => clearInterval(timer);
      }, []);
      return now;
    }

    /** Flat-dictionary fallback used when the locale seat is unavailable. */
    function fallbackTranslate(key, params) {
      const template = en[key];
      if (typeof template !== 'string') return key;
      if (params === undefined) return template;
      return template.replace(/\{(\w+)\}/g, (match, name) =>
        hasOwn(params, name) ? String(params[name]) : match,
      );
    }

    /** Stable no-op projection reader so the hook order never changes. */
    const EMPTY_PROJECTION = () => undefined;

    /**
     * The dock entry: a quiet pill showing the estimated spend and the current
     * price period, with the breakdown and countdown in its native tooltip.
     */
    function ConversationCostPill(props) {
      const useProjection =
        typeof props.useProjection === 'function' ? props.useProjection : EMPTY_PROJECTION;
      const t = typeof props.t === 'function' ? props.t : fallbackTranslate;

      const split = useProjection('conversationCost');
      const usage = useProjection('tokenUsage');
      const selection = useProjection('modelSelection');
      const now = useNow();

      try {
        return renderPill(split, usage, selection, now, t);
      } catch (error) {
        // A decoration must never blank a dock entry because a projection
        // carried an unexpected shape; hide the pill and log the cause.
        if (typeof console !== 'undefined' && typeof console.error === 'function') {
          console.error('conversation-cost: failed to render the cost pill', error);
        }
        return null;
      }
    }

    /** Build the pill from already-read projection values. */
    function renderPill(split, usage, selection, now, t) {
      const { routes, rule } = splitOf(split);
      let result = priceSplit(routes, t);
      if (result === null || !(result.total > 0)) result = priceFlat(usage, selection, t);
      if (result === null || !(result.total > 0)) return null;
      const amount = formatMoney(result.total);

      // Live period badge, from the calendar the Host published with the value.
      let period = null;
      let periodLabel = null;
      let periodLine = null;
      if (rule !== null) {
        const peak = isPeakAt(now, rule);
        period = peak ? 'peak' : 'offpeak';
        periodLabel = t(`cost.${period}`);
        const next = nextSwitchAt(now, rule);
        const duration = next === null ? null : formatDuration(next - now, t);
        if (duration === null) {
          periodLine = t(peak ? 'cost.nowPeakOnly' : 'cost.nowOffpeakOnly');
        } else {
          periodLine = t(peak ? 'cost.nowPeak' : 'cost.nowOffpeak', { duration });
        }
      }

      const title = [
        t('cost.tooltipTitle'),
        '',
        ...(periodLine === null ? [] : [periodLine, '']),
        ...result.lines,
        '',
        `${t('cost.total')} = ${amount}`,
        '',
        t('cost.window'),
        t('cost.note'),
      ].join('\n');

      const icon = h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: 14,
          height: 14,
          'aria-hidden': true,
          style: { flex: 'none', width: 14, height: 14, display: 'block' },
        },
        h('circle', {
          cx: 8,
          cy: 8,
          r: 6.25,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.2,
        }),
        h('path', {
          d: 'M5.3 4.5 8 7.65l2.7-3.15M8 7.65v4.15M5.7 8.9h4.6M5.7 10.4h4.6',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      );

      const children = [
        icon,
        h(
          'span',
          {
            style: {
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            },
          },
          t('cost.pill', { amount }),
        ),
      ];
      if (period !== null) {
        children.push(
          h(
            'span',
            {
              'aria-hidden': true,
              style: { color: 'var(--dsw-alias-separator-primary, currentColor)', flex: 'none' },
            },
            '·',
          ),
          h('span', {
            'aria-hidden': true,
            style: {
              flex: 'none',
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: period === 'peak'
                ? 'var(--dsw-alias-state-warn-primary, currentColor)'
                : 'var(--dsw-alias-state-success-primary, currentColor)',
            },
          }),
          h(
            'span',
            {
              style: {
                flex: 'none',
                color: 'var(--dsw-alias-label-tertiary)',
              },
            },
            periodLabel,
          ),
        );
      }

      const ariaLabel = period === null
        ? t('cost.aria', { amount })
        : `${t('cost.aria', { amount })} · ${periodLabel}`;

      return h(
        'span',
        {
          'data-composer-stat': 'cost',
          title,
          'aria-label': ariaLabel,
          style: {
            boxSizing: 'border-box',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '1px 8px',
            borderRadius: 'var(--dsw-radius-sm)',
            color: 'var(--dsw-alias-label-tertiary)',
            fontSize: 'calc(var(--dsh-content-font-size-secondary, 13px) - 1px)',
            lineHeight: 'calc(20px + var(--dsh-content-font-delta-secondary, 0px))',
            fontVariantNumeric: 'tabular-nums',
            whiteSpace: 'nowrap',
            maxWidth: '100%',
          },
        },
        ...children,
      );
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(
          () => ctx.locale.register(NS, { en, zh }),
          'conversation-cost: dictionaries',
        );
        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register(
            {
              name: 'conversation.composer.dock',
              id: 'conversation-cost',
              order: 2,
              locale: NS,
            },
            ConversationCostPill,
          ),
        );
      },
    };
  },
});
