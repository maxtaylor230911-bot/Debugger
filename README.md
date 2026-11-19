# Debugger

Automated AI security reviews for this repository, powered by
[0security](https://github.com/0sec-labs/0security), an open-source harness for AI
security agents.

On every pull request (and on demand), a GitHub Actions workflow runs 0security
against the code, saves its findings, and posts a report to the run's summary page.

## What's in here

| Path | What it is |
| --- | --- |
| [`.github/workflows/0security.yml`](.github/workflows/0security.yml) | The scan workflow (runs the pinned `ghcr.io/0sec-labs/0security` Docker image) |
| [`.0security/scan-prompt.md`](.0security/scan-prompt.md) | The instructions given to the security agent. Edit it to change what it looks for |
| [`app/`](app/) | A small **intentionally vulnerable** Node.js demo app, so the first scan has something to find. Replace it with your own code |

## Setup (one time)

1. Get an API key from [console.anthropic.com](https://console.anthropic.com/).
2. In this repo on GitHub: **Settings → Secrets and variables → Actions → New repository secret**
   - Name: `ANTHROPIC_API_KEY`
   - Value: your key
3. Go to **Actions → 0security scan → Run workflow** to try it.

Without the secret, the workflow still runs but skips the scan and says why.

Want a different AI provider? 0security supports OpenAI, OpenRouter, DeepSeek and others.
Swap `ANTHROPIC_API_KEY` in the workflow for that provider's variable (see the
[models docs](https://docs.0.security/models/)).

## Reading results

Open a workflow run. The **Summary** tab shows the agent's review and its findings list.
The full output is also attached as the `0security-report` artifact.

A finished scan passes even when it finds problems, so read the report, not just the
green tick.

## Running it on your own computer

```bash
curl -fsSL https://raw.githubusercontent.com/0sec-labs/0security/main/install.sh | bash
export ANTHROPIC_API_KEY="your-key"
0 -p "$(cat .0security/scan-prompt.md)"
0 findings list
```

On Windows, download `0-windows-x64.exe` from the
[0security releases](https://github.com/0sec-labs/0security/releases/latest), or use Docker:

```bash
docker run --rm -e ANTHROPIC_API_KEY -v "$PWD:/work:ro" -w /work \
  ghcr.io/0sec-labs/0security:v0.39.0 -p "Review this folder for security problems"
```

## Safety notes

- The code is mounted **read-only** and the workflow token is limited to `contents: read`.
- Pull requests from forks don't get repository secrets, so the scan is skipped for them.
- `app/` is deliberately insecure. **Do not deploy it.**
- Only point 0security at systems you own or are authorized to test.
- Usage telemetry is turned off in CI (`ZERO_ANALYTICS_LEVEL=off`).

## License

This repository is MIT licensed. 0security itself is MIT OR Apache-2.0 and is used here
unmodified, as a Docker image.
