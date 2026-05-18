"""IngestWorker — single-writer queue + daemon thread for non-blocking sync_turn.

Replaces the v1 per-call thread model that leaked orphans on join timeouts.
Hermes' chat loop calls `submit()` (non-blocking); the daemon worker drains
the queue serially, calling the supplied ingest function on each entry.

`shutdown()` posts a sentinel and joins the worker (bounded). Drops oldest
on a full queue with a single warning log per drop.
"""

from __future__ import annotations

import logging
import queue
import threading
from dataclasses import dataclass
from typing import Any, Callable


logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class IngestJob:
    """Payload passed from sync_turn into the worker queue."""

    user_content: str
    assistant_content: str
    session_id: str


_SHUTDOWN_SENTINEL = object()


class IngestWorker:
    """Single-writer worker that drains queued ingest jobs in order."""

    def __init__(
        self,
        *,
        run_job: Callable[[IngestJob], None],
        max_queue_size: int = 32,
        on_failure: Callable[[BaseException], None] | None = None,
    ) -> None:
        self._run_job = run_job
        self._on_failure = on_failure
        self._queue: queue.Queue[Any] = queue.Queue(maxsize=max_queue_size)
        self._thread: threading.Thread | None = None
        self._started = threading.Event()
        self._stopped = threading.Event()

    def start(self) -> None:
        if self._thread is not None:
            return
        self._thread = threading.Thread(
            target=self._run,
            daemon=True,
            name="atomicmemory-ingest-worker",
        )
        self._thread.start()
        self._started.set()

    def submit(self, job: IngestJob) -> bool:
        """Non-blocking enqueue. Returns False if the queue is full (drop)."""
        if self._stopped.is_set():
            return False
        try:
            self._queue.put_nowait(job)
            return True
        except queue.Full:
            logger.warning("AtomicMemory ingest queue full; dropping turn for session %s", job.session_id)
            return False

    def shutdown(self, *, timeout: float = 10.0) -> None:
        if self._thread is None:
            return
        self._stopped.set()
        try:
            self._queue.put_nowait(_SHUTDOWN_SENTINEL)
        except queue.Full:
            # Drain one slot to make space for the sentinel; ensures shutdown
            # doesn't hang behind a saturated queue.
            try:
                self._queue.get_nowait()
                self._queue.task_done()
            except queue.Empty:
                pass
            self._queue.put_nowait(_SHUTDOWN_SENTINEL)
        thread = self._thread
        self._thread = None
        thread.join(timeout=timeout)

    def queue_size(self) -> int:
        return self._queue.qsize()

    def _run(self) -> None:
        while True:
            item = self._queue.get()
            try:
                if item is _SHUTDOWN_SENTINEL:
                    return
                try:
                    self._run_job(item)
                except BaseException as exc:  # noqa: BLE001 — caller decides retry policy
                    if self._on_failure is not None:
                        try:
                            self._on_failure(exc)
                        except Exception:  # noqa: BLE001
                            logger.exception("ingest on_failure callback raised")
                    else:
                        logger.warning("AtomicMemory ingest job failed: %s", exc)
            finally:
                self._queue.task_done()
