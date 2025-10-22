const vscode = require("vscode");

let hcStatus;
let hcEditor;
let tempUri;

async function activate(context) {
  const config = vscode.workspace.getConfiguration("hideComments");
  const autoSplit = config.get("autoSplitView", true);

  const disposable = vscode.commands.registerCommand("hideComments.previewToggle", async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    // Toggle off if already in HC mode
    if (hcEditor && vscode.window.activeTextEditor === hcEditor) {
      await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
      hcEditor = null;
      hcStatus?.hide();
      return;
    }

    const doc = editor.document;
    const baseName = doc.fileName.split(/[\\/]/).pop();
    const hcLabel = `HC_${baseName}`;

    // Remove comment lines
    const stripped = [
      `# 🟢 ${hcLabel}`,
      ...doc.getText()
        .split("\n")
        .filter(line => !/^\s*(#|\/\/|--|%|;)/.test(line)),
    ].join("\n");

    // Split to right without duplicating
    if (autoSplit) await vscode.commands.executeCommand("workbench.action.focusFirstEditorGroup");

    // Use a virtual scheme (not file, untitled, or backup tracked)
    tempUri = vscode.Uri.parse(`untitled:${hcLabel}`);

    const tempDoc = await vscode.workspace.openTextDocument(tempUri);
    const edit = new vscode.WorkspaceEdit();
    edit.insert(tempUri, new vscode.Position(0, 0), stripped);
    await vscode.workspace.applyEdit(edit);

    hcEditor = await vscode.window.showTextDocument(tempDoc, {
      viewColumn: autoSplit ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active,
      preview: true,
    });
    

    // Strong header banner (visible even at top)
    const banner = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      before: {
        contentText: `🟢 ${hcLabel}`,
        color: "#00ff88",
        fontWeight: "bold",
        backgroundColor: "#00330088",
        margin: "0 1rem 0 0",
      },
    });
    hcEditor.setDecorations(banner, [new vscode.Range(0, 0, 0, 0)]);

    // Status bar indicator
    if (!hcStatus) {
      hcStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
      hcStatus.command = "hideComments.previewToggle";
      context.subscriptions.push(hcStatus);
    }
    hcStatus.text = "🟢 HC VIEW";
    hcStatus.color = "#00ff88";
    hcStatus.show();
  });

  // Cleanup when HC view closes or editor lost
  const cleanup = () => {
    if (!hcEditor) return;
    const stillVisible = vscode.window.visibleTextEditors.some(e => e === hcEditor);
    if (!stillVisible) {
      hcEditor = null;
      hcStatus?.hide();
    }
    vscode.window.onDidChangeWindowState(state => {
      if (!state.focused && hcEditor) {
        vscode.commands.executeCommand("workbench.action.closeAllEditors");
        hcEditor = null;
        hcStatus?.hide();
      }
    });
  };

  context.subscriptions.push(
    disposable,
    vscode.window.onDidChangeVisibleTextEditors(cleanup),
    vscode.workspace.onDidCloseTextDocument(cleanup)
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
