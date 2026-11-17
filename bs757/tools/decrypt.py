#!/usr/bin/env python3
"""
decrypt.py — FairPlay-decrypt the Brawl Stars iOS dump using a running app.

FairPlay keys never leave the device, so the only place the plaintext exists is
inside a process that already passed dyld's decryption. This tool reads those
pages back over Frida, splices them into the on-disk Mach-O, clears
LC_ENCRYPTION_INFO_64 and rebuilds the IPA.

Requirements
  - frida  (pip install frida-tools)            -> checked at start
  - a jailbroken device with com.supercell.laser installed and running
    (Dopamine / palera1n; frida-server or frida-gadget running on it)
  - the encrypted ipa sitting on disk (the scaffold; everything except __TEXT
    is already plaintext)

Usage
  python tools/decrypt.py --list
  python tools/decrypt.py --ipa ../com.supercell.laser_....ipa --out decrypted.ipa
  python tools/decrypt.py --ipa ... --out ... --device lan:192.168.1.42:27042
"""

from __future__ import annotations

import argparse
import os
import shutil
import struct
import sys
import tempfile
import zipfile
from pathlib import Path

MH_MAGIC_64 = 0xFEEDFACF
LC_SEGMENT_64 = 0x19
LC_ENCRYPTION_INFO = 0x21
LC_ENCRYPTION_INFO_64 = 0x2C

APP_DIR = "Payload/laser.app"
# Every Mach-O in the bundle that ships encrypted. The main binary and the
# Supercell logic framework are the two that matter; the rest are dylibs.
TARGETS = [
    f"{APP_DIR}/laser",
    f"{APP_DIR}/Frameworks/Scid.framework/Scid",
    f"{APP_DIR}/Frameworks/laserx.framework/laserx",
    f"{APP_DIR}/Frameworks/App.framework/App",
]


def align(v: int, a: int = 0x4000) -> int:
    return (v + a - 1) & ~(a - 1)


class MachOInfo:
    """Just enough Mach-O to find the encrypted window and its segments."""

    def __init__(self, data: bytes, name: str):
        self.name = name
        self.cryptid = 0
        self.cryptoff = 0
        self.cryptsize = 0
        self.segments: list[tuple[str, int, int, int, int]] = []
        magic = struct.unpack_from("<I", data, 0)[0]
        if magic != MH_MAGIC_64:
            raise ValueError(f"{name}: not a thin 64-bit LE Mach-O")
        ncmds, = struct.unpack_from("<I", data, 16)
        off = 32
        for _ in range(ncmds):
            cmd, size = struct.unpack_from("<II", data, off)
            if cmd == LC_SEGMENT_64:
                seg = data[off + 8:off + 24].rstrip(b"\0").decode()
                vmaddr, vmsize, fileoff, filesize = struct.unpack_from("<QQQQ", data, off + 24)
                self.segments.append((seg, vmaddr, vmsize, fileoff, filesize))
            elif cmd in (LC_ENCRYPTION_INFO, LC_ENCRYPTION_INFO_64):
                self.cryptoff, self.cryptsize, self.cryptid = struct.unpack_from("<III", data, off + 8)
            off += size


def patch_cryptid(data: bytearray) -> None:
    ncmds, = struct.unpack_from("<I", data, 16)
    off = 32
    for _ in range(ncmds):
        cmd, size = struct.unpack_from("<II", data, off)
        if cmd in (LC_ENCRYPTION_INFO, LC_ENCRYPTION_INFO_64):
            struct.pack_into("<I", data, off + 16, 0)
        off += size


def frida_session(spec: str | None):
    import frida

    if spec is None:
        try:
            return frida.get_usb_device(timeout=3)
        except Exception:
            pass
        return frida.get_local_device()
    if spec.startswith("lan:"):
        host, port = spec[4:].rsplit(":", 1)
        return frida.get_device_manager().add_remote_device(f"{host}:{port}")
    return frida.get_device(spec)


def attach_agent(device, bundle_id: str):
    """Attach to the game, spawning it through SpringBoard if it isn't running."""
    try:
        session = device.attach(bundle_id)
        return session, None
    except Exception:
        pass
    pid = device.spawn([bundle_id])
    session = device.attach(pid)
    device.resume(pid)
    return session, pid


AGENT = r"""
rpc.exports = {
  ranges: function () {
    const out = {};
    for (const name of %s) {
      const m = Process.findModuleByName(name);
      if (!m) { out[name] = null; continue; }
      out[name] = { base: m.base.toString(), size: m.size, path: m.path };
    }
    return out;
  },
  read: function (moduleName, offset, size) {
    const m = Process.findModuleByName(moduleName);
    if (!m) throw new Error('module missing: ' + moduleName);
    const p = m.base.add(offset);
    const chunk = 0x100000;
    const parts = [];
    for (let done = 0; done < size; done += chunk) {
      const n = Math.min(chunk, size - done);
      const buf = p.add(done).readByteArray(n);
      if (buf === null) throw new Error('unreadable page at ' + (offset + done));
      parts.push(new Uint8Array(buf));
    }
    let total = 0;
    for (const b of parts) total += b.length;
    const flat = new Uint8Array(total);
    let at = 0;
    for (const b of parts) { flat.set(b, at); at += b.length; }
    let s = '';
    for (let i = 0; i < flat.length; i += 0x8000) {
      s += String.fromCharCode.apply(null, flat.subarray(i, Math.min(i + 0x8000, flat.length)));
    }
    return btoa(s);
  }
};
"""


