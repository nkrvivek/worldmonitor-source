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

function acceptanceStep() {
  return stepNamed('Record ingestion operational acceptance');
}

function runAcceptance({ eventName, gateState, gateDetail = 'two checks failed' }) {
  return spawnSync('bash', ['-e', '-c', acceptanceStep().run], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      GATE_DETAIL: gateDetail,
      GATE_STATE: gateState,
      GITHUB_EVENT_NAME: eventName,
      GITHUB_SHA: '0123456789abcdef',
    },
  });
}

function runScheduledGate(gateState) {
  const tempDir = mkdtempSync(join(repoRoot, '.tmp-seed-freshness-gate-'));
  const fakeBin = join(tempDir, 'bin');
  const fakeGh = join(fakeBin, 'gh');
  const outputFile = join(tempDir, 'github-output');
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
    writeFileSync(outputFile, '');

    const result = spawnSync(
      'bash',
      ['-e', '-c', scheduledGateStep().run],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          FAKE_STATUS_PAGES: JSON.stringify([nonGateStatuses, gateStatuses]),
          GH_TOKEN: 'test-token',
          GITHUB_OUTPUT: outputFile,
          GITHUB_REPOSITORY: 'koala73/worldmonitor',
          GITHUB_SHA: '0123456789abcdef',
          PATH: `${fakeBin}:${process.env.PATH}`,
        },
      },
    );

    return { ...result, outputs: readFileSync(outputFile, 'utf8') };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

describe('seed freshness workflow control plane', () => {
  it('reads the gate without deciding whether the measurement may run', () => {
    // The gate step must exit 0 on every state it can read. It reports what it
    // found and hands that on; the acceptance step below is what refuses. This
    // is the fix for the day the monitor spent failing at this step without
    // ever reading a seed, and it is the only reason to have two steps.
    for (const state of ['success', 'missing', 'pending', 'failure', 'error']) {
      const result = runScheduledGate(state);
      assert.equal(
        result.status,
        0,
        `${state} must still let the freshness measurement run: ${result.stderr}`,
      );
      assert.match(result.outputs, new RegExp(`^state=${state}$`, 'm'));
    }

    for (const state of ['missing', 'pending', 'failure', 'error']) {
      const result = runScheduledGate(state);
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

    const measurement = stepNamed('Measure ingestion freshness');
    assert.equal(
      measurement.if,
      undefined,
      'the measurement must not be conditioned on the gate, or a lint failure stops us looking at production',
    );
    assert.equal(measurement['continue-on-error'], undefined);
  });

  it('fails closed unless the exact checked-out main SHA has a successful gate', () => {
    // Failing, not skipping. A skipped step leaves the run green, and green
    // here reads as "ingestion is fresh on a revision we accept". The gate
    // above is allowed to be permissive precisely because this one is not.
    const acceptance = acceptanceStep();
    assert.equal(
      acceptance.if,
      undefined,
      'a skipped acceptance step is a green run that recorded no acceptance',
    );
    assert.equal(acceptance['continue-on-error'], undefined);

    assert.equal(runAcceptance({ eventName: 'schedule', gateState: 'success' }).status, 0);
    assert.equal(
      runAcceptance({ eventName: 'workflow_dispatch', gateState: '' }).status,
      0,
      'a manual run has no gate to read and must not be blocked by its absence',
    );

    for (const state of ['', 'pending', 'failure', 'error']) {
      const result = runAcceptance({ eventName: 'schedule', gateState: state });
      assert.notEqual(
        result.status,
        0,
        `${state || 'missing'} must fail the workflow instead of producing a green skipped acceptance`,
      );
      assert.match(
        `${result.stdout}\n${result.stderr}`,
        new RegExp(`main gate is ${state || 'missing'}`),
      );
    }
  });

  it('measures before it judges, from the main-only environment on a pinned checkout', () => {
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
    const measureIndex = monitorSteps.findIndex(
      (step) => step.name === 'Measure ingestion freshness',
    );
    const acceptanceIndex = monitorSteps.findIndex(
      (step) => step.name === 'Record ingestion operational acceptance',
    );
    assert.ok(gateIndex >= 0, 'the workflow must read the gate');
    assert.ok(
      gateIndex < measureIndex && measureIndex < acceptanceIndex,
      'the refusal must come after the measurement, or it replaces it',
    );
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
