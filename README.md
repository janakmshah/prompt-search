# prompt-search

> A local CLI for searching and reusing old GitHub Copilot CLI prompts.

`prompt-search` reads your local Copilot CLI history and provides fuzzy search, session metadata, an interactive terminal picker, and clipboard handoff for selected prompts.

It reads local files only. Your prompts never leave your machine.

## Why this exists

Long-running Copilot CLI workflows often contain prompts worth reusing: PR review instructions, branch choreography, debugging context, one-off agent prompts, and carefully worded constraints. Those prompts are useful later, but difficult to find once they are spread across sessions.

`prompt-search` indexes the local Copilot data you already have and makes old prompts searchable from any terminal.

## Features

| Feature | What it gives you |
| --- | --- |
| Typo-tolerant fuzzy search | Uses Fuse.js to find prompts from fragments, approximate wording, and common typos. |
| Match highlighting | Highlights matched text in bold and windows long prompt rows to minimize hidden text and blank space. |
| Session-aware results | See the session summary, branch, source, and relative age beside each match. |
| Interactive picker | Navigate results in a compact terminal UI with tabs and keyboard shortcuts. |
| Clipboard handoff | Press Enter to copy the selected prompt and print it for visibility. |
| Scriptable output | Use `--print` or `--json` for shell scripts, aliases, and automation. |
| Local-first privacy | Reads from `~/.copilot` and does not call any network service. |
| Small dependency footprint | Uses Fuse.js for matching, Node.js built-ins for the CLI, and the system `sqlite3` command for session data. |

## Demo

```text
Prompt Search:

 All    Sessions    History

Search: rubber duck
167 matches

  #     Prompt
> 1.    rubber duck to ensure we haven't...
        Session: Review iOS Pull Request  Type: Session  When: 2m ago
  2.    rubber duck the late 4 commits...
        Session: Review iOS Pull Request  Type: Session  When: 2h ago
  3.    Rubber duck these changes
        Session: Review Pull Request      Type: Session  When: 8h ago

/ search | Up/Down navigate | Tab switch tabs | Enter copy+print | Ctrl+P print | Esc cancel
```

## Requirements

| Requirement | Notes |
| --- | --- |
| Node.js 18 or newer | Required to run the CLI. |
| `sqlite3` | Used to read `~/.copilot/session-store.db`. Installed by default on many macOS setups. |
| npm dependencies | Run `npm install` after cloning to install Fuse.js. |
| Clipboard command | macOS uses `pbcopy`; Linux attempts `wl-copy`, `xclip`, then `xsel`. |
| Copilot CLI history | The tool searches `~/.copilot/session-store.db` and `~/.copilot/command-history-state.json`. |

## Installation

Clone the repository and link the command into your PATH:

```sh
git clone https://github.com/janakmshah/prompt-search.git
cd prompt-search
npm install
npm link
```

Then run it from anywhere:

```sh
prompt-search "spin up 4"
```

For local development without linking:

```sh
./bin/prompt-search.js "rubber duck"
```

## Quick start

Open the interactive picker:

```sh
prompt-search
```

Start with a query:

```sh
prompt-search "product action"
```

Print matches without the picker:

```sh
prompt-search --print "rubber duck"
```

Return structured JSON:

```sh
prompt-search --json --limit 5 "subagents"
```

Search a different Copilot data directory:

```sh
prompt-search --copilot-dir ~/backup/.copilot "merge conflicts"
```

## Matching examples

Search is intentionally forgiving. Use the words you remember, even if the phrase is incomplete or slightly wrong.

| Query | Can match | Why |
| --- | --- | --- |
| `rubber duck` | `rubber blob duck` | Query terms do not need to be adjacent. |
| `rupper duck` | `rubber duck` | Fuse.js handles common typos and near matches. |
| `pruduct acton` | `product action` | Multiple misspelled terms can still match. |
| `spin 4` | `spin up 4 review agents` | Short fragments can find longer prompts. |
| `interactively` | `interaction tests` | Closely related word forms can match when the edit distance is small. |

Exact phrase and full-token matches are still ranked higher than looser fuzzy matches when both are present.

## Interactive controls

| Key | Action |
| --- | --- |
| Type | Update the fuzzy search. |
| Backspace | Delete from the search. |
| Ctrl+U | Clear the search. |
| Up/Down or k/j | Move the selection. |
| Page Up/Page Down | Move faster through long result sets. |
| Home/End | Jump to the first or last visible result. |
| Tab | Switch between All, Sessions, and History. |
| Enter | Copy the selected prompt to the clipboard and print it. |
| Ctrl+P | Print the selected prompt without copying. |
| Esc or Ctrl+C | Cancel. |

