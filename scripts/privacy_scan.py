#!/usr/bin/env python3
"""Fail if any tracked file contains a private marker or something that looks like a secret.

Private names and ids are stored only as SHA-256 hashes of lowercased words (and word pairs),
so this public file never spells them out. Secret-looking patterns are checked as regexes.

Team assistant names are stored only as XOR-encoded tokens and compiled into patterns at
runtime, so this file does not contain those names in plaintext. They are also checked in
tracked file paths, and (when flags are passed) in a branch name, PR title and body, and
commit messages, authors, and committers in a revision range. Commit author and committer
emails must not use a blocked local development domain.

Run: python3 scripts/privacy_scan.py
Extra checks (values are read from environment variables, never required on the command line):

  python3 scripts/privacy_scan.py \\
    --branch-from-env PR_HEAD_REF \\
    --pr-title-from-env PR_TITLE \\
    --pr-body-from-env PR_BODY \\
    --commits-from-env BASE_SHA HEAD_SHA
"""
from __future__ import annotations

import argparse
import hashlib
import os
import re
import subprocess
import sys
from collections.abc import Iterable

BLOCKED_HASHES = {
    "2a8bf9c9e658e8e5f41d8689e6fc1a229671afa45db4152d52e2b85be9ce5f38",
    "d3b760b06b993754bfc9b1fb6aa6dbd1a0a214a4968db45b8c3b7f96ae0b041b",
    "82c5fdedfdd101115a1b4933f05a9d588d65333b708394d39c770412c8a21dea",
    "088c150636539c0f36308592799684a5a21f51c410aec4e75671d86f95cb10a7",
    "4bf55a9ce713ee0c1ca0a4d517cc5a5c3b83f7dd4dc5f9009b19b3346191e8cd",
    "eef6cbe945b3f7b016c983f95e90c8ff770b835e62264120c8c14307dd451908",
    "810cb2b5f9653490e521d6c4030fcc0af4f77823665cb91be7b4124722f878d5",
    "1de08c6dfc2563be82fee5f8ac2aa418ff76be4c0bfbf30bae3347a524386619",
    "af2d35db455ac5712a3d87157d7289d7532421d704cac432fbcb09fde69ab1d8",
}

SECRET_PATTERNS = [
    re.compile(r"BEGIN [A-Z ]*PRIVATE KEY"),
    re.compile(r"untrusted comment: rsign encrypted secret key"),
    re.compile(r"\bsk_(live|test)_[0-9A-Za-z]{8,}"),
    re.compile(r"\brk_(live|test)_[0-9A-Za-z]{8,}"),
    re.compile(r"\bwhsec_[0-9A-Za-z]{8,}"),
    re.compile(r"\bservice_role\b"),
    re.compile(r"\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}"),
    re.compile(r"\bgh[pousr]_[A-Za-z0-9]{30,}"),
    re.compile(r"\bre_[A-Za-z0-9]{8,}_[A-Za-z0-9]{16,}"),
]

# Blocked local-dev mailbox domain, written in parts so it stays obvious as a rule,
# not as a real address.
LOCAL_DEV_EMAIL = re.compile(r"@farmprint\.local\b", re.IGNORECASE)

WORD = re.compile(r"[a-z0-9_]+")

# XOR key for team assistant name tokens. Tokens are lowercase words; sequences are
# joined with optional spaces, hyphens, or underscores (or nothing) at match time.
_TOKEN_KEY = 0xA5
_TOKEN_SEQS_HEX = (
    ("96c1", "c1d0c1c0"),  # two-word product role
    ("c4d5d5", "c2d0dc"),  # two-word app role
    ("d2c0c7", "c2d0dc"),  # two-word web role
    ("c6d0d6d1cac8c0d7", "d7c0c9c4d1cccacbd6", "c2d0dc"),  # three-word relations role
    ("c3d5", "c4d7c6cdccd1c0c6d1"),  # two-word architecture role
    ("c2d7cace",),  # short model-family name, whole word only
    ("c2d7cace", "c7cad1"),  # that name plus "bot" (including no separator)
    ("c2d7cace", "c7d0ccc9c1"),  # that name plus "build" (including no separator)
)


