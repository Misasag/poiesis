# Task

feat(skills): add standard discovery and prompt transparency

Accept Agent Skills standard SKILL.md bundles (kind from top-level kind or metadata.poiesis.kind), discover four roots (workspace .poiesis/skills and .agents/skills, user ~/.poiesis/skills and ~/.agents/skills) with rank-based shadowing, and show source badges, injected-character budget, an exact prompt preview, scope-aware scaffolds, and hot reload in Customize. Documents the new roots and shadowing rule in the Skills contract.

Implement the behavior described above in the existing source. Relevant areas:
- agent-window/src/browser/agent-window-widget.tsx
- agent-window/src/browser/skill-document.ts
- agent-window/src/browser/style/index.css
- agent-window/src/browser/workspace-skill-service.ts

Only edit source files under agent-window/src/. You may read and run tests. Do not edit tests, helpers, manifests, configuration or dependencies. Do not commit or inspect external repositories, benchmark metadata or solution history. Acceptance runs these commands (expected exit 0):
- npm run compile --workspace=@poiesis/theia-agent-window
- node scripts/test-skill-document.mjs

Instruction source: commit-message. Source paths are derived from the diff; no solution code is included.
