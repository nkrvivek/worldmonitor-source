import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import YAML from 'yaml';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workflowSource = readFileSync(
  resolve(repoRoot, '.github/workflows/seed-freshness-monitor.yml'),
  'utf8',
);
const workflow = YAML.parse(workflowSource);
const monitorSteps = workflow.jobs.monitor.steps;

function stepNamed(name) {
  const step = monitorSteps.find((candidate) => candidate.name === name);
  assert.ok(step, `seed freshness workflow must define "${name}"`);
  return step;
}

function scheduledGateStep() {
  const step = monitorSteps.find((candidate) => candidate.id === 'gate');
  assert.ok(step, 'seed freshness workflow must define its scheduled gate step');
  return step;
}

function runScheduledGate(gateState) {
  const tempDir = mkdtempSync(join(repoRoot, '.tmp-seed-freshness-gate-'));
  const fakeBin = join(tempDir, 'bin');
  const fakeGh = join(fakeBin, 'gh');
  const nonGateStatuses = Array.from({ length: 100 }, (_, index) => ({
    context: `railway-${index}`,
    state: 'success',
    updated_at: '2026-07-29T12:00:00Z',
  }));
  const gateStatuses = gateState === 'missing'
    ? []
    : [
        {
          context: 'gate',
          state: gateState,
          updated_at: '2026-07-29T12:01:00Z',
        },
        {
          context: 'gate',
          state: gateState === 'success' ? 'failure' : 'success',
          updated_at: '2026-07-29T12:01:00Z',
        },
      ];

  try {
    // Put the latest `gate` status on a second API page followed by an older
    // status with the same second-resolution timestamp. GitHub returns status
    // history newest-first, so this proves the workflow neither truncates the
    // response nor reorders equal timestamps into stale state.
    mkdirSync(fakeBin);
    writeFileSync(
      fakeGh,
      [
        '#!/bin/sh',
        'case " $* " in *" --paginate "*) ;; *) exit 91 ;; esac',
        'case " $* " in *" --slurp "*) ;; *) exit 92 ;; esac',
        'case "$*" in *"/statuses?per_page=100"*) ;; *) exit 93 ;; esac',
        'printf \'%s\\n\' "$FAKE_STATUS_PAGES"',
        '',
      ].join('\n'),
    );
    chmodSync(fakeGh, 0o755);

    return spawnSync(
      'bash',
      ['-e', '-c', scheduledGateStep().run],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          FAKE_STATUS_PAGES: JSON.stringify([nonGateStatuses, gateStatuses]),
          GH_TOKEN: 'test-token',
          GITHUB_REPOSITORY: 'koala73/worldmonitor',
          GITHUB_SHA: '0123456789abcdef',
          PATH: `${fakeBin}:${process.env.PATH}`,
        },
      },
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

describe('seed freshness workflow control plane', () => {
  it('fails closed unless the exact checked-out main SHA has a successful gate', () => {
    const success = runScheduledGate('success');
    assert.equal(success.status, 0, success.stderr);

    for (const state of ['missing', 'pending', 'failure', 'error']) {
      const result = runScheduledGate(state);
      assert.notEqual(
        result.status,
        0,
        `${state} must fail the workflow instead of producing a green skipped acceptance`,
      );
      assert.match(
        `${result.stdout}\n${result.stderr}`,
        new RegExp(`main gate is ${state}`),
      );
    }

    const gate = scheduledGateStep();
    assert.equal(gate.if, "github.event_name == 'schedule'");
    assert.equal(gate['continue-on-error'], undefined);
    assert.equal(workflow.jobs.monitor['continue-on-error'], undefined);
    assert.doesNotMatch(gate.run, /should_run|Skipping seed freshness/);
    assert.match(gate.run, /gh api --paginate --slurp/);
    assert.match(gate.run, /statuses\?per_page=100/);
    assert.match(gate.run, /map\(select\(\.context == "gate"\)\) \| first/);
    assert.doesNotMatch(gate.run, /sort_by\(\.updated_at\)/);
    const acceptance = stepNamed('Check ingestion operational acceptance');
    assert.equal(
      acceptance.if,
      undefined,
      'default success() semantics must keep acceptance behind the fail-closed gate',
    );
    assert.equal(acceptance['continue-on-error'], undefined);
  });

  it('runs acceptance from the main-only environment on a pinned checkout', () => {
    assert.deepEqual(
      workflow.jobs.monitor.environment,
      {
        name: 'ingestion-acceptance-production',
        deployment: false,
      },
      'production credentials must come from the main-only ingestion acceptance environment',
    );

    const checkout = monitorSteps.find(
      (step) => typeof step.uses === 'string' && step.uses.startsWith('actions/checkout@'),
    );
    assert.ok(checkout, 'workflow must check out the audited revision');
    assert.equal(
      checkout.uses,
      'actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10',
      'credential-bearing workflows must pin checkout to the repository-standard immutable SHA',
    );

    const gateIndex = monitorSteps.findIndex((step) => step.id === 'gate');
    const healthIndex = monitorSteps.findIndex(
      (step) => step.name === 'Check ingestion operational acceptance',
    );
    assert.ok(gateIndex >= 0 && gateIndex < healthIndex, 'the gate must run before health');
  });

  it('keeps Railway out of the job', () => {
    // This fork runs the seeds as Cloudflare cron triggers. A Railway step here
    // would fail on a project that does not exist. The header comment still
    // names Railway to say why the job is off, so this checks what the job
    // runs, not what it says.
    for (const step of monitorSteps) {
      assert.doesNotMatch(step.run || '', /\brailway\b/i, `${step.name} must not call Railway`);
      assert.deepEqual(
        Object.keys(step.env || {}).filter((name) => name.startsWith('RAILWAY_')),
        [],
        `${step.name} must not take a Railway credential`,
      );
    }
  });
});
