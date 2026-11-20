import path from 'node:path';
import { ConfigError } from './config.js';
import { ensureDir, writeJson, writeText } from './fs-utils.js';
import { STATUS, summarize } from './severity.js';

/**
 * Assemble the machine-readable report.
 * Timestamps come from the caller's real clock; nothing here invents them.
 */
export function buildReport({
  tool,
  environment,
  startedAt,
  finishedAt,
  strict = false,
  configPath,
  pages,
  viewports,
  results,
}) {
  const { counts, status } = summarize(results, { strict });

  return {
    schemaVersion: 1,
    tool,
    environment,
    run: {
      startedAt,
      finishedAt,
      durationMs: new Date(finishedAt).getTime() - new Date(startedAt).getTime(),
      status,
      strict,
      exitCode: null,
    },
    config: {
      path: configPath ?? null,
      pages,
      viewports,
    },
    summary: {
      total: results.length,
      ...counts,
    },
    results,
  };
}

const STATUS_LABEL = {
  [STATUS.PASS]: 'PASS',
  [STATUS.FAIL]: 'FAIL',
  [STATUS.WARNING]: 'WARN',
  [STATUS.INCONCLUSIVE]: 'INCONCLUSIVE',
  [STATUS.SKIPPED]: 'SKIP',
};

/** Human-readable summary of a report. Rendered from the same object as the JSON. */
export function renderMarkdown(report) {
  const lines = [];
  const { summary, run, environment, tool } = report;

  lines.push('# Lunik UI Forge — verification report', '');
  lines.push(`**Result: ${run.status.toUpperCase()}**`, '');
  lines.push(`- Started: \`${run.startedAt}\``);
  lines.push(`- Finished: \`${run.finishedAt}\` (${run.durationMs} ms)`);
  lines.push(`- Tool: ${tool.name} ${tool.version}`);
  lines.push(
    `- Environment: Node ${environment.node} on ${environment.platform}/${environment.arch}, ` +
      `${environment.browser.name} ${environment.browser.version}` +
      `${environment.browser.channel ? ` (channel: ${environment.browser.channel})` : ''}`,
  );
  lines.push(`- Strict mode: ${run.strict ? 'on — warnings fail the run' : 'off'}`);
  lines.push('');
  lines.push('## Summary', '');
  lines.push('| Total | Pass | Fail | Warning | Inconclusive | Skipped |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  lines.push(
    `| ${summary.total} | ${summary.pass} | ${summary.fail} | ${summary.warning} | ` +
      `${summary.inconclusive} | ${summary.skipped} |`,
  );
  lines.push('');

  const attention = report.results.filter(
    (r) => r.status !== STATUS.PASS && r.status !== STATUS.SKIPPED,
  );

  if (attention.length === 0) {
    lines.push('No failures, warnings, or inconclusive checks.', '');
  } else {
    lines.push('## Needs attention', '');
    for (const result of attention) {
      lines.push(...renderResult(result));
    }
  }

  const passed = report.results.filter((r) => r.status === STATUS.PASS);
  if (passed.length > 0) {
    lines.push('<details><summary>Passing checks</summary>', '');
    for (const result of passed) {
      lines.push(`- \`${result.pageId}\` · ${result.viewport ?? 'all'} · ${result.check}`);
    }
    lines.push('', '</details>', '');
  }

  const skipped = report.results.filter((r) => r.status === STATUS.SKIPPED);
  if (skipped.length > 0) {
    lines.push('<details><summary>Skipped checks</summary>', '');
    for (const result of skipped) {
      lines.push(`- \`${result.pageId}\` · ${result.viewport ?? 'all'} · ${result.check}: ${result.message}`);
    }
    lines.push('', '</details>', '');
  }

  return `${lines.join('\n')}\n`;
}

function renderResult(result) {
  const lines = [];
  const label = STATUS_LABEL[result.status] ?? result.status.toUpperCase();
  lines.push(`### ${label} · ${result.title}`, '');
  lines.push(`- Page: \`${result.pageId}\`${result.pageUrl ? ` (${result.pageUrl})` : ''}`);
  lines.push(`- Viewport: ${result.viewport ?? 'all'}`);
  lines.push(`- Check: \`${result.check}\` · severity \`${result.severity}\``);
  lines.push(`- Observed: ${result.message}`);
  if (result.remediation) lines.push(`- Suggested fix: ${result.remediation}`);
  if (result.artifacts && Object.keys(result.artifacts).length > 0) {
    const artifacts = Object.entries(result.artifacts)
      .map(([key, value]) => `${key}: \`${value}\``)
      .join(', ');
    lines.push(`- Artifacts: ${artifacts}`);
  }
  if (result.evidence && Object.keys(result.evidence).length > 0) {
    lines.push('', '```json', JSON.stringify(result.evidence, null, 2), '```');
  }
  lines.push('');
  return lines;
}

/**
 * Write report.json + report.md into a run directory and refresh `latest`.
 *
 * @returns {Promise<{dir: string, json: string, markdown: string, latestJson: string, latestMarkdown: string}>}
 */
export async function writeReport(report, { reportsDir, runId }) {
  const dir = path.join(reportsDir, runId);
  await ensureDir(dir);

  const json = path.join(dir, 'report.json');
  const markdown = path.join(dir, 'report.md');

  await writeJson(json, report);
  await writeText(markdown, renderMarkdown(report));

  // A stable, predictable path for humans and agents that just want "the last run".
  const latestJson = path.join(reportsDir, 'latest.json');
  const latestMarkdown = path.join(reportsDir, 'latest.md');
  await writeJson(latestJson, report);
  await writeText(latestMarkdown, renderMarkdown(report));

  return { dir, json, markdown, latestJson, latestMarkdown };
}

/** Filesystem-safe run id derived from the real start time. */
export function makeRunId(startedAt = new Date().toISOString()) {
  return startedAt.replace(/[:.]/g, '-');
}

/**
 * The only shape {@link makeRunId} can produce: an ISO-8601 timestamp with `:`
 * and `.` replaced by `-`, e.g. `2026-11-15T15-16-10-725Z`.
 *
 * Anything else is refused before it is joined into a path. `--run` is user
 * input, so a value such as `../../../Windows` must never reach `path.join`.
 */
export const RUN_ID_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;

/** True only for a string that is a generated run id. */
export function isRunId(value) {
  return typeof value === 'string' && RUN_ID_PATTERN.test(value);
}

/**
 * Refuse anything that is not a generated run id.
 *
 * Callers must use this *before* building a path from the value, so a hostile
 * `--run` fails as a usage error instead of being resolved by the filesystem.
 *
 * @param {unknown} value
 * @returns {string} the value, when it is valid
 */
export function assertRunId(value) {
  if (isRunId(value)) return value;
  throw new ConfigError(`\`--run ${String(value)}\` is not a verification run id.`, [
    'Run ids look like 2026-11-15T15-16-10-725Z: the directory name under reports/.',
    'Use the id printed by the verification report; paths and directory names are not accepted.',
  ]);
}
