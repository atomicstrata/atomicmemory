//! Agent-mode argv sniffing and command-path resolution for parse-time envelopes.
//!
//! Clap has not run yet when these are used (the parse may be the thing that
//! failed), so every spelling clap accepts has to be recognised here or a
//! machine consumer silently gets human text on stderr instead of an error
//! envelope.

/// Global flags that consume the following argv entry as their value. Used so
/// command-path resolution does not mistake a flag's value for a subcommand
/// (`am --profile demo memory search` is `memory search`, not `demo`).
const VALUE_TAKING_FLAGS: &[&str] = &[
    "--profile",
    "-p",
    "--base-url",
    "--environment",
    "--output",
    "-o",
    "--scope-user",
    "--scope-agent-id",
    "--scope-workspace",
    "--scope-namespace",
    "--scope-thread",
];

/// Global flags that take no value.
const BOOLEAN_FLAGS: &[&str] = &[
    "--agent",
    "--json",
    "--quiet",
    "-q",
    "--verbose",
    "-v",
    "--no-telemetry",
];

const VALID_OUTPUTS: &[&str] = &["text", "table", "json", "agent", "quiet"];

/// Short flags that take no value and can therefore be grouped by clap
/// (`-vv`, `-qv`). Grouped forms must be skipped like any other boolean flag,
/// or command-path resolution stops early and reports the wrong command.
const BOOLEAN_SHORT_CHARS: &[char] = &['q', 'v'];

/// Short flags that consume a value. clap lets one of these terminate a group
/// of boolean shorts, taking the rest of the token as its value (`-vpdemo`,
/// `-voagent`) or the next argv entry when nothing is attached (`-vp demo`).
///
/// Both value-taking shorts live here so the cluster parser models them
/// uniformly; handling only `-o` meant `-vpdemo` broke command resolution the
/// same way `-voagent` once did.
const VALUE_TAKING_SHORT_CHARS: &[char] = &['o', 'p'];

/// How many argv entries a short-flag cluster occupies, or `None` when the
/// cluster contains a short we do not model (caller stops rather than guess).
///
/// This is the single place short clusters are interpreted, so every
/// value-taking short is handled the same way and adding one is a single-line
/// change instead of another special case at the call site.
fn short_cluster_consumes(arg: &str) -> Option<usize> {
    let rest = arg.strip_prefix('-')?;
    // A bare `-` or a long flag (`--x`) is not a short cluster.
    if rest.is_empty() || rest.starts_with('-') {
        return None;
    }
    for (index, ch) in rest.char_indices() {
        if VALUE_TAKING_SHORT_CHARS.contains(&ch) {
            // Everything after the flag is its value; `=` is optional.
            let value = &rest[index + ch.len_utf8()..];
            let value = value.strip_prefix('=').unwrap_or(value);
            return Some(if value.is_empty() { 2 } else { 1 });
        }
        if !BOOLEAN_SHORT_CHARS.contains(&ch) {
            return None;
        }
    }
    Some(1)
}

/// Detect `--agent` / `-o agent` / `--output agent` from raw argv before Clap parses.
pub fn detect_argv_agent(argv: &[String]) -> bool {
    let mut mode: Option<String> = None;
    for (i, arg) in argv.iter().enumerate() {
        if arg == "--agent" {
            return true;
        }
        if let Some(output) = read_output_value(arg, argv.get(i + 1)) {
            if output == "agent" {
                return true;
            }
            if mode.is_none() {
                mode = Some(output);
            }
        }
        if arg == "--json" && mode.is_none() {
            mode = Some("json".into());
        }
    }
    mode.as_deref() == Some("agent")
}

/// Read an output-format value from `current` (with `next` as its possible
/// value), covering every spelling clap accepts: `--output agent`,
/// `--output=agent`, `-o agent`, `-o=agent`, and the attached short `-oagent`.
pub fn read_output_value(current: &str, next: Option<&String>) -> Option<String> {
    if current == "--output" {
        return next
            .filter(|v| VALID_OUTPUTS.contains(&v.as_str()))
            .cloned();
    }
    if let Some(rest) = current.strip_prefix("--output=")
        && VALID_OUTPUTS.contains(&rest)
    {
        return Some(rest.to_string());
    }
    read_short_cluster_output(current, next)
}

