# CLAUDE.md

## Project

VS Code extension for collecting hierarchical code "trace points" with Markdown export/import. Two bundles share `src/types.ts`:
- **Extension host** (Node CJS): `src/extension.ts` → `dist/extension.js`
- **Webview** (React 18 IIFE): `src/webview/index.tsx` → `dist/webview.js` + `webview.css`

## Commands

```bash
npm run build   # esbuild both bundles
npm run watch   # watch both
npm run lint    # eslint src --ext ts,tsx
npm run typecheck  # tsc --noEmit (esbuild doesn't type-check)
npm test        # vitest run
```

Single vitest file: `npx vitest run <path>`. Tests that need `vscode` use `vi.mock('vscode', () => import('./test/vscodeMock'))`; `src/test/vscodeMock.ts` backs `workspace.fs` with the real disk, so point storage at a temp dir (see `src/traceManager.test.ts`). Package: `npx vsce package`.

**A clean `npm test` is fully green** — any failed file or test is a regression. `src/traceManager.test.ts` is the safety net for TraceManager (CRUD, `clear`, `undoRemove` edge cases, groups/`MAX_DEPTH`, imports, trees, multi-change edit tracking, re-anchoring, persistence round-trip, positions-only saves); run it after touching core. A test that mutates traces should end with `expectIndexConsistent(m)`, which checks all three index maps against the tree. To prove a new test bites, plant the bug in the source, run the test (must fail), then restore.

## Architecture

**Message bus.** Extension ↔ webview messages are typed unions in `src/types.ts` (`ExtensionToWebviewMessage`, `WebviewToExtensionMessage`). New commands must be added to the union **and** the dispatch switch in `src/extension.ts`. Webview senders use `src/webview/utils/messaging.ts`. `StoryboardProvider` (`src/webviewProvider.ts`) gates every inbound message behind `traceManager.ensureReady()` to prevent disk-load races — keep this gate.

**TraceManager (`src/traceManager.ts`) is the source of truth** for `TraceTree[]`, the active tree/group cursor, and fast-path index maps (`traceIndex`, `traceIdMap`, `parentIdMap`); `traceIndex` buckets are keyed only via `fileIndexKey()` (file-less note cards share one bucket). It also handles:
- Range validation via token anchoring with a per-call `VALIDATION_BUDGET_MS`.
- Persistence via `src/storage/FileStorageManager.ts` — atomic write (temp → rotate → rename). With a folder open, trees go to a per-project shared file under `globalStorageUri/projects/` (shared across checkouts by project ID) and per-folder positions to `storageUri`; validation writes only positions (`persistPositions()`). See `docs/specs/shared-project-traces.md`. `deactivate()` awaits `flush()` to drain debounced saves.
- `onDidChangeTraces` events drive debounced decoration repaints + `syncWorkspace` posts.

Always mutate traces through TraceManager methods (`add`, `remove`, `reorder`, `relocateTrace`, `enterGroup`/`exitGroup`, `moveToChild`/`moveToParent`) so indexes and persistence stay in sync.

**Decorations (`src/decorationManager.ts`).** Fixed pool of `TextEditorDecorationType` (one per highlight color + faded + flash). Repaints on active-editor change, document edits (100 ms debounce), and trace-change events (50 ms — wins on burst).

**Webview.** React 18 + `@dnd-kit`. Components in `src/webview/components/`, hooks in `src/webview/hooks/`. Strict CSP with per-load nonce from `crypto.randomBytes` (`getNonce()` in `webviewProvider.ts`); only `dist/` in `localResourceRoots`.

**Markdown round-trip.** `src/exporter.ts` uses heading depth = trace depth + 2 and encodes colors as `%%Tag%%` (`HIGHLIGHT_TO_TAG` in `types.ts`). Adding a color requires updating the `HighlightColor` union + `HIGHLIGHT_TO_TAG` in `types.ts`, `HIGHLIGHT_STYLES` in `decorationManager.ts`, and `HIGHLIGHT_COLORS` in `TraceCard.tsx`.

## Conventions

- IDs: `crypto.randomUUID()` (global Web Crypto; the Node 18+ extension host always has it).
- `rangeOffset: [number, number]` (absolute offsets) is authoritative; `lineRange` is a legacy/UI projection.
- Bundles are minified — debug with source maps.
- `.vscodeignore` ships `dist/` only (excludes `src/`, `*.ts`, `*.tsx`).
- `MAX_DEPTH = 10` (`types.ts`) caps group nesting; enforced in TraceManager (`moveToChild`/`enterGroup`), also read by the webview.

## When uncertain

- Mutating `TraceTree[]` outside a TraceManager method, removing the `ensureReady()` gate, or changing the persistence/atomic-write flow: STOP, propose first — these break index/disk sync.
- Adding a new dependency: ask before adding.
- A test fails for an unclear reason: don't edit the test, ask.
- My request is ambiguous: ask ONE clarifying question, don't guess.

## Operating docs (handoff)

Project-specific operating guides live in `docs/`; general method lives in `~/.claude/playbooks/`. Read the project one first, follow its pointer to the global one.

- `docs/diagnosis.md` — the 3 traps that bite most here (read before trusting `npm test` or doing fan-out edits).
- `docs/delegation.md` — what in THIS repo is worth a subagent (→ global `delegation.md`).
- `docs/judgment.md` — done / ask / wrong-direction calls, keyed to this codebase (→ global `judgment.md`).
- `docs/prompt-templates.md` — dispatch templates pre-filled for tracenotes (→ global `prompt-templates.md`).
- `docs/maintenance.md` — how to update these `docs/` files safely.
- `docs/handoff-letter.md` — what the previous session most wants you to know.
