// editor.js — CodeMirror 6 wrapper
//
// KEY DESIGN: A single EditorView is created once and lives permanently in
// #editor-container. It is NEVER moved or re-parented. When the student
// navigates between code_groups we save the current text to a string cache
// and load the new group's text — avoiding the DOM-detach crash in CM6.

const EditorManager = (() => {
  // One view, created once.
  let view = null;

  // Text content saved per code_group: { [groupId]: string }
  const saved = {};

  // Which code_group is currently loaded in the editor
  let activeGroup = null;

  // Pending restorations from localStorage (set before the view exists)
  const pending = {};

  // CM6 module refs, set via init()
  let EditorView, EditorState, python, basicSetup, keymap, defaultKeymap,
      indentWithTab;

  function isReady() {
    return !!EditorView;
  }

  function init(modules) {
    ({ EditorView, EditorState, python, basicSetup, keymap, defaultKeymap,
       indentWithTab } = modules);
  }

  // Call once after the DOM is ready to mount the editor into #editor-container.
  function mount() {
    if (view) return; // already mounted
    if (!EditorView) { console.error('EditorManager.mount() called before init()'); return; }

    const container = document.getElementById('editor-container');
    if (!container) { console.error('#editor-container not found'); return; }

    const startState = EditorState.create({
      doc: '',
      extensions: [
        basicSetup,
        python(),
        keymap.of([indentWithTab, ...defaultKeymap]),
        EditorView.lineWrapping,
        EditorView.theme({
          '&': {
            fontSize: '13px',
            fontFamily: '"Fira Code", "Cascadia Code", "Consolas", monospace',
            height: '100%',
          },
          '.cm-scroller': { overflow: 'auto', fontFamily: 'inherit' },
          '.cm-content': { padding: '8px 0' },
          '.cm-line':    { padding: '0 8px' },
          '.cm-gutters': {
            backgroundColor: '#f0f4f8',
            color: '#7a8a99',
            border: 'none',
            borderRight: '1px solid #dce3ea',
            minWidth: '36px',
          },
          '.cm-activeLineGutter':  { backgroundColor: '#e2eaf2' },
          '.cm-activeLine':        { backgroundColor: '#f5f8fc' },
          '.cm-cursor':            { borderLeftColor: '#003B71' },
          '.cm-selectionBackground': { backgroundColor: '#bdd6f0 !important' },
        }),
      ],
    });

    view = new EditorView({ state: startState, parent: container });
  }

  // Switch the editor to a given code_group.
  // starterCode is only used the very first time a group is seen.
  function switchTo(groupId, starterCode) {
    if (!view) mount();
    if (!view) return;

    // Save current content before switching away
    if (activeGroup !== null) {
      saved[activeGroup] = view.state.doc.toString();
    }

    activeGroup = groupId;

    // Determine what text to load
    let text;
    if (pending[groupId] !== undefined) {
      // Restored from localStorage
      text = pending[groupId];
      delete pending[groupId];
    } else if (saved[groupId] !== undefined) {
      // Already visited this group this session
      text = saved[groupId];
    } else {
      // First visit — use starter code
      text = starterCode || '';
    }

    // Replace editor contents atomically
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: text },
    });

    view.requestMeasure();
  }

  function getCode(groupId) {
    if (groupId === activeGroup && view) {
      return view.state.doc.toString();
    }
    if (saved[groupId] !== undefined) return saved[groupId];
    if (pending[groupId] !== undefined) return pending[groupId];
    return '';
  }

  function getCurrentView() {
    return view;
  }

  function undo() {
    if (!view) return;
    const cmUndo = (window._cmCommands || {}).undo;
    if (cmUndo) cmUndo(view);
  }

  function redo() {
    if (!view) return;
    const cmRedo = (window._cmCommands || {}).redo;
    if (cmRedo) cmRedo(view);
  }

  function adjustFontSize(delta) {
    if (!view) return;
    const current = parseFloat(getComputedStyle(view.dom).fontSize) || 13;
    const next = Math.min(24, Math.max(10, current + delta));
    view.dom.style.fontSize = next + 'px';
  }

  function copyAll() {
    if (!view) return;
    navigator.clipboard.writeText(view.state.doc.toString()).catch(() => {});
  }

  function pasteAtCursor() {
    if (!view) return;
    navigator.clipboard.readText().then((text) => {
      view.dispatch(view.state.replaceSelection(text));
      view.focus();
    }).catch(() => {});
  }

  // Returns all known group contents (for localStorage export)
  function getAllGroupCodes() {
    // Flush current view into saved
    if (activeGroup !== null && view) {
      saved[activeGroup] = view.state.doc.toString();
    }
    const result = { ...saved };
    // Include any still-pending (never-visited) groups
    for (const [id, code] of Object.entries(pending)) {
      result[id] = code;
    }
    return result;
  }

  // Called during localStorage restore, before the view may exist
  function restoreGroupCode(groupId, code) {
    if (groupId === activeGroup && view) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: code },
      });
    } else {
      pending[groupId] = code;
    }
  }

  return {
    init,
    isReady,
    mount,
    switchTo,
    getCode,
    getCurrentView,
    undo,
    redo,
    adjustFontSize,
    copyAll,
    pasteAtCursor,
    getAllGroupCodes,
    restoreGroupCode,
  };
})();

window.EditorManager = EditorManager;
