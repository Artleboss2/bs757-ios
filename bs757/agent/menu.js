// menu.js — draggable launcher, triple-tap gate, tabbed feature panel.
//
// Launcher: 52pt translucent disc. Drag anywhere; position persists in
// NSUserDefaults. Open with three taps inside 700 ms (slower taps reset the
// counter, which is what stops missclicks mid-match). Three more closes it.
//
// Panel: 300x430, scrollable, one tab per category from BSFeatures. Top row
// carries the MASTER switch — while it is off, every non-protective feature is
// forced off and the engine installs nothing, so the build is inert.
//
// Tier dots: green = read-only or touch-only, amber = writes to the process,
// red = server-authoritative and the kind of thing that gets an account
// flagged. Red rows need a long-press to arm before the switch will move.
//
// global: BSMenu (needs BSHUD + BSFeatures)

'use strict';

const BSMenu = (function () {
  const TAP_WINDOW = 700;
  const TAP_COUNT = 3;
  const ICON = 52;
  const DRAG_SLOP = 8;
  const W = 300;
  const H = 430;
  const ROW_H = 40;
  const HEAD_H = 46;
  const TAB_H = 34;

  const TABS = ['Visuals', 'Combat', 'Movement', 'Lobby', 'Stealth'];
  const TIER_COLOR = {
    safe: [0.15, 1.0, 0.85, 1.0],
    risky: [1.0, 0.72, 0.15, 1.0],
    server: [1.0, 0.28, 0.28, 1.0],
  };

  const S = {
    icon: null,
    panel: null,
    scroll: null,
    tabBar: null,
    masterSwitch: null,
    open: false,
    tab: 0,
    taps: [],
    hud: null,
    rows: [],           // { container, sw, feature }
    state: {},          // handle -> drag bookkeeping
    built: false,
  };

  const cls = n => ObjC.classes[n];
  const F = () => globalThis.BSFeatures;

  // Registering a class allocates executable memory for its method trampolines.
  // If the kernel refuses that, one uncaught throw at module scope takes the
  // whole bundle down with it — including the overlay. Every class is therefore
  // optional, and start() refuses to build a panel it cannot wire up.
  function def(spec) {
    try {
      const c = ObjC.registerClass(spec);
      if (!c) throw new Error('registration returned null');
      return c;
    } catch (e) {
      console.log(`[menu] class ${spec.name} unavailable: ${e.message}`);
      return null;
    }
  }

  function rgba(r, g, b, a) {
    return cls('UIColor').colorWithRed_green_blue_alpha_(r, g, b, a);
  }

  function label(text, size, color, frame) {
    const l = cls('UILabel').alloc().initWithFrame_(frame);
    l.setText_(text);
    l.setFont_(cls('UIFont').boldSystemFontOfSize_(size));
    l.setTextColor_(color);
    l.setBackgroundColor_(cls('UIColor').clearColor());
    return l;
  }

  function frame(x, y, w, h) { return { origin: { x, y }, size: { width: w, height: h } }; }

  // ---- persisted launcher position ----------------------------------------
  function defaults() { return cls('NSUserDefaults').standardUserDefaults(); }

  function loadPos(win) {
    const d = defaults();
    const x = d.objectForKey_('BS757.pos.x');
    const y = d.objectForKey_('BS757.pos.y');
    const b = win.bounds();
    if (x && y) {
      const px = Number(x.doubleValue());
      const py = Number(y.doubleValue());
      if (px >= 0 && px <= b.size.width && py >= 0 && py <= b.size.height) return { x: px, y: py };
    }
    return { x: b.size.width - ICON - 18, y: b.size.height * 0.55 };
  }

  function savePos(f) {
    const d = defaults();
    d.setObject_forKey_(cls('NSNumber').numberWithDouble_(f.origin.x), 'BS757.pos.x');
    d.setObject_forKey_(cls('NSNumber').numberWithDouble_(f.origin.y), 'BS757.pos.y');
    d.synchronize();
  }

  // ---- classes -------------------------------------------------------------
  const Launcher = def({
    name: 'BS757Launcher',
    superclass: cls('UIView'),
    methods: {
      '- touchesBegan:withEvent:': function (touches) {
        const st = S.state[this.handle];
        if (!st) return;
        const pt = touches.anyObject().locationInView_(this.superview());
        st.start = { x: pt.x, y: pt.y };
        st.origin = this.frame().origin;
        st.moved = false;
        this.setAlpha_(0.7);
      },
      '- touchesMoved:withEvent:': function (touches) {
        const st = S.state[this.handle];
        if (!st || !st.origin || !st.start) return;
        const pt = touches.anyObject().locationInView_(this.superview());
        const dx = pt.x - st.start.x;
        const dy = pt.y - st.start.y;
        if (Math.abs(dx) > DRAG_SLOP || Math.abs(dy) > DRAG_SLOP) st.moved = true;
        if (!st.moved) return;
        this.setFrame_(frame(st.origin.x + dx, st.origin.y + dy, ICON, ICON));
      },
      '- touchesEnded:withEvent:': function () {
        const st = S.state[this.handle];
        this.setAlpha_(1.0);
        if (!st) return;
        if (st.moved) { savePos(this.frame()); st.moved = false; return; }
        registerTap();
      },
      '- touchesCancelled:withEvent:': function () { this.setAlpha_(1.0); },
      '- longPress:': function () { /* reserved */ },
    },
  });

  const Row = def({
    name: 'BS757Row',
    superclass: cls('UIView'),
    methods: {
      // Long-press arms a server-tier row: the only way its switch will move.
      '- onLongPress:': function () {
        const entry = S.state['row:' + this.tag()];
        if (!entry) return;
        F().arm(entry.feature.id);
        entry.feature.armed = true;
        entry.sw.setOn_(1);
        applyRow(entry, true);
        console.log('[menu] armed ' + entry.feature.id);
      },
    },
  });

  const SwitchTarget = def({
    name: 'BS757SwitchTarget',
    superclass: cls('NSObject'),
    methods: {
      '- onToggle:': function (sw) {
        const entry = S.rows[Number(this.tag())];
        if (!entry) return;
        const want = sw.isOn() === 1;
        const ok = F().set(entry.feature.id, want);
        if (ok !== want) {
          sw.setOn_(want ? 0 : 1);   // registry refused: put the switch back
          return;
        }
        applyFeature(entry.feature);
      },
    },
  });

  // ---- row rendering -------------------------------------------------------
  function applyFeature(f) {
    for (const e of S.rows) if (e.feature.id === f.id) applyRow(e, false);
  }

  function applyRow(entry, force) {
    const f = entry.feature;
    const blocked = f.blocked && f.blocked.length;
    const color = blocked ? rgba(0.5, 0.5, 0.55, 1)
      : rgba.apply(null, TIER_COLOR[f.tier] || TIER_COLOR.safe);
    entry.dot.setBackgroundColor_(color);
    entry.label.setTextColor_(blocked ? rgba(0.55, 0.55, 0.6, 1) : cls('UIColor').whiteColor());
    if (force || entry.sw.isOn() !== (f.enabled ? 1 : 0)) entry.sw.setOn_(f.enabled ? 1 : 0);
  }

  function buildRow(index, f) {
    const row = Row.alloc().initWithFrame_(frame(0, 0, W - 24, ROW_H));
    row.setTag_(index);

    const dot = cls('UIView').alloc().initWithFrame_(frame(2, ROW_H / 2 - 3, 6, 6));
    dot.setBackgroundColor_(rgba.apply(null, TIER_COLOR[f.tier] || TIER_COLOR.safe));
    dot.layer().setCornerRadius_(3);
    row.addSubview_(dot);

    const text = label(f.label, 13, cls('UIColor').whiteColor(), frame(16, 0, W - 24 - 16 - 60, ROW_H));
    row.addSubview_(text);

    const sw = cls('UISwitch').alloc().initWithFrame_(frame(W - 24 - 51, 5, 51, 31));
    sw.setOn_(f.enabled ? 1 : 0);

    const target = SwitchTarget.alloc().init();
    target.setTag_(index);
    sw.addTarget_action_forControlEvents_(target, ObjC.selector('onToggle:'), 4096);
    row.addSubview_(sw);

    if (f.tier === 'server') {
      const lp = Row.alloc().init();
      lp.setTag_(index);
      const rec = ObjC.classes.UILongPressGestureRecognizer.alloc()
        .initWithTarget_action_(lp, ObjC.selector('onLongPress:'));
      rec.setMinimumPressDuration_(0.6);
      row.addGestureRecognizer_(rec);
    }

    const entry = { container: row, sw, dot, label: text, feature: f };
    S.state['row:' + index] = entry;
    S.rows.push(entry);
    return row;
  }

  // ---- tabs ---------------------------------------------------------------
  function renderTab(index) {
    S.tab = index;
    for (const e of S.rows) {
      try { e.container.removeFromSuperview(); } catch (err) { /* gone */ }
      delete S.state['row:' + e.container.tag()];
    }
    S.rows = [];

    const cat = TABS[index];
    const list = F().all().filter(f => f.cat === cat);
    const contentH = Math.max(H - HEAD_H - TAB_H, list.length * ROW_H + 8);

    S.scroll.setContentSize_({ width: W, height: contentH });
    S.scroll.setContentOffset_({ x: 0, y: 0 });

    list.forEach((f, i) => {
      const row = buildRow(i, f);
      row.setFrame_(frame(12, i * ROW_H + 4, W - 24, ROW_H));
      S.scroll.addSubview_(row);
    });

    for (let i = 0; i < S.tabBtns.length; i++) {
      const btn = S.tabBtns[i];
      const on = i === index;
      // UIButton has no -setTextColor: the title colour is per-state.
      btn.setTitleColor_forState_(on ? rgba(0.15, 1.0, 0.85, 1.0) : rgba(0.55, 0.58, 0.65, 1.0), 0);
      btn.setBackgroundColor_(on ? rgba(0.15, 1.0, 0.85, 0.12) : cls('UIColor').clearColor());
    }
  }

  const TabTarget = def({
    name: 'BS757TabTarget',
    superclass: cls('NSObject'),
    methods: {
      '- onTap:': function (btn) { renderTab(Number(btn.tag())); },
    },
  });

  const MasterTarget = def({
    name: 'BS757MasterTarget',
    superclass: cls('NSObject'),
    methods: {
      '- onToggle:': function (sw) {
        F().setMaster(sw.isOn() === 1);
        for (const e of S.rows) applyRow(e, true);
      },
    },
  });

  function buildPanel() {
    const p = cls('UIView').alloc().initWithFrame_(frame(0, 0, W, H));
    p.setBackgroundColor_(rgba(0.06, 0.07, 0.10, 0.96));
    p.setUserInteractionEnabled_(true);
    p.layer().setCornerRadius_(14);
    p.layer().setBorderWidth_(1);
    p.layer().setBorderColor_(rgba(0.15, 1.0, 0.85, 0.45).CGColor());
    p.setClipsToBounds_(true);

    p.addSubview_(label('BS 70.757 — HUD', 15, rgba(0.15, 1.0, 0.85, 1.0), frame(12, 8, 150, 22)));

    const master = cls('UISwitch').alloc().initWithFrame_(frame(W - 66, 6, 51, 31));
    master.setOn_(F().master ? 1 : 0);
    const mt = MasterTarget.alloc().init();
    master.addTarget_action_forControlEvents_(mt, ObjC.selector('onToggle:'), 4096);
    p.addSubview_(master);
    S.masterSwitch = master;
    p.addSubview_(label('ARM', 9, rgba(0.6, 0.62, 0.7, 1), frame(W - 108, 12, 40, 14)));

    // tab bar
    const tabBar = cls('UIView').alloc().initWithFrame_(frame(0, HEAD_H - 8, W, TAB_H));
    tabBar.setBackgroundColor_(rgba(0.0, 0.0, 0.0, 0.25));
    p.addSubview_(tabBar);
    S.tabBar = tabBar;
    S.tabBtns = [];

    const tw = W / TABS.length;
    TABS.forEach((name, i) => {
      const b = cls('UIButton').alloc().initWithFrame_(frame(i * tw, 0, tw, TAB_H));
      b.setTitle_forState_(name, 0);
      b.setTitleColor_forState_(rgba(0.55, 0.58, 0.65, 1.0), 0);
      try { b.titleLabel().setFont_(cls('UIFont').boldSystemFontOfSize_(9)); }
      catch (e) { /* titleLabel not realized yet — the default font is fine */ }
      try { b.titleLabel().setAdjustsFontSizeToFitWidth_(true); }
      catch (e) { /* cosmetic only */ }
      b.setTag_(i);
      const tt = TabTarget.alloc().init();
      b.addTarget_action_forControlEvents_(tt, ObjC.selector('onTap:'), 64);
      tabBar.addSubview_(b);
      S.tabBtns.push(b);
    });

    // scroll body
    const scroll = cls('UIScrollView').alloc()
      .initWithFrame_(frame(0, HEAD_H - 8 + TAB_H, W, H - HEAD_H + 8 - TAB_H));
    scroll.setBackgroundColor_(cls('UIColor').clearColor());
    scroll.setShowsVerticalScrollIndicator_(true);
    scroll.setAlwaysBounceVertical_(false);
    p.addSubview_(scroll);
    S.scroll = scroll;

    S.built = true;
    return p;
  }

  // ---- open / close -------------------------------------------------------
  function open() {
    if (!S.panel) return;
    S.open = true;
    if (!S.built) buildPanel();
    const iconFrame = S.icon ? S.icon.frame() : { origin: { x: 0, y: 0 } };
    const win = S.icon ? S.icon.superview() : null;
    const b = win ? win.bounds() : { size: { width: 400, height: 800 } };
    let x = iconFrame.origin.x - W - 12;
    if (x < 8) x = iconFrame.origin.x + ICON + 12;
    if (x + W > b.size.width - 8) x = b.size.width - W - 8;
    let y = iconFrame.origin.y;
    if (y + H > b.size.height - 8) y = b.size.height - H - 8;
    if (y < 8) y = 8;
    S.panel.setFrame_(frame(x, y, W, H));
    S.panel.setHidden_(false);
    renderTab(S.tab);
    S.masterSwitch.setOn_(F().master ? 1 : 0);
  }

  function close() {
    S.open = false;
    if (S.panel) S.panel.setHidden_(true);
  }

  function registerTap() {
    const now = Date.now();
    S.taps = S.taps.filter(t => now - t <= TAP_WINDOW);
    S.taps.push(now);
    if (S.taps.length >= TAP_COUNT) {
      S.taps = [];
      if (S.open) close(); else open();
    }
  }

  // ---- install ------------------------------------------------------------
  function start(hud) {
    S.hud = hud;
    if (!Launcher || !SwitchTarget || !TabTarget || !MasterTarget || !Row) {
      console.log('[menu] class registration failed — no launcher, features are reachable over rpc only');
      return;
    }
    const F_ = F();
    if (F_) { F_.load(); F_.onChange(() => { for (const e of S.rows) applyRow(e, false); }); }

    const app = cls('UIApplication').sharedApplication();
    ObjC.schedule(ObjC.mainQueue, () => {
      const win = app.keyWindow() || app.windows().objectAtIndex_(0);
      if (!win) throw new Error('no window');

      const pos = loadPos(win);
      const icon = Launcher.alloc().initWithFrame_(frame(pos.x, pos.y, ICON, ICON));
      icon.setBackgroundColor_(rgba(0.06, 0.07, 0.10, 0.72));
      icon.setUserInteractionEnabled_(true);
      icon.layer().setCornerRadius_(ICON / 2);
      icon.layer().setBorderWidth_(2);
      icon.layer().setBorderColor_(rgba(0.15, 1.0, 0.85, 0.9).CGColor());

      const glyph = label('◉', 24, rgba(0.15, 1.0, 0.85, 1.0), frame(0, 0, ICON, ICON));
      glyph.setTextAlignment_(1);
      glyph.setUserInteractionEnabled_(false);
      icon.addSubview_(glyph);
      S.state[icon.handle] = {};

      const panel = buildPanel();
      panel.setHidden_(true);
      win.addSubview_(panel);
      win.addSubview_(icon);

      S.icon = icon;
      S.panel = panel;
      console.log('[menu] launcher up — triple-tap to open');
    });
  }

  function teardown() {
    if (S.icon) { delete S.state[S.icon.handle]; S.icon.removeFromSuperview(); }
    if (S.panel) S.panel.removeFromSuperview();
    S.icon = S.panel = null;
    S.rows = [];
    S.open = false;
    S.taps = [];
    S.built = false;
  }

  return { start, teardown, open, close, renderTab, get isOpen() { return S.open; } };
})();

globalThis.BSMenu = BSMenu;
