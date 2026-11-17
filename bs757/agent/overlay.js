// overlay.js — Brawl Stars 70.757 iOS HUD agent.
//
// three features, all client-local:
//   1. visibility overlay  — draws enemy boxes/HP on a transparent UIView
//                            from the actor table already in RAM. Zero packets.
//   2. adaptive aim        — blends the outgoing aim vector toward the nearest
//                            valid target, inverts a jitter cone, never snaps.
//   3. dodge assist        — suppresses a configurable share of incoming damage
//                            at the local prediction step.
//
// run:   loaded by FridaGadget, or `frida -U -n laser -l agent/overlay.js`
// config: Frameworks/offsets.json (written by repack.py, resolved by scan.js)
//
// hotkeys on the overlay long-press (2s) cycle: boxes -> aim -> dodge -> off

'use strict';

const BUILD = '70.757';

// ---------------------------------------------------------------------------
// tuning — everything that changes gameplay feel lives here
// ---------------------------------------------------------------------------
const T = {
  enabled: true,

  overlay: {
    boxColor: [0.15, 1.0, 0.85, 1.0],     // rgba 0..1
    lowHpColor: [1.0, 0.25, 0.25, 1.0],
    scoreColor: [1.0, 0.95, 0.35, 1.0],
    lineWidth: 2.0,
    hpBarHeight: 4.0,
    hpBarGap: 3.0,
    showTeammates: false,
    maxEnemies: 12,
    refreshHz: 60,
    fadeBushEnemies: 0.55,
  },

  aim: {
    enabled: true,
    blend: 0.55,           // 0 = vanilla, 1 = hard lock
    jitterDeg: 1.8,        // human hand wobble, per-shot
    maxRange: 9000.0,      // tile units; ignore targets past this
    maxTurnRad: 1.22,      // ~70deg — never whip past what a thumb can do
    minAngleRad: 0.035,    // ignore targets already on-line
  },

  dodge: {
    enabled: true,
    suppressChance: 0.33,  // ≈1 in 3 hits ignored locally
    minDamage: 1,          // never eat fractional/tick damage
    cooldownMs: 420,       // no two suppressions back to back
    dropDuringBush: true,  // wider window when hidden
  },

  // touch synthesis — the aim and dodge features drive real touches instead of
  // writing command structs. Origins come from where the controls actually sit
  // on your screen; measure once and paste.
  input: {
    echo: false,
    aimOrigin: { x: 96, y: 610 },      // attack joystick rest position, portrait
    dragRadius: 78,                     // joystick travel in points
    fireOnRelease: true,                // tap-to-shoot instead of drag-hold
    moveOrigin: { x: 340, y: 610 },     // movement stick, used by dodge
    tapHoldMs: 60,
  },
};

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------
const S = {
  cfg: null,
  offs: null,
  mainBase: null,
  logicBase: null,
  overlay: null,
  pool: [],
  tags: [],
  lines: [],
  dots: [],
  radar: null,
  pen: 0,
  timer: null,
  lastSuppress: 0,
  rng: null,
  stats: { frames: 0, draws: 0, aims: 0, dodges: 0 },
  torn: false,
};

// A jailed install signs with `code_signing: required`, which makes inline
// hooking impossible — the kernel refuses writable code pages and kills the
// task. Every hook site asks this first instead of dying into a crash report.
const G = {
  get canHook() {
    try { return typeof Interceptor !== 'undefined' && !!Interceptor && !!Interceptor.attach; }
    catch (e) { return false; }
  },
};

let started = false;

// ---------------------------------------------------------------------------
// platform helpers
// ---------------------------------------------------------------------------

function NSBundlePath() {
  return ObjC.classes.NSBundle.mainBundle().bundlePath().toString();
}

function loadOffsets() {
  const candidates = [
    NSBundlePath() + '/Frameworks/offsets.json',
    NSBundlePath() + '/offsets.json',
  ];
  for (const p of candidates) {
    try {
      const raw = File.readAllText(p);
      const parsed = JSON.parse(raw);
      if (parsed.build !== BUILD) {
        console.log(`[hud] offsets.json is for ${parsed.build}, running on ${BUILD} — offsets may miss`);
      }
      return parsed;
    } catch (e) {
      /* try next */
    }
  }
  throw new Error('offsets.json not found in bundle');
}

function moduleBase(name) {
  const m = Process.findModuleByName(name);
  return m ? m.base : null;
}

// Deterministic-per-launch xorshift; a crypto RNG inside the game process is
// itself a tell, so use plain arithmetic with a time-derived seed.
function makeRng() {
  let s = (Date.now() ^ (Math.random() * 0x7fffffff)) >>> 0 || 0x9e3779b9;
  return function () {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 0x100000000;
  };
}

// ---------------------------------------------------------------------------
// actor read — one pass, fail-closed
// ---------------------------------------------------------------------------
const A = {};   // resolved absolute field offsets

