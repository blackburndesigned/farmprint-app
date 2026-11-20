#!/usr/bin/env python3
"""Build the Tauri updater latest.json from a folder of .sig files.

  scripts/make_latest_json.py --assets-dir DIR --version X.Y.Z \\
      --notes-file FILE --repo owner/repo [--pub-date ISO] [--output FILE]

Matrix release jobs each used to upload their own latest.json, and the last
one to finish overwrote the rest. This script runs once after every platform
build and writes a single file with all 10 platform entries.

Required .sig files in --assets-dir (names match tauri-action on FarmPrint):

  FarmPrint_aarch64.app.tar.gz.sig
  FarmPrint_x64.app.tar.gz.sig
  FarmPrint_{version}_x64_en-US.msi.sig
  FarmPrint_{version}_x64-setup.exe.sig
  FarmPrint_{version}_amd64.AppImage.sig
  FarmPrint_{version}_amd64.deb.sig

Download URLs are https://github.com/{repo}/releases/latest/download/{file}.
--pub-date defaults to now (UTC, millisecond precision). Notes lose a single
trailing newline so a typical notes file matches the JSON notes field.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

SEMVER = re.compile(r"^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$")
REPO_RE = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
# Platform keys and the artifact each one points at, in the order the
# updater file must use (windows before linux; default keys share the msi /
# AppImage with their suffixed aliases, as in v0.9.16).
PLATFORM_FILES = (
    ("darwin-aarch64", "FarmPrint_aarch64.app.tar.gz"),
    ("darwin-aarch64-app", "FarmPrint_aarch64.app.tar.gz"),
    ("darwin-x86_64", "FarmPrint_x64.app.tar.gz"),
    ("darwin-x86_64-app", "FarmPrint_x64.app.tar.gz"),
    ("windows-x86_64", "FarmPrint_{version}_x64_en-US.msi"),
    ("windows-x86_64-msi", "FarmPrint_{version}_x64_en-US.msi"),
    ("windows-x86_64-nsis", "FarmPrint_{version}_x64-setup.exe"),
    ("linux-x86_64", "FarmPrint_{version}_amd64.AppImage"),
    ("linux-x86_64-appimage", "FarmPrint_{version}_amd64.AppImage"),
    ("linux-x86_64-deb", "FarmPrint_{version}_amd64.deb"),
)


def read_sig(path: Path) -> str:
    text = path.read_text()
    if text.endswith("\n"):
        text = text[:-1]
    if text.endswith("\r"):
        text = text[:-1]
    if not text:
        sys.exit(f"{path.name}: signature file is empty")
    return text


def utc_now_ms() -> str:
    # Same shape as tauri-action: 2026-11-20T01:38:04.525Z
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def build(assets_dir: Path, version: str, notes: str, repo: str, pub_date: str) -> dict:
    platforms = {}
    missing = []
    for key, template in PLATFORM_FILES:
        name = template.format(version=version)
        sig_path = assets_dir / f"{name}.sig"
        if not sig_path.is_file():
            missing.append(sig_path.name)
            continue
        platforms[key] = {
            "signature": read_sig(sig_path),
            "url": f"https://github.com/{repo}/releases/latest/download/{name}",
        }
    if missing:
        # Aliases share a .sig; name each missing file only once.
        missing = list(dict.fromkeys(missing))
        sys.exit("missing signature file(s): " + ", ".join(missing))
    return {
        "version": version,
        "notes": notes,
        "pub_date": pub_date,
        "platforms": platforms,
    }


def dumps(data: dict) -> str:
    # indent=2, UTF-8 (em dash, arrows), trailing newline: matches v0.9.16.
    return json.dumps(data, indent=2, ensure_ascii=False) + "\n"


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--assets-dir", required=True, type=Path)
    p.add_argument("--version", required=True)
    p.add_argument("--notes-file", required=True, type=Path)
    p.add_argument("--repo", required=True, help="owner/repo for download URLs")
    p.add_argument("--pub-date", default=None, help="ISO UTC timestamp; default is now")
    p.add_argument("--output", type=Path, help="write here instead of stdout")
    args = p.parse_args()

    version = args.version.lstrip("v")
    if not SEMVER.match(version):
        sys.exit(f"not a version: {args.version!r} (expected X.Y.Z)")
    if not REPO_RE.match(args.repo):
        sys.exit(f"not a repo: {args.repo!r} (expected owner/repo)")
    if not args.assets_dir.is_dir():
        sys.exit(f"assets dir not found: {args.assets_dir}")
    if not args.notes_file.is_file():
        sys.exit(f"notes file not found: {args.notes_file}")

    notes = args.notes_file.read_text()
    if notes.endswith("\n"):
        notes = notes[:-1]
        if notes.endswith("\r"):
            notes = notes[:-1]

    pub_date = args.pub_date or utc_now_ms()
    data = build(args.assets_dir, version, notes, args.repo, pub_date)
    text = dumps(data)
    if args.output:
        args.output.write_text(text)
        print(f"wrote {args.output} version {version} platforms {len(data['platforms'])}")
    else:
        sys.stdout.write(text)


if __name__ == "__main__":
    main()
