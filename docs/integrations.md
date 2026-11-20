# Integrations

## The adapter contract

An AI coding platform needs to provide four things to use Lunik UI. Nothing else
is required, and no plugin API is assumed.

| Responsibility | What it means | Where it comes from |
| --- | --- | --- |
| Discovery | Know the skill exists and when it applies | `skills/lunik-ui/SKILL.md` frontmatter |
| Instruction delivery | Give the agent the workflow and references | `SKILL.md` + `knowledge/*` |
| Command execution | Allow `node tools/*.js` in the project | `skills/lunik-ui.js` → `commands` |
| Result interpretation | Read exit codes and `reports/latest.json` | `docs/verification.md` |

`skills/lunik-ui.js` is the machine-readable contract: name, version, file
paths, commands, guarantees, prohibitions, stopping conditions. Import it rather
than duplicating those strings in each adapter.

## Claude Code

The original target. Setup is described in
[`skills/lunik-ui/claude-code.md`](../skills/lunik-ui/claude-code.md).

**Verified status: not executed against Claude Code in this environment** —
Claude Code was not installed where this repository was built. The layout
follows the documented `SKILL.md` convention, but you should confirm it on your
machine rather than assume it works.

## CI (GitHub Actions example)

The exit codes make the tool CI-friendly without extra parsing:

```yaml
- uses: actions/checkout@v4
- uses: actions/setup-node@v4
  with:
    node-version: 22
- run: npm ci
- run: npx playwright install --with-deps chromium
- run: node tools/visual-verify.js --quiet
```

Notes:

- Do not commit baselines generated on a developer's machine and compare them on
  a Linux runner unless you accept font-rendering differences. Either generate
  baselines inside the same container image, or keep the visual check at
  `warning` severity there.
- `--strict` turns warnings into failures. Use it only if you have reviewed
  every warning currently reported.
- Upload `reports/` as an artifact when a run fails; the screenshots and diffs
  are the useful part.

## Verifying an app you are already running

Point a page at a live URL instead of a served path:

```json
{ "id": "local-app", "url": "http://127.0.0.1:5173/" }
```

The built-in static server is not started when every page uses `url`. Everything
else — viewports, checks, baselines — works the same.

## Other platforms

Porting is a thin wrapper around the contract above. Practical guidance:

1. **Do not copy the knowledge files into your prompt.** Reference them; they are
   long and the agent should read the relevant one.
2. **Keep the baseline prohibition.** If the platform can run arbitrary shell
   commands, remove `tools/approve-baseline.js` from the allowed set — an agent
   that approves its own visual baselines has removed the only human check in the
   loop.
3. **Map the exit codes.** `3` means "could not verify" and must not be rendered
   as success.
4. **Prefer `reports/latest.json`** over scraping the terminal output.

## What this is not

- Not a UI component library. There is no runtime to install.
- Not a hosted service. Nothing is uploaded anywhere.
- Not a design generator. The examples are reference implementations, not output
  of an image model.
