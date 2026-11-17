// resolve.js — find the live addresses the HUD needs, at runtime.
//
// No static analysis, no decrypted file on disk: everything here is measured
// against the running process, so it survives ASLR and works on the first
// launch after install. Results are module-relative, which is what makes them
// reusable across launches.
//
// What it finds:
//   actors   — pointer table + struct layout (pos/team/hp), by shape not by name
//   matrix   — 4x4 float view-projection that projects the actors sanely
//   hp write — the store instruction that lands on an actor's HP field
//
// global: BSResolve
//   BSResolve.run({timeBudgetMs}) -> { actors, matrix, hpWrite, ... }

'use strict';

const BSResolve = (function () {
  const C = {
    mapHalfExtent: 20000.0,   // world units from map centre; Brawl Stars arena
    structSpan: 0x240,        // bytes of a candidate struct we inspect
    maxStructsPerRange: 40000,
    minActors: 2,             // a lone float pair is noise, two ordered ones is a table
    matrixBlock: 64,          // 16 x float32
    hpScanLimit: 60000,       // str-store candidates we are willing to parse

    // Hard ceilings. A Brawl Stars process maps well over a gigabyte; sweeping
    // every read-write range without a budget takes minutes on QJS and takes
    // the app down with the iOS watchdog. The sweep stops at whichever limit
    // lands first and reports what it managed to cover.
    sweepByteBudget: 64 << 20,
    slotBudget: 900000,
    maxRangeBytes: 24 << 20,
    matrixByteBudget: 64 << 20,
  };

  const out = { log: [] };
  const note = m => { out.log.push(m); };

  const inMap = v => v > -C.mapHalfExtent && v < C.mapHalfExtent;
  const looksCoord = v => inMap(v) && Math.abs(v) > 1e-3 && Number.isFinite(v);

  function moduleOf(addr) {
    for (const m of Process.enumerateModules()) {
      if (addr.compare(m.base) >= 0 && addr.compare(m.base.add(m.size)) < 0) return m;
    }
    return null;
  }

  function readable(p) {
    try { p.readU8(); return true; } catch (e) { return false; }
  }

  // -------------------------------------------------------------------------
  // 1. actor discovery — shape only
  // -------------------------------------------------------------------------
  // A battle actor holds its world position as two adjacent floats. Sweep every
  // aligned pointer slot in writable memory, then look inside the pointee for
  // that float pair. Nothing here depends on knowing any field offset.
  function findActorShapes() {
    const byOffset = new Map();   // posOffset -> [ {slot, actor, x, y} ]
    let slots = 0;
    let bytes = 0;
    let scanned = 0;
    let capped = false;

    for (const r of Process.enumerateRanges('rw-')) {
      if (r.size < 0x1000) continue;
      // Anonymous guard pages and the big asset heaps are never actor tables,
      // and one of them alone would eat the whole budget.
      if (r.size > C.maxRangeBytes) continue;
      if (bytes + r.size > C.sweepByteBudget) { capped = true; break; }
      bytes += r.size;
      scanned++;
      const end = r.base.add(r.size);
      let perRange = 0;
      for (let slot = r.base; slot.compare(end) < 0; slot = slot.add(8)) {
        slots++;
        if (slots > C.slotBudget) { capped = true; break; }
        let p;
        try { p = slot.readPointer(); } catch (e) { break; }
        if (p.isNull() || p.compare(0x10000) < 0) continue;
        if (moduleOf(p)) continue;                    // code/rodata, not a struct
        let head;
        try { head = p.readByteArray(C.structSpan); } catch (e) { continue; }
        if (!head) continue;
        const f = new Float32Array(head);
        for (let i = 0; i + 1 < f.length; i++) {
          if (!looksCoord(f[i]) || !looksCoord(f[i + 1])) continue;
          const off = i * 4;
          if (!byOffset.has(off)) byOffset.set(off, []);
          const arr = byOffset.get(off);
          if (arr.length > C.maxStructsPerRange) continue;
          arr.push({ slot, actor: p, x: f[i], y: f[i + 1] });
        }
        if (++perRange > C.maxStructsPerRange) break;
      }
    }
    note(`actor sweep: ${scanned} ranges / ${(bytes / 1e6).toFixed(1)} MB / ` +
      `${slots} slots, ${byOffset.size} candidate position offsets` +
      (capped ? ' (budget reached — partial)' : ''));
    return byOffset;
  }

  // The position offset that produces many hits is the real one; a random float
  // pair appears a handful of times, a live actor table dozens.
  function pickPositionOffset(byOffset) {
    let best = null;
    for (const [off, hits] of byOffset) {
      const uniq = new Set(hits.map(h => h.actor.toString())).size;
      if (uniq < C.minActors) continue;
      if (!best || uniq > best.uniq) best = { off, hits, uniq };
    }
    return best;
  }

  // Consecutive 8-byte slots pointing at structs of the same shape = the array.
  function findTable(hits) {
    const sorted = hits.slice().sort((a, b) => a.slot.compare(b.slot));
    let best = { run: 0, base: null, stride: 8 };
    let run = 1, start = 0;
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].slot.sub(sorted[i - 1].slot).toInt32() === 8) {
        run++;
      } else {
        if (run > best.run) best = { run, base: sorted[start].slot, stride: 8 };
        run = 1; start = i;
      }
    }
    if (run > best.run) best = { run, base: sorted[start].slot, stride: 8 };
    if (best.run < C.minActors) return null;
    return { array: best.base, stride: best.stride, count: best.run };
  }

  // Within a confirmed actor, HP is the other plausible float; team is a small
  // byte. Verify against every sampled actor so one lucky field can't win.
  function inferLayout(sample) {
    if (sample.length < C.minActors) return null;
    const blobs = sample.slice(0, 8).map(a => {
      try { const b = a.actor.readByteArray(C.structSpan); return b ? new Float32Array(b) : null; } catch (e) { return null; }
    }).filter(Boolean);
    if (blobs.length < C.minActors) return null;

    const hpVotes = new Map();
    for (const f of blobs) {
      for (let i = 0; i < f.length; i++) {
        const v = f[i];
        if (!(v > 0 && v <= 200000)) continue;
        hpVotes.set(i * 4, (hpVotes.get(i * 4) || 0) + 1);
      }
    }
    const posOff = sample[0].posOff;
    let hpOff = null, bestVotes = 0;
    for (const [off, votes] of hpVotes) {
      if (off === posOff || off === posOff + 4) continue;
      if (votes > bestVotes && votes >= blobs.length - 1) { hpOff = off; bestVotes = votes; }
    }
    if (hpOff === null) return null;

    // team: a byte in 0..2 that is stable across actors and small
    let teamOff = null;
    const raw = sample.slice(0, 8).map(a => {
      try { const b = a.actor.readByteArray(C.structSpan); return b ? new Uint8Array(b) : null; } catch (e) { return null; }
    }).filter(Boolean);
    for (let off = 0; off < C.structSpan - 1; off++) {
      if (raw.every(b => b[off] <= 2) && raw.some(b => b[off] !== 0) && raw.every(b => b[off] === raw[0][off])) {
        teamOff = off; break;
      }
    }

    return {
      pos_x: posOff,
      pos_y: posOff + 4,
      hp: hpOff,
      team: teamOff,
      max_hp: null,
      alive: null,
      bush_flag: null,
      radius: null,
    };
  }

  // -------------------------------------------------------------------------
  // 2. view-projection matrix
  // -------------------------------------------------------------------------
  // Instead of pattern-matching the upload instructions, score candidate 4x4
  // float blocks by whether they project the actors we already found onto a
  // screen-sized rectangle. A real matrix wins by a wide margin.
  function findMatrix(actors, screen) {
    const { w, h } = screen;
    const pts = actors.slice(0, 10).map(a => ({ x: a.x, y: a.y }));
    const score = (f, base, columnMajor) => {
      let hits = 0;
      for (const p of pts) {
        let cx, cy, cw;
        if (columnMajor) {
          cx = f[0] * p.x + f[4] * p.y + f[12];
          cy = f[1] * p.x + f[5] * p.y + f[13];
          cw = f[3] * p.x + f[7] * p.y + f[15];
        } else {
          cx = f[0] * p.x + f[1] * p.y + f[3];
          cy = f[4] * p.x + f[5] * p.y + f[7];
          cw = f[12] * p.x + f[13] * p.y + f[15];
        }
        if (!(cw > 1e-6)) continue;
        const sx = (cx / cw * 0.5 + 0.5) * w;
        const sy = (1 - (cy / cw * 0.5 + 0.5)) * h;
        if (sx > -w * 0.5 && sx < w * 1.5 && sy > -h * 0.5 && sy < h * 1.5) hits++;
      }
      return hits;
    };

    let best = null;
    let budget = C.matrixByteBudget;
    for (const r of Process.enumerateRanges('rw-')) {
      if (r.size < C.matrixBlock) continue;
      if (budget <= 0) break;
      const n = Math.min(r.size, 8 << 20);
      budget -= n;
      let buf;
      try { buf = r.base.readByteArray(n); } catch (e) { continue; }
      if (!buf) continue;
      const f = new Float32Array(buf);
      for (let i = 0; i + 16 <= f.length; i += 4) {
        const m15 = f[i + 15];
        if (!(m15 > 0.01 && m15 < 4)) continue;         // w term, near 1 in practice
        const sub = f.subarray(i, i + 16);
        for (const columnMajor of [true, false]) {
          const s = score(sub, r.base, columnMajor);
          if (s >= Math.min(3, pts.length) && (!best || s > best.score)) {
            best = { score: s, addr: r.base.add(i * 4), columnMajor, w, h };
          }
        }
      }
    }
    if (best) note(`matrix: ${best.score}/${pts.length} actors project in-bounds, ${best.columnMajor ? 'column' : 'row'} major`);
    return best;
  }

  // -------------------------------------------------------------------------
  // 3. the HP write
  // -------------------------------------------------------------------------
  // Any store that lands on the HP field is a damage site. Scan for the whole
  // STR-immediate float family (top byte 0xBD), parse each hit, keep the ones
  // whose displacement is the HP offset, then validate by hooking.
  function findHpStore(hpOff, logicModule, knownActors) {
    const hits = [];
    const ranges = logicModule
      ? [{ base: logicModule.base, size: logicModule.size }]
      : Process.enumerateRanges('r-x');

    for (const r of ranges) {
      Memory.scan(r.base, r.size, '?? ?? ?? BD', {
        onMatch(addr) {
          if (hits.length > C.hpScanLimit) return 'stop';
          hits.push(addr);
        },
        onError() {},
      });
    }
    note(`str-float stores: ${hits.length}`);

    const candidates = [];
    for (const addr of hits) {
      let insn;
      try { insn = Instruction.parse(addr); } catch (e) { continue; }
      const op = insn.opStr || '';
      if (!/\bstr\b/.test(op) || !/^s\d+/.test(op)) continue;
      const m = /\[x\d+(?:,\s*#(0x[0-9a-f]+|\d+))?\]/i.exec(op);
      if (!m) continue;
      const disp = m[1] ? Number(m[1]) : 0;
      if (disp !== hpOff) continue;
      const base = /\[(x\d+)/.exec(op);
      candidates.push({ addr, op, baseReg: base ? base[1] : null, module: moduleOf(addr) });
    }
    note(`hp stores at +0x${hpOff.toString(16)}: ${candidates.length}`);

    // Validate: hook each, and watch for the base register matching a live actor.
    const actorSet = new Set(knownActors.map(a => a.actor.toString()));
    const confirmed = [];
    for (const c of candidates) {
      if (!c.baseReg) continue;
      try {
        const listener = Interceptor.attach(c.addr, {
          onEnter() {
            const v = this.context[c.baseReg];
            if (!v) return;
            for (const a of knownActors) {
              if (v.sub(a.actor).toInt32() === 0 || Math.abs(v.sub(a.actor).toInt32()) < 0x240) {
                if (!confirmed.find(x => x.addr.equals(c.addr))) {
                  confirmed.push({ addr: c.addr, op: c.op, module: c.module });
                  note(`hp write confirmed: ${c.op} @ ${c.addr}`);
                }
                break;
              }
            }
          },
        });
        c.listener = listener;
      } catch (e) { /* unreadable page */ }
    }
    return { candidates, confirmed };
  }

  // -------------------------------------------------------------------------
  // public
  // -------------------------------------------------------------------------
  function screenSize() {
    try {
      const win = ObjC.classes.UIApplication.sharedApplication().keyWindow();
      const b = win.bounds();
      return { w: b.size.width, h: b.size.height };
    } catch (e) {
      return { w: 1170, h: 2532 };
    }
  }

  function run(opts) {
    const o = Object.assign({ hooks: false }, opts || {});
    out.log = [];

    const logic = Process.findModuleByName('Scid');
    const main = Process.findModuleByName('laser');
    out.mainBase = main ? main.base.toString() : null;
    out.logicBase = logic ? logic.base.toString() : null;

    const shapes = findActorShapes();
    const pos = pickPositionOffset(shapes);
    if (!pos) {
      note('no actor position offset found — run it in a live match, not the lobby');
      return { ok: false, reason: 'no-actors', ...out };
    }
    note(`position offset +0x${pos.off.toString(16)}, ${pos.uniq} structs`);
    pos.hits.forEach(h => { h.posOff = pos.off; });

    const table = findTable(pos.hits);
    const layout = inferLayout(pos.hits);
    if (!layout) return { ok: false, reason: 'no-layout', ...out };

    const actors = pos.hits.slice(0, 24).map(h => ({ x: h.x, y: h.y, actor: h.actor }));
    const matrix = findMatrix(actors, screenSize());
    const hp = o.hooks ? findHpStore(layout.hp, logic, actors) : { candidates: [], confirmed: [] };

    out.ok = true;
    out.actors = {
      count: pos.uniq,
      table: table ? { addr: table.array.toString(), stride: table.stride, entries: table.count } : null,
      layout,
      sample: actors.slice(0, 5).map(a => ({ x: +a.x.toFixed(1), y: +a.y.toFixed(1) })),
    };
    out.matrix = matrix ? {
      addr: matrix.addr.toString(),
      moduleRelative: main ? matrix.addr.sub(main.base).toString() : null,
      columnMajor: matrix.columnMajor,
      score: matrix.score,
    } : null;
    out.hpWrite = {
      candidates: hp.candidates.map(c => ({ addr: c.addr.toString(), op: c.op })),
      confirmed: hp.confirmed.map(c => ({ addr: c.addr.toString(), op: c.op })),
    };
    return out;
  }

  return { run, findActorShapes, pickPositionOffset, inferLayout, findMatrix, findHpStore };
})();

globalThis.BSResolve = BSResolve;
