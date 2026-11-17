// stealth.js — the quiet layer.
//
// Read this before assuming a jailbreak bypass is what's needed: on a
// non-jailbroken install there is no Cydia, no Sileo, no substrate, no
// jailbreak flag to hide. The app runs sandboxed and unsigned-code paths are
// already closed by `code_signing: required`. The things that actually get a
// sideloaded build noticed are different, and they're what this covers:
//
//   1. A loaded image named "FridaGadget" — renamed at build time by repack.py
//      (`--stealth-names`). Frida's own docs recommend exactly this.
//   2. A listening TCP port — avoided entirely by script interaction mode.
//   3. Interceptor's inline patches — unavailable on a jailed install, so
//      nothing to hide there either.
//   4. A constructor that runs before the app's own — mitigated by a delayed
//      boot plus resuming immediately.
//   5. A device identifier that is identical across every device you install
//      on — spoofed here, off by default.
//
// Anything that needs a hook is installed through `withHook`, which fails
// closed when Interceptor is missing instead of faulting the task.

'use strict';

const BSStealth = (function () {
  const S = { applied: [], iface: null, patched: false };

  function canHook() {
    try { return typeof Interceptor !== 'undefined' && !!Interceptor && !!Interceptor.attach; }
    catch (e) { return false; }
  }

  // ---------------------------------------------------------------- jailbreak
  // The classic checks: does a Cydia/apt path exist, does fork() return, is the
  // sandbox writable outside the container. On a sideloaded non-jailbroken
  // device the honest answers are already "no", but a tweak-installed device
  // would answer "yes" — so the shield only ever *hides*, never fakes.
  const JB_PATHS = [
    '/Applications/Cydia.app', '/Applications/Sileo.app', '/Applications/Zebra.app',
    '/Library/MobileSubstrate', '/usr/lib/libsubstrate.dylib', '/bin/bash', '/usr/sbin/sshd',
    '/etc/apt', '/private/var/lib/apt', '/var/jb', '/usr/lib/libhooker.dylib',
    '/usr/lib/libjailbreak.dylib', '/var/lib/dpkg/status', '/private/jailbreakd.pid',
    '/usr/libexec/sileo', '/.installed_unc0ver', '/.bootstrapped', '/var/binpack',
    '/usr/lib/TweakInject', '/usr/share/jailbreak', '/etc/rc.d',
  ];

  function looksJailbroken(p) {
    if (typeof p !== 'string') return false;
    return JB_PATHS.some(j => p === j || p.startsWith(j + '/') || p.includes(j + '/'));
  }

  function enableJailbreakShield(enabled) {
    if (!enabled) return false;
    if (!canHook()) {
      // Nothing to do and nothing to break: a jailed device already answers
      // every one of these paths with ENOENT.
      console.log('[stealth] jb shield: no hooks available, device is already clean');
      S.applied.push('jb-native');
      return true;
    }
    try {
      const NSFileManager = ObjC.classes.NSFileManager;
      const exists = NSFileManager['- fileExistsAtPath:'];
      const existsI = NSFileManager['- fileExistsAtPath:isDirectory:'];
      const hookOne = (method, argIdx) => {
        if (!method) return;
        Interceptor.attach(method.implementation, {
          onEnter(args) {
            try {
              const p = new ObjC.Object(args[argIdx]).toString();
              if (looksJailbroken(p)) {
                this.hide = true;
                if (argIdx === 2) args[3].writeU8(0);
              }
            } catch (e) { /* non-string path */ }
          },
          onLeave(ret) {
            if (this.hide) ret.replace(ptr(0));
          },
        });
      };
      hookOne(exists, 2);
      hookOne(existsI, 2);
      S.applied.push('jb-fm');
      console.log('[stealth] jb shield armed on NSFileManager');
      return true;
    } catch (e) {
      console.log('[stealth] jb shield failed: ' + e.message);
      return false;
    }
  }

  // ------------------------------------------------------------- fingerprint
  // IDFV is per-vendor and survives reinstalls, which is what a hardware-ban
  // lookup keys on. Spoofing it keeps a reinstall looking like a new device.
  function enableFingerprintSpoof(enabled) {
    if (!enabled) return false;
    if (!canHook()) {
      console.log('[stealth] idfv spoof needs Interceptor — skipped on this install');
      return false;
    }
    try {
      const UIDevice = ObjC.classes.UIDevice;
      const m = UIDevice['- identifierForVendor'] || UIDevice['+ identifierForVendor'];
      if (!m) return false;
      const fake = ObjC.classes.NSUUID.alloc().init();
      const str = fake.UUIDString();
      Interceptor.attach(m.implementation, {
        onLeave(ret) { ret.replace(str); },
      });
      S.applied.push('idfv');
      console.log('[stealth] idfv spoofed -> ' + str);
      return true;
    } catch (e) {
      console.log('[stealth] idfv spoof failed: ' + e.message);
      return false;
    }
  }

  // ------------------------------------------------------------- crash guard
  // A fault inside a hook must not take the process with it. The JS-side guard
  // keeps our own callbacks from throwing into the game's stack; the native
  // side is left alone deliberately, because installing a signal handler that
  // swallows SIGSEGV is how a cheat turns into a corrupt save file.
  function installCrashGuard() {
    const wrap = (fn, tag) => function () {
      try { return fn.apply(this, arguments); }
      catch (e) {
        if (S.iface) { try { S.iface.set('enabled', false); } catch (e2) { /* gone */ } }
        console.log(`[guard] ${tag} threw and was disabled: ${e.message}`);
      }
    };
    try {
      if (typeof rpc !== 'undefined' && rpc.exports && S.iface) {
        for (const k of Object.keys(rpc.exports)) {
          if (typeof rpc.exports[k] === 'function' && k !== 'stop') {
            rpc.exports[k] = wrap(rpc.exports[k], 'rpc.' + k);
          }
        }
        S.patched = true;
      }
    } catch (e) { /* no rpc surface */ }
    return true;
  }

  // A single uncaught exception inside a setTimeout used to end the agent.
  // This keeps the HUD alive and reports instead.
  function watchGlobalErrors() {
    if (typeof globalThis.__bsErrorGuard === 'boolean') return;
    globalThis.__bsErrorGuard = true;
    if (typeof globalThis.process !== 'undefined' && process.on) {
      try { process.on('uncaughtException', e => console.log('[guard] ' + (e && e.message))); } catch (e) { /* noop */ }
    }
  }

  function bindInterface(iface) { S.iface = iface; }

  function applied() { return S.applied.slice(); }
  function hookAvailable() { return canHook(); }

  return {
    enableJailbreakShield,
    enableFingerprintSpoof,
    installCrashGuard,
    watchGlobalErrors,
    bindInterface,
    applied,
    hookAvailable,
    JB_PATHS,
  };
})();

globalThis.BSStealth = BSStealth;
