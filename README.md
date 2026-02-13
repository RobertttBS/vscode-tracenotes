# TraceNotes

A VS Code extension for collecting code trace points and visualizing them in an interactive sidebar storyboard.

## Features

- **Collect Traces** – Select code in any file and capture it as a trace point with smart dedent
- **Sidebar Storyboard** – View all traces in a React-powered sidebar with syntax highlighting
- **Drag & Drop** – Reorder traces to build your narrative
- **Jump to Code** – Click any trace card to navigate back to the source with a flash highlight
- **Editable Notes** – Annotate each trace with context or observations
- **Markdown Export** – Export all traces as a formatted Markdown document
- **Crash Recovery** – Traces persist in workspace state across reloads

## Commands

| Command                          | Keybinding (macOS) | Keybinding (Win/Linux) | Description                                    |
| -------------------------------- | ------------------ | ---------------------- | ---------------------------------------------- |
| `TraceNotes: Collect Trace`      | `Option + C`       | `Alt + C`              | Capture the current selection as a trace point |
| `TraceNotes: Export to Markdown` | -                  | -                      | Export all traces to a new Markdown document   |
| `TraceNotes: Clear All Traces`   | -                  | -                      | Remove all collected traces                    |

## Development

### Prerequisites

- Node.js ≥ 18
- VS Code ≥ 1.85

### Setup

```bash
npm install
npm run build
```

### Run in Development

```bash
code --extensionDevelopmentPath=$(pwd)
```

Or press `F5` in VS Code to launch the Extension Development Host.

### Watch Mode

```bash
npm run watch
```

### Build VSIX

To package the extension into a `.vsix` file for installation:

```bash
npx @vscode/vsce package
```

## Project Structure

```
src/
├── extension.ts        # Entry point, commands, message routing
├── types.ts            # TracePoint interface & message types
├── traceManager.ts     # State manager with persistence
├── collector.ts        # Code selection + smart dedent
├── decoration.ts       # Jump-to-code + flash highlight
├── exporter.ts         # Markdown generator
├── webviewProvider.ts  # Sidebar webview provider
└── webview/
    ├── index.tsx               # React entry + styles
    ├── components/
    │   ├── Storyboard.tsx      # Drag-and-drop trace container
    │   └── TraceCard.tsx       # Individual trace card
    └── utils/
        └── messaging.ts        # Extension ↔ Webview helpers
```

## License

MIT
