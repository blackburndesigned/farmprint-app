#!/usr/bin/env python3
"""Fail if any tracked file contains a private marker or something that looks like a secret.

Private names and ids are stored only as SHA-256 hashes of lowercased words (and word pairs),
so this public file never spells them out. Secret-looking patterns are checked as regexes.
Run: python3 scripts/privacy_scan.py
"""
import hashlib
import re
import subprocess
import sys

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

WORD = re.compile(r"[a-z0-9_]+")


def h(s: str) -> str:
    return hashlib.sha256(s.encode()).hexdigest()


def main() -> int:
    files = subprocess.run(["git", "ls-files", "-z"], capture_output=True, check=True).stdout.split(b"\0")
    hits = 0
    for raw in files:
        if not raw:
            continue
        path = raw.decode()
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
            words = WORD.findall(line.lower())
            grams = words + [a + " " + b for a, b in zip(words, words[1:])]
            reason = None
            if any(h(g) in BLOCKED_HASHES for g in grams):
                reason = "private name or id"
            else:
                for p in SECRET_PATTERNS:
                    if p.search(line):
                        reason = "looks like a secret"
                        break
            if reason:
                hits += 1
                print(f"::error file={path},line={n}::{reason}")
                print(f"{path}:{n}: {reason}", file=sys.stderr)
    if hits:
        print(f"FAILED: {hits} line(s) need fixing before this can merge.", file=sys.stderr)
        return 1
    print(f"OK: {len([f for f in files if f])} files scanned, nothing private found.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
