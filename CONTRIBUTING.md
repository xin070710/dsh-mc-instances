# Contributing / 贡献指南

Thanks for helping! / 感谢参与！

## Development / 开发

Requirements: Node.js 20+ and a DeepSeek Harness installation for manual testing.

```sh
git clone https://github.com/xin070710/dsh-mc-instances.git
cd dsh-mc-instances
node --test
```

The plugin has **no build step** and no runtime dependencies. `client.js` is served as-is; `src/*.js` runs on the Host. `@deepseek-ai/dsh-tools` is optional at test time — the tool layer falls back to a bundled implementation when it cannot resolve.

Install a local checkout into a DSH profile:

```sh
dsh plugin --profile web add /absolute/path/to/dsh-mc-instances
```

## Layout / 目录

| Path | Role |
|---|---|
| `src/profiles.js` | Pure-Node workspace scanning, instance create/delete, mod toggles, logs, `.run` generation |
| `src/index.js` | DSH tool layer (`defineTool`) |
| `src/panel-api.js` | Host HTTP API for the right-sidebar panel |
| `src/launcher.js` | Background `gradlew runClient/runServer` launcher |
| `client.js` | Browser module: right-sidebar tab, guide card, header button, settings |
| `tests/` | Node test suite (`node --test`) |

## Pull requests / 提交 PR

- Keep changes focused; add or update a test for behavior changes.
- Run `node --test` before opening the PR.
- Never commit real workspace paths, usernames, tokens, logs or mod jars.
- The panel is a local tool: keep the loopback-only API gate and safe-open allowlist intact.
- For UI changes, include a screenshot or a short recording in the PR when possible.

## Plugin market / 上架

The community catalog is [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin). One YAML file per plugin lives in `data/plugins/`; the repository README and the market's index are generated from it. This repo's entry is `xin070710__dsh-mc-instances.yml`. The package already declares `dsh.bundle` + `cordis.patch.yml`, which is what makes it installable.
