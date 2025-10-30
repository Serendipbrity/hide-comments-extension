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
let isCommentedMap = new Map(); // Track state: true = comments visible, false = clean mode (comments hidden)
let justInjectedFromVCM = new Set(); // Track files that just had VCM comments injected (don't re-extract)

// -----------------------------------------------------------------------------
// Utility Helpers
// -----------------------------------------------------------------------------

// Comment markers per file type - single source of truth for all languages
const COMMENT_MARKERS = {
  'py': ['#'],
  'python': ['#'],
  'pyx': ['#'],
  'pyi': ['#'],
  'js': ['//'],
  'jsx': ['//'],
  'ts': ['//'],
  'tsx': ['//'],
  'java': ['//'],
  'c': ['//'],
  'cpp': ['//'],
  'h': ['//'],
  'hpp': ['//'],
  'cs': ['//'],
  'go': ['//'],
  'rs': ['//'],
  'swift': ['//'],
  'sql': ['--'],
  'lua': ['--'],
  'm': ['%'],
  'matlab': ['%'],
  'asm': [';'],
  's': [';']
};

// Get comment markers for a specific file based on extension
// Returns array of comment marker strings for the file type
function getCommentMarkersForFile(filePath) {
  const ext = filePath.split('.').pop().toLowerCase();
  return COMMENT_MARKERS[ext] || ['#', '//', '--', '%', ';']; // Default: support all common markers
}

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

// Merge new comments with existing VCM comments using hash matching
// This is used when toggling from clean mode to commented mode
// Returns: merged array of comments with new text prepended to existing
function mergeCommentsWithVCM(newComments, existingComments) {
  // Build a map of anchor hash -> array of existing comments (handles duplicate anchors)
  const existingByAnchor = new Map();
  for (const old of existingComments) {
    if (!existingByAnchor.has(old.anchor)) {
      existingByAnchor.set(old.anchor, []);
    }
    existingByAnchor.get(old.anchor).push(old);
  }

  // Helper: Find best matching existing comment using context hashes
  const findBestExistingMatch = (newComment, candidates) => {
    if (candidates.length === 1) {
      return candidates[0];
    }

    // Score each candidate based on context hash matching
    const scores = candidates.map(existing => {
      let score = 0;

      // Match prevHash
      if (newComment.prevHash && existing.prevHash) {
        if (newComment.prevHash === existing.prevHash) score += 10;
      }

      // Match nextHash
      if (newComment.nextHash && existing.nextHash) {
        if (newComment.nextHash === existing.nextHash) score += 10;
      }

      return { existing, score };
    });

    // Sort by score (highest first)
    scores.sort((a, b) => b.score - a.score);

    return scores[0].existing;
  };

  // Track which existing comments have been matched
  const usedExisting = new Set();

  // Process new comments and merge with existing BY MODIFYING IN PLACE
  for (const newC of newComments) {
    const candidates = existingByAnchor.get(newC.anchor) || [];
    const availableCandidates = candidates.filter(c => !usedExisting.has(c));

    if (availableCandidates.length > 0) {
      // Find the best matching existing comment using context hashes
      const existing = findBestExistingMatch(newC, availableCandidates);
      usedExisting.add(existing);

      if (newC.type === "block" && existing.type === "block") {
        // Prepend new block lines ABOVE existing block (modify in place)
        const existingTexts = existing.block.map(b => b.text?.trim());

        // Only add new block lines that don't already exist
        const uniqueNewBlocks = newC.block.filter(nb =>
          !existingTexts.includes(nb.text?.trim())
        );

        if (uniqueNewBlocks.length > 0) {
          existing.block = [...uniqueNewBlocks, ...existing.block];
        }
      } else if (newC.type === "inline" && existing.type === "inline") {
        // Check if new text already exists in the existing text
        const newText = newC.text || "";
        const existingText = existing.text || "";

        if (!existingText.includes(newText.trim())) {
          // Prepend new comment to existing comment (both include markers)
          // Example: "  # new" + "  # old" = "  # new  # old"
          existing.text = newText + existingText;
        }
      }
    }
  }

  // Return existing comments in their ORIGINAL ORDER (not reordered)
  return existingComments;
}