def main() -> int:
    ap = argparse.ArgumentParser(description="FairPlay-decrypt the Brawl Stars ipa")
    ap.add_argument("--ipa", required=False)
    ap.add_argument("--out", default="bs757-decrypted.ipa")
    ap.add_argument("--bundle", default="com.supercell.laser")
    ap.add_argument("--device", default=None, help="lan:HOST:PORT or a frida device id")
    ap.add_argument("--list", action="store_true", help="show frida devices and exit")
    args = ap.parse_args()

    try:
        import frida  # noqa: F401
    except ImportError:
        print("frida missing: python -m pip install frida-tools", file=sys.stderr)
        return 2

    if args.list:
        import frida
        print(f"frida {frida.__version__}")
        for d in frida.enumerate_devices():
            print(f"  {d.id:<28} {d.type:<10} {d.name}")
        try:
            usb = frida.get_usb_device(timeout=2)
            print(f"usb device: {usb.name}")
        except Exception:
            print("usb device: none")
        return 0

    if not args.ipa:
        print("--ipa required (the encrypted dump on disk)", file=sys.stderr)
        return 2
    src = Path(args.ipa)
    if not src.is_file():
        print(f"not found: {src}", file=sys.stderr)
        return 2

    import base64

    work = Path(tempfile.mkdtemp(prefix="bs757_dec_"))
    try:
        with zipfile.ZipFile(src) as z:
            z.extractall(work)

        # Which targets are actually encrypted?
        targets = []
        for rel in TARGETS:
            p = work / rel
            if not p.is_file():
                continue
            info = MachOInfo(p.read_bytes(), rel)
            if info.cryptid:
                targets.append((rel, info, p))
                print(f"encrypted : {rel.split('/')[-1]:<10} cryptoff={info.cryptoff:#x} cryptsize={info.cryptsize/1e6:.1f} MB")
            else:
                print(f"plaintext : {rel.split('/')[-1]}")
        if not targets:
            print("nothing to do — bundle is already decrypted")
            return 0

        print()
        try:
            device = frida_session(args.device)
            print(f"device    : {device.name} ({device.id})")
            session, spawned = attach_agent(device, args.bundle)
        except Exception as e:
            print(f"no usable device: {e}", file=sys.stderr)
            print("", file=sys.stderr)
            print("FairPlay keys are generated on the handset and never leave it,", file=sys.stderr)
            print("so this step needs a jailbroken device running the app:", file=sys.stderr)
            print("  1. jailbreak (Dopamine / palera1n), install com.supercell.laser", file=sys.stderr)
            print("  2. run frida-server on the phone", file=sys.stderr)
            print("  3. python tools/decrypt.py --ipa <dump>.ipa --out decrypted.ipa", file=sys.stderr)
            return 3

        try:
            script = session.create_script(AGENT % ("['laser','Scid','laserx','App']",))
            script.load()
            mods = script.exports_sync.ranges()
            print(f"modules   : { {k: (v['base'] if v else None) for k, v in mods.items()} }")

            for rel, info, path in targets:
                short = Path(rel).name
                name = "laser" if short == "laser" else short
                if not mods.get(name):
                    print(f"skip      : {name} not loaded in the target process", file=sys.stderr)
                    continue
                blob = base64.b64decode(script.exports_sync.read(name, info.cryptoff, info.cryptsize))
                if len(blob) != info.cryptsize:
                    raise RuntimeError(f"{name}: short read {len(blob)}/{info.cryptsize}")
                data = bytearray(path.read_bytes())
                data[info.cryptoff:info.cryptoff + info.cryptsize] = blob
                patch_cryptid(data)
                path.write_bytes(data)
                print(f"decrypted : {short:<10} {len(blob)/1e6:.1f} MB, cryptid -> 0")
        finally:
            try:
                if spawned:
                    device.kill(spawned)
            except Exception:
                pass

        out = Path(args.out)
        with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
            for root, _d, files in os.walk(work):
                for f in files:
                    p = Path(root) / f
                    z.write(p, p.relative_to(work).as_posix())
        print(f"\nout       : {out}  ({out.stat().st_size/1e6:.1f} MB)")
        print("verify    : python tools/repack.py --ipa " + out.name + " --check")
        print("next      : python tools/bundle.py && python tools/repack.py --ipa " + out.name + " ...")
        return 0
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