/// Read an output value from a short-flag cluster.
///
/// clap lets a value-taking short terminate a group of boolean shorts, so all
/// of `-o agent`, `-oagent`, `-o=agent`, `-voagent` and `-vqoagent` set the
/// output format. Recognising only a leading `-o` missed the clustered forms,
/// which then fell through to clap's human error text instead of an envelope.
fn read_short_cluster_output(current: &str, next: Option<&String>) -> Option<String> {
    let rest = current.strip_prefix('-')?;
    if rest.is_empty() || rest.starts_with('-') {
        return None;
    }
    for (index, ch) in rest.char_indices() {
        if ch == 'o' {
            let value = &rest[index + ch.len_utf8()..];
            let value = value.strip_prefix('=').unwrap_or(value);
            if value.is_empty() {
                return next
                    .filter(|v| VALID_OUTPUTS.contains(&v.as_str()))
                    .cloned();
            }
            return VALID_OUTPUTS.contains(&value).then(|| value.to_string());
        }
        // Only boolean shorts may precede the value-taking one in a cluster.
        if !BOOLEAN_SHORT_CHARS.contains(&ch) {
            return None;
        }
    }
    None
}

/// Best-effort command path from argv (subcommands until the first flag).
pub fn resolve_command_path_from_argv(argv: &[String]) -> String {
    let mut parts = Vec::new();
    let mut i = 1;
    while i < argv.len() {
        let arg = &argv[i];
        if arg.starts_with('-') {
            // `--flag=value` carries its value inline, so only one entry.
            if arg.contains('=') || BOOLEAN_FLAGS.contains(&arg.as_str()) {
                i += 1;
                continue;
            }
            if VALUE_TAKING_FLAGS.contains(&arg.as_str()) {
                i += 2;
                continue;
            }
            // Every short-flag form (`-vv`, `-oagent`, `-vpdemo`, `-vo agent`)
            // goes through one model of how much of argv it occupies.
            if let Some(consumed) = short_cluster_consumes(arg) {
                i += consumed;
                continue;
            }
            // Unknown flag: stop rather than risk reading its value as a
            // subcommand.
            break;
        }
        parts.push(arg.clone());
        i += 1;
    }
    if parts.is_empty() {
        "am".into()
    } else {
        parts.join(" ")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(parts: &[&str]) -> Vec<String> {
        parts.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn detects_agent_flag() {
        assert!(detect_argv_agent(&argv(&[
            "am", "--agent", "memory", "search", "q"
        ])));
    }

    #[test]
    fn detects_every_output_agent_spelling() {
        // Regression: only `--output agent` was recognised, so `-o agent`
        // fell through to clap's human error text on a parse failure while
        // `--output agent` produced an envelope.
        for flags in [
            vec!["-o", "agent"],
            vec!["-o=agent"],
            vec!["-oagent"],
            vec!["--output", "agent"],
            vec!["--output=agent"],
        ] {
            let mut parts = vec!["am"];
            parts.extend(flags.iter().copied());
            parts.extend(["memory", "search"]);
            assert!(
                detect_argv_agent(&argv(&parts)),
                "expected agent mode for {parts:?}"
            );
        }
    }

    #[test]
    fn does_not_detect_agent_for_other_formats() {
        for flags in [vec!["-o", "json"], vec!["--output=table"], vec!["-ojson"]] {
            let mut parts = vec!["am"];
            parts.extend(flags.iter().copied());
            parts.extend(["memory", "search"]);
            assert!(!detect_argv_agent(&argv(&parts)), "{parts:?}");
        }
    }

    #[test]
    fn resolves_command_before_flags() {
        assert_eq!(
            resolve_command_path_from_argv(&argv(&["am", "--agent", "config", "env", "show"])),
            "config env show"
        );
    }

    #[test]
    fn skips_value_taking_globals_before_the_command() {
        // Regression: a value-taking global before the subcommand made this
        // return "am" (the loop broke on the first flag), so the envelope
        // reported the wrong command.
        for flags in [
            vec!["--profile", "demo"],
            vec!["-p", "demo"],
            vec!["--profile=demo"],
            vec!["--scope-workspace", "tenant-a"],
            vec!["-o", "agent"],
            vec!["--base-url", "https://example.test"],
        ] {
            let mut parts = vec!["am"];
            parts.extend(flags.iter().copied());
            parts.extend(["memory", "search"]);
            assert_eq!(
                resolve_command_path_from_argv(&argv(&parts)),
                "memory search",
                "failed for {parts:?}"
            );
        }
    }

    #[test]
    fn does_not_swallow_the_command_after_boolean_flags() {
        assert_eq!(
            resolve_command_path_from_argv(&argv(&["am", "--quiet", "-v", "hooks", "doctor"])),
            "hooks doctor"
        );
    }

    #[test]
    fn handles_grouped_boolean_short_flags() {
        // Regression: clap accepts `-vv` / `-qv`, but only exact `-v`/`-q`
        // were recognised, so the loop broke early and the envelope reported
        // command "am" instead of the real command.
        for flags in [
            vec!["-vv"],
            vec!["-qv"],
            vec!["-vq"],
            vec!["-vvv"],
            vec!["-vv", "-oagent"],
        ] {
            let mut parts = vec!["am"];
            parts.extend(flags.iter().copied());
            parts.extend(["memory", "search"]);
            assert_eq!(
                resolve_command_path_from_argv(&argv(&parts)),
                "memory search",
                "failed for {parts:?}"
            );
        }
    }

    #[test]
    fn detects_clustered_output_shorts() {
        // Regression: clap accepts `-voagent` / `-vqoagent` (boolean shorts
        // terminated by the value-taking `-o`), but only a leading `-o` was
        // recognised, so these emitted human stderr instead of an envelope.
        for flags in [
            vec!["-voagent"],
            vec!["-vqoagent"],
            vec!["-qoagent"],
            vec!["-vo", "agent"],
            vec!["-vo=agent"],
        ] {
            let mut parts = vec!["am"];
            parts.extend(flags.iter().copied());
            parts.extend(["memory", "search"]);
            assert!(
                detect_argv_agent(&argv(&parts)),
                "expected agent mode for {parts:?}"
            );
            assert_eq!(
                resolve_command_path_from_argv(&argv(&parts)),
                "memory search",
                "command path wrong for {parts:?}"
            );
        }
    }

    #[test]
    fn clustered_shorts_do_not_false_positive() {
        // A non-boolean short before `o` is not a cluster we understand, and
        // a non-agent value must not flip agent mode on.
        assert!(!detect_argv_agent(&argv(&[
            "am", "-vojson", "memory", "search"
        ])));
        assert!(!detect_argv_agent(&argv(&[
            "am", "-xoagent", "memory", "search"
        ])));
        assert!(read_output_value("-xoagent", None).is_none());
        assert_eq!(read_output_value("-vojson", None).as_deref(), Some("json"));
    }

    #[test]
    fn clustered_profile_shorts_do_not_swallow_the_command() {
        // Regression: only `-o` clusters were modeled, so clap's `-vpdemo`
        // (= -v -p demo) stopped resolution and the envelope reported "am".
        for flags in [
            vec!["-vpdemo"],
            vec!["-qvpdemo"],
            vec!["-vp", "demo"],
            vec!["-vp=demo"],
            vec!["-pdemo"],
        ] {
            let mut parts = vec!["am"];
            parts.extend(flags.iter().copied());
            parts.extend(["-oagent", "memory", "search"]);
            assert_eq!(
                resolve_command_path_from_argv(&argv(&parts)),
                "memory search",
                "failed for {parts:?}"
            );
        }
    }

    #[test]
    fn short_cluster_consumption_is_modeled_per_form() {
        // Pure boolean clusters occupy one entry.
        assert_eq!(short_cluster_consumes("-v"), Some(1));
        assert_eq!(short_cluster_consumes("-qv"), Some(1));
        // A value-taking short with an attached value occupies one entry.
        assert_eq!(short_cluster_consumes("-oagent"), Some(1));
        assert_eq!(short_cluster_consumes("-voagent"), Some(1));
        assert_eq!(short_cluster_consumes("-vpdemo"), Some(1));
        assert_eq!(short_cluster_consumes("-vo=agent"), Some(1));
        // Nothing attached means the value is the next argv entry.
        assert_eq!(short_cluster_consumes("-o"), Some(2));
        assert_eq!(short_cluster_consumes("-vp"), Some(2));
        // Not short clusters at all.
        assert_eq!(short_cluster_consumes("--quiet"), None);
        assert_eq!(short_cluster_consumes("-"), None);
        // An unmodeled short must stop resolution rather than be guessed at.
        assert_eq!(short_cluster_consumes("-x"), None);
        assert_eq!(short_cluster_consumes("-vx"), None);
    }
}
