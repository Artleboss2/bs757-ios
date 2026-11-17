#!/usr/bin/env python3
"""
repack.py — inject FridaGadget into a Brawl Stars 70.757 .ipa, no macOS needed.

Runs on Windows/Linux/macOS. Does the Mach-O surgery in pure Python so the only
macOS-gated step left is the signature (see sign.sh).

What it does:
  1. reads the main binary + Info.plist straight out of the .ipa
  2. refuses if the main binary is still FairPlay-encrypted (cryptid != 0)
  3. appends LC_LOAD_WEAK_DYLIB for @executable_path/Frameworks/FridaGadget.dylib
  4. appends LC_RPATH @executable_path/Frameworks
  5. thins the fat gadget to its arm64 slice
  6. writes a gadget config that is valid for a *jailed* device:
       code_signing  required    <- mandatory or the kernel kills the app
       runtime       "qjs"       <- official builds ship without V8
       interaction   script      <- self-loads the agent, no PC, no blocking
  7. drops the agent + offsets + config into Frameworks/ (and the config's
     fallback location: the app root, next to the executable)
  8. optional bundle-id rewrite so the build installs beside the store app
  9. re-zips a payload-only .ipa

Usage:
  python repack.py --ipa com.supercell.laser-70.757-Decrypted.ipa \
      --gadget FridaGadget.dylib --agent agent/build/overlay.js \
      --out ../brawlstars-hud-70.757.ipa --bundle-id com.supercell.laser.hud
"""

from __future__ import annotations

import argparse
import json
import plistlib
import shutil
import struct
import sys
import tempfile
import zipfile
from pathlib import Path

MH_MAGIC_64 = 0xFEEDFACF
FAT_MAGIC = 0xCAFEBABE
FAT_MAGIC_64 = 0xCAFEBABF
CPU_TYPE_ARM64 = 0x0100000C
LC_SEGMENT_64 = 0x19
LC_SYMTAB = 0x2
LC_LOAD_DYLIB = 0xC
LC_LOAD_WEAK_DYLIB = 0x80000018
LC_RPATH = 0x8000001C
LC_CODE_SIGNATURE = 0x1D
LC_ENCRYPTION_INFO = 0x21
LC_ENCRYPTION_INFO_64 = 0x2C
LC_BUILD_VERSION = 0x32

APP_DIR = "Payload/laser.app"
EXEC = "laser"
GADGET_NAME = "FridaGadget.dylib"
# Installed under a name with no "frida" in it when --stealth-names is on.
# Frida's own gadget docs suggest exactly this: anti-Frida checks look for a
# loaded image whose name says Frida, and the dylib can be called anything.
STEALTH_GADGET_NAME = "libSCAssetSupport.dylib"


class MachOError(RuntimeError):
    pass


def align(n: int, a: int = 8) -> int:
    return (n + a - 1) & ~(a - 1)


# ---------------------------------------------------------------------------
# fat -> arm64
# ---------------------------------------------------------------------------

def thin_arm64(data: bytes) -> bytes:
    """Return the arm64 slice of a fat Mach-O, or the input if already thin.

    A slice is self-contained: every offset inside it is relative to the slice
    start, so a straight byte copy is exactly what `lipo -thin arm64` produces.
    Halving the gadget from 62 MB to its ~30 MB arm64 slice also halves the work
    the signer has to hash and the size the installer has to push over USB.
    """
    magic = struct.unpack_from(">I", data, 0)[0]
    if magic not in (FAT_MAGIC, FAT_MAGIC_64):
        return data
    big = magic == FAT_MAGIC_64
    count = struct.unpack_from(">I", data, 4)[0]
    entry = 32 if big else 20
    slices = []
    for i in range(count):
        base = 8 + i * entry
        if big:
            cpu, sub, off, size = struct.unpack_from(">iiQQ", data, base)
            al = struct.unpack_from(">I", data, base + 24)[0]
        else:
            cpu, sub, off, size, al = struct.unpack_from(">iiIII", data, base)
        slices.append((cpu, sub, off, size))
        print(f"  slice cputype={cpu} subtype={sub} {size / 1e6:.1f} MB")
    for cpu, sub, off, size in slices:
        if cpu == CPU_TYPE_ARM64:
            out = data[off:off + size]
            if struct.unpack_from("<I", out, 0)[0] != MH_MAGIC_64:
                raise MachOError("arm64 slice is not a 64-bit Mach-O")
            return out
    raise MachOError("no arm64 slice in the fat gadget")


