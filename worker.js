// Pyodide Web Worker
// Handles Python execution in isolation from the main thread

importScripts('https://cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.js');

let pyodide = null;
let isReady = false;

async function init() {
  try {
    pyodide = await loadPyodide({
      stdout: (text) => postMessage({ type: 'stdout', text }),
      stderr: (text) => postMessage({ type: 'stderr', text }),
    });

    // Override input() to pull from preloaded stdin lines
    await pyodide.runPythonAsync(`
import sys
import builtins

_stdin_lines = []
_stdin_index = 0

def _custom_input(prompt=""):
    global _stdin_index
    if prompt:
        # Show the prompt in stdout
        print(prompt, end="", flush=True)
    if _stdin_index < len(_stdin_lines):
        val = _stdin_lines[_stdin_index]
        _stdin_index += 1
        # Echo the input so output looks natural
        print(val)
        return val
    else:
        print("[No more input]")
        return ""

builtins.input = _custom_input
`);

    isReady = true;
    postMessage({ type: 'ready' });
  } catch (err) {
    postMessage({ type: 'error', text: 'Failed to load Pyodide: ' + err.message });
  }
}

async function runCode(code, stdinLines) {
  if (!isReady) {
    postMessage({ type: 'error', text: 'Pyodide not ready yet.' });
    return;
  }

  try {
    // Reset stdin state
    pyodide.globals.set('_stdin_lines', stdinLines || []);
    pyodide.globals.set('_stdin_index', 0);

    await pyodide.runPythonAsync(code);
    postMessage({ type: 'done', exitCode: 0 });
  } catch (err) {
    // Format the error nicely — strip the pyodide internal traceback prefix
    const msg = err.message || String(err);
    const cleaned = cleanTraceback(msg);
    postMessage({ type: 'stderr', text: cleaned });
    postMessage({ type: 'done', exitCode: 1 });
  }
}

function cleanTraceback(msg) {
  // Remove pyodide's internal "PythonError:" wrapper if present
  const lines = msg.split('\n');
  // Find where the actual Python traceback starts
  const start = lines.findIndex(l => l.trim().startsWith('Traceback') || l.trim().startsWith('File') || !l.includes('pyodide'));
  if (start > 0) {
    return lines.slice(start).join('\n');
  }
  return msg;
}

self.onmessage = async (event) => {
  const { type, code, stdinLines } = event.data;
  if (type === 'run') {
    await runCode(code, stdinLines);
  }
};

// Initialise immediately on load
init();
