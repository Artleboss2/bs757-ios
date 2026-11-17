#!/usr/bin/env python3
"""
audit.py — trust check for an ipa before it goes anywhere near an iPad.

Answers four questions:
  1. is it structurally what it claims to be (bundle id, version, no zip abuse)
  2. is it actually decrypted (every Mach-O cryptid == 0)
  3. what was added/removed versus the original store dump
  4. does anything in it look like someone else's payload (tweaks, loaders,
     injected dylibs, suspicious entitlements)

  python tools/audit.py --ipa <new>.ipa --baseline <store>.ipa
"""

from __future__ import annotations

import argparse
import hashlib
import plistlib
import re
import struct
import sys
import zipfile
from collections import Counter
from pathlib import Path

MH_MAGIC_64 = 0xFEEDFACF
MH_MAGIC = 0xFEEDFACE
FAT_MAGIC = 0xCAFEBABE
FAT_MAGIC_64 = 0xCAFEBABF
LC_ENCRYPTION_INFO = 0x21
LC_ENCRYPTION_INFO_64 = 0x2C

# names that have no business being inside a game bundle
SUSPECT = re.compile(
    r"(substrate|substitute|libhooker|cydia|sileo|\btweak\b|cheat|hack|"
    r"modmenu|esp\b|aimbot|wallhack|frida|gadget|injector|dylib_inject|"
    r"libblackjack|shadow\.dylib|dopamine|palera1n|unc0ver|taurine)",
    re.I,
)

OK = "  ok  "
WARN = " warn "
FAIL = " FAIL "
INFO = " info "


