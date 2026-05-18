#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawnSync } = require('child_process');
const Fuse = require('fuse.js');

const DEFAULT_LIMIT = 200;
const PROMPT_WORDS_BEFORE_MATCH = 4;
const RESULT_ROW_HEIGHT = 2;
const TABS = ['all', 'sessions', 'history'];
const FUSE_OPTIONS = {
  includeMatches: true,
  includeScore: true,
  ignoreDiacritics: true,
  ignoreLocation: true,
  minMatchCharLength: 2,
  threshold: 0.45,
  keys: [
    { name: 'searchablePrompt', weight: 0.78 },
    { name: 'searchableSessionSummary', weight: 0.12 },
    { name: 'searchableBranch', weight: 0.05 },
    { name: 'searchableRepository', weight: 0.03 },
    { name: 'searchableCwd', weight: 0.02 }
  ]
};
const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  noBold: '\x1b[22m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  black: '\x1b[30m',
  bgCyan: '\x1b[46m',
  hideCursor: '\x1b[?25l',
  showCursor: '\x1b[?25h',
  clear: '\x1b[2J\x1b[H',
  clearLine: '\x1b[2K\r'
};

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    return;
  }

  const copilotDir = expandHome(args.copilotDir || path.join(os.homedir(), '.copilot'));
  const items = loadItems(copilotDir);

  if (items.length === 0) {
    console.error(`No prompt history found in ${copilotDir}`);
    process.exitCode = 1;
    return;
  }

  const query = args.query.join(' ').trim();
  const tab = TABS.includes(args.tab) ? args.tab : 'all';
  const limit = Number.isFinite(args.limit) && args.limit > 0 ? args.limit : DEFAULT_LIMIT;

  if (args.json) {
    const { results } = searchItems(items, query, tab, limit);
    process.stdout.write(`${JSON.stringify(results.map(toJson), null, 2)}\n`);
    return;
  }

  if (args.print || !process.stdin.isTTY || !process.stdout.isTTY) {
    printResults(items, { query, tab, limit, full: args.full });
    return;
  }

  runPicker(items, {
    query,
    tab,
    limit,
    copy: args.copy
  });
}

function parseArgs(argv) {
  const args = {
    copy: true,
    copilotDir: null,
    full: false,
    help: false,
    json: false,
    limit: DEFAULT_LIMIT,
    print: false,
    query: [],
    tab: 'all'
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--') {
      args.query.push(...argv.slice(i + 1));
      break;
    }

    if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--print') {
      args.print = true;
    } else if (arg === '--json') {
      args.json = true;
    } else if (arg === '--full') {
      args.full = true;
    } else if (arg === '--no-copy') {
      args.copy = false;
    } else if (arg === '--limit' || arg === '-n') {
      i += 1;
      args.limit = parsePositiveInt(argv[i], '--limit');
    } else if (arg.startsWith('--limit=')) {
      args.limit = parsePositiveInt(arg.slice('--limit='.length), '--limit');
    } else if (arg === '--copilot-dir') {
      i += 1;
      args.copilotDir = requireValue(argv[i], '--copilot-dir');
    } else if (arg.startsWith('--copilot-dir=')) {
      args.copilotDir = requireValue(arg.slice('--copilot-dir='.length), '--copilot-dir');
    } else if (arg === '--tab') {
      i += 1;
      args.tab = requireTab(argv[i]);
    } else if (arg.startsWith('--tab=')) {
      args.tab = requireTab(arg.slice('--tab='.length));
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      args.query.push(arg);
    }
  }

  return args;
}

