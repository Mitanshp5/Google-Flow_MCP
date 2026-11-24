# Running the Playwright-backed suites

If `npx playwright install` fails with `EACCES: permission denied` on the default
browsers directory, install and run against a writable path instead:

```bash
PLAYWRIGHT_BROWSERS_PATH=$HOME/.cache/ms-playwright npx playwright install chromium-headless-shell
PLAYWRIGHT_BROWSERS_PATH=$HOME/.cache/ms-playwright npx vitest run
```

Without the env var, `download-discovery`, `w04-upload-refs` and every other
browser-backed suite fail at `browserType.launch` (ENOENT), which looks like a
code regression but is purely environmental.
