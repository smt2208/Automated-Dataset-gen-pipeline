/* ══════════════════════════════════════════════════════════════════
   app.js — Bengali AI Tutor Dataset Generator
   CU DataScience · Qwen 2.5 3B LoRA Pipeline
   ══════════════════════════════════════════════════════════════════

   Architecture:
     3 independent pipeline sections: CPT | SFT | DPO
     Each section has: PDF/DOCX · Web Scraping · Domain-Specific tabs
     DPO: Domain-Specific ONLY

   WebSocket flow (same backend):
     URL    → WS /ws/process { input_type:"url",  input_source: url,   ... }
     File   → POST /upload   → WS /ws/process { input_type:"pdf", ... }
     Domain → WS /ws/process { input_type:"domain", domain, subdomains, mode, ... }

   WS server messages:
     { type:"node_start",  node, label }
     { type:"node_done",   node, label }
     { type:"node_error",  node, message }
     { type:"error",       message }        ← fatal, stream ends
     { type:"completed",   pairs, files:{jsonl,hf,unsloth,excel} }
   ══════════════════════════════════════════════════════════════════ */

const API    = (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
                 ? `http://${location.host}` : '';
const WS_URL = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/process`;

// ── Global State ────────────────────────────────────────────────────────────
let ws           = null;
let isRunning    = false;
let downloadFiles = {};
let activeSection = null;   // 'cpt' | 'sft' | 'dpo'

// Per-section selected files
const selectedFiles = { cpt: null, sft: null };

// Per-section selected domains & subdomains
const selectedDomains = { cpt: null, sft: null, dpo: null };
const selectedSubdomains = { cpt: new Set(), sft: new Set(), dpo: new Set() };

// ── Domain Data ─────────────────────────────────────────────────────────────
const DOMAIN_DATA = {
  math: {
    label: '📐 Mathematics',
    subdomains: [
      { id: 'arithmetic',  label: 'Arithmetic (Class 1–12)',               desc: 'Basic operations, fractions, decimals, percentages' },
      { id: 'algebra',     label: 'Algebra — equations, polynomials',       desc: 'Linear & quadratic equations, factoring' },
      { id: 'geometry',    label: 'Geometry — proofs, mensuration',         desc: 'Shapes, area, volume, Euclidean proofs' },
      { id: 'statistics',  label: 'Statistics — mean, median, mode',        desc: 'Data analysis, probability, graphs' },
      { id: 'word_probs',  label: 'Word Problems (Tk/₹ context)',           desc: 'Real-world Bengali context — local prices, names' },
    ]
  },
  science: {
    label: '🔬 Science',
    subdomains: [
      { id: 'physics',    label: 'Physics — motion, force, light, electricity', desc: 'Key chapters for Class 6–12' },
      { id: 'chemistry',  label: 'Chemistry — elements, reactions',             desc: 'Periodic table, chemical equations, bonding' },
      { id: 'biology',    label: 'Biology — cells, human body, plants',         desc: 'Ecosystems, photosynthesis, nutrition' },
    ]
  },
  bengali_lang: {
    label: '📖 Bengali Language & Literature',
    subdomains: [
      { id: 'grammar',        label: 'ব্যাকরণ — সন্ধি, সমাস, কারক, বিভক্তি', desc: 'Bengali grammar rules and patterns' },
      { id: 'comprehension',  label: 'Comprehension passages',                   desc: 'Reading and understanding Bengali texts' },
      { id: 'essay',          label: 'রচনা — Essay writing',                     desc: 'Structured Bengali essay composition' },
      { id: 'literature',     label: 'Poem/Prose — Tagore, Nazrul, Sukumar Ray', desc: 'Famous Bengali literary works explained' },
    ]
  },
  social: {
    label: '🌍 Social Studies / Geography',
    subdomains: [
      { id: 'geo_wb',      label: 'Geography — West Bengal & World',          desc: 'Physical and political geography' },
      { id: 'history_bn',  label: 'Bengali & Indian History',                  desc: 'Pre-colonial to modern Indian history' },
      { id: 'world_hist',  label: 'World History',                             desc: 'Ancient, medieval, and modern world events' },
      { id: 'civics',      label: 'Civics — Government structure',             desc: 'Indian constitution, local governance' },
    ]
  }
};

// ── Default Prompts per section ──────────────────────────────────────────────
const DEFAULTS = {
  cpt: {
    model: 'gpt-5.4-mini',
    pairs: 500,
    system: `You are an expert Bengali corpus builder specialising in educational content for the Qwen 2.5 3B model. Your task is to generate fluent, natural Bengali raw text chunks that will be used for Continued Pre-Training (CPT). The text must be factually accurate, culturally appropriate, and written entirely in authentic Bengali (বাংলা). Avoid mixing English unnecessarily.`,
    human:  `Generate rich, diverse Bengali raw text passages based on the provided context or domain. The text should feel like it comes from authentic Bengali educational resources — textbooks, encyclopaedias, or well-written articles. Cover the topic comprehensively. Vary sentence structure and vocabulary. Write in a clear, educational register suitable for secondary students. Output only Bengali text, no meta-commentary.`,
  },
  sft: {
    model: 'gpt-5.4-mini',
    pairs: 200,
    system: `You are an expert curriculum designer and AI dataset creator specialising in the Bengali language. Your task is to extract and generate high-quality instruction–response pairs STRICTLY in Bengali from the provided content. These pairs will be used to fine-tune a Qwen 2.5 3B Bengali AI Tutor via Supervised Fine-Tuning (SFT). Each response should be that of an excellent, patient Bengali tutor — clear, step-by-step, encouraging, and pedagogically sound.`,
    human:  `Carefully analyse the following content and generate diverse instruction–response pairs in Bengali. Instructions must be varied (questions, fill-in, explain-this, solve-this, compare). Responses must be detailed, accurate, written in fluent Bengali, and demonstrate good teaching pedagogy. Prioritise QUALITY over quantity. Never include trivial or repetitive pairs.`,
  },
  dpo: {
    model: 'gpt-5.4-mini',
    pairs: 100,
    rejectionStyle: 'mixed',
    system: `You are an expert in Bengali educational AI alignment. Your task is to generate DPO (Direct Preference Optimization) training triples for a Bengali AI Tutor — Qwen 2.5 3B. Each triple must contain: (1) a Bengali student prompt, (2) a CHOSEN response that is pedagogically excellent, accurate, and fluent in Bengali, and (3) a REJECTED response that has clear flaws — bad teaching style, factual errors, or poor Bengali — as per the rejection strategy.`,
    human:  `Generate DPO preference triples in Bengali for the specified domain. The chosen response should exemplify an ideal Bengali tutor: clear explanation, step-by-step reasoning, culturally appropriate examples, encouraging tone. The rejected response should be plausibly wrong but noticeably inferior. Output as structured JSON with "prompt", "chosen", "rejected" fields. Ensure diversity across question types and difficulty levels.`,
  },
};

// Per-section live settings (copies of defaults, overridden by user)
const sectionSettings = {
  cpt: { ...DEFAULTS.cpt },
  sft: { ...DEFAULTS.sft },
  dpo: { ...DEFAULTS.dpo },
};

// Backend node → frontend step mapping
const NODE_STEP = {
  scrape_node:  'ps-extract',
  pdf_node:     'ps-extract',
  docx_node:    'ps-extract',
  ocr_node:     'ps-extract',
  text_node:    'ps-extract',
  domain_node:  'ps-extract',
  clean_node:   'ps-clean',
  openai_node:  'ps-openai',
  output_node:  'ps-output',
};
const ALL_STEPS = ['ps-input','ps-extract','ps-clean','ps-openai','ps-output'];


// ══════════════════════════════════════════════════════════════════
// TAB SWITCHING
// ══════════════════════════════════════════════════════════════════

function switchSubTab(section, tab) {
  // Deactivate all tabs in this section
  ['pdf','scrape','domain'].forEach(t => {
    const btn = document.getElementById(`${section}-tab-${t}`);
    if (btn) { btn.classList.remove('active'); btn.setAttribute('aria-selected', 'false'); }
    const content = document.getElementById(`${section}-content-${t}`);
    if (content) content.classList.remove('active');
  });
  // Activate selected
  const activeBtn = document.getElementById(`${section}-tab-${tab}`);
  if (activeBtn) { activeBtn.classList.add('active'); activeBtn.setAttribute('aria-selected', 'true'); }
  const activeContent = document.getElementById(`${section}-content-${tab}`);
  if (activeContent) activeContent.classList.add('active');
}


// ══════════════════════════════════════════════════════════════════
// FILE HANDLING
// ══════════════════════════════════════════════════════════════════

function handleDrop(event, section) {
  event.preventDefault();
  document.getElementById(`${section}-dropzone`).classList.remove('drag-over');
  const file = event.dataTransfer.files[0];
  if (file) setFile(file, section);
}

function handleFileSelect(event, section) {
  const file = event.target.files[0];
  if (file) setFile(file, section);
}

function setFile(file, section) {
  const ext = file.name.split('.').pop().toLowerCase();
  const allowed = ['pdf','docx','doc','txt'];
  if (!allowed.includes(ext)) {
    showToast('Unsupported file type. Use PDF, DOCX, DOC, or TXT.', 'error');
    return;
  }
  selectedFiles[section] = file;
  document.getElementById(`${section}-file-name`).textContent = file.name;
  document.getElementById(`${section}-file-selected`).classList.remove('hidden');
  if (!isRunning) { hideResult(); }
}


// ══════════════════════════════════════════════════════════════════
// DOMAIN SELECTION
// ══════════════════════════════════════════════════════════════════

function selectDomain(section, domainKey) {
  selectedDomains[section] = domainKey;
  selectedSubdomains[section] = new Set();

  // Highlight the selected card, deselect others
  const grid = document.querySelector(`#${section}-content-domain .domain-grid`);
  if (grid) {
    grid.querySelectorAll('.domain-card').forEach(c => {
      c.classList.toggle('selected', c.dataset.domain === domainKey);
    });
  }

  const domain = DOMAIN_DATA[domainKey];
  if (!domain) return;

  // Update detail panel title
  const titleEl = document.getElementById(`${section}-domain-title`);
  if (titleEl) titleEl.textContent = domain.label;

  // Render subdomain checkboxes — all pre-selected
  const listEl = document.getElementById(`${section}-subdomain-list`);
  if (listEl) {
    listEl.innerHTML = '';
    domain.subdomains.forEach(sub => {
      const item = document.createElement('div');
      item.className = 'subdomain-item selected';
      item.dataset.subId = sub.id;
      item.innerHTML = `
        <div class="subdomain-checkbox">
          <span class="subdomain-check-icon">✓</span>
        </div>
        <div style="flex:1;display:flex;flex-direction:column;gap:.1rem;">
          <span class="subdomain-text">${sub.label}</span>
          <span class="subdomain-desc">${sub.desc}</span>
        </div>
      `;
      item.addEventListener('click', () => toggleSubdomain(section, sub.id, item));
      listEl.appendChild(item);
      selectedSubdomains[section].add(sub.id);
    });
  }

  // Show detail panel, hide the cards grid
  document.getElementById(`${section}-domain-detail`).classList.remove('hidden');
  if (grid) grid.style.display = 'none';
}

