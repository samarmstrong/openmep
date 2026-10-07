# Manual D friction-rate sizing from a worksheet

A 60-line script that takes the numbers from an ACCA Manual D friction-rate
worksheet and returns round duct sizes. It is here so an HVAC designer can
check it against what their own Manual D software gives for the same inputs.

It ships with the published ACCA worksheet example: a 1200 CFM blower at 0.70
in. w.g., device losses of 0.50, total effective length of 200 ft, friction
rate 0.10. The script reproduces those totals exactly. The brochure's branch
sizes are entered as `softwareDiameterIn` so the last column shows the gap.

## Run it

Needs Node.js 24 or newer.

```sh
git clone https://github.com/samarmstrong/openmep
cd openmep/examples/manual-d-demo
npm install
node demo.mjs                 # the ACCA worksheet
node demo.mjs my-job.json     # your own worksheet
```

Output for the worksheet:

```
Blower ESP            0.70 in. w.g. at 1200 CFM
Device losses         0.50 in. w.g.
Available static (ASP) 0.20 in. w.g.
Longest return  run     80 ft effective (40 ft + 40 ft fittings) to Bedroom 1
Longest supply  run    120 ft effective (65 ft + 55 ft fittings) to Bedroom 3
Total effective length  200 ft
Friction rate (FR)    0.100 in. w.g. per 100 ft

Run                 CFM Round in     fpm      FR  vs. your size
supply trunk       1200       15     978   0.096
Bedroom 1           150        7     561   0.085  oversized (yours 8 in)
Closet               15        3     306   0.075  oversized (yours 4 in)
...
Foyer                80        6     407   0.056  ok (yours 6 in)
Bath 2               40        5     293   0.037  ok (yours 5 in)
return trunk        625       12     796   0.086
Living              275       10     504   0.045
```

## What goes in

`worksheet.json` is the friction-rate worksheet, nothing more:

| Field | Meaning |
|---|---|
| `blower.externalStaticInWg` | External static pressure from the blower table at design CFM |
| `deviceLossesInWg` | Pressure drop of each device in the air path (coil, filter, register, grille, damper, humidifier) |
| `supply.trunk`, `return.trunk` | Trunk length and the equivalent length of its fittings, from Manual D's tables or your own |
| `supply.runs[]`, `return.runs[]` | One line per room: CFM, measured length, fitting equivalent length, and optionally the size your software chose |

Every number is a design input. The script never estimates airflow, static
pressure, or lengths.

## What it does

1. Available static pressure = external static − sum of device losses.
2. Total effective length = longest supply run + longest return run, each
   measured length plus fitting equivalent lengths (the worksheet method).
3. Friction rate = ASP × 100 / TEL, with a warning outside Manual D's 0.06–0.18
   window.
4. Every run is sized at that friction rate for its CFM, rounded up to the next
   standard round size, capped by velocity (supply trunk 1300 fpm, branch
   900, run-out 700; return 1200 / 800 / 600). Those trunk caps are looser
   than the 900 supply / 700 return many designers use; the fpm column shows
   where that matters.
5. If you entered your software's size, it grades it `ok`, `undersized`, or
   `oversized` against the same rule.

## What it does not do

- **No flex-duct correction.** Sizes are for smooth galvanized round. The ACCA
  brochure picks flex sizes, which is why most of its branches come out one
  size larger than the table above. If your work is mostly flex, say so; a
  flex friction correction is the next thing on the list.
- **No fitting catalogue.** You supply equivalent lengths. Manual D's fitting
  tables are ACCA's to publish, not ours.
- **No reducing trunk.** One trunk, one tee, every room a run-out from it. A
  real trunk steps down; that is the next topology to add.
- **No rectangular selection.** The engine grades a rectangular or oval
  section you already have (ASHRAE equivalent diameter) but only proposes
  round sizes.
- **Not a load calculation.** Room CFM comes from your Manual J and S.
- **Not code compliance.** It is a friction-rate sizer with velocity caps.

## Where this comes from

The engine is [`@openmep/hvac-domain`](https://www.npmjs.com/package/@openmep/hvac-domain)
(MIT). The same sizing is available as a command-line tool on a plain JSON
network, as an [MCP server](https://www.npmjs.com/package/@openmep/mcp) for AI
agents, and inside [Pascal Editor](https://github.com/pascalorg/editor) scenes.
The ACCA worksheet it reproduces is the "Manual D calculation" brochure hosted
by AHRI. Tests: `packages/hvac-domain/src/design-friction-rate.test.ts`.

If your software gives a different friction rate or a different size for the
same inputs, please open an issue with the two numbers. That is the whole point.
