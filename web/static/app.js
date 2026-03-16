'use strict';

// ── Utilities ────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const fmtTs = iso => iso ? iso.slice(11, 19) : '';

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
  dataSpan.textContent = data;

  div.append(tsSpan, tagSpan, dataSpan);
  return div;
}

function scrollIfNeeded(panel, autoScroll) {
  if (autoScroll) panel.scrollTop = panel.scrollHeight;
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
    if (btn.dataset.tab === 'config') loadConfig();
    if (btn.dataset.tab === 'terminal') loadPortsForTerminal();
  });
});

// ── Live Stream ──────────────────────────────────────────────
const streamOutput  = $('stream-output');
const streamLegend  = $('stream-legend');
const streamFilters = $('stream-filters');
const autoScrollCB  = $('stream-autoscroll');
$('stream-clear').addEventListener('click', () => { streamOutput.innerHTML = ''; });

const portFilters = {};  // portName → { color, visible }
let streamWS = null;

function ensurePortFilter(port, color) {
  if (portFilters[port]) return;
  portFilters[port] = { color, visible: true };

  // Legend dot
  const item = document.createElement('div');
  item.className = 'legend-item';
  item.innerHTML = `<span class="legend-dot" style="background:${color}"></span><span>${port}</span>`;
  streamLegend.appendChild(item);

  // Filter checkbox
  const label = document.createElement('label');
  label.className = 'checkbox-label';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = true;
  cb.addEventListener('change', () => {
    portFilters[port].visible = cb.checked;
    // Show/hide existing lines for this port
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
    // Trim to last 2000 lines
    while (streamOutput.childElementCount > 2000) streamOutput.firstElementChild.remove();
    scrollIfNeeded(streamOutput, autoScrollCB.checked);
  });

  streamWS.addEventListener('close', () => {
    streamWS = null;
    setTimeout(connectStreamWS, 3000);
  });

  streamWS.addEventListener('error', () => streamWS.close());
}

connectStreamWS();

// ── Terminal ─────────────────────────────────────────────────
const termPortSelect = $('term-port-select');
const termOutput     = $('term-output');
const termStatus     = $('term-status');
const termForm       = $('term-form');
const termInput      = $('term-input');
const termCRLF       = $('term-crlf');

let termWS   = null;
let termPort = '';

async function loadPortsForTerminal() {
  try {
    const res = await fetch('/api/ports');
    const ports = await res.json();
    // preserve current selection
    const current = termPortSelect.value;
    termPortSelect.innerHTML = '<option value="">— select —</option>';
    ports.filter(p => p.enabled).forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.name;
      opt.textContent = `${p.name} (${p.device})`;
      if (p.name === current) opt.selected = true;
      termPortSelect.appendChild(opt);
    });
  } catch (_) {}
}

function disconnectTermWS() {
  if (termWS) { termWS.close(); termWS = null; }
  termStatus.className = 'status-dot disconnected';
}

function connectTermWS(portName) {
  disconnectTermWS();
  if (!portName) return;
  termPort = portName;
  termStatus.className = 'status-dot connecting';

  termWS = new WebSocket(wsURL(`/ws/port/${encodeURIComponent(portName)}`));

  termWS.addEventListener('open', () => {
    termStatus.className = 'status-dot connected';
  });

  termWS.addEventListener('message', e => {
    const msg = JSON.parse(e.data);
    termOutput.appendChild(buildLine(msg.port, msg.color, msg.ts, msg.data));
    while (termOutput.childElementCount > 2000) termOutput.firstElementChild.remove();
    scrollIfNeeded(termOutput, true);
  });

  termWS.addEventListener('close', () => {
    termStatus.className = 'status-dot disconnected';
    termWS = null;
    // Auto-reconnect if port is still selected
    if (termPortSelect.value === portName) {
      setTimeout(() => connectTermWS(portName), 3000);
    }
  });

  termWS.addEventListener('error', () => termWS && termWS.close());
}

termPortSelect.addEventListener('change', () => connectTermWS(termPortSelect.value));

