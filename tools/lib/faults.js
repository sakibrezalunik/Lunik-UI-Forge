/**
 * A single, explicitly-gated failure-injection seam for approval transactions.
 *
 * The approval path protects against failures at a dozen specific points
 * (staging, archiving, replacing the image, replacing the manifest, rolling
 * back). Those points cannot be reached from the outside without either
 * corrupting the filesystem in ways Windows does not allow or adding test hooks
 * throughout the code, so there is exactly one hook here and it is inert unless
 * `LUNIK_APPROVAL_FAULT` is set.
 *
 *   LUNIK_APPROVAL_FAULT=<stage>          throw a classified error at <stage>
 *   LUNIK_APPROVAL_FAULT=<stage>:crash    exit(70) at <stage>, simulating a kill
 *
 * Stages: staging, after-journal, after-archive, after-baseline-replace,
 * before-manifest-write, during-rollback, before-journal-cleanup.
 *
 * Nothing sets this variable in normal use, and an unknown stage does nothing,
 * so a typo can never weaken an approval.
 */
import { EnvironmentError } from './errors.js';

export const FAULT_ENV = 'LUNIK_APPROVAL_FAULT';

export function faultPoint(stage) {
  const spec = process.env[FAULT_ENV];
  if (!spec) return;
  const [target, mode = 'throw'] = spec.split(':');
  if (target !== stage) return;

  if (mode === 'crash') {
    // Exit without unwinding: simulates the process being killed between two
    // filesystem operations, which is what the journal exists for.
    process.exit(70);
  }

  throw new EnvironmentError(`Injected fault at "${stage}" (${FAULT_ENV}=${spec}).`, [
    'This seam exists only so the approval-transaction tests can fail a specific stage.',
    'Unset LUNIK_APPROVAL_FAULT to run normally.',
  ]);
}