function toggleSubdomain(section, subId, itemEl) {
  if (selectedSubdomains[section].has(subId)) {
    selectedSubdomains[section].delete(subId);
    itemEl.classList.remove('selected');
  } else {
    selectedSubdomains[section].add(subId);
    itemEl.classList.add('selected');
  }
}

function clearDomain(section) {
  selectedDomains[section] = null;
  selectedSubdomains[section] = new Set();

  document.getElementById(`${section}-domain-detail`).classList.add('hidden');
  const grid = document.querySelector(`#${section}-content-domain .domain-grid`);
  if (grid) {
    grid.style.display = '';
    grid.querySelectorAll('.domain-card').forEach(c => c.classList.remove('selected'));
  }
}


// ══════════════════════════════════════════════════════════════════
// SUBMIT GENERATION
// ══════════════════════════════════════════════════════════════════

async function submitGeneration(section, method) {
  if (isRunning) { showToast('A generation is already running. Please wait.', 'error'); return; }

  const settings = sectionSettings[section];
  const modeLabelMap = { cpt: 'CPT Pre-Training', sft: 'SFT Instruction', dpo: 'DPO Preference' };

  if (method === 'pdf') {
    const file = selectedFiles[section];
    if (!file) { showToast('Please select a file first.', 'error'); return; }
    await uploadAndRun(section, file, settings, modeLabelMap[section]);

  } else if (method === 'scrape') {
    const urlInput = document.getElementById(`${section}-url-input`);
    const url = urlInput ? urlInput.value.trim() : '';
    if (!url) { showToast('Please enter a URL.', 'error'); return; }
    try { new URL(url); } catch { showToast('Invalid URL — include https://', 'error'); return; }
    connectAndRun('url', url, settings, section, modeLabelMap[section]);

  } else if (method === 'domain') {
    const domain = selectedDomains[section];
    if (!domain) { showToast('Please select a domain first.', 'error'); return; }
    const subs = [...selectedSubdomains[section]];
    if (subs.length === 0) { showToast('Please select at least one sub-topic.', 'error'); return; }
    connectAndRun('domain', null, settings, section, modeLabelMap[section], { domain, subdomains: subs, mode: section });
  }
}

