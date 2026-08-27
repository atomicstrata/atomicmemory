//! Progressive wizard / plain / silent progress reporters for onboarding commands.

use std::collections::HashMap;
use std::io::{self, IsTerminal, Write};

use indicatif::{MultiProgress, ProgressBar, ProgressDrawTarget, ProgressStyle};

use crate::cli::{GlobalOptions, OutputFormat};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProgressMode {
    Wizard,
    Plain,
    Silent,
}

/// Select progress mode. `stderr_is_tty` is injectable for unit tests.
pub fn progress_mode_for(global: &GlobalOptions, stderr_is_tty: bool) -> ProgressMode {
    if global.quiet || global.output == OutputFormat::Json {
        ProgressMode::Silent
    } else if stderr_is_tty {
        ProgressMode::Wizard
    } else {
        ProgressMode::Plain
    }
}

pub fn progress_for(global: &GlobalOptions) -> Box<dyn ProgressReporter> {
    match progress_mode_for(global, io::stderr().is_terminal()) {
        ProgressMode::Silent => Box::new(Silent),
        ProgressMode::Wizard => Box::new(IndicatifWizard::new()),
        ProgressMode::Plain => Box::new(PlainSteps::new()),
    }
}

pub trait ProgressReporter: Send {
    fn start_step(&mut self, id: &str, label: &str);
    fn tick(&mut self, id: &str, detail: &str) {
        let _ = (id, detail);
    }
    /// Suspend animated output so interactive stdin prompts remain readable.
    fn pause_for_input(&mut self) {}
    /// Resume animated output after an interactive prompt completes.
    fn resume_after_input(&mut self) {}
    fn succeed(&mut self, id: &str, detail: Option<&str>);
    fn warn(&mut self, id: &str, detail: Option<&str>);
    fn fail(&mut self, id: &str, detail: Option<&str>);
    fn finish(&mut self);
}

/// Pause animated progress around an interactive stdin boundary; always resume.
pub fn with_progress_paused_for_input<T>(
    progress: &mut dyn ProgressReporter,
    should_pause: bool,
    op: impl FnOnce() -> T,
) -> T {
    if should_pause {
        progress.pause_for_input();
    }
    let result = op();
    if should_pause {
        progress.resume_after_input();
    }
    result
}

struct Silent;

impl ProgressReporter for Silent {
    fn start_step(&mut self, _id: &str, _label: &str) {}
    fn succeed(&mut self, _id: &str, _detail: Option<&str>) {}
    fn warn(&mut self, _id: &str, _detail: Option<&str>) {}
    fn fail(&mut self, _id: &str, _detail: Option<&str>) {}
    fn finish(&mut self) {}
}

struct PlainSteps {
    step_n: usize,
    active: HashMap<String, (usize, String)>,
    /// Captured lines for tests (also mirrored to stderr when not capturing-only).
    lines: Vec<String>,
    write_stderr: bool,
}

impl PlainSteps {
    fn new() -> Self {
        Self {
            step_n: 0,
            active: HashMap::new(),
            lines: Vec::new(),
            write_stderr: true,
        }
    }

    #[cfg(test)]
    fn capturing() -> Self {
        Self {
            write_stderr: false,
            ..Self::new()
        }
    }

    fn emit(&mut self, line: String) {
        if self.write_stderr {
            let _ = writeln!(io::stderr(), "{line}");
        }
        self.lines.push(line);
    }
}

impl ProgressReporter for PlainSteps {
    fn start_step(&mut self, id: &str, label: &str) {
        self.step_n += 1;
        let n = self.step_n;
        self.active.insert(id.to_string(), (n, label.to_string()));
        self.emit(format!("… [{n}] {label}"));
    }

    fn tick(&mut self, id: &str, detail: &str) {
        if let Some((n, label)) = self.active.get(id) {
            self.emit(format!("… [{n}] {label} — {detail}"));
        }
    }

    fn succeed(&mut self, id: &str, detail: Option<&str>) {
        self.settle(id, '✓', detail);
    }

