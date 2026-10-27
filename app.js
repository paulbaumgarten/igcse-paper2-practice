// app.js — Main application controller

// ─── State ────────────────────────────────────────────────────────────────────
const State = {
  paper: null,            // loaded paper JSON
  steps: [],             // flat navigation array of step objects
  currentStepIndex: 0,
  expandedQuestions: new Set(), // question ids that have been expanded
  answers: {},           // keyed by part id (text) or code_group (code)
  stdinMap: {},          // keyed by code_group
  timer: {
    totalSeconds: 0,
    remaining: 0,
    interval: null,
    started: false,
  },
  worker: null,
  workerReady: false,
  running: false,
};

// ─── Worker ───────────────────────────────────────────────────────────────────
function initWorker() {
  if (State.worker) {
    State.worker.terminate();
  }
  State.workerReady = false;
  State.worker = new Worker('worker.js');

  State.worker.onmessage = (e) => {
    const { type, text } = e.data;
    switch (type) {
      case 'ready':
        State.workerReady = true;
        setRunButtonState('idle');
        appendOutput('Pyodide ready. Click Run to execute your code.\n', 'system');
        break;
      case 'stdout':
        appendOutput(text, 'stdout');
        break;
      case 'stderr':
        appendOutput(text, 'stderr');
        break;
      case 'done':
        State.running = false;
        setRunButtonState('idle');
        break;
      case 'error':
        appendOutput(text, 'stderr');
        State.running = false;
        setRunButtonState('idle');
        break;
    }
  };

  State.worker.onerror = (e) => {
    appendOutput('Worker error: ' + e.message, 'stderr');
    State.running = false;
    setRunButtonState('idle');
  };
}

function runCode() {
  if (!State.workerReady) {
    appendOutput('Python engine still loading, please wait...', 'system');
    return;
  }
  if (State.running) return;

  const step = State.steps[State.currentStepIndex];
  if (!step || step.type !== 'code') return;

  const code = EditorManager.getCode(step.codeGroup);
  if (!code.trim()) {
    appendOutput('Nothing to run — write some code first.\n', 'system');
    return;
  }

  const stdinText = State.stdinMap[step.codeGroup] || '';
  const stdinLines = stdinText.split('\n').filter((l, i, arr) => {
    // Keep all lines except a single trailing empty line
    return !(i === arr.length - 1 && l === '');
  });

  clearOutput();
  State.running = true;
  setRunButtonState('running');
  State.worker.postMessage({ type: 'run', code, stdinLines });
}

function stopCode() {
  if (State.worker) {
    State.worker.terminate();
    State.running = false;
    setRunButtonState('idle');
    appendOutput('\n[Execution stopped]\n', 'system');
    // Restart worker (Pyodide needs full reinit after terminate)
    appendOutput('Reloading Python engine...\n', 'system');
    initWorker();
  }
}

// ─── Paper Loading ────────────────────────────────────────────────────────────
async function loadPaperFromURL() {
  const params = new URLSearchParams(window.location.search);
  const paperParam = params.get('paper');
  if (!paperParam) return false;

  try {
    const url = 'questions/' + paperParam;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    loadPaper(data);
    return true;
  } catch (err) {
    console.error('Failed to load paper from URL:', err);
    return false;
  }
}

function loadPaper(data) {
  // Validate
  if (!data.title || !Array.isArray(data.questions)) {
    showError('Invalid paper format: missing title or questions array.');
    return;
  }

  State.paper = data;
  State.steps = buildSteps(data.questions);
  State.currentStepIndex = 0;
  State.expandedQuestions = new Set();
  State.answers = {};
  State.stdinMap = {};

  // Try restore from localStorage
  restoreFromStorage();

  // Timer
  setupTimer(data.duration_minutes || 90);

  // Update header title
  document.getElementById('exam-title').textContent = data.title;

  // Hide landing, show exam
  document.getElementById('landing').style.display = 'none';
  document.getElementById('exam-shell').style.display = 'flex';

  renderNav();
  navigateTo(0);
  startTimer();
}

