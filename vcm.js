// ==============================================================================
// VCM (Visual Comment Manager) Extension for VS Code
// ==============================================================================
// This extension provides multiple modes for managing comments in source code:
// 1. Split view: Source on left, clean/commented version on right
// 2. Single file toggle: Hide/show comments in the same file
// 3. Persistent storage: Comments saved to .vcm directory for reconstruction
// ==============================================================================

const vscode = require("vscode"); // vs code api module. lets us talk to and control VSCode itself
const crypto = require("crypto"); // for generating hashes

// Global state variables for the extension
let vcmStatus;           // Status bar item showing VCM state
let vcmEditor;           // Reference to the VCM split view editor
let tempUri;             // URI for the temporary VCM view document
let scrollListener;      // Event listener for cursor movement between panes
let sourceDocUri;        // Track which source document has the split view open
let vcmSyncEnabled = true; // Flag to temporarily disable .vcm file updates during toggles
// Map is a Class for storing key value pairs. 
// new Map creates an empty instance to use crud on
// maps are better than objects because the key doesnt have to be a string and it keeps the key value ordering that they were added in. 
// What 'new' does under the hood:
// 1 Creates a fresh empty object: {}
// 2 Links that object’s internal prototype to the constructor’s .prototype.
// 3 Runs the constructor function, binding this to that new object.
// 4 Returns the new object automatically.
let isCommentedMap = new Map(); // Track state: true = comments visible, false = clean mode (comments hidden)
let justInjectedFromVCM = new Set(); // Track files that just had VCM comments injected (don't re-extract)
let privateCommentsVisible = new Map(); // Track private comment visibility per file: true = visible, false = hidden

// -----------------------------------------------------------------------------
// Utility Helpers
// -----------------------------------------------------------------------------

// Comment markers per file type - single source of truth for all languages
const COMMENT_MARKERS = {
  // Python-family
  'py': ['#'],
  'python': ['#'],
  'pyx': ['#'],
  'pyi': ['#'],

  // JavaScript / TypeScript
  'js': ['//'],
  'jsx': ['//'],
  'ts': ['//'],
  'tsx': ['//'],

  // C-family
  'c': ['//'],
  'h': ['//'],
  'cpp': ['//'],
  'cc': ['//'],
  'cxx': ['//'],
  'hpp': ['//'],
  'hh': ['//'],
  'ino': ['//'],     // Arduino
  'cs': ['//'],      // C#
  'java': ['//'],
  'swift': ['//'],
  'go': ['//'],
  'rs': ['//'],      // Rust
  'kt': ['//'],      // Kotlin
  'kts': ['//'],     // Kotlin scripts

  // Web / Frontend
  'css': ['/*'],     // note: block style
  'scss': ['//', '/*'],
  'less': ['//', '/*'],
  'html': ['<!--'],
  'htm': ['<!--'],
  'xml': ['<!--'],
  'vue': ['//', '<!--'],
  'svelte': ['//', '<!--'],

  // SQL / DB
  'sql': ['--'],
  'psql': ['--'],
  'plsql': ['--'],
  'mysql': ['--', '#'],

  // Lua / Haskell
  'lua': ['--'],
  'hs': ['--'],
  'lhs': ['--'],

  // Shell / Scripting
  'sh': ['#'],
  'bash': ['#'],
  'zsh': ['#'],
  'ksh': ['#'],
  'fish': ['#'],
  'r': ['#'],
  'rscript': ['#'],
  'pl': ['#'],      // Perl
  'pm': ['#'],      // Perl module
  'rb': ['#'],      // Ruby
  'cr': ['#'],      // Crystal
  'awk': ['#'],
  'tcl': ['#'],

  // PHP / Hack
  'php': ['//', '#'],

  // MATLAB / Octave
  'm': ['%'],
  'matlab': ['%'],
  'octave': ['%'],

  // Assembly / Low-level
  'asm': [';'],
  's': [';'],
  'S': [';'],
  'nas': [';'],

  // Lisp / Scheme / Clojure
  'lisp': [';'],
  'cl': [';'],
  'el': [';'],
  'scm': [';'],
  'ss': [';'],
  'clj': [';'],
  'cljs': [';'],
  'cljc': [';'],

  // Pascal / Delphi
  'pas': ['//'],   // also supports { } and (* *)
  'dpr': ['//'],

  // Fortran
  'f': ['!'],
  'f90': ['!'],
  'f95': ['!'],

  // TeX / LaTeX
  'tex': ['%'],
  'latex': ['%'],

  // VB / Basic
  'vb': ["'"],
  'vbs': ["'"],
  'bas': ["'"],
  'frm': ["'"],

  // PowerShell
  'ps1': ['#'],
  'psm1': ['#'],

  // Config / Data
  'ini': [';', '#'],
  'toml': ['#'],
  'yaml': ['#'],
  'yml': ['#'],
  'env': ['#'],

  // Markdown / Docs
  'md': ['<!--'],
  'markdown': ['<!--'],
  'rst': ['..'], // reStructuredText
};

// Get comment markers for a specific file based on extension
// Returns array of comment marker strings for the file type
function getCommentMarkersForFile(filePath) {
  // split the string by the period ex) vcm.js -> ['vcm','js']
  // pop the last el of the array -> ['js']
  // ensure consistency by making it lowercase if it isnt
  const ext = filePath.split('.').pop().toLowerCase();
  // retrieve all markers for the matching index comment_markers['.js'] or default to common markers if undefined (if we dont have that filetype listed)
  return COMMENT_MARKERS[ext] || ['#', '//', '--', '%', ';']; 
}

// Content Provider (provides the files text content) for generating and dynamically updating the split view VCM_filename.type. like a server
// This allows us to display *virtual* documents in VS Code (temp/non stored files)
class VCMContentProvider {
  // function for a class specifically used to initialize the properties of an object
  constructor() {
    // this.content is creating a custom property which creates a Map of URI (temp VCM_) -> document content, which is..
    // Key → the document’s unique URI (e.g., vcm-view:/some/file)
    // Value → the actual string content of that “document.”
    // It’s an in-memory store for what each virtual document currently displays.
    // When placing Map in constructor(), it’s like saying:
    // “Each time I make a new VCMContentProvider (view), give it a clean whiteboard.”
    this.content = new Map(); 
    // Creates a new event emitter from the VS Code API.
    // This object can “fire” events that tell VS Code something changed.
    // Think of it as a signal: “Hey editor, refresh this content.”
    this._onDidChange = new vscode.EventEmitter();
    // Exposes a read-only event property so VS Code (VCM_) can subscribe to changes.
    // When fire() is called later, anything listening to onDidChange reacts — usually VS Code re-requests the document’s content.
    this.onDidChange = this._onDidChange.event;
  }

  // response handler method called by VS Code when it needs to display text to a vcm-view (uri): document
  provideTextDocumentContent(uri) {
    // In the Map, look up the uri and return the content string else empty string
    return this.content.get(uri.toString()) || "";
  }

  // server push that forces update of vcm-view's (uri's) content
  update(uri, content) {
    // update the vcm_ (content's Map) for the specific file view (uri) with the new content
    this.content.set(uri.toString(), content);
    // immediately fire the event telling VS Code the document changed.
    // VS Code hears the event → re-calls provideTextDocumentContent() → updates the editor display.
    this._onDidChange.fire(uri);
  }
}

// Create a unique hash for each line of code based ONLY on content
// This makes the hash stable even when line numbers change
// Format: MD5(trimmed_line) truncated to 8 chars
// Example: "x = 5" -> "a3f2b1c4"
function hashLine(line, lineIndex) {
  return crypto.createHash("md5")
  .update(line.trim())  // Hash content and removes spaces at both ends so formatting changes don’t alter the hash.
  .digest("hex") // Finalizes the hash and converts it to a hexadecimal string.
  .substring(0, 8); // Takes only the first 8 characters of the hash (a shorter ID).
  // Ex: "x = 5" -> "a3f2b1c4"
}

// Detect initial state: are comments visible or hidden?
// Returns: true if comments are visible (isCommented), false if in clean mode
async function detectInitialMode(doc, vcmDir) {
  // get file path relative to workspace root
  const relativePath = vscode.workspace.asRelativePath(doc.uri);

  try { // Try to load the VCM metadata file
    // Detection logic:
    // - If shared comments are visible → commented mode
    // - If only private (or no comments) → clean mode
    const { sharedComments } = await loadAllComments(relativePath);
    const comments = sharedComments || [];

    // No shared comments exist → default to clean mode
    if (comments.length === 0) {
      return false;
    }

    // filter through shared comments and keep only those where alwaysShow property is false or undefined.
    // This separates the comments that are optional (toggleable) from ones that are permanently displayed.
    const nonAlwaysShowComments = comments.filter(c => !c.alwaysShow);

    // If *Only* alwaysShow shared comments exist, check if any are visible
    if (nonAlwaysShowComments.length === 0) {
      // Rare case: only alwaysShow comments
      // Just check if first alwaysShow comment is visible
      if (comments.length > 0) {
        const firstComment = comments[0];
        const lines = doc.getText().split('\n');
        const lineIndex = firstComment.originalLineIndex;

        if (lineIndex < lines.length) {
          const currentLine = lines[lineIndex];
          const commentText = firstComment.text || (firstComment.block && firstComment.block[0] ? firstComment.block[0].text : '');
          if (commentText && currentLine.includes(commentText)) {
            return true; // alwaysShow comment found, commented mode
          }
        }
      }
      return false;
    }

    // Standard case: Check if first 3 shared (non-alwaysShow) comments are visible
    // Load private comments to exclude them from detection (only first 3 for efficiency)
    const { privateComments } = await loadAllComments(relativePath);
    const privateTexts = new Set();
    const privateCheckLimit = Math.min(3, privateComments.length);
    for (let i = 0; i < privateCheckLimit; i++) {
      const pc = privateComments[i];
      if (pc.type === 'inline') {
        privateTexts.add(pc.text);
      } else if (pc.block) {
        for (const block of pc.block) {
          privateTexts.add(block.text);
        }
      }
    }

    // Extract current comments (only what we need for comparison)
    const text = doc.getText();
    const currentComments = extractComments(text, doc.uri.path);

    // Filter current comments to only non-private ones
    const currentNonPrivateComments = currentComments.filter(c => {
      if (c.type === 'inline') {
        return !privateTexts.has(c.text);
      } else if (c.block) {
        return !c.block.some(b => privateTexts.has(b.text));
      }
      return true;
    });

    // If no non-private comments in document, we're in clean mode
    if (currentNonPrivateComments.length === 0) {
      return false;
    }

    // Check if any of the first 3 shared comments exist in the non-private comments
    const checkCount = Math.min(3, nonAlwaysShowComments.length);
    for (let i = 0; i < checkCount; i++) {
      const sharedComment = nonAlwaysShowComments[i];

      // Get the text to match
      let sharedText;
      if (sharedComment.type === 'inline') {
        sharedText = sharedComment.text_cleanMode || sharedComment.text;
      } else if (sharedComment.block) {
        if (sharedComment.text_cleanMode && sharedComment.text_cleanMode[0]) {
          sharedText = sharedComment.text_cleanMode[0].text;
        } else if (sharedComment.block[0]) {
          sharedText = sharedComment.block[0].text;
        }
      }

      if (!sharedText) continue;

      // Check if this shared comment exists in the current non-private comments
      const found = currentNonPrivateComments.some(c => {
        if (c.type === 'inline') {
          return c.text && c.text.includes(sharedText);
        } else if (c.block) {
          return c.block.some(b => b.text && b.text.includes(sharedText));
        }
        return false;
      });

      if (!found) {
        return false; // Shared comment not found - we're in clean mode
      }
    }

    return true; // All shared sample comments were present, so we're in commented mode.

  } catch { // If the .vcm.json didn’t exist or was unreadable:
    // Check if the actual file has comments
    const commentMarkers = getCommentMarkersForFile(doc.uri.path);
    const lines = doc.getText().split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      for (const marker of commentMarkers) {
        // If any line begins with a comment marker, return true (commented).
        if (trimmed.startsWith(marker)) {
          return true; // File has comments - isCommented = true
        }
      }
    }

    return false; // No comments found - isCommented = false
  }
}