async function uploadAndRun(section, file, settings, modeLabel) {
  isRunning = true;
  activeSection = section;
  setWsBadge('connecting', 'Uploading…');
  showPipelinePanel(modeLabel);
  setInputsDisabled(true);

  const formData = new FormData();
  formData.append('file', file);

  try {
    const res = await fetch(`${API}/upload`, { method: 'POST', body: formData });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      showToast(err.detail || 'Upload failed.', 'error');
      unlockUI();
      return;
    }
    const { file_path, input_type } = await res.json();
    isRunning = false;
    connectAndRun(input_type, file_path, settings, section, modeLabel);
  } catch {
    showToast('Upload failed — backend unreachable.', 'error');
    unlockUI();
  }
}


// ══════════════════════════════════════════════════════════════════
// WEBSOCKET PIPELINE
// ══════════════════════════════════════════════════════════════════

function connectAndRun(inputType, inputSource, settings, section, modeLabel, extra = {}) {
  if (isRunning) return;
  isRunning   = true;
  activeSection = section;

  closeOldWs();
  resetPipeline();
  hideResult();
  setInputsDisabled(true);
  setWsBadge('connecting', 'Connecting…');
  showPipelinePanel(modeLabel);
  setStep('ps-input', 'active');

  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    setWsBadge('running', 'Running');
    setStep('ps-input', 'done');
    ws.send(JSON.stringify({
      input_type:    inputType,
      input_source:  inputSource,
      system_prompt: settings.system,
      human_prompt:  settings.human,
      model:         settings.model,
      target_pairs:  settings.pairs,
      pipeline_mode: section,          // 'cpt' | 'sft' | 'dpo'
      ...extra
    }));
  };

  ws.onmessage = evt => {
    try { handleWsMessage(JSON.parse(evt.data)); }
    catch (e) { console.error('WS parse error', e); }
  };

  ws.onerror = () => {
    setWsBadge('error', 'Error');
    showError('WebSocket error — is the backend running?');
    unlockUI();
  };

  ws.onclose = () => {
    unlockUI();
    const badge = document.getElementById('ws-status');
    if (badge && badge.classList.contains('running')) setWsBadge('idle', 'Idle');
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
      showToast(`✓ ${msg.pairs} pairs generated successfully!`, 'success');
      break;
    default:
      break;
  }
}


