#!/usr/bin/env python3
"""Assert a nightly workflow's reporter grades every job it depends on.

Both CLI install-smoke lanes end in a `report` job that opens or closes a
GitHub issue. Its verdict is only as good as the set of upstream results it
reads: ATO-1863 shipped a reporter that listed `public-provenance` in `needs`
but graded only `public-install-smoke`, so a provenance failure — the half of
the lane that checks signatures — would have passed the night in silence.

Grepping for three literal job names would not have caught that, and would not
catch the next job someone adds. This enumerates `needs` and requires each
entry to be (a) covered by the cancelled guard, (b) bound to an env var, and
(c) compared against "success". A new lane that is not graded fails here.

Regex rather than a YAML parser so the test suite keeps its only dependencies
as bash and python3; the shapes it matches are pinned by the tests below it.

Usage:
    python3 scripts/__tests__/reporter-grades-every-lane.py <workflow.yml> ...
Exits 0 when every reporter grades every lane, 1 otherwise.
"""

import re
import sys


def report_job(text: str) -> str:
    """Return the reporter job block, or "" when none is found.

    Matches any job whose body opens the failure issue, rather than the literal
    name `report:` — renaming the job used to make this return "" and, with the
    old contract, silently pass a workflow with every grading line deleted.
    """
    for match in re.finditer(r"^  [A-Za-z][\w-]*:\n(?:(?:    .*)?\n)*", text, re.MULTILINE):
        if "needs." in match.group(0) and "issue" in match.group(0):
            return match.group(0)
    return ""


def declared_needs(block: str) -> list[str]:
    """Job names from `needs: a`, `needs: [a, b]`, or a `- a` block list."""
    inline = re.search(r"^    needs:\s*\[([^\]]*)\]", block, re.MULTILINE)
    if inline:
        return [name.strip() for name in inline.group(1).split(",") if name.strip()]
    scalar = re.search(r"^    needs:\s*([A-Za-z][\w-]*)\s*$", block, re.MULTILINE)
    if scalar:
        return [scalar.group(1)]
    listed = re.search(r"^    needs:\s*\n((?:\s+-\s*[\w-]+\n)+)", block, re.MULTILINE)
    if listed:
        return re.findall(r"-\s*([\w-]+)", listed.group(1))
    return []


def success_condition(block: str) -> str:
    """The `if …; then` that decides the green path, line continuations joined.

    Selected by content, not position: the reporter's first `if` is the label
    bootstrap, so taking the first match graded the wrong statement.
    """
    joined = re.sub(r"\\\n\s*", " ", block)
    for match in re.finditer(r"^\s*if\s+(.*?);\s*then\s*$", joined, re.MULTILINE):
        if '= "success"' in match.group(1):
            return match.group(1)
    return ""


def check(path: str) -> list[str]:
    text = open(path, encoding="utf-8").read().replace("\r\n", "\n")
    if not text.endswith("\n"):
        text += "\n"
    block = report_job(text)
    if not block:
        # Failing to locate the reporter is a failure, not a pass. This function
        # used to return [] here, so a renamed job disabled the guard silently.
        return [f"{path}: no reporter job found — cannot verify anything"]

    needs = declared_needs(block)
    if not needs:
        return [f"{path}: report job declares no `needs` — nothing is graded"]

    # VAR: ${{ needs.<job>.result }}
    bound = dict(
        (job, var)
        for var, job in re.findall(
            r"^\s+([A-Z][A-Z0-9_]*):\s*\$\{\{\s*needs\.([\w-]+)\.result\s*\}\}",
            block,
            re.MULTILINE,
        )
    )

    problems = []
    for job in needs:
        if f"needs.{job}.result != 'cancelled'" not in block:
            problems.append(f"{path}: `{job}` is in needs but not in the cancelled guard")
        if job not in bound:
            problems.append(f"{path}: `{job}` is in needs but bound to no env var")
            continue
        if f'"${bound[job]}" = "success"' not in block:
            problems.append(
                f"{path}: `{job}` -> ${bound[job]} is never compared against \"success\""
            )

    for job in bound:
        if job not in needs:
            problems.append(f"{path}: grades `{job}`, which is not in needs")

    # Presence is not enough: `A || B || C` mentions every variable and is
    # green whenever any single lane passed — the exact silent-green this file
    # exists to prevent, and the mutation the first version of it missed.
    condition = success_condition(block)
    if not condition:
        problems.append(f"{path}: no `if …; then` success condition found")
    else:
        for operator in ("||", " -o "):
            if operator in condition:
                problems.append(
                    f"{path}: success condition joins lanes with `{operator.strip()}`"
                    " — every lane must be required"
                )
        for job, var in bound.items():
            if f'"${var}"' not in condition:
                problems.append(
                    f"{path}: `{job}` -> ${var} is not part of the success condition"
                )
    return problems


def main(paths: list[str]) -> int:
    if not paths:
        print("usage: reporter-grades-every-lane.py <workflow.yml> ...", file=sys.stderr)
        return 2
    problems = [problem for path in paths for problem in check(path)]
    for problem in problems:
        print(f"  {problem}", file=sys.stderr)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