termForm.addEventListener('submit', e => {
  e.preventDefault();
  const raw = termInput.value;
  if (!raw || !termPort) return;
  const data = termCRLF.checked ? raw + '\r\n' : raw;

  if (termWS && termWS.readyState === WebSocket.OPEN) {
    termWS.send(JSON.stringify({ data }));
  } else {
    // Fallback to REST
    fetch(`/api/ports/${encodeURIComponent(termPort)}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data }),
    });
  }

  // Echo sent line
  const now = new Date().toISOString();
  termOutput.appendChild(buildLine(termPort, '#8b949e', now, `> ${raw}`, true));
  scrollIfNeeded(termOutput, true);
  termInput.value = '';
});

// ── Configuration ─────────────────────────────────────────────
const cfgTbody   = $('cfg-tbody');
const cfgMessage = $('cfg-message');
const cfgAddPanel = $('cfg-add-panel');
const cfgAvailList = $('cfg-available-list');
$('cfg-scan').addEventListener('click', scanDevices);

function showCfgMsg(text, isErr) {
  cfgMessage.textContent = text;
  cfgMessage.className = 'cfg-message ' + (isErr ? 'err' : 'ok');
  clearTimeout(cfgMessage._timer);
  cfgMessage._timer = setTimeout(() => cfgMessage.classList.add('hidden'), 4000);
}

async function loadConfig() {
  try {
    const res  = await fetch('/api/ports');
    const ports = await res.json();
    renderConfigTable(ports);
  } catch (err) {
    showCfgMsg('Failed to load config: ' + err, true);
  }
}

function renderConfigTable(ports) {
  cfgTbody.innerHTML = '';
  ports.forEach(p => cfgTbody.appendChild(buildPortRow(p)));
}

function buildPortRow(p) {
  const tr = document.createElement('tr');

  const fields = [
    cell(p.device),                                            // device (read-only)
    editableText('name',      p.name),
    editableNumber('baud_rate', p.baud_rate, 300, 4000000),
    editableSelect('data_bits', p.data_bits, [5,6,7,8]),
    editableSelect('parity',    p.parity,    ['none','odd','even']),
    editableSelect('stop_bits', p.stop_bits, [1, 1.5, 2]),
    colorCell(p.color),
    toggleCell(p.enabled),
    actionsCell(p.device),
  ];

  tr.append(...fields);
  tr.dataset.device = p.device;
  return tr;
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
  inp.type = 'text'; inp.value = value; inp.dataset.field = field;
  td.appendChild(inp);
  return td;
}

function editableNumber(field, value, min, max) {
  const td = document.createElement('td');
  const inp = document.createElement('input');
  inp.type = 'number'; inp.value = value;
  inp.min = min; inp.max = max; inp.dataset.field = field;
  inp.style.width = '90px';
  td.appendChild(inp);
  return td;
}

function editableSelect(field, value, options) {
  const td = document.createElement('td');
  const sel = document.createElement('select');
  sel.dataset.field = field;
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
  cb.type = 'checkbox'; cb.checked = enabled; cb.dataset.field = 'enabled';
  const slider = document.createElement('span');
  slider.className = 'toggle-slider';
  label.append(cb, slider);
  td.appendChild(label);
  return td;
}

function actionsCell(device) {
  const td = document.createElement('td');

  const saveBtn = document.createElement('button');
  saveBtn.textContent = 'Save';
  saveBtn.addEventListener('click', () => savePort(device));

  const delBtn = document.createElement('button');
  delBtn.textContent = 'Remove';
  delBtn.className = 'danger';
  delBtn.addEventListener('click', () => deletePort(device));

  td.append(saveBtn, ' ', delBtn);
  return td;
}

function collectRowData(device) {
  const tr = cfgTbody.querySelector(`tr[data-device="${CSS.escape(device)}"]`);
  if (!tr) return null;
  const data = { device };
  tr.querySelectorAll('[data-field]').forEach(el => {
    const field = el.dataset.field;
    if (el.type === 'checkbox') data[field] = el.checked;
    else if (el.type === 'number') data[field] = Number(el.value);
    else data[field] = el.value;
  });
  return data;
}

async function savePort(device) {
  const data = collectRowData(device);
  if (!data) return;
  const encodedDevice = encodeURIComponent(device).replace(/%2F/g, '/');
  try {
    const res = await fetch(`/api/ports${encodedDevice}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error(await res.text());
    showCfgMsg(`Saved ${device}`, false);
    loadConfig();
  } catch (err) {
    showCfgMsg('Save failed: ' + err, true);
  }
}

async function deletePort(device) {
  if (!confirm(`Remove ${device} from config?`)) return;
  const encodedDevice = encodeURIComponent(device).replace(/%2F/g, '/');
  try {
    const res = await fetch(`/api/ports${encodedDevice}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(await res.text());
    showCfgMsg(`Removed ${device}`, false);
    loadConfig();
  } catch (err) {
    showCfgMsg('Delete failed: ' + err, true);
  }
}

async function scanDevices() {
  try {
    const res   = await fetch('/api/ports/available');
    const avail = await res.json();
    const cfg   = await fetch('/api/ports').then(r => r.json());
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
  const encodedDevice = encodeURIComponent(device).replace(/%2F/g, '/');
  try {
    const res = await fetch(`/api/ports${encodedDevice}`, {
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
