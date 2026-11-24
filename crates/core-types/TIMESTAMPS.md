# Timestamp wire compatibility

The Rust workspace uses maintained library types directly, with two distinct roles:

- `time::OffsetDateTime` and `time::Duration` represent internal POSIX clocks,
  authentication deadlines, scan watermarks, leases and scheduling arithmetic.
- `tz::UtcDateTime` represents external observations, including chrono-era
  represented second-60 values. Its native calendar validation and native ordering
  retain that distinction without a timestamp wrapper or custom arithmetic engine.

Observation values include provider DTO dates, transcript segments, changed/skipped
objects, saved item timestamps, memory/evidence dates and memory export/import dates.
Internal clocks are not converted into observation values by parsing arbitrary text.

## Wire adapters

`timestamp_serde` parses and formats internal clock fields with native `time`
format descriptions. UTC conversion is checked, not panicking at the year range.

`observation_serde` uses the same native `time::Parsed` parser and the native tz-rs
constructors. RFC3339 offsets have whole-minute precision. Native timezone conversion
normalizes the minute; constructing the native UTC observation preserves its original
second and nanosecond components, including second 60.

The observation formatter uses native `time::Date` formatting for the date and native
tz-rs Display for the clock. Only the established wire details are adapted:

- JSON and Granola query timestamps use `Z`; revision inputs use `+00:00`.
- Fractional precision is grouped into 0/3/6/9 digits.
- Fractions longer than nine digits are consumed but truncated, never rounded.
- Signed extended years and the legacy space/lowercase separators remain supported.
- Invalid dates, invalid offsets, trailing junk and out-of-range UTC years return errors.
- The legacy Unicode minus offset sign is accepted without changing date separators.

Free-form evidence metadata retains its narrower historical four-digit-year
RFC3339 acceptance and malformed-value fallback; saved DTO observations retain
their extended-year grammar. Signed Slack epoch fallback input must also fit the
wire formatter's calendar range before ingress succeeds.

Default library serde is deliberately unavailable. Compile-fail tests prevent an
unadapted field from accidentally changing the wire representation. Utoipa schemas
continue to expose strings with the `date-time` format.

## Represented leap seconds

Native `time` and Jiff cannot retain chrono's arbitrary represented second-60 values.
Hifitime's scientific epoch representation is not a lossless substitute for them.
tz-rs `UtcDateTime` can retain the components and compare them natively. No custom
comparison or leap-second arithmetic is implemented here.

**Do not project an observation through tz-rs `DateTime`, Unix time or arithmetic.**
Those operations can discard the represented leap second. Observation consumers
copy, compare and format native UTC values; scheduling arithmetic uses internal
`time` clock values instead. The whole-minute wire conversion above never converts
the represented leap value into a Unix instant.

Frozen chrono outputs, complete revision hashes, neighboring-value ordering tests,
provider flows and encrypted-store restart tests verify the compatibility contract.
Granola segment ordering and revision content are covered, not only item dates.

## Writers and persisted data

Internal clock writers use system/POSIX time; they do not construct second 60.
The source worker's resource scan/control/run fields are internal clock fields.
Provider timestamps are different: Drive, Granola and Linear accept external
RFC3339 observations, and the worker can persist them in `Item.updated_at` or
`Pending.record.modified_at`. Memory metadata and imported/exported records can
also contain externally supplied dates.

That producer audit does **not** establish whether any actual saved observation
contains a leap value. Compatibility tests use synthetic data, not private databases.

Existing observation JSON is read directly. No stored timestamp normalization,
record deletion, reimport, revision recalculation, cursor change or ciphertext
rewrite is required for the replacement. Ordinary authorized source updates and
withdrawals retain their existing receipt and commit semantics.

Invalid encrypted payloads, key/binding failures and impossible internal-clock
values still fail closed. The legacy fixture containing a synthetic second-60
internal control timestamp tests refusal without rewriting; it is not evidence
about provider data or production prevalence.

References:

- [time parsed components](https://docs.rs/time/0.3.55/time/parsing/struct.Parsed.html)
- [tz-rs native UTC observations](https://docs.rs/tz-rs/0.7.3/tz/struct.UtcDateTime.html)
- [tz-rs projection caveat](https://docs.rs/tz-rs/0.7.3/tz/struct.UtcDateTime.html#method.project)