// ══════════════════════════════════════════════════════════════════
// PIPELINE UI HELPERS
// ══════════════════════════════════════════════════════════════════

function showPipelinePanel(modeLabel) {
  const panel = document.getElementById('status-panel');
  const label = document.getElementById('active-pipeline-label');
  panel.style.display = '';
  panel.classList.remove('hidden');
  if (label) label.textContent = modeLabel;
}

function resetPipeline() {
  ALL_STEPS.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.className = 'pipe-step';
    el.querySelector('.pipe-state').textContent = '—';
  });
  const nameEl = document.getElementById('ps-extract-name');
  if (nameEl) nameEl.textContent = 'Reading Content';
}

function setStep(stepId, state, label = null) {
  const el = document.getElementById(stepId);
  if (!el) return;
  el.className = `pipe-step ${state}`;
  const stateLabels = { active: 'Processing…', done: 'Done ✓', error: 'Failed ✗' };
  el.querySelector('.pipe-state').textContent = stateLabels[state] || '—';
  if (label && stepId === 'ps-extract') {
    const n = document.getElementById('ps-extract-name');
    if (n) n.textContent = label;
  }
}

function setWsBadge(state, text) {
  const el = document.getElementById('ws-status');
  el.className = `ws-badge ${state}`;
  el.textContent = `● ${text}`;
}

