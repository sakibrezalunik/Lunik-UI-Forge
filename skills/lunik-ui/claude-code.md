# Claude Code adapter

Claude Code was the original target for this toolkit. This document describes
how to wire Lunik UI into it, and states clearly what has and has not been
verified.

## Status

**Not executed against Claude Code in this repository's development
environment.** Claude Code was not installed there, so the instructions below
are written from the documented skill layout and the repository's own file
structure. Treat them as a setup guide that you should confirm on your machine,
not as a tested integration.

Everything the adapter needs is ordinary files and CLI commands, so no special
plugin API is required.

## How the pieces fit

| Piece | Path | Role |
| --- | --- | --- |
| Skill instructions | `skills/lunik-ui/SKILL.md` | The workflow the agent follows |
| Skill manifest | `skills/lunik-ui.js` | Machine-readable name, paths, commands, rules |
| Knowledge | `knowledge/*` | Design, accessibility, and layout references |
| Verification | `tools/visual-verify.js` | The audit the workflow runs |
| Approval | `tools/approve-baseline.js` | Human-only baseline approval |

`SKILL.md` begins with YAML frontmatter (`name`, `description`), which is the
convention Claude Code uses to discover a skill and decide when to load it.

## Setup

1. Install dependencies in the project you want to audit:

   ```bash
   npm install
   npx playwright install chromium
   ```

   If Playwright's Chromium is not available, set
   `"browser": { "channel": "chrome" }` in `lunik.config.json` to use an
   installed Google Chrome instead.

2. Make the skill available to Claude Code. Either:

   - **Per project:** copy or symlink `skills/lunik-ui/` into the project's
     `.claude/skills/lunik-ui/` directory, keeping `SKILL.md` at its root; or
   - **Per machine:** place it in your user-level skills directory following
     Claude Code's current documentation.

   The `knowledge/` and `tools/` directories referenced by the skill must be
   reachable from the project root, because the commands run there.

3. Confirm the toolchain works before asking an agent to rely on it:

   ```bash
   node tools/visual-verify.js --quiet
   echo $?
   ```

   Expect exit code 0 when every check passes, 1 when a check fails, 2 for a
   configuration error, and 3 when verification could not run.

## What to tell the agent

Claude Code reads `SKILL.md`. If you are invoking the workflow manually, a
compact brief is exported for you:

```js
import { brief } from './skills/lunik-ui.js';
console.log(brief());
```

## Enforcing the baseline rule

The one rule worth enforcing mechanically is that an agent must not approve its
own visual baselines. Two ways to do that:

- Keep `tools/approve-baseline.js` out of the skill's allowed commands, so the
  agent can only propose a change and ask you to run the approval.
- Or require the `--confirm` flag and simply never grant it: without `--confirm`
  the tool is a dry run that prints the diff and writes nothing.

## Porting to another agent platform

An adapter needs to provide four things and nothing else:

1. **Discovery** — where the skill lives and when to load it.
2. **Instruction delivery** — `SKILL.md` plus the `knowledge/` files.
3. **Command execution** — permission to run `node tools/*.js` in the project.
4. **Result interpretation** — exit codes `0/1/2/3` and
   `reports/latest.json`.

Because those are ordinary files, exit codes, and JSON, a new adapter is a thin
wrapper. The manifest at `skills/lunik-ui.js` is the contract: it lists the
files, the commands, the guarantees, the prohibitions, and the stopping
conditions. Import it rather than duplicating that knowledge.