function requireValue(value, option) {
  if (!value) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

function requireTab(value) {
  requireValue(value, '--tab');
  const normalized = value.toLowerCase();
  if (!TABS.includes(normalized)) {
    throw new Error(`--tab must be one of: ${TABS.join(', ')}`);
  }
  return normalized;
}

function parsePositiveInt(value, option) {
  requireValue(value, option);
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${option} must be a positive integer`);
  }
  return parsed;
}

function expandHome(inputPath) {
  if (inputPath === '~') {
    return os.homedir();
  }
  if (inputPath.startsWith('~/')) {
    return path.join(os.homedir(), inputPath.slice(2));
  }
  return inputPath;
}

function loadItems(copilotDir) {
  const seen = new Set();
  const items = [];

  for (const item of loadSessionStore(path.join(copilotDir, 'session-store.db'))) {
    const key = stablePromptKey(item.prompt);
    if (!seen.has(key)) {
      seen.add(key);
      items.push(item);
    }
  }

  for (const item of loadCommandHistory(path.join(copilotDir, 'command-history-state.json'))) {
    const key = stablePromptKey(item.prompt);
    if (!seen.has(key)) {
      seen.add(key);
      items.push(item);
    }
  }

  return items.sort((a, b) => sortTime(b) - sortTime(a));
}

function loadSessionStore(dbPath) {
  if (!fs.existsSync(dbPath)) {
    return [];
  }

  const sql = `
    select
      s.id as session_id,
      s.summary as session_summary,
      s.cwd as cwd,
      s.repository as repository,
      s.branch as branch,
      s.created_at as session_created_at,
      s.updated_at as session_updated_at,
      t.turn_index as turn_index,
      t.user_message as prompt,
      t.timestamp as timestamp
    from turns t
    join sessions s on s.id = t.session_id
    where t.user_message is not null and length(trim(t.user_message)) > 0
    order by t.timestamp desc
  `;

  const result = spawnSync('sqlite3', ['-json', dbPath, sql], {
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024
  });

  if (result.error && result.error.code === 'ENOENT') {
    return [];
  }

  if (result.status !== 0) {
    const message = (result.stderr || '').trim();
    throw new Error(message || `Failed to read ${dbPath}`);
  }

  const rows = JSON.parse(result.stdout || '[]');

  return rows.map((row, index) => ({
    id: `${row.session_id}:${row.turn_index}`,
    prompt: row.prompt,
    source: 'Session',
    sourceKind: 'sessions',
    sessionId: row.session_id,
    sessionSummary: row.session_summary || '(untitled session)',
    cwd: row.cwd || '',
    repository: row.repository || '',
    branch: row.branch || '',
    turnIndex: Number(row.turn_index),
    timestamp: row.timestamp || row.session_updated_at || row.session_created_at || '',
    sessionCreatedAt: row.session_created_at || '',
    rank: index
  }));
}

function loadCommandHistory(historyPath) {
  if (!fs.existsSync(historyPath)) {
    return [];
  }

  const raw = fs.readFileSync(historyPath, 'utf8');
  const parsed = JSON.parse(raw);
  const history = Array.isArray(parsed.commandHistory) ? parsed.commandHistory : [];

  return history
    .filter((prompt) => typeof prompt === 'string' && prompt.trim().length > 0)
    .map((prompt, index) => ({
      id: `history:${index}`,
      prompt,
      source: 'History',
      sourceKind: 'history',
      sessionId: '',
      sessionSummary: 'command-history-state.json',
      cwd: '',
      repository: '',
      branch: '',
      turnIndex: null,
      timestamp: '',
      sessionCreatedAt: '',
      rank: index
    }));
}

function stablePromptKey(prompt) {
  return normalizeText(prompt).replace(/\s+/g, ' ').trim();
}

function searchItems(items, query, tab, limit) {
  const filtered = items.filter((item) => tab === 'all' || item.sourceKind === tab);
  const normalizedQuery = normalizeText(query).trim();

  if (!normalizedQuery) {
    const recent = filtered.slice().sort((a, b) => sortTime(b) - sortTime(a));

    return {
      results: recent.slice(0, limit),
      total: recent.length
    };
  }

  const fuse = new Fuse(filtered.map(toSearchableItem), FUSE_OPTIONS);
  const ranked = fuse.search(query.trim())
    .map((result) => ({
      item: withMatchRanges(result.item, normalizedQuery),
      score: rankedFuseScore(result, normalizedQuery)
    }))
    .filter(({ item }) => item.hasReliableMatch)
    .sort((a, b) => {
      if (a.score !== b.score) {
        return a.score - b.score;
      }
      return sortTime(b.item) - sortTime(a.item);
    });

  return {
    results: ranked.slice(0, limit).map(({ item }) => item),
    total: ranked.length
  };
}

function toSearchableItem(item) {
  return {
    ...item,
    searchablePrompt: oneLine(item.prompt),
    searchableSessionSummary: oneLine(item.sessionSummary || item.sessionId || item.source),
    searchableBranch: oneLine(item.branch),
    searchableRepository: oneLine(item.repository),
    searchableCwd: oneLine(item.cwd)
  };
}

function withMatchRanges(item, normalizedQuery) {
  const allMatchRanges = [
    reliableRangesForText(item.searchablePrompt, normalizedQuery),
    reliableRangesForText(item.searchableSessionSummary, normalizedQuery),
    reliableRangesForText(item.searchableBranch, normalizedQuery),
    reliableRangesForText(item.searchableRepository, normalizedQuery),
    reliableRangesForText(item.searchableCwd, normalizedQuery)
  ];

  return {
    ...item,
    hasReliableMatch: allMatchRanges.some((ranges) => ranges.length > 0),
    matchRanges: {
      prompt: allMatchRanges[0],
      sessionSummary: allMatchRanges[1]
    }
  };
}

function reliableRangesForText(text, normalizedQuery) {
  const ranges = [];

  for (const token of queryTokens(normalizedQuery)) {
    const exactRanges = exactTokenRanges(text, token);
    if (exactRanges.length > 0) {
      ranges.push(...exactRanges);
      continue;
    }

    const approximateRange = approximateTokenRange(text, token);
    if (approximateRange) {
      ranges.push(approximateRange);
    }
  }

  return mergeRanges(ranges);
}

function queryTokens(normalizedQuery) {
  return normalizedQuery
    .split(/\s+/)
    .map((token) => token.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, ''))
    .filter(Boolean);
}

function exactTokenRanges(text, normalizedToken) {
  const normalizedText = normalizeText(text);
  const ranges = [];
  let cursor = normalizedText.indexOf(normalizedToken);

  while (cursor >= 0) {
    ranges.push([cursor, cursor + normalizedToken.length - 1]);
    cursor = normalizedText.indexOf(normalizedToken, cursor + normalizedToken.length);
  }

  return ranges;
}

function approximateTokenRange(text, normalizedToken) {
  if (normalizedToken.length < 3) {
    return null;
  }

  const maxDistance = maxTypoDistance(normalizedToken);
  let best = null;

  for (const word of wordRanges(text)) {
    const normalizedWord = normalizeText(word.value);
    if (!normalizedWord || Math.abs(normalizedWord.length - normalizedToken.length) > maxDistance) {
      continue;
    }

    const distance = levenshteinDistance(normalizedWord, normalizedToken, maxDistance);
    if (distance <= maxDistance && (!best || distance < best.distance)) {
      best = {
        distance,
        range: [word.start, word.end - 1]
      };
    }
  }

  return best ? best.range : null;
}

function maxTypoDistance(token) {
  return Math.max(1, Math.floor(token.length * 0.34));
}

function wordRanges(text) {
  const ranges = [];
  const matcher = /[A-Za-z0-9]+(?:['’][A-Za-z0-9]+)*/g;
  let match = matcher.exec(text);

  while (match) {
    ranges.push({
      value: match[0],
      start: match.index,
      end: match.index + match[0].length
    });
    match = matcher.exec(text);
  }

  return ranges;
}

function levenshteinDistance(left, right, maxDistance) {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    let rowMinimum = current[0];

    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitutionCost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      const distance = Math.min(
        previous[rightIndex] + 1,
        current[rightIndex - 1] + 1,
        previous[rightIndex - 1] + substitutionCost
      );
      current[rightIndex] = distance;
      rowMinimum = Math.min(rowMinimum, distance);
    }

    if (rowMinimum > maxDistance) {
      return maxDistance + 1;
    }

    previous = current;
  }

  return previous[right.length];
}

function mergeRanges(ranges) {
  if (!Array.isArray(ranges) || ranges.length === 0) {
    return [];
  }

  const sorted = ranges
    .filter((range) => Array.isArray(range) && range.length === 2)
    .map(([start, end]) => [Math.max(0, start), Math.max(0, end)])
    .sort((a, b) => a[0] - b[0]);

  const merged = [];
  for (const [start, end] of sorted) {
    const previous = merged[merged.length - 1];
    if (previous && start <= previous[1] + 1) {
      previous[1] = Math.max(previous[1], end);
    } else {
      merged.push([start, end]);
    }
  }

  return merged;
}

function rankedFuseScore(result, normalizedQuery) {
  const item = result.item;
  let score = typeof result.score === 'number' ? result.score : 1;
  const promptText = normalizeText(item.searchablePrompt);
  const metadataText = normalizeText([
    item.searchableSessionSummary,
    item.searchableBranch,
    item.searchableRepository,
    item.searchableCwd
  ].filter(Boolean).join(' '));
  const tokens = normalizedQuery.split(/\s+/).filter(Boolean);
  const promptTokenMatches = tokens.filter((token) => promptText.includes(token)).length;
  const metadataTokenMatches = tokens.filter((token) => metadataText.includes(token)).length;

  if (promptText.includes(normalizedQuery)) {
    score -= 0.5;
  }

  if (tokens.length > 0 && promptTokenMatches === tokens.length) {
    score -= 0.3;
  }

  score -= promptTokenMatches * 0.04;
  score -= metadataTokenMatches * 0.01;
  score -= recencyBoost(item) / 1000;
  return score;
}

function recencyBoost(item) {
  const time = sortTime(item);
  if (!time) {
    return 0;
  }

  const daysOld = Math.max(0, (Date.now() - time) / 86_400_000);
  return Math.max(0, 30 - daysOld);
}

function sortTime(item) {
  const parsed = item.timestamp ? Date.parse(item.timestamp) : Number.NaN;
  if (Number.isFinite(parsed)) {
    return parsed;
  }

  if (item.sourceKind === 'history') {
    return Date.now() - item.rank * 1000;
  }

  return 0;
}

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '');
}

function runPicker(items, options) {
  const state = {
    query: options.query || '',
    tab: options.tab || 'all',
    selected: 0,
    offset: 0,
    results: [],
    total: 0
  };

  let closed = false;

  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();

  const render = () => {
    if (closed) {
      return;
    }

    const matched = searchItems(items, state.query, state.tab, options.limit);
    state.results = matched.results;
    state.total = matched.total;

    if (state.selected >= state.results.length) {
      state.selected = Math.max(0, state.results.length - 1);
    }

    const rows = process.stdout.rows || 24;
    const cols = process.stdout.columns || 120;
    const headerLines = 8;
    const footerLines = 2;
    const visibleRows = Math.max(
      1,
      Math.floor((rows - headerLines - footerLines) / RESULT_ROW_HEIGHT)
    );

    if (state.selected < state.offset) {
      state.offset = state.selected;
    } else if (state.selected >= state.offset + visibleRows) {
      state.offset = state.selected - visibleRows + 1;
    }

    process.stdout.write(ANSI.hideCursor + ANSI.clear);
    process.stdout.write(`${ANSI.bold}Prompt Search:${ANSI.reset}\n\n`);
    process.stdout.write(renderTabs(state.tab));
    process.stdout.write('\n\n');
    process.stdout.write(`Search: ${state.query ? state.query : `${ANSI.dim}(type to search)${ANSI.reset}`}\n`);
    process.stdout.write(`${ANSI.dim}${state.total} match${state.total === 1 ? '' : 'es'}${state.total > state.results.length ? `, showing ${state.results.length}` : ''}${ANSI.reset}\n\n`);
    process.stdout.write(renderTableHeader(cols));

    if (state.results.length === 0) {
      process.stdout.write(`${ANSI.dim}  No matching prompts${ANSI.reset}\n`);
    } else {
      const visible = state.results.slice(state.offset, state.offset + visibleRows);
      visible.forEach((item, index) => {
        const absoluteIndex = state.offset + index;
        process.stdout.write(renderRow(item, absoluteIndex, absoluteIndex === state.selected, cols));
      });
    }

    process.stdout.write('\n');
    process.stdout.write(`${ANSI.dim}/ search | Up/Down navigate | Tab switch tabs | Enter copy+print | Ctrl+P print | Esc cancel${ANSI.reset}`);
  };

  const cleanup = () => {
    if (closed) {
      return;
    }
    closed = true;
    process.stdin.off('keypress', onKeypress);
    process.stdout.off('resize', render);
    process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write(ANSI.showCursor + ANSI.clear);
  };

  const choose = (item, shouldCopy) => {
    cleanup();

    if (!item) {
      process.stdout.write('No prompt selected\n');
      return;
    }

    const copied = shouldCopy && copyToClipboard(item.prompt);
    if (copied) {
      process.stdout.write(`${ANSI.bold}Copied prompt to clipboard.${ANSI.reset}\n`);
    } else if (shouldCopy) {
      process.stdout.write(`${ANSI.bold}Selected prompt:${ANSI.reset}\n`);
    }

    process.stdout.write(`${formatMetadata(item)}\n\n`);
    process.stdout.write(`${item.prompt.trim()}\n`);
  };

  function onKeypress(str, key) {
    if (key.ctrl && key.name === 'c') {
      cleanup();
      process.stdout.write('Cancelled\n');
      process.exit(130);
    }

    if (key.name === 'escape' || (str === 'q' && state.query.length === 0)) {
      cleanup();
      process.stdout.write('Cancelled\n');
      return;
    }

    if (key.name === 'return') {
      choose(state.results[state.selected], options.copy);
      return;
    }

    if (key.ctrl && key.name === 'p') {
      choose(state.results[state.selected], false);
      return;
    }

    if (key.name === 'tab') {
      const currentIndex = TABS.indexOf(state.tab);
      state.tab = TABS[(currentIndex + 1) % TABS.length];
      state.selected = 0;
      state.offset = 0;
      render();
      return;
    }

    if (key.name === 'up' || str === 'k') {
      state.selected = Math.max(0, state.selected - 1);
      render();
      return;
    }

    if (key.name === 'down' || str === 'j') {
      state.selected = Math.min(Math.max(0, state.results.length - 1), state.selected + 1);
      render();
      return;
    }

    if (key.name === 'pageup') {
      state.selected = Math.max(0, state.selected - 10);
      render();
      return;
    }

    if (key.name === 'pagedown') {
      state.selected = Math.min(Math.max(0, state.results.length - 1), state.selected + 10);
      render();
      return;
    }

    if (key.name === 'home') {
      state.selected = 0;
      render();
      return;
    }

    if (key.name === 'end') {
      state.selected = Math.max(0, state.results.length - 1);
      render();
      return;
    }

    if (key.name === 'backspace' || key.name === 'delete') {
      state.query = Array.from(state.query).slice(0, -1).join('');
      state.selected = 0;
      state.offset = 0;
      render();
      return;
    }

    if (key.ctrl && key.name === 'u') {
      state.query = '';
      state.selected = 0;
      state.offset = 0;
      render();
      return;
    }

    if (str && !key.ctrl && !key.meta && isPrintable(str)) {
      state.query += str;
      state.selected = 0;
      state.offset = 0;
      render();
    }
  }

  process.stdin.on('keypress', onKeypress);
  process.stdout.on('resize', render);
  render();
}

function renderTabs(activeTab) {
  return TABS.map((tab) => {
    const label = labelForTab(tab);
    if (tab === activeTab) {
      return `${ANSI.bgCyan}${ANSI.black} ${label} ${ANSI.reset}`;
    }
    return `${ANSI.dim} ${label} ${ANSI.reset}`;
  }).join('  ');
}

function labelForTab(tab) {
  if (tab === 'all') {
    return 'All';
  }
  if (tab === 'sessions') {
    return 'Sessions';
  }
  return 'History';
}

function renderTableHeader(cols) {
  const widths = tableWidths(cols);
  return `${ANSI.dim}  ${padEnd('#', widths.number)} ${padEnd('Prompt', widths.prompt)}${ANSI.reset}\n`;
}

function renderRow(item, index, selected, cols) {
  const widths = tableWidths(cols);
  const marker = selected ? '>' : ' ';
  const baseStyle = selected ? ANSI.cyan : ANSI.dim;
  const promptLine = [
    styledCell(marker, 1),
    styledCell(`${index + 1}.`, widths.number),
    highlightedCell(
      oneLine(item.prompt),
      item.matchRanges ? item.matchRanges.prompt : [],
      widths.prompt,
      baseStyle
    )
  ].join(' ');
  const metadataLine = renderMetadataLine(item, widths, baseStyle);

  return `${baseStyle}${promptLine}${ANSI.reset}\n${baseStyle}${metadataLine}${ANSI.reset}\n`;
}

function tableWidths(cols) {
  const number = 5;
  const indent = 1 + 1 + number + 1;
  const prompt = Math.max(20, cols - indent);
  return {
    indent,
    metadata: prompt,
    number,
    prompt,
  };
}

function renderMetadataLine(item, widths, baseStyle) {
  const session = oneLine(item.sessionSummary || item.sessionId || item.source);
  const type = `Type: ${item.source}`;
  const when = timeAgo(item.timestamp, item.rank);
  const whenText = when ? `When: ${when}` : '';
  const fixedWidth = visibleLength('Session: ') + visibleLength(type) + visibleLength(whenText) + 4;
  const sessionWidth = Math.max(10, widths.metadata - fixedWidth);
  const sessionText = highlightedCell(
    session,
    item.matchRanges ? item.matchRanges.sessionSummary : [],
    sessionWidth,
    baseStyle
  );
  const parts = [
    `Session: ${sessionText}`,
    type,
    whenText
  ].filter(Boolean);

  return `${' '.repeat(widths.indent)}${parts.join('  ')}`;
}

function padEnd(value, width) {
  const text = truncate(String(value || ''), width);
  return text + ' '.repeat(Math.max(0, width - visibleLength(text)));
}

function styledCell(value, width) {
  return padEnd(value, width);
}

function highlightedCell(value, ranges, width, baseStyle = '') {
  const snippet = snippetForHighlight(String(value || ''), ranges, width);
  const highlighted = applyHighlights(snippet.content, snippet.ranges, baseStyle);
  const padding = ' '.repeat(Math.max(0, width - visibleLength(snippet.text)));
  return `${highlighted}${snippet.ellipsis}${padding}`;
}

function snippetForHighlight(value, ranges, width) {
  if (visibleLength(value) <= width) {
    return {
      content: value,
      ellipsis: '',
      ranges,
      text: value
    };
  }

  if (width <= 3) {
    const content = value.slice(0, width);
    return {
      content,
      ellipsis: '',
      ranges: clipRanges(ranges, 0, content.length, 0),
      text: content
    };
  }

  const firstMatchStart = ranges.length > 0 ? ranges[0][0] : null;
  const snippetStart = firstMatchStart === null
    ? 0
    : startAroundMatch(value, firstMatchStart, PROMPT_WORDS_BEFORE_MATCH);
  const prefix = snippetStart > 0 ? '... ' : '';
  const availableWidth = Math.max(0, width - visibleLength(prefix) - 3);
  const body = value.slice(snippetStart, snippetStart + availableWidth);
  const content = `${prefix}${body}`;
  const ellipsis = snippetStart + body.length < value.length ? '...' : '';

  return {
    content,
    ellipsis,
    ranges: clipRanges(ranges, snippetStart, snippetStart + body.length, visibleLength(prefix)),
    text: `${content}${ellipsis}`
  };
}

function startAroundMatch(value, matchStart, wordsBefore) {
  const words = wordRanges(value);
  const matchWordIndex = words.findIndex((word) => matchStart >= word.start && matchStart < word.end);

  if (matchWordIndex < 0 || matchWordIndex <= wordsBefore) {
    return 0;
  }

  return words[matchWordIndex - wordsBefore].start;
}

function clipRanges(ranges, start, end, offset) {
  return ranges
    .map(([rangeStart, rangeEnd]) => [
      Math.max(rangeStart, start) - start + offset,
      Math.min(rangeEnd + 1, end) - start + offset - 1
    ])
    .filter(([rangeStart, rangeEnd]) => rangeStart <= rangeEnd);
}

function applyHighlights(value, ranges, baseStyle) {
  const clipped = ranges
    .map(([start, end]) => [Math.max(0, start), Math.min(value.length - 1, end)])
    .filter(([start, end]) => start <= end);

  if (clipped.length === 0) {
    return value;
  }

  let cursor = 0;
  let output = '';

  for (const [start, end] of clipped) {
    if (cursor < start) {
      output += value.slice(cursor, start);
    }

    output += `${ANSI.bold}${value.slice(start, end + 1)}${ANSI.noBold}${baseStyle}`;
    cursor = end + 1;
  }

  return output + value.slice(cursor);
}

function truncate(value, width) {
  const chars = Array.from(value);
  if (chars.length <= width) {
    return value;
  }
  if (width <= 3) {
    return chars.slice(0, width).join('');
  }
  return `${chars.slice(0, width - 3).join('')}...`;
}

function visibleLength(value) {
  return Array.from(value).length;
}

function oneLine(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function isPrintable(value) {
  return value.length > 0 && !/[\x00-\x1F\x7F]/.test(value);
}

function copyToClipboard(text) {
  const command = process.platform === 'darwin' ? 'pbcopy' : findClipboardCommand();
  if (!command) {
    return false;
  }

  const result = spawnSync(command, [], {
    input: text,
    encoding: 'utf8'
  });

  return result.status === 0;
}

function findClipboardCommand() {
  for (const command of ['wl-copy', 'xclip', 'xsel']) {
    const result = spawnSync('which', [command], { encoding: 'utf8' });
    if (result.status === 0) {
      return command;
    }
  }
  return null;
}

function printResults(items, options) {
  const { results, total } = searchItems(items, options.query, options.tab, options.limit);

  if (results.length === 0) {
    console.log('No matching prompts found.');
    return;
  }

  for (const [index, item] of results.entries()) {
    console.log(`${index + 1}. ${oneLine(item.prompt)}`);
    console.log(`   ${formatMetadata(item)}`);

    if (options.full) {
      console.log('');
      console.log(item.prompt.trim());
    }
  }

  if (total > results.length) {
    console.log(`\nShowing ${results.length} of ${total} matches. Increase --limit to see more.`);
  }
}

function formatMetadata(item) {
  const parts = [
    item.source,
    item.sessionSummary,
    item.branch ? `branch ${item.branch}` : '',
    item.timestamp ? timeAgo(item.timestamp, item.rank) : ''
  ].filter(Boolean);

  return parts.join(' | ');
}

function timeAgo(timestamp, historyRank) {
  if (!timestamp) {
    return historyRank === 0 ? 'recent' : '';
  }

  const time = Date.parse(timestamp);
  if (!Number.isFinite(time)) {
    return '';
  }

  const seconds = Math.max(0, Math.floor((Date.now() - time) / 1000));
  if (seconds < 60) {
    return `${seconds}s ago`;
  }

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 48) {
    return `${hours}h ago`;
  }

  const days = Math.floor(hours / 24);
  if (days < 60) {
    return `${days}d ago`;
  }

  const months = Math.floor(days / 30);
  if (months < 24) {
    return `${months}mo ago`;
  }

  return `${Math.floor(months / 12)}y ago`;
}

function toJson(item) {
  return {
    id: item.id,
    prompt: item.prompt,
    source: item.source,
    sessionId: item.sessionId,
    sessionSummary: item.sessionSummary,
    branch: item.branch,
    cwd: item.cwd,
    repository: item.repository,
    turnIndex: item.turnIndex,
    timestamp: item.timestamp
  };
}

function printHelp() {
  console.log(`prompt-search

Fuzzy search local GitHub Copilot CLI prompt history.

Usage:
  prompt-search [options] [query]

Options:
  --copilot-dir <path>  Copilot data directory, default ~/.copilot
  --limit, -n <count>   Maximum results, default ${DEFAULT_LIMIT}
  --tab <name>          all, sessions, or history
  --print               Print matching rows instead of opening the picker
  --full                Include full prompt text with --print
  --json                Print matching rows as JSON
  --no-copy             Do not copy selection to the clipboard
  --help, -h            Show this help
`);
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
