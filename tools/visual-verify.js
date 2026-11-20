#!/usr/bin/env node
/**
 * Lunik UI Forge — browser verification entry point.
 *
 *   node tools/visual-verify.js [options]
 *
 *   --config <path>       config file (default: lunik.config.json)
 *   --root <path>         project root (default: current directory)
 *   --page <id>           verify only this page (repeatable)
 *   --viewport <name>     verify only this viewport (repeatable)
 *   --strict              treat warnings as failures
 *   --quiet               only print the final summary
 *   --plan                explain the run and output locations; no browser, no writes
 *   --help                show this text
 *
 * Exit codes: 0 pass · 1 failure · 2 usage/config error · 3 environment failure.
 *
 * This script NEVER writes to the baselines directory. Approval is a separate,
 * deliberate action (tools/approve-baseline.js).
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  flagBool,
  flagList,
  flagString,
  flagsMissingValue,
  parseArgs,
  unknownFlags,
} from './lib/args.js';
import { ConfigError, loadConfig, selectPages, selectViewports } from './lib/config.js';
import { EnvironmentError } from './lib/errors.js';
import { buildReport, makeRunId, writeReport } from './lib/report.js';
import { runVerification } from './lib/runner.js';
import { EXIT, STATUS, exitCodeFor, summarize } from './lib/severity.js';
import { readJsonIfExists, toPosix } from './lib/fs-utils.js';
import { displayPath, invocationFlags } from './lib/invocation.js';

const TOOL_NAME = 'lunik-ui-forge';

const KNOWN_FLAGS = ['config', 'root', 'page', 'viewport', 'strict', 'quiet', 'plan', 'help'];
const VALUE_FLAGS = ['config', 'root', 'page', 'viewport'];

const HELP = `Lunik UI Forge — browser verification

Usage: node tools/visual-verify.js [options]

Options:
  --config <path>     Config file (default: lunik.config.json)
  --root <path>       Project root (default: current directory)
  --page <id>         Verify only this page (repeatable)
  --viewport <name>   Verify only this viewport (repeatable)
  --strict            Treat warnings as failures
  --quiet             Only print the final summary
  --plan              Explain what will run, where output goes, and the next
                      command. Launches no browser and writes nothing.
  --help              Show this help

Exit codes:
  0  all checks passed (warnings allowed unless --strict)
  1  at least one check failed
  2  usage or configuration error
  3  verification could not run (browser, environment, navigation)
`;

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));

  if (flagBool(flags, 'help')) {
    process.stdout.write(HELP);
    return EXIT.OK;
  }

  const unknown = unknownFlags(flags, KNOWN_FLAGS);
  if (unknown.length > 0 || positional.length > 0) {
    const problems = [];
    if (unknown.length > 0) {
      problems.push(`Unknown option(s): ${unknown.map((name) => `--${name}`).join(', ')}.`);
    }
    if (positional.length > 0) {
      problems.push(`Unexpected argument(s): ${positional.join(' ')}.`);
    }
    throw new ConfigError(problems.join(' '), [
      'Options are passed as --name value; run with --help to see the supported options.',
      'Nothing was verified and no report was written.',
    ]);
  }

  const missingValue = flagsMissingValue(flags, VALUE_FLAGS);
  if (missingValue.length > 0) {
    throw new ConfigError(
      `Option(s) missing a value: ${missingValue.map((name) => `--${name}`).join(', ')}.`,
      [
        'Each of these options takes a value, for example --page saas-dashboard.',
        'Nothing was verified and no report was written.',
      ],
    );
  }

  const root = path.resolve(flagString(flags, 'root', process.cwd()));
  const quiet = flagBool(flags, 'quiet');
  const strict = flagBool(flags, 'strict');

  const { config, configPath } = await loadConfig(root, flagString(flags, 'config'));
  const pages = selectPages(config, flagList(flags, 'page'));
  const viewports = selectViewports(config, flagList(flags, 'viewport'));
  const toolVersion = await readToolVersion();

  if (flagBool(flags, 'plan')) {
    printPlan({ root, config, configPath, pages, viewports, toolVersion });
    return EXIT.OK;
  }

  const startedAt = new Date().toISOString();
  const runId = makeRunId(startedAt);
  const reportsRoot = path.join(root, config.reportsDir);

  if (!quiet) {
    process.stdout.write(
      `Lunik UI Forge ${toolVersion} — verifying ${pages.length} page(s) × ${viewports.length} viewport(s)\n`,
    );
  }

  const onProgress = (event) => {
    if (quiet) return;
    if (event.type === 'browser') {
      const { name, version, channel } = event.browserInfo;
      process.stdout.write(`Browser: ${name} ${version}${channel ? ` (channel: ${channel})` : ''}\n`);
    }
    if (event.type === 'page-done') {
      const summary = summarize(event.results, { strict });
      const mark =
        summary.status === STATUS.PASS ? 'ok  ' : summary.status === STATUS.WARNING ? 'warn' : 'FAIL';
      process.stdout.write(
        `  ${mark} ${event.pageId} @ ${event.viewport} — ` +
          `${summary.counts.fail} fail, ${summary.counts.warning} warn, ` +
          `${summary.counts.inconclusive} inconclusive\n`,
      );
    }
  };

  const { results, browserInfo } = await runVerification({
    root,
    config,
    configPath,
    pages,
    viewports,
    runId,
    reportsRoot,
    onProgress,
  });

  const finishedAt = new Date().toISOString();
  const report = buildReport({
    tool: { name: TOOL_NAME, version: toolVersion },
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      browser: browserInfo,
      timezone: 'UTC',
      colorScheme: config.browser?.colorScheme ?? 'light',
    },
    startedAt,
    finishedAt,
    strict,
    configPath,
    pages: pages.map((page) => page.id),
    viewports: viewports.map((viewport) => viewport.name),
    results,
  });

  const exitCode = exitCodeFor(report.run.status);
  report.run.exitCode = exitCode;

  const written = await writeReport(report, { reportsDir: reportsRoot, runId });

  printSummary(report, written, root, quiet, configPath);
  return exitCode;
}

function printPlan({ root, config, configPath, pages, viewports, toolVersion }) {
  const suffix = invocationFlags(root, configPath);
  const reportsRel = toPosix(path.relative(root, path.join(root, config.reportsDir))) || '.';
  const baselinesRel = toPosix(path.relative(root, path.join(root, config.baselinesDir))) || '.';
  const enabledChecks = Object.entries(config.checks ?? {}).filter(
    ([, check]) => check?.enabled !== false,
  );
  const visualEnabled = config.checks?.visual?.enabled !== false;
  const warningChecks = enabledChecks
    .filter(([, check]) => check.severity === 'warning')
    .map(([name]) => name);
  const pairs = pages.length * viewports.length;

  let baselinesPresent = 0;
  if (visualEnabled) {
    for (const page of pages) {
      for (const viewport of viewports) {
        if (existsSync(path.join(root, config.baselinesDir, page.id, `${viewport.name}.png`))) {
          baselinesPresent += 1;
        }
      }
    }
  }

  const browser = config.browser?.channel
    ? `installed ${config.browser.channel}`
    : 'Playwright Chromium';
  const mode = config.browser?.headless === false ? 'headed' : 'headless';
  const lines = [
    `Lunik UI Forge ${toolVersion} — first-run plan`,
    'Nothing is verified and no files are written by this command.',
    '',
    `Project root : ${root}`,
    `Configuration: ${displayPath(configPath)}`,
    `Browser      : ${browser} (${mode}, prefers-color-scheme: ${config.browser?.colorScheme ?? 'light'})`,
    `Checks       : ${enabledChecks.length} enabled` +
      (warningChecks.length > 0
        ? ` (warning severity: ${warningChecks.join(', ')}; --strict makes warnings fatal)`
        : ''),
    '',
    `Pages (${pages.length}):`,
    ...pages.map((page) => `  - ${page.id}  ${page.url ?? page.path}`),
    `Viewports (${viewports.length}):`,
    ...viewports.map((viewport) => `  - ${viewport.name}  ${viewport.width}x${viewport.height}`),
    '',
    `Reports     : ${reportsRel}/ (latest.md and latest.json; one new run directory per verification)`,
    `Screenshots : ${reportsRel}/<run-id>/screenshots/<page>/<viewport>.png`,
    visualEnabled
      ? `Baselines   : ${baselinesRel}/ (${baselinesPresent} of ${pairs} baseline image(s) present)`
      : `Baselines   : ${baselinesRel}/ (not used; visual comparison is disabled)`,
    '',
    `What will happen: for every page x viewport combination (${pairs} total), a browser opens, ` +
      `${enabledChecks.length} checks run, one screenshot is captured, and a report is written.`,
  ];

  if (!visualEnabled) {
    lines.push(
      'Visual comparison is disabled; the initial screenshot for each page and viewport is ' +
        'still captured for manual review.',
    );
  } else if (baselinesPresent < pairs) {
    lines.push(
      'Visual checks without a baseline fail by design: that is the expected fresh-checkout ' +
        'result, not a broken install.',
    );
  }

  lines.push('', 'Run the verification:', `  node tools/visual-verify.js${suffix}`, '');

  if (visualEnabled && baselinesPresent < pairs) {
    const [firstPage] = pages;
    const [firstViewport] = viewports;
    lines.push(
      'Then read the report and approve a baseline (the dry run writes nothing):',
      `  ${reportsRel}/latest.md`,
      `  node tools/approve-baseline.js${suffix} --page ${firstPage.id} --viewport ${firstViewport.name}`,
    );
  } else {
    lines.push('Then read the report:', `  ${reportsRel}/latest.md`);
    if (!visualEnabled) {
      lines.push(
        `Screenshots for review: ${reportsRel}/<run-id>/screenshots/<page>/<viewport>.png`,
      );
    }
  }

  process.stdout.write(`${lines.join('\n')}\n`);
}

function printSummary(report, written, root, quiet, configPath) {
  const relative = path.relative(root, written.markdown).split(path.sep).join('/');
  const line = '─'.repeat(52);

  if (!quiet) process.stdout.write(`${line}\n`);

  if (!quiet) {
    const attention = report.results.filter(
      (result) => result.status === STATUS.FAIL || result.status === STATUS.INCONCLUSIVE,
    );

    for (const result of attention.slice(0, 40)) {
      const tag = result.status === STATUS.FAIL ? 'FAIL' : 'INCONCLUSIVE';
      process.stdout.write(
        `[${tag}] ${result.pageId} @ ${result.viewport} · ${result.check}\n        ${result.message}\n`,
      );
    }

    const warnings = report.results.filter((result) => result.status === STATUS.WARNING);
    for (const result of warnings.slice(0, 20)) {
      process.stdout.write(
        `[warn] ${result.pageId} @ ${result.viewport} · ${result.check}\n        ${result.message}\n`,
      );
    }
  }

  const { summary, run } = report;
  process.stdout.write(
    `${line}\n` +
      `${run.status.toUpperCase()}  ` +
      `${summary.pass} passed · ${summary.fail} failed · ${summary.warning} warnings · ` +
      `${summary.inconclusive} inconclusive · ${summary.skipped} skipped\n` +
      `Report: ${relative}\n` +
      `Machine-readable: ${path.relative(root, written.latestJson).split(path.sep).join('/')}\n` +
      `Duration: ${run.durationMs} ms\n`,
  );

  if (!quiet) printFirstRunHint(report, root, configPath, relative);
}

/**
 * A fresh checkout fails every visual check because no human has approved a
 * baseline yet. Saying so at the point of failure avoids the two common
 * misreadings — "the install is broken" and "I must edit baselines by hand".
 * Only printed when every failure is a missing baseline, so it can never
 * excuse a real regression.
 */