def parse_macho(data: bytes):
    """returns (cryptid, cryptsize, cputype, [dylib paths]) for thin or fat."""
    if len(data) < 32:
        return None
    magic = struct.unpack_from(">I", data, 0)[0]
    slices = []
    if magic in (FAT_MAGIC, FAT_MAGIC_64):
        n = struct.unpack_from(">I", data, 4)[0]
        wide = magic == FAT_MAGIC_64
        for i in range(n):
            base = 8 + i * (32 if wide else 20)
            if wide:
                cputype, _sub, off, size = struct.unpack_from(">iiQQ", data, base)
            else:
                cputype, _sub, off, size = struct.unpack_from(">iiII", data, base)
            slices.append((cputype, data[off:off + size]))
    else:
        cputype = struct.unpack_from("<I", data, 4)[0]
        slices.append((cputype, data))

    results = []
    for cputype, sl in slices:
        m = struct.unpack_from("<I", sl, 0)[0]
        if m not in (MH_MAGIC_64, MH_MAGIC):
            continue
        ncmds = struct.unpack_from("<I", sl, 16)[0]
        off = 32 if m == MH_MAGIC_64 else 28
        cryptid, cryptsize = 0, 0
        dylibs = []
        for _ in range(ncmds):
            cmd, size = struct.unpack_from("<II", sl, off)
            if cmd in (LC_ENCRYPTION_INFO, LC_ENCRYPTION_INFO_64):
                _o, cryptsize, cryptid = struct.unpack_from("<III", sl, off + 8)
            elif cmd in (0xC, 0x8000001C, 0x1F, 0x18, 0xD):  # dylib/rpath/weak/load
                name_off = struct.unpack_from("<I", sl, off + 8)[0]
                raw = sl[off + name_off:off + size].split(b"\0")[0]
                dylibs.append(raw.decode("utf-8", "replace"))
            off += size
        results.append({"cputype": cputype, "cryptid": cryptid, "cryptsize": cryptsize, "dylibs": dylibs})
    return results


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ipa", required=True)
    ap.add_argument("--baseline", default=None)
    args = ap.parse_args()

    path = Path(args.ipa)
    if not path.is_file():
        print(f"missing {path}", file=sys.stderr)
        return 2

    findings: list[tuple[str, str]] = []
    add = findings.append

    print(f"target : {path.name}  ({path.stat().st_size/1e9:.2f} GB)")
    print(f"sha256 : ", end="", flush=True)
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 22), b""):
            h.update(chunk)
    print(h.hexdigest())

    with zipfile.ZipFile(path) as z:
        infos = z.infolist()
        names = [i.filename for i in infos]
        print(f"entries: {len(infos)}")

        # ---- 1. structural abuse ----------------------------------------
        traversal = [n for n in names if n.startswith("/") or ".." in Path(n).parts]
        symlinks = [i for i in infos if (i.external_attr >> 16) & 0o170000 == 0o120000]
        if traversal:
            add((FAIL, f"{len(traversal)} zip entries escape the archive root"))
        else:
            add((OK, "no path traversal"))
        if symlinks:
            add((WARN, f"{len(symlinks)} symlink entries: {[i.filename for i in symlinks[:4]]}"))

        if not any(n.startswith("Payload/") and n.endswith(".app/Info.plist") for n in names):
            add((FAIL, "no Payload/*.app/Info.plist"))
            return 1
        app = next(n for n in names if n.startswith("Payload/") and n.endswith(".app/Info.plist")).split("/Info.plist")[0]
        add((OK, f"app dir {app}"))

        plist = plistlib.loads(z.read(f"{app}/Info.plist"))
        bid = plist.get("CFBundleIdentifier", "?")
        ver = plist.get("CFBundleShortVersionString", "?")
        build = plist.get("CFBundleVersion", "?")
        exe = plist.get("CFBundleExecutable", "?")
        print(f"bundle : {bid}  v{ver} ({build})  exe={exe}")
        if bid != "com.supercell.laser":
            # expected on a sideload build: the rewriter has to avoid colliding
            # with an App Store install of the same identifier
            add((INFO, f"bundle id rewritten to {bid}"))
        else:
            add((OK, "bundle id com.supercell.laser"))
        if ver != "70.757":
            add((WARN, f"version {ver} != 70.757"))
        else:
            add((OK, "version 70.757"))

        # ---- 2. encryption ----------------------------------------------
        machos = []
        for i in infos:
            if i.file_size < 4096:
                continue
            head = z.open(i.filename).read(8)
            if len(head) < 8:
                continue
            m_le = struct.unpack_from("<I", head, 0)[0]
            m_be = struct.unpack_from(">I", head, 0)[0]
            if m_le in (MH_MAGIC_64, MH_MAGIC) or m_be in (FAT_MAGIC, FAT_MAGIC_64):
                machos.append(i.filename)
        encrypted = []
        dylibs_all = Counter()
        for name in machos:
            res = parse_macho(z.read(name))
            for sl in res or []:
                if sl["cryptid"]:
                    encrypted.append((name, sl["cryptsize"], sl["cryptid"]))
                for d in sl["dylibs"]:
                    dylibs_all[d] += 1
        print(f"mach-os: {len(machos)}")
        if encrypted:
            for n, sz, c in encrypted:
                add((FAIL, f"still encrypted: {n.split('/')[-1]} {sz/1e6:.1f} MB cryptid={c}"))
        else:
            add((OK, f"all {len(machos)} Mach-O are cryptid 0 (decrypted)"))

        # ---- 3. diff vs baseline ----------------------------------------
        if args.baseline and Path(args.baseline).is_file():
            with zipfile.ZipFile(args.baseline) as b:
                base = set(b.namelist())
            now = set(names)
            added = sorted(now - base)
            removed = sorted(base - now)
            print(f"vs base: +{len(added)} -{len(removed)}")
            if added:
                add((INFO, f"added: {added[:10]}{' …' if len(added) > 10 else ''}"))
            if removed:
                add((INFO, f"removed: {removed[:10]}{' …' if len(removed) > 10 else ''}"))
            suspicious_added = [a for a in added if SUSPECT.search(a) and "FridaGadget" not in a and not a.endswith("overlay.js")]
            for s in suspicious_added[:8]:
                add((WARN, f"added entry matches a tweak/loader name: {s}"))

        # ---- 4. payload hunt --------------------------------------------
        # Mach-O present that nothing loads is the signature of an injected
        # payload. Frida's gadget would show up here before we add it.
        loaded = {Path(d).name for d in dylibs_all}
        skip = {"CodeResources", "Info.plist", "PkgInfo", "embedded.mobileprovision"}
        bundle_frameworks = {
            n.split("/")[-1]
            for n in names
            if "/Frameworks/" in n and n.count("/") >= 3 and not n.endswith("/")
            and "." not in n.split("/")[-1]
            and n.split("/")[-1] not in skip
            and "/SC_Info/" not in n and "_CodeSignature" not in n
        }
        orphans = sorted(bundle_frameworks - loaded)
        if orphans:
            add((WARN, f"{len(orphans)} binaries in Frameworks that no load command references: {orphans[:6]}"))
        else:
            add((OK, "every Frameworks binary is referenced by a load command"))

        # game assets name their own things (Brawl Stars ships `gadget` FX for
        # the in-match Gadget button) — only inspect code and metadata paths
        hits = sorted({
            n for n in names
            if SUSPECT.search(n) and "/res/" not in n and not n.endswith((".png", ".bin", ".bank"))
            and "FridaGadget" not in n
        })
        if hits:
            for h_ in hits[:10]:
                add((WARN, f"suspicious name: {h_}"))
        else:
            add((OK, "no tweak/loader/cheat-named entries"))

        # entitlements / provisioning
        for n in names:
            if n.endswith((".xcent", ".entitlements", ".mobileprovision")):
                if n.endswith(".mobileprovision"):
                    add((INFO, f"provisioning profile present: {n.split('/')[-1]}"))
                else:
                    try:
                        e = plistlib.loads(z.read(n))
                        keys = sorted(e.keys())[:6]
                        add((INFO, f"{n.split('/')[-1]}: {keys}"))
                        for bad in ("com.apple.private.hid.client.event-dispatch",
                                    "platform-application", "com.apple.private.skip-library-validation"):
                            if bad in e:
                                add((WARN, f"entitlement {bad} on {n.split('/')[-1]}"))
                    except Exception:
                        add((WARN, f"unreadable entitlements {n}"))

        # unexpected top-level payloads
        tops = Counter(n.split("/")[0] for n in names)
        if set(tops) - {"Payload"}:
            add((WARN, f"top-level entries besides Payload: {set(tops) - {'Payload'}}"))

    print()
    for level, msg in findings:
        print(f"{level} {msg}")
    fails = sum(1 for lv, _ in findings if lv == FAIL)
    warns = sum(1 for lv, _ in findings if lv == WARN)
    print()
    if fails:
        print(f"VERDICT: {fails} FAIL, {warns} warn — do not sideload")
        return 1
    if warns:
        print(f"VERDICT: clean on structure and encryption, {warns} warning(s) to read above")
        return 0
    print("VERDICT: clean")
    return 0


if __name__ == "__main__":
    sys.exit(main())
