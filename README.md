# VCM - View Comments Mirror
> ***Invisible documentation*** **layer for code.**  
A VS Code extension that allows developers to document their code, via comments, as much as they like ***without bloating the code.***

## Overview

>VCM (View Comments Mirror) lets you toggle, version, and persist comments without ever polluting your actual source files.  

It mirrors all comments into .vcm/\<pathname>/*.vcm.json files, allowing you to:
- Edit clean code while comments remain safely versioned.
- Instantly hide or show all comments in any file.
- Keep private, shared, and always-visible comment layers.
- View split panes for side-by-side clean vs. documented views.  

Auto-sync everything with your Git workflow. No external storage needed.  

Anyone with the extension can toggle the same comments on and off if you choose to push the .vcm folder.  
If your team does not use VCM, simply add .vcm to your .gitignore and mark your specific comments private so you can document as much as you'd like without interfering with the team code.


## Features
#### Comment Layer Control
- Toggle clean / commented view per file (Ctrl+V+C).
- Split view mode:  
See clean code and commented code side-by-side with live updates.  
Split view is a *temporary view*.
- Comments marked private are stored separately in *.vcm/private/* which can be added to your gitignore or pushed up to share with team members who also use the extension.
- Comments automatically anchor to their code via stable content hashes.
- When you move, copy, or paste code, your comments move with it.
- Version tracked comments
- When in clean mode, empty lines ***between comments*** are removed to negate long empty blocks of spacing. They are added back in commented mode.
- Empty lines between ***code and comments*** are not removed in any mode.
- Command/Control + Shift + P then type VCM: to view all options.

### Modes
- ***Commented***:  
    - View all comments.
    - >**This will only show private comments if you have private toggled on as well.**
- ***Clean***: 
    - View no comments
    - >**'Always Show' comments are still visible here.**
    - >Private comments will still show ***if*** you have it currently toggled on.
    - >No other comment will be visible.
- ***Always Show***: 
    - >Right click to mark any comment as 'Always Show' so that ***no matter the mode, it will show.***
- ***Private***: 
    - Private toggles show/hide of only ***certain*** comments.
    - >Right click to mark certain comments as Private.  
    - >Private comments are stored in ***.vcm/private/*** which is separate from team comments (which are stored in *.vcm/shared/*) and toggle **specific** comments on and off as needed.
    - >Useful for personal notes or simply for excessive documentation that you or your team want to keep but isolate.  
    - >**If you dont wish to share 'private' comments, simply place .vcm/private/\* into your .gitignore in the root directory.**

- ***Split View***:  
    - View both clean and commented at once so you can see it live updating.
    - >Auto detects if you are in commented or clean and shows the opposite in split view.
    - >Temporary views that start with VCM_<filename> and are therefor not tracked by git.


### Smart Sync
- Comments are auto stored in .vcm/\<path>\/<filename>.vcm.json upon first VCM toggle per file.
- Editing files auto-updates the .vcm mirror.
- Comments added in clean mode are appended safely without overwriting.


### Developer-Friendly
- Works across all major languages (.js, .ts, .py, .cpp, .sql, .cs, .go, etc.)
- Lightweight — no database, server, or API needed.
- Seamlessly integrates with Git, GitHub, and your existing version control.

### Warning
Do not delete your .vcm folder without first toggling on all comments you wish to keep.

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

install locally (anyone with file): code --install-extension vcm-view-comments-mirror-0.1.0.vsix

### when publishing
1. bump the version in package.json "version": "0.1.1"
2. run npm run build:vsix




