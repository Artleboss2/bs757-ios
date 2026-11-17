// input.js — synthesize screen input the game's own touch chain receives.
//
// Two backends, probed once at boot:
//   1  IOHIDEvent digitizer dispatch — indistinguishable from driver input.
//      Needs com.apple.private.hid.client.event-dispatch, so it only lands on
//      a jailbroken or entitled build. Probed, never assumed.
//   2  UIKit responder injection — constructed UITouch objects delivered with
//      touchesBegan/Moved/Ended:withEvent: to the key window. No entitlement,
//      so it always answers and is the floor.
//
// Either way the game sees a normal down / move stream / up sequence in its own
// coordinate space. Nothing writes into the game's command buffer.
//
// global: BSInput

'use strict';

const BSInput = (function () {
  const S = { tier: 0, client: null, dispatch: null, hidFinger: null, view: null };

  const cls = n => ObjC.classes[n];
  const fn = (addr, ret, args) => new NativeFunction(addr, ret, args);

  // Frida 17 moved global lookup off Module. bridge.js exports the shim; a
  // missing symbol has to return null here rather than throw, because every
  // caller is a capability probe.
  const exp = (mod, name) => {
    try {
      if (typeof Module.getGlobalExportByName === 'function') {
        const a = Module.getGlobalExportByName(name);
        if (a) return a;
      }
    } catch (e) { /* not global */ }
    try {
      const m = mod ? Process.findModuleByName(mod) : null;
      const a = m && m.findExportByName ? m.findExportByName(name) : null;
      if (a) return a;
    } catch (e) { /* not loaded */ }
    try {
      if (typeof Module.findExportByName === 'function') return Module.findExportByName(mod, name);
    } catch (e) { /* gone */ }
    return null;
  };

  // @package ivars on UITouch; a renamed ivar on a future iOS returns false and
  // the touch is delivered with that field at its zeroed default instead of
  // throwing out of the backend.
  function setIvar(obj, name, value) {
    try {
      const get = setIvar.get || (setIvar.get = fn(
        exp('libobjc.A.dylib', 'class_getInstanceVariable'),
        'pointer', ['pointer', 'pointer']));
      const put = setIvar.put || (setIvar.put = fn(
        exp('libobjc.A.dylib', 'object_setIvar'),
        'void', ['pointer', 'pointer', 'pointer']));
      const ivar = get(obj.class().handle, Memory.allocUtf8String(name));
      if (ivar.isNull()) return false;
      put(obj.handle, ivar, value);
      return true;
    } catch (e) {
      return false;
    }
  }

  function num(v) { const b = Memory.alloc(8); b.writeDouble(v); return b; }

  function pt(x, y) { const p = Memory.alloc(16); p.writeDouble(x); p.add(8).writeDouble(y); return p; }

  function keyWindow() {
    const app = cls('UIApplication').sharedApplication();
    const win = app.keyWindow() || (app.windows().count() > 0 ? app.windows().objectAtIndex_(0) : null);
    if (win) S.view = win;
    return S.view;
  }

  // ---- tier 1: IOHID ------------------------------------------------------
  function probeHid() {
    try {
      const create = exp('IOKit', 'IOHIDEventSystemClientCreate');
      const send = exp('IOKit', 'IOHIDEventSystemClientDispatchEvent');
      const finger = exp('IOKit', 'IOHIDEventCreateDigitizerFingerEvent');
      if (!create || !send || !finger) return false;
      const c = fn(create, 'pointer', ['pointer'])(null);
      if (c.isNull()) return false;
      S.client = c;
      S.dispatch = fn(send, 'void', ['pointer', 'pointer']);
      S.hidFinger = fn(finger, 'pointer',
        ['pointer', 'uint64', 'uint32', 'uint32', 'uint32', 'double', 'double', 'double', 'double', 'double']);
      return true;
    } catch (e) {
      return false;
    }
  }

  function hidTouch(x, y, phase) {
    const ev = S.hidFinger(null, 0, 0, 1, 1, phase, x, y, 0, 0, 1.0);
    if (ev.isNull()) return false;
    S.dispatch(S.client, ev);
    return true;
  }

  // ---- tier 2: UITouch + responder ---------------------------------------
  function makeTouch(x, y, phase) {
    const t = cls('UITouch').alloc().init();
    // UIKit has used both families across releases; setting a missing name is a
    // no-op, so both get written.
    for (const [name, val] of [
      ['m_kind', num(0)], ['_type', num(0)],
      ['m_phase', num(phase)], ['_phase', num(phase)],
      ['m_timestamp', num(Date.now() / 1000)], ['_timestamp', num(Date.now() / 1000)],
      ['m_locationInWindow', pt(x, y)], ['_locationInWindow', pt(x, y)],
      ['m_previousLocationInWindow', pt(x, y)], ['_previousLocationInWindow', pt(x, y)],
      ['m_tapCount', num(1)], ['_tapCount', num(1)],
      ['m_pathIndex', num(0)], ['_pathIdentity', num(1)],
    ]) setIvar(t, name, val);
    if (S.view) {
      setIvar(t, 'm_window', S.view.handle);
      setIvar(t, 'm_view', S.view.handle);
      setIvar(t, '_window', S.view.handle);
      setIvar(t, '_view', S.view.handle);
    }
    return t;
  }

  function responderTouch(x, y, phase) {
    if (!S.view && !keyWindow()) return false;
    try {
      const set = cls('NSSet').setWithObject_(makeTouch(x, y, phase));
      const ev = cls('UIEvent').alloc().init();
      if (phase === 0) S.view.touchesBegan_withEvent_(set, ev);
      else if (phase === 1) S.view.touchesMoved_withEvent_(set, ev);
      else S.view.touchesEnded_withEvent_(set, ev);
      return true;
    } catch (e) {
      return false;
    }
  }

  // ---- public -------------------------------------------------------------
  // phase: 0 began, 1 moved, 2 ended
  function emit(x, y, phase) {
    return S.tier === 1 ? hidTouch(x, y, phase) : responderTouch(x, y, phase);
  }

  function tap(x, y) {
    return emit(x, y, 0) && emit(x, y, 2);
  }

  function hold(x, y, ms) {
    if (!emit(x, y, 0)) return false;
    const t0 = Date.now();
    const id = setInterval(() => {
      if (Date.now() - t0 >= ms) { clearInterval(id); emit(x, y, 2); }
      else emit(x, y, 1);
    }, 16);
    return true;
  }

  function drag(x0, y0, x1, y1, ms) {
    if (!emit(x0, y0, 0)) return false;
    const steps = Math.max(2, Math.floor(ms / 16));
    let i = 0;
    const id = setInterval(() => {
      i++;
      if (i >= steps) { clearInterval(id); emit(x1, y1, 2); return; }
      const t = i / steps;
      emit(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, 1);
    }, 16);
    return true;
  }

  function probe() {
    S.tier = probeHid() ? 1 : 2;
    console.log('[input] backend tier ' + S.tier +
      (S.tier === 1 ? ' (IOHID digitizer)' : ' (UITouch responder)'));
    return S.tier;
  }

  return { probe, tap, hold, drag, emit, refreshView: keyWindow, get tier() { return S.tier; } };
})();

globalThis.BSInput = BSInput;
