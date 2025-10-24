const vscode = require("vscode");
const crypto = require("crypto");

let vcmStatus;
let vcmEditor;
let tempUri;
let scrollListener;

// Register custom content provider for vcm-view scheme
class VCMContentProvider {
  constructor() {
    this.content = new Map();
  }
  provideTextDocumentContent(uri) {
    return this.content.get(uri.toString()) || "";
  }
  update(uri, content) {
    this.content.set(uri.toString(), content);
  }
}

// Hash a line of code (with line index salt for uniqueness)
function hashLine(line, lineIndex) {
  return crypto.createHash('md5').update(line.trim() + "::" + lineIndex).digest('hex').substring(0, 8);
}

// Extract comments and anchor them to next non-comment line
function extractComments(text, filePath) {
  const lines = text.split("\n");
  const comments = [];
  let commentBuffer = [];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    
    // Reset buffer on blank lines to prevent drift
    if (!trimmed) {
      if (commentBuffer.length) commentBuffer = [];
      continue;
    }
    
    // Check if line is a comment
    const commentMatch = line.match(/^(\s*)(#|\/\/|--|%|;)\s?(.*)$/);
    
    if (commentMatch) {
      // This is a comment line - add to buffer
      const indent = commentMatch[1];
      const marker = commentMatch[2];
      const text = commentMatch[3];
      
      commentBuffer.push({
        text: text,
        indent: indent,
        marker: marker,
        originalLine: i
      });
    } else {
      // This is a code line
      
      // Check for inline comment (with negative lookbehind to avoid strings)
      // Matches: code + whitespace + comment marker (not inside quotes)
      const inlineMatch = line.match(/^(.*?)(?<!["'])(\s+)(#|\/\/|--|%|;)\s?(.*)$/);
      
      if (inlineMatch && inlineMatch[1].trim()) {
        // Has inline comment
        const codePart = inlineMatch[1];
        const marker = inlineMatch[3];
        const commentText = inlineMatch[4];
        
        comments.push({
          type: "inline",
          anchor: hashLine(codePart, i),
          anchorLine: i,
          text: commentText,
          marker: marker,
          codeLine: codePart
        });
      }
      
      // If we have buffered comments above, attach them to this code line
      if (commentBuffer.length > 0) {
        comments.push({
          type: "block",
          anchor: hashLine(line, i),
          anchorLine: i,
          block: commentBuffer,
          codeLine: line.trim()
        });
        commentBuffer = [];
      }
    }
  }
  
  return comments;
}

// Rebuild text with comments injected at anchors
function injectComments(cleanText, comments) {
  const lines = cleanText.split("\n");
  const result = [];
  
  // Pre-index comments by anchor for O(1) lookup
  const blockMap = {};
  const inlineMap = {};
  
  for (const c of comments) {
    if (c.type === "block") {
      blockMap[c.anchor] = c;
    } else if (c.type === "inline") {
      inlineMap[c.anchor] = c;
    }
  }
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineHash = hashLine(line, i);
    
    // Check for block comments anchored to this line
    const blockComment = blockMap[lineHash];
    if (blockComment) {
      // Insert comment block above this line
      for (const comment of blockComment.block) {
        result.push(`${comment.indent}${comment.marker} ${comment.text}`);
      }
    }
    
    // Add the code line
    const inlineComment = inlineMap[lineHash];
    if (inlineComment) {
      // Add inline comment to end of line
      result.push(`${line}  ${inlineComment.marker} ${inlineComment.text}`);
    } else {
      result.push(line);
    }
  }
  
  return result.join("\n");
}

// Strip all comments from text but keep indentation and spacing
function stripComments(text) {
  return text
    .split("\n")
    .filter(line => {
      const trimmed = line.trim();
      // Keep blank lines OR lines that aren't pure comment lines
      return !trimmed || !/^(#|\/\/|--|%|;)/.test(trimmed);
    })
    .map(line => {
      // Remove inline comments from code lines (anything after comment marker)
      return line.replace(/\s+(#|\/\/|--|%|;).*$/, '');
    })
    .join("\n");
}

async function activate(context) {
  const config = vscode.workspace.getConfiguration("vcm");
  const autoSplit = config.get("autoSplitView", true);
  
  // Ensure .vcm directory exists
  const vcmDir = vscode.Uri.joinPath(
    vscode.workspace.workspaceFolders?.[0]?.uri || vscode.Uri.file(process.cwd()),
    ".vcm"
  );
  
  try {
    await vscode.workspace.fs.createDirectory(vcmDir);
  } catch (e) {
    // Directory might already exist
  }
  
  // Close any lingering VCM views from previous session
  setTimeout(async () => {
    const groups = vscode.window.tabGroups.all;
    if (groups.length > 1) {
      for (let i = 1; i < groups.length; i++) {
        const group = groups[i];
        if (group.tabs.length === 0) {
          await vscode.commands.executeCommand("workbench.action.closeGroup");
        } else {
          for (const tab of group.tabs) {
            if (tab.input?.uri?.scheme === "vcm-view") {
              await vscode.commands.executeCommand("workbench.action.closeGroup");
              break;
            }
          }
        }
      }
    }
  }, 100);
  
  // Register the content provider
  const provider = new VCMContentProvider();
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider("vcm-view", provider)
  );

  // Helper to save .vcm file
  async function saveVCM(doc) {
    if (doc.uri.scheme !== "file") return;
    if (doc.uri.path.includes("/.vcm/")) return;
    if (doc.languageId === "json") return;

    const text = doc.getText();
    const comments = extractComments(text, doc.uri.path);
    
    const relativePath = vscode.workspace.asRelativePath(doc.uri);
    const vcmFileUri = vscode.Uri.joinPath(vcmDir, relativePath + ".vcm.json");
    
    // Ensure intermediate directories exist
    const pathParts = relativePath.split(/[\\/]/);
    if (pathParts.length > 1) {
      const vcmSubdir = vscode.Uri.joinPath(vcmDir, pathParts.slice(0, -1).join("/"));
      try {
        await vscode.workspace.fs.createDirectory(vcmSubdir);
      } catch (e) {
        // Directory might already exist
      }
    }
    
    const vcmData = {
      file: relativePath,
      lastModified: new Date().toISOString(),
      comments: comments
    };
    
    await vscode.workspace.fs.writeFile(
      vcmFileUri,
      Buffer.from(JSON.stringify(vcmData, null, 2), "utf8")
    );
  }

  // Watch for file saves to update .vcm mirrors
  const saveWatcher = vscode.workspace.onDidSaveTextDocument(saveVCM);
  context.subscriptions.push(saveWatcher);

  // Optional: Live sync with debounce (if enabled in settings)
  const liveSync = config.get("liveSync", false);
  if (liveSync) {
    let writeTimeout;
    const changeWatcher = vscode.workspace.onDidChangeTextDocument(e => {
      clearTimeout(writeTimeout);
      writeTimeout = setTimeout(() => saveVCM(e.document), 2000);
    });
    context.subscriptions.push(changeWatcher);
  }

  // Main toggle command
  const disposable = vscode.commands.registerCommand("vcm.toggleComments", async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    // Toggle off if already in VCM mode
    if (vcmEditor && vscode.window.activeTextEditor === vcmEditor) {
      vcmEditor = null;
      vcmStatus?.hide();
      if (scrollListener) {
        scrollListener.dispose();
        scrollListener = null;
      }

      // Close only the VCM group
      await vscode.commands.executeCommand("workbench.action.closeEditorsInGroup");

      // Collapse empty right-hand group
      const groups = vscode.window.tabGroups.all;
      if (groups.length > 1) {
        const rightGroup = groups[groups.length - 1];
        const hasTabs = rightGroup.tabs.some(t => t.input?.uri?.scheme !== "vcm-view");
        if (!hasTabs) {
          await vscode.commands.executeCommand("workbench.action.joinAllGroups");
        }
      }

      await vscode.commands.executeCommand("workbench.action.focusFirstEditorGroup");
      return;
    }

    const doc = editor.document;
    const baseName = doc.fileName.split(/[\\/]/).pop();
    const vcmLabel = `VCM_${baseName}`;

    // Load .vcm file if it exists
    const relativePath = vscode.workspace.asRelativePath(doc.uri);
    const vcmFileUri = vscode.Uri.joinPath(vcmDir, relativePath + ".vcm.json");
    
    let comments = [];
    try {
      const vcmContent = await vscode.workspace.fs.readFile(vcmFileUri);
      const vcmData = JSON.parse(vcmContent.toString());
      comments = vcmData.comments || [];
    } catch (e) {
      // No .vcm file yet - extract from current file and save it
      comments = extractComments(doc.getText(), doc.uri.path);
      await saveVCM(doc);
    }

    // Get clean version of the code
    const cleanCode = stripComments(doc.getText());
    
    // Inject comments back in
    const withComments = injectComments(cleanCode, comments);

    // Split to right without duplicating
    if (autoSplit) await vscode.commands.executeCommand("workbench.action.focusFirstEditorGroup");

    // Use custom scheme that won't prompt for save
    tempUri = vscode.Uri.parse(`vcm-view:${vcmLabel}`);
    provider.update(tempUri, withComments);

    // Ensure only one group before opening
    await vscode.commands.executeCommand("workbench.action.joinAllGroups");

    // Open the VCM view with comments
    const targetColumn = autoSplit ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active;
    vcmEditor = await vscode.window.showTextDocument(tempUri, {
      viewColumn: targetColumn,
      preview: true,
      preserveFocus: false,
    });

    // Reset layout tracking
    setTimeout(async () => {
      try {
        await vscode.commands.executeCommand("workbench.action.focusFirstEditorGroup");
        await vscode.commands.executeCommand("workbench.action.pinEditor");
      } catch (e) {
        console.warn("VCM layout reset failed", e);
      }
    }, 150);
    
    // Setup symbol-based click-to-jump (bidirectional)
    const sourceEditor = editor;
    
    scrollListener = vscode.window.onDidChangeTextEditorSelection(async e => {
      if (!vcmEditor) return;
      
      let fromEditor, toEditor;
      if (e.textEditor === sourceEditor) {
        fromEditor = sourceEditor;
        toEditor = vcmEditor;
      } else if (e.textEditor === vcmEditor) {
        fromEditor = vcmEditor;
        toEditor = sourceEditor;
      } else {
        return;
      }
      
      const cursorPos = e.selections[0].active;
      const wordRange = fromEditor.document.getWordRangeAtPosition(cursorPos);
      if (!wordRange) return;
      
      const symbolAtCursor = fromEditor.document.getText(wordRange);
      const targetText = toEditor.document.getText();
      
      // Look for function/class definitions or the symbol itself
      const patterns = [
        new RegExp(`^\\s*def\\s+${symbolAtCursor}\\s*\\(`, 'm'),
        new RegExp(`^\\s*class\\s+${symbolAtCursor}\\s*[:\\(]`, 'm'),
        new RegExp(`^\\s*function\\s+${symbolAtCursor}\\s*\\(`, 'm'),
        new RegExp(`^\\s*const\\s+${symbolAtCursor}\\s*=`, 'm'),
        new RegExp(`\\b${symbolAtCursor}\\b`, 'm'),
      ];
      
      let targetLine = -1;
      for (const pattern of patterns) {
        const match = targetText.match(pattern);
        if (match && match.index !== undefined) {
          targetLine = targetText.substring(0, match.index).split("\n").length - 1;
          break;
        }
      }
      
      if (targetLine >= 0) {
        const targetPos = new vscode.Position(targetLine, 0);
        toEditor.selection = new vscode.Selection(targetPos, targetPos);
        
        const fromVisibleRanges = fromEditor.visibleRanges;
        if (fromVisibleRanges.length > 0) {
          const fromTopLine = fromVisibleRanges[0].start.line;
          const fromCursorLine = cursorPos.line;
          const linesFromTop = fromCursorLine - fromTopLine;
          const targetTopLine = Math.max(0, targetLine - linesFromTop);
          
          toEditor.revealRange(
            new vscode.Range(targetTopLine, 0, targetLine + 10, 0),
            vscode.TextEditorRevealType.Default
          );
          
          setTimeout(() => {
            toEditor.revealRange(
              new vscode.Range(targetTopLine, 0, targetTopLine, 0),
              vscode.TextEditorRevealType.AtTop
            );
          }, 10);
        } else {
          toEditor.revealRange(
            new vscode.Range(targetPos, targetPos),
            vscode.TextEditorRevealType.InCenter
          );
        }
      }
    });
    context.subscriptions.push(scrollListener);
          
    // Header banner
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

    // Status bar indicator
    if (!vcmStatus) {
      vcmStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
      vcmStatus.command = "vcm.toggleComments";
      context.subscriptions.push(vcmStatus);
    }
    vcmStatus.text = "💬 VCM: Comments Visible";
    vcmStatus.color = "#00ff88";
    vcmStatus.show();
  });

  // Cleanup when VCM view closes
  const cleanup = () => {
    if (!vcmEditor) return;
    const stillVisible = vscode.window.visibleTextEditors.some(e => e === vcmEditor);
    if (!stillVisible) {
      vcmEditor = null;
      vcmStatus?.hide();
      if (scrollListener) {
        scrollListener.dispose();
        scrollListener = null;
      }
      context.workspaceState.update('vcmViewActive', false);
    }
  };

  context.subscriptions.push(
    disposable,
    vscode.window.onDidChangeVisibleTextEditors(cleanup),
    vscode.workspace.onDidCloseTextDocument(cleanup)
  );
  
  context.workspaceState.update('vcmViewActive', false);
}

function deactivate() {
  if (scrollListener) {
    scrollListener.dispose();
  }
  if (vcmEditor) {
    vscode.commands.executeCommand("workbench.action.closeEditorsInGroup");
  }
}

module.exports = { activate, deactivate };