// ASLR moves every allocation each launch, so a table address can never be
// baked into a file. Two paths:
//   static  — offsets.json carries module-relative values and we add the base
//   dynamic — offsets.json is null, so resolve.js measures the live process
// The dynamic path is the default build; the static one exists for when a
// version's layout is stable enough to hard-code.
function resolveFields(offs) {
  const world = offs.world || {};
  const act = offs.actor || {};
  const staticReady = world.actor_array !== null && world.actor_array !== undefined &&
    act.pos_x !== null && act.pos_x !== undefined && act.hp !== null && act.hp !== undefined;

  if (staticReady) {
    A.dynamic = false;
    A.actorArray = world.actor_array;
    A.stride = world.actor_stride || 8;
    A.posX = act.pos_x;
    A.posY = act.pos_y;
    A.team = act.team;
    A.hp = act.hp;
    A.maxHp = act.max_hp;
    A.alive = act.alive;
    A.bush = act.bush_flag;
    A.radius = act.radius;
    return;
  }

  const R = globalThis.BSResolve;
  if (!R) throw new Error('offsets.json unresolved and resolve.js not bundled');
  console.log('[hud] offsets.json empty — measuring the live process');
  const res = R.run({ hooks: false });
  if (!res.ok) throw new Error('runtime resolve failed: ' + (res.reason || 'unknown'));

  res.log.forEach(l => console.log('  ' + l));
  A.dynamic = true;
  A.tableAbs = ptr(res.actors.table.addr);
  A.stride = res.actors.table.stride;
  A.posX = res.actors.layout.pos_x;
  A.posY = res.actors.layout.pos_y;
  A.team = res.actors.layout.team;
  A.hp = res.actors.layout.hp;
  A.maxHp = null;
  A.alive = null;
  A.bush = null;
  A.radius = null;
  A.max = 64;
  A.entries = res.actors.table.entries;
  A.matrixAbs = res.matrix ? ptr(res.matrix.addr) : null;
  A.columnMajor = res.matrix ? res.matrix.columnMajor : false;
  A.hpWriteAbs = null;
  A.hpReg = null;
  A.baseReg = null;
  try {
    const hp = globalThis.BSResolve.findHpStore(A.hp, moduleBase('Scid'),
      [{ actor: A.tableAbs.readPointer() }]);
    if (hp.confirmed.length) {
      A.hpWriteAbs = ptr(hp.confirmed[0].addr);
      const parsed = Instruction.parse(A.hpWriteAbs).opStr;
      const srcM = /^(s\d+)/.exec(parsed);
      const baseM = /\[(x\d+)/.exec(parsed);
      A.hpReg = srcM ? srcM[1] : null;
      A.baseReg = baseM ? baseM[1] : null;
      console.log('[hud] hp store ' + A.hpWriteAbs + '  ' + parsed);
    }
  } catch (e) {
    console.log('[hud] hp store resolve skipped: ' + e.message);
  }
  console.log(`[hud] resolved: pos +0x${A.posX.toString(16)} hp +0x${A.hp.toString(16)} ` +
    `team ${A.team === null ? '-' : '+0x' + A.team.toString(16)} table ${A.entries} slots`);
}

function worldRoot() {
  if (A.dynamic) return A.tableAbs;
  const offs = S.offs;
  if (offs.world.root_va !== null && offs.world.root_va !== undefined) {
    return S.mainBase.add(offs.world.root_va);
  }
  let p = S.mainBase;
  const chain = offs.world.root_chain || [];
  for (let i = 0; i < chain.length; i++) {
    try {
      p = p.add(chain[i].offset).readPointer();
    } catch (e) {
      return null;
    }
    if (p.isNull()) return null;
  }
  return p;
}

function readActors() {
  const root = worldRoot();
  if (root === null) return [];
  const out = [];
  // The static path never sets A.max; without a floor the loop would read
  // `i < undefined` and return an empty list while reporting success.
  const limit = A.dynamic
    ? Math.min(A.max || 64, (A.entries || 16) + 8)
    : (A.max || 64);
  for (let i = 0; i < limit; i++) {
    let a;
    try {
      a = A.dynamic
        ? root.add(i * A.stride).readPointer()
        : root.add(A.actorArray + i * A.stride).readPointer();
    } catch (e) {
      break;
    }
    if (a.isNull()) continue;
    try {
      if (A.alive !== null && a.add(A.alive).readU8() === 0) continue;
      const team = A.team === null ? 1 : a.add(A.team).readU8();
      const hp = a.add(A.hp).readFloat();
      if (!(hp > 0) || hp > 200000) continue;
      out.push({
        ptr: a,
        team,
        hp,
        maxHp: A.maxHp !== null ? a.add(A.maxHp).readFloat() : hp,
        x: a.add(A.posX).readFloat(),
        y: a.add(A.posY).readFloat(),
        bush: A.bush !== null ? a.add(A.bush).readU8() !== 0 : false,
        radius: A.radius !== null ? a.add(A.radius).readFloat() : 300.0,
      });
    } catch (e) {
      continue;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// world -> screen
// ---------------------------------------------------------------------------
function readMatrix() {
  let base = null;
  if (A.dynamic) {
    if (!A.matrixAbs) return null;
    base = A.matrixAbs;
  } else {
    const offs = S.offs.camera;
    if (offs.view_proj_va === null || offs.view_proj_va === undefined) return null;
    base = S.mainBase.add(offs.view_proj_va);
  }
  try {
    const m = [];
    for (let i = 0; i < 16; i++) m.push(base.add(i * 4).readFloat());
    return m;
  } catch (e) {
    return null;
  }
}

// Supercell pushes row-major; w sits in the last four entries.
function worldToScreen(m, wx, wy, w, h) {
  if (!m) return null;
  const z = 0.0, one = 1.0;
  const cx = m[0] * wx + m[1] * wy + m[2] * z + m[3] * one;
  const cy = m[4] * wx + m[5] * wy + m[6] * z + m[7] * one;
  const cw = m[12] * wx + m[13] * wy + m[14] * z + m[15] * one;
  if (cw <= 0.001) return null;
  const inv = 1.0 / cw;
  return { x: (cx * inv * 0.5 + 0.5) * w, y: (1.0 - (cy * inv * 0.5 + 0.5)) * h, depth: cw };
}

// ---------------------------------------------------------------------------
// overlay — pooled UIViews, no per-frame allocation
// ---------------------------------------------------------------------------
function uiColor(rgba) {
  return ObjC.classes.UIColor.colorWithRed_green_blue_alpha_(
    rgba[0], rgba[1], rgba[2], rgba[3]
  );
}

function makeBox(w, h) {
  const v = ObjC.classes.UIView.alloc().initWithFrame_({
    origin: { x: 0, y: 0 },
    size: { width: w, height: h },
  });
  v.setBackgroundColor_(ObjC.classes.UIColor.clearColor());
  v.layer().setBorderWidth_(T.overlay.lineWidth);
  v.layer().setCornerRadius_(2.0);
  v.setUserInteractionEnabled_(false);
  v.setHidden_(true);
  return v;
}

function installOverlay() {
  const app = ObjC.classes.UIApplication.sharedApplication();
  ObjC.schedule(ObjC.mainQueue, () => {
    const keyWin = app.keyWindow();
    const scene = app.windows().objectAtIndex_(0);
    const win = keyWin || scene;
    if (!win) throw new Error('no UIWindow to attach to');
    const frame = win.bounds();
    const root = ObjC.classes.UIView.alloc().initWithFrame_(frame);
    root.setBackgroundColor_(ObjC.classes.UIColor.clearColor());
    root.setUserInteractionEnabled_(false);
    root.setOpaque_(false);
    win.addSubview_(root);
    S.overlay = root;
    console.log('[hud] overlay attached ' + frame.size.width + 'x' + frame.size.height);
  });
}

function ensurePool(n) {
  while (S.pool.length < n && S.pool.length < T.overlay.maxEnemies) {
    const box = makeBox(10, 10);
    S.overlay.addSubview_(box);
    S.pool.push(box);
  }
}

function hidePool() {
  for (const b of S.pool) b.setHidden_(true);
}

// ---- text pool -------------------------------------------------------------
// One label per enemy, created once. Text changes are the expensive part, so a
// label is only re-set when its string actually differs from last frame.
function makeTag() {
  const l = ObjC.classes.UILabel.alloc().initWithFrame_({
    origin: { x: 0, y: 0 }, size: { width: 90, height: 14 },
  });
  l.setFont_(ObjC.classes.UIFont.boldSystemFontOfSize_(10));
  l.setTextAlignment_(1);
  l.setBackgroundColor_(ObjC.classes.UIColor.clearColor());
  l.setUserInteractionEnabled_(false);
  l.setHidden_(true);
  l._bsText = null;
  return l;
}

function ensureTags(n) {
  while (S.tags.length < n && S.tags.length < T.overlay.maxEnemies) {
    const t = makeTag();
    t.setTextColor_(uiColor(T.overlay.boxColor));
    S.overlay.addSubview_(t);
    S.tags.push(t);
  }
}

function hideTags() {
  for (const t of S.tags) t.setHidden_(true);
}

function setTagText(tag, text) {
  if (tag._bsText === text) return;
  tag._bsText = text;
  tag.setText_(text);
}

// ---- line pool (aim line / trails) -----------------------------------------
// A one-pixel UIView rotated to the target angle: cheaper than CAShapeLayer and
// it never allocates a path on the render thread.
const PEN_MAX = 320;

function ensureLines(n) {
  n = Math.min(n, PEN_MAX);
  while (S.lines.length < n) {
    const v = ObjC.classes.UIView.alloc().initWithFrame_({
      origin: { x: 0, y: 0 }, size: { width: 1, height: 1 },
    });
    v.setBackgroundColor_(uiColor(T.overlay.boxColor));
    v.setUserInteractionEnabled_(false);
    v.setHidden_(true);
    S.overlay.addSubview_(v);
    S.lines.push(v);
  }
}

// Drawing without CGAffineTransform.
//
// setTransform_ takes a CGAffineTransform *by value*; handing it a ByteArray
// (or null, to reset) is a marshalling error inside the bridge, not a no-op.
// Axis-aligned shapes therefore use plain frames, and diagonals are stroked as
// a run of small square stamps — allocation-free after the first frame and no
// struct marshalling anywhere.
function penReset() { S.pen = 0; }

function penRect(x, y, w, h, color) {
  if (S.pen >= PEN_MAX) return;
  ensureLines(S.pen + 1);
  const v = S.lines[S.pen++];
  v.setFrame_({ origin: { x, y }, size: { width: Math.max(1, w), height: Math.max(1, h) } });
  v.setBackgroundColor_(color);
  v.setHidden_(false);
}

function penSegment(x0, y0, x1, y1, color, width) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy);
  if (!(len > 1)) return;
  const w = width || 1;
  // Horizontal / vertical go out as one rect; anything else is stamped.
  if (Math.abs(dy) <= 0.5) { penRect(Math.min(x0, x1), y0 - w / 2, len, w, color); return; }
  if (Math.abs(dx) <= 0.5) { penRect(x0 - w / 2, Math.min(y0, y1), w, len, color); return; }
  const step = 8;
  const n = Math.min(Math.ceil(len / step), 48);
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    penRect(x0 + dx * t - w / 2, y0 + dy * t - w / 2, w, w, color);
  }
}

function penEnd() {
  for (let i = S.pen; i < S.lines.length; i++) S.lines[i].setHidden_(true);
}

function hideLines() {
  for (const v of S.lines) v.setHidden_(true);
}


function setTrackerHz(hz) {
  const clamped = hz >= 60 ? 60 : 30;
  T.overlay.refreshHz = clamped;
  if (S.timer) { clearInterval(S.timer); S.timer = null; }
  S.timer = setInterval(frame, Math.floor(1000 / clamped));
  console.log('[hud] tracker ' + clamped + 'Hz');
  return clamped;
}

// ---------------------------------------------------------------------------
// frame
// ---------------------------------------------------------------------------
// Every draw below is gated on a registry flag. With nothing armed this
// function returns after two map lookups and touches no UIKit at all.
function frame() {
  if (S.torn || !S.overlay) return;
  S.stats.frames++;

  const F = globalThis.BSFeatures;
  const on = id => !!(F && F.flag(id));
  const anyVisual = on('esp.boxes') || on('esp.health') || on('esp.distance') ||
    on('esp.names') || on('esp.maxhp') || on('esp.aimline') || on('esp.crosshair') ||
    on('esp.radar') || on('esp.trail') || on('esp.projectiles');

  if (!T.enabled || !anyVisual) {
    if (S.pool.length) hidePool();
    if (S.tags.length) hideTags();
    if (S.lines.length) hideLines();
    return;
  }

  let m, size;
  try {
    m = readMatrix();
    const b = S.overlay.bounds();
    size = { w: b.size.width, h: b.size.height };
  } catch (e) {
    penReset(); penEnd();
    return;
  }
  if (!m) { penReset(); penEnd(); return; }

  let actors;
  try {
    actors = readActors();
  } catch (e) {
    penReset(); penEnd();
    return;
  }

  const self = actors.find(a => a.team === 0) || null;
  const enemies = actors.filter(a => a.team !== 0 || T.overlay.showTeammates);
  enemies.sort((a, b) => a.hp - b.hp);
  ensurePool(Math.min(enemies.length, T.overlay.maxEnemies));
  ensureTags(Math.min(enemies.length, T.overlay.maxEnemies));

  let i = 0;
  penReset();
  for (const e of enemies) {
    if (i >= S.pool.length) break;
    const scr = worldToScreen(m, e.x, e.y, size.w, size.h);
    const box = S.pool[i];
    const tag = S.tags[i];
    if (!scr) { box.setHidden_(true); tag.setHidden_(true); continue; }

    // Project the actor radius so the box hugs the sprite at any zoom.
    const edge = worldToScreen(m, e.x + e.radius, e.y, size.w, size.h);
    const halfW = edge ? Math.max(6, Math.abs(edge.x - scr.x)) : 14;
    const h = Math.max(16, halfW * 2);

    const lowHp = e.maxHp > 0 && e.hp / e.maxHp < 0.3;
    const col = lowHp ? T.overlay.lowHpColor : T.overlay.boxColor;
    const alpha = (e.bush && on('esp.bushfade')) ? T.overlay.fadeBushEnemies : 1.0;
    const tint = uiColor([col[0], col[1], col[2], col[3] * alpha]);

    box.setFrame_({
      origin: { x: scr.x - halfW, y: scr.y - h },
      size: { width: halfW * 2, height: h },
    });
    box.layer().setBorderColor_(tint.CGColor());
    box.layer().setBorderWidth_(on('esp.health') ? T.overlay.lineWidth : 1.0);
    box.setHidden_(!on('esp.boxes'));

    // hp bar sits under the box, width proportional to remaining health
    if (on('esp.health')) {
      box.layer().setBackgroundColor_(uiColor([col[0], col[1], col[2], 0.10]).CGColor());
    } else {
      box.layer().setBackgroundColor_(ObjC.classes.UIColor.clearColor());
    }

    let text = '';
    if (on('esp.names') && e.name) text = e.name;
    if (on('esp.maxhp')) text = (text ? text + ' ' : '') + Math.ceil(e.hp) + (e.maxHp > 0 ? '/' + Math.ceil(e.maxHp) : '');
    if (on('esp.distance') && self) {
      const d = Math.round(Math.hypot(e.x - self.x, e.y - self.y) / 100);
      text = (text ? text + ' ' : '') + d + 'm';
    }
    if (text) {
      tag.setTextColor_(tint);
      setTagText(tag, text);
      tag.setFrame_({
        origin: { x: scr.x - 45, y: scr.y - h - 15 },
        size: { width: 90, height: 14 },
      });
      tag.setHidden_(false);
    } else {
      tag.setHidden_(true);
    }

    if (on('esp.aimline') && self) {
      const me = worldToScreen(m, self.x, self.y, size.w, size.h);
      if (me) penSegment(me.x, me.y, scr.x, scr.y, tint, 1.0);
    }
    i++;
  }
  for (; i < S.pool.length; i++) S.pool[i].setHidden_(true);
  for (; i < S.tags.length; i++) S.tags[i].setHidden_(true);

  // crosshair rings the current aim target
  if (on('esp.crosshair') && self) {
    const tg = pickTarget(actors, self);
    if (tg) {
      const p = worldToScreen(m, tg.x, tg.y, size.w, size.h);
      if (p) {
        const r = 16;
        const c = uiColor(T.overlay.scoreColor);
        penSegment(p.x - r, p.y - r, p.x + r, p.y - r, c, 1.0);
        penSegment(p.x + r, p.y - r, p.x + r, p.y + r, c, 1.0);
        penSegment(p.x + r, p.y + r, p.x - r, p.y + r, c, 1.0);
        penSegment(p.x - r, p.y + r, p.x - r, p.y - r, c, 1.0);
      }
    }
  }
  penEnd();

  if (on('esp.radar')) drawRadar(actors, self, size);

  S.stats.draws++;
}

// ---- radar -----------------------------------------------------------------
// Top-right square, world units mapped to a 120pt box around the local player.
function drawRadar(actors, self, size) {
  if (!S.radar) {
    const r = ObjC.classes.UIView.alloc().initWithFrame_({
      origin: { x: size.w - 132, y: 56 }, size: { width: 120, height: 120 },
    });
    r.setBackgroundColor_(uiColor([0.05, 0.06, 0.09, 0.72]));
    r.layer().setCornerRadius_(60);
    r.layer().setBorderWidth_(1);
    r.layer().setBorderColor_(uiColor([0.15, 1.0, 0.85, 0.5]).CGColor());
    r.setUserInteractionEnabled_(false);
    S.overlay.addSubview_(r);
    S.radar = r;
  }
  S.radar.setHidden_(false);
  if (!self) return;

  const R = 56;
  const SPAN = 26000;               // world units across the radar
  let n = 0;
  for (const a of actors) {
    if (a.team === 0) continue;
    ensureDots(n + 1);
    const dx = (a.x - self.x) / SPAN;
    const dy = (a.y - self.y) / SPAN;
    const clamp = Math.max(Math.abs(dx), Math.abs(dy));
    const k = clamp > 1 ? 1 / clamp : 1;
    const dot = S.dots[n];
    dot.setFrame_({
      origin: { x: 60 + dx * k * R - 2.5, y: 60 - dy * k * R - 2.5 },
      size: { width: 5, height: 5 },
    });
    dot.setBackgroundColor_(uiColor(a.team === 0 ? T.overlay.scoreColor : T.overlay.boxColor));
    dot.setHidden_(false);
    n++;
  }
  for (; n < S.dots.length; n++) S.dots[n].setHidden_(true);
}

function ensureDots(n) {
  while (S.dots.length < n && S.dots.length < 16) {
    const d = ObjC.classes.UIView.alloc().initWithFrame_({
      origin: { x: 0, y: 0 }, size: { width: 5, height: 5 },
    });
    d.layer().setCornerRadius_(2.5);
    d.setUserInteractionEnabled_(false);
    S.radar.addSubview_(d);
    S.dots.push(d);
  }
}

// ---------------------------------------------------------------------------
// aim assist
// ---------------------------------------------------------------------------
const AIM_CHAIN = { base: null, chain: [] };

function pickTarget(actors, self) {
  if (!self) return null;
  const F = globalThis.BSFeatures;
  const on = id => !!(F && F.flag(id));
  const prio = on('aim.priority');
  const skipBush = on('aim.ignorebush');
  let best = null, bestKey = Infinity;
  for (const a of actors) {
    if (a.team === self.team) continue;
    if (a.hp <= 0) continue;
    if (skipBush && a.bush) continue;
    const dx = a.x - self.x, dy = a.y - self.y;
    const d2 = dx * dx + dy * dy;
    if (d2 > T.aim.maxRange * T.aim.maxRange) continue;
    // Distance by default; weakest-first when the user asks for it. The hp term
    // is scaled so it can only break ties between nearby targets, never pull
    // the aim across the map.
    const key = prio ? d2 * (0.35 + 0.65 * Math.min(1, a.hp / 8000)) : d2;
    if (key < bestKey) { bestKey = key; best = a; }
  }
  return best;
}

function blendAim(ax, ay, self, target) {
  const dx = target.x - self.x, dy = target.y - self.y;
  const want = Math.atan2(dy, dx);
  const have = Math.atan2(ay, ax);
  let delta = want - have;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  if (Math.abs(delta) < T.aim.minAngleRad) return null;
  if (Math.abs(delta) > T.aim.maxTurnRad) return null;

  const jitter = (S.rng() * 2 - 1) * (T.aim.jitterDeg * Math.PI / 180);
  const out = have + delta * T.aim.blend + jitter;
  const len = Math.sqrt(ax * ax + ay * ay) || 1;
  return { x: Math.cos(out) * len, y: Math.sin(out) * len };
}

// Touch-driven aim: measure the angle to the chosen target, then drive the
// attack stick to that angle with the same magnitude a thumb would use. The
// game sees a normal drag; nothing in its command buffer is edited.
function aimByTouch() {
  const input = globalThis.BSInput;
  if (!input || !T.aim.enabled) return false;
  const F = globalThis.BSFeatures;
  const on = id => !!(F && F.flag(id));
  if (!on('aim.assist') && !on('aim.soft') && !on('aim.lock')) return false;
  const blend = on('aim.lock') ? 1.0 : on('aim.soft') ? T.aim.blend : T.aim.blend * 0.7;
  const silent = on('aim.silent');
  let actors, self;
  try {
    actors = readActors();
    self = actors.find(a => a.team === 0);
  } catch (e) { return false; }
  if (!self) return false;
  const tg = pickTarget(actors, self);
  if (!tg) return false;

  const m = readMatrix();
  let dest = null;
  if (m && S.overlay) {
    const b = S.overlay.bounds();
    dest = worldToScreen(m, tg.x, tg.y, b.size.width, b.size.height);
  }
  if (!dest) return false;

  const o = T.input.aimOrigin;
  const ang = Math.atan2(dest.y - o.y, dest.x - o.x);
  // Silent mode trims the wobble, so the drag looks like a thumb adjusting
  // instead of a program snapping.
  let jitter = (S.rng() * 2 - 1) * (T.aim.jitterDeg * Math.PI / 180);
  if (silent) jitter *= 0.25;
  // The pull length carries the mode: assist nudges, soft pulls, lock commits.
  const r = T.input.dragRadius * (0.85 + S.rng() * 0.15) * (0.55 + 0.45 * blend);
  const tx = o.x + Math.cos(ang + jitter) * r;
  const ty = o.y + Math.sin(ang + jitter) * r;

  input.drag(o.x, o.y, tx, ty, 90);
  if (T.input.echo) console.log(`[aim] touch drag -> ${tx.toFixed(0)},${ty.toFixed(0)}`);
  S.stats.aims++;
  return true;
}

function installAimHook() {
  if (!G.canHook) {
    console.log('[hud] aim: Interceptor unavailable on this install — touch path only');
    return;
  }
  const va = S.offs.hooks.attack_command_va;
  if (va === null || va === undefined) {
    console.log('[hud] aim: attack_command_va unresolved — using touch synthesis only');
    return;
  }
  // Signature: x0 = command struct, floats at +0x00 (aim_x) and +0x04 (aim_y).
  const target = S.logicBase.add(va);
  try {
    Interceptor.attach(target, {
      onEnter(args) {
        if (!T.aim.enabled) return;
        this.cmd = args[0];
        this.before = { x: this.cmd.readFloat(), y: this.cmd.add(4).readFloat() };
      },
      onLeave() {
        if (!T.aim.enabled || !this.before) return;
        let self = null, actors = [];
        try {
          actors = readActors();
          self = actors.find(a => a.team === 0);
        } catch (e) { return; }
        if (!self) return;
        const tg = pickTarget(actors, self);
        if (!tg) return;
        const blended = blendAim(this.before.x, this.before.y, self, tg);
        if (!blended) return;
        // Only ever move the vector, never the magnitude the client validated.
        const len0 = Math.hypot(this.before.x, this.before.y) || 1;
        const len1 = Math.hypot(blended.x, blended.y) || 1;
        this.cmd.writeFloat(blended.x * (len0 / len1));
        this.cmd.add(4).writeFloat(blended.y * (len0 / len1));
        S.stats.aims++;
      },
    });
    console.log('[hud] aim hook live at ' + target);
  } catch (e) {
    console.log('[hud] aim hook failed: ' + e.message);
  }
}

// ---------------------------------------------------------------------------
// dodge
// ---------------------------------------------------------------------------
function shouldSuppress(dmg, now) {
  if (!T.dodge.enabled) return false;
  if (dmg < T.dodge.minDamage) return false;
  if (now - S.lastSuppress < T.dodge.cooldownMs) return false;
  return S.rng() < T.dodge.suppressChance;
}

function installDodgeHook() {
  if (!G.canHook) {
    console.log('[hud] dodge: Interceptor unavailable on this install — feature idle');
    return;
  }
  if (A.dynamic) {
    // No callable damage function on the dynamic path — the resolver hands back
    // the store instruction that writes an actor's HP instead. Intercepting the
    // store and rewriting the register skips the local subtraction the same way.
    const site = A.hpWriteAbs;
    if (!site) {
      console.log('[hud] dodge: no hp store resolved, feature idle');
      return;
    }
    try {
      Interceptor.attach(site, {
        onEnter() {
          const reg = this.hpReg;
          if (!reg) return;
          const dmg = this.context[reg];
          if (!shouldSuppress(dmg, Date.now())) return;
          // roll the stored value back to the victim's current HP
          const victim = this.context[this.baseReg];
          if (!victim) return;
          const current = victim.add(A.hp).readFloat();
          this.context[reg] = Math.fround(current);
          S.lastSuppress = Date.now();
          S.stats.dodges++;
        },
      });
      console.log('[hud] dodge hook live at ' + site + ' (hp store)');
    } catch (e) {
      console.log('[hud] dodge hook failed: ' + e.message);
    }
    return;
  }

  const va = S.offs.hooks.damage_entry_va;
  if (va === null || va === undefined) {
    console.log('[hud] dodge: damage_entry_va unresolved, feature idle');
    return;
  }
  // Signature: bool damage_apply(actor* attacker, actor* victim, int dmg)
  // Returning without chaining skips the local HP subtraction for this hit.
  // The server still owns the real number; see README "what dodge actually does".
  const target = S.logicBase.add(va);
  try {
    const original = new NativeFunction(target, 'bool', ['pointer', 'pointer', 'int']);
    Interceptor.replace(target, new NativeCallback((attacker, victim, dmg) => {
      if (shouldSuppress(dmg, Date.now())) {
        S.lastSuppress = Date.now();
        S.stats.dodges++;
        return 0;
      }
      return original(attacker, victim, dmg) ? 1 : 0;
    }, 'bool', ['pointer', 'pointer', 'int']));
    console.log('[hud] dodge hook live at ' + target);
  } catch (e) {
    console.log('[hud] dodge hook failed: ' + e.message);
  }
}

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------
function start() {
  if (started) return;
  started = true;
  S.rng = makeRng();
  S.offs = loadOffsets();
  S.mainBase = moduleBase(S.offs.modules.main);
  S.logicBase = moduleBase(S.offs.modules.logic);
  if (!S.mainBase || !S.logicBase) {
    console.log('[hud] waiting for game modules…');
    setTimeout(start, 400);
    return;
  }
  console.log(`[hud] laser ${S.mainBase}  Scid ${S.logicBase}  build ${BUILD}`);
  // The single most useful line for diagnosing a jailed install: `required`
  // means the kernel will not let us patch code, so anything that needs an
  // inline hook reports itself idle instead of faulting the task.
  try { console.log('[hud] codeSigningPolicy: ' + Process.codeSigningPolicy); }
  catch (e) { console.log('[hud] codeSigningPolicy: unknown'); }

  // Stealth first: the protective flags are the only ones that default on, and
  // they must be live before anything else touches the process.
  bindStealth();

  try {
    resolveFields(S.offs);
  } catch (e) {
    // The lobby has no battle actors, so a launch outside a match is expected
    // to fail here. Keep the UI up and keep trying; the HUD lights up the
    // moment the first actor table exists.
    console.log('[hud] ' + e.message);
    installOverlay();
    if (globalThis.BSMenu) {
      try { globalThis.BSMenu.start(globalThis.BSHUD); } catch (e2) { console.log('[menu] ' + e2.message); }
    }
    let attempts = 0;
    S.retry = setInterval(() => {
      // The resolver sweeps live memory, so a blind retry every 2 s in the
      // lobby is how a healthy app turns into a watchdog kill. Six tries, then
      // the HUD waits for a manual rpc start().
      if (++attempts > 6) {
        clearInterval(S.retry);
        S.retry = null;
        console.log('[hud] actor table not found after 6 sweeps — enter a match, then call rpc start()');
        return;
      }
      try {
        resolveFields(S.offs);
        clearInterval(S.retry);
        S.retry = null;
        console.log('[hud] actors appeared — HUD live');
        publishCaps();
        installDodgeHook();
        S.timer = setInterval(frame, Math.floor(1000 / T.overlay.refreshHz));
      } catch (e3) {
        /* still not in a match */
      }
    }, 2000);
    return;
  }
  installOverlay();
  publishCaps();
  setTimeout(() => {
    if (globalThis.BSInput) {
      try { globalThis.BSInput.probe(); } catch (e) { console.log('[input] probe failed: ' + e.message); }
    }
    installAimHook();
    installDodgeHook();
    S.timer = setInterval(frame, Math.floor(1000 / T.overlay.refreshHz));
    console.log('[hud] running at ' + T.overlay.refreshHz + 'Hz');
    if (globalThis.BSMenu) {
      try { globalThis.BSMenu.start(globalThis.BSHUD); }
      catch (e) { console.log('[menu] failed: ' + e.message); }
    }
  }, 800);
}

// Tell the registry what the resolver actually produced, so the menu can grey
// out a row instead of letting it half-enable and fault later.
function publishCaps() {
  const F = globalThis.BSFeatures;
  if (!F) return;
  // Only claims what was genuinely resolved. `projectiles`, `pickups`,
  // `tilemap` and friends stay missing until the resolver actually produces
  // them, so their rows grey out instead of enabling into a silent no-op.
  const caps = ['actors', 'matrix'];
  if (A.maxHp !== null && A.maxHp !== undefined) caps.push('maxhp');
  F.setCaps(caps);
  console.log('[hud] capabilities: ' + caps.join(', '));
}

// Every stealth flag is bound to its implementation here, once.
function bindStealth() {
  const F = globalThis.BSFeatures;
  const St = globalThis.BSStealth;
  if (!F || !St) {
    console.log('[hud] registry or stealth module missing — menu will be empty');
    return;
  }
  St.watchGlobalErrors();
  F.bind('stealth.jailbreak',
    () => St.enableJailbreakShield(true),
    () => { });
  F.bind('stealth.fingerprint',
    () => St.enableFingerprintSpoof(true),
    () => { });
  F.bind('stealth.crashguard',
    () => St.installCrashGuard(),
    () => { });
  F.bind('stealth.delayboot', () => { }, () => { });
  // apply the flags that shipped on
  for (const f of F.all()) {
    if (!f.enabled) continue;
    try { f.on && f.on(); } catch (e) { console.log('[hud] ' + f.id + ': ' + e.message); }
  }
}

function teardown() {
  S.torn = true;
  if (S.timer) { clearInterval(S.timer); S.timer = null; }
  try {
    if (globalThis.BSMenu) globalThis.BSMenu.teardown();
  } catch (e) { /* menu never mounted */ }
  try {
    Interceptor.detachAll();
    Interceptor.flush();
  } catch (e) { /* nothing attached */ }
  if (S.overlay) {
    ObjC.schedule(ObjC.mainQueue, () => {
      try { S.overlay.removeFromSuperview(); } catch (e) { /* gone */ }
      S.overlay = null;
    });
  }
  S.pool = [];
  S.tags = [];
  S.lines = [];
  S.dots = [];
  S.radar = null;
  console.log('[hud] torn down clean: ' + JSON.stringify(S.stats));
}

rpc.exports = {
  start,
  stop: teardown,
  stats: () => S.stats,
  tuning: () => T,
  aim: () => aimByTouch(),
  tap: (x, y) => globalThis.BSInput.tap(x, y),
  drag: (x0, y0, x1, y1, ms) => globalThis.BSInput.drag(x0, y0, x1, y1, ms || 120),
  set: (patch) => {
    for (const k of Object.keys(patch)) {
      if (T[k] && typeof T[k] === 'object') Object.assign(T[k], patch[k]);
    }
    return T;
  },
};

// shared handle for menu.js / input.js, mounted before boot
const BSHUD = {
  tuning: () => T,
  stats: () => S.stats,
  aim: () => aimByTouch(),
  clearOverlay: () => { if (S.pool.length) hidePool(); },
  setTracker: (hz) => setTrackerHz(hz),
  set: (patch) => {
    for (const k of Object.keys(patch)) {
      if (!T[k]) continue;
      if (typeof T[k] === 'object') Object.assign(T[k], patch[k]);
      else T[k] = patch[k];
    }
    return T;
  },
};
globalThis.BSHUD = BSHUD;

// Gadget runs this file from its constructor, before UIKit has a runloop turn
// and before the game's own modules are mapped. Touching ObjC or the engine at
// module scope is an instant launch crash, so the whole boot is deferred and
// every failure is retried instead of propagated.
function boot(attempt) {
  if (typeof ObjC === 'undefined' || !globalThis.ObjC) {
    console.error('[hud] ObjC bridge missing — rebuild with `npm run build` in bs757/agent');
    return;
  }
  try {
    start();
  } catch (e) {
    console.error(`[hud] boot ${attempt} failed: ${e.message}`);
    if (attempt < 12) setTimeout(() => boot(attempt + 1), 1000);
  }
}

setTimeout(() => boot(1), 2500);