## CLI reference

```text
prompt-search [options] [query]
```

| Option | Description |
| --- | --- |
| `--copilot-dir <path>` | Use a different Copilot data directory. Defaults to `~/.copilot`. |
| `--limit <n>`, `-n <n>` | Limit result count. Defaults to `200`. |
| `--tab <name>` | Choose the initial tab: `all`, `sessions`, or `history`. |
| `--print` | Print matching rows instead of opening the picker. |
| `--full` | Include the full prompt body with `--print`. |
| `--json` | Print matching rows as JSON. |
| `--no-copy` | Do not copy the selected prompt on Enter. |
| `--help`, `-h` | Show command help. |

## Data sources

`prompt-search` combines two local Copilot CLI data sources:

| Source | Purpose |
| --- | --- |
| `~/.copilot/session-store.db` | Session turns, session summaries, branches, repositories, working directories, and timestamps. |
| `~/.copilot/command-history-state.json` | Recent command history that may not yet be represented in the session store. |

Prompts are deduplicated by normalized prompt text. Session-store prompts are preferred when the same prompt appears in both sources because they include richer metadata.

## How ranking works

Search uses Fuse.js for typo-tolerant fuzzy matching, with a small amount of deterministic post-ranking:

1. Prompt text is weighted higher than session metadata.
2. Exact phrase matches in prompt text receive the strongest boost.
3. Prompts containing all query tokens are ranked above looser fuzzy matches.
4. Metadata matches can still surface relevant sessions when the prompt text is approximate.
5. Recent prompts receive a small tie-breaker boost.

The goal is predictable search, not aggressive semantic matching. The tool is best at finding prompts from remembered words, nearby spellings, and session metadata.

## Privacy and security

`prompt-search` is local-first by design:

| Guarantee | Detail |
| --- | --- |
| No network calls | The CLI does not fetch, upload, or sync prompt data. |
| No indexing service | Results are computed in-process each time you run the command. |
| No prompt copies on disk | The tool reads existing Copilot files and does not create a prompt cache. |
| Explicit clipboard behavior | Only the selected prompt is copied, and only when you press Enter unless `--no-copy` is used. |

Your Copilot history can contain sensitive information. Treat terminal output, JSON exports, shell history, and clipboard contents accordingly.

## Development

Install or link locally:

```sh
npm install
npm link
```

Run checks:

```sh
npm test
```

Run the syntax check only:

```sh
npm run check
```

Try a non-interactive search:

```sh
node ./bin/prompt-search.js --print --limit 3 "fast path"
```

## Project structure

```text
.
├── bin/
│   └── prompt-search.js   # CLI entrypoint and interactive picker
├── scripts/
│   └── smoke-test.js      # Search behavior smoke tests
├── package-lock.json      # Locked npm dependency graph
├── package.json           # npm metadata, bin mapping, scripts
├── README.md              # User and contributor documentation
└── LICENSE                # MIT license
```

## Troubleshooting

| Problem | Fix |
| --- | --- |
| `zsh: no such file or directory: ./bin/prompt-search.js` | Run that path from the repository root, or use `npm link` and run `prompt-search` from anywhere. |
| `No prompt history found` | Confirm Copilot CLI has created `~/.copilot/session-store.db` or pass `--copilot-dir <path>`. |
| `sqlite3` is missing | Install SQLite with your system package manager, for example `brew install sqlite`. |
| Clipboard copy does not work | Use `--no-copy`, or install a supported clipboard command for your platform. |
| Too many matches | Add more query terms, use `--tab sessions`, or lower `--limit`. |

## Contributing

Contributions should keep the tool fast, local, dependency-light, and predictable.

Before opening a change:

1. Run `npm test`.
2. Keep user prompt data private in examples, tests, issues, and screenshots.
3. Prefer small, focused pull requests.
4. Document any user-facing option or behavior change in this README.

## Roadmap

Ideas that would fit the project:

| Idea | Notes |
| --- | --- |
| Open selected session metadata | Print session ID, cwd, branch, and turn index in a copyable form. |
| Config file | Allow default tab, limit, and copy behavior to be configured. |
| Export selected prompt | Save a selected prompt to a user-provided file path. |

## License

MIT. See [LICENSE](./LICENSE).