function unlockUI() {
  isRunning = false;
  setInputsDisabled(false);
}

function closeOldWs() {
  if (ws) {
    ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
    if (ws.readyState < 2) ws.close();
    ws = null;
  }
}

function setInputsDisabled(disabled) {
  const btns = document.querySelectorAll('.btn-generate');
  btns.forEach(btn => {
    btn.disabled = disabled;
    const t = btn.querySelector('.btn-text');
    if (!t) return;
    if (disabled) {
      // Save current label before overwriting
      if (!btn.dataset.originalText) btn.dataset.originalText = t.textContent;
      t.textContent = 'Running…';
    } else {
      // Restore saved label, fall back to inner text
      t.textContent = btn.dataset.originalText || t.textContent;
    }
  });
}


// ══════════════════════════════════════════════════════════════════
// RESULT PANEL
// ══════════════════════════════════════════════════════════════════

function showSuccess(pairs, files) {
  document.getElementById('stat-pairs').textContent = pairs;

  const sectionLabelMap = {
    cpt: 'Raw text chunks (CPT)',
    sft: 'Instruction–response pairs (SFT)',
    dpo: 'Preference triples (DPO)',
  };
  const labelEl = document.getElementById('stat-pairs-label');
  if (labelEl) labelEl.textContent = sectionLabelMap[activeSection] || 'Dataset pairs generated';

  const fmt = (id, key) => document.getElementById(id).classList.toggle('hidden', !files[key]);
  fmt('btn-dl-jsonl',   'jsonl');
  fmt('btn-dl-hf',      'hf');
  fmt('btn-dl-unsloth', 'unsloth');
  fmt('btn-dl-excel',   'excel');

  document.getElementById('result-success').classList.remove('hidden');
  document.getElementById('result-error').classList.add('hidden');
  document.getElementById('result-panel').classList.remove('hidden');

  // Smooth scroll to result
  setTimeout(() => document.getElementById('result-panel').scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 150);
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
  closeOldWs();
  resetPipeline();
  hideResult();
  downloadFiles  = {};
  isRunning      = false;
  activeSection  = null;

  // Reset all file inputs
  ['cpt','sft'].forEach(sec => {
    selectedFiles[sec] = null;
    const fi = document.getElementById(`${sec}-file-input`);
    if (fi) fi.value = '';
    const fs = document.getElementById(`${sec}-file-selected`);
    if (fs) fs.classList.add('hidden');
    const fn = document.getElementById(`${sec}-file-name`);
    if (fn) fn.textContent = '—';
  });

  // Reset URL inputs
  ['cpt','sft'].forEach(sec => {
    const ui = document.getElementById(`${sec}-url-input`);
    if (ui) ui.value = '';
  });

  // Reset domains
  ['cpt','sft','dpo'].forEach(sec => clearDomain(sec));

  // Hide pipeline panel
  const panel = document.getElementById('status-panel');
  if (panel) panel.style.display = 'none';

  setWsBadge('idle', 'Idle');
  setInputsDisabled(false);
  showToast('Ready for a new generation!', 'info');
}


// ══════════════════════════════════════════════════════════════════
// DOWNLOAD
// ══════════════════════════════════════════════════════════════════

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


// ══════════════════════════════════════════════════════════════════
// SETTINGS MODALS
// ══════════════════════════════════════════════════════════════════

function openSectionSettings(section) {
  const s = sectionSettings[section];
  // Populate form fields
  _setVal(`${section}-model-select`, s.model);
  _setVal(`${section}-pairs-count`, s.pairs);
  _setVal(`${section}-system-prompt`, s.system);
  _setVal(`${section}-human-prompt`, s.human);
  if (section === 'dpo') _setVal('dpo-rejection-style', s.rejectionStyle || 'mixed');

  document.getElementById(`modal-${section}`).classList.add('active');
}