# ---------------------------------------------------------------------------
# load-command editor
# ---------------------------------------------------------------------------

class MachO:
    """Minimal 64-bit little-endian Mach-O load-command editor."""

    def __init__(self, path: Path):
        self.path = path
        self.data = bytearray(path.read_bytes())
        magic = struct.unpack_from("<I", self.data, 0)[0]
        if magic in (FAT_MAGIC, FAT_MAGIC_64):
            raise MachOError("fat binary — thin the arm64 slice out first")
        if magic != MH_MAGIC_64:
            raise MachOError(f"not a 64-bit LE Mach-O (magic 0x{magic:08x})")
        self.ncmds, self.sizeofcmds = struct.unpack_from("<II", self.data, 16)
        self.cmds = self._parse()

    def _parse(self):
        cmds, off = [], 32
        for _ in range(self.ncmds):
            cmd, cmdsize = struct.unpack_from("<II", self.data, off)
            if cmdsize < 8 or off + cmdsize > len(self.data):
                raise MachOError(f"corrupt load command at {off:#x}")
            cmds.append((cmd, off, cmdsize))
            off += cmdsize
        return cmds

    # ---- inspection -----------------------------------------------------
    def cryptid(self) -> int:
        for cmd, off, _ in self.cmds:
            if cmd in (LC_ENCRYPTION_INFO, LC_ENCRYPTION_INFO_64):
                return struct.unpack_from("<I", self.data, off + 16)[0]
        return 0

    def deps(self):
        out = []
        for cmd, off, size in self.cmds:
            if cmd in (LC_LOAD_DYLIB, LC_LOAD_WEAK_DYLIB):
                name_off = struct.unpack_from("<I", self.data, off + 8)[0]
                raw = bytes(self.data[off + name_off:off + size]).split(b"\0")[0]
                out.append(raw.decode("utf8", "replace"))
        return out

    def rpaths(self):
        out = []
        for cmd, off, size in self.cmds:
            if cmd == LC_RPATH:
                name_off = struct.unpack_from("<I", self.data, off + 8)[0]
                raw = bytes(self.data[off + name_off:off + size]).split(b"\0")[0]
                out.append(raw.decode("utf8", "replace"))
        return out

    def has_dylib(self, name: str) -> bool:
        needle = name.encode()
        for cmd, off, size in self.cmds:
            if cmd in (LC_LOAD_DYLIB, LC_LOAD_WEAK_DYLIB):
                name_off = struct.unpack_from("<I", self.data, off + 8)[0]
                raw = bytes(self.data[off + name_off:off + size]).split(b"\0")[0]
                if raw == needle:
                    return True
        return False

    def header_slack(self) -> int:
        """Bytes between end of load commands and first section content."""
        first = None
        for cmd, off, size in self.cmds:
            if cmd != LC_SEGMENT_64:
                continue
            nsects = struct.unpack_from("<I", self.data, off + 64)[0]
            sect = off + 72
            for _ in range(nsects):
                file_off = struct.unpack_from("<I", self.data, sect + 48)[0]
                if file_off and (first is None or file_off < first):
                    first = file_off
                sect += 80
        if first is None:
            raise MachOError("no sections found")
        return first - (32 + self.sizeofcmds)

    # ---- mutation -------------------------------------------------------
    def _append(self, blob: bytes) -> None:
        at = 32 + self.sizeofcmds
        if len(blob) > self.header_slack():
            raise MachOError(f"no room for a {len(blob)}-byte load command")
        self.data[at:at + len(blob)] = blob
        self.sizeofcmds += len(blob)
        self.ncmds += 1
        struct.pack_into("<II", self.data, 16, self.ncmds, self.sizeofcmds)
        self.cmds = self._parse()

    def add_dylib(self, path: str, weak: bool = True) -> None:
        if self.has_dylib(path):
            return
        name = path.encode() + b"\0"
        name_off = 24
        size = align(name_off + len(name))
        # Weak, not hard: a hard LC_LOAD_DYLIB turns any gadget init failure
        # into a dyld abort, which is indistinguishable from "the app crashes on
        # launch". Weak degrades to "game runs, cheat absent".
        cmd = LC_LOAD_WEAK_DYLIB if weak else LC_LOAD_DYLIB
        blob = struct.pack("<IIIIII", cmd, size, name_off, 2, 0x10000, 0x10000)
        blob += name.ljust(size - name_off, b"\0")
        self._append(blob)

    def add_rpath(self, path: str) -> None:
        name = path.encode() + b"\0"
        size = align(12 + len(name))
        blob = struct.pack("<III", LC_RPATH, size, 12)
        blob += name.ljust(size - 12, b"\0")
        self._append(blob)

    def reserve_signature_space(self, headroom: int = 0x400000) -> int:
        """Grow LC_CODE_SIGNATURE so a re-signer has room.

        Zeroing the datasize looks tidy but leaves the signer nothing to write
        into: iloader then fails with "encoded signature exceeded reserved
        LC_CODE_SIGNATURE size". Instead the blob keeps its offset, gains
        `headroom` bytes of zero padding at the end of the file, and __LINKEDIT
        grows to cover it.
        """
        sig = next(((cmd, off, size) for cmd, off, size in self.cmds if cmd == LC_CODE_SIGNATURE), None)
        if sig is None:
            raise MachOError("no LC_CODE_SIGNATURE — nothing to reserve")
        _, off, _ = sig
        dataoff, datasize = struct.unpack_from("<II", self.data, off + 8)
        new_size = datasize + headroom
        need = dataoff + new_size
        if len(self.data) < need:
            self.data.extend(b"\0" * (need - len(self.data)))
        else:
            new_size = min(new_size, len(self.data) - dataoff)
        struct.pack_into("<II", self.data, off + 8, dataoff, new_size)

        for cmd, seg_off, _ in self.cmds:
            if cmd != LC_SEGMENT_64:
                continue
            seg = bytes(self.data[seg_off + 8:seg_off + 24]).rstrip(b"\0")
            if seg != b"__LINKEDIT":
                continue
            vmaddr, vmsize, foff, fsize = struct.unpack_from("<QQQQ", self.data, seg_off + 24)
            grown = max(fsize, dataoff + new_size)
            struct.pack_into("<Q", self.data, seg_off + 32, align(grown, 0x4000))
            struct.pack_into("<Q", self.data, seg_off + 48, grown)
            break
        return new_size

    def save(self) -> None:
        self.path.write_bytes(self.data)


