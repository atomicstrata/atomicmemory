#!/usr/bin/env python3
"""Run a piped installer with a controlling terminal for stdin contract tests."""

import errno
import os
import pty
import sys


def stream_installer(installer: str, target_fd: int) -> None:
    with open(installer, "rb") as source:
        while chunk := source.read(64 * 1024):
            os.write(target_fd, chunk)


def run(installer: str, arguments: list[str]) -> int:
    child_pid, terminal_fd = pty.fork()
    if child_pid == 0:
        read_fd, write_fd = os.pipe()
        writer_pid = os.fork()
        if writer_pid == 0:
            os.close(read_fd)
            stream_installer(installer, write_fd)
            os.close(write_fd)
            os._exit(0)
        os.close(write_fd)
        os.dup2(read_fd, 0)
        os.close(read_fd)
        os.execvpe("sh", ["sh", "-s", "--", *arguments], os.environ)

    while True:
        try:
            output = os.read(terminal_fd, 4096)
        except OSError as error:
            if error.errno == errno.EIO:
                break
            raise
        if not output:
            break
        os.write(1, output)
    _, status = os.waitpid(child_pid, 0)
    return os.waitstatus_to_exitcode(status)


if __name__ == "__main__":
    raise SystemExit(run(sys.argv[1], sys.argv[2:]))
