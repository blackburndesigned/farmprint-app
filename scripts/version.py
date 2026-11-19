#!/usr/bin/env python3
"""FarmPrint version in its 5 files, kept in step.

  scripts/version.py show            print the version in each file
  scripts/version.py check [X.Y.Z]   exit 1 unless all 5 files agree (and equal X.Y.Z when given)
  scripts/version.py bump X.Y.Z      write X.Y.Z into all 5 files (then commit and tag vX.Y.Z)

Files: Cargo.toml ([workspace.package] version), Cargo.lock (farmprint-app),
src-tauri/tauri.conf.json, ui/package.json, ui/package-lock.json (root + packages[""]).
tauri.conf.json keeps its own "version": the installers, updater latest.json and tauri-action
release names read it, and dropping it was not verified end-to-end without a real release.
"""
import json, re, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SEMVER = re.compile(r"^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$")
WS_RE = re.compile(r'(\[workspace\.package\][^\[]*?\nversion\s*=\s*")([^"]+)(")', re.S)
LOCK_RE = re.compile(r'(\[\[package\]\]\nname = "farmprint-app"\nversion = ")([^"]+)(")')


def read_all():
    out = {}
    m = WS_RE.search((ROOT / "Cargo.toml").read_text())
    out["Cargo.toml"] = m.group(2) if m else None
    m = LOCK_RE.search((ROOT / "Cargo.lock").read_text())
    out["Cargo.lock"] = m.group(2) if m else None
    out["src-tauri/tauri.conf.json"] = json.loads((ROOT / "src-tauri/tauri.conf.json").read_text()).get("version")
    out["ui/package.json"] = json.loads((ROOT / "ui/package.json").read_text()).get("version")
    lock = json.loads((ROOT / "ui/package-lock.json").read_text())
    root_v, pkg_v = lock.get("version"), lock.get("packages", {}).get("", {}).get("version")
    out["ui/package-lock.json"] = root_v if root_v == pkg_v else f"{root_v} / {pkg_v}"
    return out


def sub_json_version(path: Path, new: str, count: int):
    # Text edit (not json.dump) so formatting and key order stay byte-identical.
    text = path.read_text()
    text2, n = re.subn(r'("version":\s*")[^"]+(")', lambda m: m.group(1) + new + m.group(2), text, count=count)
    if n != count:
        sys.exit(f"{path}: expected {count} version field(s), found {n}")
    path.write_text(text2)


def bump(new: str):
    if not SEMVER.match(new):
        sys.exit(f"not a version: {new!r} (expected X.Y.Z)")
    for name, rx in (("Cargo.toml", WS_RE), ("Cargo.lock", LOCK_RE)):
        p = ROOT / name
        text, n = rx.subn(lambda m: m.group(1) + new + m.group(3), p.read_text(), count=1)
        if n != 1:
            sys.exit(f"{name}: version field not found")
        p.write_text(text)
    sub_json_version(ROOT / "src-tauri/tauri.conf.json", new, 1)
    sub_json_version(ROOT / "ui/package.json", new, 1)
    sub_json_version(ROOT / "ui/package-lock.json", new, 2)  # root, then packages[""]


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "show"
    if cmd == "bump" and len(sys.argv) == 3:
        bump(sys.argv[2].lstrip("v"))
        cmd, want = "check", sys.argv[2].lstrip("v")
    elif cmd == "check":
        want = sys.argv[2].lstrip("v") if len(sys.argv) > 2 else None
    elif cmd == "show":
        want = None
    else:
        sys.exit(__doc__)
    found = read_all()
    for k, v in found.items():
        print(f"{k:28} {v}")
    if cmd == "check":
        vals = set(found.values())
        if None in vals or len(vals) != 1:
            sys.exit("version files disagree; run: scripts/version.py bump X.Y.Z")
        if want and vals != {want}:
            sys.exit(f"version files say {vals.pop()}, expected {want} (tag and files must match)")
        print("ok")


if __name__ == "__main__":
    main()
