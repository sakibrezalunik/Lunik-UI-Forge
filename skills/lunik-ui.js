/**
 * Machine-readable manifest for the Lunik UI agent skill.
 *
 * This is the single source of truth an adapter (Claude Code today, others
 * later) can import instead of hard-coding paths, commands, and rules. It is
 * plain ESM with no dependencies so any host can load it.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SKILL_DIR = path.dirname(fileURLToPath(import.meta.url));

export const skill = {
  name: 'lunik-ui',
  version: '0.1.0',
  description:
    'Design, implement, and verify a user interface with browser-based evidence: ' +
    'design direction, design system, implementation guidance, automated audits, ' +
    'screenshots, and a bounded fix loop.',

  /** Files an adapter should surface to the agent, relative to the project root. */
  files: {
    instructions: 'skills/lunik-ui/SKILL.md',
    adapterGuide: 'skills/lunik-ui/claude-code.md',
    designPrinciples: 'knowledge/design-principles.md',
    designTemplate: 'knowledge/DESIGN-TEMPLATE.md',
    designTokens: 'knowledge/design-tokens.json',
    accessibility: 'knowledge/accessibility.md',
    layoutPatterns: 'knowledge/layout-patterns.md',
    heuristics: 'knowledge/ui-heuristics.md',
  },

  commands: {
    verify: 'node tools/visual-verify.js',
    verifyStrict: 'node tools/visual-verify.js --strict',
    verifyOnePage: 'node tools/visual-verify.js --page <page-id> --viewport <viewport>',
    // The dry run is what an agent may run: it writes nothing and prints the run
    // id, the candidate SHA-256 and a diff. The approval itself needs
    // `--run <run-id> --approve-hash <sha256> --confirm` and is a human action.
    approveBaseline:
      'node tools/approve-baseline.js --page <page-id> --viewport <viewport>',
    serve: 'node tools/serve.js',
    tests: 'npm run test:all',
  },

  /** Behaviour an agent may rely on. */
  guarantees: [
    'Verification launches a real browser and inspects the rendered page.',
    'Every result carries page, viewport, severity, evidence, and a suggested fix.',
    'A check that could not run is reported as inconclusive and exits non-zero.',
    'Warnings are distinguishable from failures in both the JSON and the markdown report.',
    'Verification never writes to the baselines directory.',
  ],

  /** Behaviour an agent must not perform. */
  prohibitions: [
    'Never create, copy, or edit files under baselines/ without explicit human approval.',
    'Never claim a check passed without reading its result.',
    'Never lower a severity, loosen a threshold, or delete a check to make a run green.',
    'Never report an unrun or failed verification as successful.',
    'Never perform offensive security actions; this toolkit audits interfaces only.',
  ],

  /** Stop conditions that must end an automatic loop. */
  stoppingConditions: [
    'All required checks pass and remaining warnings are understood.',
    'Three fix/verify cycles completed with a failure still outstanding.',
    'The remaining failure needs a human product or design decision.',
    'The environment cannot run a browser.',
  ],
};

/**
 * Read the skill instructions.
 * @param {string} [projectRoot] defaults to the repository containing this file
 * @returns {Promise<string>}
 */
export async function loadInstructions(projectRoot = path.resolve(SKILL_DIR, '..')) {
  return readFile(path.join(projectRoot, skill.files.instructions), 'utf8');
}

/**
 * A compact brief for a host that only has room for a few lines.
 * @returns {string}
 */
export function brief() {
  return [
    `${skill.name} v${skill.version}`,
    skill.description,
    '',
    'Workflow: inspect -> respect DESIGN.md -> plan hierarchy -> implement ->',
    'run `node tools/visual-verify.js` -> read reports/latest.md -> fix -> re-run.',
    'Never write baselines; a human approves them explicitly.',
    'Never report a pass you did not observe.',
  ].join('\n');
}

export default skill;
