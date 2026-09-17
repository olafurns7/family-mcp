---
target: Bilingual landing page copy and mobile usability
total_score: 32
max_score: 36
na_heuristics: 7
p0_count: 0
p1_count: 0
target_identity: "apps/landing/src/components/Landing.astro"
target_fingerprint: "sha256:32445cdf9a040352d603a3069110ea40588963539d74ff8a70781e0edd9f8f64"
target_path: apps/landing/src/components/Landing.astro
timestamp: 2026-09-17T09-58-18Z
slug: src-components-landing-astro
closed: true
---
Method: dual-agent (A: /root/critique_design · B: /root/critique_evidence)

Target: `src/components/Landing.astro`, English and Icelandic routes. This critique covers the local page after the initial Icelandic rewrite, removal of platform/runtime labels and correction to IS, before the final copy and mobile-control refinements.

## Design specificity

The four color lanes and visible installers suit this small collection of Icelandic services. The composition feels intentional and is easy to scan. Keep it. The remaining opportunity is less repeated text and more comfortable mobile controls.

The independent detector returned zero findings (`[]`, exit 0). Its result agrees with the sound markup foundation but does not detect the copy repetition or touch ergonomics found by the design review. There were no false positives. CSP blocked the browser overlay; native screenshots, DOM, accessibility and interaction checks supplied the browser evidence.

## Design health

| Heuristic | Score | Assessment |
|---|---:|---|
| System status | 4 | Named copy feedback and current language are clear. |
| Familiar language | 3 | Icelandic is direct; English still has promotional phrases. |
| User control | 4 | Ordinary links and selectable commands; no forced flow. |
| Consistency | 4 | The same service and installation pattern in both languages. |
| Error prevention | 3 | Named, pinned installers; small language targets need care. |
| Recognition | 4 | Commands and setup links remain visible. |
| Efficiency | n/a | A small directory does not need shortcuts or customization. |
| Minimalism | 3 | Capability summaries repeat the descriptions. |
| Error recovery | 4 | Clipboard denial selects the command and explains manual copying. |
| Help | 3 | Per-service guides and brief next steps; guides were outside this review. |
| **Total** | **32/36** | **Good (88.9%).** |

## What works

- Familiar service names and consistent color lanes make choosing straightforward.
- Full commands, copy feedback and manual-copy recovery support the actual installation task.
- The revised Icelandic, IS label and removal of runtime detail improve the introduction. Payment limitations and the distinction between local credentials and shared account data remain clear.

## Priority issues

1. **P2: Repeated capability summaries.** `src/components/Landing.astro` renders a second line that largely repeats InfoMentor, Krónan and Domino's descriptions. It adds reading and scrolling without helping the choice. Keep one factual description per service, merging Abler's unique groups and attendance information before removing the shared summary row. Suggested command: `$impeccable distill`.
2. **P2: Small mobile actions.** `src/styles/global.css` reduces copy/setup text to 10px. Language targets measure 32×34px, copy 109×36px and setup about 84×30px. Use at least 12px action text and 44px tap height, plus 44px language-link width. This is a comfort improvement, not a claimed WCAG minimum-target failure. Suggested command: `$impeccable adapt`.

There are no supported P0 or P1 findings. Assessment B independently measured the compact controls; it treated them as optional P3 within the narrower copy-only scope. The combined review uses P2 because these are the landing page's primary mobile actions.

## Cognitive load and emotional journey

All eight cognitive-load checks pass. No required decision presents more than four peer options. Service recognition and successful copy feedback are the useful high points. Repeated content creates avoidable mobile scrolling; the practical next steps provide a clear ending. Keep the sober Domino's payment explanation.

## Persona checks

- **Jordan, first visit:** Setup guides are easy to find. Terminal instructions appear below the service list, a minor ordering observation for this technical audience.
- **Casey, mobile:** Small controls and duplicate summaries are the concrete friction addressed above.
- **Riley, error paths:** Copy denial recovered correctly. This review did not test installation, account login or payment behavior.

## Minor observations

English phrases such as “Now in the conversation” and “A little less app-hopping” are less direct than the revised Icelandic. A Humanizer pass should align their tone while retaining supported capabilities and limitations. The slightly formal Icelandic affiliation notice is understandable and does not justify changing its factual meaning.

Questions skipped: 2 priority issues; both fit the requested page cleanup.