def _decode_token(hexstr: str) -> str:
    return bytes(b ^ _TOKEN_KEY for b in bytes.fromhex(hexstr)).decode("ascii")


def _sequence_pattern(tokens: list[str]) -> re.Pattern[str]:
    """Build a case-insensitive pattern for a token sequence.

    Tokens may be separated by spaces, hyphens, underscores, or nothing.
    The first token and the last are anchored as whole words so ordinary
    words that only share a prefix or suffix do not match.
    """
    parts = [re.escape(tokens[0])]
    for tok in tokens[1:]:
        parts.append(r"[ \t\-_]*")
        parts.append(re.escape(tok))
    return re.compile(r"\b" + "".join(parts) + r"\b", re.IGNORECASE)


TEAM_NAME_PATTERNS = [_sequence_pattern([_decode_token(t) for t in seq]) for seq in _TOKEN_SEQS_HEX]


def h(s: str) -> str:
    return hashlib.sha256(s.encode()).hexdigest()


def team_name_hit(text: str) -> bool:
    """True if text contains a team assistant name (any allowed separator form)."""
    if not text:
        return False
    return any(p.search(text) for p in TEAM_NAME_PATTERNS)


def local_dev_email_hit(text: str) -> bool:
    return bool(text and LOCAL_DEV_EMAIL.search(text))


def _line_private_reason(line: str) -> str | None:
    words = WORD.findall(line.lower())
    grams = words + [a + " " + b for a, b in zip(words, words[1:])]
    if any(h(g) in BLOCKED_HASHES for g in grams):
        return "private name or id"
    if team_name_hit(line):
        return "team assistant name"
    for p in SECRET_PATTERNS:
        if p.search(line):
            return "looks like a secret"
    return None


def _report(location: str, reason: str) -> None:
    # GitHub annotation form when location looks like file[:line]
    if ":" in location and not location.startswith("commit "):
        file, _, rest = location.partition(":")
        print(f"::error file={file},line={rest}::{reason}")
    else:
        print(f"::error::{location}: {reason}")
    print(f"{location}: {reason}", file=sys.stderr)


def scan_tracked_files() -> tuple[int, int]:
    files = subprocess.run(["git", "ls-files", "-z"], capture_output=True, check=True).stdout.split(b"\0")
    hits = 0
    scanned = 0
    for raw in files:
        if not raw:
            continue
        path = raw.decode()
        scanned += 1
        if team_name_hit(path):
            hits += 1
            _report(f"{path}:0", "team assistant name in path")
        if path == "scripts/privacy_scan.py":
            continue
        try:
            data = open(path, "rb").read()
        except OSError:
            continue
        if b"\0" in data[:8192]:
            continue  # binary
        text = data.decode("utf-8", "replace")
        for n, line in enumerate(text.splitlines(), 1):
            reason = _line_private_reason(line)
            if reason:
                hits += 1
                _report(f"{path}:{n}", reason)
    return hits, scanned


def scan_label(label: str, text: str) -> int:
    if team_name_hit(text):
        _report(label, "team assistant name")
        return 1
    if local_dev_email_hit(text):
        _report(label, "disallowed email domain")
        return 1
    return 0


def _all_zero_sha(sha: str) -> bool:
    return bool(sha) and set(sha.lower()) == {"0"} and len(sha) >= 40


def _commit_range_args(base: str, head: str) -> list[str]:
    if not head:
        raise ValueError("commit range is missing a head SHA")
    if not base or _all_zero_sha(base):
        # New branch or the first push: scan commits on head that are not on main, if main exists.
        guessed = subprocess.run(
            ["git", "merge-base", "origin/main", head],
            capture_output=True,
            text=True,
        )
        if guessed.returncode == 0 and guessed.stdout.strip():
            return [f"{guessed.stdout.strip()}..{head}"]
        return ["-1", head]
    return [f"{base}..{head}"]


