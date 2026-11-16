# Changelog

## 1.0.4 — 2026-11-16

- Re-release under the `xin070710` account with a clean commit history and no old account references.

## 1.0.3 — 2026-11-16

- `config.workspace` now also seeds the panel's workspace switcher and default workspace (not only the agent tools).
- Add a panel test for the configured default workspace.

## 1.0.2 — 2026-11-16

- Expand the plugin detail page and update the design/market notes.

## 1.0.1 — 2026-11-16

- Add `config.workspace` as a default workspace for the agent tools and document it.
- The public package contains no machine-specific workspace or JDK paths; JDK discovery now uses the project's `org.gradle.java.home`, `DSH_MC_JDK17/21/25`, `JAVA_HOME`, and common install locations.
- Generic example project names in docs and tool descriptions.

## 1.0.0 — 2026-11-16

First public release.

### Panel

- PCL2-style right-sidebar tab: project-grouped instance cards, loader/MC/JDK/mod counts, last activity, search and loader/running filters.
- Launch and stop `gradlew runClient` / `runServer -Pinstance=…` in the background, with PID, uptime, persistent launch records and graceful-then-forced process-tree stop.
- Game log and Gradle launch log panes with auto-refresh, error/warning highlighting, copy path and reveal.
- Enable/disable mods by renaming, "only this one", import from workspace candidates, delete with confirmation.
- Create/delete instances (inherits `options.txt`, can copy mods), open game/project folders, generate IntelliJ run configurations.
- Duplicate project names are disambiguated with `projectRelativePath::instanceName`; IDE run config names get a project prefix on collision.

### Entry points and settings

- Session-header button, right-sidebar guide card, and the “MC instances” tab.
- Auto-hide when neither the current workspace (including subdirectories) nor its direct parent has an MC project/instance. The header button and guide card both disappear; `Ctrl+Alt+M` (`⌘⌥M` on macOS) opens the panel while hidden. The setting lives in the panel gear and `localStorage` (`dsh.mc-instances.autoHideEmpty`).
- Workspace switcher over registered DSH workspaces, with a safe default workspace fallback.

### Host

- Loopback-only panel API with an exact custom header, strict JSON content type, body cap, and no arbitrary executable opening.
- Bounded workspace scans (5000 directories / 3 seconds) and bounded parent probes.
- Zero runtime dependencies; `@deepseek-ai/dsh-tools` is an optional peer with a bundled fallback.

## 0.2.0

- Internal pre-release used for local development.
