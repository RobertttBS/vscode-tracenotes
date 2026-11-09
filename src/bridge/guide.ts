// Shared by the CLI's `help` and the agent skill written by "Set Up AI Agents".
export const GUIDE = `Commands (run from inside the project folder; output is JSON)
  list                                  Trees: [{id, name, active}].
  show [--tree <id|name>] [--id <traceId>] [--outline]
                                        A tree (default: the active tree) with the trace ids
                                        used below, or just one trace and its children (--id).
                                        --outline prints one line per trace: id, [Tag], title.
  find [<query>] [--file <path>[:<line>[-<line>]]] [--tag <tag>] [--tree <id|name>] [--outline]
                                        Search every tree (or --tree) without switching trees.
                                        <query>: the panel's search, over title, note and code,
                                        case-insensitive: words (all must appear, any order),
                                        "exact phrase", OR, NOT or -word, ( ). Quote it as one
                                        argument. If it starts with "-", put the flags first,
                                        then --, then the query (all after -- is query):
                                        find --tag Todo -- '-legacy "password hash" (bcrypt OR argon2)'
                                        --file: traces anchored in that file (with lines: only
                                        those overlapping them), or anywhere under a folder.
                                        --tag: traces with that colour tag, e.g. Todo.
                                        Combine freely; at least one is needed. Each match:
                                        tree, parent id, id, title, location, and "match"
                                        (the line holding the most search words).
  create --name <name>                  Create a tree from Markdown on stdin (or --input
                                        <file>); it becomes active.
  add [--tree <id|name>] [--parent <id> | --after <id> | --before <id>] [--dry-run]
                                        Add traces from Markdown on stdin (or --input <file>):
                                        under --parent, next
                                        to a sibling, or at the end of the tree's root.
                                        --dry-run parses and reads the code but adds nothing.
  note <id> [text]                      Replace a trace's whole note, title included
                                        (argument, stdin, or --input <file>).
  title <id> <text>                     Replace only a trace's title (the note's first line).
  move <id> (--parent <id> | --after <id> | --before <id> | --root)
                                        Move a trace and its children within its tree.
  rm <id> [<id> …]                      Remove traces and their children.
  check [--tree <id|name>]              List traces whose code no longer matches the file.
  refresh <id> [<id> …] [--lines <start>:<end>]
                                        Re-read a trace's code from its current lines (the
                                        closest match \`check\` reports), or from --lines
                                        (single id only); the note is kept.
  rename [--tree <id|name>] <new name>  Rename a tree (default: the active tree).
  delete-tree --tree <id|name>          Delete a whole tree. Only for trees you created or
                                        the user asked you to delete.
  color [list]                          The panel's colours: key, what it paints, default (a
                                        hex colour or the VS Code theme colour it follows)
                                        and any overrides, plus the active theme.
  color set <key> <#colour> [<key> <#colour> …] [--scope user|workspace] [--theme <name>]
                                        Override colours (hex: #rgb, #rgba, #rrggbb,
                                        #rrggbbaa; quote it, or drop the "#"). Writes
                                        workbench.colorCustomizations, default --scope user;
                                        --theme limits it to that colour theme. Applies at once.
  color reset [<key> …] [--scope user|workspace] [--theme <name>]
                                        Remove overrides (all TraceNotes ones if no key).
                                        Only change colours when the user asks.
create/add reply with only ids, titles, tags, locations and "code" (the first line
read at those lines: compare it with what you meant, to catch off-by-one line
numbers); use \`show\` for the notes. "workspace" is the root that relative paths
resolved against.
Add --quiet (-q) to create/add to get just a count (plus the tree id/name for create)
and any warnings, for big trees.
A "warnings" list (always first in the reply) flags traces whose code no longer
matches the file (stale or miscopied) or could not be anchored; fix them with refresh.

Markdown format (the same as TraceNotes "Export to Markdown")
  - Each trace is a heading "<title>". A leading "<n>. " (as exports write it,
    0 included) is dropped, since the panel numbers cards itself; \`note\` and
    \`title\` drop it from the first line too. Heading level = depth + 2:
    ## root, ### child, #### grandchild … (at most 10 levels).
  - Optional colour tag at the start of the title (before or after the number):
    %%Important%% %%Faq%% %%Note%%
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
  - Windows PowerShell has no heredoc and re-encodes piped text (non-ASCII becomes
    "?"). There, write the Markdown to a UTF-8 file with your file-writing tool
    (not Set-Content/Out-File) and pass it: tracenotes create --name "X" --input tree.md
    Delete the file afterwards.
    Output piped on Windows (JSON, --outline, errors) writes non-ASCII as \\uXXXX;
    read it as-is (JSON stays valid).
  - Get line numbers from the file right before create/add (or use "?:?"), then
    check the reply's warnings and each trace's "code" line.
  - After the code changes, fix an existing tree instead of rebuilding it:
    check → refresh <ids> (add --lines if the range moved) → note <id> if needed → check.
    \`check\` only catches code that no longer matches; to find notes a change made
    wrong, run \`find --file <path>:<start>-<end>\` for each \`git diff\` hunk.
  - To find a card by topic, use \`find <text>\` instead of reading whole trees.
  - To explain a change, read \`git diff\` first and pick the hunks worth a card.
  - Write titles and notes in the user's language; keep notes to about 3 lines.
  - For explaining a change or feature, a good shape is: background → entry
    points and registration → main flow → key algorithms → docs/config changes.
`;
