# Agar.io Bot + Food Radar

This repository keeps the editable source files separate and builds one combined Tampermonkey userscript.

## Install the combined userscript

Open this URL in a browser with Tampermonkey installed:

https://raw.githubusercontent.com/CuteDevNya/agar.io-bot/main/dist/agar-io-bot.user.js

Tampermonkey should offer to install **Agar.io Bot + Food Radar**.

If you previously installed the separate Food Bot and Food Radar scripts, disable those old individual scripts before enabling the combined one. Otherwise both copies can run simultaneously.

## Controls

- **B** — enable/disable the bot.
- **H** — toggle hunting. Hunting starts enabled and is continuously evaluated alongside food collection; turn it off only to focus exclusively on food.
- **J** — toggle auto-split attacks. Auto-split starts enabled but only attempts an attack when size, distance, cooldown, and target checks qualify. If the current game build does not expose `core.split()`, hunting still works but auto-split cannot activate.
- **Reload Agar.io** after installing or updating.

## Bot abilities (0.6.0)

- Food collection and food-cluster scoring.
- Continuous opportunistic hunting: the bot compares safe prey against available food every tick instead of treating hunting as a separate mode.
- Threat assessment and evasive movement around larger cells, with virus avoidance taking priority over chasing prey or food.
- Predictive aiming at eligible prey.
- Automatic split attacks when an eligible prey target is sufficiently close and the current game build exposes the split function.
- Target stability and canvas-transform probe throttling to reduce unnecessary work.

The bot has one movement aim point, so it cannot physically steer toward food and prey in different directions at the exact same moment. It scans both types of targets continuously and chooses the most useful action; immediate danger takes priority. These behaviours are heuristics and do not guarantee survival or a successful attack.

## Source files

- `src/food-radar.js`: packet tracker, food radar, and canvas-transform probe.
- `src/food-bot.js`: bot decisions, target selection, danger evaluation, and mouse control.
- `VERSION`: version of the combined release.
- `dist/agar-io-bot.user.js`: generated installable userscript.
- `dist/agar-io-bot.meta.js`: metadata used for update checks.
- `.github/workflows/build-userscript.yml`: rebuilds the combined file when source or version changes.

## Publishing an update

Edit the files under `src/` and increase `VERSION` (for example, to `0.7.0`). Push the changes to `main`. GitHub Actions rebuilds the combined userscript and checks JavaScript syntax automatically.

Tampermonkey checks for updates according to its configured update interval. Once it has installed the new version, reload Agar.io to run it.
