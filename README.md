# TraceNotes

> An extension for code tracing and note-taking that supports exporting and importing in Markdown format.

### Select the code and press **`Opt+C`** or **`Alt+C`** to collect traces; the rest is intuitive.

![UI explanation](images/UI_explaination.jpeg)

TraceNotes is an extension for navigating and documenting code logic. It allows you to build a structured narrative of code flows that stay synchronized with the editor.

## Features

### Trace Collection

- **Capture** – Select code and press `Opt+C` or `Alt+C` to create a trace point.
- **Indentation Correction** – Automatically removes leading indentation from collected snippets based on the selection.
- **Recovery** – Trace points attempt to maintain their position when files are modified, though accuracy may vary depending on the extent of the changes.

### Project Sharing (Worktrees & Clones)

- **Cross-Checkout Sync** – Share traces across different git worktrees, clones, or checkouts of the same repository. Projects are automatically recognized by git remote `origin`, folder name, or by clicking the **`Set Project ID`** (`🔗`) button in the Storyboard header (`tracenotes.projectId`).
- **Portable Paths** – Traces store workspace-relative paths, opening the corresponding file in each local checkout.
- **Independent Positions & Live Updates** – Code position validation is kept per checkout so different branches don't conflict, while trace edits sync live across open VS Code windows.

### Markdown Portability

- **Export** – Save collected traces to a Markdown file. The export preserves the hierarchy using standard Markdown headings.
- **Import** – Load trace data back into the extension from supported Markdown documents.

### Additional Capabilities

- **Organization** – Group traces into levels (up to 10 levels deep), manage multiple trace trees, and reorder or nest cards via drag and drop.
- **Navigation & Search** – Navigate back and forward across trace views (`<` / `>`) and search traces in a floating view (`🔍`).
- **Synchronization** – Link trace cards to source lines for bi-directional navigation. Cursor movement highlights associated cards.
- **Visual Markers** – Assign colors to traces to highlight sidebar cards and editor gutter positions.
- **Annotations & Standalone Notes** – Add notes to individual trace points or click `+` to insert standalone empty note cards.

---

## Commands & Shortcuts

| Action              | Shortcut (macOS) | Shortcut (Win/Linux) | Command                               |
| :------------------ | :--------------- | :------------------- | :------------------------------------ |
| **Collect Trace**   | `Option + C`     | `Alt + C`            | `TraceNotes: Collect Trace`           |
| **Export MD**       | —                | —                    | `TraceNotes: Export to Markdown`      |
| **Import MD**       | —                | —                    | `TraceNotes: Import Trace`            |
| **Export All Data** | —                | —                    | `TraceNotes: Export All Data to JSON` |
| **Clear Current**   | —                | —                    | `TraceNotes: Clear All Traces`        |
| **Set Project ID**  | —                | —                    | `TraceNotes: Set Project ID`          |

---

## Support

If you find this extension helpful, consider buying me a coffee!

[![Buy Me A Coffee](https://img.shields.io/badge/Buy_Me_A_Coffee-Donate-orange.svg?style=flat-square&logo=buy-me-a-coffee)](https://buymeacoffee.com/robertttbs)

---

## License

Distributed under the **MIT License**.
