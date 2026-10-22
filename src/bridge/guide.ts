// Shared by the CLI's `help` and the agent skill written by "Set Up AI Agents".
export const GUIDE = `Commands (run from inside the project folder; output is JSON)
  list                                  Trees: [{id, name, active}].
  show [--tree <id|name>] [--outline]   A tree (default: the active tree) with the trace ids
                                        used below. --outline prints one line per trace.
  create --name <name>                  Create a tree from Markdown on stdin; it becomes active.
  add [--tree <id|name>] [--parent <id> | --after <id> | --before <id>]
                                        Add traces from Markdown on stdin: under --parent, next
                                        to a sibling, or at the end of the tree's root.
  note <id> [text]                      Replace a trace's note (argument, or stdin).
  rm <id> [<id> …]                      Remove traces and their children.
  check [--tree <id|name>]              List traces whose code no longer matches the file.
  refresh <id> [<id> …] [--lines <start>:<end>]
                                        Re-read a trace's code from its current lines (or
                                        --lines, single id only); the note is kept.
  rename [--tree <id|name>] <new name>  Rename a tree (default: the active tree).
  delete-tree --tree <id|name>          Delete a whole tree. Only for trees you created or
                                        the user asked you to delete.
create/add reply with only ids, titles and locations; use \`show\` for the notes.
Add --quiet (-q) to create/add to get just a count (plus the tree id/name for create)
and any warnings, for big trees.
A "warnings" list (always first in the reply) flags traces whose code no longer
matches the file (stale or miscopied) or could not be anchored; fix them with refresh.

Markdown format (the same as TraceNotes "Export to Markdown")
  - Each trace is a heading "<title>" ("<n>. <title>" as exports write it also
    works). Heading level = depth + 2:
    ## root, ### child, #### grandchild … (at most 10 levels).
  - Optional colour tag right after the number: %%Important%% %%Faq%% %%Note%%
    %%Tip%% %%Remark%% %%Info%% %%Warning%% %%Todo%%
  - The heading is the card title. Put more note lines directly under it; they
    follow the title. (A "<!-- tracenote -->" … "<!-- /tracenote -->" block
    replaces the whole note, title included, so avoid it unless you need blank
    lines inside a note — then make the title its first line.)
  - Code: a fenced block whose info line is "<lang> <startLine>:<endLine>:<path>"
    (1-based lines; path relative to the workspace root, or absolute; lang is a
    common name such as ts, tsx, python, c, c++, go, css, md). Two ways:
      - Lines known: leave the block empty; TraceNotes reads those lines.
      - Lines unknown: write "?:?" for the lines and paste the code into the block;
        TraceNotes finds it in the file. Costs more tokens, but no line counting.
  - Notes are Markdown (GitHub style): **bold**, \`code\`, nested bullets, tables
    and links all render in the panel.
  - One code block per trace, after its note lines; nothing may follow it before
    the next heading. Need more code? Put it in a child trace.
  - A heading without a code block is a plain note card (useful for grouping).

Example
  ## 1. %%Important%% POST /login entry point
  \`\`\`ts 12:30:src/routes/auth.ts
  \`\`\`
  ### 1. Checks the password hash
  bcrypt; the cost factor comes from config.
  \`\`\`ts 40:40:src/services/auth.ts
  \`\`\`

Workflow
  - Pipe Markdown with a heredoc: tracenotes create --name "X" <<'EOF' … EOF
    (no temp files).
  - Get line numbers from the file right before create/add (or use "?:?"), then
    check the reply's warnings.
  - After the code changes, fix an existing tree instead of rebuilding it:
    check → refresh <ids> (add --lines if the range moved) → note <id> if needed → check.
  - To explain a change, read \`git diff\` first and pick the hunks worth a card.
  - Write titles and notes in the user's language; keep notes to about 3 lines.
  - For explaining a change or feature, a good shape is: background → entry
    points and registration → main flow → key algorithms → docs/config changes.
`;