# ---------------------------------------------------------------------------
# gadget config
# ---------------------------------------------------------------------------

def script_config(agent_name: str) -> dict:
    """Config for a jailed, self-loading install.

    Every key here is load-bearing:
      code_signing required  — the documented switch that lets Gadget run on a
                               jailed device with no debugger attached. Left at
                               `optional`, Gadget assumes it may write code
                               pages, the kernel disagrees, and the app dies at
                               launch.
      runtime "qjs"          — a STRING. Official Frida binaries are built
                               without V8 (since 14.0), so asking for v8 aborts.
      interaction script     — runs our agent automatically; no frida client on
                               a PC, no blocked main thread.
      on_change ignore       — no file watching inside the sandbox.
    No `log.file`: a sandboxed app cannot write /tmp, and a path it cannot open
    is noise at best.
    """
    return {
        "interaction": {
            "type": "script",
            "path": agent_name,
            "on_change": "ignore",
        },
        "runtime": "qjs",
        "code_signing": "required",
        "teardown": "minimal",
    }


def listen_config(port: int) -> dict:
    """Manual-attach mode. Kept for offset work; not the shipping build."""
    return {
        "interaction": {
            "type": "listen",
            "address": "127.0.0.1",
            "port": port,
            "on_port_conflict": "pick-next",
            # `wait` would freeze the app at the splash until a client connects.
            "on_load": "resume",
        },
        "runtime": "qjs",
        "code_signing": "required",
        "teardown": "minimal",
    }


# ---------------------------------------------------------------------------
# app bundle surgery
# ---------------------------------------------------------------------------

