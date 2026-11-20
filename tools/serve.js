#!/usr/bin/env node
/**
 * Serve the project so you can look at the examples in a browser.
 *
 *   node tools/serve.js --port 4173
 *
 * Run this when you want to inspect a page yourself rather than through the
 * automated checks. Ctrl+C stops it.
 */
import path from 'node:path';
import { flagBool, flagString, parseArgs, unknownFlags } from './lib/args.js';
import { startStaticServer } from './lib/server.js';

const { flags, positional } = parseArgs(process.argv.slice(2));

if (flagBool(flags, 'help')) {
  process.stdout.write(
    'Lunik UI Forge — static preview server\n\n' +
      'Usage: node tools/serve.js [options]\n\n' +
      'Options:\n' +
      '  --root <path>   Project root (default: current directory)\n' +
      '  --port <number> Port to listen on (default: 4173)\n' +
      '  --help          Show this help\n',
  );
  process.exit(0);
}

const unknown = unknownFlags(flags, ['root', 'port', 'help']);
if (unknown.length > 0 || positional.length > 0) {
  process.stderr.write(
    `Usage error: ${[
      ...unknown.map((name) => `unknown option --${name}`),
      ...positional.map((value) => `unexpected argument ${value}`),
    ].join(', ')}.\n` +
      'Usage: node tools/serve.js [--root <path>] [--port <number>]\n',
  );
  process.exit(2);
}

const root = path.resolve(flagString(flags, 'root', process.cwd()));
const port = Number.parseInt(flagString(flags, 'port', '4173'), 10);

const server = await startStaticServer({ root, port });

process.stdout.write(`Lunik UI Forge — serving ${root}\n`);
process.stdout.write(`  ${server.origin}/examples/saas-dashboard/\n`);
process.stdout.write(`  ${server.origin}/examples/cybersecurity-dashboard/\n`);
process.stdout.write('Press Ctrl+C to stop.\n');

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await server.close();
    process.exit(0);
  });
}
