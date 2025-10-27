// ==============================================================================
// VCM (Visual Comment Manager) Extension for VS Code
// ==============================================================================
// This extension provides multiple modes for managing comments in source code:
// 1. Split view: Source on left, clean/commented version on right
// 2. Single file toggle: Hide/show comments in the same file
// 3. Persistent storage: Comments saved to .vcm directory for reconstruction
// ==============================================================================

const vscode = require("vscode");
const crypto = require("crypto");

// Global state variables for the extension
let vcmStatus;           // Status bar item showing VCM state
let vcmEditor;           // Reference to the VCM split view editor
let tempUri;             // URI for the temporary VCM view document
let scrollListener;      // Event listener for cursor movement between panes
let vcmSyncEnabled = true; // Flag to temporarily disable .vcm file updates during toggles

// -----------------------------------------------------------------------------
// Utility Helpers
// -----------------------------------------------------------------------------

// Content provider for the custom "vcm-view:" URI scheme
// This allows us to display virtual documents in VS Code without creating real files
class VCMContentProvider {
  constructor() {
    this.content = new Map(); // Map of URI -> document content
  }
  
  // Called by VS Code when it needs to display a vcm-view: document
  provideTextDocumentContent(uri) {
    return this.content.get(uri.toString()) || "";
  }
  
  // Update the content for a specific URI
  update(uri, content) {
    this.content.set(uri.toString(), content);
  }
}

// Create a unique hash for each line of code
// Used to track where comments belong even when line numbers change
// Format: MD5(trimmed_line)
// Example: "x = 5::42" -> "a3f2b1c4"
function hashLine(line, lineIndex) {
  return crypto.createHash("md5")
    .update(line.trim())
    .digest("hex")
    .substring(0, 8);
}

// -----------------------------------------------------------------------------
// Comment Extraction + Injection
// -----------------------------------------------------------------------------