    fn warn(&mut self, id: &str, detail: Option<&str>) {
        self.settle(id, '⚠', detail);
    }

    fn fail(&mut self, id: &str, detail: Option<&str>) {
        self.settle(id, '✗', detail);
    }

    fn finish(&mut self) {}
}

impl PlainSteps {
    fn settle(&mut self, id: &str, symbol: char, detail: Option<&str>) {
        let Some((n, label)) = self.active.remove(id) else {
            return;
        };
        let line = match detail {
            Some(d) if !d.is_empty() => format!("{symbol} [{n}] {label} — {d}"),
            _ => format!("{symbol} [{n}] {label}"),
        };
        self.emit(line);
    }
}

struct WizardStep {
    n: usize,
    label: String,
    bar: ProgressBar,
}

struct IndicatifWizard {
    multi: MultiProgress,
    step_n: usize,
    active: HashMap<String, WizardStep>,
    finished: bool,
    input_paused: bool,
}

impl IndicatifWizard {
    fn new() -> Self {
        Self {
            multi: MultiProgress::new(),
            step_n: 0,
            active: HashMap::new(),
            finished: false,
            input_paused: false,
        }
    }

    fn spinner_style() -> ProgressStyle {
        ProgressStyle::with_template("{spinner:.cyan} [{prefix}] {msg}")
            .unwrap_or_else(|_| ProgressStyle::default_spinner())
            .tick_chars("⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏ ")
    }

    fn settle(&mut self, id: &str, symbol: char, detail: Option<&str>) {
        let Some(step) = self.active.remove(id) else {
            return;
        };
        let msg = match detail {
            Some(d) if !d.is_empty() => format!("{symbol} [{}] {} — {d}", step.n, step.label),
            _ => format!("{symbol} [{}] {}", step.n, step.label),
        };
        // Persist into scrollback so pause/clear cannot erase completed steps.
        let _ = self.multi.println(&msg);
        step.bar.finish_and_clear();
    }
}

impl ProgressReporter for IndicatifWizard {
    fn start_step(&mut self, id: &str, label: &str) {
        self.step_n += 1;
        let n = self.step_n;
        let bar = self.multi.add(ProgressBar::new_spinner());
        bar.set_style(Self::spinner_style());
        bar.set_prefix(format!("{n}"));
        bar.set_message(label.to_string());
        bar.enable_steady_tick(std::time::Duration::from_millis(80));
        self.active.insert(
            id.to_string(),
            WizardStep {
                n,
                label: label.to_string(),
                bar,
            },
        );
    }

    fn tick(&mut self, id: &str, detail: &str) {
        if let Some(step) = self.active.get(id) {
            step.bar.set_message(format!("{} — {detail}", step.label));
        }
    }

    fn pause_for_input(&mut self) {
        if self.input_paused {
            return;
        }
        self.input_paused = true;
        for step in self.active.values() {
            step.bar.disable_steady_tick();
        }
        // Hide animated bars only — settled steps already went to scrollback via println.
        let _ = self.multi.clear();
        self.multi.set_draw_target(ProgressDrawTarget::hidden());
        let _ = writeln!(io::stderr());
        let _ = io::stderr().flush();
    }

    fn resume_after_input(&mut self) {
        if !self.input_paused {
            return;
        }
        self.input_paused = false;
        self.multi.set_draw_target(ProgressDrawTarget::stderr());
        for step in self.active.values() {
            step.bar
                .enable_steady_tick(std::time::Duration::from_millis(80));
            step.bar.tick();
        }
    }

    fn succeed(&mut self, id: &str, detail: Option<&str>) {
        self.settle(id, '✓', detail);
    }

    fn warn(&mut self, id: &str, detail: Option<&str>) {
        self.settle(id, '⚠', detail);
    }

    fn fail(&mut self, id: &str, detail: Option<&str>) {
        self.settle(id, '✗', detail);
    }

    fn finish(&mut self) {
        if self.finished {
            return;
        }
        self.finished = true;
        for (_, step) in self.active.drain() {
            step.bar.finish_and_clear();
        }
        let _ = self.multi.clear();
    }
}

