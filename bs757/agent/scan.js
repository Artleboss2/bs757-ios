// scan.js — thin driver around resolve.js. Run it in a live match.
//
//   frida -H <ip>:27042 -n Gadget -l agent/build/scan.js --runtime=v8
//   frida -U -n laser -l agent/build/scan.js
//
// Prints one JSON blob. Module-relative values are what you paste into
// offsets.json; absolute ones change every launch and are for the log only.

'use strict';

// In the full bundle this file is fused with resolve.js, so the banner is a
// no-op there; standalone it must be loaded after resolve.js.
if (typeof BSResolve === 'undefined') {
  console.error('scan.js needs resolve.js — use agent/build/scan.js');
} else {
  try {
    const res = BSResolve.run({ hooks: true });
    res.log.forEach(l => console.log('  ' + l));

    const compact = {
      build: '70.757',
      ok: res.ok,
      reason: res.reason,
      actors: res.actors,
      matrix: res.matrix,
      hpWrite: res.hpWrite,
    };
    console.log('\n' + JSON.stringify(compact, null, 2));
    send({ type: 'scan', payload: compact });

    if (!res.ok) {
      console.log('\nNothing usable yet: ' + (res.reason || 'unknown'));
      console.log(res.reason === 'no-actors'
        ? 'Start a match first — the lobby has no battle actors.'
        : 'Run again after the first frame of a match.');
    }
  } catch (e) {
    console.error('scan failed: ' + (e && e.message));
  }
}
