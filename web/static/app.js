'use strict';

// ── Utilities ────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const fmtTs = iso => iso ? iso.slice(11, 19) : '';

// ── ANSI → HTML ───────────────────────────────────────────────
// Converts ANSI SGR color/bold codes to <span> elements.
// Non-color sequences (cursor movement, erase, etc.) are stripped.
const ANSI_FG = {
  30:'#6e7681', 31:'#f85149', 32:'#3fb950', 33:'#d29922',
  34:'#58a6ff', 35:'#bc8cff', 36:'#76e3ea', 37:'#c9d1d9',
  90:'#6e7681', 91:'#ff7b72', 92:'#56d364', 93:'#e3b341',
  94:'#79c0ff', 95:'#d2a8ff', 96:'#b3f0ff', 97:'#ffffff',
};
const ANSI_BG = {
  40:'#010409', 41:'#3d1c1c', 42:'#1a3020', 43:'#2f2600',
  44:'#1c2a3a', 45:'#2e1f4a', 46:'#0f2f30', 47:'#2a2a2a',
};

function ansiToHtml(raw) {
  // 1. Escape HTML to prevent injection
  let s = raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // 2. Strip non-CSI ESC sequences (ESC + single char, e.g. ESC M = Reverse Index)
  s = s.replace(/\x1b[^\[]/g, '');

  // 3. Process CSI sequences: \x1b[ params cmd
  let out = '';
  let spans = 0;
  let bold = false, fg = null, bg = null;
  const re = /\x1b\[([0-9;]*)([A-Za-z])/g;
  let last = 0, m;

  while ((m = re.exec(s)) !== null) {
    out += s.slice(last, m.index);
    last = m.index + m[0].length;

    if (m[2] !== 'm') continue; // drop non-SGR CSI (cursor, erase, etc.)

    // Close open spans before changing state
    if (spans) { out += '</span>'.repeat(spans); spans = 0; }

    const codes = m[1] === '' ? [0] : m[1].split(';').map(Number);
    for (const c of codes) {
      if      (c === 0)                              { bold = false; fg = null; bg = null; }
      else if (c === 1)                              { bold = true; }
      else if (c === 22)                             { bold = false; }
      else if (ANSI_FG[c] !== undefined)             { fg = ANSI_FG[c]; }
      else if (ANSI_BG[c] !== undefined)             { bg = ANSI_BG[c]; }
      else if (c === 39)                             { fg = null; }
      else if (c === 49)                             { bg = null; }
    }

    if (bold || fg || bg) {
      const style = [
        fg   ? `color:${fg}`            : '',
        bg   ? `background:${bg}`       : '',
        bold ? 'font-weight:bold'       : '',
      ].filter(Boolean).join(';');
      out += `<span style="${style}">`;
      spans++;
    }
  }

  out += s.slice(last);
  if (spans) out += '</span>'.repeat(spans);

  // 4. Strip any leftover control chars (bell, backspace, etc.)
  return out.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

function buildLine(port, color, ts, data, sent = false) {
  const div = document.createElement('div');
  div.className = 'line' + (sent ? ' sent' : '');

  const tsSpan   = document.createElement('span');
  tsSpan.className = 'line-ts';
  tsSpan.textContent = fmtTs(ts);

  const tagSpan  = document.createElement('span');
  tagSpan.className = 'line-tag';
  tagSpan.style.color = color || '#8b949e';
  tagSpan.textContent = `[${port}]`;

  const dataSpan = document.createElement('span');
  dataSpan.className = 'line-data';
  dataSpan.innerHTML = ansiToHtml(data);  // render ANSI color codes

  div.append(tsSpan, tagSpan, dataSpan);
  return div;
}

function scrollIfNeeded(panel, autoScroll) {
  if (autoScroll) panel.scrollTop = panel.scrollHeight;
}

// ── File download helper ──────────────────────────────────────
function downloadText(filename, text) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function logTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

// Wraps a save action with button feedback:
// disables the button → yields a paint frame → runs action → shows "Saved ✓" briefly.
function withSaveFeedback(btn, action) {
  if (btn.disabled) return;
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Saving…';
  // yield to browser so the 'Saving…' label actually paints before we block
  setTimeout(() => {
    try { action(); } catch (_) {}
    btn.textContent = 'Saved ✓';
    setTimeout(() => {
      btn.textContent = original;
      btn.disabled = false;
    }, 1500);
  }, 30);
}

function saveStreamToFile() {
  const lines = [];
  streamOutput.querySelectorAll('.line').forEach(div => {
    const ts   = div.querySelector('.line-ts')?.textContent.trim()  ?? '';
    const tag  = div.querySelector('.line-tag')?.textContent.trim()  ?? '';
    const data = div.querySelector('.line-data')?.innerText.trim()   ?? '';
    if (ts || tag || data) lines.push(`${ts} ${tag} ${data}`);
  });
  if (lines.length === 0) return;
  downloadText(`stream-${logTimestamp()}.txt`, lines.join('\n'));
}

function saveTerminalToFile(portName) {
  const session = termSessions.get(portName);
  if (!session) return;

  const buffer = session.term.buffer.active;
  const lines  = [];
  for (let i = 0; i < buffer.length; i++) {
    const line = buffer.getLine(i);
    if (line) lines.push(line.translateToString(true));
  }
  // Trim trailing blank lines
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  if (lines.length === 0) return;
  downloadText(`terminal-${portName}-${logTimestamp()}.txt`, lines.join('\n'));
}

function wsURL(path) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}${path}`;
}

// ── Tab switching ────────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    $(`tab-${btn.dataset.tab}`).classList.add('active');
    if (btn.dataset.tab === 'stream')   primeStreamLegend();
    if (btn.dataset.tab === 'config')   loadConfig();
    if (btn.dataset.tab === 'terminal') loadPortsForTerminal();  // sync, don't reconnect existing
  });
});

// ── Live Stream ──────────────────────────────────────────────
const streamOutput  = $('stream-output');
const streamLegend  = $('stream-legend');
const streamFilters = $('stream-filters');
const autoScrollCB  = $('stream-autoscroll');
$('stream-save').addEventListener('click', function() { withSaveFeedback(this, saveStreamToFile); });
$('stream-clear').addEventListener('click', () => { streamOutput.innerHTML = ''; });

const portFilters = {};  // portName → { color, visible }
let streamWS = null;

function ensurePortFilter(port, color) {
  if (portFilters[port]) return;
  portFilters[port] = { color, visible: true };

  const item = document.createElement('div');
  item.className = 'legend-item';
  item.innerHTML = `<span class="legend-dot" style="background:${color}"></span><span>${port}</span>`;
  streamLegend.appendChild(item);

  const label = document.createElement('label');
  label.className = 'checkbox-label';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = true;
  cb.addEventListener('change', () => {
    portFilters[port].visible = cb.checked;
    streamOutput.querySelectorAll(`.line[data-port="${port}"]`).forEach(el => {
      el.style.display = cb.checked ? '' : 'none';
    });
  });
  label.append(cb, document.createTextNode(port));
  streamFilters.appendChild(label);
}

function connectStreamWS() {
  if (streamWS) return;
  streamWS = new WebSocket(wsURL('/ws/stream'));

  streamWS.addEventListener('message', e => {
    const msg = JSON.parse(e.data);
    ensurePortFilter(msg.port, msg.color);
    if (!portFilters[msg.port]?.visible) return;

    const line = buildLine(msg.port, msg.color, msg.ts, msg.data);
    line.dataset.port = msg.port;
    streamOutput.appendChild(line);
    while (streamOutput.childElementCount > 2000) streamOutput.firstElementChild.remove();
    scrollIfNeeded(streamOutput, autoScrollCB.checked);
  });

  streamWS.addEventListener('close', () => {
    streamWS = null;
    setTimeout(connectStreamWS, 3000);
  });

  streamWS.addEventListener('error', () => streamWS.close());
}

async function primeStreamLegend() {
  try {
    const res = await fetch('/api/ports');
    const ports = await res.json();
    ports.filter(p => p.enabled && p.color).forEach(p => ensurePortFilter(p.name, p.color));
  } catch (_) {}
}

// Hard-reset the legend and filters (call after config changes that may rename/reorder ports).
async function resetStreamLegend() {
  // Clear state
  for (const k of Object.keys(portFilters)) delete portFilters[k];
  streamLegend.innerHTML = '';
  streamFilters.innerHTML = '';
  // Re-populate from current (saved) config
  await primeStreamLegend();
}

connectStreamWS();
primeStreamLegend();

// ── Terminal (xterm.js) ───────────────────────────────────────
const termPortTabsEl  = $('term-port-tabs');
const termXterminalsEl = $('term-xterminals');

// Map of portName → { name, color, term, fitAddon, wrapper, ws }
const termSessions   = new Map();
let   activeTermPort = null;

const XTERM_THEME = {
  background:          '#010409',
  foreground:          '#c9d1d9',
  cursor:              '#c9d1d9',
  cursorAccent:        '#010409',
  selectionBackground: '#264f78',
  black:   '#010409', brightBlack:   '#6e7681',
  red:     '#f85149', brightRed:     '#ff7b72',
  green:   '#3fb950', brightGreen:   '#56d364',
  yellow:  '#d29922', brightYellow:  '#e3b341',
  blue:    '#58a6ff', brightBlue:    '#79c0ff',
  magenta: '#bc8cff', brightMagenta: '#d2a8ff',
  cyan:    '#76e3ea', brightCyan:    '#b3f0ff',
  white:   '#c9d1d9', brightWhite:   '#ffffff',
};

// ── Session management ────────────────────────────────────────

function getOrCreateSession(port) {
  if (termSessions.has(port.name)) return termSessions.get(port.name);

  // Create wrapper div
  const wrapper = document.createElement('div');
  wrapper.className = 'term-xterm-wrapper';
  wrapper.dataset.port = port.name;
  termXterminalsEl.appendChild(wrapper);

  // Create xterm Terminal
  const term = new window.Terminal({
    theme:      XTERM_THEME,
    cursorBlink: true,
    fontSize:   13,
    fontFamily: '"Consolas", "Menlo", "Liberation Mono", monospace',
    scrollback: 5000,
    convertEol:  false,  // pass raw bytes; let the device control CR/LF
  });

  const fitAddon = new window.FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.open(wrapper);

  const session = { name: port.name, color: port.color, term, fitAddon, wrapper, ws: null, unread: 0 };
  termSessions.set(port.name, session);

  // Keystrokes → serial (raw bytes, exactly as xterm produces them)
  // This handles regular keys, ctrl+C, ctrl+X, arrow keys, ESC sequences — everything.
  term.onData(data => {
    const s = termSessions.get(port.name);
    if (s?.ws?.readyState === WebSocket.OPEN) {
      s.ws.send(new TextEncoder().encode(data));
    }
  });

  connectTermSessionWS(session);
  return session;
}

function connectTermSessionWS(session) {
  if (session.ws) return;
  setTermTabStatus(session.name, 'connecting');

  const ws = new WebSocket(wsURL(`/ws/port/${encodeURIComponent(session.name)}`));
  ws.binaryType = 'arraybuffer';
  session.ws = ws;

  ws.addEventListener('open', () => setTermTabStatus(session.name, 'connected'));

  ws.addEventListener('message', e => {
    // Raw bytes from serial → write directly to xterm (handles ANSI, prompts, everything)
    session.term.write(new Uint8Array(e.data));

    if (activeTermPort !== session.name) {
      session.unread++;
      updateTermTabBadge(session.name);
    }
  });

  ws.addEventListener('close', () => {
    session.ws = null;
    setTermTabStatus(session.name, 'disconnected');
    session.term.write('\r\n\x1b[33m[disconnected — reconnecting in 3s…]\x1b[0m\r\n');
    setTimeout(() => {
      if (termSessions.has(session.name)) connectTermSessionWS(session);
    }, 3000);
  });

  ws.addEventListener('error', () => ws.close());
}

// ── Tab buttons ───────────────────────────────────────────────

function renderTermTabs(ports) {
  termPortTabsEl.querySelectorAll('.term-tab-btn').forEach(btn => {
    if (!ports.find(p => p.name === btn.dataset.port)) btn.remove();
  });

  ports.forEach(port => {
    let btn = termPortTabsEl.querySelector(`.term-tab-btn[data-port="${CSS.escape(port.name)}"]`);
    if (!btn) {
      btn = document.createElement('button');
      btn.className = 'term-tab-btn';
      btn.dataset.port = port.name;
      btn.innerHTML = `
        <span class="status-dot disconnected"></span>
        <span class="term-tab-name">${port.name}</span>
        <span class="term-tab-badge"></span>`;
      btn.addEventListener('click', () => switchTermPort(port.name));
      termPortTabsEl.appendChild(btn);
    }
  });
}

function setTermTabStatus(portName, status) {
  const btn = termPortTabsEl.querySelector(`.term-tab-btn[data-port="${CSS.escape(portName)}"]`);
  if (btn) btn.querySelector('.status-dot').className = `status-dot ${status}`;
}

function updateTermTabBadge(portName) {
  const btn = termPortTabsEl.querySelector(`.term-tab-btn[data-port="${CSS.escape(portName)}"]`);
  if (!btn) return;
  const session = termSessions.get(portName);
  const count = session?.unread || 0;
  const badge = btn.querySelector('.term-tab-badge');
  badge.textContent = count > 99 ? '99+' : String(count);
  badge.classList.toggle('visible', count > 0);
}

function switchTermPort(portName) {
  activeTermPort = portName;

  // Update tab active state
  termPortTabsEl.querySelectorAll('.term-tab-btn').forEach(btn =>
    btn.classList.toggle('active', btn.dataset.port === portName));

  // Show only the active wrapper
  termXterminalsEl.querySelectorAll('.term-xterm-wrapper').forEach(w =>
    w.classList.toggle('active', w.dataset.port === portName));

  const session = termSessions.get(portName);
  if (!session) return;

  // Clear unread
  session.unread = 0;
  updateTermTabBadge(portName);

  // Fit terminal to container (must be visible first)
  requestAnimationFrame(() => {
    session.fitAddon.fit();
    session.term.focus();
  });
}

// Re-fit active terminal on window resize
window.addEventListener('resize', () => {
  if (activeTermPort) termSessions.get(activeTermPort)?.fitAddon.fit();
});

$('term-save').addEventListener('click', function() {
  if (activeTermPort) withSaveFeedback(this, () => saveTerminalToFile(activeTermPort));
});

// ── Load / sync ports ─────────────────────────────────────────

async function loadPortsForTerminal() {
  try {
    const res     = await fetch('/api/ports');
    const ports   = await res.json();
    const enabled = ports.filter(p => p.enabled);
    const names   = new Set(enabled.map(p => p.name));

    // Tear down sessions for removed ports
    for (const [name, session] of termSessions) {
      if (!names.has(name)) {
        if (session.ws) session.ws.close();
        session.term.dispose();
        session.wrapper.remove();
        termSessions.delete(name);
      }
    }

    // Create sessions for new ports
    enabled.forEach(p => getOrCreateSession(p));

    renderTermTabs(enabled);

    if (!activeTermPort || !names.has(activeTermPort)) {
      if (enabled.length > 0) switchTermPort(enabled[0].name);
    }
  } catch (_) {}
}

// ── Configuration ─────────────────────────────────────────────
const cfgTbody    = $('cfg-tbody');
const cfgMessage  = $('cfg-message');
const cfgAddPanel = $('cfg-add-panel');
const cfgAvailList = $('cfg-available-list');

$('cfg-scan').addEventListener('click', scanDevices);
$('cfg-save-all').addEventListener('click', saveAllPorts);

function showCfgMsg(text, isErr) {
  cfgMessage.textContent = text;
  cfgMessage.className = 'cfg-message ' + (isErr ? 'err' : 'ok');
  clearTimeout(cfgMessage._timer);
  cfgMessage._timer = setTimeout(() => cfgMessage.classList.add('hidden'), 4000);
}

async function loadConfig() {
  try {
    const [portsRes, cfgRes] = await Promise.all([fetch('/api/ports'), fetch('/api/config')]);
    const ports = await portsRes.json();
    const cfg   = await cfgRes.json();
    $('cfg-buffer-size').value = cfg.server?.buffer_size ?? 300;
    renderConfigTable(ports);
  } catch (err) {
    showCfgMsg('Failed to load config: ' + err, true);
  }
}

function renderConfigTable(ports) {
  cfgTbody.innerHTML = '';
  ports.forEach(p => cfgTbody.appendChild(buildPortRow(p)));
}

let dragSrc = null;

function buildPortRow(p) {
  const tr = document.createElement('tr');
  tr.dataset.device = p.device;
  tr.draggable = true;

  tr.append(
    gripCell(),
    cell(p.device),
    editableText('name',      p.name),
    editableNumber('baud_rate', p.baud_rate, 300, 4000000),
    editableSelect('data_bits', p.data_bits, [5, 6, 7, 8],           true),
    editableSelect('parity',    p.parity,    ['none', 'odd', 'even']),
    editableSelect('stop_bits', p.stop_bits, [1, 1.5, 2],            true),
    colorCell(p.color),
    toggleCell(p.enabled),
    removeCell(p.device),
  );

  tr.addEventListener('dragstart', e => {
    dragSrc = tr;
    e.dataTransfer.effectAllowed = 'move';
    tr.classList.add('dragging');
  });
  tr.addEventListener('dragend', () => {
    tr.classList.remove('dragging');
    cfgTbody.querySelectorAll('tr').forEach(r => r.classList.remove('drag-over'));
    dragSrc = null;
  });
  tr.addEventListener('dragover', e => {
    e.preventDefault();
    if (!dragSrc || dragSrc === tr) return;
    e.dataTransfer.dropEffect = 'move';
    cfgTbody.querySelectorAll('tr').forEach(r => r.classList.remove('drag-over'));
    tr.classList.add('drag-over');
  });
  tr.addEventListener('drop', e => {
    e.preventDefault();
    if (!dragSrc || dragSrc === tr) return;
    tr.classList.remove('drag-over');
    const rows   = Array.from(cfgTbody.children);
    const srcIdx = rows.indexOf(dragSrc);
    const dstIdx = rows.indexOf(tr);
    if (srcIdx < dstIdx) cfgTbody.insertBefore(dragSrc, tr.nextSibling);
    else                  cfgTbody.insertBefore(dragSrc, tr);
  });

  return tr;
}

function gripCell() {
  const td = document.createElement('td');
  td.className = 'grip-cell';
  td.textContent = '⠿';
  td.title = 'Drag to reorder';
  return td;
}

function cell(text) {
  const td = document.createElement('td');
  td.textContent = text;
  td.style.color = 'var(--text-dim)';
  td.style.fontSize = '.8rem';
  return td;
}

function editableText(field, value) {
  const td = document.createElement('td');
  const inp = document.createElement('input');
  inp.type = 'text'; inp.value = value ?? ''; inp.dataset.field = field;
  td.appendChild(inp);
  return td;
}

function editableNumber(field, value, min, max) {
  const td = document.createElement('td');
  const inp = document.createElement('input');
  inp.type = 'number'; inp.value = value ?? '';
  inp.min = min; inp.max = max; inp.dataset.field = field;
  inp.style.width = '90px';
  td.appendChild(inp);
  return td;
}

function editableSelect(field, value, options, numeric = false) {
  const td = document.createElement('td');
  const sel = document.createElement('select');
  sel.dataset.field = field;
  if (numeric) sel.dataset.numeric = '1';
  options.forEach(o => {
    const opt = document.createElement('option');
    opt.value = o; opt.textContent = o;
    if (String(o) === String(value)) opt.selected = true;
    sel.appendChild(opt);
  });
  td.appendChild(sel);
  return td;
}

function colorCell(color) {
  const td = document.createElement('td');
  const inp = document.createElement('input');
  inp.type = 'color'; inp.value = color || '#4caf50'; inp.dataset.field = 'color';
  td.appendChild(inp);
  return td;
}

function toggleCell(enabled) {
  const td = document.createElement('td');
  const label = document.createElement('label');
  label.className = 'toggle-switch';
  const cb = document.createElement('input');
  cb.type = 'checkbox'; cb.checked = !!enabled; cb.dataset.field = 'enabled';
  const slider = document.createElement('span');
  slider.className = 'toggle-slider';
  label.append(cb, slider);
  td.appendChild(label);
  return td;
}

function removeCell(device) {
  const td = document.createElement('td');
  const btn = document.createElement('button');
  btn.textContent = 'Remove';
  btn.className = 'danger';
  btn.addEventListener('click', () => deletePort(device));
  td.appendChild(btn);
  return td;
}

function collectRowData(tr) {
  const data = { device: tr.dataset.device };
  tr.querySelectorAll('[data-field]').forEach(el => {
    const field = el.dataset.field;
    if (el.type === 'checkbox')                      data[field] = el.checked;
    else if (el.type === 'number' || el.dataset.numeric) data[field] = Number(el.value);
    else                                             data[field] = el.value;
  });
  return data;
}

function portPutURL(device) {
  // device is like /dev/ttyUSB0 → PUT /api/ports/dev/ttyUSB0
  return '/api/ports' + device;
}

async function saveAllPorts() {
  const rows = Array.from(cfgTbody.querySelectorAll('tr'));

  // Collect ports in current DOM order (drag-to-reorder is preserved here)
  const ports = rows.map(tr => collectRowData(tr));
  const bufferSize = parseInt($('cfg-buffer-size').value, 10) || 300;

  // Single atomic PUT — replaces full config with correct ordering
  try {
    const res = await fetch('/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ server: { buffer_size: bufferSize }, ports }),
    });
    if (!res.ok) throw new Error(await res.text());
    showCfgMsg(`Saved ${ports.length} port${ports.length !== 1 ? 's' : ''}.`, false);
    loadConfig();
    resetStreamLegend();   // hard-reset so renamed/reordered ports replace old legend entries
    loadPortsForTerminal();
  } catch (err) {
    showCfgMsg('Save failed: ' + err, true);
  }
}

async function deletePort(device) {
  if (!confirm(`Remove ${device} from config?`)) return;
  try {
    const res = await fetch(portPutURL(device), { method: 'DELETE' });
    if (!res.ok) throw new Error(await res.text());
    showCfgMsg(`Removed ${device}`, false);
    loadConfig();
    resetStreamLegend();
    loadPortsForTerminal();
  } catch (err) {
    showCfgMsg('Delete failed: ' + err, true);
  }
}

async function scanDevices() {
  try {
    const [availRes, cfgRes] = await Promise.all([
      fetch('/api/ports/available'),
      fetch('/api/ports'),
    ]);
    const avail = await availRes.json();
    const cfg   = await cfgRes.json();
    const configured = new Set(cfg.map(p => p.device));
    const unconfigured = (avail || []).filter(d => !configured.has(d));

    cfgAvailList.innerHTML = '';
    if (unconfigured.length === 0) {
      cfgAvailList.textContent = 'No unconfigured devices found.';
    } else {
      unconfigured.forEach(device => {
        const div = document.createElement('div');
        div.className = 'avail-item';
        div.textContent = device;
        const addBtn = document.createElement('button');
        addBtn.textContent = 'Add';
        addBtn.addEventListener('click', () => addNewDevice(device));
        div.appendChild(addBtn);
        cfgAvailList.appendChild(div);
      });
    }
    cfgAddPanel.classList.remove('hidden');
  } catch (err) {
    showCfgMsg('Scan failed: ' + err, true);
  }
}

async function addNewDevice(device) {
  const defaults = {
    device,
    name: device.split('/').pop(),
    enabled: false,
    baud_rate: 115200,
    data_bits: 8,
    parity: 'none',
    stop_bits: 1,
    color: '',
  };
  try {
    const res = await fetch(portPutURL(device), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(defaults),
    });
    if (!res.ok) throw new Error(await res.text());
    showCfgMsg(`Added ${device}`, false);
    cfgAddPanel.classList.add('hidden');
    loadConfig();
  } catch (err) {
    showCfgMsg('Add failed: ' + err, true);
  }
}
