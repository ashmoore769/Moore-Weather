# Moore Weather dashboard 1.4

Prepared 27 November 2026 (Australia/Brisbane).

## Scope

This release redesigns the existing private dashboard. It changes presentation,
responsive composition, graph dimensions, labels, and the order of dialog content.
It preserves the station collectors, authentication, stored readings, financial
calculations, history gap handling, and notification rules. No database migration
or hosting change is required.

The six primary weather readings and the next 24 hours of forecast now share the
first desktop view. Home Solar follows immediately. SkyCam and radar share a row
on wide screens; supporting measurements and Soil Profile share the next row.
Station Power and Yard Power are paired where space permits. Narrow screens keep
the same content in one reading order, using two columns for the main readings.

Each reading has one DOM element and retains its existing data and history
binding. Portrait/landscape preferences now change only the CSS composition;
switching layout no longer moves live sensor nodes between containers.

The header explicitly describes station freshness. Active collection problems
and device notification state appear first in Alerts & status. Archive gaps,
diagnostics and notification rules remain available in labelled disclosures.
The history viewer presents the graph before advanced date/resolution controls.

Expected zero charging with measured zero solar or inadequate panel voltage is
neutral. This uses sensor readings rather than an assumed daylight schedule.
Positive charging retains the established comparison with load current.

## Validation

Run `npm run check` and `npm test` for offline syntax, asset, parsing, history,
presentation, finance, reliability and security regressions. Existing browser
gates retain data/interaction/overflow checks and use the new graph and layout
dimensions.

`npm run dev` launches a separate, read-only fixture preview. Its sample-data
label and synthetic camera/radar imagery are confined to that preview server;
the production server still runs `node server.js`. See
[preview modes](../tools/preview/README.md).

Visual review covers desktop Landscape, desktop Portrait, narrow viewport widths,
history/alert dialogs, chart controls, and healthy, stale, partial and unavailable
feeds. Browser zoom is useful for checking narrow CSS widths and high zoom; it
does not replace an actual iPhone/Safari test.

## Preserved release

The GUI before this redesign is version **1.3.23**:

- Git commit: `a9d34f5c47e2b45458f066443a5252cf941b9b13`
- Preservation branch: `rollback/gui-before-redesign-20261127`
- Render deploy: `dep-dbv6cke1egvs73ermbdg`
- Render service: `srv-cv6nrnt6l47c73da0tcg`
- Service URL: <https://moore-weather.onrender.com/>

The redesign is one commit, preserved on `release/gui-v1.4.0`, so its application
changes can be reversed together. Keep both preservation branches at their
original commits.

## Permanent rollback

From a clean checkout of the latest main branch:

```bash
git fetch origin main release/gui-v1.4.0 rollback/gui-before-redesign-20261127
git switch main
git pull --ff-only origin main
git revert --no-edit origin/release/gui-v1.4.0
git push origin main
```

Review and resolve any conflicts if later work has changed the same files. Do not
force-push main or replace unrelated newer commits. Render's existing automatic
deployment follows the new revert commit. Wait for that exact commit to become
live, then reload the dashboard and verify the restored GUI and fresh readings.
This code rollback does not restore, overwrite or delete the persistent database.

For an emergency rollback, Render can reuse the retained build artifact for the
baseline deploy above, if it is still available. A rollback through the Render
Dashboard disables automatic deployments; reconcile main with the intended GUI
before re-enabling them. The persistent disk keeps its current state. This service
uses a disk and may briefly restart during deployment or rollback.

References: [Render deployments](https://render.com/docs/deploys),
[Render rollbacks](https://render.com/docs/rollbacks).