// Detect initial state: are comments visible or hidden?
// Returns: true if comments are visible (isCommented), false if in clean mode
async function detectInitialMode(doc, vcmFileUri, vcmDir) {
  const relativePath = vscode.workspace.asRelativePath(doc.uri);
  const vcmPath = vscode.Uri.joinPath(vcmDir, relativePath + ".vcm.json");

  try {
    // VCM exists - check if first 5-10 comments from VCM match the file
    const vcmData = JSON.parse((await vscode.workspace.fs.readFile(vcmPath)).toString());
    const comments = vcmData.comments || [];

    if (comments.length === 0) {
      return true; // No comments in VCM, assume commented mode
    }

    const lines = doc.getText().split('\n');
    const checkCount = Math.min(10, comments.length);

    // Check if first N comments exist in the file
    for (let i = 0; i < checkCount; i++) {
      const comment = comments[i];
      const lineIndex = comment.originalLine;

      if (lineIndex >= lines.length) continue;

      const currentLine = lines[lineIndex];
      const commentText = comment.type === 'inline'
        ? comment.text
        : (comment.block && comment.block[0] ? comment.block[0].text : '');

      if (commentText && !currentLine.includes(commentText)) {
        return false; // Comment not found - we're in clean mode
      }
    }

    return true; // All checked comments found - we're in commented mode

  } catch {
    // No VCM exists - check if the actual file has comments
    const commentMarkers = getCommentMarkersForFile(doc.uri.path);
    const lines = doc.getText().split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      for (const marker of commentMarkers) {
        if (trimmed.startsWith(marker)) {
          return true; // File has comments - isCommented = true
        }
      }
    }

    return false; // No comments found - isCommented = false
  }
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

  // Get comment markers for this file type from our centralized config
  const commentMarkers = getCommentMarkersForFile(filePath);

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
      // Store the ENTIRE line as-is (includes indent, marker, spacing, text, trailing spaces)
      commentBuffer.push({
        text: line,           // Full line exactly as it appears
        originalLine: i,      // 0-based line index
      });
      continue; // Move to next line, stay in comment-gathering mode
    }

    // CASE 2: This line is code - check for inline comment(s)
    // Find the first comment marker and extract everything after it as ONE combined comment
    let inlineRegex = new RegExp(`(\\s+)(${markerPattern})`, "");
    let match = line.match(inlineRegex);

    if (match) {
      // Extract everything from the first comment marker onwards (all inline comments combined)
      const commentStartIndex = match.index;
      const fullComment = line.substring(commentStartIndex);

      // Context lines
      const prevIdx = findPrevCodeLine(i);
      const nextIdx = findNextCodeLine(i);

      // Hash only the code portion before the first inline comment marker
      const anchorBase = line.substring(0, commentStartIndex).trimEnd();

      comments.push({
        type: "inline",
        anchor: hashLine(anchorBase, 0),
        prevHash: prevIdx >= 0 ? hashLine(lines[prevIdx], 0) : null,
        nextHash: nextIdx >= 0 ? hashLine(lines[nextIdx], 0) : null,
        originalLine: i,
        text: fullComment,  // Store ALL inline comments as one combined text
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
      // DON'T mark as used for inline comments - multiple inlines can be on same line!
      // usedIndices.add(targetIndex);

      if (!inlineMap.has(targetIndex)) inlineMap.set(targetIndex, []);
      inlineMap.get(targetIndex).push(inline);
    }
  }

  // Rebuild the file line by line
  for (let i = 0; i < lines.length; i++) {
    // STEP 1: Insert any block comments anchored to this line
    // These go ABOVE the code line
    const blocks = blockMap.get(i);
    if (blocks) {
      for (const block of blocks) {
        // Combine text_cleanMode (if it's a block array) and block
        let allBlockLines = [];

        // text_cleanMode for blocks contains the block array
        if (block.text_cleanMode && Array.isArray(block.text_cleanMode)) {
          allBlockLines.push(...block.text_cleanMode);
        }

        // Add original block lines
        if (block.block) {
          allBlockLines.push(...block.block);
        }

        for (const c of allBlockLines) {
          // Just push the full text as-is (includes indent, marker, spacing, text)
          result.push(c.text);
        }
      }
    }

    // STEP 2: Add the code line itself
    let line = lines[i];

    // STEP 3: Check if this line has an inline comment
    const inlines = inlineMap.get(i);
    if (inlines && inlines.length > 0) {
      // Should only be one inline comment per line (contains all combined comments)
      const inline = inlines[0];
      // Combine text_cleanMode (string) and text
      let commentText = "";

      // text_cleanMode for inline comments is a string
      if (inline.text_cleanMode && typeof inline.text_cleanMode === 'string') {
        commentText += inline.text_cleanMode;
      }

      // Add original text
      if (inline.text) {
        commentText += inline.text;
      }

      if (commentText) {
        line += commentText;
      }
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
  // Get comment markers for this file type from our centralized config
  const commentMarkers = getCommentMarkersForFile(filePath);

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

  // ============================================================================
  // saveVCM()
  // ============================================================================
  // Handles saving the .vcm mirror file for the currently open document.
  // Logic:
  //   - If the file contains existing VCM comments (isCommented = true):
  //         → overwrite the .vcm.json with the current comment state.
  //   - If the file is clean (isCommented = false):
  //         → prepend new comments to existing ones where possible,
  //           without overwriting anything in the .vcm.json.
  //
  // This function is always called by the save watcher (liveSync included).
  // It auto-detects commented vs. clean by comparing line hashes against
  // a small sample of known VCM anchors (first/last 5) for speed.
  // ============================================================================
  async function saveVCM(doc) {
    if (doc.uri.scheme !== "file") return;
    if (doc.uri.path.includes("/.vcm/")) return;
    if (doc.languageId === "json") return;

    // Check if we just injected comments from VCM
    // (this flag prevents re-extracting immediately after injection in clean mode)
    const wasJustInjected = justInjectedFromVCM.has(doc.uri.fsPath);
    if (wasJustInjected) {
      justInjectedFromVCM.delete(doc.uri.fsPath);
    }

    const text = doc.getText();
    const relativePath = vscode.workspace.asRelativePath(doc.uri);
    const vcmFileUri = vscode.Uri.joinPath(vcmDir, relativePath + ".vcm.json");

    // Extract all current comments from the document
    const currentComments = extractComments(text, doc.uri.path);

    // Load existing VCM data (if any)
    let existingComments = [];
    try {
      const raw = (await vscode.workspace.fs.readFile(vcmFileUri)).toString();
      const vcmData = JSON.parse(raw);
      existingComments = vcmData.comments || [];
    } catch {
      // No .vcm yet — nothing to merge
      existingComments = [];
    }

    // Get the current mode from our state map
    let isCommented = isCommentedMap.get(doc.uri.fsPath);

    // If state is not set, initialize it by detecting the mode
    if (isCommented === undefined) {
      isCommented = await detectInitialMode(doc, vcmFileUri, vcmDir);
      isCommentedMap.set(doc.uri.fsPath, isCommented);
    }

    // ------------------------------------------------------------------------
    // Merge Strategy
    // ------------------------------------------------------------------------
    let finalComments;

    if (isCommented) {
      // Commented mode:
      //   → The user is editing the commented version.
      //   → Replace entire VCM with what's currently visible.
      //   → Always extract current state to detect deletions immediately.

      finalComments = currentComments;

    } else {
      // Clean mode:
      //   → The user is editing the clean version WITHOUT comments visible.
      //   → VCM comments (with `text`) are preserved as-is (hidden from view).
      //   → New comments typed in clean mode go into `text_cleanMode`.
      //   → Livesync only touches `text_cleanMode`, never `text`.

      // If we just injected from VCM, skip processing to avoid re-extracting
      if (wasJustInjected) {
        finalComments = existingComments;
      } else {
        // Build a map of existing comments by anchor for matching
        const existingByAnchor = new Map();
        for (const existing of existingComments) {
          const key = `${existing.type}:${existing.anchor}`;
          if (!existingByAnchor.has(key)) {
            existingByAnchor.set(key, []);
          }
          existingByAnchor.get(key).push(existing);
        }

        // Process current comments (typed in clean mode)
        for (const current of currentComments) {
          const key = `${current.type}:${current.anchor}`;
          const candidates = existingByAnchor.get(key) || [];

          if (candidates.length > 0) {
            // Found matching existing comment - update its text_cleanMode
            const existing = candidates[0]; // Use first match (could improve with context matching)

            if (current.type === "inline") {
              existing.text_cleanMode = current.text;
            } else if (current.type === "block") {
              // For block comments, store the block array in text_cleanMode
              existing.text_cleanMode = current.block;
            }
          } else {
            // No existing comment - create new one with text_cleanMode
            const newComment = { ...current };
            if (current.type === "inline") {
              newComment.text_cleanMode = current.text;
              delete newComment.text;
            } else if (current.type === "block") {
              // For block comments, store the block array in text_cleanMode
              newComment.text_cleanMode = current.block;
              delete newComment.block;
            }
            existingComments.push(newComment);
          }
        }

        // Remove text_cleanMode from comments that are no longer present
        for (const existing of existingComments) {
          const key = `${existing.type}:${existing.anchor}`;
          const stillExists = currentComments.some(c =>
            `${c.type}:${c.anchor}` === key
          );

          if (!stillExists) {
            // User deleted this comment in clean mode
            existing.text_cleanMode = null;
          }
        }

        finalComments = existingComments;
      }
    }

    // ------------------------------------------------------------------------
    // Save final .vcm.json data
    // ------------------------------------------------------------------------
    const vcmData = {
      file: relativePath,
      lastModified: new Date().toISOString(),
      comments: finalComments,
    };

    // Ensure directories exist
    const pathParts = relativePath.split(/[\\/]/);
    if (pathParts.length > 1) {
      const vcmSubdir = vscode.Uri.joinPath(
        vcmDir,
        pathParts.slice(0, -1).join("/")
      );
      await vscode.workspace.fs.createDirectory(vcmSubdir).catch(() => {});
    }

    // Write file back to disk
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
    // saveVCM() will check if file is in clean mode internally
    await saveVCM(doc);
  });
  context.subscriptions.push(saveWatcher);

  // Optional: Watch for file edits and auto-save .vcm after 2 seconds
  // This provides real-time .vcm updates but can be disabled for performance
  if (liveSync) {
    let writeTimeout;
    const changeWatcher = vscode.workspace.onDidChangeTextDocument((e) => {
      if (!vcmSyncEnabled) return;
      // saveVCM() will check if file is in clean mode internally
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
  
  const toggleCurrentFileComments = vscode.commands.registerCommand("vcm-view-comments-mirror.toggleCurrentFileComments", async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    // Disable .vcm sync during toggle to prevent overwriting
    vcmSyncEnabled = false;

    const doc = editor.document;
    const text = doc.getText();
    const relativePath = vscode.workspace.asRelativePath(doc.uri);
    const vcmFileUri = vscode.Uri.joinPath(vcmDir, relativePath + ".vcm.json");

    // Detect initial state if not already set
    if (!isCommentedMap.has(doc.uri.fsPath)) {
      const initialState = await detectInitialMode(doc, vcmFileUri, vcmDir);
      isCommentedMap.set(doc.uri.fsPath, initialState);
    }

    // Get current state
    const currentIsCommented = isCommentedMap.get(doc.uri.fsPath);
    let newText;

    if (currentIsCommented === true) {
      // Currently in commented mode -> switch to clean mode (hide comments)
      // Ensure a .vcm file exists before stripping
      try {
        await vscode.workspace.fs.stat(vcmFileUri);
      } catch {
        // No .vcm yet — extract and save before removing comments
        await saveVCM(doc);
      }

      // If liveSync is disabled, always update manually
      const config = vscode.workspace.getConfiguration("vcm");
      const liveSync = config.get("liveSync", false);
      if (!liveSync) {
        await saveVCM(doc);
      }

      // Strip comments to show clean version
      newText = stripComments(text, doc.uri.path);
      // Mark this file as now in clean mode
      isCommentedMap.set(doc.uri.fsPath, false);
      vscode.window.showInformationMessage("VCM: Switched to clean mode (comments hidden)");
    } else {
      // Currently in clean mode -> switch to commented mode (show comments)
      try {
        // Try to read existing .vcm file
        const vcmData = JSON.parse((await vscode.workspace.fs.readFile(vcmFileUri)).toString());
        const existingComments = vcmData.comments || [];

        // Merge text_cleanMode into text/block and clear text_cleanMode
        const mergedComments = existingComments.map(comment => {
          const merged = { ...comment };

          if (comment.text_cleanMode) {
            if (comment.type === "inline") {
              // For inline: text_cleanMode is a string, prepend to text
              merged.text = (comment.text_cleanMode || "") + (comment.text || "");
            } else if (comment.type === "block") {
              // For block: text_cleanMode is a block array, prepend to block
              merged.block = [...(comment.text_cleanMode || []), ...(comment.block || [])];
            }
            merged.text_cleanMode = null;
          }

          return merged;
        });

        // Get clean code (strip all comments)
        const cleanText = stripComments(text, doc.uri.path);

        // Inject merged comments into clean code
        newText = injectComments(cleanText, mergedComments);

        // Save the merged VCM before toggling
        const updatedVcmData = {
          file: relativePath,
          lastModified: new Date().toISOString(),
          comments: mergedComments,
        };
        await vscode.workspace.fs.writeFile(
          vcmFileUri,
          Buffer.from(JSON.stringify(updatedVcmData, null, 2), "utf8")
        );

        // Mark this file as now in commented mode
        isCommentedMap.set(doc.uri.fsPath, true);

        // Mark that we just injected from VCM - don't re-extract on next save
        justInjectedFromVCM.add(doc.uri.fsPath);

        vscode.window.showInformationMessage("VCM: Switched to commented mode (comments visible)");
      } catch {
        // No .vcm file exists yet — create one now
        isCommentedMap.set(doc.uri.fsPath, true);
        await saveVCM(doc);
        try {
          const vcmData = JSON.parse((await vscode.workspace.fs.readFile(vcmFileUri)).toString());
          // Strip comments before injecting
          const cleanText = stripComments(text, doc.uri.path);
          newText = injectComments(cleanText, vcmData.comments || []);

          // Mark that we just injected from VCM - don't re-extract on next save
          justInjectedFromVCM.add(doc.uri.fsPath);

          vscode.window.showInformationMessage("VCM: Created new .vcm and switched to commented mode");
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
  
  const toggleSplitView = vscode.commands.registerCommand("vcm-view-comments-mirror.toggleSplitViewComments", async () => {
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

    // Insert timestamp before file extension to preserve language detection
    const uniqueLabel = vcmLabel.replace(/(\.[^/.]+)$/, `_${Date.now()}$1`);
    // Create virtual document with vcm-view: scheme
    tempUri = vscode.Uri.parse(`vcm-view:${uniqueLabel}`);
    provider.update(tempUri, showVersion);


    // Collapse any existing split groups to start fresh
    await vscode.commands.executeCommand("workbench.action.joinAllGroups");
    
    // Open in split view (beside) or same pane based on config
    const targetColumn = autoSplit ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active;
    vcmEditor = await vscode.window.showTextDocument(tempUri, {
      viewColumn: targetColumn,
      preview: true,  // Use preview tab (can be replaced)
    });

    // Setup bidirectional click-to-jump (source → split view)
    const sourceEditor = editor;
    
    let activeHighlight;

    scrollListener = vscode.window.onDidChangeTextEditorSelection(async e => {
      if (!vcmEditor) return;
      if (e.textEditor !== sourceEditor) return;

      const cursorPos = e.selections[0].active;
      const wordRange = sourceEditor.document.getWordRangeAtPosition(cursorPos);
      if (!wordRange) return;

      const word = sourceEditor.document.getText(wordRange);
      if (!word || word.length < 2) return;

      // Extract line context to improve matching accuracy
      const sourceLine = sourceEditor.document.lineAt(cursorPos.line).text.trim();
      const targetText = vcmEditor.document.getText();
      const targetLines = targetText.split("\n");

      // Try to find the same line context first (exact match or partial)
      let targetLine = targetLines.findIndex(line => line.trim() === sourceLine.trim());
      if (targetLine === -1) {
        // fallback: find first line containing the word as whole word
        const wordRegex = new RegExp(`\\b${word}\\b`);
        targetLine = targetLines.findIndex(line => wordRegex.test(line));
      }

      if (targetLine === -1) return;

      // Jump + highlight that line
      const targetPos = new vscode.Position(targetLine, 0);
      vcmEditor.selection = new vscode.Selection(targetPos, targetPos);
      vcmEditor.revealRange(
        new vscode.Range(targetPos, targetPos),
        vscode.TextEditorRevealType.InCenter
      );

      // Remove previous highlight if exists
      if (activeHighlight) {
        activeHighlight.dispose();
        activeHighlight = null;
      }

      // Create a highlight using the editor’s built-in selection color
      activeHighlight = vscode.window.createTextEditorDecorationType({
        backgroundColor: new vscode.ThemeColor("editor.selectionBackground"),
        isWholeLine: true,
      });

      vcmEditor.setDecorations(activeHighlight, [
        new vscode.Range(targetPos, targetPos),
      ]);
    });
    context.subscriptions.push(scrollListener);


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