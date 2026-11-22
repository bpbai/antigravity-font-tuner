---
name: antigravity-font-tuner-setup
description: Install, verify, or uninstall the Antigravity Font Tuner plugin without modifying app.asar or language_server binaries.
---

# Antigravity Font Tuner — Agent Installation Guide

Follow these steps when the user asks you to install, enable, or troubleshoot **Antigravity Font Tuner**:

## 1. Prerequisites
- Node.js >= 20 (Antigravity ships with Node.js >= 22/24 internally).
- Antigravity desktop must expose its local CDP debug port (`--remote-debugging-port=0` on the launch shortcut).
- Never modify `app.asar`, `language_server`, or hand-edit `~/.gemini/config/config.json`.

## 2. Install Plugin
From the repository root:

```bash
node install.mjs install
```

This copies only `plugin.json`, `assets/`, and `sidecars/` to:
- `~/.gemini/config/plugins/antigravity-font-tuner/`

And ensures the custom drop-in font folder exists at:
- `~/.gemini/antigravity/sidecar_data/antigravity-font-tuner/font_tuner/data/fonts/`

## 3. Enable Local CDP (If `DevToolsActivePort` Is Missing)
Run:

```bash
node install.mjs status
```

If `CDP active port` says `NO`, run:

```bash
node install.mjs enable-cdp
```

On Windows this inspects Desktop, Start Menu, and Taskbar `.lnk` shortcuts matching Antigravity and appends `--remote-debugging-port=0` with readback verification. On macOS/Linux it prints the launch command or `.desktop` flag.

Ask the user to **quit and relaunch Antigravity completely** from the updated shortcut so Chromium activates `DevToolsActivePort`.

## 4. Custom & System Font Loading Notes
- Any `.ttf`, `.otf`, `.woff2` file dropped into the plugin `fonts/` folder is automatically scanned and loaded directly into the renderer via `FontFace` (no OS installation required).
- Native OS `.ttf`, `.otf`, and `.ttc` fonts across Windows, macOS, and Linux are automatically indexed for quick selection in the **Font Tuner** side panel.
- Restarting or updating Antigravity preserves this plugin cleanly because no core application files are patched.

## 5. Uninstall
To remove the plugin while keeping settings/fonts:

```bash
node install.mjs uninstall
```

To also remove saved settings and custom fonts:

```bash
node install.mjs uninstall --purge-data
```
