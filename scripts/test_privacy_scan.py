#!/usr/bin/env python3
"""Tests for scripts/privacy_scan.py.

Positive examples are built at runtime from the script's encoded tokens so this
file does not itself contain team assistant names in plaintext.
"""
from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))
import privacy_scan as ps  # noqa: E402

REPO_ROOT = SCRIPT_DIR.parent


def tokens(seq_index: int) -> list[str]:
    return [ps._decode_token(t) for t in ps._TOKEN_SEQS_HEX[seq_index]]


def joined(seq_index: int, sep: str) -> str:
    return sep.join(tokens(seq_index))


class TeamNameMatching(unittest.TestCase):
    def test_two_word_roles_accept_common_separators_and_concatenation(self):
        # product role, app role, web role, architecture role
        for idx in (0, 1, 2, 4):
            for sep in (" ", "-", "_", ""):
                text = joined(idx, sep)
                self.assertTrue(ps.team_name_hit(text), f"expected a hit for sep={sep!r} idx={idx}")
                self.assertTrue(ps.team_name_hit(text.upper()))
                self.assertTrue(ps.team_name_hit(f"prefix {text} suffix"))

    def test_three_word_role_accepts_separators_and_concatenation(self):
        for sep in (" ", "-", "_", ""):
            text = joined(3, sep)
            self.assertTrue(ps.team_name_hit(text), f"expected a hit for sep={sep!r}")

    def test_three_word_role_does_not_match_first_two_words_alone(self):
        first_two = tokens(3)[0] + " " + tokens(3)[1]
        self.assertFalse(ps.team_name_hit(first_two))

    def test_architecture_role_does_not_match_second_word_alone(self):
        self.assertFalse(ps.team_name_hit(tokens(4)[1]))
        self.assertFalse(ps.team_name_hit(tokens(4)[0]))

    def test_short_name_is_a_whole_word_only(self):
        short = tokens(5)[0]
        self.assertTrue(ps.team_name_hit(short))
        self.assertTrue(ps.team_name_hit(short.upper()))
        self.assertTrue(ps.team_name_hit(f"({short})"))
        self.assertFalse(ps.team_name_hit(short + "king"))
        self.assertFalse(ps.team_name_hit("a" + short))

    def test_short_name_with_bot_or_build_including_no_separator(self):
        for idx in (6, 7):
            for sep in (" ", "-", "_", ""):
                self.assertTrue(ps.team_name_hit(joined(idx, sep)), f"idx={idx} sep={sep!r}")

    def test_ordinary_words_are_not_hits(self):
        for text in (
            "application",
            "3dudes",
            "happy",
            "the guy",
            "web site",
            "customer service",
            "architects",
            "building",
            "robot",
        ):
            self.assertFalse(ps.team_name_hit(text), text)

    def test_path_and_branch_forms(self):
        role = joined(1, "-")
        self.assertTrue(ps.team_name_hit(f"fix/{role}-labels"))
        self.assertTrue(ps.team_name_hit(f"feat/{joined(0, '-')}"))
        self.assertEqual(ps.scan_label("branch", f"fix/{role}-labels"), 1)
        self.assertEqual(ps.scan_label("branch", "ci/name-scan"), 0)

    def test_pr_title_and_body_flags(self):
        self.assertEqual(ps.scan_label("pr title", "Add a helper"), 0)
        self.assertEqual(ps.scan_label("pr title", f"Help from {joined(1, ' ')}"), 1)
        self.assertEqual(ps.scan_label("pr body", "No issue here."), 0)
        self.assertEqual(ps.scan_label("pr body", f"Thanks, {joined(2, '-')}."), 1)

    def test_local_dev_email_domain(self):
        addr = "dev@farmprint.local"
        self.assertTrue(ps.local_dev_email_hit(addr))
        self.assertTrue(ps.local_dev_email_hit(addr.upper()))
        self.assertFalse(ps.local_dev_email_hit("person@example.com"))
        self.assertEqual(ps.scan_label("author email", addr), 1)
        self.assertEqual(ps.scan_label("author email", "person@example.com"), 0)

    def test_name_in_email_local_part(self):
        local = joined(1, "-") + "@example.com"
        self.assertTrue(ps.team_name_hit(local))
        self.assertEqual(ps.scan_label("author email", local), 1)

    def test_encoded_script_has_no_plaintext_names(self):
        source = (SCRIPT_DIR / "privacy_scan.py").read_text()
        self.assertFalse(ps.team_name_hit(source))
        self.assertFalse(ps.team_name_hit((SCRIPT_DIR / "test_privacy_scan.py").read_text()))

    def test_secret_pattern_still_flagged(self):
        kind = "te" + "st"
        sample = "key = sk_" + kind + "_12345678abcd"
        self.assertEqual(ps._line_private_reason(sample), "looks like a secret")


