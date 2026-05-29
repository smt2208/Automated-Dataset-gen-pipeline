/* ══════════════════════════════════════════════════════════════════
   app.js — Bengali Fine-Tuning Dataset Generator (SPA)
   ══════════════════════════════════════════════════════════════════

   Architecture:
     Hash-based SPA:  #home | #cpt | #sft | #dpo
     Each mode page has its own pipeline tracker, result panel, sub-tabs

   WebSocket flow (unchanged backend):
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


// ══════════════════════════════════════════════════════════════════
// HASH ROUTER
// ══════════════════════════════════════════════════════════════════

const PAGES = ['home', 'cpt', 'sft', 'dpo'];

function route() {
  const hash = (location.hash || '#home').replace('#', '');
  const page = PAGES.includes(hash) ? hash : 'home';

  // Show/hide pages
  PAGES.forEach(p => {
    const el = document.getElementById(`page-${p}`);
    if (el) el.classList.toggle('active', p === page);
  });

  // Update navbar links
  document.querySelectorAll('.nav-link').forEach(link => {
    link.classList.toggle('active', link.dataset.page === page);
  });

  // Scroll to top on page change
  window.scrollTo(0, 0);
}

window.addEventListener('hashchange', route);
window.addEventListener('DOMContentLoaded', route);
// Also run immediately in case DOMContentLoaded already fired
route();


// ══════════════════════════════════════════════════════════════════
// GLOBAL STATE
// ══════════════════════════════════════════════════════════════════

let ws           = null;
let isRunning    = false;
let downloadFiles = {};
let activeSection = null;   // 'cpt' | 'sft' | 'dpo'

// Per-section selected files
const selectedFiles = { cpt: null, sft: null };

// Per-section selected domains & subdomains
const selectedDomains = { cpt: null, sft: null, dpo: null };
const selectedSubdomains = { cpt: new Set(), sft: new Set(), dpo: new Set() };


// ── Domain Data ─────────────────────────────────────────────────
const DOMAIN_DATA = {
  math: {
    label: '📐 Mathematics',
    subdomains: [
      { id: 'arithmetic',    label: 'Arithmetic (Class 1–12)',                  desc: 'Basic operations, fractions, decimals, percentages' },
      { id: 'algebra',       label: 'Algebra — equations, polynomials',         desc: 'Linear & quadratic equations, factoring' },
      { id: 'geometry',      label: 'Geometry — proofs, mensuration',           desc: 'Shapes, area, volume, Euclidean proofs' },
      { id: 'trigonometry',  label: 'Trigonometry — ratios, identities',        desc: 'Heights & distances, trigonometric identities' },
      { id: 'statistics',    label: 'Statistics — mean, median, probability',   desc: 'Data analysis, probability, graphs' },
      { id: 'calculus',      label: 'Calculus (Class 11–12)',                   desc: 'Differentiation, integration, limits' },
      { id: 'set_theory',    label: 'Set Theory — Venn diagrams, relations',    desc: 'Sets, subsets, unions, intersections' },
      { id: 'number_theory', label: 'Number Theory — primes, HCF, LCM',        desc: 'Divisibility, prime factorization, modular arithmetic' },
      { id: 'word_probs',    label: 'Word Problems (Tk/₹ context)',             desc: 'Real-world Bengali context — local prices, names' },
    ]
  },
  science: {
    label: '🔬 Science',
    subdomains: [
      { id: 'physics',      label: 'Physics — motion, force, light, electricity', desc: 'Key chapters for Class 6–12' },
      { id: 'chemistry',    label: 'Chemistry — elements, reactions',              desc: 'Periodic table, chemical equations, bonding' },
      { id: 'biology',      label: 'Biology — cells, human body, plants',          desc: 'Ecosystems, photosynthesis, nutrition' },
      { id: 'env_science',  label: 'Environmental Science',                        desc: 'Pollution, conservation, climate change' },
      { id: 'astronomy',    label: 'Astronomy — solar system, stars',              desc: 'Space science, celestial bodies, ISRO' },
    ]
  },
  bengali_lang: {
    label: '📖 Bengali Language & Literature',
    subdomains: [
      { id: 'grammar',        label: 'ব্যাকরণ — সন্ধি, সমাস, কারক, বিভক্তি',  desc: 'Bengali grammar rules and patterns' },
      { id: 'comprehension',  label: 'Comprehension passages',                     desc: 'Reading and understanding Bengali texts' },
      { id: 'essay',          label: 'রচনা / প্রবন্ধ — Essay writing',            desc: 'Structured Bengali essay composition' },
      { id: 'literature',     label: 'Poem/Prose — Tagore, Nazrul, Sukumar Ray',   desc: 'Famous Bengali literary works explained' },
      { id: 'letter',         label: 'চিঠি / আবেদনপত্র — Letter writing',         desc: 'Formal & informal letter/application formats' },
      { id: 'translation',    label: 'অনুবাদ — Translation (En ↔ Bn)',             desc: 'English to Bengali and Bengali to English' },
      { id: 'report',         label: 'প্রতিবেদন / সংলাপ — Report & Dialogue',     desc: 'Report writing and dialogue composition' },
    ]
  },
  social: {
    label: '🌍 Social Studies / Geography',
    subdomains: [
      { id: 'geo_wb',          label: 'Geography — West Bengal & World',           desc: 'Physical and political geography' },
      { id: 'history_bn',      label: 'Bengali & Indian History',                  desc: 'Pre-colonial to modern Indian history' },
      { id: 'world_hist',      label: 'World History',                             desc: 'Ancient, medieval, and modern world events' },
      { id: 'civics',          label: 'Civics — Government structure',             desc: 'Indian constitution, local governance' },
      { id: 'economics',       label: 'Basic Economics',                           desc: 'Demand, supply, banking, Indian economy' },
      { id: 'current_affairs', label: 'Current Affairs — Bengal & India',           desc: 'Recent events, schemes, policy updates' },
      { id: 'env_studies',     label: 'Environmental Studies',                     desc: 'Sustainability, ecology, SDGs' },
    ]
  },
  ict: {
    label: '🖥️ ICT / Computer Science',
    subdomains: [
      { id: 'digital_lit',  label: 'Digital Literacy',                            desc: 'Internet basics, email, office tools' },
      { id: 'programming',  label: 'Programming Basics — Python, algorithms',     desc: 'Flowcharts, loops, functions, data types' },
      { id: 'data_struct',  label: 'Data Structures',                             desc: 'Arrays, lists, sorting, searching' },
      { id: 'networking',   label: 'Networking & Cyber Safety',                   desc: 'Protocols, internet safety, online privacy' },
    ]
  },
  reasoning: {
    label: '🧩 Reasoning & Mental Ability',
    subdomains: [
      { id: 'logical',       label: 'Logical Reasoning',                          desc: 'Syllogisms, Venn diagrams, puzzles' },
      { id: 'number_series', label: 'Number & Pattern Series',                    desc: 'Sequences, analogies, missing numbers' },
      { id: 'verbal',        label: 'Verbal Reasoning',                           desc: 'Coding-decoding, blood relations, directions' },
      { id: 'non_verbal',    label: 'Non-Verbal Reasoning',                       desc: 'Figure completion, mirror image, paper folding' },
    ]
  }
};


// ── Default Prompts per section ──────────────────────────────────
const DEFAULTS = {
  cpt: {
    model: 'gpt-5.4-mini',
    pairs: 50,
    reasoning: 'low',
    system: `You are an expert Bengali language corpus architect. Your task is to generate high-quality, natural Bengali (বাংলা) raw text passages for Continued Pre-Training (CPT) of a language model that will serve as a Bengali AI tutor.\n\nQuality Standards:\n• Write entirely in authentic, fluent Bengali — avoid unnecessary English mixing unless it is natural in the educational context (e.g., technical terms like 'DNA', 'algorithm').\n• Content must be factually accurate, well-structured, and pedagogically sound.\n• Use diverse writing styles: expository, narrative, dialogic (teacher-student conversation), and analytical.\n• Target Class 6–12 students across West Bengal and Bangladesh curricula.\n• Include culturally grounded examples: local names, prices in ₹/৳, Bengali festivals, geography, and historical references.\n• Vary sentence length and complexity — mix simple explanations with advanced academic prose.`,
    human: `Generate rich, diverse Bengali raw text passages based on the provided context. Each passage should feel like it comes from an authentic Bengali educational resource — a textbook chapter, encyclopedia entry, well-written magazine article, or a teacher's detailed explanation.\n\nRequirements:\n1. Cover the topic comprehensively with depth and accuracy.\n2. Use varied registers: some passages formal/academic, others conversational/explanatory.\n3. Include specific examples, numbers, and facts grounded in Bengali/South Asian context.\n4. Naturally integrate subject-specific terminology (transliterated English terms are acceptable where standard in Bengali education).\n5. Output only Bengali text — no meta-commentary, headers, or labels.`,
  },
  sft: {
    model: 'gpt-5.4-mini',
    pairs: 50,
    reasoning: 'low',
    crossLingual: false,
    system: `You are an expert AI dataset creator building Supervised Fine-Tuning (SFT) data for a Bengali AI Tutor. The tutor must become pedagogically excellent, patient, and culturally aligned with Bengali students (Class 6–12, West Bengal & Bangladesh curricula).\n\nData Quality Standards:\n• Generate instruction-input-output triples following the Alpaca schema.\n• The 'output' field MUST demonstrate expert-level Chain-of-Thought (CoT) reasoning — show step-by-step thinking, not just final answers.\n• Ensure maximum diversity in task types: conceptual explanation, problem solving, step-by-step derivation, multiple-choice with reasoning, summarization, comparison, error correction, translation, creative writing, and real-world application.\n• Use authentic Bengali throughout with culturally appropriate examples (local names, ₹/৳ prices, NCTB/WBBSE references).\n• Vary difficulty from basic (Class 6) to advanced (Class 12 / competitive exam level).\n\nINPUT FIELD REQUIREMENT: For at least 30–40% of the items, the 'input' field MUST contain meaningful supplementary context — a passage to analyze, a table of data, a code snippet, a problem statement, or reference material that the instruction refers to. Do NOT leave the 'input' field empty for every item.`,
    human: `Based on the provided context, generate a diverse set of instruction-input-output triples:\n- instruction: The core task or question (in Bengali).\n- input: Additional context for the task — a passage, data, or reference material. Fill this for 30–40% of items; leave blank only when the instruction is fully self-contained.\n- output: Detailed Bengali response with clear Chain-of-Thought reasoning.\n\nTask Diversity (cover as many as possible):\n• Conceptual explanation ('এটা কী?', 'ব্যাখ্যা করো')\n• Problem solving with step-by-step working\n• Multiple-choice with elimination reasoning\n• Summarization of passages or concepts\n• Compare & contrast between related concepts\n• Error identification & correction\n• Real-world application problems (Bengali context)`,
  },
  dpo: {
    model: 'gpt-5.4-mini',
    pairs: 50,
    reasoning: 'low',
    crossLingual: false,
    rejectionStyle: 'mixed',
    system: `You are an expert in AI alignment for Bengali education. Your task is to generate DPO (Direct Preference Optimization) training triples for a Bengali AI Tutor. Each triple trains the model to prefer high-quality responses over flawed ones.\n\nTriple Structure:\n• prompt: A student question or task (in Bengali).\n• chosen: The ideal tutor response — pedagogically excellent, accurate, fluent Bengali, encouraging tone, step-by-step reasoning, culturally appropriate examples.\n• rejected: A plausibly written but clearly inferior response with specific flaws.\n\nRejection Flaws (vary across these categories):\n1. Pedagogical: Skips steps, gives answer without explanation, condescending tone.\n2. Factual: Contains incorrect facts, wrong formulas, misleading information.\n3. Linguistic: Poor Bengali grammar, excessive English mixing, unnatural phrasing.\n4. Structural: Disorganized, no clear reasoning flow, missing key steps, too brief.\n\nQuality Standard: The difference between chosen and rejected must be clear and educational — a human annotator should immediately see why 'chosen' is better.`,
    human: `Generate DPO preference triples for the specified domain:\n- prompt: A student question (in Bengali)\n- chosen: The ideal Bengali tutor response with clear reasoning and step-by-step explanation\n- rejected: A plausibly written but flawed Bengali response\n\nEnsure diversity across:\n• Question types (conceptual, computational, analytical, creative)\n• Difficulty levels (basic to advanced)\n• Rejection strategies (pedagogical flaws, factual errors, poor Bengali, structural problems)\n\nThe chosen response should exemplify an ideal Bengali tutor with step-by-step reasoning. The rejected response should be noticeably inferior but not obviously garbage.`,
  },
};

// Per-section live settings (copies of defaults, overridden by user)
const sectionSettings = {
  cpt: { ...DEFAULTS.cpt },
  sft: { ...DEFAULTS.sft },
  dpo: { ...DEFAULTS.dpo },
};

// Backend node → per-section pipeline step mapping
const NODE_STEP_SUFFIX = {
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
const STEP_SUFFIXES = ['ps-input','ps-extract','ps-clean','ps-openai','ps-output'];


// ══════════════════════════════════════════════════════════════════
// TAB SWITCHING
// ══════════════════════════════════════════════════════════════════

function switchSubTab(section, tab) {
  ['pdf','scrape','domain'].forEach(t => {
    const btn = document.getElementById(`${section}-tab-${t}`);
    if (btn) { btn.classList.remove('active'); btn.setAttribute('aria-selected', 'false'); }
    const content = document.getElementById(`${section}-content-${t}`);
    if (content) content.classList.remove('active');
  });
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
  if (!isRunning) { hideResult(section); }
}


// ══════════════════════════════════════════════════════════════════
// DOMAIN SELECTION
// ══════════════════════════════════════════════════════════════════

function selectDomain(section, domainKey) {
  selectedDomains[section] = domainKey;
  selectedSubdomains[section] = new Set();

  const grid = document.querySelector(`#${section}-content-domain .domain-grid`);
  if (grid) {
    grid.querySelectorAll('.domain-card').forEach(c => {
      c.classList.toggle('selected', c.dataset.domain === domainKey);
    });
  }

  const domain = DOMAIN_DATA[domainKey];
  if (!domain) return;

  const titleEl = document.getElementById(`${section}-domain-title`);
  if (titleEl) titleEl.textContent = domain.label;

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

  if (method === 'pdf') {
    const file = selectedFiles[section];
    if (!file) { showToast('Please select a file first.', 'error'); return; }
    await uploadAndRun(section, file, settings);

  } else if (method === 'scrape') {
    const urlInput = document.getElementById(`${section}-url-input`);
    const url = urlInput ? urlInput.value.trim() : '';
    if (!url) { showToast('Please enter a URL.', 'error'); return; }
    try { new URL(url); } catch { showToast('Invalid URL — include https://', 'error'); return; }
    connectAndRun('url', url, settings, section);

  } else if (method === 'domain') {
    const domain = selectedDomains[section];
    if (!domain) { showToast('Please select a domain first.', 'error'); return; }
    const subs = [...selectedSubdomains[section]];
    if (subs.length === 0) { showToast('Please select at least one sub-topic.', 'error'); return; }
    connectAndRun('domain', null, settings, section, { domain, subdomains: subs, mode: section });
  }
}

async function uploadAndRun(section, file, settings) {
  isRunning = true;
  activeSection = section;
  setWsBadge('connecting', 'Uploading…');
  showPipeline(section);
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
    connectAndRun(input_type, file_path, settings, section);
  } catch {
    showToast('Upload failed — backend unreachable.', 'error');
    unlockUI();
  }
}


// ══════════════════════════════════════════════════════════════════
// WEBSOCKET PIPELINE
// ══════════════════════════════════════════════════════════════════

function connectAndRun(inputType, inputSource, settings, section, extra = {}) {
  if (isRunning) return;
  isRunning   = true;
  activeSection = section;

  closeOldWs();
  resetPipeline(section);
  hideResult(section);
  setInputsDisabled(true);
  setWsBadge('connecting', 'Connecting…');
  showPipeline(section);
  setStep(section, 'ps-input', 'active');

  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    setWsBadge('running', 'Running');
    setStep(section, 'ps-input', 'done');
    ws.send(JSON.stringify({
      input_type:    inputType,
      input_source:  inputSource,
      system_prompt: settings.system,
      human_prompt:  settings.human,
      model:         settings.model,
      target_pairs:  settings.pairs,
      reasoning_effort: settings.reasoning,
      cross_lingual: settings.crossLingual || false,
      pipeline_mode: section,
      ...extra
    }));
  };

  ws.onmessage = evt => {
    try { handleWsMessage(JSON.parse(evt.data)); }
    catch (e) { console.error('WS parse error', e); }
  };

  ws.onerror = () => {
    setWsBadge('error', 'Error');
    showError(section, 'WebSocket error — is the backend running?');
    unlockUI();
  };

  ws.onclose = () => {
    unlockUI();
    const badge = document.getElementById('ws-status');
    if (badge && badge.classList.contains('running')) setWsBadge('idle', 'Idle');
  };
}

function handleWsMessage(msg) {
  const sec = activeSection;
  if (!sec) return;

  const stepSuffix = NODE_STEP_SUFFIX[msg.node];
  switch (msg.type) {
    case 'node_start':
      if (stepSuffix) setStep(sec, stepSuffix, 'active', msg.label);
      break;
    case 'node_done':
      if (stepSuffix) setStep(sec, stepSuffix, 'done');
      break;
    case 'node_error':
      if (stepSuffix) setStep(sec, stepSuffix, 'error');
      break;
    case 'error':
      setWsBadge('error', 'Failed');
      showError(sec, msg.message || 'An unknown pipeline error occurred.');
      break;
    case 'completed':
      setWsBadge('done', 'Done');
      downloadFiles = msg.files || {};
      showSuccess(sec, msg.pairs, msg.files);
      showToast(`✓ ${msg.pairs} pairs generated successfully!`, 'success');
      break;
    default:
      break;
  }
}


// ══════════════════════════════════════════════════════════════════
// PIPELINE UI HELPERS (per-section)
// ══════════════════════════════════════════════════════════════════

function showPipeline(section) {
  const panel = document.getElementById(`${section}-pipeline`);
  if (panel) panel.classList.remove('hidden');
}

function resetPipeline(section) {
  STEP_SUFFIXES.forEach(suffix => {
    const el = document.getElementById(`${section}-${suffix}`);
    if (!el) return;
    el.className = 'pipe-step';
    const stateEl = el.querySelector('.pipe-state');
    if (stateEl) stateEl.textContent = '—';
  });
  const nameEl = document.getElementById(`${section}-ps-extract-name`);
  if (nameEl) nameEl.textContent = 'Reading Content';
}

function setStep(section, stepSuffix, state, label = null) {
  const el = document.getElementById(`${section}-${stepSuffix}`);
  if (!el) return;
  el.className = `pipe-step ${state}`;
  const stateLabels = { active: 'Processing…', done: 'Done ✓', error: 'Failed ✗' };
  const stateEl = el.querySelector('.pipe-state');
  if (stateEl) stateEl.textContent = stateLabels[state] || '—';
  if (label && stepSuffix === 'ps-extract') {
    const n = document.getElementById(`${section}-ps-extract-name`);
    if (n) n.textContent = label;
  }
}

function setWsBadge(state, text) {
  const el = document.getElementById('ws-status');
  if (!el) return;
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
      if (!btn.dataset.originalText) btn.dataset.originalText = t.textContent;
      t.textContent = 'Running…';
    } else {
      t.textContent = btn.dataset.originalText || t.textContent;
    }
  });
}


// ══════════════════════════════════════════════════════════════════
// RESULT PANEL (per-section)
// ══════════════════════════════════════════════════════════════════

function showSuccess(section, pairs, files) {
  const pairsEl = document.getElementById(`${section}-stat-pairs`);
  if (pairsEl) pairsEl.textContent = pairs;

  const sectionLabelMap = {
    cpt: 'Raw text chunks (CPT)',
    sft: 'Instruction–input–output pairs (SFT)',
    dpo: 'Preference triples (DPO)',
  };
  const labelEl = document.getElementById(`${section}-stat-label`);
  if (labelEl) labelEl.textContent = sectionLabelMap[section] || 'Dataset pairs generated';

  const fmt = (id, key) => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('hidden', !files[key]);
  };
  fmt(`${section}-btn-dl-jsonl`,   'jsonl');
  fmt(`${section}-btn-dl-hf`,      'hf');
  fmt(`${section}-btn-dl-unsloth`, 'unsloth');
  fmt(`${section}-btn-dl-excel`,   'excel');

  const successEl = document.getElementById(`${section}-result-success`);
  const errorEl   = document.getElementById(`${section}-result-error`);
  const panelEl   = document.getElementById(`${section}-result-panel`);

  if (successEl) successEl.classList.remove('hidden');
  if (errorEl)   errorEl.classList.add('hidden');
  if (panelEl)   panelEl.classList.remove('hidden');

  setTimeout(() => {
    if (panelEl) panelEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, 150);
}

function showError(section, msg) {
  const msgEl    = document.getElementById(`${section}-error-message`);
  const errorEl  = document.getElementById(`${section}-result-error`);
  const successEl = document.getElementById(`${section}-result-success`);
  const panelEl  = document.getElementById(`${section}-result-panel`);

  if (msgEl)     msgEl.textContent = msg;
  if (errorEl)   errorEl.classList.remove('hidden');
  if (successEl) successEl.classList.add('hidden');
  if (panelEl)   panelEl.classList.remove('hidden');
}

function hideResult(section) {
  const panelEl   = document.getElementById(`${section}-result-panel`);
  const successEl = document.getElementById(`${section}-result-success`);
  const errorEl   = document.getElementById(`${section}-result-error`);

  if (panelEl)   panelEl.classList.add('hidden');
  if (successEl) successEl.classList.add('hidden');
  if (errorEl)   errorEl.classList.add('hidden');
}

function resetForNewGeneration() {
  closeOldWs();

  // Reset all sections
  ['cpt','sft','dpo'].forEach(sec => {
    resetPipeline(sec);
    hideResult(sec);

    // Hide pipeline tracker
    const pipeline = document.getElementById(`${sec}-pipeline`);
    if (pipeline) pipeline.classList.add('hidden');
  });

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
  _setVal(`${section}-model-select`, s.model);
  _setVal(`${section}-pairs-count`, s.pairs);
  _setVal(`${section}-reasoning`, s.reasoning);
  _setVal(`${section}-system-prompt`, s.system);
  _setVal(`${section}-human-prompt`, s.human);
  if (section === 'dpo') _setVal('dpo-rejection-style', s.rejectionStyle || 'mixed');
  // Cross-lingual toggle (SFT and DPO only)
  if (section === 'sft' || section === 'dpo') {
    const toggle = document.getElementById(`${section}-cross-lingual`);
    if (toggle) toggle.checked = s.crossLingual || false;
  }

  document.getElementById(`modal-${section}`).classList.add('active');
}

function closeSectionSettings(section) {
  document.getElementById(`modal-${section}`).classList.remove('active');
}

function saveSectionSettings(section) {
  const model  = document.getElementById(`${section}-model-select`).value;
  let pairs    = parseInt(document.getElementById(`${section}-pairs-count`).value, 10);
  const reasoning = document.getElementById(`${section}-reasoning`).value;
  const system = document.getElementById(`${section}-system-prompt`).value.trim();
  const human  = document.getElementById(`${section}-human-prompt`).value.trim();

  // Cap target pairs to maximum 100 per generation
  if (isNaN(pairs)) pairs = DEFAULTS[section].pairs;
  if (pairs > 100) pairs = 100;
  if (pairs < 1) pairs = 1;

  sectionSettings[section].model     = model  || DEFAULTS[section].model;
  sectionSettings[section].pairs     = pairs;
  sectionSettings[section].reasoning = reasoning || DEFAULTS[section].reasoning;
  sectionSettings[section].system    = system || DEFAULTS[section].system;
  sectionSettings[section].human     = human  || DEFAULTS[section].human;

  // Cross-lingual toggle (SFT and DPO only)
  if (section === 'sft' || section === 'dpo') {
    const toggle = document.getElementById(`${section}-cross-lingual`);
    sectionSettings[section].crossLingual = toggle ? toggle.checked : false;
  }

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
  _setVal(`${section}-reasoning`, d.reasoning);
  _setVal(`${section}-system-prompt`, d.system);
  _setVal(`${section}-human-prompt`, d.human);
  if (section === 'dpo') _setVal('dpo-rejection-style', 'mixed');
  // Reset cross-lingual toggle
  if (section === 'sft' || section === 'dpo') {
    const toggle = document.getElementById(`${section}-cross-lingual`);
    if (toggle) toggle.checked = d.crossLingual || false;
  }
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
// TOAST
// ══════════════════════════════════════════════════════════════════

function showToast(msg, type = 'info') {
  let toast = document.getElementById('_toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = '_toast';
    Object.assign(toast.style, {
      position: 'fixed', bottom: '1.5rem', right: '1.5rem',
      padding: '.8rem 1.4rem', borderRadius: '12px',
      fontSize: '.85rem', fontWeight: '600', color: '#fff',
      zIndex: '9999', boxShadow: '0 12px 40px rgba(0,0,0,.45)',
      transition: 'opacity .3s, transform .3s', maxWidth: '340px',
      fontFamily: 'Inter, sans-serif', lineHeight: '1.45',
      backdropFilter: 'blur(16px) saturate(180%)',
      webkitBackdropFilter: 'blur(16px) saturate(180%)',
    });
    document.body.appendChild(toast);
  }
  const bgColours     = { success: 'rgba(34,212,126,.15)', error: 'rgba(255,90,90,.15)', info: 'rgba(108,99,255,.15)' };
  const borderColours = { success: 'rgba(34,212,126,.45)', error: 'rgba(255,90,90,.45)', info: 'rgba(108,99,255,.45)' };
  
  toast.style.background  = bgColours[type] || bgColours.info;
  toast.style.border      = `1px solid ${borderColours[type] || borderColours.info}`;
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