def scan_commit_range(base: str, head: str) -> int:
    """Scan commit messages, authors, and committers in (base, head]."""
    try:
        rev_args = _commit_range_args(base, head)
    except ValueError as exc:
        print(f"FAILED: {exc}", file=sys.stderr)
        return 1
    # %x1f field sep, %x1e record sep. Bodies may contain newlines.
    fmt = "%H%x1f%an%x1f%ae%x1f%cn%x1f%ce%x1f%s%x1f%b%x1e"
    proc = subprocess.run(
        ["git", "log", "--format=" + fmt, *rev_args],
        capture_output=True,
        check=False,
    )
    if proc.returncode != 0:
        err = (proc.stderr or b"").decode("utf-8", "replace").strip()
        print(f"FAILED: could not read commit range: {err}", file=sys.stderr)
        return 1
    raw = proc.stdout.decode("utf-8", "replace")
    hits = 0
    for record in raw.split("\x1e"):
        record = record.strip("\n")
        if not record.strip():
            continue
        parts = record.split("\x1f", 6)
        if len(parts) < 6:
            continue
        sha, an, ae, cn, ce, subject = parts[0], parts[1], parts[2], parts[3], parts[4], parts[5]
        body = parts[6] if len(parts) > 6 else ""
        short = sha[:12]
        message = subject + ("\n" + body if body else "")
        if team_name_hit(message):
            _report(f"commit {short} message", "team assistant name")
            hits += 1
        for field, label in ((an, "author"), (cn, "committer")):
            if team_name_hit(field):
                _report(f"commit {short} {label}", "team assistant name")
                hits += 1
        for field, label in ((ae, "author email"), (ce, "committer email")):
            if team_name_hit(field) or local_dev_email_hit(field):
                reason = "team assistant name" if team_name_hit(field) else "disallowed email domain"
                _report(f"commit {short} {label}", reason)
                hits += 1
    return hits


def _env_text(var: str) -> str:
    # GitHub may pass a JSON null for an empty PR body as the empty string or as "null"
    # only if we interpolated; with env mapping, unset or empty is "".
    return os.environ.get(var) or ""


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Scan the repo (and optional PR/commit text) for private material.")
    p.add_argument("--branch-from-env", metavar="VAR", help="env var holding the branch name (e.g. github.head_ref)")
    p.add_argument("--pr-title-from-env", metavar="VAR", help="env var holding the PR title")
    p.add_argument("--pr-body-from-env", metavar="VAR", help="env var holding the PR body")
    p.add_argument(
        "--commits-from-env",
        nargs=2,
        metavar=("BASE_VAR", "HEAD_VAR"),
        help="env vars holding the exclusive base SHA and inclusive head SHA",
    )
    p.add_argument("--no-files", action="store_true", help="skip the tracked-file scan (for unit tests)")
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    hits = 0
    scanned = 0
    if not args.no_files:
        file_hits, scanned = scan_tracked_files()
        hits += file_hits
    if args.branch_from_env:
        hits += scan_label("branch", _env_text(args.branch_from_env))
    if args.pr_title_from_env:
        hits += scan_label("pr title", _env_text(args.pr_title_from_env))
    if args.pr_body_from_env:
        hits += scan_label("pr body", _env_text(args.pr_body_from_env))
    if args.commits_from_env:
        base = _env_text(args.commits_from_env[0])
        head = _env_text(args.commits_from_env[1])
        hits += scan_commit_range(base, head)
    if hits:
        print(f"FAILED: {hits} issue(s) need fixing before this can merge.", file=sys.stderr)
        return 1
    if args.no_files:
        print("OK: supplied text is clean.")
    else:
        print(f"OK: {scanned} files scanned, nothing private found.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