// Detect if private comments are currently visible in the document
// Returns: true if private comments are visible, false if hidden
// This is a FALLBACK - should only be used when state is not in the map
async function detectPrivateVisibility(doc, relativePath) {
  try {
    // Load private comments from VCM
    const { privateComments } = await loadAllComments(relativePath);

    // If no private comments exist, return false (nothing to show)
    if (privateComments.length === 0) {
      return false;
    }

    // Extract current comments from document (only need to check if ONE exists)
    const text = doc.getText();
    const currentComments = extractComments(text, doc.uri.path);

    // Only check the first private comment for efficiency (if one is visible, they all should be)
    const firstPrivate = privateComments[0];
    const firstPrivateKey = `${firstPrivate.type}:${firstPrivate.anchor}:${firstPrivate.prevHash || 'null'}:${firstPrivate.nextHash || 'null'}`;
    const firstPrivateText = firstPrivate.text || (firstPrivate.block ? firstPrivate.block.map(b => b.text).join('\n') : '');

    // Check if the first private comment exists in current document
    for (const current of currentComments) {
      const currentKey = `${current.type}:${current.anchor}:${current.prevHash || 'null'}:${current.nextHash || 'null'}`;

      // Match by key (exact anchor match)
      if (currentKey === firstPrivateKey) {
        return true; // Found the first private comment in the document
      }

      // Match by text (in case anchor changed)
      if (firstPrivateText) {
        const currentText = current.text || (current.block ? current.block.map(b => b.text).join('\n') : '');
        if (currentText === firstPrivateText) {
          return true; // Found the first private comment by text match
        }
      }
    }

    // First private comment not found in document
    return false;
  } catch (error) {
    // If we can't detect (no VCM file, etc.), default to hidden
    return false;
  }
}

