// editor.js — CodeMirror 6 wrapper
// Manages one persistent editor instance per code_group

const EditorManager = (() => {
  // Map of code_group -> { view: EditorView, state: any }
  const groups = {};
  let currentGroup = null;
  let currentContainer = null;

  // These will be set once CM6 modules are loaded
  let EditorView, EditorState, python, basicSetup, keymap, defaultKeymap,
      indentWithTab, lineNumbers, highlightActiveLine, syntaxHighlighting,
      defaultHighlightStyle, autocompletion, closeBrackets;

  function isReady() {
    return !!EditorView;
  }

  function init(modules) {
    ({
      EditorView, EditorState, python, basicSetup, keymap, defaultKeymap,
      indentWithTab, lineNumbers, highlightActiveLine, syntaxHighlighting,
      defaultHighlightStyle, autocompletion, closeBrackets
    } = modules);
  }

  function getOrCreate(groupId, starterCode, container) {
    currentGroup = groupId;
    currentContainer = container;

    // If there's a pending restore, use that code instead of the starter
    if (groups[groupId] && groups[groupId]._pending !== undefined) {
      const pendingCode = groups[groupId]._pending;
      delete groups[groupId];
      starterCode = pendingCode;
    }

    if (!groups[groupId]) {
      const startState = EditorState.create({
        doc: starterCode || '',
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
            '.cm-line': { padding: '0 8px' },
            '.cm-gutters': {
              backgroundColor: '#f0f4f8',
              color: '#7a8a99',
              border: 'none',
              borderRight: '1px solid #dce3ea',
              minWidth: '36px',
            },
            '.cm-activeLineGutter': { backgroundColor: '#e2eaf2' },
            '.cm-activeLine': { backgroundColor: '#f5f8fc' },
            '.cm-cursor': { borderLeftColor: '#003B71' },
            '.cm-selectionBackground': { backgroundColor: '#bdd6f0 !important' },
          }),
        ],
      });

      groups[groupId] = {
        view: new EditorView({
          state: startState,
          parent: container,
        }),
      };
    } else {
      // Re-attach existing view to the container
      container.appendChild(groups[groupId].view.dom);
      groups[groupId].view.requestMeasure();
    }

    return groups[groupId].view;
  }

  function getCurrentView() {
    if (!currentGroup || !groups[currentGroup]) return null;
    return groups[currentGroup].view;
  }

  function getCode(groupId) {
    const g = groups[groupId];
    if (!g) return '';
    return g.view.state.doc.toString();
  }

  function setCode(groupId, code) {
    const g = groups[groupId];
    if (!g) return;
    g.view.dispatch({
      changes: { from: 0, to: g.view.state.doc.length, insert: code },
    });
  }

  function undo() {
    const v = getCurrentView();
    if (v) {
      const cmUndo = (window._cmCommands || {}).undo;
      if (cmUndo) cmUndo(v);
    }
  }

  function redo() {
    const v = getCurrentView();
    if (v) {
      const cmRedo = (window._cmCommands || {}).redo;
      if (cmRedo) cmRedo(v);
    }
  }

  function adjustFontSize(delta) {
    const v = getCurrentView();
    if (!v) return;
    const current = parseFloat(getComputedStyle(v.dom).fontSize) || 13;
    const next = Math.min(24, Math.max(10, current + delta));
    v.dom.style.fontSize = next + 'px';
  }

  function copyAll() {
    const v = getCurrentView();
    if (!v) return;
    navigator.clipboard.writeText(v.state.doc.toString()).catch(() => {});
  }

  function pasteAtCursor() {
    const v = getCurrentView();
    if (!v) return;
    navigator.clipboard.readText().then((text) => {
      v.dispatch(v.state.replaceSelection(text));
      v.focus();
    }).catch(() => {});
  }

  function getAllGroupCodes() {
    const result = {};
    for (const [id, g] of Object.entries(groups)) {
      if (g._pending !== undefined) {
        result[id] = g._pending;
      } else {
        result[id] = g.view.state.doc.toString();
      }
    }
    return result;
  }

  function restoreGroupCode(groupId, code) {
    if (groups[groupId]) {
      setCode(groupId, code);
    } else {
      // Will be set when the group is first created via getOrCreate
      groups[groupId] = { _pending: code };
    }
  }

  return {
    init,
    isReady,
    getOrCreate,
    getCurrentView,
    getCode,
    setCode,
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