// Parse source code and extract all comments with their anchor points
// Returns an array of comment objects that can be saved to .vcm files
// 
// Comment types:
// - "block": Multi-line comments above code (e.g., docstrings, headers)
// - "inline": Comments on the same line as code (e.g., x = 5  # counter)
//
// Key concept: Comments are "anchored" to the next line of code below them
// This allows reconstruction even if line numbers change
// Extract all comments and anchor them to the next real code line (by hash)
function extractComments(text, filePath) {
  const lines = text.split("\n");
  const comments = [];
  let commentBuffer = [];

  const isComment = (l) => l.trim().match(/^(#|\/\/|--|%|;)/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) continue;

    // CASE 1: This line is a standalone comment
    if (isComment(line)) {
      const match = line.match(/^(\s*)(#|\/\/|--|%|;)\s?(.*)$/);
      if (match) {
        commentBuffer.push({
          text: match[3],
          indent: match[1],
          marker: match[2],
          originalLine: i,
        });
      }
      continue;
    }

    // CASE 2: Inline comment detection
    const inlineMatch = line.match(/^(.*?)(?<!["'])(\s+)(#|\/\/|--|%|;)\s?(.*)$/);
    if (inlineMatch && inlineMatch[1].trim()) {
      const codePart = inlineMatch[1];
      const marker = inlineMatch[3];
      const commentText = inlineMatch[4];
      comments.push({
        type: "inline",
        anchor: hashLine(codePart, i),  // anchor by code hash
        text: commentText,
        marker,
        codeLine: codePart,
      });
    }

    // CASE 3: Buffered block comment above code line
    if (commentBuffer.length > 0) {
      comments.push({
        type: "block",
        anchor: hashLine(line, i),  // anchor hash of the code line below
        insertAbove: true,
        block: commentBuffer,
      });
      commentBuffer = [];
    }
  }

  // CASE 4: File header comments
  if (commentBuffer.length > 0) {
    comments.push({
      type: "block",
      anchor: "__FILE_START__", // sentinel for top-of-file comments
      insertAbove: true,
      block: commentBuffer,
    });
  }

  return comments;
}

// Reconstruct source code by injecting comments back into clean code
// Takes:
//   cleanText - Code with all comments removed
//   comments - Array of comment objects from extractComments()
// Returns: Full source code with comments restored
function injectComments(cleanText, comments) {
  const lines = cleanText.split("\n");
  const result = [];  // Will contain the final reconstructed code

  // Build a map of line content hash -> line index for the clean code
  const lineHashToIndex = new Map();
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim()) {
      const hash = hashLine(lines[i], i);
      lineHashToIndex.set(hash, i);
    }
  }

  // Separate and sort comments by type for efficient processing
  const blockComments = comments.filter(c => c.type === "block");
  const inlineComments = comments.filter(c => c.type === "inline");

  // Build maps: anchor hash -> comment
  const blockMap = new Map();
  for (const block of blockComments) {
    const lineIndex = lineHashToIndex.get(block.anchor);
    if (lineIndex !== undefined) {
      blockMap.set(lineIndex, block);
    }
  }

  const inlineMap = new Map();
  for (const inline of inlineComments) {
    const lineIndex = lineHashToIndex.get(inline.anchor);
    if (lineIndex !== undefined) {
      inlineMap.set(lineIndex, inline);
    }
  }

  // Rebuild the file line by line
  for (let i = 0; i < lines.length; i++) {
    // STEP 1: Insert any block comments anchored to this line
    // These go ABOVE the code line
    const block = blockMap.get(i);
    if (block) {
      for (const c of block.block) {
        // Reconstruct: indent + marker + space + text
        result.push(`${c.indent || ""}${c.marker || "//"} ${c.text}`);
      }
    }

    // STEP 2: Add the code line itself
    let line = lines[i];
    
    // STEP 3: Check if this line has an inline comment
    const inline = inlineMap.get(i);
    if (inline) {
      // Append the inline comment to the end of the code line
      line += `  ${inline.marker || "//"} ${inline.text}`;
    }

    result.push(line);
  }

  return result.join("\n");
}

// Remove all comments from source code, leaving only code and blank lines
// This creates the "clean" version for split view or toggle mode
// Process:
// 1. Filter out lines that are pure comments (start with #, //, etc)
// 2. Strip inline comments from mixed code+comment lines
// 3. Preserve blank lines to maintain code structure
function stripComments(text) {
  return text
    .split("\n")
    .filter(line => {
      const trimmed = line.trim();
      // Keep blank lines OR lines that aren't pure comments
      return !trimmed || !/^(#|\/\/|--|%|;)/.test(trimmed);
    })
    .map(line => {
      // Remove inline comments: everything after comment marker
      // Regex matches: whitespace + comment marker + rest of line
      return line.replace(/\s+(#|\/\/|--|%|;).*$/, "");
    })
    .join("\n");
}

// -----------------------------------------------------------------------------
// Extension Activate
// -----------------------------------------------------------------------------

async function activate(context) {
  // Load user configuration
  const config = vscode.workspace.getConfiguration("vcm");
  const autoSplit = config.get("autoSplitView", true);  // Auto-split vs same pane
  const liveSync = config.get("liveSync", false);       // Auto-save .vcm on edit

  // Create .vcm directory in workspace root
  // This stores .vcm.json files that mirror the comment structure
  const vcmDir = vscode.Uri.joinPath(
    vscode.workspace.workspaceFolders?.[0]?.uri || vscode.Uri.file(process.cwd()),
    ".vcm"
  );
  await vscode.workspace.fs.createDirectory(vcmDir).catch(() => {});

  // Register content provider for vcm-view: scheme
  // This allows us to create virtual documents that display in the editor
  const provider = new VCMContentProvider();
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider("vcm-view", provider)
  );

  // ---------------------------------------------------------------------------
  // SAVE VCM HANDLER
  // ---------------------------------------------------------------------------
  // Extracts comments from a document and saves them to .vcm/<file>.vcm.json
  // This creates a persistent mirror of the comment structure
  async function saveVCM(doc) {
    // Only process real files (not virtual documents or .vcm files themselves)
    if (doc.uri.scheme !== "file") return;
    if (doc.uri.path.includes("/.vcm/")) return;
    if (doc.languageId === "json") return;

    const text = doc.getText();
    const comments = extractComments(text, doc.uri.path);

    // Create .vcm file path mirroring source file structure
    // Example: src/app.py -> .vcm/src/app.py.vcm.json
    const relativePath = vscode.workspace.asRelativePath(doc.uri);
    const vcmFileUri = vscode.Uri.joinPath(vcmDir, relativePath + ".vcm.json");

    // Ensure nested directories exist
    const pathParts = relativePath.split(/[\\/]/);
    if (pathParts.length > 1) {
      const vcmSubdir = vscode.Uri.joinPath(vcmDir, pathParts.slice(0, -1).join("/"));
      await vscode.workspace.fs.createDirectory(vcmSubdir).catch(() => {});
    }

    // Save comment data as JSON
    const vcmData = {
      file: relativePath,
      lastModified: new Date().toISOString(),
      comments,  // Array of comment objects from extractComments()
    };

    await vscode.workspace.fs.writeFile(
      vcmFileUri,
      Buffer.from(JSON.stringify(vcmData, null, 2), "utf8")
    );
  }

  // ---------------------------------------------------------------------------
  // WATCHERS
  // ---------------------------------------------------------------------------

  // Watch for file saves and update .vcm files
  // vcmSyncEnabled flag prevents infinite loops during toggles
  const saveWatcher = vscode.workspace.onDidSaveTextDocument(async (doc) => {
    if (!vcmSyncEnabled) return;  // Skip if we're in the middle of a toggle
    await saveVCM(doc);
  });
  context.subscriptions.push(saveWatcher);

  // Optional: Watch for file edits and auto-save .vcm after 2 seconds
  // This provides real-time .vcm updates but can be disabled for performance
  if (liveSync) {
    let writeTimeout;
    const changeWatcher = vscode.workspace.onDidChangeTextDocument((e) => {
      if (!vcmSyncEnabled) return;
      clearTimeout(writeTimeout);
      writeTimeout = setTimeout(() => saveVCM(e.document), 2000);
    });
    context.subscriptions.push(changeWatcher);
  }

  // ---------------------------------------------------------------------------
  // COMMAND: Toggle same file (hide/show comments)
  // ---------------------------------------------------------------------------
  // Toggles comments on/off in the current file without creating a split view
  // Process:
  // 1. If file has comments: strip them and show clean version
  // 2. If file is clean: restore comments from .vcm file
  
  const toggleCurrentFileComments = vscode.commands.registerCommand("vcm.toggleCurrentFileComments", async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    // Disable .vcm sync during toggle to prevent overwriting
    vcmSyncEnabled = false;
    
    const doc = editor.document;
    const text = doc.getText();
    const relativePath = vscode.workspace.asRelativePath(doc.uri);
    const vcmFileUri = vscode.Uri.joinPath(vcmDir, relativePath + ".vcm.json");

    // Check if current file has any comments
    const hasComments = /(^\s*(#|\/\/|--|%|;)|\s+(#|\/\/|--|%|;)).*/m.test(text);
    let newText;

    if (hasComments) {
      // File has comments -> strip them
      newText = stripComments(text);
      vscode.window.showInformationMessage("VCM: Comments hidden (clean view)");
    } else {
      // File is clean -> restore comments from .vcm
      try {
        const vcmData = JSON.parse((await vscode.workspace.fs.readFile(vcmFileUri)).toString());
        newText = injectComments(text, vcmData.comments || []);
        vscode.window.showInformationMessage("VCM: Comments restored from .vcm");
      } catch {
        vscode.window.showErrorMessage("VCM: No .vcm data found — save once with comments first.");
        vcmSyncEnabled = true;
        return;
      }
    }

    // Replace entire document content
    const edit = new vscode.WorkspaceEdit();
    edit.replace(doc.uri, new vscode.Range(0, 0, doc.lineCount, 0), newText);
    await vscode.workspace.applyEdit(edit);
    await vscode.commands.executeCommand("workbench.action.files.save");
    
    // Re-enable sync after a delay to ensure save completes
    setTimeout(() => (vcmSyncEnabled = true), 800);
  });
  context.subscriptions.push(toggleCurrentFileComments);

  // ---------------------------------------------------------------------------
  // COMMAND: Split view with/without comments
  // ---------------------------------------------------------------------------
  // Opens a split view with source on left and clean/commented version on right
  // Currently configured: source (with comments) -> right pane (without comments)
  // TODO: Make this configurable to show comments on right instead
  
  const toggleSplitView = vscode.commands.registerCommand("vcm.toggleComments", async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    const doc = editor.document;
    const relativePath = vscode.workspace.asRelativePath(doc.uri);
    const vcmFileUri = vscode.Uri.joinPath(vcmDir, relativePath + ".vcm.json");
    const baseName = doc.fileName.split(/[\\/]/).pop();
    const vcmLabel = `VCM_${baseName}`;

    // Load comment data from .vcm file, or extract from current file
    let comments;
    try {
      const vcmData = JSON.parse((await vscode.workspace.fs.readFile(vcmFileUri)).toString());
      comments = vcmData.comments || [];
    } catch {
      // No .vcm file exists yet - extract and save
      comments = extractComments(doc.getText(), doc.uri.path);
      await saveVCM(doc);
    }

    // Create clean version and version with comments
    const clean = stripComments(doc.getText());
    const withComments = injectComments(clean, comments);

    // Create virtual document with vcm-view: scheme
    tempUri = vscode.Uri.parse(`vcm-view:${vcmLabel}`);
    provider.update(tempUri, withComments);

    // Collapse any existing split groups to start fresh
    await vscode.commands.executeCommand("workbench.action.joinAllGroups");
    
    // Open in split view (beside) or same pane based on config
    const targetColumn = autoSplit ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active;
    vcmEditor = await vscode.window.showTextDocument(tempUri, {
      viewColumn: targetColumn,
      preview: true,  // Use preview tab (can be replaced)
    });

    // Add visual banner to identify VCM view
    const banner = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      before: {
        contentText: `💬 ${vcmLabel} (with comments)`,
        color: "#00ff88",
        fontWeight: "bold",
        backgroundColor: "#00330088",
        margin: "0 1rem 0 0",
      },
    });
    vcmEditor.setDecorations(banner, [new vscode.Range(0, 0, 0, 0)]);
  });
  context.subscriptions.push(toggleSplitView);
}

// Extension deactivation - cleanup resources
function deactivate() {
  if (scrollListener) scrollListener.dispose();
  if (vcmEditor) vscode.commands.executeCommand("workbench.action.closeEditorsInGroup");
}

module.exports = { activate, deactivate };