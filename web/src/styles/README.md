# Stylesheet structure

`../styles.css` is the ordered entry point. Angular resolves its imports at build
time and emits **one** stylesheet; these files do not add browser requests.

| File                    | Responsibility                                           |
| ----------------------- | -------------------------------------------------------- |
| `base.css`              | Element defaults, panels, headings and layout primitives |
| `theme.css`             | Sniper Hunter palette and themed controls                |
| `lists.css`             | Game lists, player cards and platform filters            |
| `match.css`             | Match summary, teams and repeat-opponent cards           |
| `controls.css`          | Search toolbars, toggles and replay upload               |
| `status.css`            | Persistent progress bar and idle animation               |
| `profile.css`           | Player profile and games together                        |
| `sql.css`               | Schema browser, SQL editor and results                   |
| `shell.css`             | Splash screen, update dialog and back-to-top control     |
| `settings-about.css`    | Settings forms, account suggestions and About            |
| `interaction.css`       | Cursor, scrollbar behavior, console and selected states  |
| `responsive.css`        | Shared mobile adjustments                                |
| `map.css`               | Movement map, synchronization, saved maps and tooltips   |
| `replay-responsive.css` | Narrow replay/map controls                               |
| `collapsible.css`       | Shared expandable-section appearance                     |
| `layout.css`            | Final replay layout and responsive sizing constraints    |

The order deliberately preserves the pre-refactor cascade, including responsive
overrides. Do not alphabetize the imports or introduce CSS layers without checking
their effect on specificity. Rules are formatted one declaration per line. Only
identical redundant declarations were removed; differing fallback/override values
remain intentional.

Important layout relationships:

- On desktop, the match summary uses a 2:2:1 grid. The sniper panel's
  `height: 0; min-height: 100%` prevents its list from determining the grid row
  height. Its inner grid scrolls with content-sized rows.
- On stacked layouts, the measured `--match-info-height` limits the sniper panel;
  an empty panel keeps its natural height. Preserve the matching rules in
  `match.css` and `layout.css` together.
- Team avatar rings use shadows so the picture and row sizes do not change.
- Native/custom cursor switching stays global. Map calibration's crosshair is an
  intentional exception.