impl Drop for IndicatifWizard {
    fn drop(&mut self) {
        self.finish();
    }
}

#[cfg(test)]
impl IndicatifWizard {
    /// Test-only accessor for the pause state so tests can assert
    /// `pause_for_input` / `resume_after_input` actually flip it.
    fn input_paused(&self) -> bool {
        self.input_paused
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli::{GlobalOptions, OutputFormat};

    fn globals() -> GlobalOptions {
        GlobalOptions {
            no_telemetry: true,
            ..Default::default()
        }
    }

    #[test]
    fn quiet_selects_silent() {
        let mut g = globals();
        g.quiet = true;
        assert_eq!(progress_mode_for(&g, true), ProgressMode::Silent);
    }

    #[test]
    fn json_selects_silent() {
        let mut g = globals();
        g.output = OutputFormat::Json;
        assert_eq!(progress_mode_for(&g, true), ProgressMode::Silent);
    }

    #[test]
    fn tty_selects_wizard() {
        assert_eq!(progress_mode_for(&globals(), true), ProgressMode::Wizard);
    }

    #[test]
    fn nontty_selects_plain() {
        assert_eq!(progress_mode_for(&globals(), false), ProgressMode::Plain);
    }

    #[test]
    fn yes_does_not_force_silent() {
        // --yes lives on InitOptions, not GlobalOptions — Wizard still applies on TTY.
        assert_eq!(progress_mode_for(&globals(), true), ProgressMode::Wizard);
    }

    #[test]
    fn plain_steps_emit_no_ansi() {
        let mut p = PlainSteps::capturing();
        p.start_step("identity", "Sign in");
        p.tick("identity", "waiting");
        p.succeed("identity", Some("ok"));
        p.start_step("runtime", "Start Core");
        p.warn("runtime", Some("skipped"));
        p.start_step("smoke", "Smoke");
        p.fail("smoke", Some("timeout"));
        let out = p.lines.join("\n");
        assert!(!out.contains('\u{1b}'), "unexpected ANSI in: {out}");
        assert!(out.contains('✓'));
        assert!(out.contains('⚠'));
        assert!(out.contains('✗'));
        assert!(out.contains("[1] Sign in"));
    }

    #[test]
    fn wizard_pause_for_input_toggles_state() {
        let mut p = IndicatifWizard::new();
        p.start_step("runtime", "Start local Core (Docker)");
        assert!(!p.input_paused(), "pause state should start false");
        p.pause_for_input();
        assert!(
            p.input_paused(),
            "pause_for_input must flip input_paused to true"
        );
        // Idempotent: a second pause is a no-op and must not clear the flag.
        p.pause_for_input();
        assert!(p.input_paused(), "double-pause must remain paused");
        p.resume_after_input();
        assert!(
            !p.input_paused(),
            "resume_after_input must flip input_paused back to false"
        );
        // Resuming when not paused is also a no-op.
        p.resume_after_input();
        assert!(!p.input_paused(), "double-resume must remain unpaused");
        p.succeed("runtime", Some("healthy"));
    }

    struct RecordingReporter {
        input_events: Vec<&'static str>,
    }

    impl ProgressReporter for RecordingReporter {
        fn start_step(&mut self, _id: &str, _label: &str) {}
        fn succeed(&mut self, _id: &str, _detail: Option<&str>) {}
        fn warn(&mut self, _id: &str, _detail: Option<&str>) {}
        fn fail(&mut self, _id: &str, _detail: Option<&str>) {}
        fn finish(&mut self) {}
        fn pause_for_input(&mut self) {
            self.input_events.push("pause");
        }
        fn resume_after_input(&mut self) {
            self.input_events.push("resume");
        }
    }

    #[test]
    fn with_progress_paused_for_input_resumes_on_error() {
        let mut reporter = RecordingReporter {
            input_events: Vec::new(),
        };
        let result: Result<(), &str> =
            with_progress_paused_for_input(&mut reporter, true, || Err("prompt failed"));
        assert!(result.is_err());
        assert_eq!(reporter.input_events, vec!["pause", "resume"]);
    }
}
