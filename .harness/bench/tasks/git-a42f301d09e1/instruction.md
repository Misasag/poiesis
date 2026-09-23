# Task

Rebuild Customize as a Cursor-style page with an inline Monaco skill editor

Replace the long single-column Customize page with Cursor's structure:
a search field, a scope selector pill, chip tabs (Skills / Plugins),
scope groups rendered as rounded list cards with compact rows, and
Cursor-style empty-state cards. Clicking a row now navigates to a detail
page inside the same view (back button, meta line, info strip) whose
body is a Theia Monaco editor filling the remaining height, replacing
the small textarea and its nested scrolling. Skill proposals appear as
a group at the top of the Skills tab with their own detail page.

Also: unsaved-change guards on every navigation path, list scroll
restoration, external file changes reloaded only when clean, a Plugins
placeholder without dead controls, light-theme tokens for the new
classes, a late Theia theme restore sync, a shared PoiesisDisclosureSummary
component, an editor lifecycle unit test, and smoke updates for the new
selectors.

Implement the behavior described above in the existing source. Relevant areas:
- agent-window/src/browser/agent-window-widget.tsx
- agent-window/src/browser/agent-window/agent-part.tsx
- agent-window/src/browser/agent-window/agent-window-host.ts
- agent-window/src/browser/agent-window/customize-part.tsx
- agent-window/src/browser/agent-window/settings-part.tsx
- agent-window/src/browser/components/poiesis-disclosure.tsx
- agent-window/src/browser/style/agent.css
- agent-window/src/browser/style/components.css
- agent-window/src/browser/style/customize.css
- agent-window/src/browser/style/settings.css
- agent-window/src/browser/style/theme.css
- agent-window/src/browser/theme-preference-service.ts

Only edit source files under agent-window/src/. You may read and run tests. Do not edit tests, helpers, manifests, configuration or dependencies. Do not commit or inspect external repositories, benchmark metadata or solution history. Acceptance runs these commands (expected exit 0):
- npm run compile --workspace=@poiesis/theia-agent-window
- node scripts/test-customize-editor-lifecycle.mjs

Instruction source: commit-message. Source paths are derived from the diff; no solution code is included.
