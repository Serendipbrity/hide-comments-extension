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
let sourceDocUri;        // Track which source document has the split view open
let vcmSyncEnabled = true; // Flag to temporarily disable .vcm file updates during toggles
let isCommentedMap = new Map(); // Track state: true = comments visible, false = clean mode (comments hidden)
let justInjectedFromVCM = new Set(); // Track files that just had VCM comments injected (don't re-extract)
let privateCommentsVisible = new Map(); // Track private comment visibility per file: true = visible, false = hidden

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
    this._onDidChange = new vscode.EventEmitter();
    this.onDidChange = this._onDidChange.event;
  }

  // Called by VS Code when it needs to display a vcm-view: document
  provideTextDocumentContent(uri) {
    return this.content.get(uri.toString()) || "";
  }

  // Update the content for a specific URI and notify VS Code
  update(uri, content) {
    this.content.set(uri.toString(), content);
    this._onDidChange.fire(uri);
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
    // VCM exists - check if first 5-10 NON-alwaysShow comments from VCM match the file
    const vcmData = JSON.parse((await vscode.workspace.fs.readFile(vcmPath)).toString());
    const comments = vcmData.comments || [];

    // Filter out alwaysShow comments for detection (they're always visible)
    const nonAlwaysShowComments = comments.filter(c => !c.alwaysShow);

    if (nonAlwaysShowComments.length === 0) {
      // Only alwaysShow comments exist - need to check if there are other comments in file
      // If the file has MORE comments than just alwaysShow, we're in commented mode
      const lines = doc.getText().split('\n');
      const commentMarkers = getCommentMarkersForFile(doc.uri.path);
      let commentCount = 0;
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        for (const marker of commentMarkers) {
          if (trimmed.startsWith(marker)) {
            commentCount++;
            break;
          }
        }
      }
      // If we have more comments in file than alwaysShow comments in VCM, we're in commented mode
      return commentCount > comments.length;
    }

    const lines = doc.getText().split('\n');
    const checkCount = Math.min(10, nonAlwaysShowComments.length);

    // Check if first N NON-alwaysShow comments exist in the file
    for (let i = 0; i < checkCount; i++) {
      const comment = nonAlwaysShowComments[i];
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

    // CASE 1: This line is a standalone comment
    if (isComment(line)) {
      // Store the ENTIRE line as-is (includes indent, marker, spacing, text, trailing spaces)
      commentBuffer.push({
        text: line,           // Full line exactly as it appears
        originalLine: i,      // 0-based line index
      });
      continue; // Move to next line, stay in comment-gathering mode
    }

    // CASE 1.5: Blank line - check if it's within a comment block
    if (!trimmed) {
      // If we have comments buffered, check if the next non-blank line is also a comment
      if (commentBuffer.length > 0) {
        // Look ahead to find the next non-blank line
        let nextNonBlankIdx = -1;
        for (let j = i + 1; j < lines.length; j++) {
          if (lines[j].trim()) {
            nextNonBlankIdx = j;
            break;
          }
        }

        // If the next non-blank line is a comment, this blank line is part of the block
        if (nextNonBlankIdx >= 0 && isComment(lines[nextNonBlankIdx])) {
          commentBuffer.push({
            text: line,           // Empty or whitespace-only line
            originalLine: i,      // 0-based line index
          });
          continue;
        }
      }
      // Otherwise, skip this blank line (it's between blocks or code sections)
      continue;
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
      // Count blank lines BEFORE the first comment line
      const firstCommentLine = commentBuffer[0].originalLine;
      let leadingBlankLines = 0;
      for (let j = firstCommentLine - 1; j >= 0; j--) {
        if (!lines[j].trim()) {
          leadingBlankLines++;
        } else {
          break; // Hit code or another comment
        }
      }

      // Count blank lines AFTER the last comment (between comment and this code line)
      const lastCommentLine = commentBuffer[commentBuffer.length - 1].originalLine;
      const trailingBlankLines = i - lastCommentLine - 1;

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
        leadingBlankLines: leadingBlankLines > 0 ? leadingBlankLines : undefined,
        trailingBlankLines: trailingBlankLines > 0 ? trailingBlankLines : undefined,
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
//   cleanText - Code with alwaysShow comments already present, other comments removed
//   comments - Array of comment objects from extractComments()
//   includePrivate - Whether to include private comments (default: false)
// Returns: Full source code with comments restored
function injectComments(cleanText, comments, includePrivate = false) {
  const lines = cleanText.split("\n");
  const result = [];  // Will contain the final reconstructed code

  // Filter out alwaysShow comments (managed separately)
  // Include/exclude private comments based on includePrivate parameter
  const commentsToInject = comments.filter(c => {
    if (c.alwaysShow) return false; // Always exclude alwaysShow
    if (c.isPrivate && !includePrivate) return false; // Exclude private if not included
    return true;
  });

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
  const blockComments = commentsToInject.filter(c => c.type === "block").sort((a, b) => {
    const aLine = a.block[0]?.originalLine || 0;
    const bLine = b.block[0]?.originalLine || 0;
    return aLine - bLine;
  });
  const inlineComments = commentsToInject.filter(c => c.type === "inline").sort((a, b) => a.originalLine - b.originalLine);

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

  // First pass: identify which blank lines belong to comment spacing
  const blankLinesOwnedByComments = new Set();

  for (let i = 0; i < lines.length; i++) {
    const blocks = blockMap.get(i);
    if (blocks) {
      for (const block of blocks) {
        const leadingBlanks = block.leadingBlankLines || 0;
        const trailingBlanks = block.trailingBlankLines || 0;
        const totalBlanks = leadingBlanks + trailingBlanks;

        // Find all consecutive blank lines before the anchor
        const blankIndices = [];
        for (let j = i - 1; j >= 0; j--) {
          if (!lines[j].trim()) {
            blankIndices.unshift(j); // Add to front to maintain order
          } else {
            break;
          }
        }

        // Mark the appropriate blanks:
        // First N are leading, next M are trailing
        for (let idx = 0; idx < Math.min(blankIndices.length, totalBlanks); idx++) {
          blankLinesOwnedByComments.add(blankIndices[idx]);
        }
      }
    }
  }

  // Second pass: rebuild the file
  for (let i = 0; i < lines.length; i++) {
    // STEP 1: Insert any block comments anchored to this line
    // These go ABOVE the code line
    const blocks = blockMap.get(i);
    if (blocks) {
      for (const block of blocks) {
        const leadingBlanks = block.leadingBlankLines || 0;
        const trailingBlanks = block.trailingBlankLines || 0;

        // Collect all consecutive blank lines before the anchor
        const allBlankLines = [];
        for (let j = i - 1; j >= 0; j--) {
          if (!lines[j].trim()) {
            allBlankLines.unshift(lines[j]); // Add to front to maintain order
          } else {
            break;
          }
        }

        // Split them: first N are leading, next M are trailing
        const leadingBlankLines = allBlankLines.slice(0, leadingBlanks);
        const trailingBlankLines = allBlankLines.slice(leadingBlanks, leadingBlanks + trailingBlanks);

        // Add leading blanks
        for (const blank of leadingBlankLines) {
          result.push(blank);
        }

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

        // Add trailing blanks
        for (const blank of trailingBlankLines) {
          result.push(blank);
        }
      }
    }

    // Skip blank lines that are owned by comments (we already added them with the comment)
    if (blankLinesOwnedByComments.has(i)) {
      continue;
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
// 6. Skip comments marked with alwaysShow flag (they appear in all modes)
function stripComments(text, filePath, vcmComments = [], keepPrivate = false) {
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
  const currentComments = extractComments(text, filePath);

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
        allCommentBlockLines.add(blockLine.originalLine);
      }

      // If this block is alwaysShow, also add to alwaysShow set
      if (alwaysShowAnchors.has(current.anchor)) {
        for (const blockLine of current.block) {
          alwaysShowLines.add(blockLine.originalLine);
        }
      }

      // If this block is private and we're keeping private, add to private set
      if (privateAnchors.has(current.anchor)) {
        for (const blockLine of current.block) {
          privateLines.add(blockLine.originalLine);
        }
      }
    } else if (current.type === "inline") {
      if (alwaysShowAnchors.has(current.anchor)) {
        // For alwaysShow inline comments, store the line index and text
        alwaysShowLines.add(current.originalLine);
        alwaysShowInlineComments.set(current.originalLine, current.text || "");
      }
      if (privateAnchors.has(current.anchor)) {
        // For private inline comments (if keeping), store the line index and text
        privateLines.add(current.originalLine);
        privateInlineComments.set(current.originalLine, current.text || "");
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
              curr.anchor === anchorHash && curr.originalLine === selectedLine
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

    // Save private comments
    if (privateComments.length > 0) {
      const privateFileUri = vscode.Uri.joinPath(vcmPrivateDir, relativePath + ".vcm.json");
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
        // File doesn't exist, that's fine
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

    // Load existing VCM data from both shared and private files
    const { sharedComments: existingComments, privateComments: existingPrivateComments } = await loadAllComments(relativePath);

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
    // NOTE: We only process SHARED comments during extraction/merging.
    // Private comments are always preserved separately and never extracted from the document.
    let finalComments;

    if (isCommented) {
      // Commented mode:
      //   → The user is editing the commented version.
      //   → Replace entire VCM with what's currently visible.
      //   → Always extract current state to detect deletions immediately.
      //   → PRESERVE metadata like alwaysShow and isPrivate from existing comments.

      // Build a map of existing SHARED comments with their metadata
      const existingByKey = new Map();
      const existingByText = new Map(); // Secondary index by text for anchor updates
      for (const existing of existingComments) {
        const key = `${existing.type}:${existing.anchor}`;
        if (!existingByKey.has(key)) {
          existingByKey.set(key, []);
        }
        existingByKey.get(key).push(existing);

        // Also index by text to handle anchor changes
        const textKey = existing.text || (existing.block ? existing.block.map(b => b.text).join('\n') : '');
        if (textKey && !existingByText.has(textKey)) {
          existingByText.set(textKey, existing);
        }
      }

      // Build a map of existing PRIVATE comments (to preserve isPrivate flag)
      const privateByKey = new Map();
      const privateByText = new Map();
      for (const privateComment of existingPrivateComments) {
        const key = `${privateComment.type}:${privateComment.anchor}`;
        if (!privateByKey.has(key)) {
          privateByKey.set(key, []);
        }
        privateByKey.get(key).push(privateComment);

        // Also index by text
        const textKey = privateComment.text || (privateComment.block ? privateComment.block.map(b => b.text).join('\n') : '');
        if (textKey && !privateByText.has(textKey)) {
          privateByText.set(textKey, privateComment);
        }
      }

      // Build a map of current comments for checking what exists
      const currentByKey = new Map();
      for (const current of currentComments) {
        const key = `${current.type}:${current.anchor}`;
        if (!currentByKey.has(key)) {
          currentByKey.set(key, []);
        }
        currentByKey.get(key).push(current);
      }

      // Track which existing comments we've matched to avoid duplicates
      const matchedExisting = new Set();

      // Start with updated current comments (preserving metadata)
      finalComments = currentComments.map(current => {
        const key = `${current.type}:${current.anchor}`;
        const currentText = current.text || (current.block ? current.block.map(b => b.text).join('\n') : '');

        // First check if this is a private comment
        const privateCandidates = privateByKey.get(key) || [];
        if (privateCandidates.length > 0) {
          // This is a private comment - mark it as such
          return {
            ...current,
            isPrivate: true,
          };
        }

        // Also check by text in case anchor changed
        if (currentText && privateByText.has(currentText)) {
          return {
            ...current,
            isPrivate: true,
          };
        }

        // Not private - check shared comments for metadata
        const candidates = existingByKey.get(key) || [];

        if (candidates.length > 0) {
          // Found a match by anchor - preserve alwaysShow and other metadata
          const existing = candidates[0];
          matchedExisting.add(existing);
          // Remove this existing comment from the map so we don't add it again
          candidates.shift();
          if (candidates.length === 0) {
            existingByKey.delete(key);
          }
          return {
            ...current,
            alwaysShow: existing.alwaysShow || undefined, // Preserve alwaysShow
            // Add any other metadata fields here if needed in the future
          };
        }

        // No match by anchor - try matching by text (anchor might have changed)
        if (currentText && existingByText.has(currentText)) {
          const existing = existingByText.get(currentText);
          if (!matchedExisting.has(existing)) {
            // Found a match by text - this is the same comment with updated anchor
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

      // Add any existing comments that weren't matched
      // (these are comments that were hidden/not extracted, like non-alwaysShow in clean mode)
      for (const [key, candidates] of existingByKey) {
        if (!currentByKey.has(key)) {
          // This existing comment wasn't found in current - keep it if not already matched
          for (const candidate of candidates) {
            if (!matchedExisting.has(candidate)) {
              finalComments.push(candidate);
            }
          }
        }
      }

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

        // Build a set of private comment anchors to exclude from extraction
        const privateAnchors = new Set();
        for (const privateComment of existingPrivateComments) {
          const key = `${privateComment.type}:${privateComment.anchor}`;
          privateAnchors.add(key);
        }

        // Process current comments (typed in clean mode)
        // IMPORTANT: Filter out private comments - they should never be added to shared VCM
        for (const current of currentComments) {
          const key = `${current.type}:${current.anchor}`;

          // Skip if this is a private comment (visible in clean mode but should stay in private VCM)
          if (privateAnchors.has(key)) {
            continue;
          }

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
    // Save final comments, splitting into shared and private files
    // ------------------------------------------------------------------------
    // Add private comments that aren't already in finalComments
    // (They might already be there if private comments were visible and got extracted)
    const finalCommentsSet = new Set(finalComments.map(c => {
      const text = c.text || (c.block ? c.block.map(b => b.text).join('\n') : '');
      return `${c.type}:${c.anchor}:${text}`;
    }));

    const missingPrivateComments = existingPrivateComments.filter(pc => {
      const text = pc.text || (pc.block ? pc.block.map(b => b.text).join('\n') : '');
      const key = `${pc.type}:${pc.anchor}:${text}`;
      return !finalCommentsSet.has(key);
    });

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

    // Debounce updates to prevent multiple rapid injections
    clearTimeout(splitViewUpdateTimeout);
    splitViewUpdateTimeout = setTimeout(async () => {
      try {
        // Get updated text from the document (source of truth)
        const text = doc.getText();

        // Determine which version to show based on current mode
        const isInCommentedMode = isCommentedMap.get(doc.uri.fsPath);

        let showVersion;
        if (isInCommentedMode) {
          // Source is in commented mode, show clean in split view
          // Load VCM comments to preserve alwaysShow metadata
          const { allComments: vcmComments } = await loadAllComments(relativePath);
          const keepPrivate = privateCommentsVisible.get(doc.uri.fsPath) === true;
          showVersion = stripComments(text, doc.uri.path, vcmComments, keepPrivate);
        } else {
          // Source is in clean mode, show commented in split view
          // Load comments from VCM to inject
          const { allComments: comments } = await loadAllComments(relativePath);
          const includePrivate = privateCommentsVisible.get(doc.uri.fsPath) === true;
          showVersion = injectComments(text, comments, includePrivate);
        }

        // Update the split view content
        provider.update(tempUri, showVersion);
      } catch (err) {
        // Ignore errors - VCM might not exist yet
      }
    }, 100); // Small debounce delay to prevent rapid duplicate updates
  });
  context.subscriptions.push(splitViewSyncWatcher);

  // Clean up when split view is closed (always, not just when liveSync is enabled)
  const closeWatcher = vscode.workspace.onDidCloseTextDocument((doc) => {
    if (tempUri && doc.uri.toString() === tempUri.toString()) {
      vcmEditor = null;
      tempUri = null;
      sourceDocUri = null;
      if (scrollListener) {
        scrollListener.dispose();
        scrollListener = null;
      }
    }
  });
  context.subscriptions.push(closeWatcher);

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

        // Text is already in clean mode, so just inject comments directly
        const includePrivate = privateCommentsVisible.get(doc.uri.fsPath) === true;
        newText = injectComments(text, mergedComments, includePrivate);

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
          const vcmData = JSON.parse((await vscode.workspace.fs.readFile(vcmFileUri)).toString());
          // Strip comments before injecting (except alwaysShow and private if visible)
          const keepPrivate = privateCommentsVisible.get(doc.uri.fsPath) === true;
          const cleanText = stripComments(text, doc.uri.path, vcmData.comments || [], keepPrivate);
          newText = injectComments(cleanText, vcmData.comments || [], keepPrivate);

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
            targetComment = candidates.find(c => c.originalLine === selectedLine);
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
          let currentComment = currentCandidates.find(c => c.originalLine === selectedLine);
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
              const firstLine = Math.min(...matchingComment.block.map(b => b.originalLine));
              const lastLine = Math.max(...matchingComment.block.map(b => b.originalLine));
              const range = new vscode.Range(firstLine, 0, lastLine + 1, 0);
              edit.delete(doc.uri, range);
            } else if (matchingComment.type === "inline") {
              // Remove just the inline comment part (keep the code)
              const lineText = lines[matchingComment.originalLine];
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
                  matchingComment.originalLine, commentStartIdx,
                  matchingComment.originalLine, lineText.length
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
            targetComment = candidates.find(c => c.originalLine === selectedLine);
            if (!targetComment) {
              targetComment = candidates[0]; // Fallback to first match
            }
          }

          // Only add this one comment to VCM, marked as private
          targetComment.isPrivate = true;
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
          let currentComment = currentCandidates.find(c => c.originalLine === selectedLine);
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

          targetVcmComment.isPrivate = true;
        }

        // Save updated comments (will split into shared/private automatically)
        await saveCommentsToVCM(relativePath, comments);

        // Check if private comments are currently visible
        const privateVisible = privateCommentsVisible.get(doc.uri.fsPath) === true;

        if (!privateVisible) {
          // Private mode is off, so hide this comment
          // Find the comment lines to remove
          const currentComments = extractComments(doc.getText(), doc.uri.path);
          const currentComment = currentComments.find(c => c.anchor === anchorHash);

          if (currentComment) {
            const edit = new vscode.WorkspaceEdit();

            if (currentComment.type === "block" && currentComment.block) {
              // Remove the entire block
              const firstLine = currentComment.block[0].originalLine;
              const lastLine = currentComment.block[currentComment.block.length - 1].originalLine;
              edit.delete(doc.uri, new vscode.Range(firstLine, 0, lastLine + 1, 0));
            } else if (currentComment.type === "inline") {
              // Remove inline comment from the line
              const currentLine = doc.lineAt(currentComment.originalLine);
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
        let currentComment = currentCandidates.find(c => c.originalLine === selectedLine);
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
              const firstLine = Math.min(...matchingComment.block.map(b => b.originalLine));
              const lastLine = Math.max(...matchingComment.block.map(b => b.originalLine));
              const range = new vscode.Range(firstLine, 0, lastLine + 1, 0);
              edit.delete(doc.uri, range);
            } else if (matchingComment.type === "inline") {
              // Remove just the inline comment part (keep the code)
              const lineText = lines[matchingComment.originalLine];

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
                  matchingComment.originalLine,
                  commentStartIndex,
                  matchingComment.originalLine,
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

        // Check current visibility state by detecting if private comments are in the document
        // Extract current comments and check if any private ones are present
        const currentComments = extractComments(text, doc.uri.path);
        const privateAnchors = new Set(privateComments.map(c => c.anchor));
        const privateCommentsInDoc = currentComments.some(c => privateAnchors.has(c.anchor));

        // Determine current visibility state
        // If we have an explicit stored state, use it
        // Otherwise, use document state as source of truth
        const storedState = privateCommentsVisible.get(doc.uri.fsPath);
        const currentlyVisible = storedState !== undefined ? storedState : privateCommentsInDoc;

        let newText;
        if (currentlyVisible) {
          // Hide private comments - remove ONLY private comments using anchor hashes
          const privateAnchors = new Set(privateComments.map(c => c.anchor));

          // Extract current comments to identify which ones are private
          const currentComments = extractComments(text, doc.uri.path);

          // Build a map of private comments by type and anchor for removal
          const privateBlocksToRemove = [];
          const privateInlinesToRemove = [];

          for (const current of currentComments) {
            if (privateAnchors.has(current.anchor)) {
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
                linesToRemove.add(blockLine.originalLine);
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
            const inlineToRemove = privateInlinesToRemove.find(c => c.originalLine === i);
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
          // Pass true to includePrivate to inject them
          newText = injectComments(text, privateComments, true);

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
    const keepPrivate = privateCommentsVisible.get(doc.uri.fsPath) === true;
    const clean = stripComments(text, doc.uri.path, comments, keepPrivate);
    const withComments = injectComments(clean, comments, keepPrivate);

    // Detect initial state if not already set
    if (!isCommentedMap.has(doc.uri.fsPath)) {
      const initialState = await detectInitialMode(doc, vcmFileUri, vcmDir);
      isCommentedMap.set(doc.uri.fsPath, initialState);
    }

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


    // Collapse any existing split groups to start fresh
    await vscode.commands.executeCommand("workbench.action.joinAllGroups");
    
    // Open in split view (beside) or same pane based on config
    const targetColumn = autoSplit ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active;
    vcmEditor = await vscode.window.showTextDocument(tempUri, {
      viewColumn: targetColumn,
      preview: true,  // Use preview tab (can be replaced)
    });

    // Track which source document has the split view open for live sync
    sourceDocUri = doc.uri;

    // Setup bidirectional click-to-jump (source → split view)
    const sourceEditor = editor;
    
    let activeHighlight;

    scrollListener = vscode.window.onDidChangeTextEditorSelection(async e => {
      if (!vcmEditor) return;
      if (e.textEditor !== sourceEditor) return;

      // Only jump on mouse clicks, not keyboard navigation or typing
      // e.kind will be undefined for typing, 1 for keyboard, 2 for mouse
      if (e.kind !== vscode.TextEditorSelectionChangeKind.Mouse) return;

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