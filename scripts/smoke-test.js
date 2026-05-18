#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-search-'));

try {
  fs.writeFileSync(
    path.join(fixtureDir, 'command-history-state.json'),
    JSON.stringify({
      commandHistory: [
        'rubber duck debugging prompt',
        'product action branch flow',
        'spin up 4 review agents',
        'ask me interactively before choosing',
        'add interaction tests',
        'objectively better original approach'
      ]
    })
  );

  assertSearch('rupper duck', 'rubber duck debugging prompt');
  assertSearch('pruduct acton', 'product action branch flow');
  assertSearch('spin 4', 'spin up 4 review agents');
  assertSearch('interactively', 'add interaction tests');
  assertNoSearch('interactively', 'objectively better original approach');
} finally {
  fs.rmSync(fixtureDir, { recursive: true, force: true });
}

function assertSearch(query, expected) {
  const output = search(query, '10');

  if (!output.includes(expected)) {
    throw new Error(`Expected "${query}" to find "${expected}". Output:\n${output}`);
  }
}

function assertNoSearch(query, unexpected) {
  const output = search(query, '10');

  if (output.includes(unexpected)) {
    throw new Error(`Expected "${query}" not to find "${unexpected}". Output:\n${output}`);
  }
}

function search(query, limit) {
  const result = spawnSync(process.execPath, [
    path.join(root, 'bin/prompt-search.js'),
    '--copilot-dir',
    fixtureDir,
    '--print',
    '--limit',
    limit,
    query
  ], {
    encoding: 'utf8'
  });

  if (result.status !== 0) {
    throw new Error(`Search failed for "${query}": ${result.stderr || result.stdout}`);
  }

  return result.stdout;
}
