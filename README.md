# VCM - View Comments Mirror
> Invisible documentation layer for code.  
A VS Code extension that allows developers to document their code, via comments, as much as they like without bloating the code.

## Overview

VCM (View Comments Mirror) lets you toggle, version, and persist comments — without ever polluting your actual source files.  

It mirrors all comments into .vcm/*.vcm.json files, allowing you to:
- Instantly hide or show all comments in any file.
- Edit clean code while comments remain safely versioned.
- Keep private, shared, and always-visible comment layers.
- View split panes for side-by-side clean vs. documented views.  

Auto-sync everything with your Git workflow — no external storage needed.  

Anyone with the extension can toggle the same comments on and off if you choose to push the .vcm folder.  
If your team does not use VCM, simply add .vcm to your .gitignore and mark your specific comments private so you can document as much as you'd like without interfering with the team code.


## Features
#### Comment Layer Control
- Toggle clean / commented view per file (Ctrl+V+C).
Split view mode — see clean code and commented code side-by-side.
- Comments marked private are stored separately in .vcm/private/ which can be added to your gitignore or pushed up to share with team members who also use the extension.
- Comments automatically anchor to their code via stable content hashes.
- When you move, copy, or paste code, your comments move with it.
- Version tracked comments

#### Smart Sync
- Comments are auto stored in .vcm/<path>/<filename>.vcm.json upon first VCM toggle per file.
- Editing files auto-updates the .vcm mirror.
- Comments added in clean mode are appended safely without overwriting.

#### Privacy + Visibility
- Always Show: Right-click a comment → “Always Show” to keep visible even in clean mode.
- Private Mode: Right-click a comment → Mark as private toggles show/hide of only ***certain*** comments.

#### Developer-Friendly
- Works across all major languages (.js, .ts, .py, .cpp, .sql, .cs, .go, etc.)
- Lightweight — no database, server, or API needed.
- Seamlessly integrates with Git, GitHub, and your existing version control.

## Philosophy
VCM was built to solve one core problem:
“How do I keep my code production-clean without losing my thought process?”
Instead of deleting your reasoning, testing notes, or TODOs, VCM preserves them invisibly — like Git for your brain.

## Installation

From VS Code Marketplace:ext install serendipbrity.vcm-view-comments-mirror

## Author
Brittani Court  
Software Engineer  
[GitHub Profile](https://github.com/Serendipbrity)


>Documentation shouldn’t slow you down. It should move with you.

### License

MIT © Brittani Court


