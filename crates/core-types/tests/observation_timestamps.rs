//! Native maintained observation types preserve frozen chrono wire and ordering contracts.
use am_core_types::observation_serde as timestamps;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tz::UtcDateTime;

#[test]
fn unicode_offset_minus_preserves_values_without_accepting_unicode_date_separators() {
    let input = "2017-01-01T00:29:60.123456789123−00:30";
    let at = timestamps::parse(input).unwrap();
    assert_eq!(
        timestamps::wire(at).unwrap(),
        "2017-01-01T00:59:60.123456789Z"
    );
    for input in [
        "2026−01-01T00:00:00Z",
        "−0001-01-01T00:00:00Z",
        "2026-01-01T00:00:00−05:00junk",
    ] {
        assert!(timestamps::parse(input).is_err(), "{input}");
    }
}

#[derive(Serialize, Deserialize)]
struct Record {
    #[serde(with = "timestamps")]
    at: UtcDateTime,
}

#[test]
fn every_frozen_observation_including_leaps_retains_its_wire_value() {
    let rows: Vec<Value> =
        serde_json::from_str(include_str!("fixtures/legacy-timestamps.json")).unwrap();
    for row in rows {
        let input = row["input"].as_str().unwrap();
        let at = timestamps::parse(input).unwrap();
        assert_eq!(timestamps::wire(at).unwrap(), row["json"], "{input}");
        assert_eq!(
            timestamps::revision(at).unwrap(),
            row["revision"],
            "{input}"
        );
        let wire = serde_json::to_value(Record { at }).unwrap();
        assert_eq!(wire["at"], row["json"]);
        assert_eq!(serde_json::from_value::<Record>(wire).unwrap().at, at);
    }
}

#[test]
fn native_ordering_distinguishes_the_represented_leap_from_both_neighbors() {
    for minute in ["2016-12-31T23:59:", "2026-02-28T11:12:"] {
        let inputs = [
            "59.999999999Z",
            "60Z",
            "60.000000001Z",
            "60.5Z",
            "60.999999999Z",
        ];
        let values: Vec<_> = inputs
            .iter()
            .map(|suffix| timestamps::parse(&format!("{minute}{suffix}")).unwrap())
            .collect();
        assert!(values.windows(2).all(|pair| pair[0] < pair[1]));
    }
    let leap = timestamps::parse("2016-12-31T23:59:60.5Z").unwrap();
    assert!(leap < timestamps::parse("2017-01-01T00:00:00Z").unwrap());
    assert_eq!(
        leap,
        timestamps::parse("2017-01-01T05:44:60.5+05:45").unwrap()
    );
    assert_eq!(
        timestamps::wire(timestamps::parse("2026-01-01T00:00:60.123456789-00:30").unwrap())
            .unwrap(),
        "2026-01-01T00:30:60.123456789Z"
    );
}

#[test]
fn invalid_dates_offsets_and_utc_year_overflows_are_errors() {
    for input in [
        "2026-02-30T00:00:60Z",
        "1900-02-29T23:59:60Z",
        "2026-01-01T24:00:60Z",
        "2026-01-01T00:00:61Z",
        "2026-01-01T00:00:00+24:00",
        "+999999-12-31T23:59:60-23:59",
        "-999999-01-01T00:00:00+23:59",
    ] {
        assert!(timestamps::parse(input).is_err(), "{input}");
    }
}

#[test]
fn long_observation_fractions_keep_truncation_and_reject_non_digit_suffixes() {
    for size in [33, 128, 1024] {
        let digits = format!("123456789{}", "7".repeat(size));
        let at = timestamps::parse(&format!("2017-01-01T05:44:60.{digits}+05:45")).unwrap();
        assert_eq!(
            timestamps::wire(at).unwrap(),
            "2016-12-31T23:59:60.123456789Z"
        );
        assert!(timestamps::parse(&format!("2017-01-01T05:44:60.{digits}xZ")).is_err());
    }
}

#[test]
fn upstream_epoch_constructor_cannot_make_the_wire_adapter_drop_fractional_digits() {
    if let Ok(invalid) = UtcDateTime::from_timespec(0, 1_500_000_000) {
        assert!(timestamps::wire(invalid).is_err());
        assert!(timestamps::revision(invalid).is_err());
        assert!(serde_json::to_value(Record { at: invalid }).is_err());
    }
}
