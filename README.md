# t-vis

`tvis` is a localhost review desk for long Codex / Trae CLI replies. Read a
reply in the browser, select multiple passages, leave questions in the margin,
then send one structured follow-up back to the same App Server thread.

## Install

Prerequisites: Node.js 20+ and a current `codex` or `traecli` executable on
`PATH`.

```bash
npm install --global @heal/tvis
```

For local development, run `npm run tvis --` from a clone of this repository.

## First npm release

The initial public npm release must be made locally before npm can bind this
repository's GitHub Actions workflow as a trusted publisher. After logging in
to the public npm registry, run the interactive bootstrap command:

```bash
npm login --registry=https://registry.npmjs.org
npm run publish:bootstrap
```

The command checks and packs the project, asks for an OTP without echoing it,
publishes the exact archive, verifies the published version, then configures
OIDC trusted publishing for `2heal1/t-vis` and `release.yml`. Subsequent
releases are published by pushing a matching `v*` Git tag.

## Start a shared session

```bash
tvis trae
# or
tvis codex
```

The command runs three processes as one foreground session:

1. a loopback-only App Server at `ws://127.0.0.1:4699`;
2. the t-vis Web bridge at `http://127.0.0.1:4173`;
3. the matching TUI attached to that App Server with `--remote`.

The bridge prints an authenticated localhost URL. Open that exact URL in a
browser. Closing the TUI, pressing `Ctrl-C`, or terminating `tvis` stops the
shared App Server and bridge.

Pass normal TUI arguments after the target:

```bash
tvis trae --resume
tvis codex --model gpt-5.2
```

Use `TVIS_APP_SERVER_PORT` and `TVIS_PORT` to change the two loopback ports.

## Workflow

1. Start with `tvis trae` or `tvis codex`, then open the printed browser URL.
2. t-vis automatically opens the currently loaded TUI session and shows its
   most recent reply. Use the **会话** picker to switch to an earlier session
   from the same working directory, or **刷新会话** after starting a new TUI
   session. The selected session refreshes automatically while the page is
   visible, and immediately when you return to its browser tab.
3. Drag to select one or more passages. Add a question to each margin note.
4. Click **发送到会话**. t-vis sends a single structured `turn/start` input
   to the current thread and renders streamed reply deltas when the App Server
   emits them.

## Session isolation

Each browser review URL includes a `thread` route parameter after you load a
thread. Server-Sent Events are filtered on that `threadId`, and all
`turn/start` calls carry that same ID. Therefore different browser tabs and
TUI sessions do not cross streams or send a margin note to the wrong session.

The bridge only listens on `127.0.0.1` and requires the random token embedded
in its startup URL. The Trae App Server path is experimental; t-vis uses the
common App Server methods `initialize`, `thread/start`, `thread/read`,
`thread/resume`, and `turn/start`.
