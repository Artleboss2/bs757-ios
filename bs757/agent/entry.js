// entry.js — the module the gadget loads (built to build/overlay.js).
//
// Import order is execution order. bridge.js must be first: menu.js calls
// ObjC.registerClass at module top level, so the global has to exist before
// this file's other imports are evaluated. features.js follows so the registry
// exists before anything reads a flag.

import './bridge.js';

import './features.js';
import './stealth.js';
import './input.js';
import './menu.js';
import './resolve.js';
import './overlay.js';

console.log('[hud] bundle loaded');
