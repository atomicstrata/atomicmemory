//! Wire adapters for native tz-rs observation values, including represented leap seconds.
//! Ordering and calendar validation belong to tz-rs; this module defines no timestamp type.
//! ```compile_fail
//! let _ = serde_json::to_value(tz::UtcDateTime::UNIX_EPOCH);
//! ```
use crate::timestamp_serde::{ParseError, components};
use serde::{Deserialize, Deserializer, Serializer};
use time::{Date, Month, OffsetDateTime, UtcOffset, macros::format_description};
use tz::{DateTime, LocalTimeType, UtcDateTime};

/// Parse an external observation without normalizing represented second-60 values.
pub fn parse(input: &str) -> Result<UtcDateTime, ParseError> {
    let p = components(input)?;
    let offset = UtcOffset::try_from(p).map_err(|_| ParseError::Invalid)?;
    // RFC3339 offsets are whole minutes. Convert that minute with the native
    // library, then construct its native UTC value with unchanged seconds/nanos.
    // tz-rs project() must not be used: it discards represented leap seconds.
    let minute = DateTime::new(
        p.year().ok_or(ParseError::Invalid)?,
        p.month().ok_or(ParseError::Invalid)? as u8,
        p.day().ok_or(ParseError::Invalid)?.get(),
        p.hour_24().ok_or(ParseError::Invalid)?,
        p.minute().ok_or(ParseError::Invalid)?,
        0,
        0,
        LocalTimeType::with_ut_offset(offset.whole_seconds()).map_err(|_| ParseError::Invalid)?,
    )
    .map_err(|_| ParseError::Invalid)?;
    let minute = UtcDateTime::try_from(minute).map_err(|_| ParseError::Invalid)?;
    Date::from_calendar_date(
        minute.year(),
        Month::try_from(minute.month()).map_err(|_| ParseError::Invalid)?,
        minute.month_day(),
    )
    .map_err(|_| ParseError::Invalid)?;
    UtcDateTime::new(
        minute.year(),
        minute.month(),
        minute.month_day(),
        minute.hour(),
        minute.minute(),
        p.second().ok_or(ParseError::Invalid)?,
        p.subsecond().unwrap_or(0),
    )
    .map_err(|_| ParseError::Invalid)
}

/// Convert an internally generated POSIX clock value with native epoch conversion.
pub fn from_clock(at: OffsetDateTime) -> Result<UtcDateTime, ParseError> {
    UtcDateTime::from_total_nanoseconds(at.unix_timestamp_nanos()).map_err(|_| ParseError::Invalid)
}

/// Preserve legacy UTC JSON, including represented leap seconds and fractional grouping.
pub fn wire(at: UtcDateTime) -> Result<String, time::error::Format> {
    format(at, "Z")
}

/// Preserve the exact UTC timestamp input used by legacy revision hashes.
pub fn revision(at: UtcDateTime) -> Result<String, time::error::Format> {
    format(at, "+00:00")
}

fn format(at: UtcDateTime, suffix: &str) -> Result<String, time::error::Format> {
    // Validate the formatter's input even when it came from an upstream epoch
    // constructor rather than this module's checked observation parser.
    if at.nanoseconds() >= 1_000_000_000 {
        return Err(time::error::Format::InvalidComponent("subsecond"));
    }
    let invalid = || time::error::Format::InvalidComponent("year");
    let date = Date::from_calendar_date(
        at.year(),
        Month::try_from(at.month()).map_err(|_| invalid())?,
        at.month_day(),
    )
    .map_err(|_| invalid())?
    .format(format_description!("[year]-[month]-[day]"))?;
    let native = at.to_string();
    let clock = native
        .split_once('T')
        .and_then(|(_, clock)| clock.strip_suffix('Z'))
        .ok_or(time::error::Format::InvalidComponent("time"))?;
    let digits = match at.nanoseconds() {
        0 => 0,
        nanos if nanos % 1_000_000 == 0 => 3,
        nanos if nanos % 1000 == 0 => 6,
        _ => 9,
    };
    // Native Display supplies the clock, including :60; only its fixed nine
    // fractional digits are grouped to match the established serde/hash wire.
    let width = if digits == 0 { 8 } else { 9 + digits };
    let clock = clock
        .get(..width)
        .ok_or(time::error::Format::InvalidComponent("time"))?;
    Ok(format!("{date}T{clock}{suffix}"))
}

/// Serialize a required native observation timestamp.
pub fn serialize<S: Serializer>(at: &UtcDateTime, serializer: S) -> Result<S::Ok, S::Error> {
    serializer.serialize_str(&wire(*at).map_err(serde::ser::Error::custom)?)
}

/// Decode a required native observation timestamp.
pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<UtcDateTime, D::Error> {
    parse(&String::deserialize(deserializer)?).map_err(serde::de::Error::custom)
}

/// Optional native observation timestamp with unchanged null/missing semantics.
pub mod option {
    use super::*;
    /// Serialize an optional native observation timestamp.
    pub fn serialize<S: Serializer>(
        at: &Option<UtcDateTime>,
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        match at {
            Some(at) => serializer.serialize_some(&wire(*at).map_err(serde::ser::Error::custom)?),
            None => serializer.serialize_none(),
        }
    }
    /// Decode an optional native observation timestamp.
    pub fn deserialize<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<Option<UtcDateTime>, D::Error> {
        Option::<String>::deserialize(deserializer)?
            .map(|value| parse(&value).map_err(serde::de::Error::custom))
            .transpose()
    }
}
