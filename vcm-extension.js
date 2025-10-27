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

// Create a unique hash for each line of code based ONLY on content
// This makes the hash stable even when line numbers change
// Format: MD5(trimmed_line) truncated to 8 chars
// Example: "x = 5" -> "a3f2b1c4"
function hashLine(line, lineIndex) {
  return crypto.createHash("md5")
    .update(line.trim())  // Only hash content, NOT line index
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
// Context hashes (prevHash, nextHash) help disambiguate identical anchor lines
function extractComments(text, filePath) {
  const lines = text.split("\n");
  const comments = [];      // Final array of all extracted comments
  let commentBuffer = [];   // Temporary buffer for consecutive comment lines

  // Detect language from file extension to use correct comment markers
  const ext = filePath.split('.').pop().toLowerCase();
  let commentMarkers;
  
  if (['py', 'python', 'pyx', 'pyi'].includes(ext)) {
    commentMarkers = ['#'];  // Python only uses #
  } else if (['js', 'jsx', 'ts', 'tsx', 'java', 'c', 'cpp', 'h', 'hpp', 'cs', 'go', 'rs', 'swift'].includes(ext)) {
    commentMarkers = ['//'];  // C-style languages
  } else if (['sql', 'lua'].includes(ext)) {
    commentMarkers = ['--'];  // SQL/Lua style
  } else if (['m', 'matlab'].includes(ext)) {
    commentMarkers = ['%'];  // MATLAB style
  } else if (['asm', 's'].includes(ext)) {
    commentMarkers = [';'];  // Assembly style
  } else {
    commentMarkers = ['#', '//', '--', '%', ';'];  // Default: support all
  }

  // Build regex pattern for this file type
  const markerPattern = commentMarkers.map(m => m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  
  // Helper: Check if a line is a comment
  const isComment = (l) => {
    const trimmed = l.trim();
    for (const marker of commentMarkers) {
      if (trimmed.startsWith(marker)) return true;
    }
    return false;
  };

  // Helper: Find the next non-blank code line after index i
  const findNextCodeLine = (startIndex) => {
    for (let j = startIndex + 1; j < lines.length; j++) {
      const trimmed = lines[j].trim();
      if (trimmed && !isComment(lines[j])) {
        return j;
      }
    }
    return -1;
  };

  // Helper: Find the previous non-blank code line before index i
  const findPrevCodeLine = (startIndex) => {
    for (let j = startIndex - 1; j >= 0; j--) {
      const trimmed = lines[j].trim();
      if (trimmed && !isComment(lines[j])) {
        return j;
      }
    }
    return -1;
  };

  // Process each line sequentially
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    
    // Skip blank lines - they don't affect comment grouping
    if (!trimmed) continue;

    // CASE 1: This line is a standalone comment
    if (isComment(line)) {
      // Extract comment parts: indent, marker, and text
      const match = line.match(new RegExp(`^(\\s*)(${markerPattern})\\s?(.*?)$`));
      if (match) {
        commentBuffer.push({
          text: match[3],        // The actual comment text
          indent: match[1],      // Whitespace before the comment marker
          marker: match[2],      // The comment symbol
          originalLine: i,       // 0-based line index
        });
      }
      continue; // Move to next line, stay in comment-gathering mode
    }

    // CASE 2: This line is code - check for inline comment
    // Find the last occurrence of a comment marker that's not in a string
    // We scan from right to left to find the actual comment marker
    let inlineComment = null;
    for (const marker of commentMarkers) {
      const markerIndex = line.lastIndexOf(marker);
      if (markerIndex === -1) continue;
      
      // Check if marker is preceded by whitespace (not part of string/expression)
      const beforeMarker = line.substring(0, markerIndex);
      if (beforeMarker.match(/\s$/) && beforeMarker.trim()) {
        // This looks like a real comment
        const codePart = beforeMarker.trimEnd();
        const commentText = line.substring(markerIndex + marker.length).trim();

        // Calculate the spacing between code and comment marker
        const spacing = beforeMarker.length - codePart.length;
        // Extra check for // in expressions (skip if looks like division)
        if (marker === '//' && codePart.match(/[\w\]\)]$/) && commentText.match(/^\d/)) {
          continue; // Likely division operator
        }
        
        inlineComment = {
          codePart,
          marker,
          commentText,
          spacing  // Store the original spacing
        };
        break;
      }
    }
    
    if (inlineComment) {
      // Store context: previous and next code lines
      const prevIdx = findPrevCodeLine(i);
      const nextIdx = findNextCodeLine(i);

      comments.push({
        type: "inline",
        anchor: hashLine(inlineComment.codePart, 0), // Just content hash
        prevHash: prevIdx >= 0 ? hashLine(lines[prevIdx], 0) : null,
        nextHash: nextIdx >= 0 ? hashLine(lines[nextIdx], 0) : null,
        originalLine: i,
        text: inlineComment.commentText,
        marker: inlineComment.marker,
        spacing: inlineComment.spacing,  // Store the original spacing
      });
    }

    // CASE 3: We have buffered comment lines above this code line
    // Attach the entire comment block to this line of code
    if (commentBuffer.length > 0) {
      // Store context: previous code line and next code line
      const prevIdx = findPrevCodeLine(i);
      const nextIdx = findNextCodeLine(i);

      comments.push({
        type: "block",
        anchor: hashLine(line, 0), // Just content hash
        prevHash: prevIdx >= 0 ? hashLine(lines[prevIdx], 0) : null,
        nextHash: nextIdx >= 0 ? hashLine(lines[nextIdx], 0) : null,
        insertAbove: true,
        block: commentBuffer,
      });
      commentBuffer = []; // Clear buffer for next block
    }
  }

  // CASE 4: Handle comments at the top of file (before any code)
  // These are typically file headers, copyright notices, or module docstrings
  if (commentBuffer.length > 0) {
    // Find the first actual line of code in the file
    const firstCodeIndex = lines.findIndex((l) => l.trim() && !isComment(l));
    const anchorLine = firstCodeIndex >= 0 ? firstCodeIndex : 0;

    // For file header comments, there's no previous code line
    const nextIdx = findNextCodeLine(anchorLine - 1);

    // Insert this block at the beginning of the comments array
    comments.unshift({
      type: "block",
      anchor: hashLine(lines[anchorLine] || "", 0), // Just content hash
      prevHash: null, // No previous code line before file header
      nextHash: nextIdx >= 0 ? hashLine(lines[nextIdx], 0) : null,
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

  // Build a map of line content hash -> array of line indices (handles duplicates)
  const lineHashToIndices = new Map();
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim()) {
      const hash = hashLine(lines[i], 0); // Content-only hash
      if (!lineHashToIndices.has(hash)) {
        lineHashToIndices.set(hash, []);
      }
      lineHashToIndices.get(hash).push(i);
    }
  }

  // Helper: Find best matching line index using context hashes
  const findBestMatch = (comment, candidateIndices, usedIndices) => {
    if (candidateIndices.length === 1) {
      return candidateIndices[0];
    }

    // Filter out already used indices
    const available = candidateIndices.filter(idx => !usedIndices.has(idx));
    if (available.length === 0) {
      // All used, fall back to any candidate
      return candidateIndices[0];
    }
    if (available.length === 1) {
      return available[0];
    }

    // Check context hashes to find the best match
    const scores = available.map(idx => {
      let score = 0;

      // Find previous non-blank code line
      let prevIdx = -1;
      for (let j = idx - 1; j >= 0; j--) {
        if (lines[j].trim()) {
          prevIdx = j;
          break;
        }
      }

      // Find next non-blank code line
      let nextIdx = -1;
      for (let j = idx + 1; j < lines.length; j++) {
        if (lines[j].trim()) {
          nextIdx = j;
          break;
        }
      }

      // Score based on matching context
      if (comment.prevHash && prevIdx >= 0) {
        const prevHash = hashLine(lines[prevIdx], 0);
        if (prevHash === comment.prevHash) score += 10;
      }

      if (comment.nextHash && nextIdx >= 0) {
        const nextHash = hashLine(lines[nextIdx], 0);
        if (nextHash === comment.nextHash) score += 10;
      }

      return { idx, score };
    });

    // Sort by score (highest first), then by index (to maintain order)
    scores.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.idx - b.idx;
    });

    return scores[0].idx;
  };

  // Separate comments by type and sort by originalLine
  const blockComments = comments.filter(c => c.type === "block").sort((a, b) => {
    const aLine = a.block[0]?.originalLine || 0;
    const bLine = b.block[0]?.originalLine || 0;
    return aLine - bLine;
  });
  const inlineComments = comments.filter(c => c.type === "inline").sort((a, b) => a.originalLine - b.originalLine);

  // Track which indices we've already used
  const usedIndices = new Set();

  // Build maps: line index -> comment
  const blockMap = new Map();
  for (const block of blockComments) {
    const indices = lineHashToIndices.get(block.anchor);
    if (indices && indices.length > 0) {
      const targetIndex = findBestMatch(block, indices, usedIndices);
      usedIndices.add(targetIndex);

      if (!blockMap.has(targetIndex)) {
        blockMap.set(targetIndex, []);
      }
      blockMap.get(targetIndex).push(block);
    }
  }

  const inlineMap = new Map();
  for (const inline of inlineComments) {
    const indices = lineHashToIndices.get(inline.anchor);
    if (indices && indices.length > 0) {
      const targetIndex = findBestMatch(inline, indices, usedIndices);
      usedIndices.add(targetIndex);

      inlineMap.set(targetIndex, inline);
    }
  }

  // Rebuild the file line by line
  for (let i = 0; i < lines.length; i++) {
    // STEP 1: Insert any block comments anchored to this line
    // These go ABOVE the code line
    const blocks = blockMap.get(i);
    if (blocks) {
      for (const block of blocks) {
        for (const c of block.block) {
          // Reconstruct: indent + marker + text (text already has space if needed)
          result.push(`${c.indent || ""}${c.marker || "//"}${c.text ? " " + c.text : ""}`);
        }
      }
    }

    // STEP 2: Add the code line itself
    let line = lines[i];
    
    // STEP 3: Check if this line has an inline comment
    const inline = inlineMap.get(i);
    if (inline) {
      // Append the inline comment with original spacing (default to 2 spaces if not stored)
      const spacing = " ".repeat(inline.spacing || 2);
      line += `${spacing}${inline.marker || "//"}${inline.text ? " " + inline.text : ""}`;
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
// 4. Handle strings properly - don't remove comment markers inside strings
// 5. Language-aware: only remove markers appropriate for the file type
function stripComments(text, filePath) {
  // Detect language from file extension (same logic as extractComments)
  const ext = filePath.split('.').pop().toLowerCase();
  let commentMarkers;

  if (['py', 'python', 'pyx', 'pyi'].includes(ext)) {
    commentMarkers = ['#'];  // Python only uses #
  } else if (['js', 'jsx', 'ts', 'tsx', 'java', 'c', 'cpp', 'h', 'hpp', 'cs', 'go', 'rs', 'swift'].includes(ext)) {
    commentMarkers = ['//'];  // C-style languages
  } else if (['sql', 'lua'].includes(ext)) {
    commentMarkers = ['--'];  // SQL/Lua style
  } else if (['m', 'matlab'].includes(ext)) {
    commentMarkers = ['%'];  // MATLAB style
  } else if (['asm', 's'].includes(ext)) {
    commentMarkers = [';'];  // Assembly style
  } else {
    commentMarkers = ['#', '//', '--', '%', ';'];  // Default: support all
  }

  // Build regex pattern for this file type
  const markerPattern = commentMarkers.map(m => m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const lineStartPattern = new RegExp(`^(${markerPattern})`);

  // Helper: Find the position of an inline comment, accounting for strings
  const findCommentStart = (line) => {
    let inString = false;
    let stringChar = null;
    let escaped = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      const nextChar = line[i + 1];

      // Handle escape sequences
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }

      // Track string state (single, double, or backtick quotes)
      if (!inString && (char === '"' || char === "'" || char === '`')) {
        inString = true;
        stringChar = char;
        continue;
      }
      if (inString && char === stringChar) {
        inString = false;
        stringChar = null;
        continue;
      }

      // Only look for comment markers outside of strings
      if (!inString) {
        // Check each marker for this language
        for (const marker of commentMarkers) {
          if (marker.length === 2) {
            // Two-character markers like //, --, etc.
            if (char === marker[0] && nextChar === marker[1]) {
              // Make sure there's whitespace before it (not part of code)
              if (i > 0 && line[i - 1].match(/\s/)) {
                return i - 1; // Include the whitespace
              }
            }
          } else {
            // Single-character markers like #, %, ;
            if (char === marker) {
              // Make sure there's whitespace before it
              if (i > 0 && line[i - 1].match(/\s/)) {
                return i - 1;
              }
            }
          }
        }
      }
    }

    return -1; // No comment found
  };

  return text
    .split("\n")
    .filter(line => {
      const trimmed = line.trim();
      // Keep blank lines OR lines that aren't pure comments
      return !trimmed || !lineStartPattern.test(trimmed);
    })
    .map(line => {
      // Remove inline comments: everything after comment marker (if not in string)
      const commentPos = findCommentStart(line);
      if (commentPos >= 0) {
        return line.substring(0, commentPos).trimEnd();
      }
      return line;
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

    // Detect language-specific comment markers
    const ext = doc.uri.path.split('.').pop().toLowerCase();
    let commentMarkers;

    if (['py', 'python', 'pyx', 'pyi'].includes(ext)) {
      commentMarkers = ['#'];
    } else if (['js', 'jsx', 'ts', 'tsx', 'java', 'c', 'cpp', 'h', 'hpp', 'cs', 'go', 'rs', 'swift'].includes(ext)) {
      commentMarkers = ['//'];
    } else if (['sql', 'lua'].includes(ext)) {
      commentMarkers = ['--'];
    } else if (['m', 'matlab'].includes(ext)) {
      commentMarkers = ['%'];
    } else if (['asm', 's'].includes(ext)) {
      commentMarkers = [';'];
    } else {
      commentMarkers = ['#', '//', '--', '%', ';'];
    }

    // Build language-specific comment detection pattern
    const markerPattern = commentMarkers.map(m => m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    const commentPattern = new RegExp(`(^\\s*(${markerPattern})|\\s+(${markerPattern}))`, 'm');

    // Check if current file has any comments
    const hasComments = commentPattern.test(text);
    let newText;

    if (hasComments) {
      // File has comments -> strip them
      newText = stripComments(text, doc.uri.path);
      vscode.window.showInformationMessage("VCM: Comments hidden (clean view)");
    } else {
      // File is clean -> restore comments from .vcm
      try {
        // Try to read existing .vcm file
        const vcmData = JSON.parse((await vscode.workspace.fs.readFile(vcmFileUri)).toString());
        newText = injectComments(text, vcmData.comments || []);
        vscode.window.showInformationMessage("VCM: Comments restored from .vcm");
      } catch {
        // No .vcm file exists yet — create one now
        await saveVCM(doc);
        try {
          const vcmData = JSON.parse((await vscode.workspace.fs.readFile(vcmFileUri)).toString());
          newText = injectComments(text, vcmData.comments || []);
          vscode.window.showInformationMessage("VCM: Created and restored new .vcm data");
        } catch {
          vscode.window.showErrorMessage("VCM: Could not create .vcm data — save the file once with comments.");
          vcmSyncEnabled = true;
          return;
        }
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
    const text = doc.getText();
    const clean = stripComments(text, doc.uri.path);
    const withComments = injectComments(clean, comments);

    // Determine if source already has comments
    const hasComments = text.trim() !== clean.trim();

    // If source has comments, show clean; otherwise, show commented
    const showVersion = hasComments ? clean : withComments;
    const labelType = hasComments ? "clean" : "with comments";

    // Create virtual document with vcm-view: scheme
    tempUri = vscode.Uri.parse(`vcm-view:${vcmLabel}`);
    provider.update(tempUri, showVersion);


    // Collapse any existing split groups to start fresh
    await vscode.commands.executeCommand("workbench.action.joinAllGroups");
    
    // Open in split view (beside) or same pane based on config
    const targetColumn = autoSplit ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active;
    vcmEditor = await vscode.window.showTextDocument(tempUri, {
      viewColumn: targetColumn,
      preview: true,  // Use preview tab (can be replaced)
    });

    // Decorate the banner
    const banner = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      before: {
        contentText: `💬 ${vcmLabel} (${labelType})`,
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