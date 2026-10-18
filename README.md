# Agar.io Bot + Food Radar

This repository keeps the editable source files separate and builds one combined Tampermonkey userscript.

## Install the combined userscript

Open this URL in a browser with Tampermonkey installed:

https://raw.githubusercontent.com/CuteDevNya/agar.io-bot/main/dist/agar-io-bot.user.js

Tampermonkey should offer to install **Agar.io Bot + Food Radar**.

If you previously installed the separate Food Bot and Food Radar scripts, disable those old individual scripts before enabling the combined one. Otherwise both copies can run simultaneously.

## Use

- Reload Agar.io after installing or updating.
- Press **B** to enable or disable the bot.
- The radar starts first and exposes its API to the bot.

## Source files

- `src/food-radar.js`: packet tracker, food radar, and canvas-transform probe.
- `src/food-bot.js`: bot decisions, target selection, danger evaluation, and mouse control.
- `VERSION`: version of the combined release.
- `dist/agar-io-bot.user.js`: generated installable userscript.
- `dist/agar-io-bot.meta.js`: metadata used for update checks.
- `.github/workflows/build-userscript.yml`: rebuilds the combined file when source or version changes.

## Publishing an update

Edit the files under `src/` and increase `VERSION` (for example, to `0.4.0`). Push the changes to `main`. GitHub Actions rebuilds the combined files automatically.

Tampermonkey checks for updates according to its configured update interval. Once it has installed the new version, reload Agar.io to run it.
