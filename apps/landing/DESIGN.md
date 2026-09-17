---
name: Family MCP
description: An approachable timetable of local MCP connections.
colors:
  green: "#076b67"
  ink: "#233b36"
  muted: "#526660"
  paper: "#f8faf7"
  line: "#d9e3dc"
  focus: "#af3c18"
  white: "#ffffff"
  abler-secondary: "#d5efea"
  mint: "#ddf0e8"
  mint-ink: "#174c40"
  mint-secondary: "#356454"
  yellow: "#f5cf82"
  yellow-ink: "#483716"
  yellow-secondary: "#655027"
  peach: "#efbaa4"
  peach-ink: "#573427"
  peach-secondary: "#754638"
  copy-hover: "#e4f1e9"
  language-hover: "#e5eee6"
typography:
  display:
    fontFamily: "'Archivo Variable', sans-serif"
    fontSize: "clamp(2.65rem, 5.3vw, 4.6rem)"
    fontWeight: 620
    lineHeight: 1.075
    letterSpacing: "-0.037em"
  headline:
    fontFamily: "'Archivo Variable', sans-serif"
    fontSize: "32px"
    fontWeight: 630
    lineHeight: 1.2
    letterSpacing: "-0.03em"
  body:
    fontFamily: "'Archivo Variable', sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.65
  label:
    fontFamily: "'Archivo Variable', sans-serif"
    fontSize: "12px"
    fontWeight: 580
  language:
    fontFamily: "'Archivo Variable', sans-serif"
    fontSize: "12px"
    fontWeight: 650
  command:
    fontFamily: "ui-monospace, 'SFMono-Regular', Consolas, 'Liberation Mono', monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.65
rounded:
  control: "5px"
  enclosure: "8px"
  command: "9px"
  lane: "14px"
spacing:
  compact: "8px"
  inline: "12px"
  lane-gap: "14px"
  inset-mobile: "22px"
  group: "24px"
  column: "50px"
components:
  copy-button:
    backgroundColor: "transparent"
    textColor: "{colors.mint-ink}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "7px 8px"
  copy-button-hover:
    backgroundColor: "{colors.copy-hover}"
  copy-button-copied:
    backgroundColor: "{colors.green}"
    textColor: "{colors.white}"
  language-switch:
    rounded: "{rounded.enclosure}"
    padding: "3px"
  language-link:
    typography: "{typography.language}"
    rounded: "{rounded.control}"
  language-link-current:
    backgroundColor: "{colors.green}"
    textColor: "{colors.white}"
  language-link-hover:
    backgroundColor: "{colors.language-hover}"
  command-box:
    backgroundColor: "{colors.white}"
    textColor: "{colors.ink}"
    rounded: "{rounded.command}"
    padding: "8px 14px 15px"
---

# Design System: Family MCP

## Overview

**Creative North Star: "The Icelandic swimming-pool timetable"**

Confident Archivo lettering and flat color bands make a small collection easy to
read. Deep pool green anchors a clean paper ground; mint, yellow and peach give
the services distinct, friendly identities without illustration or texture.

The controls are compact and direct. White command surfaces separate executable
text from the descriptive content, and English and Icelandic share the same
layout and visual hierarchy.

**Key Characteristics:**

- Flat service colors and a shared reading rhythm.
- Archivo for interface text; native monospace for commands.
- Visible installation text, language links and copy feedback.

## Colors

### Primary

Pool green carries the wordmark, display headings, Abler lane, current language
and successful copy state. White text belongs on those green surfaces.

### Secondary

Mint identifies InfoMentor, yellow identifies Krónan, and peach identifies
Domino’s. Each lane uses its recorded ink and secondary-text pair; Abler uses its
light secondary tone. The two pale hover colors belong to the copy and language
controls respectively.

### Neutral

Paper is the page ground; white is the command surface. Ink carries body text,
muted carries supporting copy, and line supplies quiet navigation/footer borders.
The rust focus color remains visible on light surfaces; Abler switches its lane
focus to yellow, while its white command box retains rust.

**The Paired Color Rule.** Keep each service background with its recorded main
and secondary text colors.

## Typography

Self-hosted Archivo Variable supplies display, body and controls. Native
monospace is reserved for commands. The desktop roles are normative above;
the scale is tuned by role rather than a fixed ratio.

- Display uses balanced two-line text. At 700px and below it becomes
  `clamp(2.15rem, 6.6vw, 2.8rem)` with 1.13 leading and `-0.035em` tracking.
- Service headlines become 28px at 960px and 29px at 700px. The closing heading
  uses 30px, weight 580, 1.2 leading and `-0.025em` tracking; mobile uses 26px.
- Introductory copy steps from 19px/1.6 to 17px at 960px and 16px/1.65 at 700px.
  Service descriptions use the body role, limited to 47ch on wider screens.
- Commands become 11px at 700px; copy and setup labels stay 12px at every width.
  Versions use tabular figures.

## Layout

The centered container is `min(1200px, calc(100% - 96px))`. At 960px its side
gutters become 28px; at 700px they become 16px. Service lanes and the closing
section share a `0.92fr 1.08fr` grid, becoming one column at 700px.
The introduction sits 32px below the headline, reduced to 22px at 700px.

Lanes use 36px by 38px padding and a 50px column gap. At 960px this becomes
30px by 26px with a 24px gap; mobile uses `26px 22px 22px` padding and a 22px
internal gap. Space between lanes becomes 12px on mobile. Descriptions precede
commands at every width; commands wrap within their available width.

## Elevation & Depth

The page, lanes and command surfaces are flat. Color and spacing establish depth.
Only the temporary copy-status message has a soft shadow
(`0 5px 18px #0a302426`); the sidecar records this existing exception.

**The Flat Surface Rule.** Keep service lanes and command surfaces free of shadows.

## Shapes

The radius roles above progress from compact controls to broader service lanes.
Language navigation has a thin outline; command surfaces rely on their white
fill. The preview badge uses a small 4px radius and a thin border. Icons are
inline SVG strokes, including the repeated horizontal bars of the wordmark.

## Components

### Service lanes and command boxes

Each lane pairs a service heading, release link and description with a white
command box, authentication cue and setup link. The preview lane adds a badge
and a full-width limitation separated by a thin rule. Command boxes reduce their
horizontal padding to 12px on mobile. Their focusable text uses preserved wrapping
and can be selected manually. Setup links have a 44px minimum height at every width.

### Copy button

The quiet control has a 117px minimum width and 44px minimum height; mobile
reduces minimum width to 109px. Hover uses a pale fill. Successful copying uses
green, changes the label, disables the button for 1.8 seconds, and announces the
service name in a polite live status for 3.5 seconds. Failure selects the visible
command and shows manual-copy guidance. Only color and background transition
(`160ms ease-out`); reduced-motion preference removes transitions.

### Navigation and focus

The EN and IS language pair remains visible, with the current page indicated by
both `aria-current` and green fill. Links are at least 44px by 44px at every width.
Text links underline on hover. Keyboard focus uses a 3px outline
with a 5px offset; the skip link appears when focused.

## Do's and Don'ts

### Do:

- **Do** preserve the service palette pairings and shared lane structure.
- **Do** let command text wrap and keep keyboard focus visible.
- **Do** retain the same controls and hierarchy in English and Icelandic.

### Don't:

- **Don't** add shadows to service lanes or command boxes.
- **Don't** use monospace for display headings or descriptive prose.
- **Don't** hide command text behind the copy action.
