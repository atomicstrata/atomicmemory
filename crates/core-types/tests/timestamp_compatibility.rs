//! Frozen legacy outputs compared against native time types and wire adapters.
use am_core_types::timestamp_serde::{self, ParseError};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use time::{Duration, OffsetDateTime};

#[derive(Serialize, Deserialize)]
struct Record {
    #[serde(with = "timestamp_serde")]
    at: OffsetDateTime,
}

#[test]
fn invalid_leap_dates_and_utc_range_overflows_return_errors() {
    for input in [
        "2026-02-30T00:00:60Z",
        "1900-02-29T23:59:60Z",
        "+999999-12-31T23:59:59-23:59",
        "-999999-01-01T00:00:00+23:59",
    ] {
        assert_eq!(timestamp_serde::parse(input), Err(ParseError::Invalid));
    }
    let at = OffsetDateTime::parse(
        "+999999-12-31T23:59:59-23:59",
        &time::macros::format_description!(
            "[year]-[month]-[day]T[hour]:[minute]:[second][offset_hour sign:mandatory]:[offset_minute]"
        ),
    ).unwrap();
    assert!(timestamp_serde::wire(at).is_err());
    assert!(timestamp_serde::revision(at).is_err());
}

#[test]
fn arbitrary_rfc3339_fraction_lengths_keep_legacy_nanosecond_truncation() {
    for digits in [33, 128, 1024] {
        let fraction = format!("123456789{}", "7".repeat(digits));
        let at = timestamp_serde::parse(&format!("2026-01-01T00:00:00.{fraction}Z")).unwrap();
        assert_eq!(
            timestamp_serde::wire(at).unwrap(),
            "2026-01-01T00:00:00.123456789Z"
        );
        let at =
            timestamp_serde::parse(&format!("+10000-01-01T00:00:00.{fraction}+05:45")).unwrap();
        assert_eq!(
            timestamp_serde::wire(at).unwrap(),
            "9999-12-31T18:15:00.123456789Z"
        );
        assert!(timestamp_serde::parse(&format!("2026-01-01T00:00:00.{fraction}xZ")).is_err());
    }
}

#[test]
fn native_library_and_wire_adapters_match_supported_legacy_values() {
    let rows: Vec<Value> =
        serde_json::from_str(include_str!("fixtures/legacy-timestamps.json")).unwrap();
    for row in rows {
        let input = row["input"].as_str().unwrap();
        // These values cannot be represented by time without normalization.
        // They are rejected, not silently converted or counted as compatible.
        if input.contains(":60") {
            assert_eq!(
                timestamp_serde::parse(input),
                Err(ParseError::LegacyLeapSecond)
            );
            assert!(serde_json::from_value::<Record>(serde_json::json!({"at":input})).is_err());
            continue;
        }
        let at = timestamp_serde::parse(input).unwrap_or_else(|error| panic!("{input}: {error}"));
        assert_eq!(timestamp_serde::wire(at).unwrap(), row["json"], "{input}");
        assert_eq!(
            timestamp_serde::revision(at).unwrap(),
            row["revision"],
            "{input}"
        );
        assert_eq!(
            at.unix_timestamp(),
            row["seconds"].as_i64().unwrap(),
            "{input}"
        );
        assert_eq!(
            at.unix_timestamp_nanos().div_euclid(1_000_000),
            i128::from(row["millis"].as_i64().unwrap())
        );
        assert_eq!(u64::from(at.microsecond()), row["micros"].as_u64().unwrap());
        let record = serde_json::to_value(Record { at }).unwrap();
        assert_eq!(record["at"], row["json"]);
        assert_eq!(serde_json::from_value::<Record>(record).unwrap().at, at);
        for pair in row["adds"].as_array().unwrap() {
            let duration = Duration::nanoseconds(pair[0].as_i64().unwrap());
            assert_eq!(
                timestamp_serde::revision(at + duration).unwrap(),
                pair[1],
                "{input} + {duration}"
            );
        }
        for pair in row["diffs"].as_array().unwrap() {
            let other = pair[0].as_str().unwrap();
            if other.contains(":60") {
                continue;
            }
            let expected: i128 = pair[1].as_str().unwrap().parse().unwrap();
            assert_eq!(
                (at - timestamp_serde::parse(other).unwrap()).whole_nanoseconds(),
                expected
            );
        }
    }
}

#[test]
fn native_format_descriptions_reject_invalid_inputs() {
    for input in [
        "",
        "2026-01-01",
        "2026-01-01T00:00:00",
        "1900-02-29T00:00:00Z",
        "2026-13-01T00:00:00Z",
        "2026-01-01T24:00:00Z",
        "2026-01-01T00:00:61Z",
        "2026-01-01T00:00:00+24:00",
        "2026-01-01T00:00:00Zjunk",
        "2026-01-01T00:00:00.💥Z",
        "💥💥💥💥💥60Z",
    ] {
        assert_eq!(
            timestamp_serde::parse(input),
            Err(ParseError::Invalid),
            "{input}"
        );
    }
}

#[test]
fn library_rfc3339_parser_normalizes_leaps_so_the_wire_boundary_must_refuse_them() {
    use time::format_description::well_known::Rfc3339;
    let input = "2016-12-31T23:59:60.500Z";
    let normalized = OffsetDateTime::parse(input, &Rfc3339).unwrap();
    assert_ne!(timestamp_serde::wire(normalized).unwrap(), input);
    assert_eq!(
        timestamp_serde::parse(input),
        Err(ParseError::LegacyLeapSecond)
    );
}
