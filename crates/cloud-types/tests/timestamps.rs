//! Cloud/Core wire DTO and OpenAPI timestamp compatibility.
use am_cloud_types::ApiKey;
use serde_json::json;
use utoipa::PartialSchema;

#[test]
fn metadata_mapping_never_replaces_legacy_leap_values_with_now() {
    let metadata = json!({"evidence":[{"created_at":"2016-12-31T23:59:60.5Z"}]});
    let evidence = am_cloud_types::evidence_from_core_metadata(&metadata).unwrap();
    assert_eq!(
        am_core_types::observation_serde::wire(evidence[0].created_at).unwrap(),
        "2016-12-31T23:59:60.500Z"
    );
}

#[test]
fn malformed_metadata_keeps_the_existing_fallback_without_hiding_other_evidence() {
    let before = tz::UtcDateTime::now().unwrap();
    let metadata = json!({"evidence":[{"created_at":"2026-02-30T00:00:60Z"},{"created_at":"2026-01-01T00:00:00Z"}]});
    let items = am_cloud_types::evidence_from_core_metadata(&metadata).unwrap();
    let after = tz::UtcDateTime::now().unwrap();
    assert_eq!(items.len(), 2);
    assert!(items[0].created_at >= before && items[0].created_at <= after);
    assert_eq!(
        items[1].created_at,
        am_core_types::observation_serde::parse("2026-01-01T00:00:00Z").unwrap()
    );
}

#[test]
fn metadata_retains_unicode_offset_values_but_keeps_strict_year_fallback() {
    for key in ["evidence", "links"] {
        let before = tz::UtcDateTime::now().unwrap();
        let metadata = json!({key:[
            {"created_at":"2026-01-01T00:00:60.5−05:00"},
            {"created_at":"+10000-01-01T00:00:00Z"},
            {"created_at":"-0001-01-01T00:00:00Z"}
        ]});
        let items = am_cloud_types::evidence_from_core_metadata(&metadata).unwrap();
        let after = tz::UtcDateTime::now().unwrap();
        assert_eq!(
            am_core_types::observation_serde::wire(items[0].created_at).unwrap(),
            "2026-01-01T05:00:60.500Z"
        );
        assert!(
            items[1..]
                .iter()
                .all(|item| before <= item.created_at && item.created_at <= after)
        );
    }
}

#[test]
fn memory_and_export_observations_keep_leaps_and_the_datetime_schema() {
    let core: am_core_types::CoreMemory = serde_json::from_value(json!({
        "id":"memory", "content":"body", "created_at":"2016-12-31T23:59:60.500Z",
        "updated_at":"2017-01-01T05:44:60.500+05:45"
    }))
    .unwrap();
    let memory = am_cloud_types::core_memory_to_memory(core, "project").unwrap();
    let value = serde_json::to_value(&memory).unwrap();
    assert_eq!(value["created_at"], "2016-12-31T23:59:60.500Z");
    assert_eq!(value["updated_at"], value["created_at"]);
    let schema = serde_json::to_value(am_cloud_types::Memory::schema()).unwrap();
    assert_eq!(
        schema["properties"]["created_at"],
        json!({"type":"string","format":"date-time"})
    );
    let export: am_cloud_types::ExportMemoryRecord = serde_json::from_value(json!({
        "schema_version":1,"memory_id":"memory","user_id":"user","content":"body",
        "source_site":"core","created_at":"2016-12-31T23:59:60.500Z"
    }))
    .unwrap();
    assert_eq!(
        serde_json::to_value(export).unwrap()["created_at"],
        value["created_at"]
    );
}

#[test]
fn public_dtos_accept_offsets_and_emit_normalized_legacy_fractional_precision() {
    let key: ApiKey = serde_json::from_value(json!({
        "id":"key", "org_id":"org", "project_id":"project", "name":"test",
        "prefix":"amc_test", "status":"active",
        "created_at":"2026-10-25T17:45:00.1234+05:45",
        "last_used_at":null
    }))
    .unwrap();
    let wire = serde_json::to_value(&key).unwrap();
    assert_eq!(wire["created_at"], "2026-10-25T12:00:00.123400Z");
    assert!(wire["last_used_at"].is_null());
    assert_eq!(
        key.created_at,
        am_core_types::timestamp_serde::parse("2026-10-25T12:00:00.1234Z").unwrap()
    );
    let memory: am_core_types::CoreMemory = serde_json::from_value(json!({
        "id":"memory", "content":"body", "created_at":"1969-12-31T23:59:59.999999999Z",
        "updated_at":"2026-10-25T12:00:00.123456789Z"
    }))
    .unwrap();
    let wire = serde_json::to_value(memory).unwrap();
    assert_eq!(wire["created_at"], "1969-12-31T23:59:59.999999999Z");
    assert_eq!(wire["updated_at"], "2026-10-25T12:00:00.123456789Z");
}

#[test]
fn dto_openapi_resolves_required_and_optional_timestamps_as_date_time_strings() {
    let schema = serde_json::to_value(ApiKey::schema()).unwrap();
    assert_eq!(
        schema["properties"]["created_at"],
        json!({"type":"string","format":"date-time"})
    );
    assert!(
        schema["required"]
            .as_array()
            .unwrap()
            .contains(&json!("created_at"))
    );
    assert!(
        !schema["required"]
            .as_array()
            .unwrap()
            .contains(&json!("last_used_at"))
    );
}
