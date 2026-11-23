//! Legacy wire formatting for native `time::OffsetDateTime` values.
//! No timestamp type, calendar implementation or arithmetic lives here.
//!
//! Default time serde is deliberately disabled: every wire field needs an adapter.
//! ```compile_fail
//! let _ = serde_json::to_value(time::OffsetDateTime::now_utc());
//! ```
use serde::{Deserialize, Deserializer, Serializer};
use std::borrow::Cow;
use time::{
    OffsetDateTime, UtcOffset, format_description::BorrowedFormatItem, macros::format_description,
    parsing::Parsed,
};

const INPUT: &[BorrowedFormatItem<'_>] = format_description!(
    version = 2,
    "[year]-[month]-[day][first [T] [t] [ ]][hour]:[minute]:[second][optional [.[subsecond]]][first [Z] [z] [[offset_hour sign:mandatory]:[offset_minute]]]"
);
const SECONDS: &[BorrowedFormatItem<'_>] =
    format_description!("[year]-[month]-[day]T[hour]:[minute]:[second]");
const MILLIS: &[BorrowedFormatItem<'_>] =
    format_description!("[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:3]");
const MICROS: &[BorrowedFormatItem<'_>] =
    format_description!("[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:6]");
const NANOS: &[BorrowedFormatItem<'_>] =
    format_description!("[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:9]");

/// Parsing never silently converts a persisted leap second to another instant.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ParseError {
    /// Invalid timestamp input.
    #[error("invalid timestamp")]
    Invalid,
    /// Requires an explicit legacy migration decision; the original value is retained.
    #[error(
        "legacy leap-second timestamp requires explicit migration; saved state must not be reset"
    )]
    LegacyLeapSecond,
}

/// Parse using time's format-description parser, including signed extended years.
pub fn parse(input: &str) -> Result<OffsetDateTime, ParseError> {
    let parsed = components(input)?;
    if parsed.second() == Some(60) {
        time::Date::try_from(parsed).map_err(|_| ParseError::Invalid)?;
        UtcOffset::try_from(parsed).map_err(|_| ParseError::Invalid)?;
        return Err(ParseError::LegacyLeapSecond);
    }
    let at: OffsetDateTime = parsed.try_into().map_err(|_| ParseError::Invalid)?;
    at.checked_to_offset(UtcOffset::UTC)
        .ok_or(ParseError::Invalid)
}

pub(crate) fn components(input: &str) -> Result<Parsed, ParseError> {
    let input = legacy_fraction(input);
    let input = legacy_offset_minus(&input);
    let mut parsed = Parsed::new();
    let remaining = parsed
        .parse_items(input.as_bytes(), INPUT)
        .map_err(|_| ParseError::Invalid)?;
    if !remaining.is_empty() {
        return Err(ParseError::Invalid);
    }
    if parsed
        .offset_hour()
        .is_some_and(|hour| hour.unsigned_abs() >= 24)
    {
        return Err(ParseError::Invalid);
    }
    if parsed.offset_hour().is_none() {
        parsed.set_offset_hour(0).ok_or(ParseError::Invalid)?;
    }
    Ok(parsed)
}

fn legacy_offset_minus(input: &str) -> Cow<'_, str> {
    // Chrono accepted U+2212 only as the RFC3339 offset sign, not in dates.
    match input.rsplit_once('−') {
        Some((prefix, offset)) if offset.len() == 5 => Cow::Owned(format!("{prefix}-{offset}")),
        _ => Cow::Borrowed(input),
    }
}

fn legacy_fraction(input: &str) -> Cow<'_, str> {
    let Some((prefix, fraction)) = input.split_once('.') else {
        return Cow::Borrowed(input);
    };
    let digits = fraction.bytes().take_while(u8::is_ascii_digit).count();
    if digits <= 9 {
        return Cow::Borrowed(input);
    }
    // Chrono consumed arbitrarily long RFC3339 fractions but retained only
    // nine digits. Preserve that wire contract before the native parser's
    // bounded fractional reader; never round or remove a non-digit suffix.
    Cow::Owned(format!(
        "{prefix}.{}{}",
        &fraction[..9],
        &fraction[digits..]
    ))
}

/// Preserve legacy fractional grouping and explicit UTC offset in revision inputs.
pub fn revision(at: OffsetDateTime) -> Result<String, time::error::Format> {
    format(at, "+00:00")
}

/// Preserve JSON/Granola UTC designators without dropping nanosecond precision.
pub fn wire(at: OffsetDateTime) -> Result<String, time::error::Format> {
    format(at, "Z")
}

fn format(at: OffsetDateTime, suffix: &str) -> Result<String, time::error::Format> {
    let at = at
        .checked_to_offset(UtcOffset::UTC)
        .ok_or(time::error::Format::InvalidComponent("year"))?;
    let description = match at.nanosecond() {
        0 => SECONDS,
        nanos if nanos % 1_000_000 == 0 => MILLIS,
        nanos if nanos % 1_000 == 0 => MICROS,
        _ => NANOS,
    };
    let mut result = at.format(description)?;
    result.push_str(suffix);
    Ok(result)
}

/// Serialize a required timestamp with the existing UTC JSON representation.
pub fn serialize<S: Serializer>(at: &OffsetDateTime, serializer: S) -> Result<S::Ok, S::Error> {
    serializer.serialize_str(&wire(*at).map_err(serde::ser::Error::custom)?)
}

/// Decode a required timestamp without silently normalizing legacy leap seconds.
pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<OffsetDateTime, D::Error> {
    parse(&String::deserialize(deserializer)?).map_err(serde::de::Error::custom)
}

/// Optional timestamp adapter with unchanged null handling.
pub mod option {
    use super::*;
    /// Serialize an optional timestamp without changing null semantics.
    pub fn serialize<S: Serializer>(
        at: &Option<OffsetDateTime>,
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        match at {
            Some(at) => serializer.serialize_some(&wire(*at).map_err(serde::ser::Error::custom)?),
            None => serializer.serialize_none(),
        }
    }
    /// Decode an optional timestamp, explicitly refusing legacy leap seconds.
    pub fn deserialize<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<Option<OffsetDateTime>, D::Error> {
        Option::<String>::deserialize(deserializer)?
            .map(|text| parse(&text).map_err(serde::de::Error::custom))
            .transpose()
    }
}
