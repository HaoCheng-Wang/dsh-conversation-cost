# Conversation cost

A composer-dock decoration for the DeepSeek Harness Web UI: below the message
composer it shows an estimated spend for the current conversation, priced from
the provider-reported token usage of the whole Session. It handles DeepSeek's
**peak / off-peak pricing**: every request is priced by the period in effect
when it started, and mixed-model Sessions price each model route separately.

## Install

The repository root is the bundle package (`package.json` declares
`dsh.bundle.patch`), so install it with the Harness plugin manager from this
repository or a local clone:

```text
https://github.com/HaoCheng-Wang/dsh-conversation-cost
```

The plugin activates for the whole profile; the Calendar cache lives under
`$DSH_HOME/storages/conversation_cost.json`.

## What it shows

A quiet pill — `≈¥1.25 · ● 空闲` — beside the shipped activity and usage pills:

- `≈¥1.25` — the estimated spend of the conversation so far;
- `● 空闲` / `● 高峰` — the **current** price period (green dot = off-peak,
  amber dot = peak). Hovering shows how long until the period switches.

The native tooltip carries the per-period token breakdown, the current period
with a countdown to the next switch, the totals, the calendar rule, and a note
that the figure is an estimate, not a bill.

## Peak / off-peak rule

DeepSeek's current rule (effective 2026-08-17):

| | |
|---|---|
| Peak | Beijing time, Monday–Friday, 09:00–12:00 and 14:00–18:00; Chinese statutory holidays excluded |
| Off-peak | every other moment, including weekends and holidays all day |
| Off-peak price | 50% of the peak price |

The Host half classifies each model request by its step's `step/start` time
(the moment the request started), so a request straddling a price boundary is
priced by the period it began in. The resolved calendar (windows + holiday
dates) is published with the projection so the Client half can show the live
period and countdown without a second copy of the table.

Current list prices used by the default card (CNY per 1M tokens):

| Model | Cache hit (peak/off-peak) | Cache miss (peak/off-peak) | Output (peak/off-peak) |
|---|---|---|---|
| `deepseek-flash` | ¥0.04 / ¥0.02 | ¥2 / ¥1 | ¥8 / ¥4 |
| `deepseek-v4-pro` | ¥0.30 / ¥0.15 | ¥9 / ¥4.5 | ¥27 / ¥13.5 |

Edit the `PRICES` table in `client.js` to match the provider a profile is
actually charged by, then reload the page.

## Automatic holiday calendar

**No yearly action is needed.** The Host half resolves the calendar each time
it activates:

1. **Built-in years** ship with the package (currently 2026 and 2027) and are
   trusted as-is.
2. **Other needed years are fetched automatically** from the annually
   maintained [holiday-cn](https://github.com/NateScarlet/holiday-cn) dataset,
   in this source order:
   - GitHub Contents API
     `https://api.github.com/repos/NateScarlet/holiday-cn/contents/{year}.json`,
   - jsDelivr `https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/{year}.json`,
   - raw.githubusercontent
     `https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/{year}.json`.
3. **Which years**: the current year, plus the next year from October (when the
   State Council schedule is usually published), plus the previous year in
   January (for Sessions straddling New Year). Years already covered by the
   built-in table are skipped, so a normal start makes no request.
4. **Cache**: fetched calendars are stored in the profile storage domain
   `conversation_cost` (`$DSH_HOME/storages/conversation_cost.json`). A cached
   year costs no request; successful data is refreshed after 30 days, an
   unpublished year is retried after 3 days.
5. **Fail-soft**: if every source is unreachable, the built-in/config table is
   used and a warning is logged; cost figures keep working.

Only off-days are taken from the dataset (`isOffDay: true`); make-up weekend
workdays stay off-peak because the peak rule requires a weekday. Payloads are
validated (only real `YYYY-MM-DD` dates from the requested year are accepted).

### Manual override (still supported)

The profile patch can override the calendar; useful for an air-gapped machine
or a provider with its own holiday policy:

`~/.dsh/profiles/web/cordis.patch.yml`

```yaml
- id: conversation-cost
  name: "@local/dsh-conversation-cost"
  config:
    extraHolidays:
      - "2028-01-01"
      - "2028-01-02"
```

| Field | Meaning |
|---|---|
| `autoHolidayUpdate` | `false` disables the automatic fetch entirely (built-in + config only). |
| `holidaySources` | URL template list containing `{year}`; replaces the default source order. |
| `holidayFetchTimeoutMs` | Total budget per activation for all fetches; default `5000`. |
| `holidayYears` | Explicit year list to fetch (diagnostics/testing); replaces the automatic window. |
| `extraHolidays` | Beijing dates appended to the built-in table. |
| `holidays` | Full replacement list for the built-in table. |
| `peakWindows` | `[["09:00","12:00"], ["14:00","18:00"]]` by default; accepts `HH:MM` strings or minutes-of-day. |
| `timeZoneOffsetMinutes` | Fixed UTC offset used for the calendar; defaults to `480` (Beijing, no DST). |

Notes:

- A patch override replaces the row's complete config; fields you omit fall
  back to the plugin's built-in defaults.
- Changing the profile patch reloads the running profile (the Host watches its
  patch files).
- Invalid config entries (bad dates, reversed windows, non-URL sources) are
  ignored; the affected field falls back to its default instead of breaking the
  plugin.

Reference: the [2026](http://big5.www.gov.cn/gate/big5/www.gov.cn/zhengce/content/202511/content_7047090.htm)
and [2027](https://www.gov.cn/zhengce/content/202611/content_7085101.htm)
State Council arrangements.

## Where the numbers come from

| Input | Source |
|---|---|
| Per-period tokens | Host projection `conversationCost` (client-visible): folds `step/start`, `request/header`, `llm/retry-started`, `assistant/message`, and `assistant/attempt` events into per-route peak/off-peak buckets |
| Calendar + periods | the same projection's `rule` field, resolved from the plugin config and the auto-updated holiday data |
| Fallback tokens | client-visible `tokenUsage` projection (flat whole-log total), priced at the peak rate when the split is unavailable |
| Model (fallback only) | `modelSelection` projection |
| Rates | `PRICES` in `client.js` |

The Harness persists no billing data, so cost is always an estimate:
`tokens × configured rate card`.

## Composition

```yaml
- insert:
    - id: conversation-cost
      name: '@local/dsh-conversation-cost'
```

The Host half registers one client-visible Session projection
(`conversationCost`, `summary: false`) and the `conversation_cost` storage
domain for its calendar cache. The Client half registers the pill in
`conversation.composer.dock` and its own locale namespace.
