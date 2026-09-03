---
document_id: apple-aqua-2009-2010-ui-design-spec
title: Apple Aqua, Snow Leopard, and iTunes 2009–2010
subtitle: Historical research and an implementation-ready UI design language
version: 1.0.0
date: 2026-09-03
format: utf-8-markdown
status: implementation-ready
primary_profile: snow-leopard-itunes-9
optional_profiles:
  - classic-aqua-gel-accent
  - itunes-10-transition
intended_readers:
  - Claude Code
  - Claude Opus 5
  - Fable 5
  - UI designers
  - frontend engineers
requirement_terms:
  MUST: mandatory for style fidelity or usability
  SHOULD: expected unless product constraints justify a documented exception
  MAY: optional enhancement
historical_scope:
  core: 2009-2010
  context: 2000-2008
implementation_status:
  documented_history: cited
  reconstruction_tokens: approximate
  code_samples: framework-agnostic starting points
---

# Apple Aqua, Snow Leopard, and iTunes 2009–2010

## Historical research and an implementation-ready UI design language

This file is both a research report and a build specification. It explains what Apple’s interface language actually looked and behaved like around 2009–2010, why the period is often misremembered as uniformly “gel,” and how to recreate the effect without producing a generic glossy-web or modern glassmorphism pastiche.

The default target is **Mac OS X 10.6 Snow Leopard structure with iTunes 9 media-app chrome**. That combination is the clearest answer to “2009 Apple Aqua gel”: restrained gray window architecture, cool-blue navigation, dense white data views, small colorful icons, prominent physical playback controls, and selective pools of luminous Aqua blue.

If an implementation agent reads only the next section, it should still make sound decisions. For full fidelity, it must read the entire file before editing code.

---

## 1. Agent operating contract

### 1.1 Instruction priority

When using this file to design or implement a product, apply these priorities in order:

1. **Preserve product function, content, and data integrity.** Style must not break workflows.
2. **Preserve accessibility and input semantics.** Historical visual compactness is not permission to create tiny touch targets, invisible focus, or unlabeled icon buttons.
3. **Choose one coherent era profile.** Default to `snow-leopard-itunes-9`. Do not casually mix iTunes 10’s gray/vertical-window-control changes into iTunes 9 chrome.
4. **Build the hierarchy before the gloss.** Window regions, navigation, tables, controls, state, and spacing establish the style. Gel highlights are a finishing layer.
5. **Use the supplied reconstruction tokens consistently.** Do not improvise a different blue or shadow for every component.
6. **Use original product names, artwork, and icons.** Do not copy Apple logos, iTunes art, application icons, or other proprietary assets.
7. **Document any deliberate deviation.** State why it was necessary and which requirement it replaces.

### 1.2 Mandatory profile declaration

Before implementation, write one line in the project plan or change summary:

```text
AQUA_PROFILE=snow-leopard-itunes-9
```

Allowed values:

- `snow-leopard-itunes-9` — **default and recommended**; 2009 late Aqua with custom media chrome.
- `classic-aqua-gel-accent` — stronger 2000–2004 gel on selected controls, while retaining the 2009 information architecture.
- `itunes-10-transition` — 2010 gray, more recessed, less colorful, and more vertically spacious.

Do not infer `itunes-10-transition` merely because the user mentions “2010.” Use it only when the user asks for iTunes 10 specifically, requests the vertical traffic-light arrangement, or explicitly prefers its grayscale transition.

### 1.3 Repository placement and invocation

Place this file at either the repository root or `docs/design/APPLE_AQUA_2009_2010_UI_DESIGN_SPEC.md`. Add one durable instruction to the repository’s agent guidance, for example:

```text
For UI work, read docs/design/APPLE_AQUA_2009_2010_UI_DESIGN_SPEC.md completely and treat its MUST requirements as the visual source of truth.
```

The implementation requirements, tokens, examples, and checks are self-contained. An agent does not need web access to apply them; the links support historical verification. If the host repository has a higher-priority instruction that conflicts with this file, the agent must report the conflict rather than silently choosing one.

### 1.4 Definition of success

An implementation succeeds when a viewer can recognize the **late-2000s Mac media-application grammar before noticing the gradient effects**. At minimum it must have:

- one framed desktop-style window or clearly bounded app shell;
- a unified gray titlebar/toolbar region;
- familiar primary controls with obvious affordance;
- a persistent, cool-blue source list or equivalent primary navigator;
- a dominant white content region using dense rows, columns, grids, or artwork;
- restrained blue selection, focus, progress, and default-action states;
- compact Lucida Grande–like typography and consistent 4/8/12/20 spacing;
- visible hover, pressed, selected, focused, disabled, inactive-window, and busy states;
- original icons with a consistent top light source and small-size pixel discipline;
- no modern frosted-glass cards, giant corner radii, floating pill islands, or excessive blur.

---

## 2. Executive finding: Aqua in 2009 was not “everything glossy”