// ─── Step Building ────────────────────────────────────────────────────────────
// Builds the flat navigation step array from questions JSON
function buildSteps(questions) {
  const steps = [];

  for (const q of questions) {
    if (!q.parts || q.parts.length <= 1) {
      // Single-part or no-parts question: one step
      const parts = q.parts || [{ id: q.id, question_html: q.question_html, marks: q.marks, answer_type: q.answer_type }];
      steps.push({
        id: q.id,
        label: q.label || q.id,
        type: q.type || 'text',
        codeGroup: q.code_group || q.id,
        starterCode: q.starter_code || '',
        contextHtml: parts[0].context_html || q.context_html || '',
        questionHtml: parts[0].question_html || q.question_html || '',
        marks: parts[0].marks || q.marks,
        answerType: parts[0].answer_type || 'textarea',
        rows: parts[0].rows || 6,
        parts: null,
        parentId: null,
        isTopLevel: true,
      });
    } else {
      // Multi-part question: first add a "parent" placeholder step
      // that expands into sub-parts when reached
      steps.push({
        id: q.id,
        label: q.label || q.id,
        type: 'parent',
        parts: q.parts,
        question: q,
        isTopLevel: true,
        contextHtml: q.context_html || '',
      });
    }
  }

  // Add summary step at end
  steps.push({
    id: '__summary__',
    label: 'Summary',
    type: 'summary',
    isTopLevel: true,
  });

  return steps;
}

// Expand a parent step into its sub-parts in-place
function expandStep(stepIndex) {
  const step = State.steps[stepIndex];
  if (step.type !== 'parent') return;

  const q = step.question;
  const subSteps = q.parts.map((part, i) => ({
    id: part.id || `${q.id}_${i}`,
    label: part.label || `${q.label}(${String.fromCharCode(97 + i)})`,
    type: q.type || 'code',
    codeGroup: q.code_group || q.id,
    starterCode: i === 0 ? (q.starter_code || '') : '',
    contextHtml: part.context_html || q.context_html || '',
    questionHtml: part.question_html || '',
    marks: part.marks,
    answerType: part.answer_type || 'textarea',
    rows: part.rows || 6,
    parts: null,
    parentId: q.id,
    isTopLevel: false,
  }));

  // Replace the parent step with its sub-steps
  State.steps.splice(stepIndex, 1, ...subSteps);
  State.expandedQuestions.add(q.id);
}

// ─── Navigation ───────────────────────────────────────────────────────────────
function navigateTo(index) {
  if (index < 0 || index >= State.steps.length) return;

  let step = State.steps[index];

  // If we land on a parent, expand it and navigate to first child
  if (step.type === 'parent') {
    expandStep(index);
    renderNav();
    step = State.steps[index]; // now the first sub-step
  }

  State.currentStepIndex = index;
  renderNav();
  renderStep(step);
}

function navPrev() {
  navigateTo(State.currentStepIndex - 1);
}

function navNext() {
  saveCurrentAnswers();
  navigateTo(State.currentStepIndex + 1);
}

// ─── Rendering ────────────────────────────────────────────────────────────────
function renderNav() {
  const nav = document.getElementById('nav-breadcrumb');
  nav.innerHTML = '';

  State.steps.forEach((step, i) => {
    if (i > 0) {
      const line = document.createElement('span');
      line.className = 'nav-line';
      nav.appendChild(line);
    }

    const btn = document.createElement('button');
    btn.className = 'nav-step';
    btn.textContent = step.label;
    btn.dataset.index = i;

    if (i === State.currentStepIndex) {
      btn.classList.add('active');
    } else if (isStepAnswered(step)) {
      btn.classList.add('answered');
    }

    btn.addEventListener('click', () => {
      saveCurrentAnswers();
      navigateTo(i);
    });

    nav.appendChild(btn);
  });

  // Scroll active step into view
  const active = nav.querySelector('.nav-step.active');
  if (active) active.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });

  // Update prev/next button states
  document.getElementById('btn-prev').disabled = State.currentStepIndex === 0;
  document.getElementById('btn-next').disabled = State.currentStepIndex === State.steps.length - 1;
}

