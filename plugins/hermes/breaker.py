"""Thread-safe circuit breaker — restored from v1, with a real lock.

Wraps every SDK call. After `threshold` consecutive failures the breaker
opens for `cooldown_seconds`; the next probing call after cooldown reads as
closed (the counter is cleared eagerly on the read so a single success
proves recovery).
"""

from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass


logger = logging.getLogger(__name__)


@dataclass
class CircuitBreaker:
    threshold: int = 5
    cooldown_seconds: float = 120.0
    _consecutive_failures: int = 0
    _open_until_monotonic: float = 0.0
    _lock: threading.Lock = None  # type: ignore[assignment]

    def __post_init__(self) -> None:
        if self._lock is None:
            self._lock = threading.Lock()

    def is_open(self, *, now: float | None = None) -> bool:
        clock = now if now is not None else time.monotonic()
        with self._lock:
            if self._consecutive_failures < self.threshold:
                return False
            if clock >= self._open_until_monotonic:
                self._consecutive_failures = 0
                return False
            return True

    def record_success(self) -> None:
        with self._lock:
            self._consecutive_failures = 0

    def record_failure(self, *, now: float | None = None) -> None:
        clock = now if now is not None else time.monotonic()
        with self._lock:
            self._consecutive_failures += 1
            if self._consecutive_failures >= self.threshold:
                self._open_until_monotonic = clock + self.cooldown_seconds
                logger.warning(
                    "AtomicMemory circuit breaker tripped after %d consecutive failures. "
                    "Pausing calls for %.0fs.",
                    self._consecutive_failures,
                    self.cooldown_seconds,
                )
