# dsh-mc-instances

English | [中文](README.zh.md)

[![License: MIT](https://img.shields.io/badge/license-MIT-2ea44f.svg)](LICENSE)

<img src="assets/icon-180.png" width="96" height="96" alt="dsh-mc-instances icon" align="right">

> **Right sidebar entry**: once the plugin loads, the session's right sidebar gains an “MC instances” tab. The “Minecraft instance manager” card on the guide page and the MC instances button in the session header open the same PCL2-style panel — instance cards, one-click start/stop, mod toggles and game/Gradle logs. Disabling the plugin removes these entry points; the panel only writes `run/`, `.idea/runConfigurations/`, and launch logs under the project's `logs/`, never project files.

**Manage Minecraft mod-testing instances from inside DeepSeek Harness.**

<img src="docs/preview.svg" alt="PCL2-style instance manager preview" width="900">

It manages the instance-isolation setup every mod dev ends up building: each project runs
`gradlew runClient -Pinstance=<name>` to point the game directory at its own `run/<name>/`,
with its own `mods/ config/ saves/ logs/`.

The annoying part is that those instances never show up in the IDE run dropdown, and each
`mods/` folder has to be filled by hand. This plugin turns the whole ritual into one sentence
or one click.

## What you get

| Capability | Detail |
|---|---|
| **PCL2-style sidebar panel** | An “MC instances” tab in the session's right sidebar: cards grouped by project with loader, MC version, JDK, mod count and last activity; search, loader filters and a running filter. Detects the current session workspace; auto-hide is on by default |
| **Launch / stop** | Starts `gradlew runClient -Pinstance=…` (or the server) from the panel, shows PID and uptime, and stops the whole process tree; Gradle output goes to the project's `logs/launch-*.log` |
| **Game and Gradle logs** | Two log views with auto-refresh and error/warning highlighting, plus copy-path and reveal-in-file-manager actions |
| **List instances** | Finds every project that supports instance isolation plus all of its instances (including the default `run/`), with loader, MC version, JDK, mod count and last-played time |
| **One-click IDE configs** | Writes `.idea/runConfigurations/<project>-<instance>.run` so each instance appears in the IntelliJ run dropdown — pick it, hit the green triangle, debug/breakpoints included |
| **Create instance** | Makes `run/<name>/{mods,config,saves,logs}` and inherits the default instance's `options.txt` |
| **Mod toggles** | Enable/disable by renaming `xxx.jar` ⇄ `xxx.jar.disabled` — nothing gets deleted, switching test setups is instant; also “keep only this one” |
| **Pick mods from the workspace** | Collects candidate jars from `_shared/`, `_mods/`, every `run/mods` and `run/<instance>/mods`, then imports them into the target instance |
| **Read logs** | Tails the instance's `logs/latest.log` so you can see whether a mod loaded or crashed |
| **Delete instance** | Removes `run/<instance>/` (the default `run/` is protected) |

## Install

From the plugin market (recommended): open **Plugins → Plugin Market**, search for “MC instances” or `dsh-mc-instances`, and install.

Or install directly from GitHub (no build step):

```sh
dsh plugin --profile web add github:xin070710/dsh-mc-instances
```

Restart `dsh web`. No further configuration needed. On Desktop, install from **Settings → Plugins** so it lands in the profile the app actually uses.

## Usage

Just talk to the agent:

```
list my Minecraft test instances
create an instance called dev2 for example-mod and copy JEI into it
keep only Pixelmon enabled in example-mod-dev2
generate the IDE run configurations
example-mod-dev2 crashed on launch, show me the log
```

Tools it can call:

| Tool | Purpose |
|---|---|
| `mc_instances` | `action: list` for everything, `action: detail` for one instance |
| `mc_instance_create` | Create an instance; optionally copy a whole `mods/` set from another instance |
| `mc_mods` | `list` / `enable` / `disable` / `only` / `import` / `remove` / `candidates` |
| `mc_instance_log` | Tail an instance log (120 lines by default, up to 2000) |
| `mc_instance_launch` | Launch an instance in the background (`gradlew runClient -Pinstance=…`), returning the PID and log path immediately |
| `mc_instance_launch_log` | Tail the Gradle-side launch log (`logs/launch-<instance>-<side>.log`) |
| `mc_ide_config` | Write IntelliJ run configs for all or one project (`server: true` → `runServer`) |
| `mc_instance_delete` | Delete an instance directory |

## Configuration

Workspace resolution: tool argument `workspace` → env `DSH_MC_WORKSPACE` → process current directory. The panel prefers registered DSH workspaces and respects the auto-hide setting before switching.

```sh
DSH_MC_WORKSPACE=D:\path\to\your\mods dsh web
```

You can also set the default workspace on the plugin row in the profile's `cordis.patch.yml` (the public repo contains no machine-specific paths):

```yaml
- id: mc-instances
  name: dsh-mc-instances
  config:
    workspace: D:\path\to\your\mods
```

JDK resolution: project `gradle.properties` (`org.gradle.java.home`) → `DSH_MC_JDK17/21/25` → `JAVA_HOME` → common install directories (`C:\Program Files\Java`, Eclipse Adoptium, Microsoft, `~/.jdks`, `/usr/lib/jvm`, and similar).

## IntelliJ workflow

1. Ask the agent to “generate the IDE run configurations” (or call `mc_ide_config`)
2. In IntelliJ, click **Reload** in the Gradle panel once so it picks up the new configurations
3. Pick `example-mod-dev2` in the run dropdown and hit the green triangle
4. Ask the agent to tail that instance's log to confirm the mods loaded

## Behaviour contract

- **Auto-hide when no nearby instances (configurable).** On by default. The scan covers the current workspace (including subdirectories) and its direct parent; when neither has an MC project/instance, the session-header MC instances button and the MC instances card on the right-sidebar guide both disappear, and the panel stops auto-switching to other workspaces. Press **Ctrl+Alt+M** (⌘⌥M on macOS) to open the panel while every entry is hidden, then turn auto-hide off from the gear “MC instance settings.” The setting is saved in this browser / desktop profile.
- **Plain projects are recognized too.** A standard Minecraft project without `-Pinstance` isolation still appears with its default `run/` instance; it just cannot create additional isolated instances. Projects that ship only `gradlew` (no `.bat`) try Git Bash on Windows.
- **Never edits your build scripts.** It only reads `build.gradle` to detect loader/version/JDK; writes happen in `run/` and `.idea/runConfigurations/`.
- **Never deletes mod files on disable** — it renames them.
- **The default `run/` instance cannot be deleted**, and a running instance is never deleted.
- **Duplicate project names are distinguished.** Workspaces can contain `Fabric\example` and `NeoForge\example`; the panel uses project-relative-path + instance name as the identity, and generated IDE configurations get a project prefix when two run-configuration names collide (for example `Fabric-example-default`).
- **Launch records persist.** Running instances are recorded in `%DSH_HOME%/mc-instances/launches.json`, so a Host plugin reload still refuses a duplicate launch. Stop asks the process tree to close first and only force-kills after 5 seconds.
- **Only safe paths open.** The Host API accepts loopback pages with the panel header only; “open folder” is limited to scanned instance/project directories and log, text, or image files, and refuses executables. Remote entries such as dsh-pocket cannot use the panel (Agent tools still work).
- **Scans are bounded** to 5000 directories / 3 seconds, so picking a drive root cannot hang the panel.
- **Zero runtime dependencies** — file operations are plain Node; `@deepseek-ai/dsh-tools` is the only peer dependency.
- Generated `.run` files use the same format as existing IntelliJ Gradle configurations (`GradleRunConfiguration` + `runClient` + `-Pinstance=<name>`).

## Development

```sh
node --test
```

- `src/profiles.js` — pure Node scanning and instance operations, unit-testable without DSH
- `src/index.js` — DSH tool layer (`defineTool`) exposed to the agent
- `src/panel-api.js` — Host HTTP API for the right-sidebar panel (loopback + custom-header gate)
- `client.js` — browser-side tab, guide card and header button
- `tests/` — pure logic, tool-layer end-to-end, panel API and launch/stop

The tool tests use `@deepseek-ai/dsh-tools` when it resolves (the DSH installation provides it), and fall back to a bundled implementation otherwise, so the plugin also loads from a git source.

Issues and PRs are welcome. To list the plugin in the community market, see [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin); the entry file for this repo is `xin070710__dsh-mc-instances.yml`.

## License

MIT © dsh-mc-instances contributors