Apple introduced Aqua in 2000 as a luminous, semi-transparent, animated interface, backed by Quartz anti-aliasing and compositing. That is the origin of the famous translucent scrollbars, blue gel default buttons, liquid progress bars, soft shadows, and visibly clickable controls. [Apple’s launch announcement](https://www.apple.com/newsroom/2000/01/05Apple-Unveils-Mac-OS-X/) is unusually explicit about those qualities.

But the requested 2009–2010 period was already late Aqua. Mac OS X 10.5 Leopard had removed brushed-metal windows, unified the titlebar and toolbar, stretched content cleanly to the window edges, and standardized a gray-gradient frame around mostly white content. Apple’s 2008 Human Interface Guidelines define that structure directly. [Apple HIG: Introduction](https://leopard-adc.pepas.com/documentation/UserExperience/Conceptual/AppleHIGuidelines/XHIGIntro/XHIGIntro.html) [Apple HIG: Windows](https://leopard-adc.pepas.com/documentation/UserExperience/Conceptual/AppleHIGuidelines/XHIGWindows/XHIGWindows.html)

Snow Leopard in 2009 refined Leopard rather than replacing its visual system. Apple presented the release as hundreds of improvements, and contemporary analysis likewise observed visual continuity, with more perceived contrast, revised Dock menus, Dock Exposé, many fades, and a dark media-specific exception in QuickTime X. [Apple’s Snow Leopard announcement](https://www.apple.com/newsroom/2009/06/08Apple-Unveils-Mac-OS-X-Snow-Leopard/) [Ars Technica’s contemporary Snow Leopard review](https://arstechnica.com/gadgets/2009/08/mac-os-x-10-6/)

iTunes was both the canonical demonstration of Apple’s user-centered information architecture and a frequent visual outlier. Apple’s own HIG praised its large sortable songs pane, smaller playlists/collections pane, physical-player transport metaphors, and standard search field. Yet reviewers noted that iTunes 9 used a lighter, smoother, subtly shinier custom chrome than other Snow Leopard applications. [Apple HIG: Human Interface Design](https://leopard-adc.pepas.com/documentation/UserExperience/Conceptual/AppleHIGuidelines/XHIGHIDesign/XHIGHIDesign.html) [Ars Technica on iTunes 9](https://arstechnica.com/gadgets/2009/09/hands-on-with-itunes-9/) [GoSquared’s iTunes 8/9 comparison](https://www.gosquared.com/blog/itunes-9-interface-changes)

The practical conclusion is simple:

> **Build a disciplined gray-and-white desktop application with blue navigation and dense information. Apply gel only where state, action, movement, or physical control benefits from luminosity.**

---

## 3. Period map: related languages, not one frozen style

| Profile | Historical anchor | Structural character | Surface character | Best use |
|---|---|---|---|---|
| Classic Aqua foundation | Mac OS X 10.0–10.3, 2000–2003 | Simple windows and standard controls | Strong blue gel, translucent candy, deep specular highlights, pulsing default button | Accent reference; playful utilities; a stronger nostalgic option |
| Leopard system Aqua | Mac OS X 10.5, 2007–2009 | Unified titlebar/toolbar, source list, white content, bottom bar | Neutral gray chrome, blue selection, diminished brushed metal, restrained standard controls | General desktop app shell |
| Snow Leopard | Mac OS X 10.6, 2009–2010 | Leopard structure plus Dock Exposé and refinements | Slightly higher perceived contrast; system continuity; selective dark media overlays | OS-level context and default app shell |
| iTunes 8 | 2008–2009 | Transport + display + search; source list; table, Grid, Cover Flow; optional Genius rail | Darker/flatter toolbar than iTunes 9; colorful small icons; artwork-forward views | Darker late-Aqua media library |
| iTunes 9 | 2009–2010 | Same media skeleton, more browsing and device-management modes | Lighter curved toolbar gradient; subtly blurred/shiny transport; pale-blue navigation and rows | **Default target for this guide** |
| iTunes 10 transition | 2010–2012 | Denser top edge, Album List, simplified sidebar controls | Vertical traffic lights, monochrome gray icons, blue-gray sidebar, recessed/bezel-less actions, more white space | Specific 2010 recreation, not generic Aqua |

The borders between these profiles matter. The original 2001 Aqua push button was a 20-pixel rounded rectangle, visually clear when ordinary, blue and pulsing when it was the default action. By 2009, that intense liquid vocabulary survived most strongly in stateful or special controls; it was no longer the material of every application surface. The archived [2001 Aqua HIG](https://archive.org/details/apple-hig) and the [2008 control guidelines](https://leopard-adc.pepas.com/documentation/UserExperience/Conceptual/AppleHIGuidelines/XHIGControls/XHIGControls.html) make that evolution visible.

---

## 4. Historical analysis

### 4.1 Aqua’s original proposition: software should look tangible and alive

Early Aqua used optical cues that made a flat screen feel populated by real, touchable things:

- **Specular highlights** suggested a polished transparent shell.
- **Dark lower gradients and inner shadows** suggested depth and pressure.
- **Soft cast shadows** placed objects above other surfaces.
- **Translucency** hinted at material rather than merely filling a rectangle.
- **Animation** connected cause and effect: windows minimized toward the Dock; sheets emerged from their parent; default buttons pulsed; application icons bounced.
- **Saturated color was semantic.** Blue indicated the selected, active, focused, progressing, or default element rather than becoming a universal background.

This was not decoration separated from usability. Apple described Aqua as an overall appearance *and behavior*, with consistent controls, anti-aliased drawing, shadow, transparency, careful color, and animated status communication. [Apple HIG: Introduction](https://leopard-adc.pepas.com/documentation/UserExperience/Conceptual/AppleHIGuidelines/XHIGIntro/XHIGIntro.html)

The key design move was **affordance through modeled volume**. A button looked pressable because it had a rim, convex highlight, bottom depth, and a distinct pressed response. Apple’s guidelines explicitly linked three-dimensional Aqua buttons with discoverability: if something is clickable, it should look clickable. [Apple HIG: Human Interface Design](https://leopard-adc.pepas.com/documentation/UserExperience/Conceptual/AppleHIGuidelines/XHIGHIDesign/XHIGHIDesign.html)

### 4.2 Leopard disciplined the candy

Leopard’s visual consolidation is the most important background to 2009. Earlier Mac OS X applications mixed pinstriped Aqua, brushed metal, custom shells, drawers, and multiple toolbar treatments. In 10.5 Apple moved toward a more coherent window model:

- titlebar and toolbar became a single continuous gray-gradient frame;
- brushed metal was retired;
- the window body reached the left and right edges rather than being wrapped in side frame material;
- content views were white, while surrounding body areas were light gray;
- navigation used a blue source list separated by a narrow splitter;
- bottom bars repeated the gray window-frame material for subordinate actions;
- toolbars were reserved for frequent commands and maintained corresponding menu commands.

That framework made the interface feel clean and machine-like without becoming flat. Bevels were thin, gradients quiet, and shadows purposeful. The window itself had depth; its content panes did not need to become individual raised cards. This distinction is crucial for a faithful recreation. [Apple HIG: Windows](https://leopard-adc.pepas.com/documentation/UserExperience/Conceptual/AppleHIGuidelines/XHIGWindows/XHIGWindows.html)

### 4.3 Snow Leopard: refinement, contrast, and context-specific experiments

Snow Leopard retained Leopard’s window grammar. Its user-facing changes were concentrated in refinement and behavior:

- Finder became more responsive and kept its sidebar, toolbar, view controls, search pill, and white/striped data views.
- Dock Exposé connected an application icon to the windows it owned.
- Stacks gained navigable grid behavior.
- Dock menus received a dark, translucent, rounded treatment with a restrained gradient selection.
- many appearances, disappearances, and state changes used fades;
- QuickTime X broke from the generic gray shell with a frameless black player and floating transport overlay, demonstrating that media could justify a context-specific dark surface.

Apple’s illustrated [*Welcome to Snow Leopard* guide](https://cdsassets.apple.com/live/6GJYWVAV/user/ma1170_welcome_to_snow_leopard.pdf) is especially useful visual evidence: Finder’s blue sidebar, black Cover Flow stage, white table, unified toolbar, rounded search field, small colored icons, scrollbars, and traffic lights coexist in one compact window.

The lesson is not to make all media interfaces dark. It is to let **content context choose the content canvas** while preserving clear control hierarchy. A library manager can be light and data-dense; an immersive player can go black and hide secondary chrome until interaction.

### 4.4 iTunes 8: artwork becomes navigation

iTunes 8’s major visual contribution was Grid view, which replaced “List with Artwork” as a primary mode. Album, artist, genre, or composer collections became artwork tiles; hover could reveal playback or scrub through associated covers. Genius added both an instant playlist action and an optional recommendation sidebar. [Macworld’s 2008 first look](https://www.macworld.com/article/192388/itunes8firstlook.html) [Apple’s iTunes 8 announcement](https://www.apple.com/newsroom/2008/09/09Apple-Announces-iTunes-8/)

This created three complementary ways to understand a library:

1. **List:** precise, sortable, metadata-dense.
2. **Grid:** visual grouping and recognition through cover art.
3. **Cover Flow:** a physical browsing metaphor based on a centered object, perspective, movement, and reflection.

The modes were not just alternate skins. Each served a different mental operation: lookup, scan, or browse. That is why a modern recreation should not force every data type into the same card grid.

### 4.5 iTunes 9: the period’s most useful media-app target

iTunes 9 preserved a remarkably legible skeleton despite its growing feature set:

- **upper left:** previous, play/pause, and next—large familiar transport controls;
- **upper center:** an inset information/LCD panel for title, artist, time, progress, or synchronization status;
- **upper right:** volume, view or mode controls, and a rounded search field;
- **left rail:** grouped sources such as Library, Store, Devices, Shared, Genius, and Playlists;
- **main field:** table, browser columns, artwork grid, Cover Flow, Store, or device management;
- **bottom edge:** add/remove, shuffle/repeat, status, Genius, speakers/output, or other subordinate actions.

Apple’s press release emphasized a redesigned Store, iTunes LP, Home Sharing, Genius Mixes, improved syncing, and direct iPhone screen arrangement. Those product additions increased the need for persistent navigation and view switching. [Apple’s iTunes 9 announcement](https://www.apple.com/newsroom/2009/09/09Apple-Premieres-iTunes-9/)

The surface treatment was subtly custom. Contemporary comparisons reported a toolbar five pixels shorter than iTunes 8, a lighter and more visibly curved vertical gradient, playback buttons with a more sophisticated gradient and subtle blur, a lighter volume control, a slightly lighter blue sidebar, and refined colorful icons at roughly 15-pixel scale. Another period account described white headers, extremely pale blue browse columns, and alternating light-blue stripes in the track list. [GoSquared’s direct comparison](https://www.gosquared.com/blog/itunes-9-interface-changes) [Ars Technica’s iTunes 9 review](https://arstechnica.com/gadgets/2009/09/hands-on-with-itunes-9/)

This was “shiny” in a controlled sense: **tight radii, thin rims, tiny highlights, and small pools of saturation**. It was not a screen full of blue bubbles.

### 4.6 iTunes 10: a transition toward flatter, grayer utility

iTunes 10 is historically important because it breaks several system expectations:

- the window title disappeared;
- red, yellow, and green controls became smaller and vertical;
- the blue sidebar turned blue-gray;
- colorful source icons became uniformly gray;
- disclosure triangles gave way to hover-revealed Show/Hide text;
- Album List used more whitespace and selectively showed artwork;
- bottom-bar buttons sat directly on the gray status bar with reduced bezels;
- grid-header controls became recessed rounded segments.

The contemporary Macworld account even quantified the looser density: 24 tracks occupied 410 vertical pixels in iTunes 9 and 458 in iTunes 10. [Macworld’s iTunes 10 first look](https://www.macworld.com/article/207495/iutnes10_1stlook.html)

Those changes make iTunes 10 useful as a **transitional profile**, but a poor generic template for “Aqua gel.” If used, apply the whole cluster: grayscale icons, blue-gray navigation, recessed controls, extra row spacing, and vertical traffic lights. Applying only the vertical traffic lights to an otherwise colorful iTunes 9 recreation produces a costume rather than a coherent period design.

### 4.7 Why the interface felt like Apple

The strongest family resemblance came from decisions deeper than color:

- **A clear mental model.** Songs lived in a library; playlists behaved like real collections; transport controls resembled physical players.
- **One dominant object.** The content table or artwork view received most of the area; toolbars and sidebars stayed subordinate.
- **Persistent orientation.** Source selection, window title, display status, and view mode told the user where they were.
- **Direct manipulation.** Users dragged tracks, playlists, apps, covers, columns, splitters, and scrubber thumbs.
- **Immediate feedback.** Selection changed visibly, buttons depressed, progress moved, and operations exposed status.
- **Compact consistency.** Repeated baselines, narrow rows, small icons, and predictable 8/12/20-pixel spacing kept dense tools calm.
- **Color discipline.** Blue usually meant active; gray supported; white contained data; color-rich artwork and icons carried identity.
- **Forgiveness and redundancy.** Important toolbar actions also existed in menus, destructive operations were separated, and reversible exploration was encouraged.

These principles are directly aligned with Apple’s contemporary guidance on mental models, simplicity, discoverability, direct manipulation, feedback, consistency, and forgiveness. [Apple HIG: Human Interface Design](https://leopard-adc.pepas.com/documentation/UserExperience/Conceptual/AppleHIGuidelines/XHIGHIDesign/XHIGHIDesign.html)

---

## 5. The visual grammar

### 5.1 The hierarchy of materials

Use a small, ordered material system. From back to front:

1. **Desktop/backdrop:** textured image, muted color, or neutral work area. It is scenery, not a translucent blur layer.
2. **Window frame:** medium-to-strong cast shadow, thin dark outline, small top corner radius.
3. **Unified titlebar/toolbar:** light-to-medium neutral vertical gradient with a top highlight and lower separator.
4. **Navigation source list:** cool blue-gray plane; slightly darker at the lower edge; narrow right divider.
5. **Content canvas:** white or near-white; flat and dominant.
6. **Data structure:** white headers, faint separators, optional pale-blue alternating rows.
7. **Controls:** neutral clear/silver by default; dimensional but compact.
8. **Active state:** saturated Aqua-blue selection, focus ring, progress fill, or default action.
9. **Content identity:** original album art, thumbnails, and small colorful icons.

Do not give every layer a shadow. The outer window, popovers/menus, floating panels, and controls that genuinely sit above a surface may cast shadows. Rows, ordinary panels, and content sections should usually be separated by lines, spacing, or tonal changes.

### 5.2 Shape language

- Window corners: modest, approximately 6–8 px at desktop scale.
- Body panes: square or 0–3 px; they meet window edges cleanly.
- Standard push buttons: pill-like because their height is small, not because every action is a giant capsule.
- Search fields: fully rounded ends.
- Toolbar segmented controls: compact 3–5 px rounding or a capsule wrapper.
- List selection: near-rectangular with 2–4 px rounding only when inset; edge-to-edge source-list selection may be square.
- Artwork: 0–4 px rounding; period album covers were largely square.
- Menus and floating overlays: 5–8 px rounding, clear border, one shadow.

Avoid the modern pattern of a rounded card inside a rounded card inside a rounded page. Late Aqua relied on **window regions and split views**, not a pile of independent cards.

### 5.3 Line and border language

Thin edges do a great deal of work:

- use 1 px outer borders with a dark neutral or desaturated blue;
- add a 1 px inner top highlight to imply a polished surface;
- use a darker 1 px lower separator under the toolbar;
- separate navigation and content with a 1 px splitter or a 9 px draggable divider when resizing needs to be obvious;
- use faint horizontal row separators only when stripes alone are insufficient;
- render at device-pixel-aligned coordinates where possible.

The visual target is crisp and optical, not soft and foggy. Large blur fields belong only in the outer window shadow, not inside every component.

### 5.4 Color logic

Color should answer a question:

- **What is selected?** Aqua blue.
- **Where is keyboard focus?** Blue focus halo with sufficient contrast.
- **What is progressing?** Blue fill or animated blue cylinder.
- **What is the safe default action?** Blue gel button, optionally with a restrained pulse.
- **Which sources are which?** Small distinct icon colors in iTunes 9; monochrome only in the iTunes 10 profile.
- **Which window is active?** Full saturation and contrast; inactive controls and chrome become clear/graphite and lower contrast.
- **What is content?** Album art and media thumbnails remain richly colored against neutral structure.

Apple supported both blue Aqua and Graphite control tints and used a clear treatment for inactive-window controls. That historical behavior supports exposing an `aqua`/`graphite` theme switch rather than recoloring individual components arbitrarily. [Apple: Using the System Control Tint](https://developer.apple.com/library/archive/documentation/Cocoa/Conceptual/DrawColor/Tasks/SystemTintAware.html)

### 5.5 Typography

The period system font was Lucida Grande. Apple’s 2008 roles were 13 pt for system text and regular controls, 12 pt for lists and tables, 11 pt for small text and column headings, 10 pt for toolbar labels, and 9 pt for mini controls. [Apple HIG: Text](https://leopard-adc.pepas.com/documentation/UserExperience/Conceptual/AppleHIGuidelines/XHIGText/XHIGText.html)

Use this stack on the web:

```css
font-family: "Lucida Grande", "Lucida Sans Unicode", "Helvetica Neue", Arial, sans-serif;
```

If Lucida Grande is unavailable, prefer a compact humanist/system sans and tune metrics explicitly. Do not substitute an exaggerated geometric display face.

Rules:

- normal body/control copy: 13 px, weight 400;
- table/list rows: 12 px;
- column headers and secondary labels: 11 px;
- toolbar captions and source-group titles: 10 px;
- rare mini annotations: 9 px;
- bold is sparse and functional;
- text is crisp and anti-aliased;
- line heights are compact, generally 1.2–1.35;
- push-button labels have **no decorative text shadow**;
- source-group headings may use uppercase with modest tracking;
- use title case for button/menu commands and sentence case for explanatory copy;
- use a true ellipsis (`…`) when an action requires further input before completion.

### 5.6 Spacing rhythm

Apple’s 2008 layout guidance emphasized visual balance and repeated alignments, with representative values of 20 px at side/bottom window edges, 14 px below the titlebar, 8 px between individual controls, and 12 px around separators. [Apple HIG: Layout](https://leopard-adc.pepas.com/documentation/UserExperience/Conceptual/AppleHIGuidelines/XHIGLayout/XHIGLayout.html)

Use the following rhythm:

- 2 px: optical nudge or icon/text micro-gap only;
- 4 px: tight related-item gap;
- 6 px: compact inline gap;
- 8 px: standard control gap;
- 10 px: small group padding;
- 12 px: control-to-control or group separation;
- 14 px: top margin beneath frame areas;
- 16 px: strong local grouping;
- 20 px: dialog/window body edge;
- 24/32 px: major region separation, used sparingly.

Alignment is more important than any single measurement. Left edges, label baselines, column starts, and control centers MUST repeat.

---

## 6. How to build the Aqua gel look

### 6.1 The six-layer optical model

The following is a reconstruction inferred from Apple’s period controls and screenshots, not an official Apple rendering formula.

Build a gel control from six visual layers:

1. **Outer rim** — a crisp 1 px dark edge. It defines the control against gray or white surroundings.
2. **Colored body** — a saturated vertical gradient whose lower half is darker than its upper half.
3. **Specular cap** — a white translucent highlight concentrated in roughly the upper 35–45% of the shape.
4. **Equator transition** — a narrow shift around the center where the bright upper shell meets the deeper lower body.
5. **Internal depth** — an inset lower shadow plus a faint inner upper hairline.
6. **Environmental shadow** — a small, close shadow beneath the control; never a large floating-card shadow.

The silhouette and tonal ordering matter more than the number of gradient stops. The viewer must read **light from above, transparent shell, saturated volume below**.

### 6.2 Highlight geometry

For a 22–24 px-high pill:

- outer radius: 10–12 px;
- rim: 1 px;
- top highlight begins 1 px inside the rim;
- highlight occupies the upper 8–10 px;
- the brightest band sits near 8–18% height, not at the exact center;
- the equator transition occurs around 46–54%;
- the darkest body lies in the final 10–20%;
- bottom inner shadow: 1 px, low opacity;
- cast shadow: 0–1 px downward offset, 1–2 px blur.

For round transport controls, use a radial or elliptical highlight offset toward the upper left, then overlay a subtle vertical darkening. Keep every transport control’s virtual light source consistent.

### 6.3 Material parameters

Use these ranges as practical constraints:

| Property | Neutral/clear control | Aqua active/default control |
|---|---:|---:|
| Top luminance | 94–100% | 82–96% cyan-white |
| Mid-body saturation | 0–8% | 65–90% |
| Lower-body lightness | 68–78% | 36–50% |
| Outer rim opacity | 45–70% black | 65–90% dark blue |
| Top inner highlight | 70–100% white | 65–95% white |
| Bottom inset shadow | 12–25% black | 18–34% dark blue |
| Cast shadow | 16–28% black | 18–30% black |
| Highlight blur | 0–2 px | 0–2 px |

Do not use a large Gaussian blur to simulate gel. The period look was largely created by **crisp shape masks and controlled tonal bands**.

### 6.4 The 60/30/10 restraint rule

For an application window:

- roughly **60%** should be white or near-white content;
- roughly **30%** should be neutral/cool gray frame and navigation;
- no more than **10%** should be saturated Aqua, traffic-light color, artwork accents, or status color at one time.

This is a reconstruction heuristic, not an Apple metric. It prevents the common failure mode where “Aqua” becomes a blue-themed website.

### 6.5 Default-button pulse

The classic default action may pulse, but it MUST remain calm:

- duration: 1.4–1.8 seconds;
- easing: smooth ease-in-out;
- animate outer halo opacity and very slight body luminance;
- do not scale the button;
- do not move the label;
- pause the animation when the document is hidden;
- disable it under `prefers-reduced-motion: reduce`;
- use it only for the safe default action in a dialog or focused workflow.

### 6.6 Neutral controls are part of the gel language

Ordinary buttons should be clear/silver, not blue. Their construction still uses the same rim, top highlight, lower depth, and pressed response. This contrast is what makes the blue default button meaningful. Both the 2001 and 2008 HIGs describe ordinary push buttons as clear and the default action as colored. [Classic Aqua HIG](https://archive.org/details/apple-hig) [Apple HIG: Controls](https://leopard-adc.pepas.com/documentation/UserExperience/Conceptual/AppleHIGuidelines/XHIGControls/XHIGControls.html)

### 6.7 Common optical failures

- One simple top-to-bottom gradient looks plastic but not liquid.
- A centered white streak looks metallic rather than translucent.
- Huge shadow blur makes the object look like a modern floating card.
- White text with a heavy dark shadow creates a game UI, not a Mac control.
- Identical gloss on every surface destroys hierarchy.
- High transparency over arbitrary content reduces legibility and reads as 2020s glassmorphism.
- Excessive cyan makes controls look neon.
- Perfectly flat icons inside deep gel buttons create mismatched lighting.

---

## 7. Reconstruction tokens

### 7.1 Important status note

The values in this section are **implementation approximations**, derived from period documentation and visual evidence. They are not official Apple color specifications. Historical screenshots vary with display gamma, color profile, compression, and capture method. Preserve the relationships between values before obsessing over individual hex codes.

### 7.2 Canonical machine-readable token set

An implementation agent SHOULD copy these into the project’s native theme format and use semantic names in components. It MUST NOT scatter the raw values across unrelated files.

```json
{
  "name": "Aqua 2009 Reconstruction",
  "format": "semantic-design-tokens",
  "version": "1.0.0",
  "profile": "snow-leopard-itunes-9",
  "status": "approximate-reconstruction",
  "color": {
    "desktop": "#6D737A",
    "windowOutline": "#747474",
    "windowBody": "#ECECEC",
    "content": "#FFFFFF",
    "contentMuted": "#F7F7F7",
    "rowStripe": "#F1F6FB",
    "rowDivider": "#D8DEE5",
    "chromeTop": "#F6F6F6",
    "chromeUpper": "#E5E5E5",
    "chromeLower": "#C4C4C4",
    "chromeBottom": "#AFAFAF",
    "chromeSeparator": "#858585",
    "chromeHighlight": "#FFFFFF",
    "sidebarTop": "#DCE8F4",
    "sidebarBottom": "#BECEE0",
    "sidebarDivider": "#93A3B2",
    "sidebarGroupText": "#536473",
    "selectionTop": "#69B5F3",
    "selectionMid": "#378DDA",
    "selectionBottom": "#1764B2",
    "selectionBorder": "#0F4E8B",
    "selectionText": "#FFFFFF",
    "aquaSpecular": "#EAFBFF",
    "aquaTop": "#A9E5FF",
    "aquaMid": "#38B6F7",
    "aquaLower": "#0D83D6",
    "aquaBottom": "#075FA6",
    "aquaRim": "#07558F",
    "focus": "#3F9FE8",
    "graphiteTop": "#E5E7E9",
    "graphiteMid": "#AEB4B9",
    "graphiteBottom": "#737A80",
    "text": "#161616",
    "textSecondary": "#565B60",
    "textDisabled": "#96999C",
    "lcdTop": "#E1EAEB",
    "lcdBottom": "#AEBCC0",
    "lcdText": "#172326",
    "danger": "#D64A44",
    "warning": "#D9A431",
    "success": "#4E9D47",
    "trafficClose": "#E9635B",
    "trafficMinimize": "#E3B64B",
    "trafficZoom": "#58A953"
  },
  "font": {
    "family": "Lucida Grande, Lucida Sans Unicode, Helvetica Neue, Arial, sans-serif",
    "system": "13px",
    "view": "12px",
    "small": "11px",
    "label": "10px",
    "mini": "9px",
    "weightRegular": 400,
    "weightEmphasized": 700,
    "lineHeightCompact": 1.2,
    "lineHeightBody": 1.35
  },
  "space": {
    "micro": "2px",
    "tight": "4px",
    "inline": "6px",
    "control": "8px",
    "smallGroup": "10px",
    "group": "12px",
    "frameTop": "14px",
    "strongGroup": "16px",
    "windowEdge": "20px",
    "major": "24px",
    "bottomBarRegular": "32px"
  },
  "size": {
    "windowRadius": "7px",
    "panelRadius": "5px",
    "controlRadius": "5px",
    "pillRadius": "999px",
    "visualControlRegular": "22px",
    "visualControlSmall": "19px",
    "searchRegular": "22px",
    "searchSmall": "19px",
    "trafficLight": "12px",
    "toolbarMedia": "62px",
    "tableHeader": "20px",
    "tableRow": "20px",
    "sourceRow": "21px",
    "bottomBarSmall": "22px",
    "splitterHairline": "1px",
    "splitterWide": "9px",
    "sidebarDefault": "196px",
    "sidebarMin": "160px",
    "sidebarMax": "280px"
  },
  "shadow": {
    "window": "0 18px 42px rgba(0,0,0,0.34), 0 3px 10px rgba(0,0,0,0.28)",
    "panel": "0 8px 20px rgba(0,0,0,0.28), 0 1px 4px rgba(0,0,0,0.22)",
    "control": "0 1px 1px rgba(0,0,0,0.25)",
    "controlInsetTop": "inset 0 1px 0 rgba(255,255,255,0.95)",
    "controlInsetBottom": "inset 0 -1px 0 rgba(0,0,0,0.20)",
    "focus": "0 0 0 2px rgba(63,159,232,0.48), 0 0 5px rgba(63,159,232,0.58)"
  },
  "motion": {
    "press": "70ms",
    "selection": "100ms",
    "disclosure": "140ms",
    "panel": "200ms",
    "defaultPulse": "1650ms",
    "easeStandard": "cubic-bezier(0.2, 0.7, 0.2, 1)"
  }
}
```

### 7.3 CSS custom properties

```css
:root,
[data-aqua-profile="snow-leopard-itunes-9"] {
  color-scheme: light;

  --aqua-font: "Lucida Grande", "Lucida Sans Unicode", "Helvetica Neue", Arial, sans-serif;
  --aqua-text: #161616;
  --aqua-text-secondary: #565b60;
  --aqua-text-disabled: #96999c;

  --aqua-window-body: #ececec;
  --aqua-content: #fff;
  --aqua-stripe: #f1f6fb;
  --aqua-row-divider: #d8dee5;

  --aqua-chrome-top: #f6f6f6;
  --aqua-chrome-upper: #e5e5e5;
  --aqua-chrome-lower: #c4c4c4;
  --aqua-chrome-bottom: #afafaf;
  --aqua-chrome-separator: #858585;

  --aqua-sidebar-top: #dce8f4;
  --aqua-sidebar-bottom: #becee0;
  --aqua-sidebar-divider: #93a3b2;

  --aqua-blue-specular: #eafbff;
  --aqua-blue-top: #a9e5ff;
  --aqua-blue-mid: #38b6f7;
  --aqua-blue-lower: #0d83d6;
  --aqua-blue-bottom: #075fa6;
  --aqua-blue-rim: #07558f;

  --aqua-selection-top: #69b5f3;
  --aqua-selection-mid: #378dda;
  --aqua-selection-bottom: #1764b2;
  --aqua-selection-border: #0f4e8b;
  --aqua-focus: #3f9fe8;

  --aqua-window-radius: 7px;
  --aqua-panel-radius: 5px;
  --aqua-control-h: 22px;
  --aqua-row-h: 20px;
  --aqua-source-row-h: 21px;

  --aqua-window-shadow:
    0 18px 42px rgb(0 0 0 / 34%),
    0 3px 10px rgb(0 0 0 / 28%);
  --aqua-panel-shadow:
    0 8px 20px rgb(0 0 0 / 28%),
    0 1px 4px rgb(0 0 0 / 22%);
}
```

### 7.4 Profile overrides

The classic accent profile strengthens control luminosity; it does not revert the entire application to pinstripes or early-2000s window architecture.

```css
[data-aqua-profile="classic-aqua-gel-accent"] {
  --aqua-blue-specular: #f4fdff;
  --aqua-blue-top: #c9f2ff;
  --aqua-blue-mid: #47c5ff;
  --aqua-blue-lower: #078ce4;
  --aqua-blue-bottom: #07569e;
  --aqua-control-h: 22px;
}

[data-aqua-profile="itunes-10-transition"] {
  --aqua-sidebar-top: #d6dce1;
  --aqua-sidebar-bottom: #b9c2ca;
  --aqua-sidebar-divider: #949ca3;
  --aqua-stripe: #f6f7f8;
  --aqua-source-row-h: 23px;
  --aqua-row-h: 22px;
}
```

### 7.5 Token adaptation rules

- If a platform uses density-independent units, preserve *proportions* and optical compactness, not literal physical pixels.
- On 2×/3× screens, keep 1 CSS-pixel or 1 logical-point edges where the platform rasterizes them crisply.
- Increase contrast before increasing saturation.
- If the product brand requires a different accent hue, preserve the same luminance ladder: bright specular top, saturated middle, dark lower body and rim.
- Do not change structural neutrals to the brand color. Brand color belongs in active states and content identity.
- The `itunes-10-transition` profile MUST also switch source icons to monochrome and traffic lights to a vertical stack; token changes alone are insufficient.

---

## 8. Application architecture

### 8.1 Canonical late-Aqua media window

Use this region hierarchy for a desktop media, file, catalog, or library application:

```text
application-window
  title-toolbar
    traffic-lights
    primary-transport-or-actions
    information-display
    secondary-controls
    search-field
  work-area
    source-list
    splitter
    content-stack
      optional-scope-or-browser
      primary-content-view
  bottom-bar
    source-actions
    status
    output-or-view-actions
  transient-layer
    sheet | menu | tooltip | popover | drag-image
```

This code-style tree is normative. A component may be omitted only when its function is absent. Do not add decorative regions that have no job.

### 8.2 Region specification

| Region | Default size | Appearance | Required behavior |
|---|---:|---|---|
| Window | min 720 × 480 desktop | 1 px outline, 7 px top radius, strong cast shadow | Resizable; remembers sensible size; inactive state |
| Media toolbar | 58–66 px; target 62 px | unified neutral gradient; top highlight; lower separator | frequent controls only; draggable empty areas on desktop |
| Traffic lights | 12 px diameter, 7 px gap | red/yellow/green with tiny gloss and rim | horizontal in default profile; meaningful window actions or decorative only in a non-window mockup |
| Source list | 160–280 px; target 196 px | cool-blue vertical gradient; 1 px right divider | persistent; resizable; max two hierarchy levels; keyboard navigation |
| Content view | takes remaining area | white; optional pale-blue rows or black Cover Flow stage | owns primary task and scroll position |
| Browser/scope | 80–180 px as needed | white or faint blue; crisp dividers | filters/narrows without replacing navigation |
| Bottom bar | 22 px small, 32 px regular | gray frame gradient | subordinate actions and status; no primary command |
| Sheet/dialog | content-sized | gray/light body, clear/default buttons | attached to parent when modal; focus trap and escape/cancel behavior |

The titlebar and toolbar are a single visual surface in the default profile. That is a defining Leopard-era change documented by Apple. [Apple HIG: Windows](https://leopard-adc.pepas.com/documentation/UserExperience/Conceptual/AppleHIGuidelines/XHIGWindows/XHIGWindows.html)

### 8.3 Responsive adaptation

Historical fidelity does not require breaking smaller screens.

At widths below approximately 760 px:

- preserve the top transport and now-playing identity;
- allow secondary toolbar actions to move into a labeled overflow menu;
- convert the source list into a dismissible navigation panel or a top-level source button;
- never hide the current source name;
- keep the primary content full-width;
- retain visible focus and state;
- use at least the platform’s recommended touch target, even if the visible control remains compact inside it.

At widths below approximately 480 px:

- stack transport and information display only if necessary;
- prioritize play/pause over previous/next, then expose the latter nearby;
- turn multi-column tables into a primary-label/secondary-metadata row, not cards by default;
- keep artwork square and modest;
- avoid simulating desktop window controls unless the interface is intentionally a visual demo.

### 8.4 Density rules

The 2009 profile is compact:

- source rows: 20–22 px visual height;
- data rows: 19–22 px visual height;
- column headers: approximately 20 px;
- icons in source lists: roughly 15–16 px with optical hand-tuning;
- toolbar glyphs inside framed controls: roughly 12–16 px;
- table text: 12 px;
- status text: 10–11 px.

For touch, preserve those visible dimensions only when a larger invisible or surrounding hit target is available. Otherwise expand the component to at least 40–48 logical units and keep the *internal drawing* compact. Never sacrifice operability to period cosplay.

### 8.5 Content-view modes

A media/library product SHOULD implement the modes that suit its real content:

- **List:** sortable columns; high information density; optional alternating stripes.
- **Album List:** artwork groups interrupt the list only at meaningful album boundaries.
- **Grid:** square original artwork; compact labels; optional hover play.
- **Column Browser:** successive filters for genre/artist/album or analogous facets.
- **Cover Flow–inspired browser:** centered active item; neighboring items in perspective; dark stage; restrained reflection; keyboard and drag/swipe navigation.

Do not include Cover Flow merely as decoration. It needs a browsable ordered collection and clear active selection. Finder and iTunes used it as a physical browsing metaphor; the period HIG also accounted for how icons behaved against its black reflective stage. [Apple HIG: Icons](https://leopard-adc.pepas.com/documentation/UserExperience/Conceptual/AppleHIGuidelines/XHIGIcons/XHIGIcons.html)

---

## 9. Component specifications

### 9.1 Window frame

**Purpose:** establish one stable work surface and make active/inactive state visible.

The window MUST:

- use a crisp 1 px neutral outline;
- use a modest 6–8 px top radius;
- cast one broad environmental shadow and one close contact shadow;
- clip child surfaces cleanly at the frame boundary;
- have a visibly unified titlebar/toolbar in the default profile;
- reduce toolbar contrast, traffic-light saturation, and shadow strength when inactive;
- avoid a thick metallic side frame.

The window SHOULD NOT:

- float each internal section independently;
- use translucent blur behind the main content;
- use a 20–32 px modern card radius;
- place content inside an additional rounded “app card.”

### 9.2 Titlebar and toolbar

**Purpose:** contain window identity and the most frequent actions without competing with content.

Surface recipe:

- top 1 px white highlight;
- light gray at top, mid gray below, slightly darker lower edge;
- optional very faint noise of 0.5–1.5% opacity if the rendering otherwise looks digitally sterile;
- 1 px dark lower separator and optional 1 px light line immediately above it;
- no brushed-metal horizontal scratches.

Layout recipe for a media app:

- traffic lights at 12–14 px from left and 10–12 px from top;
- transport cluster below or horizontally aligned with them depending toolbar height;
- central information display grows but has a maximum width;
- volume/mode controls sit to its right;
- search field anchors the far right;
- empty space remains draggable in desktop shells.

Toolbar controls MUST be the actions users need frequently. The same commands SHOULD remain available through a menu or labeled overflow route, following the period guideline that toolbar items not become the only way to find a feature. [Apple HIG: Windows](https://leopard-adc.pepas.com/documentation/UserExperience/Conceptual/AppleHIGuidelines/XHIGWindows/XHIGWindows.html)

### 9.3 Traffic-light window controls

Default profile:

- three 12 px circles in a horizontal row;
- order: close/red, minimize/yellow, zoom/green;
- approximately 7 px edge-to-edge gap, or a 19 px center pitch at 12 px diameter;
- thin dark rim;
- top elliptical highlight;
- bottom depth;
- symbols may appear on hover if the product needs clearer meaning;
- inactive window: desaturate toward clear/graphite while keeping all controls present.

`itunes-10-transition` profile:

- stack the smaller controls vertically at the far upper left;
- remove the visible window title;
- reclaim top height consistently;
- apply the entire iTunes 10 cluster, including grayscale source icons and reduced bezels.

For a web page that is not actually a movable desktop window, traffic lights MAY be decorative. If decorative, mark them `aria-hidden="true"`, remove them from tab order, and never imply that they close/minimize the browser. If functional in an application shell, give each a visible tooltip and accessible name.

### 9.4 Transport controls

**Purpose:** make primary playback immediate and physically legible.

Required anatomy:

- previous, play/pause, and next arranged as one cluster;
- play/pause is 1.15–1.35× the visual area of adjacent controls;
- glyphs use familiar physical-player symbols;
- controls are round or rounded neutral buttons with a top highlight and close shadow;
- pressed state visibly inverts the convexity: darker upper area, stronger inset shadow, no outer glow;
- disabled controls remain visible but desaturated;
- play changes to pause without moving the control’s center or changing its footprint.

Preferred dimensions at desktop scale:

- previous/next visible disc: 24–28 px;
- play visible disc: 30–34 px;
- gap: 2–5 px;
- glyph: 9–13 px;
- surrounding hit target: at least 32 px pointer, larger for touch.

Do not place the transport in a giant saturated blue capsule. In iTunes 9 the controls were custom, dimensional neutrals; Aqua blue was more prominent in selected/progress states.

### 9.5 Information display / LCD panel

**Purpose:** centralize current item, timing, progress, and transient operation status.

The display SHOULD:

- be horizontally centered in the media toolbar;
- be inset, not floating;
- use a cool gray-green or gray-blue vertical gradient;
- have a dark 1 px inner rim and an inner shadow at the top;
- show primary title centered or left-aligned consistently;
- show secondary artist/source in a smaller row;
- allow a thin scrub/progress channel inside or immediately below;
- truncate long text cleanly and expose the full value via tooltip/accessibility label;
- switch temporarily to import/sync/buffering status, then return to now playing.

Avoid a faux seven-segment typeface unless the product intentionally targets much older hi-fi equipment. iTunes’ panel was an LCD metaphor expressed through material, compact type, and status layout—not novelty typography.

### 9.6 Source list / sidebar

**Purpose:** persistent primary navigation and collection selection.

Default profile surface:

- cool pale-blue vertical gradient across the full pane;
- 1 px darker divider at right;
- group headings in 10 px bold uppercase, desaturated blue-gray;
- source rows 20–22 px high;
- 15–16 px original colored icons;
- selected row uses a medium-to-deep blue gradient with white text and a subtle upper highlight;
- unfocused selection becomes gray or pale desaturated blue;
- hover is a slight tint, not a card.

Behavior:

- source list persists unless the user explicitly hides/collapses it;
- selected source controls the main content view;
- arrow keys move selection; left/right collapse or expand groups where applicable;
- sections expose clear headings;
- hierarchy SHOULD NOT exceed two levels;
- resize through a splitter when desktop space permits;
- add/remove or organization controls belong directly below in the bottom bar, not scattered inside rows;
- drag targets show an insertion line or highlighted destination.

Apple’s 2008 HIG explicitly described a blue source list as the primary navigation pattern used by Finder and iTunes, normally visible and limited to shallow hierarchy. [Apple HIG: Windows — Source Lists](https://leopard-adc.pepas.com/documentation/UserExperience/Conceptual/AppleHIGuidelines/XHIGWindows/XHIGWindows.html)

`itunes-10-transition` changes:

- replace colorful icons with a harmonized monochrome gray family;
- shift the pane from pale blue to somber blue-gray;
- increase row height slightly;
- replace always-visible disclosure triangles beside section headings with a discoverable Show/Hide treatment only if keyboard and touch equivalents remain obvious;
- retain current-location clarity even when icons are hidden.

### 9.7 Splitter

- Default hairline: 1 px, visually crisp.
- Wide draggable alternative: 9 px with a subtle recessed or grip treatment.
- Pointer cursor communicates resize.
- Keyboard resizing SHOULD be available in a desktop application.
- Hit area MAY be wider than the visible line.
- Active dragging darkens the divider slightly; no glow is needed.

The 1 px “zero-width” and 9 px wide split styles correspond to the period control system. [Apple HIG: Controls](https://leopard-adc.pepas.com/documentation/UserExperience/Conceptual/AppleHIGuidelines/XHIGControls/XHIGControls.html)

### 9.8 Table and list view

**Purpose:** make a large library scannable, sortable, and manipulable.

Header:

- 20 px high;
- 11 px regular or semibold text;
- white or near-white surface;
- 1 px lower separator;
- thin vertical column dividers where resizing is supported;
- sort column shows a small ascending/descending triangle;
- selected/sorted header may be slightly darker, never saturated blue.

Rows:

- 19–22 px in the default profile;
- 12 px view font;
- white and very pale blue alternating stripes where data density benefits;
- minimal horizontal separators;
- selected active row uses the same blue material as source selection;
- selected inactive row becomes gray-blue with dark text where contrast requires;
- current playback may show a small speaker/equalizer glyph in the first status column;
- star/rating, checkbox, disclosure, or status affordances occupy dedicated narrow columns;
- text alignment follows data type: text left, numbers/time right, status centered.

Behavior:

- column headers are buttons with sort state communicated programmatically;
- columns may resize and reorder if that is core to the task;
- the focused row and selected row remain distinguishable;
- double click performs the expected primary item action;
- drag provides a ghost/drag image and valid-target feedback;
- very long lists virtualize without changing row geometry while scrolling.

Apple permitted scrolling lists to be white or white striped with blue and specified the 12 pt view font for lists/tables. [Apple HIG: Controls](https://leopard-adc.pepas.com/documentation/UserExperience/Conceptual/AppleHIGuidelines/XHIGControls/XHIGControls.html) [Apple HIG: Text](https://leopard-adc.pepas.com/documentation/UserExperience/Conceptual/AppleHIGuidelines/XHIGText/XHIGText.html)

### 9.9 Column Browser and scope bar

Use a Column Browser when users narrow a large library through ordered facets such as Genre → Artist → Album.

- background: white or an almost imperceptible cool blue;
- each column has a crisp vertical divider;
- rows are compact and text-led;
- the active facet/row uses selection blue;
- counts appear right-aligned in secondary text;
- scrollbars remain local to a column when needed;
- the browser can sit above the table or to its left, but a product should choose one default and remember user preference.

iTunes 9 added a left-side browser option while preserving the earlier top arrangement. [Macworld’s iTunes 9 review](https://www.macworld.com/article/200107/itunes9-2.html)

Use a scope bar only to narrow or filter a current operation. It appears immediately below the toolbar and uses compact recessed buttons. Do not use it as a second permanent navigation bar.

### 9.10 Artwork grid

- use square original art at consistent dimensions;
- keep tiles flat on the content canvas;
- use 12 px title and 11 px secondary label;
- leave 12–20 px between tile groups, depending artwork size;
- selected tile gets a blue focus/selection frame plus a label highlight, not a rounded card background;
- hover MAY reveal a small circular play control centered over the art;
- multi-cover collections MAY scrub through covers with horizontal pointer movement, but only with obvious feedback and a keyboard alternative;
- lazy loading preserves dimensions to avoid layout shift;
- missing artwork uses an original neutral placeholder with a simple media metaphor.

iTunes 8 used artwork as collection navigation and exposed hover playback/cover preview. [Macworld’s iTunes 8 first look](https://www.macworld.com/article/192388/itunes8firstlook.html)

### 9.11 Cover Flow–inspired browser

This component is optional and expensive. Build it only when it materially improves visual browsing.

Stage:

- near-black to black background;
- centered active cover, front-facing;
- neighboring covers rotate 45–65° in perspective and recede laterally;
- reflection below is vertically flipped, fades quickly, and uses low opacity;
- a small dark or silver scrub track sits below;
- labels remain readable outside the reflection zone;
- dark artwork edges get a subtle inner glow so they do not dissolve into black.

Interaction:

- left/right keys and accessible previous/next buttons;
- pointer drag or wheel with discrete settling;
- active item announced to assistive technology;
- motion duration 180–260 ms with reduced-motion fallback to a simple horizontal carousel;
- no endless parallax or ambient animation.

Apple’s period icon guidance specifically warned that dark icon edges could disappear against Cover Flow and recommended a slight inner glow, while a specialist history documents its animation, reflection, and physical-album metaphor. [Apple HIG: Icons](https://leopard-adc.pepas.com/documentation/UserExperience/Conceptual/AppleHIGuidelines/XHIGIcons/XHIGIcons.html) [512 Pixels: History of Cover Flow](https://512pixels.net/2023/10/the-history-of-cover-flow/)

### 9.12 Bottom/status bar

Surface:

- same neutral material family as the titlebar, generally lighter and shallower;
- top separator rather than an independent shadow;
- 22 px small or 32 px regular height;
- content aligned to a common vertical center.

Layout:

- left: add/remove playlist or source actions;
- center: item count, duration, capacity, selection summary, or sync status;
- right: shuffle/repeat, artwork toggle, output/AirPlay-equivalent, Genius/recommendation, or view actions.

Rules:

- primary playback does not move to the bottom bar;
- labels use 10–11 px secondary text;
- buttons are small rectangular/gradient controls or icon controls whose function is also reachable elsewhere;
- `itunes-10-transition` may remove visible bezels and place glyphs directly on the bar, but hover/focus/pressed states must restore affordance.

Apple treated bottom bars as subordinate window-frame areas and specified 22 px small and 32 px regular heights. [Apple HIG: Windows](https://leopard-adc.pepas.com/documentation/UserExperience/Conceptual/AppleHIGuidelines/XHIGWindows/XHIGWindows.html)

### 9.13 Push buttons

Variants:

1. **Clear neutral:** normal immediate action.
2. **Default Aqua:** safe default action activated by Enter/Return.
3. **Graphite:** global Graphite tint or inactive/neutral alternative.
4. **Destructive:** neutral button with explicit destructive wording; reserve red fill for exceptional modern safety needs, not historical decoration.

Requirements:

- label is a verb or verb phrase;
- label uses title case where appropriate;
- ellipsis indicates that more input is required;
- ordinary and default buttons share geometry;
- label has no shadow/effects;
- minimum 12 px visible spacing between regular buttons;
- default sits at the lower right in left-to-right dialog layouts; Cancel sits to its left;
- dangerous alternatives are separated more strongly;
- toggle state uses a checkbox or segmented/toggle control, not an ordinary push button.

### 9.14 Rectangular, capsule, and segmented toolbar controls

Rectangular toolbar control:

- 20–24 px visual height;
- 3–5 px radius;
- neutral vertical gradient with crisp edge;
- black streamlined glyph, ideally 12–16 px;
- selected toggle receives a restrained blue inner glow or depressed state;
- 8 px between independent controls.

Capsule toolbar control:

- use only for a related cluster or period-authentic toolbar action group;
- do not use as the default shape for every action;
- icon weight and perspective must harmonize across the set.

Segmented control:

- equal segment widths when meanings have equal weight;
- icons or text within one control, not a mixture;
- internal 1 px separators;
- selected segment is depressed/darker or blue-highlighted;
- one selection for mode switching; allow multiple only when semantics demand it;
- arrow-key navigation and programmatic selected state.

### 9.15 Search field

The search field is a signature component:

- 22 px regular or 19 px small visual height;
- fully rounded ends;
- white/near-white recessed fill;
- thin gray border plus top inner shadow;
- magnifying-glass glyph at left;
- placeholder in secondary gray;
- clear button at right only when text exists;
- focus receives a blue halo;
- search begins as the user types only when results are fast; otherwise Enter or an explicit action initiates it;
- scope/history menu is optional and must have a discoverable trigger;
- keyboard shortcut focuses search.

The period HIG specifies rounded search fields at 22 px regular and 19 px small and treats search as one of the few body controls suitable in a window-frame area. [Apple HIG: Controls](https://leopard-adc.pepas.com/documentation/UserExperience/Conceptual/AppleHIGuidelines/XHIGControls/XHIGControls.html)

### 9.16 Text fields, pop-up menus, checkboxes, and radio buttons

Text fields:

- white recessed interior;
- 1 px gray rim, subtle top inner shadow;
- blue focus ring;
- 13 px input text;
- errors use message text and an icon/outline, never color alone.

Pop-up/select menus:

- compact clear/silver body with rounded ends or modest radius;
- visible up/down or down indicator in a separate end zone;
- use for a manageable set of mutually exclusive values;
- keep labels noun/adjective oriented; actions belong in menus/buttons;
- do not bury critical choices in deep submenus.

Checkboxes/radio buttons:

- keep native semantics;
- render a compact beveled or recessed body;
- selected mark uses dark graphite or Aqua blue depending tint;
- sentence-style labels;
- full label is clickable;
- indeterminate checkbox uses a dash.

### 9.17 Sliders, scrubbers, and progress

Slider/scrubber:

- narrow recessed track;
- played/selected portion may use Aqua blue or a lighter filled channel;
- thumb is round/oval, silver, top-lit, and casts a 1 px contact shadow;
- live dragging updates content continuously where performance permits;
- keyboard arrows adjust value;
- value is exposed programmatically.

Determinate progress:

- recessed rounded channel;
- blue gel fill with internal highlight and lower depth;
- optional subtle moving diagonal or specular texture, but percent/label remains available;
- active and paused/inactive states are distinct.

Indeterminate progress:

- period-authentic option: horizontally moving striped blue cylinder;
- modern accessible fallback: compact spinner with equivalent status text;
- animation stops under reduced motion or becomes a low-frequency opacity change;
- never leave a lengthy operation without textual feedback or cancellation when cancellation is safe.

Apple’s HIG emphasized live slider feedback and differentiated determinate, indeterminate, and asynchronous indicators. [Apple HIG: Controls](https://leopard-adc.pepas.com/documentation/UserExperience/Conceptual/AppleHIGuidelines/XHIGControls/XHIGControls.html)

### 9.18 Scrollbars

Aqua scrollbars are easy to overstate. For the 2009 profile:

- track: very light neutral trough with 1 px inset edge;
- thumb: medium neutral or blue-gray, rounded, with narrow top/left highlight and lower/right shade;
- arrow steppers MAY appear only in a highly literal desktop recreation;
- hover increases thumb contrast;
- active drag deepens the thumb and inset shadow;
- preserve platform scrolling behavior and do not force a tiny thumb;
- never make the track saturated blue.

### 9.19 Menus

Default application menus:

- opaque or mildly translucent light surface;
- modest 5–7 px radius;
- strong but compact panel shadow;
- 13 px text with aligned shortcut column;
- checkmarks and submenu arrows occupy stable columns;
- unavailable items remain visible but dimmed;
- icons are rare and reserved for meaningfully familiar items;
- selected item uses Aqua blue and white text.

Snow Leopard Dock menu variant:

- dark charcoal translucent surface;
- softly rounded, faintly translucent edges;
- restrained gray/blue selection gradient;
- white text;
- use only for Dock/contextual shell recreation, not every application menu.

Keeping unavailable choices visible rather than hiding them preserves discoverability, a principle reinforced by the period menu and interaction guidance. [Apple HIG: Menus](https://leopard-adc.pepas.com/documentation/UserExperience/Conceptual/AppleHIGuidelines/XHIGMenus/XHIGMenus.html)

### 9.20 Dialogs and sheets

- Use a sheet when an operation belongs to one parent window; visually attach it beneath the titlebar.
- Use a standalone alert only when the issue is application- or system-wide.
- Keep 20 px side/bottom margins and approximately 14 px at the top of body content.
- Align icon, message, informative text, and buttons to a clear grid.
- Primary message uses 13 px bold sparingly; explanation uses 11–13 px regular.
- Place the safe default at lower right and Cancel immediately to its left.
- Animate the relationship to the parent in 180–240 ms, with a reduced-motion instant/fade alternative.
- Trap focus while modal; Escape cancels where safe; Enter activates the safe default.
- Error messages explain the cause and what the user can do next.

### 9.21 Icons

There are three distinct icon systems. Do not render them all the same way.

**Application/content icons**

- vibrant, inviting, dimensional;
- based on a recognizable object or medium;
- common light source from directly above or very slightly upper-left;
- material-specific reflections and shadows;
- application-scale assets prepared independently for large and tiny output sizes;
- original artwork only.

**Toolbar icons**

- simplified, straight-on, and lower detail;
- constrained shading;
- distinct silhouettes;
- consistent size, visual weight, perspective, and light source;
- familiar metaphors for frequent commands.

**Source-list icons**

- target 15–16 px;
- one clear silhouette and one or two identifying colors;
- hand-tuned at final size rather than merely scaled from a large illustration;
- no hairlines thinner than a device pixel;
- baseline and optical mass aligned across the set;
- `itunes-10-transition`: monochrome gray, still distinguished by silhouette.

Apple’s HIG differentiated colorful user applications from desaturated utilities, dimensional large icons from simpler toolbar icons, and recommended hand-tuning 16/32 px resources. [Apple HIG: Icons](https://leopard-adc.pepas.com/documentation/UserExperience/Conceptual/AppleHIGuidelines/XHIGIcons/XHIGIcons.html)

### 9.22 Artwork and media identity

- Album art, thumbnails, and editorial imagery provide most of the rich color.
- Keep art square unless the media type has a different native ratio.
- Use very small or no corner radius.
- Use a 1 px neutral keyline on light artwork.
- Shadows are shallow and directly related to a physical stack/cover metaphor.
- Missing art is neutral and typographic/iconic, not a glowing blue blob.
- Never scrape or reuse Apple/iTunes artwork merely to evoke the period.

### 9.23 Dock and desktop shell, when explicitly requested

Do not add a Dock to an ordinary application view. If building an OS-shell recreation:

- use a reflective or translucent dark shelf along the bottom;
- place distinct dimensional application icons at consistent baseline and size;
- enlarge icons locally on hover only when the user requests magnification;
- show running-state indicators subtly;
- use bounce only to communicate launch or urgent attention;
- keep minimized-window and stack behavior spatially connected to their Dock item;
- implement Stack fan/grid/list modes only if the shell needs folder browsing;
- use a dark Snow Leopard Dock menu, not the light application-menu style.

### 9.24 QuickTime X–style dark exception

For a focused video player, the system may switch materials:

- black, frameless content window;
- black title overlay at top;
- floating dark transport palette over the lower video;
- chrome fades when idle and returns on pointer/focus movement;
- controls remain reachable by keyboard and screen reader;
- avoid obscuring critical content; allow the transport to move or dock if the workflow requires frame inspection.

This is a contextual exception documented in Snow Leopard, not the default app material. [Ars Technica’s Snow Leopard review](https://arstechnica.com/gadgets/2009/08/mac-os-x-10-6/)

---

## 10. State system

Visual fidelity fails when only the resting screenshot is styled. Every interactive element MUST implement a coherent state ladder.

### 10.1 State matrix

| State | Shape | Tone | Shadow/highlight | Text/icon | Motion |
|---|---|---|---|---|---|
| Rest | normal geometry | neutral clear/silver | convex top highlight, small cast shadow | full contrast | none |
| Hover | unchanged | 3–6% brighter or slightly cooler | highlight strengthens slightly | full contrast | 80–120 ms transition |
| Pressed | unchanged or 1 px downward optical shift | darker upper/mid body | outer shadow collapses; inset shadow strengthens | full contrast | 50–80 ms |
| Selected/toggled | unchanged | Aqua blue or visibly depressed graphite | inner glow or inset depth | white/dark chosen for contrast | 80–120 ms |
| Keyboard focus | unchanged | base state preserved | 2 px blue halo outside rim | unchanged | none or short fade |
| Disabled | unchanged | desaturated, lower contrast | reduced depth; no glow | 45–60% visual strength | none |
| Busy | unchanged | progress-specific blue | animated fill/indicator | status text remains | controlled loop |
| Inactive window | unchanged | graphite/clear, desaturated selection | weaker window/control shadow | lower contrast but readable | 100–160 ms |
| Default action | same geometry as peer | blue gel | soft periodic halo | dark readable label | optional 1.4–1.8 s pulse |
| Error | unchanged | neutral surface plus red marker/rim | no decorative glow | clear message | brief reveal only |

### 10.2 Non-negotiable state rules

- Hover and focus are different states; keyboard focus cannot depend on hover.
- Pressed state changes convexity, not merely opacity.
- Selected state persists after pointer release.
- Disabled controls remain visible when their existence helps explain the interface.
- Inactive-window selection remains legible but loses saturated Aqua priority.
- Color is never the only state signal; use a checkmark, depression, glyph, text, border, or position as a second cue.
- Default-action pulse must stop under reduced motion.
- Loading status must have an accessible name and, when determinate, a numeric value.

### 10.3 Active versus inactive window

Active windows use:

- full outer shadow;
- full traffic-light color;
- stronger toolbar separator;
- blue active selection;
- normal icon color.

Inactive windows use:

- 35–55% weaker cast shadow;
- clear/graphite traffic lights;
- flatter chrome contrast;
- gray or pale blue-gray selection;
- slightly reduced icon saturation.

The application MUST NOT hide window controls or selection when inactive.

---

## 11. Motion and feedback

### 11.1 Principle

Motion explains state, ownership, and destination. It is not ambient decoration. Apple’s period guidance used animation to connect minimized windows to the Dock, sheets to their parent window, and user actions to visible outcomes. [Apple HIG: Human Interface Design](https://leopard-adc.pepas.com/documentation/UserExperience/Conceptual/AppleHIGuidelines/XHIGHIDesign/XHIGHIDesign.html)

### 11.2 Recommended timings

These are reconstruction values:

| Interaction | Duration | Easing | Notes |
|---|---:|---|---|
| Button press/release | 50–80 ms | ease-out | Convex to inset; no bounce |
| Hover/focus appearance | 80–120 ms | ease-out | Small tonal change |
| Row/source selection | 80–120 ms | linear/ease-out | Fast enough to feel immediate |
| Disclosure open/close | 120–160 ms | standard | Rotate triangle + reveal content |
| Menu/popover | 100–160 ms | ease-out | Fade plus 2–4 px movement maximum |
| Sheet attach/detach | 180–240 ms | standard | Communicate parent relationship |
| View-mode change | 160–240 ms | standard | Crossfade/reflow; preserve focus |
| Cover browser settle | 180–260 ms | standard | Discrete item-to-item movement |
| Default-button pulse | 1400–1800 ms | ease-in-out | Halo/luminance only |
| Progress texture | 900–1400 ms loop | linear | Low-amplitude, functional |

### 11.3 Reduced motion

Under reduced motion:

- remove default-button pulsing;
- replace sheet travel with a short fade or instant appearance;
- replace Cover Flow perspective movement with a discrete carousel/list;
- stop striped progress movement while retaining a visible busy state;
- keep essential state changes immediate.

### 11.4 Feedback copy

When work lasts more than a brief moment, show what is happening in plain language:

- `Importing 18 of 94 songs…`
- `Syncing artwork…`
- `About a minute remains`
- `Searching “Blue Train”…`

Prefer specific status over an unexplained spinner. Provide Cancel when interruption is safe.

---

## 12. Reference CSS implementation

This CSS is a starting point, not a drop-in design system. Adapt class names and architecture to the host project. Preserve semantics and states.

### 12.1 Window shell

```css
.aqua-window {
  position: relative;
  isolation: isolate;
  overflow: hidden;
  min-width: min(44rem, 100%);
  min-height: 30rem;
  color: var(--aqua-text);
  font: 13px/1.35 var(--aqua-font);
  background: var(--aqua-window-body);
  border: 1px solid #747474;
  border-radius: var(--aqua-window-radius) var(--aqua-window-radius) 5px 5px;
  box-shadow: var(--aqua-window-shadow);
}

.aqua-window[data-active="false"] {
  filter: saturate(0.56);
  box-shadow:
    0 10px 28px rgb(0 0 0 / 18%),
    0 2px 6px rgb(0 0 0 / 16%);
}

.aqua-toolbar {
  position: relative;
  display: grid;
  grid-template-columns: auto auto minmax(12rem, 1fr) auto;
  align-items: center;
  min-height: 62px;
  padding: 0 12px;
  background:
    linear-gradient(
      to bottom,
      rgb(255 255 255 / 78%) 0,
      rgb(255 255 255 / 20%) 3px,
      transparent 3px
    ),
    linear-gradient(
      to bottom,
      var(--aqua-chrome-top) 0%,
      var(--aqua-chrome-upper) 42%,
      var(--aqua-chrome-lower) 82%,
      var(--aqua-chrome-bottom) 100%
    );
  border-bottom: 1px solid var(--aqua-chrome-separator);
  box-shadow: inset 0 -1px rgb(255 255 255 / 28%);
}

.aqua-work-area {
  display: grid;
  grid-template-columns: 196px 1px minmax(0, 1fr);
  min-height: 0;
  background: var(--aqua-content);
}

.aqua-splitter {
  width: 1px;
  background: var(--aqua-sidebar-divider);
  box-shadow: 1px 0 rgb(255 255 255 / 50%);
  cursor: col-resize;
}

.aqua-content {
  min-width: 0;
  min-height: 0;
  overflow: auto;
  background: var(--aqua-content);
}

.aqua-bottom-bar {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  min-height: 22px;
  padding: 0 7px;
  color: var(--aqua-text-secondary);
  font-size: 10px;
  background: linear-gradient(#e9e9e9, #c7c7c7);
  border-top: 1px solid #929292;
  box-shadow: inset 0 1px rgb(255 255 255 / 70%);
}
```

### 12.2 Neutral and Aqua gel buttons

```css
.aqua-button {
  position: relative;
  isolation: isolate;
  min-width: 69px;
  min-height: 22px;
  padding: 1px 14px 2px;
  overflow: hidden;
  color: #151515;
  font: 400 13px/18px var(--aqua-font);
  text-align: center;
  white-space: nowrap;
  background:
    linear-gradient(
      to bottom,
      rgb(255 255 255 / 96%) 0%,
      rgb(255 255 255 / 64%) 38%,
      rgb(255 255 255 / 12%) 48%,
      rgb(0 0 0 / 4%) 52%,
      rgb(0 0 0 / 12%) 100%
    ),
    linear-gradient(to bottom, #fefefe 0%, #e4e4e4 48%, #c8c8c8 100%);
  border: 1px solid #777;
  border-radius: 999px;
  box-shadow:
    inset 0 1px 0 rgb(255 255 255 / 95%),
    inset 0 -1px 0 rgb(0 0 0 / 18%),
    0 1px 1px rgb(0 0 0 / 25%);
  cursor: default;
  -webkit-font-smoothing: antialiased;
}

.aqua-button::before {
  content: "";
  position: absolute;
  z-index: -1;
  inset: 1px 2px 48%;
  border-radius: 999px 999px 55% 55%;
  background: linear-gradient(to bottom, rgb(255 255 255 / 82%), rgb(255 255 255 / 18%));
  pointer-events: none;
}

.aqua-button:hover:not(:disabled) {
  filter: brightness(1.035);
}

.aqua-button:active:not(:disabled),
.aqua-button[aria-pressed="true"] {
  transform: translateY(1px);
  background:
    linear-gradient(to bottom, rgb(0 0 0 / 12%), transparent 42%, rgb(255 255 255 / 8%)),
    linear-gradient(to bottom, #bdbdbd, #e4e4e4 58%, #c6c6c6);
  box-shadow:
    inset 0 2px 3px rgb(0 0 0 / 25%),
    inset 0 -1px rgb(255 255 255 / 55%);
}

.aqua-button:focus-visible {
  outline: 1px solid #0d61a7;
  outline-offset: 2px;
  box-shadow:
    inset 0 1px 0 rgb(255 255 255 / 95%),
    inset 0 -1px 0 rgb(0 0 0 / 18%),
    0 0 0 2px rgb(63 159 232 / 48%),
    0 0 5px rgb(63 159 232 / 58%);
}

.aqua-button:disabled {
  color: var(--aqua-text-disabled);
  filter: grayscale(0.8) contrast(0.75) brightness(1.08);
  box-shadow: inset 0 1px rgb(255 255 255 / 70%);
  cursor: not-allowed;
}

.aqua-button[data-default="true"] {
  color: #071820;
  background:
    linear-gradient(
      to bottom,
      rgb(255 255 255 / 88%) 0%,
      rgb(255 255 255 / 48%) 36%,
      rgb(255 255 255 / 5%) 48%,
      rgb(0 65 135 / 8%) 52%,
      rgb(0 45 105 / 24%) 100%
    ),
    linear-gradient(
      to bottom,
      var(--aqua-blue-top) 0%,
      var(--aqua-blue-mid) 49%,
      var(--aqua-blue-lower) 72%,
      var(--aqua-blue-bottom) 100%
    );
  border-color: var(--aqua-blue-rim);
  box-shadow:
    inset 0 1px var(--aqua-blue-specular),
    inset 0 -1px rgb(0 40 95 / 38%),
    0 1px 1px rgb(0 0 0 / 28%),
    0 0 0 1px rgb(68 183 247 / 22%),
    0 0 5px rgb(40 158 229 / 34%);
  animation: aqua-default-pulse 1650ms ease-in-out infinite;
}

.aqua-button[data-default="true"]:active:not(:disabled) {
  background:
    linear-gradient(to bottom, rgb(0 51 112 / 24%), transparent 50%, rgb(255 255 255 / 10%)),
    linear-gradient(to bottom, #0b72b8, #37aeea 62%, #0866ad);
  box-shadow:
    inset 0 2px 4px rgb(0 30 80 / 46%),
    inset 0 -1px rgb(255 255 255 / 30%);
  animation: none;
}

@keyframes aqua-default-pulse {
  0%, 100% {
    box-shadow:
      inset 0 1px var(--aqua-blue-specular),
      inset 0 -1px rgb(0 40 95 / 38%),
      0 1px 1px rgb(0 0 0 / 28%),
      0 0 2px rgb(40 158 229 / 26%);
  }
  50% {
    box-shadow:
      inset 0 1px var(--aqua-blue-specular),
      inset 0 -1px rgb(0 40 95 / 30%),
      0 1px 1px rgb(0 0 0 / 24%),
      0 0 7px rgb(40 158 229 / 58%);
  }
}

@media (prefers-reduced-motion: reduce) {
  .aqua-button[data-default="true"] {
    animation: none;
  }
}
```

### 12.3 Source list and rows

```css
.aqua-source-list {
  min-width: 0;
  overflow: auto;
  color: #1f2b35;
  background: linear-gradient(
    to bottom,
    var(--aqua-sidebar-top),
    var(--aqua-sidebar-bottom)
  );
}

.aqua-source-heading {
  margin: 10px 8px 3px;
  color: #536473;
  font: 700 10px/1.2 var(--aqua-font);
  letter-spacing: 0.035em;
  text-transform: uppercase;
}

.aqua-source-row {
  display: grid;
  grid-template-columns: 16px minmax(0, 1fr) auto;
  align-items: center;
  gap: 5px;
  min-height: var(--aqua-source-row-h);
  padding: 0 7px;
  border-block: 1px solid transparent;
  font-size: 11px;
  line-height: 1;
  user-select: none;
}

.aqua-source-row:hover {
  background: rgb(255 255 255 / 20%);
}

.aqua-source-row[aria-selected="true"] {
  color: #fff;
  background:
    linear-gradient(to bottom, rgb(255 255 255 / 20%), transparent 48%),
    linear-gradient(
      to bottom,
      var(--aqua-selection-top),
      var(--aqua-selection-mid) 48%,
      var(--aqua-selection-bottom)
    );
  border-block-color: var(--aqua-selection-border);
  text-shadow: 0 1px rgb(0 45 90 / 40%);
}

.aqua-window[data-active="false"] .aqua-source-row[aria-selected="true"] {
  color: #20252a;
  background: linear-gradient(#d3d8dc, #b5bdc4);
  border-block-color: #959ca2;
  text-shadow: 0 1px rgb(255 255 255 / 54%);
}
```

### 12.4 Search field

```css
.aqua-search {
  position: relative;
  display: grid;
  grid-template-columns: 14px minmax(4rem, 1fr) 14px;
  align-items: center;
  min-height: 22px;
  padding: 0 6px;
  color: var(--aqua-text);
  background: linear-gradient(#ececec, #fff 38%, #fff);
  border: 1px solid #818181;
  border-radius: 999px;
  box-shadow:
    inset 0 1px 2px rgb(0 0 0 / 18%),
    0 1px rgb(255 255 255 / 56%);
}

.aqua-search:focus-within {
  border-color: #1768a7;
  box-shadow:
    inset 0 1px 2px rgb(0 0 0 / 16%),
    0 0 0 2px rgb(63 159 232 / 48%),
    0 0 5px rgb(63 159 232 / 50%);
}

.aqua-search input {
  min-width: 0;
  padding: 0;
  color: inherit;
  font: 11px/20px var(--aqua-font);
  background: transparent;
  border: 0;
  outline: 0;
}

.aqua-search input::placeholder {
  color: #777d82;
}
```

### 12.5 Information display

```css
.aqua-lcd {
  position: relative;
  min-width: 15rem;
  max-width: 28rem;
  min-height: 38px;
  padding: 4px 10px;
  overflow: hidden;
  color: #172326;
  text-align: center;
  background:
    linear-gradient(to bottom, rgb(255 255 255 / 34%), transparent 44%),
    linear-gradient(to bottom, #e1eaeb, #c7d3d5 52%, #aebcc0);
  border: 1px solid #737b7d;
  border-radius: 4px;
  box-shadow:
    inset 0 2px 4px rgb(0 0 0 / 25%),
    0 1px rgb(255 255 255 / 62%);
}

.aqua-lcd__title {
  overflow: hidden;
  font-size: 12px;
  font-weight: 700;
  line-height: 16px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.aqua-lcd__detail {
  overflow: hidden;
  color: #3e4c50;
  font-size: 10px;
  line-height: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
```

### 12.6 Tables

```css
.aqua-table {
  width: 100%;
  table-layout: fixed;
  border-collapse: separate;
  border-spacing: 0;
  color: var(--aqua-text);
  font: 12px/1.2 var(--aqua-font);
}

.aqua-table th {
  height: 20px;
  padding: 0 6px;
  overflow: hidden;
  color: #303438;
  font-size: 11px;
  font-weight: 400;
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
  background: linear-gradient(#fff, #eceeef);
  border-right: 1px solid #d2d5d7;
  border-bottom: 1px solid #aeb3b7;
  box-shadow: inset 0 1px #fff;
}

.aqua-table td {
  height: var(--aqua-row-h);
  padding: 0 6px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.aqua-table tbody tr:nth-child(even) {
  background: var(--aqua-stripe);
}

.aqua-table tbody tr[aria-selected="true"] {
  color: #fff;
  background: linear-gradient(
    var(--aqua-selection-top),
    var(--aqua-selection-mid) 46%,
    var(--aqua-selection-bottom)
  );
}

.aqua-table tbody tr:focus-visible {
  position: relative;
  outline: 2px solid var(--aqua-focus);
  outline-offset: -2px;
}
```

### 12.7 Progress bar

```css
.aqua-progress {
  position: relative;
  height: 14px;
  overflow: hidden;
  background: linear-gradient(#a6a6a6, #ededed 35%, #f7f7f7);
  border: 1px solid #797979;
  border-radius: 999px;
  box-shadow:
    inset 0 1px 2px rgb(0 0 0 / 28%),
    0 1px rgb(255 255 255 / 60%);
}

.aqua-progress__fill {
  position: absolute;
  inset: 0 auto 0 0;
  width: var(--progress, 0%);
  min-width: 0;
  background:
    linear-gradient(to bottom, rgb(255 255 255 / 76%), transparent 44%),
    repeating-linear-gradient(
      120deg,
      rgb(255 255 255 / 13%) 0 5px,
      transparent 5px 10px
    ),
    linear-gradient(
      var(--aqua-blue-top),
      var(--aqua-blue-mid) 48%,
      var(--aqua-blue-bottom)
    );
  border-right: 1px solid var(--aqua-blue-rim);
  box-shadow:
    inset 0 1px var(--aqua-blue-specular),
    inset 0 -1px rgb(0 40 95 / 35%);
  transition: width 160ms ease-out;
}
```

### 12.8 Minimal semantic markup

```html
<section class="aqua-window" data-active="true" data-aqua-profile="snow-leopard-itunes-9">
  <header class="aqua-toolbar">
    <div class="window-actions" aria-label="Window controls">
      <!-- Use real buttons only if these actions actually exist. -->
    </div>

    <div class="transport" aria-label="Playback controls">
      <button type="button" aria-label="Previous track">…</button>
      <button type="button" aria-label="Play">…</button>
      <button type="button" aria-label="Next track">…</button>
    </div>

    <section class="aqua-lcd" aria-live="polite" aria-label="Now playing">
      <div class="aqua-lcd__title">Track title</div>
      <div class="aqua-lcd__detail">Artist — Album</div>
    </section>

    <div class="aqua-search" role="search">
      <span aria-hidden="true">⌕</span>
      <input type="search" placeholder="Search" aria-label="Search library">
      <button type="button" aria-label="Clear search" hidden>×</button>
    </div>
  </header>

  <div class="aqua-work-area">
    <nav class="aqua-source-list" aria-label="Library sources">…</nav>
    <div class="aqua-splitter" role="separator" aria-orientation="vertical"
         aria-valuemin="160" aria-valuemax="280" aria-valuenow="196" tabindex="0"></div>
    <main class="aqua-content" tabindex="-1">…</main>
  </div>

  <footer class="aqua-bottom-bar">
    <div>…</div>
    <output aria-live="polite">128 songs, 7.4 hours</output>
    <div>…</div>
  </footer>
</section>
```

Replace placeholder glyphs with original SVG/icon components. Do not ship Unicode approximations when they misalign or vary by platform.

---

## 13. Platform translation

### 13.1 Web / React / Vue / Svelte

- Use semantic HTML first, CSS custom properties second, component abstractions third.
- Use pseudo-elements for specular caps only when they do not block input or content.
- Keep visible 1 px edges aligned to the CSS pixel grid.
- Implement table semantics with `<table>` when data is tabular; do not turn every row into generic `<div>` markup.
- Use `aria-selected`, `aria-pressed`, `aria-sort`, `aria-current`, `aria-live`, and named controls as appropriate.
- Do not globally disable platform focus outlines until the Aqua focus replacement exists.
- Visual regression-test active, inactive, narrow, empty, loading, error, and reduced-motion states.

### 13.2 AppKit / SwiftUI

- If the project targets a modern OS but wants a historical skin, do not assume current system controls will look late-Aqua.
- Preserve native roles, keyboard commands, menus, focus movement, VoiceOver labels, and window behavior.
- Build historical surfaces with semantic components plus layered `Shape`, `LinearGradient`, overlays, strokes, inner-shadow approximations, and state-driven modifiers.
- In AppKit, use proper `NSButton`, `NSSearchField`, `NSTableView`, `NSSplitView`, and accessibility roles where possible; customize cells/drawing rather than replacing behavior wholesale.
- Keep toolbar commands in menus and support standard shortcuts.

### 13.3 Android / Jetpack Compose

- Translate CSS pixels to `dp` only as a starting proportion; use `sp` for type.
- Use `Brush.verticalGradient`, `BorderStroke`, `shadow`, `clip`, and layered `Box`/`Canvas` drawing for gel.
- Keep the visible 20–24 dp control inside at least a 48 dp touch target where feasible.
- Use `InteractionSource` for hover/press/focus, `semantics` for selected/progress roles, and `animate*AsState` only for restrained state feedback.
- Preserve system back behavior and content scaling.
- On mobile widths, treat the source list as a navigation drawer/sheet but keep current-source orientation visible.

### 13.4 React Native / Flutter

- Reproduce the same layered order: border, base gradient, specular overlay, inset-depth approximation, cast shadow.
- Use platform accessibility roles and minimum target sizes.
- Avoid bitmap nine-slices unless vector/gradient rendering cannot meet performance; if used, create multiple density assets and test stretch regions.
- Treat desktop window chrome as an optional framed theme, not as false operating-system functionality.

---

## 14. Accessibility and modern adaptation

Historical style is an aesthetic constraint, not an accessibility waiver. Apple’s contemporary HIG framed accessibility and standard behavior as part of Aqua, and iTunes 8 added screen-reader support on Mac and Windows. [Apple HIG: Introduction](https://leopard-adc.pepas.com/documentation/UserExperience/Conceptual/AppleHIGuidelines/XHIGIntro/XHIGIntro.html) [Macworld on iTunes 8](https://www.macworld.com/article/192388/itunes8firstlook.html)

### 14.1 Required accessibility behavior

- All interactive elements MUST have correct native semantics or an equivalent accessibility role.
- Every icon-only control MUST have an accessible name and a tooltip or visible contextual label.
- Keyboard focus MUST be visible and distinct from selection.
- Transport, view mode, list selection, sort state, progress, and disclosure state MUST be announced programmatically.
- Text contrast MUST remain readable on every gradient stop and in inactive-window state.
- Color MUST NOT be the only cue for status, selection, warning, or error.
- Dynamic status SHOULD use a polite live region; urgent blocking failures use an appropriate alert pattern.
- Tables MUST preserve row/column relationships.
- Reduced motion MUST be honored.
- Text zoom/reflow MUST not clip toolbar labels, source names, table content, or buttons.
- Pointer targets SHOULD be at least 32 × 32 CSS px on desktop when adjacent controls are close; touch targets SHOULD follow the host platform’s current minimum, commonly 44–48 logical units.

### 14.2 Compact visual, generous interaction

There are three acceptable strategies for reconciling period dimensions with modern input:

1. Place the 20–24 px visual control inside a transparent 32–48 px hit wrapper.
2. Expand the neutral surrounding toolbar area while keeping the internal rim/highlight geometry compact.
3. Use a larger control on touch breakpoints and preserve the same tonal proportions.

Do not overlap invisible hit targets. Do not create controls whose interactive area extends into an unrelated neighbor.

### 14.3 Contrast tuning

The reconstruction palette may need adjustment to meet the product’s required contrast standard. Tune in this order:

1. darken text or rim;
2. lighten the immediate background behind text;
3. reduce highlight opacity;
4. deepen the selected-state lower gradient;
5. only then alter hue or saturation.

For selected rows, white text may need a darker and less cyan body than the sample tokens. For Aqua buttons with dark text, ensure the lightest specular band does not wash through the glyph/label area.

### 14.4 Content and localization

- Buttons grow horizontally with translated labels; never reduce type below the role size to force a fit.
- Source-list and table text truncate with an accessible full label.
- Mirrored locales reverse ordered layout and disclosure direction while retaining semantic transport direction where culturally/platform appropriate.
- Use locale-aware time, number, date, and duration formatting.
- Do not encode meaning in a single letter or unexplained abbreviation merely to preserve compactness.

---

## 15. AI implementation workflow

This section is normative for Claude Code, Claude Opus 5, Fable 5, or another coding agent.

### Phase 0 — Read and declare

1. Read this entire file.
2. Read the repository’s own instructions and existing design system.
3. Declare the selected `AQUA_PROFILE`.
4. Identify the target platform, viewport classes, and input types.
5. State which existing product behaviors and components must remain unchanged.

### Phase 1 — Audit before editing

Inspect the existing product and produce a short inventory:

- application shell and navigation;
- primary content types;
- global tokens/theme files;
- component library and style entry points;
- state management for selection, playback, loading, error, and disabled behavior;
- keyboard and accessibility behavior;
- existing tests and screenshot tooling;
- supplied brand/art assets and their licenses;
- responsive breakpoints.

Do not start by globally replacing colors or adding gradients.

### Phase 2 — Map product concepts to period concepts

Create a mapping table before implementation. Example:

| Product concept | Aqua-era component | Reason |
|---|---|---|
| Main navigation | Blue source list | Persistent collections/sources control dominant content |
| Current playback | LCD information display | Central, glanceable state |
| Primary playback | Transport cluster | Familiar physical-player metaphor |
| Search | Rounded search field | Standard, recognizable utility |
| Large dataset | Striped sortable table | Dense scanning and metadata comparison |
| Visual collection | Artwork grid | Recognition by cover/image |
| Secondary source actions | Bottom bar buttons | Subordinate content organization |
| Modal item settings | Attached sheet | Clear parent ownership |

If a product concept has no credible period mapping, keep it functionally clear and apply only the shared type, edge, and state language.

### Phase 3 — Establish tokens

1. Copy the canonical tokens into the project’s theme system.
2. Give them semantic names.
3. Implement profile overrides centrally.
4. Add active/inactive, focus, disabled, and reduced-motion values.
5. Write a small visual fixture or story showing every material and state.

There MUST be exactly one source of truth for core color, spacing, type, radius, shadow, and motion values.

### Phase 4 — Build structure in grayscale

Build or refactor these in order:

1. window/app frame;
2. unified titlebar/toolbar;
3. work-area split;
4. source list;
5. content canvas and selected view;
6. bottom/status bar;
7. dialogs/sheets/menus.

Temporarily use grayscale. Verify sizing, hierarchy, overflow, resizing, keyboard order, and responsive behavior before adding the Aqua palette.

### Phase 5 — Implement stateful controls

Implement neutral controls first:

1. clear push button;
2. transport control;
3. segmented/view control;
4. search field;
5. list/table selection;
6. slider/scrubber;
7. progress;
8. default Aqua action.

For each control, test rest, hover, press, focus, selected, disabled, busy, and inactive-window states where applicable.

### Phase 6 — Add optical material

Add effects in this order:

1. crisp rim;
2. body gradient;
3. top specular cap;
4. equator transition;
5. inner lower depth;
6. close cast shadow;
7. active-state Aqua color;
8. optional pulse or progress motion.

If the result already reads as Aqua after step 5, stop. Additional gloss is optional.

### Phase 7 — Add original icon and artwork system

1. Define application/content, toolbar, and source-list icon families separately.
2. Use one virtual top light source.
3. Hand-tune source icons at final output size.
4. Keep toolbar glyphs simple and distinct.
5. Use original content art as the dominant color source.
6. Audit every icon-only action for accessible naming.

### Phase 8 — Validate behavior and visual fidelity

Run existing tests, then add or exercise:

- keyboard traversal and focus order;
- transport-state changes;
- list/table selection and sorting;
- search entry/clear/empty results;
- long labels and localization expansion;
- loading/progress/error/empty states;
- active and inactive app/window state;
- narrow viewport and touch input;
- reduced motion;
- high zoom/text scaling;
- theme profile switch if exposed.

Capture screenshots at a representative wide and narrow size. Compare them against the fidelity checklist in Section 17.

### Phase 9 — Report

The implementation summary MUST state:

- selected profile;
- files/components changed;
- product behavior preserved;
- accessibility provisions;
- tests run and results;
- screenshots or visual checks performed;
- intentional deviations from this specification.

---

## 16. Copy/paste prompt for a coding model

Use the following block when handing this specification to Claude Code, Claude Opus 5, Fable 5, or another implementation agent.

```text
Read APPLE_AQUA_2009_2010_UI_DESIGN_SPEC.md completely before changing code.

Goal:
Restyle and, where necessary, restructure the target interface using the late-2000s Apple Aqua design language documented in that file.

Default profile:
AQUA_PROFILE=snow-leopard-itunes-9

Priority order:
1. Preserve existing product behavior and data integrity.
2. Preserve or improve accessibility, responsive behavior, and platform semantics.
3. Establish the period layout hierarchy before adding material effects.
4. Implement semantic theme tokens and reusable components.
5. Apply restrained Aqua gel only to stateful controls, selection, focus, progress, and the safe default action.
6. Use original assets; do not copy Apple logos, iTunes art, application icons, or proprietary UI bitmaps.

Required process:
- Inspect repository instructions, architecture, styles, components, tests, and available assets.
- Produce a concise audit and a product-to-Aqua component mapping.
- State the selected profile and an implementation plan.
- Implement the window/app shell, unified toolbar, source list, dominant content view, bottom bar, and complete control state system.
- Use the token set and component rules from the specification instead of inventing unrelated values.
- Retain native semantics and keyboard behavior.
- Honor reduced motion and modern minimum touch targets.
- Test active, hover, pressed, selected, focus, disabled, loading, error, empty, inactive-window, narrow, and reduced-motion states.
- Run relevant tests and perform visual checks at wide and narrow sizes.

Style constraints:
- Compact Lucida Grande-like typography.
- Modest radii, crisp one-pixel rims, top-lit neutral chrome, blue source-list navigation, white/striped data views.
- Original colorful 15–16 px source icons for the default iTunes 9 profile.
- No modern glassmorphism, giant rounded cards, neon gradients, excessive blur, or blue coating on every surface.
- No iTunes 10 vertical traffic lights or monochrome sidebar icons unless AQUA_PROFILE=itunes-10-transition.

Before finishing, use the acceptance tests in Sections 17 and 18 of the specification. Report changed files, tests, visual checks, and any deviations.
```

---

## 17. Fidelity acceptance tests

An agent or reviewer should be able to answer every MUST item “yes.”

### 17.1 Composition

- [ ] MUST: One dominant work window/app shell is visually clear.
- [ ] MUST: The titlebar and toolbar read as one continuous neutral surface in the default profile.
- [ ] MUST: Primary navigation is a persistent source list or a responsive equivalent with current-location context.
- [ ] MUST: The main content region is visually dominant and mostly white/neutral.
- [ ] MUST: Bottom-bar actions are visibly subordinate.
- [ ] SHOULD: Artwork, data, and controls form a clear large/medium/small hierarchy.

### 17.2 Material

- [ ] MUST: Rims are crisp and generally 1 px.
- [ ] MUST: The virtual light source is above each dimensional control.
- [ ] MUST: Gel controls have a top specular zone, mid-body color, and darker lower depth.
- [ ] MUST: Neutral controls remain neutral; Aqua blue is selective.
- [ ] MUST: Internal content panes do not all cast independent card shadows.
- [ ] SHOULD: The outer window shadow is stronger than any control shadow.

### 17.3 Typography and density

- [ ] MUST: The font is Lucida Grande or a compact, tuned fallback.
- [ ] MUST: Body/control text is approximately 13 px and list/table text approximately 12 px at desktop scale.
- [ ] MUST: Source-group and toolbar labels are smaller and visually subordinate.
- [ ] MUST: Alignment and repeated 4/8/12/20 spacing are consistent.
- [ ] SHOULD: Data rows remain compact in the default profile.

### 17.4 Components

- [ ] MUST: Transport controls use familiar symbols and keep play/pause spatially stable.
- [ ] MUST: Search is a rounded, recessed field with visible focus and clear state.
- [ ] MUST: Source and row selection have active and inactive variants.
- [ ] MUST: Tables communicate sort state and preserve semantics.
- [ ] MUST: Progress communicates status beyond animation alone.
- [ ] SHOULD: The media toolbar includes a central inset information display when now-playing/status is core.

### 17.5 Interaction

- [ ] MUST: Every control has relevant hover, pressed, focus, selected, disabled, and busy states.
- [ ] MUST: Keyboard users can reach and operate every action.
- [ ] MUST: Focus does not rely on color alone and remains visible on gradients.
- [ ] MUST: Reduced motion removes pulse and nonessential travel.
- [ ] MUST: Destructive actions are clearly worded and separated from safe defaults.
- [ ] SHOULD: Drag, resize, and reorder operations provide immediate visual feedback where supported.

### 17.6 Profile coherence

- [ ] MUST: The selected profile is declared.
- [ ] MUST: Default profile uses horizontal traffic lights and colored source icons.
- [ ] MUST: iTunes 10 profile, if selected, applies vertical traffic lights, monochrome icons, blue-gray navigation, reduced bezels, and looser rows as one set.
- [ ] MUST: Classic gel accent, if selected, strengthens only appropriate controls rather than recoloring the entire shell.

---

## 18. Functional and accessibility acceptance tests

- [ ] App loads with no new runtime errors or console warnings.
- [ ] Existing core workflows still complete.
- [ ] Current selection, current source, and current playback item are programmatically exposed.
- [ ] All icon-only controls have names.
- [ ] Logical tab order follows the visual/task order.
- [ ] Focus is restored after dialogs, sheets, or temporary panels close.
- [ ] Search can be entered, cleared, and escaped by keyboard.
- [ ] Sortable headers expose sort direction.
- [ ] Splitter resizing does not trap the pointer or keyboard.
- [ ] Text at 200% zoom does not become unusable.
- [ ] Touch targets meet the host platform’s current guidance.
- [ ] Selected and ordinary text meet the project’s contrast requirement.
- [ ] No status depends on red/green/blue alone.
- [ ] Busy state includes readable text and an accessible status.
- [ ] Reduced-motion mode contains no looping pulse, moving stripe, or large perspective travel.
- [ ] Empty, loading, error, offline, and disabled states use the same material and type system.
- [ ] Narrow layout preserves current-location and primary-action context.

---

## 19. Anti-patterns: what this style is not

### 19.1 Modern glassmorphism

Wrong:

- backdrop blur on every panel;
- large translucent cards floating over a colorful wallpaper;
- white hairline borders with diffuse glow;
- 20–30 px radii everywhere.

Correct late Aqua:

- mostly opaque, structured regions;
- selective translucency;
- one bounded window;
- modest radii;
- crisp rims and explicit state.

### 19.2 “Everything is blue gel”

Wrong:

- blue toolbar, blue sidebar, blue cards, blue buttons, blue scroll track.

Correct:

- neutral window chrome;
- cool-blue navigation plane;
- white content;
- blue selection/default/progress/focus;
- rich color primarily in content art and small identifying icons.

### 19.3 Generic skeuomorphism

Wrong:

- leather, stitched edges, wood, torn paper, or fake knobs without task meaning.

Correct:

- physical metaphors where users already understand them: transport, scrubber, album cover, shelf/stack, button depression, window layering.

### 19.4 Modern SaaS dashboard structure

Wrong:

- sidebar plus a field of large KPI cards with huge headings, 16 px body type, 16 px radii, and floating action pills.

Correct:

- compact source list;
- dominant table/list/artwork canvas;
- small status bar;
- toolbar of frequent actions;
- dialogs for secondary configuration.

### 19.5 Flat icon inconsistency

Wrong:

- mixing emoji, modern outline symbols, photorealistic icons, and brand logos at random.

Correct:

- separate but coordinated application, toolbar, and source-list families;
- shared lighting and optical weight;
- tiny icons redrawn for tiny size.

### 19.6 Fake OS controls

Wrong:

- clickable-looking traffic lights that do nothing;
- a false browser menu bar that traps users;
- decorative search fields that are not inputs.

Correct:

- real semantic controls when functionality exists;
- decorative chrome removed from the accessibility tree when it does not.

### 19.7 Ahistorical hybrid

Wrong:

- iTunes 10 vertical window controls;
- iTunes 9 colorful source icons;
- classic 2001 pinstriped window body;
- modern Big Sur translucent sidebar;
- iOS 7 typography;
- all in one screen.

Correct:

- select a profile and use its internal cluster consistently.

---

## 20. Design review rubric

Score each dimension from 0 to 3.

| Dimension | 0 | 1 | 2 | 3 |
|---|---|---|---|---|
| Period coherence | Random retro mixture | Some period cues | Mostly coherent with minor drift | Profile is explicit and internally consistent |
| Hierarchy | Effects obscure task | Main task competes with chrome | Clear task with a few noisy areas | Dominant content, subordinate navigation/chrome, precise emphasis |
| Material | Flat or modern glass | Generic gradients | Good depth with small inconsistencies | Crisp top-lit material and disciplined gel |
| Color | Saturation everywhere | Blue-heavy theme | Mostly selective accent | Neutral structure, semantic Aqua, content-rich color |
| Typography | Generic/oversized | Partial compactness | Good roles and density | Tuned Lucida-like roles and exact alignment |
| Components | Screenshot-only styling | Some states missing | Most states coherent | Complete state ladder across all controls |
| Interaction | Mouse-only/unclear | Basic function | Keyboard and feedback largely sound | Direct, discoverable, reversible, fully stateful |
| Accessibility | Broken or absent | Patches after styling | Most semantics/contrast sound | Integrated semantics, focus, motion, target, and zoom support |
| Responsiveness | Desktop mockup only | Cramped collapse | Usable adaptation | Hierarchy and identity survive every target size |
| Asset integrity | Copied/inconsistent | Questionable/mixed assets | Original assets with small issues | Original, licensed, coordinated, hand-tuned icon/art system |

Target: **26/30 or higher**, with no zero in interaction, accessibility, or asset integrity.

---

## 21. Historical details worth preserving—and details to leave behind

### Preserve

- the user’s mental model as the basis of layout;
- one persistent navigator controlling one dominant content field;
- familiar physical playback symbols;
- visible control affordance;
- white/striped high-density lists;
- central now-playing/status display;
- tiny, carefully distinguished icons;
- consistent blue active state;
- direct manipulation with immediate feedback;
- active/inactive window distinction;
- clear safe default and cancel path;
- modest animation that shows ownership or destination.

### Adapt

- small controls: enlarge hit areas for modern touch/pointer needs;
- low-contrast grays: tune to current contrast requirements;
- hover-only disclosure: add keyboard/touch-visible routes;
- Cover Flow movement: provide reduced-motion and list alternatives;
- desktop-only split panes: collapse responsibly on narrow screens;
- old icon metaphors: retain physical clarity but use objects the current audience recognizes.

### Leave behind

- inaccessible fixed sizes;
- mouse-only behavior;
- hidden functionality available only through obscure menus;
- decorative animations that delay work;
- copied Apple graphics, trademarks, or product identity;
- inconsistent one-off application chrome simply because iTunes historically used it;
- nonfunctional fake window controls.

---

## 22. Source notes and bibliography

### 22.1 Primary sources

1. Apple, [“Apple Unveils Mac OS X”](https://www.apple.com/newsroom/2000/01/05Apple-Unveils-Mac-OS-X/), January 5, 2000. Defines the initial Aqua proposition: luminous and semi-transparent elements, fluid animation, and Quartz anti-aliasing/compositing.
2. Apple, [*Aqua Human Interface Guidelines* (October 2001 scan)](https://archive.org/details/apple-hig). Used for the classic gel-button foundation and early exact control metrics; not treated as a 2009 system specification.
3. Apple, [*Apple Human Interface Guidelines: Introduction*](https://leopard-adc.pepas.com/documentation/UserExperience/Conceptual/AppleHIGuidelines/XHIGIntro/XHIGIntro.html), updated June 9, 2008. Defines Aqua appearance and behavior for Mac OS X 10.5.
4. Apple, [*Apple Human Interface Guidelines: Human Interface Design*](https://leopard-adc.pepas.com/documentation/UserExperience/Conceptual/AppleHIGuidelines/XHIGHIDesign/XHIGHIDesign.html), updated June 9, 2008. Source for mental models, iTunes architecture, direct manipulation, discoverability, feedback, consistency, and forgiveness.
5. Apple, [*Apple Human Interface Guidelines: Windows*](https://leopard-adc.pepas.com/documentation/UserExperience/Conceptual/AppleHIGuidelines/XHIGWindows/XHIGWindows.html), updated June 9, 2008. Source for unified chrome, gray frame surfaces, white content, source lists, split architecture, toolbars, and bottom bars.
6. Apple, [*Apple Human Interface Guidelines: Controls*](https://leopard-adc.pepas.com/documentation/UserExperience/Conceptual/AppleHIGuidelines/XHIGControls/XHIGControls.html), updated June 9, 2008. Source for control roles, state, search dimensions, spacing, lists, splitters, sliders, and progress.
7. Apple, [*Apple Human Interface Guidelines: Text*](https://leopard-adc.pepas.com/documentation/UserExperience/Conceptual/AppleHIGuidelines/XHIGText/XHIGText.html), updated June 9, 2008. Source for Lucida Grande roles, type sizes, anti-aliasing, label style, and ellipsis semantics.
8. Apple, [*Apple Human Interface Guidelines: Layout Guidelines*](https://leopard-adc.pepas.com/documentation/UserExperience/Conceptual/AppleHIGuidelines/XHIGLayout/XHIGLayout.html), updated June 9, 2008. Source for center equalization, alignment, visual balance, and representative spacing.
9. Apple, [*Apple Human Interface Guidelines: Icons*](https://leopard-adc.pepas.com/documentation/UserExperience/Conceptual/AppleHIGuidelines/XHIGIcons/XHIGIcons.html), updated June 9, 2008. Source for icon genres, lighting, material, perspective, toolbar simplification, Cover Flow considerations, and output sizes.
10. Apple, [*Apple Human Interface Guidelines: Menus*](https://leopard-adc.pepas.com/documentation/UserExperience/Conceptual/AppleHIGuidelines/XHIGMenus/XHIGMenus.html), updated June 9, 2008. Source for visible/dimmed commands, menu structure, and discoverability.
11. Apple, [“Using the System Control Tint”](https://developer.apple.com/library/archive/documentation/Cocoa/Conceptual/DrawColor/Tasks/SystemTintAware.html), documentation archive. Source for Aqua blue, Graphite, and clear/inactive tint behavior.
12. Apple, [“Apple Unveils Mac OS X Snow Leopard”](https://www.apple.com/newsroom/2009/06/08Apple-Unveils-Mac-OS-X-Snow-Leopard/), June 8, 2009. Product scope and refinement framing.
13. Apple, [*Welcome to Snow Leopard*](https://cdsassets.apple.com/live/6GJYWVAV/user/ma1170_welcome_to_snow_leopard.pdf), 2009. Apple-produced visual reference for the Finder, Dock, Stacks, Exposé, Cover Flow, sidebar, toolbar, tables, search, and scrollbars.
14. Apple, [“Apple Announces iTunes 8”](https://www.apple.com/newsroom/2008/09/09Apple-Announces-iTunes-8/), September 9, 2008. Product context for Genius and visual browsing.
15. Apple, [“Apple Premieres iTunes 9”](https://www.apple.com/newsroom/2009/09/09Apple-Premieres-iTunes-9/), September 9, 2009. Product context for the redesigned Store, iTunes LP, Home Sharing, Genius Mixes, and device arrangement.
16. Apple, [“Apple Introduces iTunes 10 With Ping”](https://www.apple.com/newsroom/2010/09/01Apple-Introduces-iTunes-10-With-Ping/), September 1, 2010. Release boundary and feature context.

### 22.2 Contemporary and specialist secondary sources

17. Rob Griffiths, [“First Look: iTunes 8.0”](https://www.macworld.com/article/192388/itunes8firstlook.html), *Macworld*, September 10, 2008. Grid view, hover browsing, Genius rail, preferences, and accessibility.
18. Dan Frakes, [“iTunes 9”](https://www.macworld.com/article/200107/itunes9-2.html), *Macworld*, September 11, 2009. Shiny chrome, Column Browser, source-list complexity, Grid, and device management.
19. Chris Foresman, [“Hands on: iTunes 9 refinements cool, but hard to find”](https://arstechnica.com/gadgets/2009/09/hands-on-with-itunes-9/), *Ars Technica*, September 11, 2009. Direct description of iTunes 9’s custom chrome, lighter blue navigation, white headers, and pale-blue rows.
20. James Gill, [“iTunes 9 – Interface Changes”](https://www.gosquared.com/blog/itunes-9-interface-changes), GoSquared, 2009. Direct iTunes 8/9 visual comparison: toolbar height/gradient, button material, slider, sidebar, and small icons.
21. Kirk McElhearn, [“First look: iTunes 10”](https://www.macworld.com/article/207495/iutnes10_1stlook.html), *Macworld*, September 2, 2010. Vertical window controls, gray icons, Album List, spacing, and recessed/bezel-less changes.
22. John Siracusa, [“Mac OS X 10.6 Snow Leopard: the Ars Technica review”](https://arstechnica.com/gadgets/2009/08/mac-os-x-10-6/), *Ars Technica*, August 31, 2009. Contemporary visual analysis of Snow Leopard continuity, contrast, Dock menus, fades, QuickTime X, Dock, and Finder.
23. 512 Pixels, [“The History of Cover Flow”](https://512pixels.net/2023/10/the-history-of-cover-flow/), October 2023. Specialist retrospective on Cover Flow’s acquisition, iTunes/Finder use, animation, reflection, and physical-media metaphor.

### 22.3 Evidence boundary

Historical statements are cited to the sources above. The precise hex colors, CSS gradient stops, blur radii, shadow opacities, responsive thresholds, and motion durations in this guide are reasoned reconstruction values. They are intended to produce a coherent visual result on modern rendering systems; they should not be described as leaked, extracted, or official Apple tokens.

---

## 23. Final one-page build brief

If implementation time is short, follow this sequence:

1. Set `AQUA_PROFILE=snow-leopard-itunes-9`.
2. Use a compact Lucida Grande–like 13/12/11/10 px type system.
3. Build one window with a strong shadow, 7 px radius, and a unified 62 px neutral toolbar.
4. Put primary physical controls at upper left, an inset LCD/status display in the center, and a pill search field at upper right.
5. Add a 196 px pale-blue source list with 15–16 px original colorful icons and compact grouped rows.
6. Give the main area to a white sortable table, artwork grid, or meaningful combination; use faint blue row stripes.
7. Add a 22 px gray bottom/status bar for subordinate actions and item counts.
8. Keep ordinary controls clear/silver. Use Aqua gel only for the safe default, selection, focus, progress, and toggled state.
9. Build gel from rim → body gradient → top specular cap → center transition → lower depth → close shadow.
10. Implement every state, including inactive window and reduced motion.
11. Preserve semantics, keyboard behavior, contrast, modern hit targets, and responsive orientation.
12. Use original artwork and icons; do not copy Apple assets.
13. Reject giant rounded cards, pervasive blur, neon blue, and mixed iTunes 9/10 cues.
14. Run Sections 17 and 18 before declaring the work complete.

The period look is achieved when **content remains calm and useful, structure feels precise, controls look touchable, and blue light appears only where the interface is alive**.
