#!/usr/bin/env python3
"""
bundle.py — build the two scripts the gadget loads.

The agent is a set of ES modules now, not a concatenation: Frida 17 removed the
language bridges from the runtime, so `ObjC` only exists if `frida-objc-bridge`
is bundled in. That means a real bundler, and the one Frida ships is
frida-compile — which is exactly what this drives.

  build/overlay.js   the HUD the gadget self-loads at launch
  build/scan.js      resolver + scan driver, for a one-shot offset pass

  python tools/bundle.py          (needs `npm install` in bs757/agent once)
"""

from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
AGENT = ROOT / "agent"

TARGETS = [
    ("entry.js", "build/overlay.js"),
    ("scan-entry.js", "build/scan.js"),
]


def main() -> int:
    npm = shutil.which("npm")
    if npm is None:
        print("error: npm not on PATH — node 22+ is required", file=sys.stderr)
        return 2
    if not (AGENT / "node_modules").is_dir():
        print("installing agent dependencies…")
        rc = subprocess.call([npm, "install", "--no-audit", "--no-fund"], cwd=AGENT)
        if rc != 0:
            print("error: npm install failed", file=sys.stderr)
            return 2

    for src, out in TARGETS:
        cmd = [npm, "exec", "--", "frida-compile", src, "-o", out, "-c", "-S"]
        print(f"bundle      : {src} -> {out}")
        rc = subprocess.call(cmd, cwd=AGENT)
        if rc != 0:
            print(f"error: frida-compile failed for {src}", file=sys.stderr)
            return rc

    for _, out in TARGETS:
        p = AGENT / out
        if not p.is_file() or p.stat().st_size == 0:
            print(f"error: {out} was not produced", file=sys.stderr)
            return 3
        print(f"built       : {out}  ({p.stat().st_size / 1024:.0f} KB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
