// features.js — the single source of truth for what the cheat can do.
//
// Rules this file enforces so nothing has to remember them per-frame:
//
//   * EVERY feature ships OFF. A feature that is off installs no hook, opens no
//     socket, allocates nothing and is never even read by the frame loop. That
//     is the whole detection story: an off switch that is genuinely inert.
//   * Three tiers. `safe` is read-only or touch-only (nothing in the process
//     changes). `risky` writes to the process and is only reachable from the
//     panel, never from a persisted default. `server` is authoritative on
//     Supercell's side — anything here is cosmetic locally and is exactly what
//     gets an account flagged, so it loads disabled and needs an explicit arm.
//   * `needs` is a capability list. If the resolver has not produced a
//     capability, the feature refuses to enable and says which one is missing,
//     instead of half-installing and faulting on the first frame.
//
// global: BSFeatures

'use strict';

const BSFeatures = (function () {
  const KEY = 'BS757.features.v2';
  const KEY_MASTER = 'BS757.master.v1';

  // tier    — safe | risky | server
  // needs   — capability ids the engine must have resolved first
  // default — always false unless a tier-`safe` guard that protects us
  const DEFS = [
    // ---- VISUALS -----------------------------------------------------------
    { id: 'esp.boxes', cat: 'Visuals', label: 'Enemy boxes', tier: 'safe' },
    { id: 'esp.health', cat: 'Visuals', label: 'HP bars', tier: 'safe' },
    { id: 'esp.maxhp', cat: 'Visuals', label: 'HP numbers', tier: 'safe' },
    { id: 'esp.distance', cat: 'Visuals', label: 'Distance', tier: 'safe' },
    { id: 'esp.names', cat: 'Visuals', label: 'Brawler names', tier: 'safe', needs: ['names'] },
    { id: 'esp.bushfade', cat: 'Visuals', label: 'Fade in bushes', tier: 'safe' },
    { id: 'esp.turrets', cat: 'Visuals', label: 'Turrets & pets', tier: 'safe', needs: ['pets'] },
    { id: 'esp.walls', cat: 'Visuals', label: 'Destructible walls', tier: 'safe', needs: ['tilemap'] },
    { id: 'esp.projectiles', cat: 'Visuals', label: 'Projectile lines', tier: 'safe', needs: ['projectiles'] },
    { id: 'esp.impact', cat: 'Visuals', label: 'Impact markers', tier: 'safe', needs: ['projectiles'] },
    { id: 'esp.aimline', cat: 'Visuals', label: 'Line to target', tier: 'safe' },
    { id: 'esp.radar', cat: 'Visuals', label: 'Mini radar', tier: 'safe' },
    { id: 'esp.crosshair', cat: 'Visuals', label: 'Target crosshair', tier: 'safe' },
    { id: 'esp.safezone', cat: 'Visuals', label: 'Safe zone predictor', tier: 'safe', needs: ['zonedata'] },
    { id: 'esp.cubes', cat: 'Visuals', label: 'Power cube markers', tier: 'safe', needs: ['pickups'] },
    { id: 'esp.trail', cat: 'Visuals', label: 'Movement trails', tier: 'safe' },

    // ---- COMBAT ------------------------------------------------------------
    { id: 'aim.assist', cat: 'Combat', label: 'Aim assist', tier: 'safe' },
    { id: 'aim.soft', cat: 'Combat', label: 'Soft pull (thumb-like)', tier: 'safe' },
    { id: 'aim.lock', cat: 'Combat', label: 'Hard lock', tier: 'risky' },
    { id: 'aim.lead', cat: 'Combat', label: 'Projectile lead', tier: 'safe', needs: ['projectiles'] },
    { id: 'aim.silent', cat: 'Combat', label: 'Only while firing', tier: 'safe' },
    { id: 'aim.autofire', cat: 'Combat', label: 'Auto fire', tier: 'risky' },
    { id: 'aim.priority', cat: 'Combat', label: 'Low HP priority', tier: 'safe' },
    { id: 'aim.ignorebush', cat: 'Combat', label: 'Ignore hidden', tier: 'safe' },
    { id: 'combat.instantreload', cat: 'Combat', label: 'Instant reload', tier: 'risky', needs: ['reload'] },
    { id: 'combat.cooldown', cat: 'Combat', label: 'No cooldowns', tier: 'risky', needs: ['cooldown'] },
    { id: 'combat.gadget', cat: 'Combat', label: 'Free gadgets', tier: 'risky', needs: ['gadget'] },
    { id: 'combat.damagemult', cat: 'Combat', label: 'Damage x2', tier: 'server', needs: ['damage'] },
    { id: 'combat.rng', cat: 'Combat', label: 'RNG seed control', tier: 'server', needs: ['rng'] },

    // ---- MOVEMENT ----------------------------------------------------------
    { id: 'move.dodge', cat: 'Movement', label: 'Dodge assist', tier: 'safe', needs: ['projectiles'] },
    { id: 'move.dodgerate', cat: 'Movement', label: 'Dodge: wider window', tier: 'safe', needs: ['projectiles'] },
    { id: 'move.magnet', cat: 'Movement', label: 'Auto pickup', tier: 'safe', needs: ['pickups'] },
    { id: 'move.speed', cat: 'Movement', label: 'Speed hack', tier: 'risky', needs: ['velocity'] },
    { id: 'move.dash', cat: 'Movement', label: 'Dash burst', tier: 'risky', needs: ['velocity'] },
    { id: 'move.autobait', cat: 'Movement', label: 'Auto bait', tier: 'risky', needs: ['pathfinding'] },

    // ---- LOBBY / COSMETIC --------------------------------------------------
    { id: 'ui.skins', cat: 'Lobby', label: 'Show all skins', tier: 'server', needs: ['skins'] },
    { id: 'ui.stats', cat: 'Lobby', label: 'Fake win rate', tier: 'server' },
    { id: 'econ.gems', cat: 'Lobby', label: 'Resource injector', tier: 'server', needs: ['purchase'] },

    // ---- STEALTH -----------------------------------------------------------
    // Protective, not offensive: these are the ones that keep the install
    // quiet. `stealth.hidegadget` is enforced at build time by repack.py.
    { id: 'stealth.jailbreak', cat: 'Stealth', label: 'JB detection shield', tier: 'safe', def: true },
    { id: 'stealth.crashguard', cat: 'Stealth', label: 'Crash guard', tier: 'safe', def: true },
    { id: 'stealth.fingerprint', cat: 'Stealth', label: 'Spoof IDFV', tier: 'risky' },
    { id: 'stealth.delayboot', cat: 'Stealth', label: 'Late boot (quiet)', tier: 'safe', def: true },
    { id: 'net.lagsim', cat: 'Stealth', label: 'Simulate lag', tier: 'risky' },
    { id: 'net.packets', cat: 'Stealth', label: 'Packet hooks', tier: 'server', needs: ['net'] },
  ];

  const byId = new Map();
  for (const d of DEFS) {
    byId.set(d.id, Object.assign({ enabled: false, def: false, needs: [], tier: 'safe', cat: 'Misc' }, d));
  }

  const S = {
    master: false,          // the whole cheat is dormant until this is true
    caps: new Set(),        // capability ids the engine has resolved
    listeners: new Set(),   // fn(id, on) called after every change
    saved: {},
  };

  // ---- persistence --------------------------------------------------------
  function defaults() { return ObjC.classes.NSUserDefaults.standardUserDefaults(); }

  function load() {
    try {
      const raw = defaults().objectForKey_(KEY);
      if (raw) S.saved = JSON.parse(String(raw)) || {};
    } catch (e) { S.saved = {}; }
    try {
      const m = defaults().objectForKey_(KEY_MASTER);
      S.master = m ? Number(m.boolValue()) !== 0 : false;
    } catch (e) { S.master = false; }
    for (const f of byId.values()) {
      // A feature with no saved value keeps its definition default, and only
      // genuine protective flags have one. Everything else starts false.
      if (Object.prototype.hasOwnProperty.call(S.saved, f.id)) f.enabled = !!S.saved[f.id];
      else f.enabled = f.def === true;
    }
    enforceTiers();
  }

  function save() {
    const out = {};
    for (const f of byId.values()) out[f.id] = !!f.enabled;
    try {
      const d = defaults();
      d.setObject_forKey_(JSON.stringify(out), KEY);
      d.setObject_forKey_(ObjC.classes.NSNumber.numberWithBool_(S.master), KEY_MASTER);
      d.synchronize();
    } catch (e) { /* sandboxed defaults can refuse; state stays in RAM */ }
  }

  // ---- tier enforcement ---------------------------------------------------
  // A `server` feature is never left on across a launch, whatever the plist
  // says, and never comes on while the master switch is off.
  function enforceTiers() {
    for (const f of byId.values()) {
      if (!S.master && !f.def) f.enabled = false;
      if (f.tier === 'server' && f.armed !== true) f.enabled = false;
    }
  }

  // ---- capabilities -------------------------------------------------------
  function setCaps(list) {
    S.caps = new Set(list || []);
    for (const f of byId.values()) {
      if (f.enabled && !canRun(f)) {
        f.enabled = false;
        f.blocked = f.needs.filter(n => !S.caps.has(n));
      } else {
        f.blocked = null;
      }
    }
  }

  function canRun(f) { return f.needs.every(n => S.caps.has(n)); }

  function missing(f) { return f.needs.filter(n => !S.caps.has(n)); }

  // ---- public -------------------------------------------------------------
  function flag(id) {
    const f = byId.get(id);
    return !!(f && f.enabled);
  }

  function get(id) { return byId.get(id) || null; }

  function set(id, on) {
    const f = byId.get(id);
    if (!f) return false;
    const want = !!on;
    if (want) {
      if (f.tier === 'server' && f.armed !== true) {
        console.log(`[feature] ${id} is server-authoritative — arm it first`);
        return false;
      }
      if (!canRun(f)) {
        console.log(`[feature] ${id} needs unresolved: ${missing(f).join(', ')}`);
        return false;
      }
      if (!S.master) setMaster(true);
    }
    f.enabled = want;
    // Teardown runs on the same tick as the flip so a disabled risky feature
    // leaves nothing behind in the process.
    try { if (want) f.on && f.on(); else f.off && f.off(); } catch (e) {
      console.log(`[feature] ${id} ${want ? 'on' : 'off'} failed: ${e.message}`);
      f.enabled = false;
    }
    save();
    for (const l of S.listeners) { try { l(id, f.enabled); } catch (e) { /* listener */ } }
    return f.enabled;
  }

  function setMaster(on) {
    S.master = !!on;
    for (const f of byId.values()) {
      if (!S.master) {
        if (f.enabled) { try { f.off && f.off(); } catch (e) { /* already down */ } }
        f.enabled = f.def === true && f.tier === 'safe';
      }
    }
    save();
    console.log('[feature] master ' + (S.master ? 'armed' : 'disarmed'));
    return S.master;
  }

  function arm(id) {
    const f = byId.get(id);
    if (!f) return false;
    f.armed = true;
    return true;
  }

  function byCategory() {
    const out = new Map();
    for (const f of byId.values()) {
      if (!out.has(f.cat)) out.set(f.cat, []);
      out.get(f.cat).push(f);
    }
    return out;
  }

  function bind(id, on, off) {
    const f = byId.get(id);
    if (!f) return;
    f.on = on || null;
    f.off = off || null;
  }

  function onChange(fn) { S.listeners.add(fn); }

  return {
    ids: () => Array.from(byId.keys()),
    all: () => Array.from(byId.values()),
    byCategory,
    flag, get, set, setMaster, arm, bind, onChange, setCaps, missing, canRun, load, save,
    get master() { return S.master; },
  };
})();

globalThis.BSFeatures = BSFeatures;