// -----------------------------------------------------------------------------
// Comment Extraction
// -----------------------------------------------------------------------------
// text: the entire file content (string), filePath: the full path
function extractComments(text, filePath, existingVCMComments = null, isCleanMode = false, debugAnchorText = false) {
  const lines = text.split("\n"); // Splits file text into an array of individual lines.
  const comments = [];      // Final array of all extracted comments
  let commentBuffer = [];   // Temporary holding area for consecutive comment lines

  // Get comment markers for this file type from our centralized config list
  const commentMarkers = getCommentMarkersForFile(filePath);

  // Build regex pattern for this file type
  // .replace() escapes special regex characters like *, ?, (, ), etc., because // or % would otherwise break the regex engine.
  // .join('|') means “match any of these markers.”
  // Example:
  // If commentMarkers = ["//", "#"],
  // then markerPattern = "\\/\\/|#" — usable inside new RegExp().
  const markerPattern = commentMarkers.map(m => m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  
  // Helper: Check if a line is a comment or code
  const isComment = (l) => {
    const trimmed = l.trim(); // Remove whitespace
    for (const marker of commentMarkers) { // loop over all possible markers for this file
      // Check whether the line begins with any marker and return true if so
      if (trimmed.startsWith(marker)) return true;
    }
    return false; // not a comment line
  };

  // Helper: Find the next non-blank code line after index i
  const findNextCodeLine = (startIndex) => {
    for (let j = startIndex + 1; j < lines.length; j++) { // Loops forward from the given index.
      const trimmed = lines[j].trim();
      if (trimmed && !isComment(lines[j])) { // Skip blank lines and comments.
        return j; // return code lines index
      }
    }
    return -1; // if none found, return to last line of code's index we found.
  };

  // Helper: Find the previous non-blank code line before index i
  const findPrevCodeLine = (startIndex) => {
    for (let j = startIndex - 1; j >= 0; j--) {
      const trimmed = lines[j].trim();
      if (trimmed && !isComment(lines[j])) {
        return j; // index of next line of code
      }
    }
    return -1; // no code line was found after this point (end of file). So that nextHash becomes null instead of blowing up
  };

  // Process each line sequentially
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // CASE 1: This line is a standalone comment
    if (isComment(line)) {
      // Store the ENTIRE line as-is (includes indent, marker, spacing, text, trailing spaces)
      commentBuffer.push({
        text: line,           // Full line exactly as it appears
        originalLineIndex: i,      // 0-based line index
      });
      continue; // Don’t finalize it yet. move to next line. You might be in the middle of a comment block.
    }

    // CASE 1.5: Currently on Blank line - check if it's within a comment block
    if (!trimmed) { // if no (trimmed) lines
      // If we have comments buffered, this blank line is part of the comment block
      // Include it so spacing is preserved exactly as typed
      if (commentBuffer.length > 0) {
        commentBuffer.push({
          text: line,           // Empty or whitespace-only line
          originalLineIndex: i, // 0-based line index
        });
      }
      // Skip blank lines that are before any comments (they're just file spacing)
      continue;
    }

    // CASE 2: This line is code - check for inline comment(s)
    // Find the first comment marker preceded by white space and extract everything after it as ONE combined comment
    // (\\s+) → one or more whitespace characters
    let inlineRegex = new RegExp(`(\\s+)(${markerPattern})`, "");
    let match = line.match(inlineRegex);

    if (match) {
      const commentStartIndex = match.index; // tells where the comment begins.
      const fullComment = line.substring(commentStartIndex); // extract from that point to the end → the whole inline comment.

      // Context line hashes that are before and after
      const prevIdx = findPrevCodeLine(i);
      const nextIdx = findNextCodeLine(i);

      // Hash only the code portion before the first inline comment marker
      const anchorBase = line.substring(0, commentStartIndex).trimEnd();

      const inlineComment = {
        type: "inline",
        anchor: hashLine(anchorBase, 0), // hash of the line's code (for identification later),
        prevHash: prevIdx >= 0 ? hashLine(lines[prevIdx], 0) : null,
        nextHash: nextIdx >= 0 ? hashLine(lines[nextIdx], 0) : null,
        originalLineIndex: i, // the line number it appeared on (changes per mode so not reliable alone)
        text: fullComment,  // Store ALL inline comments as one combined text
      };

      // Add debug anchor text if enabled
      if (debugAnchorText) {
        inlineComment.anchorText = anchorBase;
      }

      comments.push(inlineComment);
    }

    // CASE 3: We have buffered comment lines (comment group) above this code line
    // Attach the entire comment block to this line of code
    if (commentBuffer.length > 0) {
      // Store context: previous code line and next code line
      const prevIdx = findPrevCodeLine(i);
      const nextIdx = findNextCodeLine(i);

      // DO NOT include leading or trailing blanks - they should persist in clean mode as spacing
      // Only store the actual comment lines (which may include blanks BETWEEN comment lines)
      const fullBlock = commentBuffer;

      const blockComment = {
        type: "block",
        anchor: hashLine(line, 0), // Just content hash
        prevHash: prevIdx >= 0 ? hashLine(lines[prevIdx], 0) : null,
        nextHash: nextIdx >= 0 ? hashLine(lines[nextIdx], 0) : null,
        insertAbove: true, // when re-adding comments, they should appear above that line.
        block: fullBlock,
      };

      // Add debug anchor text if enabled
      if (debugAnchorText) {
        blockComment.anchorText = line;
      }

      comments.push(blockComment);
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

    const headerComment = {
      type: "block",
      anchor: hashLine(lines[anchorLine] || "", 0), // Just content hash
      prevHash: null, // No previous code line before file header
      nextHash: nextIdx >= 0 ? hashLine(lines[nextIdx], 0) : null,
      insertAbove: true,
      block: commentBuffer,
    };

    // Add debug anchor text if enabled
    if (debugAnchorText) {
      headerComment.anchorText = lines[anchorLine] || "";
    }

    // Insert this block at the beginning of the comments array
    comments.unshift(headerComment);
  }

  return comments;
}

// -----------------------------------------------------------------------------
// Comment Injection
// -----------------------------------------------------------------------------
// Reconstruct source code by injecting comments back into clean code
// cleanText → the code in clean mode (with comments stripped out).
// comments → parsed metadata previously extracted from the commented version (what you want to re-inject).
// includePrivate → flag to decide whether to re-insert private comments.. Default to privatemode off unless specified to avoid undefined
function injectComments(cleanText, comments, includePrivate = false) {
  // split("\n") turns the code into an array of lines so you can loop by index.
  const lines = cleanText.split("\n");
  const result = [];  // Where you’ll push lines and comments in order, then join back later.

  // Include/exclude private comments based on if includePrivate is toggled on or off
  const commentsToInject = comments.filter(c => {
    if (c.alwaysShow) return false; // Always exclude alwaysShow (managed separately)
    if (c.isPrivate && !includePrivate) return false; // Exclude private if not explicitly included
    return true;
  });

  // Create an empty Map to link each line’s unique hash → all positions in the file where that line exists. 
  // (handles duplicates)
  // You use a Map instead of an object because the keys (hash strings) are not simple variable names and you may have duplicates.
  const lineHashToIndices = new Map();
  for (let i = 0; i < lines.length; i++) { // Iterates through every line.
    // Remove whitespace per line and if the result is empty (meaning blank line), it skips it. You don’t hash blank lines because they’re not meaningful anchors for comments.
    if (lines[i].trim()) { 
      // Hash each unique content line
      // Takes the current line’s code content (not line number) and generates a deterministic hash.
      // Hashes let you re-anchor comments even if the code is moved up or down because you can later match by the same hash.
      const hash = hashLine(lines[i], 0); 
      if (!lineHashToIndices.has(hash)) { // If this hash hasn’t been seen before
        lineHashToIndices.set(hash, []); // Create a new list as its value in the map.
      }
      // Add the current line’s index to that hash’s list
      // This allows for duplicate code lines:
      // If the same text appears twice (say, import torch on lines 3 and 20),
      // the map will have: "hash(import torch)" → [3, 20]
      // So later you can decide which one the comment should attach to.
      lineHashToIndices.get(hash).push(i);
    }
  }

  // Helper: Find best matching line index among duplicates using context hashes
  // When several lines share the same content hash, this function decides which one should anchor the comment.
  const findBestMatch = (comment, candidateIndices, usedIndices) => {
    if (candidateIndices.length === 1) { // Shortcut: if only one match: done.
      return candidateIndices[0]; // return that one match
    }

    // When multiple identical code lines exist (same hash), candidateIndices might have several matches.
    // usedIndices tracks lines already assigned to other comments.
    // → You filter them out so you don’t attach multiple comment blocks to the same line.
    const available = candidateIndices.filter(idx => !usedIndices.has(idx));
    if (available.length === 0) {
      // All used, fall back to any candidate
      return candidateIndices[0];
    }

    if (available.length === 1) { // if only one available
      return available[0]; // return that one. No need to score.
    }

    // Build a list of possible line indices, each with a “score” indicating how well its context fits.
    const scores = available.map(idx => {
      let score = 0;

      // Find previous non-blank nearest neighbor code line
      let prevIdx = -1;
      for (let j = idx - 1; j >= 0; j--) {
        if (lines[j].trim()) {
          prevIdx = j;
          break;
        }
      }

      // Find next non-blank nearest neighbor code line
      let nextIdx = -1;
      for (let j = idx + 1; j < lines.length; j++) {
        if (lines[j].trim()) {
          nextIdx = j;
          break;
        }
      }

      // Compare these neighbor lines to the comment’s stored hashes and score based on matching context
      // Add 10 points for each matching context hash.
      // Higher score = better contextual fit.
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
      // Sort by score descending
      if (b.score !== a.score) return b.score - a.score;
      return a.idx - b.idx; // sort and return index by index ascending.
    });

    return scores[0].idx; // Return the index with highest contextual match.
  };

  // Separate block comments by type and sort by originalLineIndex
  // Ensure that when you loop through comments, they’re in natural file order, not random JSON order.
  // .sort(...) orders the comment blocks from top to bottom according to where they originally appeared by line number in the file.
  // That way, when you inject them, they’re added in the same vertical order they were extracted.
  const blockComments = commentsToInject.filter(c => c.type === "block").sort((a, b) => {
    // Each block comment object has a block array. each el = 1 comment line of the block
    // a.block[0]?.originalLineIndex → accesses the first line of that block (top of the comment) and gets its original line number in the old file.
    // The ?. (optional chaining) avoids errors if block or [0] doesn’t exist (so it returns undefined instead of crashing).
    // || 0 = “if we can’t find its original position, assume line 0.”
    const aLine = a.block[0]?.originalLineIndex || 0; 
    const bLine = b.block[0]?.originalLineIndex || 0;
    return aLine - bLine; // sort them ascending (smallest line number - top of file first).
  });
  const inlineComments = commentsToInject.filter(c => c.type === "inline").sort((a, b) => a.originalLineIndex - b.originalLineIndex);

  // Track which indices we've already used
  const usedIndices = new Set();

  // Build maps: Map() is a key-value store where keys can be any type.
  // key = line index of code
  // value = array of block comment objects that attach to that code line.
  // This is what injectComments() uses later to decide “for line i, which comments go above it?”
  const blockMap = new Map();

  // Loops through every block comment that needs to be inserted.
  for (const block of blockComments) {
    // indices is an array of potential candidate line numbers where that code exists now.
    // lineHashToIndices maps a hash of a code line → all possible line indices in the current document that match that code’s hash.
    // block.anchor is that hash value — it’s how we know which code line this comment originally belonged to.
    const indices = lineHashToIndices.get(block.anchor);
    // Only proceed if the anchor’s code still exists in the file (non-null and non-empty array).
    if (indices && indices.length > 0) {
      // findBestMatch() decides which of those possible indices best matches this comment.
      // Example: if that same code line appears twice in the file, it picks the one nearest to where the comment used to be.
      // It also receives usedIndices to avoid assigning a block to an index already taken.
      const targetIndex = findBestMatch(block, indices, usedIndices);
      usedIndices.add(targetIndex); // Adds the target index to usedIndices (taken) so you don’t double-assign it.

      // if the map doesnt exist yet for this index
      if (!blockMap.has(targetIndex)) {
        // initialize an empty array for it
        blockMap.set(targetIndex, []);
      }
      // Actually stores the comment object(s) in that array — meaning:
      // “When reinjecting, for this line index, insert this block comment above it.”
      blockMap.get(targetIndex).push(block);
    }
  }

  // Same logic as blockMap, but this one tracks inline comments.
  // Key = line index of code line, value = array of inline comments that go on that line.
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
  // Iterate through every line of clean code
  // i represents both position in original clean code and potential anchor target for comments.
  for (let i = 0; i < lines.length; i++) {
    // STEP 1: Insert any block comments anchored to this line
    // blocks maps anchor index → block comment(s) that should appear above this code line.
    const blocks = blockMap.get(i);
    // Handle the case of multiple comment blocks anchored to the same code line (stacked).
    if (blocks) {
      for (const block of blocks) {
        // Determine which version to inject: text_cleanMode (if different) or block
        const hasTextCleanMode = block.text_cleanMode && Array.isArray(block.text_cleanMode);
        const cleanModeTexts = hasTextCleanMode ? block.text_cleanMode.map(b => b.text).join('\n') : '';
        const blockTexts = block.block ? block.block.map(b => b.text).join('\n') : '';
        const blocksIdentical = hasTextCleanMode && block.block && cleanModeTexts === blockTexts;

        let linesToInject;
        if (hasTextCleanMode && !blocksIdentical) {
          // Use text_cleanMode (newly typed version)
          linesToInject = block.text_cleanMode;
        } else if (block.block) {
          // Use block (VCM version or identical)
          linesToInject = block.block;
        } else {
          linesToInject = [];
        }

        // Inject all lines from the block (includes leading blanks, comments, and trailing blanks)
        for (const lineObj of linesToInject) {
          result.push(lineObj.text);
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

      // Only use text_cleanMode if it's different from text (avoid double injection)
      const hasTextCleanMode = inline.text_cleanMode && typeof inline.text_cleanMode === 'string';
      const textsIdentical = hasTextCleanMode && inline.text === inline.text_cleanMode;

      if (hasTextCleanMode && !textsIdentical) {
        commentText += inline.text_cleanMode;
      }

      // Add original text (only if no text_cleanMode or they're identical)
      if (inline.text && (!hasTextCleanMode || textsIdentical)) {
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
// 6. Skip comments marked with alwaysShow flag (they appear in all modes)
function stripComments(text, filePath, vcmComments = [], keepPrivate = false, isCleanMode = false) {
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

  // Build sets of comment anchor hashes that should be kept
  const alwaysShowAnchors = new Set();
  const privateAnchors = new Set();
  for (const comment of vcmComments) {
    if (comment.alwaysShow) {
      alwaysShowAnchors.add(comment.anchor);
    }
    if (comment.isPrivate && keepPrivate) {
      privateAnchors.add(comment.anchor);
    }
  }

  // Extract current comments to identify blank lines within comment blocks
  // Pass vcmComments and mode so blank line extraction works correctly
  const currentComments = extractComments(text, filePath, vcmComments, isCleanMode);

  // Build sets for tracking lines
  const allCommentBlockLines = new Set();
  const alwaysShowLines = new Set();
  const alwaysShowInlineComments = new Map();
  const privateLines = new Set();
  const privateInlineComments = new Map();

  for (const current of currentComments) {
    if (current.type === "block" && current.block) {
      // Track all lines in all comment blocks (including blank lines WITHIN them)
      // But DO NOT track leading/trailing blank lines - those should stay visible in ALL modes
      for (const blockLine of current.block) {
        allCommentBlockLines.add(blockLine.originalLineIndex);
      }

      // If this block is alwaysShow, also add to alwaysShow set
      if (alwaysShowAnchors.has(current.anchor)) {
        for (const blockLine of current.block) {
          alwaysShowLines.add(blockLine.originalLineIndex);
        }
      }

      // If this block is private and we're keeping private, add to private set
      if (privateAnchors.has(current.anchor)) {
        for (const blockLine of current.block) {
          privateLines.add(blockLine.originalLineIndex);
        }
      }
    } else if (current.type === "inline") {
      if (alwaysShowAnchors.has(current.anchor)) {
        // For alwaysShow inline comments, store the line index and text
        alwaysShowLines.add(current.originalLineIndex);
        alwaysShowInlineComments.set(current.originalLineIndex, current.text || "");
      }
      if (privateAnchors.has(current.anchor)) {
        // For private inline comments (if keeping), store the line index and text
        privateLines.add(current.originalLineIndex);
        privateInlineComments.set(current.originalLineIndex, current.text || "");
      }
    }
  }

  // Combine alwaysShow and private into comment maps for inline handling
  const inlineCommentsToKeep = new Map([...alwaysShowInlineComments, ...privateInlineComments]);

  const lines = text.split("\n");
  const filteredLines = [];

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    const trimmed = line.trim();

    // Keep lines that are marked as alwaysShow or private (if keeping private)
    if (alwaysShowLines.has(lineIndex) || privateLines.has(lineIndex)) {
      filteredLines.push(line);
      continue;
    }

    // Keep blank lines UNLESS they're part of a comment block (i.e., blank lines BETWEEN comment lines)
    // Blank lines before/after comments should ALWAYS be kept
    if (!trimmed) {
      if (!allCommentBlockLines.has(lineIndex)) {
        filteredLines.push(line);
      }
      continue;
    }

    // Filter out pure comment lines (unless they're alwaysShow or private)
    if (lineStartPattern.test(trimmed)) {
      continue; // Skip this line
    }

    // This is a code line - check for inline comments
    if (inlineCommentsToKeep.has(lineIndex)) {
      // This line has an alwaysShow or private inline comment - keep the entire line
      filteredLines.push(line);
    } else {
      // Remove inline comments: everything after comment marker (if not in string)
      const commentPos = findCommentStart(line);
      if (commentPos >= 0) {
        filteredLines.push(line.substring(0, commentPos).trimEnd());
      } else {
        filteredLines.push(line);
      }
    }
  }

  return filteredLines.join("\n");
}

// -----------------------------------------------------------------------------
// Extension Activate
// -----------------------------------------------------------------------------

async function activate(context) {
  // Load user configuration
  const config = vscode.workspace.getConfiguration("vcm");
  const autoSplit = config.get("autoSplitView", true);  // Auto-split vs same pane
  const liveSync = config.get("liveSync", false);       // Auto-save .vcm on edit
  const debugAnchorText = config.get("debugAnchorText", true); // Store anchor line text for debugging

  // Create .vcm directory in workspace root
  // This stores .vcm.json files that mirror the comment structure
  const vcmBaseDir = vscode.Uri.joinPath(
    vscode.workspace.workspaceFolders?.[0]?.uri || vscode.Uri.file(process.cwd()),
    ".vcm"
  );
  const vcmDir = vscode.Uri.joinPath(vcmBaseDir, "shared");
  const vcmPrivateDir = vscode.Uri.joinPath(vcmBaseDir, "private");

  // Don't auto-create directories - they'll be created when first needed

  // Register content provider for vcm-view: scheme
  // This allows us to create virtual documents that display in the editor
  const provider = new VCMContentProvider();
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider("vcm-view", provider)
  );

  // ---------------------------------------------------------------------------
  // Update context for menu items based on cursor position
  // ---------------------------------------------------------------------------
  async function updateAlwaysShowContext() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      await vscode.commands.executeCommand('setContext', 'vcm.commentIsAlwaysShow', false);
      await vscode.commands.executeCommand('setContext', 'vcm.cursorOnComment', false);
      return;
    }

    const doc = editor.document;
    const selectedLine = editor.selection.active.line;
    const line = doc.lineAt(selectedLine);
    const text = line.text;
    const trimmed = text.trim();

    // Check if cursor is on a comment line (either block comment or inline comment)
    const isBlockComment = trimmed.match(/^(\s*)(#|\/\/|--|%|;)/);
    const commentMarkers = getCommentMarkersForFile(doc.uri.path);
    let isInlineComment = false;

    // Check if line contains an inline comment
    if (!isBlockComment) {
      for (const marker of commentMarkers) {
        const markerIndex = text.indexOf(marker);
        if (markerIndex > 0) {
          // Comment marker appears after position 0, so it's inline
          isInlineComment = true;
          break;
        }
      }
    }

    const isOnComment = isBlockComment || isInlineComment;
    await vscode.commands.executeCommand('setContext', 'vcm.cursorOnComment', !!isOnComment);

    if (!isOnComment) {
      await vscode.commands.executeCommand('setContext', 'vcm.commentIsAlwaysShow', false);
      await vscode.commands.executeCommand('setContext', 'vcm.commentIsPrivate', false);
      return;
    }

    // Check if this comment is marked as alwaysShow or private
    const relativePath = vscode.workspace.asRelativePath(doc.uri);

    try {
      const { allComments: comments } = await loadAllComments(relativePath);

      // Find the anchor hash for this comment
      const lines = doc.getText().split("\n");
      let anchorHash;

      if (isInlineComment) {
        // For inline comments, the anchor is the code portion before the comment
        // Find where the comment starts and hash only the code part
        let commentStartIndex = -1;
        for (const marker of commentMarkers) {
          const markerRegex = new RegExp(`(\\s+)(${marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`);
          const match = text.match(markerRegex);
          if (match) {
            commentStartIndex = match.index;
            break;
          }
        }
        if (commentStartIndex > 0) {
          const anchorBase = text.substring(0, commentStartIndex).trimEnd();
          anchorHash = hashLine(anchorBase, 0);
        } else {
          await vscode.commands.executeCommand('setContext', 'vcm.commentIsAlwaysShow', false);
          await vscode.commands.executeCommand('setContext', 'vcm.commentIsPrivate', false);
          return;
        }
      } else {
        // For block comments, find the next non-comment line
        let anchorLineIndex = -1;
        for (let i = selectedLine + 1; i < lines.length; i++) {
          const trimmed = lines[i].trim();
          if (trimmed && !trimmed.match(/^(\s*)(#|\/\/|--|%|;)/)) {
            anchorLineIndex = i;
            break;
          }
        }

        // If no code line below, fallback to the previous code line
        if (anchorLineIndex === -1) {
          for (let i = selectedLine - 1; i >= 0; i--) {
            const trimmed = lines[i].trim();
            if (trimmed && !trimmed.match(/^(\s*)(#|\/\/|--|%|;)/)) {
              anchorLineIndex = i;
              break;
            }
          }
        }

        if (anchorLineIndex === -1) {
          await vscode.commands.executeCommand('setContext', 'vcm.commentIsAlwaysShow', false);
          await vscode.commands.executeCommand('setContext', 'vcm.commentIsPrivate', false);
          return;
        }

        anchorHash = hashLine(lines[anchorLineIndex], 0);
      }

      // Check if any comment with this anchor has alwaysShow or isPrivate
      let isAlwaysShow = false;
      let isPrivate = false;
      for (const c of comments) {
        if (c.anchor === anchorHash) {
          // For inline comments, also verify we're on the correct line
          if (c.type === "inline" && isInlineComment) {
            // Extract current comments and match by line
            const currentComments = extractComments(doc.getText(), doc.uri.path);
            const matchingCurrent = currentComments.find(curr =>
              curr.anchor === anchorHash && curr.originalLineIndex === selectedLine
            );
            if (matchingCurrent) {
              if (c.alwaysShow) isAlwaysShow = true;
              if (c.isPrivate) isPrivate = true;
            }
          } else {
            // For block comments, anchor match is sufficient
            if (c.alwaysShow) isAlwaysShow = true;
            if (c.isPrivate) isPrivate = true;
          }
        }
      }

      await vscode.commands.executeCommand('setContext', 'vcm.commentIsAlwaysShow', isAlwaysShow);
      await vscode.commands.executeCommand('setContext', 'vcm.commentIsPrivate', isPrivate);
    } catch {
      await vscode.commands.executeCommand('setContext', 'vcm.commentIsAlwaysShow', false);
      await vscode.commands.executeCommand('setContext', 'vcm.commentIsPrivate', false);
    }
  }

  // Update context when selection changes
  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection(() => updateAlwaysShowContext())
  );

  // Update context when active editor changes
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => updateAlwaysShowContext())
  );

  // Initial update
  updateAlwaysShowContext();

  // ===========================================================================
  // Helper functions for managing shared and private VCM files
  // ===========================================================================

  // Load all comments from both shared and private VCM files
  async function loadAllComments(relativePath) {
    const sharedFileUri = vscode.Uri.joinPath(vcmDir, relativePath + ".vcm.json");
    const privateFileUri = vscode.Uri.joinPath(vcmPrivateDir, relativePath + ".vcm.json");

    let sharedComments = [];
    let privateComments = [];

    try {
      const sharedData = JSON.parse((await vscode.workspace.fs.readFile(sharedFileUri)).toString());
      sharedComments = sharedData.comments || [];
    } catch {
      // No shared VCM file
    }

    try {
      const privateData = JSON.parse((await vscode.workspace.fs.readFile(privateFileUri)).toString());
      privateComments = (privateData.comments || []).map(c => ({ ...c, isPrivate: true }));
    } catch {
      // No private VCM file
    }

    return { sharedComments, privateComments, allComments: [...sharedComments, ...privateComments] };
  }

  // Save comments, splitting them into shared and private files
  async function saveCommentsToVCM(relativePath, comments) {
    const sharedComments = comments.filter(c => !c.isPrivate);
    const privateComments = comments.filter(c => c.isPrivate).map(c => {
      const { isPrivate, ...rest } = c;
      return rest; // Remove isPrivate flag when saving to private file
    });

    // Save shared comments (only if there are shared comments or a shared VCM file already exists)
    const sharedExists = await vcmFileExists(vcmDir, relativePath);
    if (sharedComments.length > 0 || sharedExists) {
      // Ensure the base .vcm/shared directory exists
      await vscode.workspace.fs.createDirectory(vcmDir).catch(() => {});

      const sharedFileUri = vscode.Uri.joinPath(vcmDir, relativePath + ".vcm.json");
      const sharedData = {
        file: relativePath,
        lastModified: new Date().toISOString(),
        comments: sharedComments,
      };

      // Ensure dir structure exists
      const pathParts = relativePath.split(/[\\/]/);
      if (pathParts.length > 1) {
        const vcmSubdir = vscode.Uri.joinPath(vcmDir, pathParts.slice(0, -1).join("/"));
        await vscode.workspace.fs.createDirectory(vcmSubdir).catch(() => {});
      }

      await vscode.workspace.fs.writeFile(
        sharedFileUri,
        Buffer.from(JSON.stringify(sharedData, null, 2), "utf8")
      );
    }

    // 4️⃣ Private VCM path + write or delete
    const privateFileUri = vscode.Uri.joinPath(vcmPrivateDir, relativePath + ".vcm.json");
    if (privateComments.length > 0) {
      const privateData = {
        file: relativePath,
        lastModified: new Date().toISOString(),
        comments: privateComments,
      };

      const pathParts = relativePath.split(/[\\/]/);
      if (pathParts.length > 1) {
        const vcmPrivateSubdir = vscode.Uri.joinPath(vcmPrivateDir, pathParts.slice(0, -1).join("/"));
        await vscode.workspace.fs.createDirectory(vcmPrivateSubdir).catch(() => {});
      }

      await vscode.workspace.fs.writeFile(
        privateFileUri,
        Buffer.from(JSON.stringify(privateData, null, 2), "utf8")
      );
    } else {
      // Delete private VCM file if no private comments
      const privateFileUri = vscode.Uri.joinPath(vcmPrivateDir, relativePath + ".vcm.json");
      try {
        await vscode.workspace.fs.delete(privateFileUri);
      } catch {
        // Ignore non-existent file
      }
    }
  }

  // Check if a VCM file exists
  async function vcmFileExists(dir, relativePath) {
    try {
      await vscode.workspace.fs.stat(vscode.Uri.joinPath(dir, relativePath + ".vcm.json"));
      return true;
    } catch {
      return false;
    }
  }

  // ============================================================================
  // processCommentSync()
  // ============================================================================
  // Reusable function for processing comment synchronization in both commented
  // and clean modes. Handles matching, deduplication, and property updates.
  // Used for both shared and private comments to eliminate code duplication.
  // ============================================================================
  function processCommentSync({
    isCommented,           // boolean: true = commented mode, false = clean mode
    currentComments,       // array: comments extracted from current document
    existingComments,      // array: comments from VCM file (will be modified in place for clean mode)
    otherComments = [],    // array: comments from other VCM (to detect cross-contamination)
    isPrivateMode = false, // boolean: true = processing private comments, false = shared
    wasJustInjected = false, // boolean: skip processing in clean mode if just injected
  }) {
    // If just injected in clean mode, return existing comments unchanged
    if (!isCommented && wasJustInjected) {
      return existingComments;
    }

    let finalComments;

    if (isCommented) {
      // ========================================================================
      // COMMENTED MODE: Replace VCM with current state, preserving metadata
      // ========================================================================

      // Build map of existing comments by anchor
      const existingByKey = new Map();
      const existingByText = new Map();
      for (const existing of existingComments) {
        const key = `${existing.type}:${existing.anchor}`;
        if (!existingByKey.has(key)) {
          existingByKey.set(key, []);
        }
        existingByKey.get(key).push(existing);

        // Index by text to handle anchor changes
        const textKey = existing.text || (existing.block ? existing.block.map(b => b.text).join('\n') : '');
        if (textKey && !existingByText.has(textKey)) {
          existingByText.set(textKey, existing);
        }
      }

      // Build map of "other" comments (private if processing shared, shared if processing private)
      const otherByKey = new Map();
      const otherByText = new Map();
      for (const otherComment of otherComments) {
        const key = `${otherComment.type}:${otherComment.anchor}`;
        if (!otherByKey.has(key)) {
          otherByKey.set(key, []);
        }
        otherByKey.get(key).push(otherComment);

        // Index by text
        const textKey = otherComment.text || (otherComment.block ? otherComment.block.map(b => b.text).join('\n') : '');
        if (textKey && !otherByText.has(textKey)) {
          otherByText.set(textKey, otherComment);
        }
      }

      // Track which existing comments we've matched
      const matchedExisting = new Set();

      // Process current comments and match with existing to preserve metadata
      finalComments = currentComments.map(current => {
        const key = `${current.type}:${current.anchor}`;
        const currentText = current.text || (current.block ? current.block.map(b => b.text).join('\n') : '');

        // Check if this comment exists in the "other" VCM (cross-contamination detection)
        const otherCandidates = otherByKey.get(key) || [];
        if (otherCandidates.length > 0) {
          // This comment belongs to the other VCM - mark it appropriately
          return {
            ...current,
            isPrivate: !isPrivateMode, // If processing shared, mark as private; if processing private, don't mark
          };
        }

        // Also check by text in case anchor changed
        if (currentText && otherByText.has(currentText)) {
          return {
            ...current,
            isPrivate: !isPrivateMode,
          };
        }

        // Not from other VCM - check this VCM's existing comments for metadata
        const candidates = existingByKey.get(key) || [];
        if (candidates.length > 0) {
          // Found match by anchor - preserve metadata
          const existing = candidates[0];
          matchedExisting.add(existing);
          candidates.shift();
          if (candidates.length === 0) {
            existingByKey.delete(key);
          }
          return {
            ...current,
            alwaysShow: existing.alwaysShow || undefined,
            // Preserve any other metadata fields here
          };
        }

        // No match by anchor - try matching by text (anchor might have changed)
        if (currentText && existingByText.has(currentText)) {
          const existing = existingByText.get(currentText);
          if (!matchedExisting.has(existing)) {
            matchedExisting.add(existing);
            return {
              ...current,
              alwaysShow: existing.alwaysShow || undefined,
            };
          }
        }

        // No match found - return as-is (new comment)
        return current;
      });

      // In commented mode, DO NOT add back unmatched existing comments
      // If a comment isn't in the current document, it was deleted

    } else {
      // ========================================================================
      // CLEAN MODE: Preserve hidden VCM comments, track new ones via text_cleanMode (shared) or direct update (private)
      // ========================================================================

      // Build map of existing comments by anchor + context hashes
      const existingByKey = new Map();
      for (const existing of existingComments) {
        const key = `${existing.type}:${existing.anchor}:${existing.prevHash || 'null'}:${existing.nextHash || 'null'}`;
        if (!existingByKey.has(key)) {
          existingByKey.set(key, []);
        }
        existingByKey.get(key).push(existing);
      }

      // Build set of "other" comment keys for filtering
      const otherKeys = new Set();
      const otherTexts = new Set();
      for (const otherComment of otherComments) {
        const key = `${otherComment.type}:${otherComment.anchor}:${otherComment.prevHash || 'null'}:${otherComment.nextHash || 'null'}`;
        otherKeys.add(key);

        const textKey = otherComment.text || (otherComment.block ? otherComment.block.map(b => b.text).join('\n') : '');
        if (textKey) {
          otherTexts.add(`${otherComment.type}:${textKey}`);
        }
      }

      if (isPrivateMode) {
        // ====================================================================
        // PRIVATE MODE IN CLEAN: Update anchors by matching text (like shared)
        // ====================================================================

        // Build map by text for matching
        const existingByText = new Map();
        for (const existing of existingComments) {
          const textKey = existing.text || (existing.block ? existing.block.map(b => b.text).join('\n') : '');
          if (textKey && !existingByText.has(textKey)) {
            existingByText.set(textKey, existing);
          }
        }

        // Track which existing comments we've matched
        const matchedExisting = new Set();

        // Process current comments
        for (const current of currentComments) {
          const key = `${current.type}:${current.anchor}:${current.prevHash || 'null'}:${current.nextHash || 'null'}`;
          const currentText = current.text || (current.block ? current.block.map(b => b.text).join('\n') : '');

          // Skip if this comment belongs to the "other" VCM (shared)
          if (otherKeys.has(key)) {
            continue;
          }

          // Match by text first (handles when comment moves)
          let existing = null;
          if (currentText && existingByText.has(currentText)) {
            const candidate = existingByText.get(currentText);
            if (!matchedExisting.has(candidate)) {
              existing = candidate;
              matchedExisting.add(existing);
              // Update anchor to new position
              existing.anchor = current.anchor;
              existing.prevHash = current.prevHash;
              existing.nextHash = current.nextHash;
              existing.originalLineIndex = current.originalLineIndex;
              // Update content
              existing.text = current.text;
              existing.block = current.block;
              // Update anchorText
              if (current.anchorText !== undefined) {
                existing.anchorText = current.anchorText;
              }
            }
          }

          // If no text match, try anchor match
          if (!existing) {
            const candidates = existingByKey.get(key) || [];
            if (candidates.length > 0 && !matchedExisting.has(candidates[0])) {
              existing = candidates[0];
              matchedExisting.add(existing);
              // Update content
              existing.text = current.text;
              existing.block = current.block;
              if (current.anchorText !== undefined) {
                existing.anchorText = current.anchorText;
              }
            }
          }

          // If still no match, add as new
          if (!existing) {
            existingComments.push(current);
            matchedExisting.add(current);
          }
        }

        // Return all existing comments (updated in place)
        finalComments = existingComments;

      } else {
        // ====================================================================
        // SHARED MODE IN CLEAN: Track changes via text_cleanMode
        // ====================================================================

        // Build map by text_cleanMode content for matching
        const existingByTextCleanMode = new Map();
        for (const existing of existingComments) {
          if (existing.text_cleanMode) {
            const textKey = typeof existing.text_cleanMode === 'string'
              ? existing.text_cleanMode
              : (Array.isArray(existing.text_cleanMode) ? existing.text_cleanMode.map(b => b.text).join('\n') : '');
            if (textKey && !existingByTextCleanMode.has(textKey)) {
              existingByTextCleanMode.set(textKey, existing);
            }
          }
        }

        // Track which existing comments we've matched
        const matchedInCleanMode = new Set();

        // Process current comments (typed in clean mode)
        for (const current of currentComments) {
          const key = `${current.type}:${current.anchor}:${current.prevHash || 'null'}:${current.nextHash || 'null'}`;
          const currentText = current.text || (current.block ? current.block.map(b => b.text).join('\n') : '');
          const textKey = `${current.type}:${currentText}`;

          // Skip if this comment belongs to the "other" VCM
          if (otherKeys.has(key) || otherTexts.has(textKey)) {
            continue;
          }

          // Also check by text in case anchor changed
          // BUT: Only skip if this text matches other comment AND doesn't match any existing comment
          const isOtherCommentText = otherTexts.has(textKey);
          const isExistingCommentText = existingByTextCleanMode.has(currentText) ||
                                        existingComments.some(ec => {
                                          const ecText = ec.text || '';
                                          return ecText === currentText;
                                        });

          if (isOtherCommentText && !isExistingCommentText) {
            // This text only exists in other VCM, not in this one - skip it
            continue;
          }

          // Process as a comment for this VCM
          let existing = null;

          // First, try to match by text_cleanMode content (handles anchor changes)
          if (currentText && existingByTextCleanMode.has(currentText)) {
            const candidate = existingByTextCleanMode.get(currentText);
            if (!matchedInCleanMode.has(candidate)) {
              existing = candidate;
              matchedInCleanMode.add(existing);
              // Update anchor to new position (comment moved with code)
              existing.anchor = current.anchor;
              existing.prevHash = current.prevHash;
              existing.nextHash = current.nextHash;
            }
          }

          // If no text match, try anchor match (for VCM comments)
          if (!existing) {
            const candidates = existingByKey.get(key) || [];
            if (candidates.length > 0 && !matchedInCleanMode.has(candidates[0])) {
              existing = candidates[0];
              matchedInCleanMode.add(existing);
            }
          }

          if (existing) {
            // Update text_cleanMode
            if (current.type === "inline") {
              if (current.text !== existing.text) {
                existing.text_cleanMode = current.text;
              } else {
                existing.text_cleanMode = null;
              }
            } else if (current.type === "block") {
              const existingTexts = existing.block?.map(b => b.text).join('\n') || '';
              const currentTexts = current.block?.map(b => b.text).join('\n') || '';
              const blocksIdentical = existingTexts === currentTexts;

              if (!blocksIdentical) {
                existing.text_cleanMode = current.block;
              } else {
                existing.text_cleanMode = null;
              }
            }
          } else {
            // No match - this is a newly typed comment in clean mode
            const newComment = { ...current };
            if (current.type === "inline") {
              newComment.text_cleanMode = current.text;
              delete newComment.text;
            } else if (current.type === "block") {
              newComment.text_cleanMode = current.block;
              delete newComment.block;
            }
            existingComments.push(newComment);
            matchedInCleanMode.add(newComment);
          }
        }

        // Remove text_cleanMode from comments that were deleted in clean mode
        for (const existing of existingComments) {
          if (existing.text_cleanMode) {
            const key = `${existing.type}:${existing.anchor}`;
            const stillExists = currentComments.some(c =>
              `${c.type}:${c.anchor}` === key
            );

            if (!stillExists) {
              // User deleted this comment in clean mode
              existing.text_cleanMode = null;
            }
          }
        }

        finalComments = existingComments;
      }
    }

    return finalComments;
  }

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

    // Load existing VCM data from both shared and private files
    const { sharedComments: existingComments, privateComments: existingPrivateComments } = await loadAllComments(relativePath);

    // Get the current mode from our state map
    // IMPORTANT: Once mode is set, it should NEVER change except via manual toggle or undo/redo
    let isCommented = isCommentedMap.get(doc.uri.fsPath);

    // If state is not set, initialize it by detecting the mode
    // This only happens on first open or after a restart
    if (isCommented === undefined) {
      isCommented = await detectInitialMode(doc, vcmDir);
      isCommentedMap.set(doc.uri.fsPath, isCommented);
    }

    // Initialize private comment visibility if not set
    // After initialization, state is managed by toggles and undo/redo detection (same as commented mode)
    if (!privateCommentsVisible.has(doc.uri.fsPath)) {
      const privateVisible = await detectPrivateVisibility(doc, relativePath);
      privateCommentsVisible.set(doc.uri.fsPath, privateVisible);
    }

    // Debug: Never re-detect mode during normal saves - mode should be stable
    // Both commented/clean mode AND private visibility are managed by toggles and undo/redo detection

    // Extract all current comments from the document
    // Pass mode and ALL existing comments (shared + private) so blank lines are handled correctly
    // This is critical for proper matching when private comments are visible in clean mode
    const isCleanMode = !isCommented;
    const allExistingComments = [...existingComments, ...existingPrivateComments];
    const currentComments = extractComments(text, doc.uri.path, allExistingComments, isCleanMode, debugAnchorText);

    // ------------------------------------------------------------------------
    // Merge Strategy - Using processCommentSync for both shared and private
    // ------------------------------------------------------------------------

    // Process shared comments (these may include isPrivate flags in commented mode)
    let finalComments = processCommentSync({
      isCommented,
      currentComments,
      existingComments,
      otherComments: existingPrivateComments,
      isPrivateMode: false,
      wasJustInjected,
    });

    // Process private comments (updates anchors and content)
    processCommentSync({
      isCommented,
      currentComments,
      existingComments: existingPrivateComments,
      otherComments: existingComments,
      isPrivateMode: true,
      wasJustInjected,
    });

    // ------------------------------------------------------------------------
    // Filter out empty comments (no text, block, or text_cleanMode content)
    // ------------------------------------------------------------------------
    finalComments = finalComments.filter(comment => {
      // For inline comments: must have text or text_cleanMode
      if (comment.type === 'inline') {
        return (comment.text && comment.text.trim()) ||
               (comment.text_cleanMode && comment.text_cleanMode.trim());
      }
      // For block comments: must have block or text_cleanMode with content
      else if (comment.type === 'block') {
        const hasBlock = comment.block && Array.isArray(comment.block) && comment.block.length > 0;
        const hasTextCleanMode = comment.text_cleanMode && Array.isArray(comment.text_cleanMode) && comment.text_cleanMode.length > 0;
        return hasBlock || hasTextCleanMode;
      }
      return true;
    });

    // ------------------------------------------------------------------------
    // Save final comments, splitting into shared and private files
    // ------------------------------------------------------------------------
    // In commented mode: private comments are extracted and already in finalComments with isPrivate: true
    // In clean mode: private comments were processed separately and updated in place (text-based matching)

    // Check which private comments are already in finalComments (using text+anchor+type as key)
    // In commented mode: private comments were extracted and marked with isPrivate
    // In clean mode: private comments were updated separately via text-based matching
    const finalCommentsSet = new Set(finalComments.map(c => {
      const text = c.text || (c.block ? c.block.map(b => b.text).join('\n') : '');
      return `${c.type}:${c.anchor}:${text}`;
    }));

    // Add private comments that aren't already in finalComments
    // (They might already be there if private comments were visible and got extracted)
    const missingPrivateComments = existingPrivateComments.filter(pc => {
      const text = pc.text || (pc.block ? pc.block.map(b => b.text).join('\n') : '');
      const key = `${pc.type}:${pc.anchor}:${text}`;
      return !finalCommentsSet.has(key);
    }).map(pc => ({ ...pc, isPrivate: true })); // Ensure isPrivate flag is set

    const finalCommentsWithPrivate = [...finalComments, ...missingPrivateComments];
    await saveCommentsToVCM(relativePath, finalCommentsWithPrivate);
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
  // Helper: Generate commented version (for toggle and split view)
  // ---------------------------------------------------------------------------
  async function generateCommentedVersion(text, filePath, relativePath, includePrivate) {
    try {
      // Load ALL comments (shared + private) to handle includePrivate correctly
      const { sharedComments, privateComments } = await loadAllComments(relativePath);

      // Merge text_cleanMode into text/block (but don't modify the original) for shared comments
      const mergedSharedComments = sharedComments.map(comment => {
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

      // Combine shared and private comments (all need to be in array for proper filtering)
      const allComments = [...mergedSharedComments, ...privateComments];

      // Strip ALL comments from source (both shared and private) before injecting
      // We want a clean slate, then inject only what's needed based on includePrivate
      const cleanText = stripComments(text, filePath, allComments, false, true);
      return injectComments(cleanText, allComments, includePrivate);
    } catch {
      // No .vcm file exists
      return text;
    }
  }

  // Split view live sync: update the VCM split view when source file changes
  // This is separate from liveSync setting and always enabled when split view is open
  let splitViewUpdateTimeout;
  const splitViewSyncWatcher = vscode.workspace.onDidChangeTextDocument(async (e) => {
    // Only sync if split view is open
    if (!vcmEditor || !tempUri || !sourceDocUri) return;

    // Only sync changes to the source document (not the vcm-view: document)
    if (e.document.uri.scheme === "vcm-view") return;

    // Only sync if this is the document that has the split view open
    if (e.document.uri.toString() !== sourceDocUri.toString()) return;

    const doc = e.document;
    const relativePath = vscode.workspace.asRelativePath(doc.uri);

    // Check if this is an undo/redo operation
    const isUndoRedo = e.reason === vscode.TextDocumentChangeReason.Undo ||
                       e.reason === vscode.TextDocumentChangeReason.Redo;

    // Debounce updates to prevent multiple rapid changes
    clearTimeout(splitViewUpdateTimeout);
    splitViewUpdateTimeout = setTimeout(async () => {
      try {
        // Get updated text from the document (source of truth)
        const text = doc.getText();

        let actualMode;
        const storedMode = isCommentedMap.get(doc.uri.fsPath);

        // Only detect mode on undo/redo/paste (might have changed modes)
        // For normal typing, use stored mode (typing in clean mode stays in clean mode)
        if (isUndoRedo) {
          actualMode = await detectInitialMode(doc, vcmDir);
          if (storedMode !== actualMode) {
            isCommentedMap.set(doc.uri.fsPath, actualMode);
          } else {
            actualMode = storedMode;
          }

          // Also detect private visibility on undo/redo
          const actualPrivateVisibility = await detectPrivateVisibility(doc, relativePath);
          const storedPrivateVisibility = privateCommentsVisible.get(doc.uri.fsPath);
          if (storedPrivateVisibility !== actualPrivateVisibility) {
            privateCommentsVisible.set(doc.uri.fsPath, actualPrivateVisibility);
          }
        } else {
          actualMode = storedMode;
        }

        // Get current private visibility state
        const includePrivate = privateCommentsVisible.get(doc.uri.fsPath) === true;

        let showVersion;
        if (actualMode) {
          // Source is in commented mode, show clean in split view
          // Load VCM comments to preserve alwaysShow metadata
          const { allComments: vcmComments } = await loadAllComments(relativePath);
          showVersion = stripComments(text, doc.uri.path, vcmComments, includePrivate);
        } else {
          // Source is in clean mode, show commented in split view
          // Use the same logic as toggling to commented mode
          showVersion = await generateCommentedVersion(text, doc.uri.path, relativePath, includePrivate);
        }

        // Update the split view content
        provider.update(tempUri, showVersion);
      } catch (err) {
        // Ignore errors - VCM might not exist yet
      }
    }, 300); // Longer debounce to handle rapid undo/redo operations
  });
  context.subscriptions.push(splitViewSyncWatcher);

  // Helper function to close split view tab and clean up
  const closeSplitView = async () => {
    if (tempUri) {
      try {
        // Find the specific VCM tab and close only that tab (not the whole pane)
        const allTabs = vscode.window.tabGroups.all.flatMap(group => group.tabs);
        const vcmTab = allTabs.find(tab => {
          if (tab.input instanceof vscode.TabInputText) {
            return tab.input.uri.toString() === tempUri.toString();
          }
          return false;
        });

        if (vcmTab) {
          await vscode.window.tabGroups.close(vcmTab);
        }
      } catch {
        // ignore errors if already closed
      }
    }
    
    // Clean up our own references
    vcmEditor = null;
    tempUri = null;
    sourceDocUri = null;
    if (scrollListener) {
      scrollListener.dispose();
      scrollListener = null;
    }
  };

  // Clean up when split view is closed (always, not just when liveSync is enabled)
  const closeWatcher = vscode.workspace.onDidCloseTextDocument((doc) => {
    if (tempUri && doc.uri.toString() === tempUri.toString()) {
      // Split view document was closed
      vcmEditor = null;
      tempUri = null;
      sourceDocUri = null;
      if (scrollListener) {
        scrollListener.dispose();
        scrollListener = null;
      }
    } else if (sourceDocUri && doc.uri.toString() === sourceDocUri.toString()) {
      // Source document was closed - close the split view too
      closeSplitView();
    }
  });
  context.subscriptions.push(closeWatcher);

  // Monitor visible editors - close split view if source is no longer visible
  const visibleEditorsWatcher = vscode.window.onDidChangeVisibleTextEditors((editors) => {
    // If we have a split view open, check if source is still visible
    if (sourceDocUri && tempUri) {
      const sourceVisible = editors.some(e => e.document.uri.toString() === sourceDocUri.toString());
      if (!sourceVisible) {
        // Source is no longer visible - close the split view
        closeSplitView();
      }
    }
  });
  context.subscriptions.push(visibleEditorsWatcher);

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
      const initialState = await detectInitialMode(doc, vcmDir);
      isCommentedMap.set(doc.uri.fsPath, initialState);
    }

    // Detect private comment visibility if not already set
    if (!privateCommentsVisible.has(doc.uri.fsPath)) {
      const privateVisible = await detectPrivateVisibility(doc, relativePath);
      privateCommentsVisible.set(doc.uri.fsPath, privateVisible);
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
        // We're still in commented mode here, so this will extract all comments
        await saveVCM(doc);
      }

      // If liveSync is disabled, always update manually
      // We're still in commented mode here, so this will extract all comments
      const config = vscode.workspace.getConfiguration("vcm");
      const liveSync = config.get("liveSync", false);
      if (!liveSync) {
        await saveVCM(doc);
      }

      // Load ALL VCM comments (shared + private) to check for alwaysShow and isPrivate
      const { allComments: vcmComments } = await loadAllComments(relativePath);

      // Strip comments to show clean version (but keep alwaysShow and private if visible)
      const keepPrivate = privateCommentsVisible.get(doc.uri.fsPath) === true;
      newText = stripComments(text, doc.uri.path, vcmComments, keepPrivate);
      // Mark this file as now in clean mode
      isCommentedMap.set(doc.uri.fsPath, false);
      // DO NOT change privateCommentsVisible - private comment visibility persists across mode toggles
      vscode.window.showInformationMessage("VCM: Switched to clean mode (comments hidden)");
    } else {
      // Currently in clean mode -> switch to commented mode (show comments)
      try {
        // Load ALL comments (shared + private) to handle includePrivate correctly
        const { sharedComments: existingSharedComments, privateComments: existingPrivateComments } = await loadAllComments(relativePath);

        // Merge text_cleanMode into text/block and clear text_cleanMode for shared comments
        const mergedSharedComments = existingSharedComments.map(comment => {
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

        // Combine shared and private comments (all need to be in the array for proper filtering)
        const allMergedComments = [...mergedSharedComments, ...existingPrivateComments];

        // Strip any comments typed in clean mode before injecting VCM comments
        const cleanText = stripComments(text, doc.uri.path, allMergedComments, false);
        const includePrivate = privateCommentsVisible.get(doc.uri.fsPath) === true;
        newText = injectComments(cleanText, allMergedComments, includePrivate);

        // Save the merged shared comments back to VCM (private comments are stored separately)
        const updatedVcmData = {
          file: relativePath,
          lastModified: new Date().toISOString(),
          comments: mergedSharedComments,
        };
        await vscode.workspace.fs.writeFile(
          vcmFileUri,
          Buffer.from(JSON.stringify(updatedVcmData, null, 2), "utf8")
        );

        // Mark this file as now in commented mode
        isCommentedMap.set(doc.uri.fsPath, true);
        // DO NOT change privateCommentsVisible - private comment visibility persists across mode toggles

        // Mark that we just injected from VCM - don't re-extract on next save
        justInjectedFromVCM.add(doc.uri.fsPath);

        vscode.window.showInformationMessage("VCM: Switched to commented mode (comments visible)");
      } catch {
        // No .vcm file exists yet — create one now
        isCommentedMap.set(doc.uri.fsPath, true);
        // DO NOT initialize privateCommentsVisible - it will default to false (hidden) if not set
        await saveVCM(doc);
        try {
          // Load ALL comments (shared + private) after saving
          const { sharedComments, privateComments } = await loadAllComments(relativePath);
          const allComments = [...sharedComments, ...privateComments];

          // Strip comments before injecting (except alwaysShow and private if visible)
          const keepPrivate = privateCommentsVisible.get(doc.uri.fsPath) === true;
          const cleanText = stripComments(text, doc.uri.path, allComments, keepPrivate);
          newText = injectComments(cleanText, allComments, keepPrivate);

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
  // COMMAND: Right-click -> "Always Show This Comment"
  // ---------------------------------------------------------------------------
  const markAlwaysShow = vscode.commands.registerCommand(
    "vcm-view-comments-mirror.markAlwaysShow",
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;

      const doc = editor.document;
      const selectedLine = editor.selection.active.line;
      const line = doc.lineAt(selectedLine);
      const text = line.text;
      const trimmed = text.trim();

      // Check if line has a comment (block or inline)
      const isBlockComment = trimmed.match(/^(\s*)(#|\/\/|--|%|;)/);
      const commentMarkers = getCommentMarkersForFile(doc.uri.path);
      let isInlineComment = false;

      // Check if line contains an inline comment
      if (!isBlockComment) {
        for (const marker of commentMarkers) {
          const markerIndex = text.indexOf(marker);
          if (markerIndex > 0) {
            // Comment marker appears after position 0, so it's inline
            isInlineComment = true;
            break;
          }
        }
      }

      if (!isBlockComment && !isInlineComment) {
        vscode.window.showWarningMessage("VCM: You can only mark comment lines as 'Always Show'.");
        return;
      }

      const relativePath = vscode.workspace.asRelativePath(doc.uri);

      try {
        // Find the anchor hash for this comment
        const lines = doc.getText().split("\n");
        let anchorHash;

        if (isInlineComment) {
          // For inline comments, the anchor is the code portion before the comment
          // Find where the comment starts and hash only the code part
          let commentStartIndex = -1;
          for (const marker of commentMarkers) {
            const markerRegex = new RegExp(`(\\s+)(${marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`);
            const match = text.match(markerRegex);
            if (match) {
              commentStartIndex = match.index;
              break;
            }
          }
          if (commentStartIndex > 0) {
            const anchorBase = text.substring(0, commentStartIndex).trimEnd();
            anchorHash = hashLine(anchorBase, 0);
          } else {
            vscode.window.showErrorMessage("VCM: Could not find comment marker.");
            return;
          }
        } else {
          // For block comments, find the next non-comment line
          let anchorLineIndex = -1;
          for (let i = selectedLine + 1; i < lines.length; i++) {
            const trimmed = lines[i].trim();
            if (trimmed && !trimmed.match(/^(\s*)(#|\/\/|--|%|;)/)) {
              anchorLineIndex = i;
              break;
            }
          }

          // If no code line below, fallback to the previous code line
          if (anchorLineIndex === -1) {
            for (let i = selectedLine - 1; i >= 0; i--) {
              const trimmed = lines[i].trim();
              if (trimmed && !trimmed.match(/^(\s*)(#|\/\/|--|%|;)/)) {
                anchorLineIndex = i;
                break;
              }
            }
          }

          if (anchorLineIndex === -1) {
            vscode.window.showErrorMessage("VCM: Could not determine anchor line for this comment.");
            return;
          }

          anchorHash = hashLine(lines[anchorLineIndex], 0);
        }

        // Load or create VCM comments
        let comments = [];
        const { allComments } = await loadAllComments(relativePath);

        if (allComments.length === 0) {
          // No VCM exists - extract only the specific comment being marked
          const allExtractedComments = extractComments(doc.getText(), doc.uri.path);

          // Find all comments with matching anchor
          const candidates = allExtractedComments.filter(c => c.anchor === anchorHash);

          if (candidates.length === 0) {
            vscode.window.showWarningMessage("VCM: Could not find a matching comment entry.");
            return;
          }

          let targetComment;
          if (candidates.length === 1) {
            targetComment = candidates[0];
          } else {
            // Multiple comments with same anchor - use line number to disambiguate
            targetComment = candidates.find(c => c.originalLineIndex === selectedLine);
            if (!targetComment) {
              targetComment = candidates[0]; // Fallback to first match
            }
          }

          // Only add the specific comment being marked as always show
          targetComment.alwaysShow = true;
          comments = [targetComment];
        } else {
          // VCM exists - mark the comment in existing list using context matching
          comments = allComments;

          // Extract current comments to get fresh prevHash/nextHash
          const currentComments = extractComments(doc.getText(), doc.uri.path);
          const currentCandidates = currentComments.filter(c => c.anchor === anchorHash);

          if (currentCandidates.length === 0) {
            vscode.window.showWarningMessage("VCM: Could not find a matching comment entry in current file.");
            return;
          }

          // Find the current comment at the selected line
          let currentComment = currentCandidates.find(c => c.originalLineIndex === selectedLine);
          if (!currentComment && currentCandidates.length > 0) {
            currentComment = currentCandidates[0]; // Fallback
          }

          // Now match this current comment to a VCM comment using context
          const vcmCandidates = comments.filter(c => c.anchor === anchorHash);
          let targetVcmComment;

          if (vcmCandidates.length === 1) {
            targetVcmComment = vcmCandidates[0];
          } else if (vcmCandidates.length > 1) {
            // Use context hashes to find best match
            let bestMatch = null;
            let bestScore = -1;

            for (const vcm of vcmCandidates) {
              let score = 0;
              if (currentComment.prevHash && vcm.prevHash === currentComment.prevHash) {
                score += 10;
              }
              if (currentComment.nextHash && vcm.nextHash === currentComment.nextHash) {
                score += 10;
              }
              if (score > bestScore) {
                bestScore = score;
                bestMatch = vcm;
              }
            }
            targetVcmComment = bestMatch || vcmCandidates[0];
          } else {
            vscode.window.showWarningMessage("VCM: Could not find a matching comment entry in .vcm.");
            return;
          }

          targetVcmComment.alwaysShow = true;
        }

        // Save updated comments
        await saveCommentsToVCM(relativePath, comments);

        vscode.window.showInformationMessage("VCM: Marked as Always Show ✅");
        // Update context to refresh menu items
        await updateAlwaysShowContext();
      } catch (err) {
        vscode.window.showErrorMessage("VCM: Error marking comment as Always Show: " + err.message);
      }
    }
  );
  context.subscriptions.push(markAlwaysShow);

  // ---------------------------------------------------------------------------
  // COMMAND: Right-click -> "Unmark Always Show"
  // ---------------------------------------------------------------------------
  const unmarkAlwaysShow = vscode.commands.registerCommand(
    "vcm-view-comments-mirror.unmarkAlwaysShow",
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;

      const doc = editor.document;
      const selectedLine = editor.selection.active.line;
      const line = doc.lineAt(selectedLine);
      const text = line.text;
      const trimmed = text.trim();

      // Check if line has a comment (block or inline)
      const isBlockComment = trimmed.match(/^(\s*)(#|\/\/|--|%|;)/);
      const commentMarkers = getCommentMarkersForFile(doc.uri.path);
      let isInlineComment = false;

      // Check if line contains an inline comment
      if (!isBlockComment) {
        for (const marker of commentMarkers) {
          const markerIndex = text.indexOf(marker);
          if (markerIndex > 0) {
            // Comment marker appears after position 0, so it's inline
            isInlineComment = true;
            break;
          }
        }
      }

      if (!isBlockComment && !isInlineComment) {
        vscode.window.showWarningMessage("VCM: You can only unmark comment lines.");
        return;
      }

      const relativePath = vscode.workspace.asRelativePath(doc.uri);

      try {
        // Load all comments using helper function
        const { allComments } = await loadAllComments(relativePath);

        if (allComments.length === 0) {
          vscode.window.showWarningMessage("VCM: No .vcm file found.");
          return;
        }

        const comments = allComments;

        // Find the anchor hash for this comment
        const lines = doc.getText().split("\n");
        let anchorHash;

        if (isInlineComment) {
          // For inline comments, the anchor is the code portion before the comment
          let commentStartIndex = -1;
          for (const marker of commentMarkers) {
            const markerRegex = new RegExp(`(\\s+)(${marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`);
            const match = text.match(markerRegex);
            if (match) {
              commentStartIndex = match.index;
              break;
            }
          }
          if (commentStartIndex > 0) {
            const anchorBase = text.substring(0, commentStartIndex).trimEnd();
            anchorHash = hashLine(anchorBase, 0);
          } else {
            vscode.window.showErrorMessage("VCM: Could not find comment marker.");
            return;
          }
        } else {
          // For block comments, find the next non-comment line
          let anchorLineIndex = -1;
          for (let i = selectedLine + 1; i < lines.length; i++) {
            const trimmed = lines[i].trim();
            if (trimmed && !trimmed.match(/^(\s*)(#|\/\/|--|%|;)/)) {
              anchorLineIndex = i;
              break;
            }
          }

          // If no code line below, fallback to the previous code line
          if (anchorLineIndex === -1) {
            for (let i = selectedLine - 1; i >= 0; i--) {
              const trimmed = lines[i].trim();
              if (trimmed && !trimmed.match(/^(\s*)(#|\/\/|--|%|;)/)) {
                anchorLineIndex = i;
                break;
              }
            }
          }

          if (anchorLineIndex === -1) {
            vscode.window.showErrorMessage("VCM: Could not determine anchor line for this comment.");
            return;
          }

          anchorHash = hashLine(lines[anchorLineIndex], 0);
        }

        // Search for comment with this anchor and remove alwaysShow
        let found = false;
        for (const c of comments) {
          if (c.anchor === anchorHash && c.alwaysShow) {
            delete c.alwaysShow;
            found = true;
          }
        }

        if (!found) {
          vscode.window.showWarningMessage("VCM: This comment is not marked as Always Show.");
          return;
        }

        // Save updated comments using helper function
        await saveCommentsToVCM(relativePath, comments);

        // Check if we're in clean mode - if so, remove the comment from the document
        const isInCleanMode = isCommentedMap.get(doc.uri.fsPath) === false;

        if (isInCleanMode) {
          // Remove the comment line(s) from the document
          const edit = new vscode.WorkspaceEdit();

          // For block comments, we need to find all lines in the block
          const currentComments = extractComments(doc.getText(), doc.uri.path);
          const matchingComment = currentComments.find(c => c.anchor === anchorHash);

          if (matchingComment) {
            if (matchingComment.type === "block" && matchingComment.block) {
              // Remove all lines in the block (from first to last)
              const firstLine = Math.min(...matchingComment.block.map(b => b.originalLineIndex));
              const lastLine = Math.max(...matchingComment.block.map(b => b.originalLineIndex));
              const range = new vscode.Range(firstLine, 0, lastLine + 1, 0);
              edit.delete(doc.uri, range);
            } else if (matchingComment.type === "inline") {
              // Remove just the inline comment part (keep the code)
              const lineText = lines[matchingComment.originalLineIndex];
              const commentMarkers = getCommentMarkersForFile(doc.uri.path);

              // Find where the comment starts
              let commentStartIdx = -1;
              for (const marker of commentMarkers) {
                const idx = lineText.indexOf(marker);
                if (idx > 0 && lineText[idx - 1].match(/\s/)) {
                  commentStartIdx = idx - 1; // Include the whitespace before marker
                  break;
                }
              }

              if (commentStartIdx >= 0) {
                const range = new vscode.Range(
                  matchingComment.originalLineIndex, commentStartIdx,
                  matchingComment.originalLineIndex, lineText.length
                );
                edit.delete(doc.uri, range);
              }
            }

            await vscode.workspace.applyEdit(edit);
            await doc.save();
          }
        }

        vscode.window.showInformationMessage("VCM: Unmarked Always Show ✅");
        // Update context to refresh menu items
        await updateAlwaysShowContext();
      } catch (err) {
        vscode.window.showErrorMessage("VCM: Error unmarking comment: " + err.message);
      }
    }
  );
  context.subscriptions.push(unmarkAlwaysShow);

  // ---------------------------------------------------------------------------
  // COMMAND: Right-click -> "Mark as Private"
  // ---------------------------------------------------------------------------
  const markPrivate = vscode.commands.registerCommand(
    "vcm-view-comments-mirror.markPrivate",
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;

      const doc = editor.document;
      const selectedLine = editor.selection.active.line;
      const line = doc.lineAt(selectedLine);
      const text = line.text;
      const trimmed = text.trim();

      // Check if line has a comment (block or inline)
      const isBlockComment = trimmed.match(/^(\s*)(#|\/\/|--|%|;)/);
      const commentMarkers = getCommentMarkersForFile(doc.uri.path);
      let isInlineComment = false;

      // Check if line contains an inline comment
      if (!isBlockComment) {
        for (const marker of commentMarkers) {
          const markerIndex = text.indexOf(marker);
          if (markerIndex > 0) {
            // Comment marker appears after position 0, so it's inline
            isInlineComment = true;
            break;
          }
        }
      }

      if (!isBlockComment && !isInlineComment) {
        vscode.window.showWarningMessage("VCM: You can only mark comment lines as private.");
        return;
      }

      const relativePath = vscode.workspace.asRelativePath(doc.uri);

      try {
        // Extract current comments to get the comment at cursor with its hashes
        const currentComments = extractComments(doc.getText(), doc.uri.path);

        // Find the comment at the cursor position to get its hashes
        const commentAtCursor = currentComments.find(c => {
          if (isInlineComment) {
            return c.type === "inline" && c.originalLineIndex === selectedLine;
          } else {
            // For block comments, check if cursor is within the block
            if (c.type === "block" && c.block) {
              const firstLine = c.block[0].originalLineIndex;
              const lastLine = c.block[c.block.length - 1].originalLineIndex;
              return selectedLine >= firstLine && selectedLine <= lastLine;
            }
            return false;
          }
        });

        if (!commentAtCursor) {
          vscode.window.showWarningMessage("VCM: Could not find a matching comment entry.");
          return;
        }

        // Build the key using ALL hashes for this comment
        const commentKey = `${commentAtCursor.type}:${commentAtCursor.anchor}:${commentAtCursor.prevHash || 'null'}:${commentAtCursor.nextHash || 'null'}`;

        // Load or create VCM comments
        let comments = [];
        const { allComments } = await loadAllComments(relativePath);

        if (allComments.length === 0) {
          // No VCM exists - add only this comment to VCM, marked as private
          commentAtCursor.isPrivate = true;
          comments = [commentAtCursor];
        } else {
          // VCM exists - find and mark the matching comment using ALL hashes + text
          comments = allComments;

          // For inline comments, also match on text to distinguish between multiple inline comments with same hashes
          const targetVcmComment = comments.find(vcm => {
            const vcmKey = `${vcm.type}:${vcm.anchor}:${vcm.prevHash || 'null'}:${vcm.nextHash || 'null'}`;
            if (vcmKey !== commentKey) return false;

            // If this is an inline comment, also match on the text to be more specific
            if (commentAtCursor.type === "inline") {
              return vcm.text === commentAtCursor.text;
            }

            return true;
          });

          if (!targetVcmComment) {
            vscode.window.showWarningMessage("VCM: Could not find a matching comment entry in .vcm.");
            return;
          }

          targetVcmComment.isPrivate = true;
        }

        // Save updated comments (will split into shared/private automatically)
        await saveCommentsToVCM(relativePath, comments);

        // Check if private comments are currently visible
        const privateVisible = privateCommentsVisible.get(doc.uri.fsPath) === true;

        if (!privateVisible) {
          // Private mode is off, so hide this comment (we already have it in commentAtCursor)
          if (commentAtCursor) {
            const edit = new vscode.WorkspaceEdit();

            if (commentAtCursor.type === "block" && commentAtCursor.block) {
              // Remove the entire block
              const firstLine = commentAtCursor.block[0].originalLineIndex;
              const lastLine = commentAtCursor.block[commentAtCursor.block.length - 1].originalLineIndex;
              edit.delete(doc.uri, new vscode.Range(firstLine, 0, lastLine + 1, 0));
            } else if (commentAtCursor.type === "inline") {
              // Remove inline comment from the line
              const currentLine = doc.lineAt(commentAtCursor.originalLineIndex);
              const commentMarkers = getCommentMarkersForFile(doc.uri.path);
              let commentStartIdx = -1;

              for (const marker of commentMarkers) {
                const idx = currentLine.text.indexOf(marker);
                if (idx > 0 && currentLine.text[idx - 1].match(/\s/)) {
                  commentStartIdx = idx - 1;
                  break;
                }
              }

              if (commentStartIdx >= 0) {
                const newLineText = currentLine.text.substring(0, commentStartIdx).trimEnd();
                edit.replace(doc.uri, currentLine.range, newLineText);
              }
            }

            await vscode.workspace.applyEdit(edit);

            // Mark that we just modified from marking private to prevent re-extraction
            justInjectedFromVCM.add(doc.uri.fsPath);

            await vscode.commands.executeCommand("workbench.action.files.save");
          }

          // Set the global state to false since we auto-hid the comment
          privateCommentsVisible.set(doc.uri.fsPath, false);

          vscode.window.showInformationMessage("VCM: Private comment hidden 🔒 Toggle Private Comments to view.");
        } else {
          vscode.window.showInformationMessage("VCM: Marked as Private 🔒");
        }

        // Update context to refresh menu items
        setTimeout(() => updateAlwaysShowContext(), 100);
      } catch (err) {
        vscode.window.showErrorMessage("VCM: Error marking comment as Private: " + err.message);
      }
    }
  );
  context.subscriptions.push(markPrivate);

  // ---------------------------------------------------------------------------
  // COMMAND: Right-click -> "Unmark Private"
  // ---------------------------------------------------------------------------
  const unmarkPrivate = vscode.commands.registerCommand(
    "vcm-view-comments-mirror.unmarkPrivate",
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;

      const doc = editor.document;
      const selectedLine = editor.selection.active.line;
      const line = doc.lineAt(selectedLine);
      const text = line.text;
      const trimmed = text.trim();

      // Check if line has a comment (block or inline)
      const isBlockComment = trimmed.match(/^(\s*)(#|\/\/|--|%|;)/);
      const commentMarkers = getCommentMarkersForFile(doc.uri.path);
      let isInlineComment = false;

      // Check if line contains an inline comment
      if (!isBlockComment) {
        for (const marker of commentMarkers) {
          const markerIndex = text.indexOf(marker);
          if (markerIndex > 0) {
            // Comment marker appears after position 0, so it's inline
            isInlineComment = true;
            break;
          }
        }
      }

      if (!isBlockComment && !isInlineComment) {
        vscode.window.showWarningMessage("VCM: You can only unmark comment lines.");
        return;
      }

      const relativePath = vscode.workspace.asRelativePath(doc.uri);

      try {
        // Load all comments from both shared and private
        const { allComments: comments } = await loadAllComments(relativePath);

        // Find the anchor hash for this comment
        const lines = doc.getText().split("\n");
        let anchorHash;

        if (isInlineComment) {
          // For inline comments, the anchor is the code portion before the comment
          let commentStartIndex = -1;
          for (const marker of commentMarkers) {
            const markerRegex = new RegExp(`(\\s+)(${marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`);
            const match = text.match(markerRegex);
            if (match) {
              commentStartIndex = match.index;
              break;
            }
          }
          if (commentStartIndex > 0) {
            const anchorBase = text.substring(0, commentStartIndex).trimEnd();
            anchorHash = hashLine(anchorBase, 0);
          } else {
            vscode.window.showErrorMessage("VCM: Could not find comment marker.");
            return;
          }
        } else {
          // For block comments, find the next non-comment line
          let anchorLineIndex = -1;
          for (let i = selectedLine + 1; i < lines.length; i++) {
            const trimmed = lines[i].trim();
            if (trimmed && !trimmed.match(/^(\s*)(#|\/\/|--|%|;)/)) {
              anchorLineIndex = i;
              break;
            }
          }

          // If no code line below, fallback to the previous code line
          if (anchorLineIndex === -1) {
            for (let i = selectedLine - 1; i >= 0; i--) {
              const trimmed = lines[i].trim();
              if (trimmed && !trimmed.match(/^(\s*)(#|\/\/|--|%|;)/)) {
                anchorLineIndex = i;
                break;
              }
            }
          }

          if (anchorLineIndex === -1) {
            vscode.window.showErrorMessage("VCM: Could not determine anchor line for this comment.");
            return;
          }

          anchorHash = hashLine(lines[anchorLineIndex], 0);
        }

        // Extract current comments to match by context
        const currentComments = extractComments(doc.getText(), doc.uri.path);
        const currentCandidates = currentComments.filter(c => c.anchor === anchorHash);

        if (currentCandidates.length === 0) {
          vscode.window.showWarningMessage("VCM: Could not find a matching comment entry in current file.");
          return;
        }

        // Find the current comment at the selected line
        let currentComment = currentCandidates.find(c => c.originalLineIndex === selectedLine);
        if (!currentComment && currentCandidates.length > 0) {
          currentComment = currentCandidates[0]; // Fallback
        }

        // Match to VCM comment using context
        const vcmCandidates = comments.filter(c => c.anchor === anchorHash && c.isPrivate);

        if (vcmCandidates.length === 0) {
          vscode.window.showWarningMessage("VCM: This comment is not marked as private.");
          return;
        }

        let targetVcmComment;
        if (vcmCandidates.length === 1) {
          targetVcmComment = vcmCandidates[0];
        } else {
          // Use context hashes + text to find best match
          let bestMatch = null;
          let bestScore = -1;

          for (const vcm of vcmCandidates) {
            let score = 0;
            if (currentComment.prevHash && vcm.prevHash === currentComment.prevHash) {
              score += 10;
            }
            if (currentComment.nextHash && vcm.nextHash === currentComment.nextHash) {
              score += 10;
            }
            // For inline comments, exact text match is highest priority
            if (isInlineComment && currentComment.text === vcm.text) {
              score += 100;
            }
            if (score > bestScore) {
              bestScore = score;
              bestMatch = vcm;
            }
          }
          targetVcmComment = bestMatch || vcmCandidates[0];
        }

        // Remove isPrivate flag
        delete targetVcmComment.isPrivate;

        // Save updated comments (will split into shared/private automatically)
        await saveCommentsToVCM(relativePath, comments);

        // Check if we need to remove the comment from the document
        const isInCommentedMode = isCommentedMap.get(doc.uri.fsPath);
        const privateVisible = privateCommentsVisible.get(doc.uri.fsPath) === true;

        // Remove from document if:
        // 1. In clean mode with private visible (comment is visible but shouldn't be after unmarking)
        // 2. In commented mode with private hidden (comment was visible only because it was private)
        const shouldRemove = (!isInCommentedMode && privateVisible) || (isInCommentedMode && !privateVisible);

        if (shouldRemove) {
          // Remove the comment from the document
          const edit = new vscode.WorkspaceEdit();

          // Use the currentComment we already found
          const matchingComment = currentComment;

          if (matchingComment) {
            if (matchingComment.type === "block" && matchingComment.block) {
              // Remove all lines in the block (from first to last)
              const firstLine = Math.min(...matchingComment.block.map(b => b.originalLineIndex));
              const lastLine = Math.max(...matchingComment.block.map(b => b.originalLineIndex));
              const range = new vscode.Range(firstLine, 0, lastLine + 1, 0);
              edit.delete(doc.uri, range);
            } else if (matchingComment.type === "inline") {
              // Remove just the inline comment part (keep the code)
              const lineText = lines[matchingComment.originalLineIndex];

              // Find where the comment starts
              let commentStartIndex = -1;
              for (const marker of commentMarkers) {
                const markerRegex = new RegExp(`(\\s+)(${marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`);
                const match = lineText.match(markerRegex);
                if (match) {
                  commentStartIndex = match.index;
                  break;
                }
              }

              if (commentStartIndex > 0) {
                const range = new vscode.Range(
                  matchingComment.originalLineIndex,
                  commentStartIndex,
                  matchingComment.originalLineIndex,
                  lineText.length
                );
                edit.delete(doc.uri, range);
              }
            }

            await vscode.workspace.applyEdit(edit);
            await doc.save();
          }
        }
        // If in commented mode with private visible, comment stays in document (moved to shared)

        vscode.window.showInformationMessage("VCM: Unmarked Private ✅");
        // Update context to refresh menu items (with small delay to ensure file writes complete)
        setTimeout(async () => {
          await updateAlwaysShowContext();
        }, 100);
      } catch (err) {
        vscode.window.showErrorMessage("VCM: No .vcm file found. Try saving first.");
      }
    }
  );
  context.subscriptions.push(unmarkPrivate);

  // ---------------------------------------------------------------------------
  // COMMAND: Toggle Private Comments Visibility
  // ---------------------------------------------------------------------------
  const togglePrivateComments = vscode.commands.registerCommand(
    "vcm-view-comments-mirror.togglePrivateComments",
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;

      // Disable .vcm sync during toggle to prevent overwriting
      vcmSyncEnabled = false;

      const doc = editor.document;
      const text = doc.getText();
      const relativePath = vscode.workspace.asRelativePath(doc.uri);

      try {
        // Load private comments from private VCM file
        const { privateComments } = await loadAllComments(relativePath);

        if (privateComments.length === 0) {
          vscode.window.showInformationMessage("VCM: No private comments found in this file.");
          vcmSyncEnabled = true;
          return;
        }

        // Use stored state as source of truth (updated by undo/redo detection)
        // Toggle flips this state
        const storedState = privateCommentsVisible.get(doc.uri.fsPath);
        const currentlyVisible = storedState !== undefined ? storedState : false;

        let newText;
        if (currentlyVisible) {
          // Hide private comments - remove ONLY private comments using anchor + context hashes
          const privateKeys = new Set(privateComments.map(c =>
            `${c.type}:${c.anchor}:${c.prevHash || 'null'}:${c.nextHash || 'null'}`
          ));

          // Extract current comments to identify which ones are private
          const currentComments = extractComments(text, doc.uri.path);

          // Build a map of private comments by type and anchor for removal
          const privateBlocksToRemove = [];
          const privateInlinesToRemove = [];

          for (const current of currentComments) {
            const currentKey = `${current.type}:${current.anchor}:${current.prevHash || 'null'}:${current.nextHash || 'null'}`;
            if (privateKeys.has(currentKey)) {
              if (current.type === "block") {
                privateBlocksToRemove.push(current);
              } else if (current.type === "inline") {
                privateInlinesToRemove.push(current);
              }
            }
          }

          // Remove private comments from the text
          const lines = text.split("\n");
          const linesToRemove = new Set();

          // Mark block comment lines for removal
          for (const block of privateBlocksToRemove) {
            if (block.block) {
              for (const blockLine of block.block) {
                linesToRemove.add(blockLine.originalLineIndex);
              }
            }
          }

          // Process lines: filter out block comments and strip inline comments
          const resultLines = [];
          for (let i = 0; i < lines.length; i++) {
            // Skip lines that are part of private block comments
            if (linesToRemove.has(i)) continue;

            let line = lines[i];

            // Check if this line has a private inline comment to remove
            const inlineToRemove = privateInlinesToRemove.find(c => c.originalLineIndex === i);
            if (inlineToRemove) {
              // Remove the inline comment using the same logic as stripComments
              const commentMarkers = getCommentMarkersForFile(doc.uri.path);
              let commentStartIdx = -1;
              for (const marker of commentMarkers) {
                const idx = line.indexOf(marker);
                if (idx > 0 && line[idx - 1].match(/\s/)) {
                  commentStartIdx = idx - 1;
                  break;
                }
              }
              if (commentStartIdx >= 0) {
                line = line.substring(0, commentStartIdx).trimEnd();
              }
            }

            resultLines.push(line);
          }

          newText = resultLines.join("\n");
          privateCommentsVisible.set(doc.uri.fsPath, false);
          vscode.window.showInformationMessage("VCM: Private comments hidden 🔒");
        } else {
          // Show private comments - inject them back
          // Load shared comments too
          const { sharedComments } = await loadAllComments(relativePath);

          // Check current mode to determine what to show
          const isInCommentedMode = isCommentedMap.get(doc.uri.fsPath);

          if (isInCommentedMode) {
            // In commented mode: show BOTH shared and private comments
            // Strip ALL comments first, then inject both shared and private
            const allCommentsForStripping = [...sharedComments, ...privateComments];
            const cleanText = stripComments(text, doc.uri.path, allCommentsForStripping, false, false);

            // Inject both shared and private comments
            const allCommentsToInject = [...sharedComments, ...privateComments];
            newText = injectComments(cleanText, allCommentsToInject, true);
          } else {
            // In clean mode: show ONLY private comments
            // Strip any existing private comments first (to avoid double injection)
            const cleanText = stripComments(text, doc.uri.path, privateComments, false, false);

            // Inject only private comments
            newText = injectComments(cleanText, privateComments, true);
          }

          privateCommentsVisible.set(doc.uri.fsPath, true);

          // Mark that we just injected from VCM so saveVCM doesn't re-extract these as shared comments
          justInjectedFromVCM.add(doc.uri.fsPath);

          vscode.window.showInformationMessage("VCM: Private comments visible 🔓");
        }

        // Replace entire document content
        const edit = new vscode.WorkspaceEdit();
        edit.replace(doc.uri, new vscode.Range(0, 0, doc.lineCount, 0), newText);
        await vscode.workspace.applyEdit(edit);
        await vscode.commands.executeCommand("workbench.action.files.save");

        // Manually update split view if it's open
        if (tempUri && vcmEditor && sourceDocUri && doc.uri.toString() === sourceDocUri.toString()) {
          try {
            const updatedText = doc.getText();
            const isInCommentedMode = isCommentedMap.get(doc.uri.fsPath);
            const includePrivate = privateCommentsVisible.get(doc.uri.fsPath) === true;

            let showVersion;
            if (isInCommentedMode) {
              // Source is in commented mode, show clean in split view
              const { allComments: vcmComments } = await loadAllComments(relativePath);
              showVersion = stripComments(updatedText, doc.uri.path, vcmComments, includePrivate);
            } else {
              // Source is in clean mode, show commented in split view
              showVersion = await generateCommentedVersion(updatedText, doc.uri.path, relativePath, includePrivate);
            }

            provider.update(tempUri, showVersion);
          } catch {
            // Ignore errors
          }
        }

        // Re-enable sync after a delay to ensure save completes
        setTimeout(() => (vcmSyncEnabled = true), 800);
      } catch (err) {
        vscode.window.showErrorMessage("VCM: Error toggling private comments.");
        vcmSyncEnabled = true;
      }
    }
  );
  context.subscriptions.push(togglePrivateComments);

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

    // Close any existing VCM split view before opening a new one (only one VCM_ allowed)
    if (tempUri) {
      await closeSplitView();
    }

    const relativePath = vscode.workspace.asRelativePath(doc.uri);
    const vcmFileUri = vscode.Uri.joinPath(vcmDir, relativePath + ".vcm.json");
    const baseName = doc.fileName.split(/[\\/]/).pop();
    const vcmLabel = `VCM_${baseName}`;

    // Load comment data from .vcm file, or extract from current file
    let sharedComments, privateComments;
    try {
      const result = await loadAllComments(relativePath);
      sharedComments = result.sharedComments;
      privateComments = result.privateComments;
    } catch {
      // No .vcm file exists yet - extract and save
      sharedComments = extractComments(doc.getText(), doc.uri.path);
      privateComments = [];
      await saveVCM(doc);
    }

    // Detect initial state if not already set
    if (!isCommentedMap.has(doc.uri.fsPath)) {
      const initialState = await detectInitialMode(doc, vcmDir);
      isCommentedMap.set(doc.uri.fsPath, initialState);
    }

    // Detect private comment visibility if not already set
    if (!privateCommentsVisible.has(doc.uri.fsPath)) {
      const privateVisible = await detectPrivateVisibility(doc, relativePath);
      privateCommentsVisible.set(doc.uri.fsPath, privateVisible);
    }

    // Create clean version and version with comments
    const text = doc.getText();
    const keepPrivate = privateCommentsVisible.get(doc.uri.fsPath) === true;

    // Always include ALL comments (shared + private) in the array
    // Let stripComments and injectComments decide what to do based on keepPrivate flag
    const allComments = [...sharedComments, ...privateComments];
    const clean = stripComments(text, doc.uri.path, allComments, keepPrivate);
    const withComments = injectComments(clean, allComments, keepPrivate);

    // Check the current mode from our state map
    const isInCommentedMode = isCommentedMap.get(doc.uri.fsPath);

    // If source is in commented mode, show clean; otherwise, show commented
    const showVersion = isInCommentedMode ? clean : withComments;
    const labelType = isInCommentedMode ? "clean" : "with comments";

    // Insert timestamp before file extension to preserve language detection
    const uniqueLabel = vcmLabel.replace(/(\.[^/.]+)$/, `_${Date.now()}$1`);
    // Create virtual document with vcm-view: scheme
    tempUri = vscode.Uri.parse(`vcm-view:${uniqueLabel}`);
    provider.update(tempUri, showVersion);

    // Open in a proper split pane (like "Open to the Side")
    // Use ViewColumn.Beside to open in a new editor group to the side
    vcmEditor = await vscode.window.showTextDocument(tempUri, {
      viewColumn: vscode.ViewColumn.Beside,
      preview: false,  // Don't use preview mode so it persists as a tab
      preserveFocus: true  // Keep focus on source editor
    });

    // Track which source document has the split view open for live sync
    sourceDocUri = doc.uri;

    // Dispose of any existing scroll listener before creating a new one
    if (scrollListener) {
      scrollListener.dispose();
      scrollListener = null;
    }

    // Setup bidirectional click-to-jump (source ↔ split view)
    const sourceEditor = editor;

    let activeHighlight;
    let reverseActiveHighlight;

    scrollListener = vscode.window.onDidChangeTextEditorSelection(async e => {
      if (!vcmEditor) return;

      // Only jump on mouse clicks, not keyboard navigation or typing
      // e.kind will be undefined for typing, 1 for keyboard, 2 for mouse
      if (e.kind !== vscode.TextEditorSelectionChangeKind.Mouse) return;

      // Direction 1: Source → Split View
      if (e.textEditor === sourceEditor) {
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

        // Create a highlight using the editor's built-in selection color
        activeHighlight = vscode.window.createTextEditorDecorationType({
          backgroundColor: new vscode.ThemeColor("editor.selectionBackground"),
          isWholeLine: true,
        });

        vcmEditor.setDecorations(activeHighlight, [
          new vscode.Range(targetPos, targetPos),
        ]);
      }

      // Direction 2: Split View → Source
      else if (e.textEditor === vcmEditor) {
        const cursorPos = e.selections[0].active;
        const wordRange = vcmEditor.document.getWordRangeAtPosition(cursorPos);
        if (!wordRange) return;

        const word = vcmEditor.document.getText(wordRange);
        if (!word || word.length < 2) return;

        // Extract line context to improve matching accuracy
        const splitLine = vcmEditor.document.lineAt(cursorPos.line).text.trim();
        const sourceText = sourceEditor.document.getText();
        const sourceLines = sourceText.split("\n");

        // Try to find the same line context first (exact match or partial)
        let sourceLine = sourceLines.findIndex(line => line.trim() === splitLine.trim());
        if (sourceLine === -1) {
          // fallback: find first line containing the word as whole word
          const wordRegex = new RegExp(`\\b${word}\\b`);
          sourceLine = sourceLines.findIndex(line => wordRegex.test(line));
        }

        if (sourceLine === -1) return;

        // Jump + highlight that line
        const sourcePos = new vscode.Position(sourceLine, 0);
        sourceEditor.selection = new vscode.Selection(sourcePos, sourcePos);
        sourceEditor.revealRange(
          new vscode.Range(sourcePos, sourcePos),
          vscode.TextEditorRevealType.InCenter
        );

        // Remove previous highlight if exists
        if (reverseActiveHighlight) {
          reverseActiveHighlight.dispose();
          reverseActiveHighlight = null;
        }

        // Create a highlight using the editor's built-in selection color
        reverseActiveHighlight = vscode.window.createTextEditorDecorationType({
          backgroundColor: new vscode.ThemeColor("editor.selectionBackground"),
          isWholeLine: true,
        });

        sourceEditor.setDecorations(reverseActiveHighlight, [
          new vscode.Range(sourcePos, sourcePos),
        ]);
      }
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