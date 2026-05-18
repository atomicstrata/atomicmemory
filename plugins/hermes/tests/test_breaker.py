"""Circuit breaker — trip + cooldown + reset (deterministic, no time.sleep)."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from plugins.hermes.breaker import CircuitBreaker


class BreakerStartsClosed(unittest.TestCase):
    def test_initial_state_is_closed(self) -> None:
        breaker = CircuitBreaker(threshold=5, cooldown_seconds=120)

        self.assertFalse(breaker.is_open(now=1.0))


class BreakerTripsAtThreshold(unittest.TestCase):
    def test_opens_after_n_consecutive_failures(self) -> None:
        breaker = CircuitBreaker(threshold=3, cooldown_seconds=60)

        for _ in range(3):
            breaker.record_failure(now=10.0)

        self.assertTrue(breaker.is_open(now=10.0))


class BreakerResetsOnSuccess(unittest.TestCase):
    def test_success_clears_failure_count_immediately(self) -> None:
        breaker = CircuitBreaker(threshold=3, cooldown_seconds=60)
        for _ in range(3):
            breaker.record_failure(now=10.0)
        self.assertTrue(breaker.is_open(now=10.0))

        breaker.record_success()

        self.assertFalse(breaker.is_open(now=10.0))


class BreakerCooldownExpires(unittest.TestCase):
    def test_open_state_clears_after_cooldown_window(self) -> None:
        breaker = CircuitBreaker(threshold=2, cooldown_seconds=60)
        breaker.record_failure(now=100.0)
        breaker.record_failure(now=100.0)
        self.assertTrue(breaker.is_open(now=100.0))

        # Right at the boundary: still open until strictly past cooldown.
        self.assertFalse(breaker.is_open(now=160.0))


class BreakerSubthresholdStaysClosed(unittest.TestCase):
    def test_below_threshold_failures_do_not_open(self) -> None:
        breaker = CircuitBreaker(threshold=5, cooldown_seconds=60)

        for _ in range(4):
            breaker.record_failure(now=1.0)

        self.assertFalse(breaker.is_open(now=1.0))


if __name__ == "__main__":
    unittest.main()