def patch_binary(binary: Path, install_path: str) -> MachO:
    mo = MachO(binary)
    if mo.cryptid():
        raise MachOError(
            "main binary is FairPlay-encrypted (LC_ENCRYPTION_INFO cryptid=1). "
            "The __TEXT segment is ciphertext; injection cannot work on it. "
            "Decrypt first (see README: decrypting the dump) and re-run."
        )
    slack = mo.header_slack()
    needed = align(24 + len(install_path) + 1) + align(12 + len("@executable_path/Frameworks") + 1)
    if slack < needed:
        raise MachOError(f"only {slack} bytes of header slack, need {needed}")
    mo.add_dylib(install_path, weak=True)
    # Compare against the actual LC_RPATH list: the gadget's own install path
    # contains "@executable_path/Frameworks", so a substring test on the
    # dependency list always matched and the rpath was never added.
    if "@executable_path/Frameworks" not in mo.rpaths():
        mo.add_rpath("@executable_path/Frameworks")
    reserved = mo.reserve_signature_space(0x400000)
    print(f"signature   : {reserved / 1e6:.1f} MB reserved in __LINKEDIT")
    mo.save()
    return mo


def repack(args: argparse.Namespace) -> int:
    src = Path(args.ipa)
    if not src.is_file():
        print(f"error: {src} not found", file=sys.stderr)
        return 2
    if not args.check and not Path(args.gadget).is_file():
        print(f"error: gadget dylib {args.gadget} not found", file=sys.stderr)
        return 2

    work = Path(tempfile.mkdtemp(prefix="bs757_"))
    try:
        binary = work / EXEC
        with zipfile.ZipFile(src) as zsrc:
            names = set(zsrc.namelist())
            exe_name = f"{APP_DIR}/{EXEC}"
            info_name = f"{APP_DIR}/Info.plist"
            if exe_name not in names:
                print(f"error: {exe_name} missing inside the ipa", file=sys.stderr)
                return 2
            if info_name not in names:
                print(f"error: {info_name} missing inside the ipa", file=sys.stderr)
                return 2
            binary.write_bytes(zsrc.read(exe_name))
            plist_bytes = zsrc.read(info_name)

        mo = MachO(binary)
        print(f"binary      : {binary.name}  {binary.stat().st_size / 1e6:.2f} MB")
        print(f"cryptid     : {mo.cryptid()}  {'ENCRYPTED' if mo.cryptid() else 'decrypted'}")
        print(f"header slack: {mo.header_slack()} bytes")
        if mo.cryptid():
            print("", file=sys.stderr)
            print("STOP: FairPlay ciphertext. Decrypt the dump first.", file=sys.stderr)
            return 3

        if args.check:
            print("check ok — binary is patchable")
            return 0

        # 1. Info.plist: bundle id rewrite + the keys a listening gadget needs
        info = plistlib.loads(plist_bytes)
        original_id = info.get("CFBundleIdentifier")
        if args.bundle_id:
            info["CFBundleIdentifier"] = args.bundle_id
            print(f"bundle id   : {original_id} -> {args.bundle_id}")
        # iOS 14+ refuses a 0.0.0.0 bind without this string, and refuses the
        # Bonjour browse without the service list. Harmless in script mode.
        info.setdefault(
            "NSLocalNetworkUsageDescription",
            "Allows the local debugging bridge to reach this device on your network.",
        )
        info.setdefault("NSBonjourServices", ["_frida._tcp.", "_frida._udp."])
        print(f"version     : {info.get('CFBundleVersion')}")
        if info.get("CFBundleVersion") != args.expect_version:
            print(
                f"warning: expected {args.expect_version}, bundle says "
                f"{info.get('CFBundleVersion')} — offsets.json is version-locked",
                file=sys.stderr,
            )
        plist_bytes = plistlib.dumps(info)

        # 2. stale signatures and FairPlay metadata are dropped during the copy
        drop_markers = ("_CodeSignature/", "SC_Info/")
        print("removed     : _CodeSignature/ + SC_Info/ entries")

        # 3. inject
        gadget_file = STEALTH_GADGET_NAME if args.stealth_names else GADGET_NAME
        # Gadget looks for "<binary name minus .dylib>.config" — FridaGadget.dylib
        # -> FridaGadget.config — so a renamed gadget needs a renamed config.
        config_file = gadget_file[:-len(".dylib")] + ".config"
        install_path = "@executable_path/Frameworks/" + gadget_file
        patch_binary(binary, install_path)
        print(f"mach-o      : LC_LOAD_WEAK_DYLIB {gadget_file} + LC_RPATH added")

        # 4. gadget payload — staged in memory, written as new zip entries
        fw_name = f"{APP_DIR}/Frameworks"
        agent_name = Path(args.agent).name
        agent_bytes = Path(args.agent).read_bytes()

        print("gadget      : thinning fat binary to arm64")
        gadget_bytes = thin_arm64(Path(args.gadget).read_bytes())
        print(f"gadget      : {gadget_bytes.__len__() / 1e6:.1f} MB arm64 slice")

        config = listen_config(args.port) if args.mode == "listen" else script_config(agent_name)
        config_bytes = (json.dumps(config, indent=2) + "\n").encode()
        print(f"config      : interaction={config['interaction']['type']} "
              f"runtime={config['runtime']} code_signing={config['code_signing']}")

        added: dict[str, bytes] = {
            # Gadget looks for "<name>.config" beside itself, and ALSO in the
            # parent directory when it sits in one called "Frameworks". Both
            # copies are written so neither lookup can miss.
            f"{fw_name}/{gadget_file}": gadget_bytes,
            f"{fw_name}/{config_file}": config_bytes,
            f"{APP_DIR}/{config_file}": config_bytes,
            f"{fw_name}/{agent_name}": agent_bytes,
            f"{APP_DIR}/{agent_name}": agent_bytes,
        }
        if args.stealth_names:
            print(f"stealth     : gadget installed as {gadget_file}")
        # the one-shot scanner ships beside the agent so a bad resolve can be
        # diagnosed from the device without a second build
        scan_bundle = Path(args.agent).parent / "scan.js"
        if scan_bundle.is_file():
            added[f"{fw_name}/scan.js"] = scan_bundle.read_bytes()
            print("scanner     : Frameworks/scan.js bundled")
        offsets = Path(args.agent).parent / "offsets.json"
        if not offsets.is_file():
            offsets = Path(args.agent).parent.parent / "offsets.json"
        if offsets.is_file():
            added[f"{fw_name}/offsets.json"] = offsets.read_bytes()
            added[f"{APP_DIR}/offsets.json"] = offsets.read_bytes()
            print(f"offsets     : {offsets.name} bundled next to the agent")

        # 5. stream the archive: substitute the patched entries, copy the rest raw
        replaced = {
            exe_name: binary.read_bytes(),
            info_name: plist_bytes,
            **added,
        }
        out = Path(args.out)
        written = 0
        with zipfile.ZipFile(src) as zsrc, zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=1) as zdst:
            for info_e in zsrc.infolist():
                name = info_e.filename
                if name in replaced or any(m in name for m in drop_markers):
                    continue
                if name.endswith("/"):
                    continue
                with zsrc.open(info_e, "r") as fsrc, zdst.open(name, "w") as fdst:
                    shutil.copyfileobj(fsrc, fdst, 1 << 20)
                written += 1
            for name, data in replaced.items():
                zdst.writestr(name, data, compress_type=zipfile.ZIP_DEFLATED, compresslevel=6)
                written += 1
        print(f"out         : {out}  ({out.stat().st_size / 1e6:.2f} MB, {written} entries)")
        print("next        : sign + install, then just launch the game — no PC needed")
        return 0
    finally:
        shutil.rmtree(work, ignore_errors=True)


def main() -> int:
    ap = argparse.ArgumentParser(description="Inject FridaGadget into a Brawl Stars ipa")
    ap.add_argument("--ipa", required=True)
    ap.add_argument("--gadget", default="FridaGadget.dylib")
    ap.add_argument("--agent", default="agent/build/overlay.js")
    ap.add_argument("--mode", choices=("script", "listen"), default="script")
    ap.add_argument("--port", type=int, default=27042)
    ap.add_argument("--out", default="bs757-hud.ipa")
    ap.add_argument("--bundle-id", default=None)
    ap.add_argument("--expect-version", default="70.757")
    ap.add_argument("--check", action="store_true", help="inspect only, change nothing")
    ap.add_argument(
        "--stealth-names", action="store_true",
        help="install the gadget under an innocuous name so no loaded image says 'Frida'",
    )
    return repack(ap.parse_args())


if __name__ == "__main__":
    try:
        sys.exit(main())
    except MachOError as e:
        print(f"mach-o: {e}", file=sys.stderr)
        sys.exit(4)
