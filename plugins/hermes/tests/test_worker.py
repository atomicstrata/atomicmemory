"""IngestWorker — single-writer queue drains in order; shutdown joins bounded."""

from __future__ import annotations

import sys
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from plugins.hermes.worker import IngestJob, IngestWorker


class WorkerProcessesSubmittedJobs(unittest.TestCase):
    def test_jobs_run_in_submission_order(self) -> None:
        seen: list[str] = []
        seen_event = threading.Event()

        def run_job(job: IngestJob) -> None:
            seen.append(job.session_id)
            if len(seen) == 3:
                seen_event.set()

        worker = IngestWorker(run_job=run_job)
        worker.start()

        worker.submit(IngestJob("u", "a", "s1"))
        worker.submit(IngestJob("u", "a", "s2"))
        worker.submit(IngestJob("u", "a", "s3"))
        self.assertTrue(seen_event.wait(timeout=2))
        worker.shutdown()

        self.assertEqual(seen, ["s1", "s2", "s3"])


class WorkerShutdownJoinsCleanly(unittest.TestCase):
    def test_shutdown_drains_pending_jobs(self) -> None:
        processed = threading.Event()

        def run_job(job: IngestJob) -> None:
            processed.set()

        worker = IngestWorker(run_job=run_job)
        worker.start()

        self.assertTrue(worker.submit(IngestJob("u", "a", "s1")))
        worker.shutdown()

        self.assertTrue(processed.is_set())


class WorkerSubmitAfterShutdownReturnsFalse(unittest.TestCase):
    def test_submit_after_stop_drops(self) -> None:
        worker = IngestWorker(run_job=lambda _job: None)
        worker.start()
        worker.shutdown()

        self.assertFalse(worker.submit(IngestJob("u", "a", "s1")))


class WorkerForwardsJobFailureToCallback(unittest.TestCase):
    def test_on_failure_invoked_with_exception(self) -> None:
        seen: list[BaseException] = []
        received = threading.Event()

        def run_job(_job: IngestJob) -> None:
            raise RuntimeError("boom")

        def on_failure(exc: BaseException) -> None:
            seen.append(exc)
            received.set()

        worker = IngestWorker(run_job=run_job, on_failure=on_failure)
        worker.start()
        worker.submit(IngestJob("u", "a", "s1"))
        self.assertTrue(received.wait(timeout=2))
        worker.shutdown()

        self.assertEqual(len(seen), 1)
        self.assertIsInstance(seen[0], RuntimeError)


if __name__ == "__main__":
    unittest.main()