class CommitRangeScan(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self.tmp.name)
        self._git("init", "-q", "-b", "main")
        self._git("config", "user.name", "Pat Example")
        self._git("config", "user.email", "pat@example.com")
        (self.repo / "README").write_text("ok\n")
        self._git("add", "README")
        self._git("commit", "-q", "-m", "initial")
        self.base = self._git("rev-parse", "HEAD").stdout.strip()

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _git(self, *args: str, env: dict | None = None, check: bool = True):
        run_env = os.environ.copy()
        if env:
            run_env.update(env)
        return subprocess.run(
            ["git", *args],
            cwd=self.repo,
            capture_output=True,
            text=True,
            check=check,
            env=run_env,
        )

    def _commit(self, message: str, name: str | None = None, email: str | None = None) -> str:
        (self.repo / "README").write_text(self.repo.joinpath("README").read_text() + "x\n")
        self._git("add", "README")
        extra = []
        if name:
            extra += ["-c", f"user.name={name}"]
        if email:
            extra += ["-c", f"user.email={email}"]
        self._git(*extra, "commit", "-q", "-m", message)
        return self._git("rev-parse", "HEAD").stdout.strip()

    def _scan(self, base: str, head: str) -> int:
        cwd = os.getcwd()
        os.chdir(self.repo)
        try:
            return ps.scan_commit_range(base, head)
        finally:
            os.chdir(cwd)

    def test_clean_commit_is_ok(self):
        head = self._commit("Add a feature")
        self.assertEqual(self._scan(self.base, head), 0)

    def test_message_with_team_name_is_flagged(self):
        head = self._commit(f"Work by {joined(1, ' ')}")
        self.assertEqual(self._scan(self.base, head), 1)

    def test_author_name_is_flagged(self):
        head = self._commit("Add a feature", name=joined(1, " "))
        self.assertGreaterEqual(self._scan(self.base, head), 1)

    def test_author_local_dev_email_is_flagged(self):
        head = self._commit("Add a feature", email="helper@farmprint.local")
        self.assertGreaterEqual(self._scan(self.base, head), 1)

    def test_base_commit_itself_is_not_included(self):
        # Even if we cannot rewrite base, the range is exclusive of base.
        self.assertEqual(self._scan(self.base, self.base), 0)


class CliEnvFlags(unittest.TestCase):
    def test_branch_and_title_from_env(self):
        env = os.environ.copy()
        env["PR_HEAD_REF"] = "ci/name-scan"
        env["PR_TITLE"] = "A safe title"
        env["PR_BODY"] = "A safe body."
        proc = subprocess.run(
            [
                sys.executable,
                str(SCRIPT_DIR / "privacy_scan.py"),
                "--no-files",
                "--branch-from-env",
                "PR_HEAD_REF",
                "--pr-title-from-env",
                "PR_TITLE",
                "--pr-body-from-env",
                "PR_BODY",
            ],
            capture_output=True,
            text=True,
            env=env,
            cwd=REPO_ROOT,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)

    def test_branch_from_env_detects_name(self):
        env = os.environ.copy()
        env["PR_HEAD_REF"] = "fix/" + joined(1, "-")
        proc = subprocess.run(
            [
                sys.executable,
                str(SCRIPT_DIR / "privacy_scan.py"),
                "--no-files",
                "--branch-from-env",
                "PR_HEAD_REF",
            ],
            capture_output=True,
            text=True,
            env=env,
            cwd=REPO_ROOT,
        )
        self.assertEqual(proc.returncode, 1)
        self.assertIn("team assistant name", proc.stderr)


if __name__ == "__main__":
    unittest.main()
