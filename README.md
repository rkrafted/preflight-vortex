# Preflight for Vortex

Shows [Preflight](https://github.com/rkrafted/preflight)'s checks for Cyberpunk 2077 inside Vortex, and asks before you launch
a setup that won't run.

> **Early beta.** The add-on has not been tried inside Vortex on a real PC yet. Please report what you see in
> [Issues](https://github.com/rkrafted/preflight-vortex/issues).

## What you get

- Three checks in Vortex's health check page: **frameworks**, **environment**, **logs** — each with a **Fix**
  button when Preflight knows a safe fix
- A **Preflight** page in the game's menu: the verdict, "What to do", a patch-day board, and buttons for
  *Install core frameworks* and *Undo last fix*
- When you press Play and the setup is blocked, Vortex asks **Cancel launch** or **Launch anyway**

## Install (step by step)

1. Download `preflight-….exe` from the [Preflight releases](https://github.com/rkrafted/preflight/releases) and rename it to
   `preflight.exe`.
2. Download this add-on: the green **Code** button above → **Download ZIP**. Unzip it.
3. Put `preflight.exe` inside the unzipped folder's `src` folder, next to `index.js`.
4. Open the folder `%APPDATA%\Vortex\plugins` (paste that into the Explorer address bar). Create a folder
   named `preflight-vortex` there and copy `info.json` and everything inside `src` into it.
5. Open a command window in that folder (click the address bar, type `cmd`, Enter) and run
   `preflight rules update` once to download the compatibility rules.
6. Restart Vortex and select Cyberpunk 2077.

To remove it, delete the `preflight-vortex` folder and restart Vortex.

## Hooks

| Hook | Behaviour |
|---|---|
| `registerHealthCheck` ×3 | `preflight-frameworks` (`scan`), `preflight-environment` (`scan`), `preflight-logs` (`diagnose`); only runs for `cyberpunk2077` |
| health-check `fix` | re-scans and runs only the fixes the findings name (`fix.fix_id`), in catalogue order |
| `registerStartHook` | before the game launches: on a blocking verdict asks "Cancel launch / Launch anyway"; never blocks when the binary is missing or errors |
| `onAsync('did-deploy')` | maps the profile id to its game; writes the lockfile, or shows a notice when the deployed loadout is blocked |
| `registerMainPage('Preflight')` | verdict, "What to do" with Fix buttons, patch-day board, chains, Install core, Undo last fix |
| `registerAction` (mod icons) | "Preflight report" dialog with "Undo last fix" |

Exit codes are mapped as documented: `0` passed, `1` warning, `3` failed, `2` error (reported as a
failed check, never as a launch block).

**Why the gate is on launch, not deploy:** Vortex 2.9 runs `will-deploy` handlers through `emitAndAwait`,
which catches a handler's error and deploys anyway, so no extension can stop a deploy. Start hooks can
stop a launch.

## Tests

```
npm test
```

Pure functions and hook wiring against Vortex 2.9's real call shapes (profile ids, `onAsync`, start
hooks). The sideload itself is a rig check on the owner's Windows box.
