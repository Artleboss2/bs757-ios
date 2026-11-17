// bridge.js — the one module that has to run before every other module.
//
// Frida 17 stopped bundling the language bridges into the runtime: `ObjC` is no
// longer a global by itself. The gadget therefore needs this bundled and
// imported first, or every UIKit call in menu.js/overlay.js/input.js throws
// ReferenceError on the very first frame.
//
// Same release also moved global symbol lookup off Module
// (findExportByName -> getGlobalExportByName), so the shim lands here too and
// the other modules import it instead of touching Module directly.

import ObjC from 'frida-objc-bridge';

globalThis.ObjC = ObjC;

// mod is the library the symbol is expected in, or null for a global lookup.
// Returns null instead of throwing: every caller here is a probe.
export function exp(mod, name) {
  try {
    if (typeof Module.getGlobalExportByName === 'function') {
      const a = Module.getGlobalExportByName(name);
      if (a) return a;
    }
  } catch (e) {
    /* not a global export */
  }
  try {
    const m = mod ? Process.findModuleByName(mod) : null;
    if (m && typeof m.findExportByName === 'function') return m.findExportByName(name);
  } catch (e) {
    /* module not loaded */
  }
  try {
    if (typeof Module.findExportByName === 'function') return Module.findExportByName(mod, name);
  } catch (e) {
    /* removed in this build */
  }
  return null;
}

// Interceptor needs writable code pages. On a jailed device signing is
// `required`, which makes the whole API unavailable — probes must ask first.
export const canHook = (() => {
  try {
    return typeof Interceptor !== 'undefined' && !!Interceptor && !!Interceptor.attach;
  } catch (e) {
    return false;
  }
})();