function printFirstRunHint(report, root, configPath, reportRel) {
  const failures = report.results.filter((result) => result.status === STATUS.FAIL);
  const missing = failures.filter(
    (result) => result.check === 'visual' && result.message.startsWith('No approved baseline'),
  );
  if (missing.length === 0 || missing.length !== failures.length) return;

  const noun = missing.length === 1 ? 'check has' : 'checks have';
  const suffix = invocationFlags(root, configPath);
  process.stdout.write(
    `\nFirst run: ${missing.length} visual ${noun} no approved baseline.\n` +
      'That is expected on a fresh checkout — a baseline is a claim that a human must make.\n' +
      `The exact approval commands are in ${reportRel}. Preview the workflow without running it:\n` +
      `  node tools/visual-verify.js${suffix} --plan\n`,
  );
}

async function readToolVersion() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const manifest = await readJsonIfExists(path.join(here, '..', 'package.json'), {});
  return manifest.version ?? '0.0.0';
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    if (error instanceof ConfigError) {
      process.stderr.write(`Configuration error: ${error.message}\n`);
      for (const detail of error.details) process.stderr.write(`  - ${detail}\n`);
      process.exitCode = EXIT.USAGE;
      return;
    }
    if (error instanceof EnvironmentError) {
      process.stderr.write(`Environment error: ${error.message}\n`);
      for (const detail of error.details) process.stderr.write(`  - ${detail}\n`);
      process.exitCode = EXIT.ENVIRONMENT;
      return;
    }
    process.stderr.write(`Unexpected error: ${error?.stack ?? error}\n`);
    process.exitCode = EXIT.ENVIRONMENT;
  });
