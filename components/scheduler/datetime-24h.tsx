"use client";

/**
 * Date + 24-hour time picker.
 *
 * ── Why this exists instead of `<input type="datetime-local">` ───────────────
 *
 * Native `datetime-local` (and `type="time"`) render their clock from the
 * BROWSER/OS locale, not from the page. On an en-US machine that is a 12-hour
 * field with an AM/PM segment, and there is no attribute, CSS property or JS
 * hook that changes it — `hour12`/`hourCycle` apply to `Intl` formatting, never
 * to a native control's own editor. The only way to guarantee 24-hour input is
 * to stop using the native time editor, which is what this does: a native date
 * input (whose format is harmless and locale-appropriate) plus two explicit
 * 00–23 / 00–59 selects.
 *
 * Selects rather than a free-text "HH:MM" box on purpose — they cannot produce
 * an unparseable value, so no validation layer is needed and there is no state
 * where the field looks filled but submits nothing.
 *
 * ── Contract ────────────────────────────────────────────────────────────────
 *
 * `value` and `onChange` speak the exact same `YYYY-MM-DDTHH:mm` string the
 * native control used, so this is a drop-in swap: the surrounding lead-time
 * checks, `toLocalInputValue()` seeding and submit payloads all keep working
 * unchanged. Seconds are tolerated on input and dropped on output.
 */

const HOURS = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, "0"));
const MINUTES = Array.from({ length: 60 }, (_, i) => String(i).padStart(2, "0"));

interface DateTime24hProps {
  /** `YYYY-MM-DDTHH:mm`, or "" when nothing is chosen yet. */
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}

/** Splits the input value without going through `Date` — no timezone shifts. */
function parse(value: string): { date: string; hour: string; minute: string } {
  const [date = "", time = ""] = value.split("T");
  const [hour = "", minute = ""] = time.split(":");
  return { date, hour, minute };
}

export default function DateTime24h({
  value,
  onChange,
  disabled = false,
}: DateTime24hProps) {
  const { date, hour, minute } = parse(value);

  // A time without a date is not a moment, so nothing is emitted until the date
  // exists. Once it does, a missing time part settles at 00 rather than
  // blocking — the surrounding lead-time check catches a too-early result and
  // offers a fix, which is friendlier than an input that refuses to update.
  function emit(next: Partial<{ date: string; hour: string; minute: string }>) {
    const merged = { date, hour, minute, ...next };
    if (!merged.date) {
      onChange("");
      return;
    }
    const hh = merged.hour || "00";
    const mm = merged.minute || "00";
    onChange(`${merged.date}T${hh}:${mm}`);
  }

  const fieldClass =
    "rounded-lg border border-border bg-background px-3 py-2 text-sm focus:border-foreground/30 focus:outline-none disabled:opacity-60";

  return (
    <div className="flex flex-wrap items-center gap-2">
      <input
        type="date"
        value={date}
        onChange={(e) => emit({ date: e.target.value })}
        disabled={disabled}
        className={fieldClass}
        aria-label="Date"
      />
      <div className="flex items-center gap-1">
        <select
          value={hour}
          onChange={(e) => emit({ hour: e.target.value })}
          disabled={disabled}
          className={fieldClass}
          aria-label="Hour (24-hour clock)"
        >
          {/* Only reachable before a time is set; never re-selectable, so it
              cannot put the field back into a half-filled state. */}
          {!hour && <option value="" disabled />}
          {HOURS.map((h) => (
            <option key={h} value={h}>
              {h}
            </option>
          ))}
        </select>
        <span aria-hidden="true" className="text-sm text-muted">
          :
        </span>
        <select
          value={minute}
          onChange={(e) => emit({ minute: e.target.value })}
          disabled={disabled}
          className={fieldClass}
          aria-label="Minute"
        >
          {!minute && <option value="" disabled />}
          {MINUTES.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
