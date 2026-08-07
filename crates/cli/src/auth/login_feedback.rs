//! Testable login output policy for TTY, verbose, and non-TTY modes.

use std::io::{self, IsTerminal};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LoginFeedback {
    pub verbose: bool,
    pub quiet: bool,
    pub stderr_is_tty: bool,
}

impl LoginFeedback {
    pub fn detect(verbose: bool, quiet: bool) -> Self {
        Self {
            verbose,
            quiet,
            stderr_is_tty: io::stderr().is_terminal(),
        }
    }

    #[cfg(test)]
    pub fn for_test(verbose: bool, quiet: bool, stderr_is_tty: bool) -> Self {
        Self {
            verbose,
            quiet,
            stderr_is_tty,
        }
    }

    pub fn show_authorize_url(&self) -> bool {
        !self.quiet && (self.verbose || !self.stderr_is_tty)
    }

    pub fn concise_tty(&self) -> bool {
        !self.quiet && self.stderr_is_tty && !self.verbose
    }

    pub fn show_recovery_hints(&self) -> bool {
        !self.quiet && (self.verbose || !self.stderr_is_tty)
    }

    pub fn show_waiting_message(&self) -> bool {
        !self.quiet
    }

    pub fn show_success(&self) -> bool {
        !self.quiet
    }

    pub fn success_line(&self, profile: &str) -> &'static str {
        let _ = profile;
        if self.verbose || !self.stderr_is_tty {
            "Logged in. Profile updated."
        } else {
            "Logged in."
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tty_default_hides_authorize_url() {
        let fb = LoginFeedback::for_test(false, false, true);
        assert!(fb.concise_tty());
        assert!(!fb.show_authorize_url());
        assert!(!fb.show_recovery_hints());
        assert_eq!(fb.success_line("cloud"), "Logged in.");
    }

    #[test]
    fn verbose_tty_shows_authorize_url_and_hints() {
        let fb = LoginFeedback::for_test(true, false, true);
        assert!(!fb.concise_tty());
        assert!(fb.show_authorize_url());
        assert!(fb.show_recovery_hints());
        assert_eq!(fb.success_line("cloud"), "Logged in. Profile updated.");
    }

    #[test]
    fn nontty_shows_authorize_url_and_hints() {
        let fb = LoginFeedback::for_test(false, false, false);
        assert!(!fb.concise_tty());
        assert!(fb.show_authorize_url());
        assert!(fb.show_recovery_hints());
    }

    #[test]
    fn quiet_suppresses_success_and_urls() {
        let fb = LoginFeedback::for_test(true, true, true);
        assert!(!fb.show_authorize_url());
        assert!(!fb.show_success());
        assert!(!fb.show_waiting_message());
    }
}