function closeSectionSettings(section) {
  document.getElementById(`modal-${section}`).classList.remove('active');
}

function saveSectionSettings(section) {
  const model  = document.getElementById(`${section}-model-select`).value;
  const pairs  = parseInt(document.getElementById(`${section}-pairs-count`).value, 10);
  const system = document.getElementById(`${section}-system-prompt`).value.trim();
  const human  = document.getElementById(`${section}-human-prompt`).value.trim();

  sectionSettings[section].model  = model  || DEFAULTS[section].model;
  sectionSettings[section].pairs  = isNaN(pairs) ? DEFAULTS[section].pairs : pairs;
  sectionSettings[section].system = system || DEFAULTS[section].system;
  sectionSettings[section].human  = human  || DEFAULTS[section].human;

  if (section === 'dpo') {
    sectionSettings[section].rejectionStyle =
      document.getElementById('dpo-rejection-style').value || 'mixed';
  }

  closeSectionSettings(section);
  showToast(`${section.toUpperCase()} settings saved!`, 'success');
}

function resetSectionDefaults(section) {
  const d = DEFAULTS[section];
  _setVal(`${section}-model-select`, d.model);
  _setVal(`${section}-pairs-count`, d.pairs);
  _setVal(`${section}-system-prompt`, d.system);
  _setVal(`${section}-human-prompt`, d.human);
  if (section === 'dpo') _setVal('dpo-rejection-style', 'mixed');
  showToast(`${section.toUpperCase()} settings reset to defaults.`, 'info');
}

// Init: populate all settings textareas with defaults
(function initSettings() {
  ['cpt','sft','dpo'].forEach(sec => {
    const d = DEFAULTS[sec];
    _setVal(`${sec}-system-prompt`, d.system);
    _setVal(`${sec}-human-prompt`, d.human);
  });
})();

function _setVal(id, val) {
  const el = document.getElementById(id);
  if (el) el.value = val;
}


// ══════════════════════════════════════════════════════════════════
// STEPPER HIGHLIGHT (scroll-based)
// ══════════════════════════════════════════════════════════════════

function updateStepper() {
  const sections = ['cpt','sft','dpo'];
  let current = 'cpt';
  sections.forEach(sec => {
    const el = document.getElementById(`section-${sec}`);
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.top < window.innerHeight * 0.55) current = sec;
  });
  sections.forEach(sec => {
    const step = document.getElementById(`stepper-${sec}`);
    if (step) step.classList.toggle('active', sec === current);
  });
}
window.addEventListener('scroll', updateStepper, { passive: true });
updateStepper();


// ══════════════════════════════════════════════════════════════════
// TOAST
// ══════════════════════════════════════════════════════════════════

function showToast(msg, type = 'info') {
  let toast = document.getElementById('_toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = '_toast';
    Object.assign(toast.style, {
      position: 'fixed', bottom: '1.5rem', right: '1.5rem',
      padding: '.75rem 1.2rem', borderRadius: '10px',
      fontSize: '.83rem', fontWeight: '600', color: '#fff',
      zIndex: '999', boxShadow: '0 4px 24px rgba(0,0,0,.5)',
      transition: 'opacity .3s, transform .3s', maxWidth: '340px',
      fontFamily: 'Inter, sans-serif', lineHeight: '1.4',
    });
    document.body.appendChild(toast);
  }
  const colours = { success: '#22d47e', error: '#ff5a5a', info: '#6c63ff' };
  toast.style.background  = colours[type] || colours.info;
  toast.style.opacity     = '1';
  toast.style.transform   = 'translateY(0)';
  toast.textContent = msg;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { toast.style.opacity = '0'; toast.style.transform = 'translateY(8px)'; }, 3500);
}


// ══════════════════════════════════════════════════════════════════
// URL ENTER KEY
// ══════════════════════════════════════════════════════════════════

['cpt','sft'].forEach(sec => {
  const el = document.getElementById(`${sec}-url-input`);
  if (el) el.addEventListener('keydown', e => { if (e.key === 'Enter') submitGeneration(sec, 'scrape'); });
});
