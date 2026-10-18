# Agar.io Bot + Food Radar

This repository keeps the editable source files separate and builds one combined Tampermonkey userscript.

## Install the combined userscript

Open this URL in a browser with Tampermonkey installed:

https://raw.githubusercontent.com/CuteDevNya/agar.io-bot/main/dist/agar-io-bot.user.js

Tampermonkey should offer to install **Agar.io Bot + Food Radar**.

If you previously installed the separate Food Bot and Food Radar scripts, disable those old individual scripts before enabling the combined one. Otherwise both copies can run simultaneously.

## Controls

- **B** — enable/disable the bot.
- **H** — toggle hunting mode. The bot can target visible player cells that are sufficiently smaller than your largest cell; if no safe prey is found, it returns to food collection.
- **J** — toggle optional auto-split attacks. This also enables hunting mode. Split attempts are conservative and only occur when the size and on-screen distance thresholds are satisfied. If the current game build does not expose `core.split()`, hunting still works but auto-split cannot activate.
- Reload Agar.io after installing or updating.

## Bot abilities (0.5.0)

- Food collection with stable target selection.
- Risk assessment and evasive movement around larger cells.
- Virus avoidance.
- Optional hunting and predicted aiming at safely smaller visible players.
- Optional auto-split attack, disabled by default.
- Short canvas-transform probe throttling to reduce frame work while preserving the live food-alignment method.

These behaviors use heuristics from the visible cell data; they do not guarantee survival or a successful attack.

## Source files

- `src/food-radar.js`: packet tracker, food radar, and canvas-transform probe.
- `src/food-bot.js`: bot decisions, target selection, danger evaluation, and mouse control.
- `VERSION`: version of the combined release.
- `dist/agar-io-bot.user.js`: generated installable userscript.
- `dist/agar-io-bot.meta.js`: metadata used for update checks.
- `.github/workflows/build-userscript.yml`: rebuilds the combined file when source or version changes.

## Publishing an update

Edit the files under `src/` and increase `VERSION` (for example, to `0.6.0`). Push the changes to `main`. GitHub Actions rebuilds the combined userscript and checks JavaScript syntax automatically.

Tampermonkey checks for updates according to its configured update interval. Once it has installed the new version, reload Agar.io to run it.
