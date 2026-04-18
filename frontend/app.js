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
let isRunning     = false;  // prevents double-submits and stuck UI

// ── Default Prompts (Mirror of backend) ──────────────────────────────────
const DEFAULT_SYSTEM_PROMPT = "You are an expert curriculum designer and AI dataset creator specialising in the Bengali language. Your task is to extract high-quality, diverse instruction-response pairs STRICTLY in the Bengali language from the provided document context. Create pairs that are suitable for fine-tuning a Qwen 2.5 3B model on Bengali understanding and generation. The pairs must be fluent, culturally appropriate, factually accurate, and logically derived from the text.";
const DEFAULT_HUMAN_PROMPT = "Carefully analyse the following document and understand its core themes, key facts, and overall domain.\n\nBased firmly on this text, generate instruction-response pairs in Bengali that offer balanced and comprehensive coverage of the material. Your absolute priority is QUALITY over quantity — avoid trivial or repetitive pairs. Instructions must be naturally phrased and varied (questions, tasks, fill-in, explanations, etc.). Responses must be highly accurate, fluent in Bengali, and sufficiently detailed to train a premium model.";

let customSystemPrompt = DEFAULT_SYSTEM_PROMPT;
let customHumanPrompt  = DEFAULT_HUMAN_PROMPT;

// Mapping: backend node name → frontend step <div> id
// Multiple backend nodes map to the same visual step (ps-extract)
const NODE_STEP = {
  scrape_node:  'ps-extract',
  pdf_node:     'ps-extract',
  ocr_node:     'ps-extract',
  text_node:    'ps-extract',
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

  // Only clear results if we are not mid-generation
  if (!isRunning) {
    resetPipeline();
    hideResult();
    setWsBadge('idle', 'Idle');
  }
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
  const allowed = ['application/pdf', 'image/png', 'image/jpeg', 'image/jpg', 'text/plain'];
  // Also check by extension since .txt MIME type can vary across browsers
  const ext = file.name.split('.').pop().toLowerCase();
  if (!allowed.includes(file.type) && !['pdf','png','jpg','jpeg','txt'].includes(ext)) {
    showToast('Unsupported type. Use PDF, PNG, JPG, or TXT.', 'error');
    return;
  }
  selectedFile = file;
  document.getElementById('file-name-label').textContent = file.name;
  document.getElementById('file-selected').classList.remove('hidden');

  // Clear old pipeline state only if not mid-generation
  if (!isRunning) {
    resetPipeline();
    hideResult();
    setWsBadge('idle', 'Ready');
  }
}


// ── Pipeline UI helpers ────────────────────────────────────────────────────

function resetPipeline() {
  ALL_STEPS.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.className = 'pipe-step';
    el.querySelector('.pipe-state').textContent = '—';
  });
  const nameEl = document.getElementById('ps-extract-name');
  if (nameEl) nameEl.textContent = 'Extraction';
  // NOTE: do NOT touch `ws` or `isRunning` here — managed by connectAndRun/unlock
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

function _unlockUI() {
  isRunning = false;
  setInputsDisabled(false);
}

function _closeOldWs() {
  if (ws) {
    // Detach handlers first so onclose doesn't fire on the OLD ws and unlock prematurely
    ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
    if (ws.readyState < 2) ws.close();
    ws = null;
  }
}

function connectAndRun(inputType, inputSource) {
  if (isRunning) return;   // block double-submits
  isRunning = true;

  _closeOldWs();
  resetPipeline();
  hideResult();
  setInputsDisabled(true);
  setWsBadge('connecting', 'Connecting…');
  setStep('ps-input', 'active');

  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    setWsBadge('running', 'Running');
    setStep('ps-input', 'done');
    ws.send(JSON.stringify({
      input_type:   inputType,
      input_source: inputSource,
      system_prompt: customSystemPrompt,
      human_prompt:  customHumanPrompt
    }));
  };

  ws.onmessage = (evt) => {
    try { handleWsMessage(JSON.parse(evt.data)); }
    catch (e) { console.error('WS parse error', e); }
  };

  ws.onerror = () => {
    setWsBadge('error', 'Error');
    showError('WebSocket error — is the backend running?');
    _unlockUI();
  };

  ws.onclose = () => {
    // Always unlock whenever the socket closes (success, error, or server-side close)
    _unlockUI();
    // If badge is still "Running" it means server closed without sending completed
    const badge = document.getElementById('ws-status');
    if (badge && badge.classList.contains('running')) {
      setWsBadge('idle', 'Idle');
    }
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

function resetForNewGeneration() {
  // Cleanly close any lingering WS without triggering any state handlers
  _closeOldWs();
  // Reset UI
  resetPipeline();
  hideResult();
  downloadFiles = {};
  selectedFile  = null;
  isRunning     = false;
  // Clear the file input so the same file can be re-selected
  const fi = document.getElementById('file-input');
  if (fi) fi.value = '';
  document.getElementById('file-selected').classList.add('hidden');
  document.getElementById('file-name-label').textContent = '—';
  // Clear URL input
  document.getElementById('url-input').value = '';
  setWsBadge('idle', 'Idle');
  setInputsDisabled(false);
  showToast('Ready for a new generation!', 'info');
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


// ── Settings Modal Handlers ────────────────────────────────────────────────

function openSettings() {
  document.getElementById('prompt-system').value = customSystemPrompt;
  document.getElementById('prompt-human').value  = customHumanPrompt;
  document.getElementById('settings-modal').classList.add('active');
}

function closeSettings() {
  document.getElementById('settings-modal').classList.remove('active');
}

function resetPromptsToDefault() {
  document.getElementById('prompt-system').value = DEFAULT_SYSTEM_PROMPT;
  document.getElementById('prompt-human').value  = DEFAULT_HUMAN_PROMPT;
}

function saveSettings() {
  const sysObj = document.getElementById('prompt-system').value.trim();
  const humObj = document.getElementById('prompt-human').value.trim();

  customSystemPrompt = sysObj || DEFAULT_SYSTEM_PROMPT;
  customHumanPrompt  = humObj || DEFAULT_HUMAN_PROMPT;
  
  closeSettings();
  showToast("Prompt settings saved!", "success");
}

// Close settings when clicking on the overlay shadow
document.getElementById('settings-modal').addEventListener('click', e => {
  if (e.target.id === 'settings-modal') closeSettings();
});
