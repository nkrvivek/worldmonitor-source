// One Groq model id for the whole repo, and a test that says so.
//
// Groq decommissioned `llama-3.3-70b-versatile` and `llama-3.1-8b-instant`.
// Measured 2026-08-24: GET https://api.groq.com/openai/v1/models returned 13
// ids and neither was among them. The key was valid the whole time, so every
// groq fallback in this repo had been answering HTTP 404 for weeks while the
// provider chain fell through to its next entry and logged nothing a reader
// would connect to a dead model. Six production files and fifteen test files
// carried the id as a literal, which is why nobody changed it in one place.
//
// The rule this locks: a file that calls api.groq.com names its model through
// GROQ_FALLBACK_MODEL. Two CommonJS files cannot import an ESM constant at
// module scope, so they keep a literal and this test pins it equal instead.
//
// The constant itself lives in two files, once per packaging boundary. The
// Railway nixpacks build ships `scripts/` alone as `/app/`, so a seed entry
// point that imported `../shared/groq-model.js` would die on
// ERR_MODULE_NOT_FOUND in the container (#3811). `scripts/lib/groq-model.mjs`
// serves the scripts side, `shared/groq-model.js` serves everything else, and
// the first case below asserts the two agree.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { GROQ_EXTRA_BODY, GROQ_FALLBACK_MODEL } from '../shared/groq-model.js';
import {
  GROQ_EXTRA_BODY as SCRIPTS_GROQ_EXTRA_BODY,
  GROQ_FALLBACK_MODEL as SCRIPTS_GROQ_FALLBACK_MODEL,
} from '../scripts/lib/groq-model.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SEARCH_DIRS = ['scripts', 'server', 'shared', 'worker', 'api', 'src', 'convex'];
const CODE_EXTS = ['.mjs', '.cjs', '.js', '.ts', '.mts', '.tsx'];
const GROQ_URL = 'api.groq.com';

// How far past an api.groq.com line a `model:` field still belongs to the same
// provider entry. Every entry in this repo writes the two within a few lines.
const ENTRY_WINDOW = 600;

// Files that name api.groq.com but declare no model, with the reason. A file
// that lands here by accident is reported, not skipped.
const NO_MODEL_DECLARED = {
  'server/_shared/llm-health.ts':
    'health probe; it lists provider URLs and takes the model as an argument',
  'shared/groq-model.js': 'this is the single source',
  'scripts/lib/groq-model.mjs': 'the scripts-side copy of the single source',
};

// CommonJS callers: shared/groq-model.js is ESM and cannot be required at
// module scope, so the literal stays and this test holds it to the constant.
const COMMONJS_LITERALS = ['scripts/ais-relay.cjs', 'scripts/lib/llm-chain.cjs'];

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if (CODE_EXTS.some((ext) => entry.endsWith(ext)) && !entry.includes('.test.')) {
      out.push(full);
    }
  }
  return out;
}

function groqCallers() {
  const files = [];
  for (const dir of SEARCH_DIRS) {
    for (const full of walk(join(repoRoot, dir))) {
      if (readFileSync(full, 'utf8').includes(GROQ_URL)) {
        files.push(relative(repoRoot, full));
      }
    }
  }
  return files.sort();
}

/** Every `model:` value written within one provider entry of an api.groq.com URL. */
function groqModelValues(source) {
  const values = [];
  let from = 0;
  for (;;) {
    const at = source.indexOf(GROQ_URL, from);
    if (at === -1) break;
    from = at + GROQ_URL.length;
    const window = source.slice(at, at + ENTRY_WINDOW);
    const match = window.match(/model:\s*(?:'([^']+)'|"([^"]+)"|([^,\n]*GROQ_FALLBACK_MODEL))/);
    if (!match) continue;
    values.push(match[3] ? 'GROQ_FALLBACK_MODEL' : (match[1] ?? match[2]));
  }
  return values;
}

describe('groq model single source', () => {
  it('keeps the two packaging-boundary copies of the constant equal', () => {
    // scripts/ ships alone under nixpacks, so it cannot import shared/. The
    // duplication is forced; the drift is not.
    assert.equal(SCRIPTS_GROQ_FALLBACK_MODEL, GROQ_FALLBACK_MODEL);
    assert.deepEqual({ ...SCRIPTS_GROQ_EXTRA_BODY }, { ...GROQ_EXTRA_BODY });
    assert.equal(Object.isFrozen(SCRIPTS_GROQ_EXTRA_BODY), true);
  });

  it('routes every groq caller through GROQ_FALLBACK_MODEL', () => {
    // Arrange
    const files = groqCallers().filter((f) => !(f in NO_MODEL_DECLARED));

    // Act — a literal is allowed only in the two CommonJS files, and only
    // when it still equals the constant.
    const wrong = [];
    for (const file of files) {
      const values = groqModelValues(readFileSync(join(repoRoot, file), 'utf8'));
      if (values.length === 0) {
        wrong.push(`${file}: calls groq but declares no model`);
        continue;
      }
      for (const value of values) {
        if (value === 'GROQ_FALLBACK_MODEL') continue;
        if (COMMONJS_LITERALS.includes(file) && value === GROQ_FALLBACK_MODEL) continue;
        wrong.push(`${file}: ${value}`);
      }
    }

    // Assert
    assert.deepEqual(wrong, []);
  });

  it('sends the reasoning effort the small-token callers need', () => {
    // gpt-oss-120b puts its chain of thought in a separate field but still
    // spends the token budget on it. Measured at default effort with
    // max_tokens 50: empty content. Several callers here run at maxTokens 300.
    assert.equal(GROQ_EXTRA_BODY.reasoning_effort, 'low');
    assert.equal(Object.isFrozen(GROQ_EXTRA_BODY), true);
  });

  it('leaves no decommissioned Groq id anywhere in the tree', () => {
    // Arrange
    const dead = ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768'];

    // Act
    const hits = [];
    for (const dir of SEARCH_DIRS) {
      for (const full of walk(join(repoRoot, dir))) {
        const rel = relative(repoRoot, full);
        // Both copies name the dead ids in their own history notes.
        if (rel === 'shared/groq-model.js' || rel === 'scripts/lib/groq-model.mjs') continue;
        const source = readFileSync(full, 'utf8');
        for (const id of dead) {
          // Ollama serves its own llama builds; only Groq ids are dead here.
          if (source.includes(`'${id}'`) || source.includes(`"${id}"`)) hits.push(`${rel}: ${id}`);
        }
      }
    }

    // Assert
    assert.deepEqual(hits, []);
  });
});
