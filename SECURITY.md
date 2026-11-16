# Security

## Scope / 范围

This plugin is a local developer tool for the machine running DeepSeek Harness. It:

- starts Gradle wrappers from projects it has scanned;
- reads and writes files under a scanned project's `run/`, `.idea/runConfigurations/`, and `logs/`;
- exposes a local HTTP API for the right-sidebar panel.

## Design boundaries / 设计边界

- The panel API is reachable only from a loopback page (`127.0.0.1`, `localhost`, `[::1]`) on the Host's expected port + a custom request header. Remote entries such as dsh-pocket cannot call it.
- Requests must be `application/json`, within a 256 KiB body cap.
- "Open folder" is restricted to scanned project/instance directories and log/text/image files; executable extensions are refused.
- The plugin never edits `build.gradle`, `settings.gradle`, or mod jars. Disabling a mod renames `*.jar` to `*.jar.disabled`.
- Launch records are kept under `%DSH_HOME%/mc-instances/launches.json` (override with `DSH_MC_PANEL_STATE_DIR`).

## Reporting / 报告问题

Please use GitHub Security Advisories:

<https://github.com/xin070710/dsh-mc-instances/security/advisories/new>

Do not open a public issue for a vulnerability that could lead to command execution or arbitrary file access. Include the DSH version, plugin version, and a minimal reproduction.
