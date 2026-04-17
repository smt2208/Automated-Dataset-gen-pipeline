/* ══════════════════════════════════════════════════════════════
   app.js — Bengali Dataset Generator
   ══════════════════════════════════════════════════════════════
   Flow:
     URL  → WebSocket /ws/process  { input_type:"url",  input_source: url }
     File → POST /upload → WebSocket /ws/process  { input_type:"pdf"|"image", input_source: file_path }

   WS server messages:
     { type:"node_start", node, label }
     { type:"node_done",  node, label }
     { type:"node_error", node, message }
     { type:"error",      message }         ← fatal, stream ends
     { type:"completed",  pairs, files:{jsonl,hf,unsloth,excel} }
   ══════════════════════════════════════════════════════════════ */

const API    = location.hostname === 'localhost' || location.hostname === '127.0.0.1' ? `http://${location.host}` : '';
const WS_URL = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/process`;

// ── State ──────────────────────────────────────────────────────────────────
let selectedFile  = null;
let downloadFiles = {};   // filled on "completed" event
let ws            = null;

// Mapping: backend node name → frontend step <div> id
// Multiple backend nodes map to the same visual step (ps-extract)
const NODE_STEP = {
  scrape_node:  'ps-extract',
  pdf_node:     'ps-extract',
  ocr_node:     'ps-extract',
  clean_node:   'ps-clean',
  openai_node:  'ps-openai',
  output_node:  'ps-output',
};

// All known frontend step IDs (in order)
const ALL_STEPS = ['ps-input', 'ps-extract', 'ps-clean', 'ps-openai', 'ps-output'];


// ── Tab switching ──────────────────────────────────────────────────────────

function switchTab(tab) {
  document.querySelectorAll('.tab').forEach(t => {
    t.classList.remove('active');
    t.setAttribute('aria-selected', 'false');
  });
  document.querySelectorAll('.tab-content').forEach(c => c.classList.add('hidden'));
  document.getElementById(`tab-${tab}`).classList.add('active');
  document.getElementById(`tab-${tab}`).setAttribute('aria-selected', 'true');
  document.getElementById(`tab-content-${tab}`).classList.remove('hidden');
}


// ── File handling ──────────────────────────────────────────────────────────

function handleDrop(event) {
  event.preventDefault();
  document.getElementById('dropzone').classList.remove('drag-over');
  const file = event.dataTransfer.files[0];
  if (file) setFile(file);
}

function handleFileSelect(event) {
  const file = event.target.files[0];
  if (file) setFile(file);
}

function setFile(file) {
  const allowed = ['application/pdf', 'image/png', 'image/jpeg', 'image/jpg'];
  if (!allowed.includes(file.type)) {
    showToast('Unsupported type. Use PDF, PNG, or JPG.', 'error');
    return;
  }
  selectedFile = file;
  document.getElementById('file-name-label').textContent = file.name;
  document.getElementById('file-selected').classList.remove('hidden');
}


// ── Pipeline UI helpers ────────────────────────────────────────────────────

function resetPipeline() {
  ALL_STEPS.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.className = 'pipe-step';
    el.querySelector('.pipe-state').textContent = '—';
  });
  // Reset extract label to generic
  const nameEl = document.getElementById('ps-extract-name');
  if (nameEl) nameEl.textContent = 'Extraction';
}

function setStep(stepId, state /* 'active'|'done'|'error' */, label = null) {
  const el = document.getElementById(stepId);
  if (!el) return;
  el.className = `pipe-step ${state}`;
  const labels = { active: 'Processing…', done: 'Done ✓', error: 'Failed ✗' };
  el.querySelector('.pipe-state').textContent = labels[state] || '—';
  if (label) {
    const nameEl = id => document.getElementById(id);
    // Update the extraction step's dynamic label if applicable
    if (stepId === 'ps-extract') {
      const n = document.getElementById('ps-extract-name');
      if (n) n.textContent = label;
    }
  }
}

function setWsBadge(state /* 'idle'|'connecting'|'running'|'done'|'error' */, text) {
  const el = document.getElementById('ws-status');
  el.className = `ws-badge ${state}`;
  el.textContent = `● ${text}`;
}


// ── WebSocket pipeline runner ──────────────────────────────────────────────

function connectAndRun(inputType, inputSource) {
  // Close any existing connection
  if (ws && ws.readyState < 2) ws.close();

  resetPipeline();
  hideResult();
  setInputsDisabled(true);
  setWsBadge('connecting', 'Connecting…');

  // Immediately mark routing as active
  setStep('ps-input', 'active');

  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    setWsBadge('running', 'Running');
    setStep('ps-input', 'done');
    ws.send(JSON.stringify({ input_type: inputType, input_source: inputSource }));
  };

  ws.onmessage = (evt) => {
    try {
      handleWsMessage(JSON.parse(evt.data));
    } catch (e) {
      console.error('WS parse error', e);
    }
  };

  ws.onerror = () => {
    setWsBadge('error', 'Error');
    showError('WebSocket error — is the backend running on port 8000?');
    setInputsDisabled(false);
  };

  ws.onclose = () => {
    setInputsDisabled(false);
  };
}

function handleWsMessage(msg) {
  const stepId = NODE_STEP[msg.node];

  switch (msg.type) {
    case 'node_start':
      if (stepId) setStep(stepId, 'active', msg.label);
      break;

    case 'node_done':
      if (stepId) setStep(stepId, 'done');
      break;

    case 'node_error':
      if (stepId) setStep(stepId, 'error');
      break;

    case 'error':
      setWsBadge('error', 'Failed');
      showError(msg.message || 'An unknown pipeline error occurred.');
      break;

    case 'completed':
      setWsBadge('done', 'Done');
      downloadFiles = msg.files || {};
      showSuccess(msg.pairs, msg.files);
      showToast(`✓ ${msg.pairs} pairs generated!`, 'success');
      break;

    default:
      break;
  }
}


// ── Submit handlers ────────────────────────────────────────────────────────

function submitUrl() {
  const url = document.getElementById('url-input').value.trim();
  if (!url) { showToast('Please enter a URL.', 'error'); return; }
  try { new URL(url); } catch { showToast('Invalid URL — include https://', 'error'); return; }
  connectAndRun('url', url);
}

async function submitFile() {
  if (!selectedFile) { showToast('No file selected.', 'error'); return; }

  setInputsDisabled(true);
  setWsBadge('connecting', 'Uploading…');

  const formData = new FormData();
  formData.append('file', selectedFile);

  try {
    const res = await fetch(`${API}/upload`, { method: 'POST', body: formData });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      showToast(err.detail || 'Upload failed.', 'error');
      setInputsDisabled(false);
      setWsBadge('idle', 'Idle');
      return;
    }
    const { file_path, input_type } = await res.json();
    connectAndRun(input_type, file_path);
  } catch {
    showToast('Upload failed — backend unreachable.', 'error');
    setInputsDisabled(false);
    setWsBadge('idle', 'Idle');
  }
}


// ── Download ───────────────────────────────────────────────────────────────

function downloadDataset(format) {
  const filename = downloadFiles[format];
  if (!filename) { showToast('File not available.', 'error'); return; }
  const a = document.createElement('a');
  a.href = `${API}/download/${encodeURIComponent(filename)}`;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}


// ── Result panel helpers ───────────────────────────────────────────────────

function showSuccess(pairs, files) {
  document.getElementById('stat-pairs').textContent = pairs;

  // Show / hide each download button based on whether file exists
  const fmt = (id, key) => document.getElementById(id).classList.toggle('hidden', !files[key]);
  fmt('btn-dl-jsonl',   'jsonl');
  fmt('btn-dl-hf',      'hf');
  fmt('btn-dl-unsloth', 'unsloth');
  fmt('btn-dl-excel',   'excel');

  document.getElementById('result-success').classList.remove('hidden');
  document.getElementById('result-error').classList.add('hidden');
  document.getElementById('result-panel').classList.remove('hidden');
}

function showError(msg) {
  document.getElementById('error-message').textContent = msg;
  document.getElementById('result-error').classList.remove('hidden');
  document.getElementById('result-success').classList.add('hidden');
  document.getElementById('result-panel').classList.remove('hidden');
}

function hideResult() {
  document.getElementById('result-panel').classList.add('hidden');
  document.getElementById('result-success').classList.add('hidden');
  document.getElementById('result-error').classList.add('hidden');
}


// ── Input lock helpers ─────────────────────────────────────────────────────

function setInputsDisabled(disabled) {
  ['btn-url', 'btn-file'].forEach(id => {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.disabled = disabled;
    const t = btn.querySelector('.btn-text');
    if (t) t.textContent = disabled ? 'Running…' : 'Generate';
  });
}


// ── Toast ──────────────────────────────────────────────────────────────────

function showToast(msg, type = 'info') {
  let toast = document.getElementById('_toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = '_toast';
    Object.assign(toast.style, {
      position: 'fixed', bottom: '1.5rem', right: '1.5rem',
      padding: '.75rem 1.2rem', borderRadius: '10px',
      fontSize: '.85rem', fontWeight: '500', color: '#fff',
      zIndex: '100', boxShadow: '0 4px 20px rgba(0,0,0,.5)',
      transition: 'opacity .3s', maxWidth: '320px',
      fontFamily: 'Inter, sans-serif',
    });
    document.body.appendChild(toast);
  }
  const colours = { success: '#22d47e', error: '#ff5a5a', info: '#6c63ff' };
  toast.style.background = colours[type] || colours.info;
  toast.style.opacity = '1';
  toast.textContent = msg;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { toast.style.opacity = '0'; }, 3500);
}


// ── Enter key on URL field ─────────────────────────────────────────────────

document.getElementById('url-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') submitUrl();
});