function isStepAnswered(step) {
  if (step.type === 'code') {
    const code = EditorManager.getCode(step.codeGroup);
    return code && code !== (step.starterCode || '');
  }
  if (step.type === 'text') {
    const ans = State.answers[step.id];
    return ans && ans.trim && ans.trim().length > 0;
  }
  return false;
}

function renderStep(step) {
  const leftPanel = document.getElementById('left-panel');

  // Show/hide right-panel panes (editor, text, summary)
  const rpCode    = document.getElementById('rp-code');
  const rpText    = document.getElementById('rp-text');
  const rpSummary = document.getElementById('rp-summary');
  rpCode.classList.add('hidden');
  rpText.classList.add('hidden');
  rpSummary.classList.add('hidden');

  // Show/hide editor toolbar
  const toolbar = document.getElementById('editor-toolbar');
  if (step.type === 'code') {
    toolbar.classList.remove('hidden');
  } else {
    toolbar.classList.add('hidden');
  }

  if (step.type === 'code') {
    rpCode.classList.remove('hidden');
    renderCodeStep(step, leftPanel);
  } else if (step.type === 'text') {
    rpText.classList.remove('hidden');
    renderTextStep(step, leftPanel);
  } else if (step.type === 'summary') {
    rpSummary.classList.remove('hidden');
    renderSummary(leftPanel);
  }
}

function renderCodeStep(step, leftPanel) {
  // Left: context + question
  leftPanel.innerHTML = `
    <div class="question-context">${step.contextHtml || ''}</div>
    <div class="question-body">
      ${step.questionHtml || ''}
      ${step.marks ? `<p class="marks">[${step.marks} mark${step.marks !== 1 ? 's' : ''}]</p>` : ''}
    </div>
  `;

  // Switch editor to this code group (handles save/restore internally)
  EditorManager.switchTo(step.codeGroup, step.starterCode);

  // Restore stdin value for this group
  const stdinTa = document.getElementById('stdin-textarea');
  if (stdinTa) {
    // Re-bind: remove old listener by replacing node
    const fresh = stdinTa.cloneNode(true);
    stdinTa.parentNode.replaceChild(fresh, stdinTa);
    fresh.value = State.stdinMap[step.codeGroup] || '';
    fresh.addEventListener('input', () => {
      State.stdinMap[step.codeGroup] = fresh.value;
      saveToStorage();
    });
  }

}

function renderTextStep(step, leftPanel) {
  leftPanel.innerHTML = `
    <div class="question-context">${step.contextHtml || ''}</div>
    <div class="question-body">
      ${step.questionHtml || ''}
      ${step.marks ? `<p class="marks">[${step.marks} mark${step.marks !== 1 ? 's' : ''}]</p>` : ''}
    </div>
  `;

  const container = document.getElementById('text-answer-container');
  container.innerHTML = '';

  const answerWrap = document.createElement('div');
  answerWrap.className = 'text-answer-wrap';

  const answerId = step.id;
  const savedAnswer = State.answers[answerId] || '';

  if (step.answerType === 'input') {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'text-answer-input';
    input.value = savedAnswer;
    input.addEventListener('input', () => {
      State.answers[answerId] = input.value;
      saveToStorage();
      renderNav();
    });
    answerWrap.appendChild(input);
  } else {
    const ta = document.createElement('textarea');
    ta.className = 'text-answer-textarea';
    ta.rows = step.rows || 6;
    ta.value = savedAnswer;
    ta.addEventListener('input', () => {
      State.answers[answerId] = ta.value;
      saveToStorage();
      renderNav();
    });
    answerWrap.appendChild(ta);
  }

  container.appendChild(answerWrap);
}

function renderSummary(leftPanel) {
  leftPanel.innerHTML = `
    <div class="summary-left">
      <h2>Summary</h2>
      <p>Review your answers below, then export to submit.</p>
      <p>Your work has been auto-saved in this browser.</p>
      <button id="btn-export" class="btn-export">Export Answers (JSON)</button>
    </div>
  `;
  document.getElementById('btn-export').addEventListener('click', exportAnswers);

  // De-duplicate code steps by codeGroup
  const seenGroups = new Set();
  const summaryHtml = State.steps
    .filter(s => {
      if (s.type === 'text') return true;
      if (s.type === 'code') {
        if (seenGroups.has(s.codeGroup)) return false;
        seenGroups.add(s.codeGroup);
        return true;
      }
      return false;
    })
    .map(s => {
      if (s.type === 'code') {
        const code = EditorManager.getCode(s.codeGroup);
        return `
          <div class="summary-item">
            <div class="summary-label">${s.label} <span class="summary-marks">${s.marks ? `[${s.marks} marks]` : ''}</span></div>
            <div class="summary-question">${s.questionHtml || ''}</div>
            <pre class="summary-code">${escapeHtml(code || '(no code written)')}</pre>
          </div>`;
      } else {
        const ans = State.answers[s.id] || '';
        return `
          <div class="summary-item">
            <div class="summary-label">${s.label} <span class="summary-marks">${s.marks ? `[${s.marks} marks]` : ''}</span></div>
            <div class="summary-question">${s.questionHtml || ''}</div>
            <div class="summary-answer">${escapeHtml(ans || '(no answer)')}</div>
          </div>`;
      }
    }).join('');

  const container = document.getElementById('summary-answers-container');
  container.innerHTML = summaryHtml;
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ─── Output Panel ─────────────────────────────────────────────────────────────
function appendOutput(text, stream) {
  const pre = document.getElementById('output-pre');
  if (!pre) return;
  const span = document.createElement('span');
  span.className = 'output-' + stream;
  span.textContent = text;
  pre.appendChild(span);
  pre.scrollTop = pre.scrollHeight;
}

function clearOutput() {
  const pre = document.getElementById('output-pre');
  if (pre) pre.innerHTML = '';
}

function setRunButtonState(state) {
  const runBtn = document.getElementById('btn-run');
  const stopBtn = document.getElementById('btn-stop');
  if (!runBtn || !stopBtn) return;

  if (state === 'running') {
    runBtn.disabled = true;
    runBtn.classList.add('running');
    stopBtn.disabled = false;
  } else {
    runBtn.disabled = !State.workerReady;
    runBtn.classList.remove('running');
    stopBtn.disabled = true;
  }
}

// ─── Output divider drag resize ───────────────────────────────────────────────
// Registered once during initApp; elements are permanent in the DOM.
function setupOutputDivider() {
  const divider       = document.getElementById('output-divider');
  const editorContainer = document.getElementById('editor-container');
  const outputSection = document.getElementById('output-section');
  if (!divider) return;

  let dragging = false;
  let startY, startEditorH, startOutputH;

  divider.addEventListener('mousedown', (e) => {
    dragging = true;
    startY = e.clientY;
    startEditorH = editorContainer.offsetHeight;
    startOutputH = outputSection.offsetHeight;
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const dy = e.clientY - startY;
    const newEditorH = Math.max(80, startEditorH + dy);
    const newOutputH = Math.max(60, startOutputH - dy);
    editorContainer.style.height = newEditorH + 'px';
    outputSection.style.height = newOutputH + 'px';
    const view = EditorManager.getCurrentView();
    if (view) view.requestMeasure();
  });

  window.addEventListener('mouseup', () => {
    if (dragging) {
      dragging = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
  });
}

// ─── Panel Split Drag ─────────────────────────────────────────────────────────
function setupPanelSplit() {
  const splitter = document.getElementById('panel-splitter');
  const left = document.getElementById('left-panel');
  const right = document.getElementById('right-panel');
  const container = document.getElementById('panels-container');

  let dragging = false;
  let startX, startLeftW;

  splitter.addEventListener('mousedown', (e) => {
    dragging = true;
    startX = e.clientX;
    startLeftW = left.offsetWidth;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const containerW = container.offsetWidth;
    const dx = e.clientX - startX;
    const newLeftW = Math.min(
      Math.max(280, startLeftW + dx),
      containerW - 320
    );
    const pct = (newLeftW / containerW) * 100;
    left.style.width = pct + '%';
    right.style.width = (100 - pct - 0.5) + '%'; // 0.5% for splitter
    const view = EditorManager.getCurrentView();
    if (view) view.requestMeasure();
  });

  window.addEventListener('mouseup', () => {
    if (dragging) {
      dragging = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
  });
}

// ─── Timer ────────────────────────────────────────────────────────────────────
function setupTimer(minutes) {
  State.timer.totalSeconds = minutes * 60;
  State.timer.remaining = minutes * 60;
  State.timer.started = false;
  updateTimerDisplay();
}

function startTimer() {
  if (State.timer.started) return;
  State.timer.started = true;
  State.timer.interval = setInterval(() => {
    if (State.timer.remaining > 0) {
      State.timer.remaining--;
      updateTimerDisplay();
    } else {
      clearInterval(State.timer.interval);
    }
  }, 1000);
}

function updateTimerDisplay() {
  const r = State.timer.remaining;
  const h = Math.floor(r / 3600);
  const m = Math.floor((r % 3600) / 60);
  const s = r % 60;
  const display = h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;

  const el = document.getElementById('timer-display');
  if (el) {
    el.textContent = display;
    if (r <= 300) {
      el.classList.add('timer-warning');
    } else {
      el.classList.remove('timer-warning');
    }
  }
}

// ─── Persistence ──────────────────────────────────────────────────────────────
function storageKey() {
  return 'igcse_paper2_' + (State.paper?.title || 'unknown');
}

function saveCurrentAnswers() {
  const step = State.steps[State.currentStepIndex];
  if (!step) return;
  // Text answers are saved live via event listeners
  // Code is read directly from EditorManager
  saveToStorage();
}

function saveToStorage() {
  if (!State.paper) return;
  const data = {
    answers: State.answers,
    stdinMap: State.stdinMap,
    codes: EditorManager.getAllGroupCodes(),
    currentStepIndex: State.currentStepIndex,
    timeRemaining: State.timer.remaining,
    expandedQuestions: [...State.expandedQuestions],
  };
  try {
    localStorage.setItem(storageKey(), JSON.stringify(data));
  } catch (e) {
    console.warn('localStorage save failed:', e);
  }
}

function restoreFromStorage() {
  const raw = localStorage.getItem(storageKey());
  if (!raw) return;
  try {
    const data = JSON.parse(raw);
    State.answers = data.answers || {};
    State.stdinMap = data.stdinMap || {};
    if (data.expandedQuestions) {
      // Re-expand previously expanded questions
      for (const qid of data.expandedQuestions) {
        const idx = State.steps.findIndex(s => s.id === qid && s.type === 'parent');
        if (idx >= 0) expandStep(idx);
      }
    }
    // Restore code after CM is initialised — store pending values
    if (data.codes) {
      for (const [groupId, code] of Object.entries(data.codes)) {
        EditorManager.restoreGroupCode(groupId, code);
      }
    }
    if (data.timeRemaining != null) {
      State.timer.remaining = data.timeRemaining;
    }
  } catch (e) {
    console.warn('localStorage restore failed:', e);
  }
}

// ─── Export ───────────────────────────────────────────────────────────────────
function exportAnswers() {
  const elapsed = State.timer.totalSeconds - State.timer.remaining;
  const h = Math.floor(elapsed / 3600);
  const m = Math.floor((elapsed % 3600) / 60);
  const s = elapsed % 60;
  const timeElapsed = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;

  const answers = {};

  // Text answers
  for (const step of State.steps) {
    if (step.type === 'text') {
      answers[step.id] = {
        label: step.label,
        type: 'text',
        answer: State.answers[step.id] || '',
      };
    }
  }

  // Code answers (one per code_group, de-duplicated)
  const seenGroups = new Set();
  for (const step of State.steps) {
    if (step.type === 'code' && !seenGroups.has(step.codeGroup)) {
      seenGroups.add(step.codeGroup);
      answers[step.codeGroup] = {
        label: step.label,
        type: 'code',
        code: EditorManager.getCode(step.codeGroup),
        stdin_preloaded: State.stdinMap[step.codeGroup] || '',
      };
    }
  }

  const exportData = {
    paper_title: State.paper.title,
    exported_at: new Date().toISOString(),
    time_elapsed: timeElapsed,
    answers,
  };

  const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const safeName = State.paper.title.replace(/[^a-z0-9]/gi, '_').toLowerCase();
  a.download = `${safeName}_answers.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// ─── Landing page ─────────────────────────────────────────────────────────────
function setupLanding() {
  const dropZone = document.getElementById('drop-zone');
  const fileInput = document.getElementById('file-input');

  dropZone.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) readFileAsPaper(file);
  });

  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
  });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file) readFileAsPaper(file);
  });
}

function readFileAsPaper(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const data = JSON.parse(e.target.result);
      loadPaper(data);
    } catch (err) {
      showError('Could not parse JSON file: ' + err.message);
    }
  };
  reader.readAsText(file);
}

function showError(msg) {
  const el = document.getElementById('landing-error');
  if (el) {
    el.textContent = msg;
    el.style.display = 'block';
  }
}

// ─── Toolbar button wiring ────────────────────────────────────────────────────
function setupToolbar() {
  document.getElementById('btn-undo').addEventListener('click', () => EditorManager.undo());
  document.getElementById('btn-redo').addEventListener('click', () => EditorManager.redo());
  document.getElementById('btn-zoom-in').addEventListener('click', () => EditorManager.adjustFontSize(1));
  document.getElementById('btn-zoom-out').addEventListener('click', () => EditorManager.adjustFontSize(-1));
  document.getElementById('btn-copy').addEventListener('click', () => EditorManager.copyAll());
  document.getElementById('btn-paste').addEventListener('click', () => EditorManager.pasteAtCursor());
  document.getElementById('btn-run').addEventListener('click', runCode);
  document.getElementById('btn-stop').addEventListener('click', stopCode);
  document.getElementById('btn-stdin').addEventListener('click', toggleStdin);
}

function toggleStdin() {
  const panel = document.getElementById('stdin-panel');
  if (!panel) return;
  panel.classList.toggle('hidden');
  document.getElementById('btn-stdin').classList.toggle('active', !panel.classList.contains('hidden'));
}

// ─── Init ─────────────────────────────────────────────────────────────────────
async function initApp() {
  setupLanding();
  setupToolbar();
  setupPanelSplit();
  setupOutputDivider(); // wire up the persistent output resize handle

  document.getElementById('btn-prev').addEventListener('click', navPrev);
  document.getElementById('btn-next').addEventListener('click', navNext);

  // Auto-save every 30 seconds as belt-and-braces
  setInterval(saveToStorage, 30000);

  // Initialise Pyodide worker immediately (so it's ready when needed)
  initWorker();

  // Wait for the CM6 ES module in index.html to signal readiness
  await loadCodeMirror();

  // Mount the single persistent editor instance into #editor-container
  EditorManager.mount();

  // Try URL-based paper loading
  const loaded = await loadPaperFromURL();
  if (!loaded) {
    // Stay on landing page
    document.getElementById('landing').style.display = 'flex';
  }
}

async function loadCodeMirror() {
  // Wait for the ES module in index.html to finish loading CodeMirror 6
  // and set window._cmReady, with a 30-second timeout.
  return new Promise((resolve, reject) => {
    let waited = 0;
    const check = () => {
      if (window._cmReady) {
        EditorManager.init(window._cmModules);
        resolve();
      } else if (waited > 30000) {
        console.error('CodeMirror failed to load within 30 seconds.');
        resolve(); // resolve anyway so the rest of the app still boots
      } else {
        waited += 50;
        setTimeout(check, 50);
      }
    };
    check();
  });
}

window.addEventListener('DOMContentLoaded', initApp);
