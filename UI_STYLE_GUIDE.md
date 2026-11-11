# UI Style Guide — "Chunky Arcade"

A project-independent guide to this UI language. It is written for whoever builds the next screen — human or
agent — on this project or any other Roblox project. It states **rules and arithmetic**, not file inventories.
Where a number appears, the reason it is that number appears beside it.

The look in one sentence: **a saturated rectangular card, lifted off a darker plate of its own hue, wrapped in a
thick near-black outline, with bold outlined text on top.**

---

## 1. The Chunky Component Anatomy

**There are two anatomies, and which one applies is decided by one question: can you press it?**

A **control** — a tab, a chest button, a close button — is an object sitting on something, so it has the five layers. A
**panel** — a sheet, the picker, the payout, a toast, the phase banner — is a surface, so it has one layer. Dimensions and
content differ within each family; never the structure.

```
CONTROL                                    PANEL
Container   transparent, owns the cell     Container   transparent, exactly the face's box
├─ Shadow   darker plate, fills the cell   └─ Face      the panel: filled, rounded, outlined
└─ Face     bright card, inset from the                    ├─ Border   UIStroke
   │        shadow's far edges                            └─ Content
   ├─ Border   UIStroke on the face
   └─ Content  icon, title, badge, list
```

**A panel has no shadow plate (item 195).** Not "a plate with depth 0" — none. §1.2b records the three rounds of bugs
that produced that decision, and §1.1's arithmetic below applies to controls.

### 1.1 The Golden Math of Depth

This is the whole trick for a control, and it is arithmetic, not taste.

**A `UIStroke` is drawn centred on the edge it strokes.** A stroke of `X` pixels therefore extends `X / 2`
pixels *inside* the frame and `X / 2` pixels *outside* it.

The shadow plate is what shows in the strip the face does not cover. If the face is inset by `D` pixels from the
shadow's edge, and the face carries a border of `X` pixels, then the **visible shadow** is:

```
visible shadow = D − (X / 2)
```

| Face inset `D` | Border `X` | Visible shadow | Reads as |
|---|---|---|---|
| 4 | 4 | **2 px** | a slightly thick outline — flat |
| 6 | 3 | **4.5 px** | shallow depth |
| 8 | 4 | **6 px** | depth |

**The rule, stated as a constraint:**

```
D ≥ (X × 2)
```

At `D = 2X` exactly, the visible strip equals the border's own thickness — the point at which the eye stops
reading the strip as "another plate" and starts reading it as "the border got thicker". Anything below `2X` and
the outline *eats* the shadow entirely: the component animates correctly, has all the right layers, and still
looks flat. **This is the single most common way to build this style wrongly.** If a chunky component reads
flat, check this inequality before touching anything else.

**The numbers in use.** Both control scales obey it, and the panel scale has no depth to check:

| Scale | Depth `D` | Border `X` | Visible |
|---|---|---|---|
| Card / tab (`CHUNKY_DEPTH`) | 8 | 4 | 6 px |
| Control inside a panel | 6 | 3 | 4.5 px |
| Panel / sheet | **none** | 6 | — (§1.2b) |

Depth is a **fixed pixel inset**, never a scale fraction. A scale-based inset vanishes on a small card and
becomes a slab on a large one; a pixel inset reads as a cast shadow at every size. Roughly a tenth of the
component's width is the proportion the reference art uses.

### 1.2 Which way the inset goes

The face is anchored at the container's **top-left** and made `D` pixels **short on its bottom and right**
edges. The shadow therefore shows along the far edges only — a one-sided strip. This matters:

- **A one-sided strip reads as thickness. A symmetric ring reads as a second border.** Do not centre the face.
- **Do not achieve the offset with a negative position.** A face positioned at `(-D, -D)` at full size produces
  the identical picture but *overhangs the container* by `D` on the top and left. Inside a `UIListLayout` that
  eats the gap to the neighbour above; against a screen edge it clips. Inset the face instead — same shadow, same
  place, and the component's union stays exactly the cell it was given.

### 1.2b Depth belongs to controls only. Panels have no shadow plate.

**The rule, stated once: if you cannot press it, it has no depth.** A panel is a surface; a control is an object. The
control's depth is the inset in §1.2 — a shadow strip inside a **fixed layout cell**. A panel has **one face, one outline,
one corner radius** and nothing behind it.

**The offset sibling is deleted, and it is worth recording why (item 195).** For three rounds panels carried a second
`Frame` nudged `D` down and right, on the argument that a child cannot draw behind its own parent's background. The
argument was true; the design was still wrong, because a panel is usually `AutomaticSize` and **a container measures all
of its children**. The frame grew by the plate's overhang, the face stopped being the container's own box, and what
remained of the plate was a sliver along two edges. That one cause produced both reported symptoms:

- **"there is no panel underneath to give it depth"** — the visible band was narrower than the offset, so a short chip had
  nothing that read as depth at all;
- **"a black line at the top right"** — the sliver's edge showing past the face's `UICorner` arc.

Items 122 and 123 had each already spent a round on a variant of this (a square plate under a rounded face; a pale corner
that was never the shadow). Three fixes to a cosmetic plate is the signal: **the plate is the defect.**

| | control (pressed) | panel (readout or containment) |
| --- | --- | --- |
| shadow plate | yes — inset strip inside the cell | **none** |
| face | inset by `D` on the bottom/right | fills the container exactly |
| edge | outline over the shadow strip | outline only |
| union | exactly the cell | the container's own box |

**What is lost, plainly:** sheets no longer read as cards raised off the screen. They read as flat charcoal panels with a
thick near-black outline and a rounded corner — the same silhouette as everything else, which is the look that was asked
for. `CHUNKY_PANEL_DEPTH` and `CHUNKY_PANEL_SHADOW` are **deleted**, not set to zero; this tree removes inert values.

**Still true, and still the mechanism for controls:** the plate is the same size as the face and only its *position* moves
(§1.3), and a plate never has a size of its own — it is the face, moved, inside a cell the layout already fixed.


### 1.3 Corners: every plate that exists carries the same radius

**Every plate in a component carries the same `UICorner` radius — the shadow included, where there is one.** A square plate
under a rounded face is a silhouette mismatch: the control reads as a different component family from the tabs and cards
beside it, and the eye notices the *shape* long before it notices the colour. **Panels have no plate at all** (§1.2b), so
this applies to controls only.

The radius is one number per scale:

| Scale | Radius | Depth |
|---|---|---|
| Card / tab | 8 | 8 |
| Panel / sheet | 12 | **none** (§1.2b) |
| Control inside a panel | 8 | 6 |

Two consequences worth knowing:

- **A rounded plate does not cover its own bounding box**, so a few pixels at the component's outermost corners
  show whatever is behind it ? roughly `0.29 ? radius`, so about 2 px at radius 8. That is invisible **when the
  shadow is a saturated dark shade of its face and everything around it is a surface of similar value**, which is
  the normal case. It becomes a visible notch only when a *pale plate* sits directly behind the component; if you
  see a pale corner, the plate behind is the bug, not the shadow. (That exact mistake cost two rounds here: the
  fix was removing a light section fill behind the buttons, not squaring their shadows.)
- **Do not try to fix the corners by clipping the container.** `ClipsDescendants` on a rounded container does not
  reliably produce a rounded clip, so the shadow keeps its square silhouette ? the component is then pointed with
  a clip that does nothing. Round the plate itself — or, for a panel, have no plate to round.


### 1.4 Border mode

Name `ApplyStrokeMode` explicitly on every plate stroke. On a frame, use `Border` — the face's own box is what
is being outlined. Leaving it to the default is how a component acquires an outline around its *fill* and
nothing around its edge.

### 1.5 One stroke per object

**A GuiObject honours exactly one `UIStroke`.** Add a second and it does not stack — the newer instance takes
over, and which one wins is not something to rely on. If a component needs a coloured ring *plus* the chunky
black border, the ring goes on its **own transparent frame** filling the face, carrying its own stroke and
copying the face's corner radius. Two strokes, two objects.

Symptom of getting this wrong: an item's border changes colour when it is rebuilt, and looks unchanged
immediately after being clicked. That is not a rebuild bug; it is a lost stroke.

---

## 2. Colour & Typography Rules

### 2.1 Shadows are saturated, never neutral

**Do not use black or grey for a shadow plate.** Use a darker, more saturated version of the face colour: red
face, dark red shadow; blue face, dark blue shadow.

Two reasons, and both are load-bearing:

1. **A neutral shadow reads as a different object.** The plate behind the card is supposed to be *the same
   surface, in shadow*. Changing its hue to grey says "this is a second material".
2. **The shadow has to stay distinguishable from the border.** The border's outer half sits directly on top of
   the shadow strip. If shadow and border are close in value, the strip disappears — the same flat-looking
   failure as the depth arithmetic, arrived at from the colour side. Keep a **three-value ladder**: face →
   shadow → border, each clearly stepped down.

Reference pairs in use:

| Component | Face | Shadow |
|---|---|---|
| Store tab | `232, 68, 68` | `170, 34, 34` |
| Inventory tab | `64, 140, 240` | `26, 82, 160` |
| Panel / sheet face | `52, 52, 58` | `26, 26, 30` |
| Panel outline | — | `10, 10, 12` |

Derived shadows are acceptable where a face colour is theme-driven: **45% of the face's brightness**, same hue.
A shadow that is a scalar multiple of its own face can never drift out of hue, which is the specific failure
hand-picked pairs exist to avoid.

### 2.2 Borders are near-black

`20, 20, 20` for component outlines, `10, 10, 12` for a panel's. Never a themed accent, never a light colour.
The near-black outline is what makes the saturated face read as a physical object rather than a coloured
rectangle.

### 2.3 Panel faces are neutral, controls are not

- **A large surface is furniture.** A panel is charcoal — a full-height red sheet behind pale cards is a wall
  of colour that every item on it has to fight. The identity colour belongs on the tab that *opens* the panel,
  which is where it is doing its job.
- **A control is an object.** Buttons, tabs, cards and rows keep their identity colour, because the colour is
  the affordance.
- **A readout is a panel, not a control** — and it is *not* exempt from the language. The phase banner was the one
  surface that stayed in the flat HUD palette, on the argument that a fact display has nothing to press and therefore
  nothing to style. **That is reversed (item 193):** the banner is the most-seen surface in the game after the ball, and
  it was the only one a player could not mistake for this game's. It is built through `buildChunkyPanel` — the panel
  builder, *not* `applyChunkyChrome`, which dresses an existing `GuiButton` and would invert a stack around a hit area
  that does not exist. Its labels stay on big-ui `Text` because the chunky face is charcoal (§2.3's own rule), and pale
  ink on charcoal is exactly the pairing item 58 found big-ui could do.
- **So the rule is the builder, not the input.** A surface with no control takes `buildChunkyPanel`; a surface that is
  pressed takes `buildChunkyButton` or `applyChunkyChrome`. "Readout" is no longer a reason to stay flat.

### 2.4 Typography

**Bold faces only.** `GothamBlack` for titles and badges, `SourceSansBold` or `GothamBold` where `GothamBlack`
is too heavy. Nothing in this style uses a regular weight.

**Text carries its own outline.** A `UIStroke` on the `TextLabel` / `TextButton` itself, black, `2–3` px, and
**left in the default `Contextual` mode** — on a text object that strokes the *glyphs*, which is the sticker
outline the style wants. `Border` mode would draw a rectangle around the label instead. This is the one place
the default is correct; every plate stroke names `Border` explicitly.

| Use | Thickness |
|---|---|
| Body and captions | 2 |
| Titles, badges | 3 |

**Every label in a panel gets it, not most of them.** A panel with outlined headings and bare body copy reads
as a half-finished migration. Attach the outline at the point the label is created — one factory, or one helper
called at each creation site — so "every label is outlined" is verifiable by searching for one name.

### 2.5 Scaling

**`TextScaled` is only safe next to a `UITextSizeConstraint`.** Without one the engine is free to shrink a
nine-letter label to a six-pixel smear on a phone and to blow a four-letter one up to the width of the card on a
monitor.

The **ceiling also keeps a set of components looking like a set.** `TextScaled` fits each label to its own
length, so with a generous cap a five-letter tab renders far larger than a nine-letter one and the row reads as
two different sizes. Cap at what the *longest* label in the set can reach; the short ones simply stop growing.

Sensible bounds: `10` minimum for captions, `14` for a card title, `8` for a badge mark.

### 2.6 Type is scaled by table, not by call site

When a screen wants its type one step larger, **change one table, not a hundred literal reads**. A scale with a
ladder of distinct sizes (`11 → 12 → 14 → 16 → 18 → 24 → 32`) and one derived table that shifts every variant
up a step keeps the whole screen consistent — and keeps the *bands* consistent too, because a row sized from its
label's line height grows with it. Scattered `TextSize` edits put the type and the space it needs out of step.

---

## 3. Interaction States

### 3.1 Raised and pressed

This style needs exactly two states, and they differ in geometry only:

- **Raised (default):** the face is inset by `D` on its far edges. The shadow is visible. The object looks
  lifted.
- **Pressed (selected / held):** the face **grows to fill the cell** and covers the shadow completely. The
  object looks pushed in.

**It must grow, not slide.** A face of the raised size *moved* to the shadow's offset covers the shadow on two
edges and leaves an L of it along the other two — which reads as a component shoved sideways, not pressed.

**Selection needs no second colour.** A selected tab is simply the pressed one. That means there is no second
palette per component, nothing for a caller to keep in step, and no state where a tab's colour disagrees with
whether its panel is open.

### 3.2 Hover and press feedback

Scale the whole control with a `UIScale` (~`1.03` hover, ~`0.97` press, ~`0.1` s). **Never tween size** —
scaling does not change the layout box, so pressing one item in a grid cannot nudge its neighbours.

Set `AutoButtonColor = false` on every button. The engine's own pressed tint is a second piece of feedback for
one press, in a different visual language.

### 3.3 Disabled

Dim the **face and its labels**, not the button's `TextTransparency`. Once a component moves its caption onto a
child label inside the face, the button's own text properties do nothing — a disabled state that "stopped
working" after a restyle is almost always this.

Suggested wash: `0.45`. High enough to read as inactive on a saturated fill, low enough that the caption still
explains *why* it is inactive.

---

## 4. Responsive Layout Strategy

In Roblox, the equivalent of responsive web layout is mainly **Scale-based `UDim2` sizing, layout objects, flex, and size constraints**. A useful distinction: **Scale adapts to the screen; Offset keeps small details—like padding and touch-target sizes—readable.** Don't try to solve the whole layout with either one alone.

> **Build this UI responsively for phones, tablets, and desktop.** Don't position every element with fixed pixel coordinates. Use `UIListLayout` or `UIGridLayout` to arrange related elements, `UIFlexItem` where content should fill or shrink into available space, and `AutomaticSize` for sections that should fit their contents. Use Scale-based `UDim2` for sizes and spacing that should adapt to their parent, and Offset for deliberate pixel-sized details such as padding, gaps, or minimum touch-target sizes.
>
> Constrain panels to sensible minimum and maximum sizes with `UISizeConstraint`. When the design needs a percentage of the *screen*, use the project's `addViewportConstraint` helper so the cap updates when the viewport changes. Let fixed header/footer sections take the space they need and let the main content flex into what remains. If the content can exceed that space, put it in a `ScrollingFrame` rather than letting it clip or push other sections off-screen.
>
> Keep text readable on narrow screens: wrap or scale it intentionally, and set minimum text sizes where appropriate. Don't make buttons or touch targets so small that proportional scaling makes them hard to use. Check the finished layout at phone portrait, phone landscape, and desktop sizes.

> **Naming note for this repository.** The paragraph above is the portable statement of the policy and is kept
> verbatim. In *this* tree the two illustrative files are named differently: the viewport-aware bound helper is
> `src/shared/ui/viewport.ts` (`capToViewport`), and the content-sized-band / flexing-content examples are
> `src/shared/ui/chunky-panel.ts` (the sheet) and `src/shared/ui/panel.ts` (`PanelHeader`, `PanelFooter`, the
> `TabStrip` band). There is no `viewportConstraint.ts` or `panelChrome.ts` here.

### 4.1 The rules worth restating

- **Structure with layouts, not offsets.** Header, tabs, content and footer are children of one vertical
  `UIListLayout` with `LayoutOrder`. Nothing is positioned by hand, so a band's height is its own business and
  no constant has to be updated in four places when it changes.
- **Let the content decide the height where it can.** A sheet whose height is its content plus its bands never
  has empty space in it and never clips.
- **Beware the circular size.** A child at `Scale (1, 1)` inside a container that is `AutomaticSize.Y` is
  circular: the container asks the child for a height, the child scales to the container. The engine resolves it
  by collapsing one of them — silently. **The child must be the one that reports**: given `AutomaticSize.Y` and
  a `0`-pixel height, so the container can follow it.
- **Clips descendants deliberately.** A scrolling region clips. A sheet that is meant to fit its content does
  not, so an overgrown sheet is a visible bug rather than a silent amputation.
- **Fixed-pixel bands do not grow with the type.** If the sheet's type scale is bumped, headers, tab strips and
  footers are still the heights they were. Check the tallest glyph against the tightest band; `24` px of glyph in
  a `44` px header is the case that goes wrong first.

### 4.2 Scale the composition, do not rearrange it (item 160)

**A phone gets the desktop composition, smaller — never a different arrangement.** Every screen-space panel is laid out at
its designed pixel size on every device and then drawn through **one `UIScale`**, computed by `shared/ui/ui-scale.ts`:

```
scale = clamp( min( viewport.X × 0.92 / design.X,
                    viewport.Y × 0.90 / design.Y ), 0.45, 1 )
```

One number multiplies width, height, gaps, corners, strokes and type together, so **every proportion survives**. That is the
whole difference between a scale and a reflow:

| | reflow (wrong here) | scale (right here) |
| --- | --- | --- |
| phone shows | a rearranged store: stacked sections, re-proportioned bands | the same store, smaller |
| driven by | a width breakpoint | one uniform multiplier |
| fails as | "you changed the layout", overlapping bands | nothing, until text is too small |

**The design size is read from the panel itself.** `UIScale` multiplies *rendering* and does not touch `Size`, so
`root.Size`'s offsets are the design size at all times — including an auto-height sheet, where `AutomaticSize.Y` writes the
resolved content height back into `Size.Y.Offset`. One function serves six panels with no per-panel constant table to keep in
step.

**A fixed pixel width does not overflow a small screen when nothing clamps it.** An 880-pixel sheet drawn at `0.75` is 660
pixels; it overflows only when something *also* clamps its layout box.

#### A scaled frame shrinks about its `AnchorPoint`, so anchor it where it must not move (item 164)

`UIScale` multiplies the frame's **`AbsoluteSize`**, and `AbsolutePosition` is then derived from `AnchorPoint` against that scaled
size. So the anchor is the point the composition holds still while it shrinks:

| `AnchorPoint` | what happens as the scale drops |
| --- | --- |
| `(0, 0)` | the top-left corner is nailed down and the whole box pulls in toward it |
| `(0.5, 0.5)` | the centre is nailed down; it shrinks evenly on all four sides |
| `(0.5, 0)` | horizontally centred, top edge fixed — "top middle" |

**A host anchored at the origin drags its centred children up and to the left by `(1 − scale) / 2` of its own box.** That is not a
subtle drift: the first chest-reveal grid shipped as a correct `5 × 2` arrangement sitting off the screen's top-left corner, because
its host was a full-screen frame at `(0, 0)` with the cards at `0.5` of it — the cards were centred in the *scaled* box, and the
scaled box had collapsed toward the corner. The panels never had this bug because they are anchored at `(0.5, 0.5)`; any new
scaled composition has to answer the same question before it is drawn.

**Size the host to the composition, not to the screen.** A host whose `Size` is the screen makes `0.5` mean "middle of the screen"
rather than "middle of the grid", which is only the same thing when the grid fills the screen.

#### Why `capToViewport` is not used on these panels

`capToViewport` installs a `UISizeConstraint`, which clamps **layout** size per axis. Given an 880-wide sheet and a 390-wide
viewport it sets the width to 358 and leaves the height alone — squashing the composition and re-flowing every band inside it,
which is the distortion the uniform scale exists to avoid. `UIScale` is applied *after* layout, so the geometry is untouched.
**The two mechanisms answer the same question and only one of them can be in a panel.**

#### Breakpoints

There are none left in the store or the inventory. Both had one that stacked their columns below 900 viewport pixels, which
made a small screen show a different composition. A panel that scales has no reason to branch on width: the sheet's own width
never changes, only the multiplier applied to it.

#### The legibility floor, and the honest trade

`MIN_PANEL_SCALE` is `0.45`. Below it the arithmetic is ignored and the panel is drawn **wider than the screen** — visible,
clipped and reportable — rather than shrunk until its 12-point captions resolve to four points, which is on screen and
unreadable. That is the "if something hits a practical minimum, constrain that element rather than breaking the layout" case:
the floor is the constraint, and the overflow it produces is the symptom that says the screen is too small for this
composition.

In practice the floor only binds on a **portrait** phone. This game is played in landscape, and a 844 × 390 viewport draws an
880 × 466 store at `0.75` — full composition, legible type, comfortably inside the screen.

### 4.3 Layers and input (item 161)

**Eight `ScreenGui`s, one function, one order.** `getScreenGui(layer)` is the only way to obtain one, and a layer names a rank,
not a device:

| layer | order | insets | tenants |
| --- | --- | --- | --- |
| `fullScreen` | 10 | `None` | scenery that must reach the screen edge |
| `hudCore` | 20 | `CoreUISafeInsets` | the leaderboard, **the picker**, **the spectate button** |
| `hudTopbar` | 30 | `TopbarSafeInsets` | the phase banner |
| `splash` | 35 | `CoreUISafeInsets` | the elimination splash, the payout panel, the countdown |
| `sheet` | 37 | `CoreUISafeInsets` | **the store, the inventory, the rail** |
| `reveal` | 38 | `None` | **the chest reveal** |
| `toast` | 39 | `CoreUISafeInsets` | the reward toast |
| `transition` | 40 | `None` | the round wipe — covers everything, always |

**A sheet is above the splashes and below the wipe**, because a splash drawn over an open sheet is legible only by accident, and a
sheet drawn over the wipe reads as a store that refuses to close. **The toast is above the sheets**, because a reward that arrives
while the player is shopping must not be hidden by the shop — the same rule as "a toast may never be silently dropped".

**Three constraints need four integers, and two `ScreenGui`s may never share one.** The reveal must be above the sheet it was
opened from, the toast must be above the reveal (item 133's rule), and the wipe must be above everything — so the chain is total
and no two layers tie. A tie is not a near-miss: two guis at the same `DisplayOrder` are ordered by sibling position in
`PlayerGui`, which is not a correctness property any controller should be leaning on. The reveal (item 163) took `38` and the
sheet stepped down to `37`; pushing the toast up one instead would have put it above the wipe, where a reward message would float
on the black of a phase transition.

**Do not swallow panel input with a GUI blocker.** The obvious fix — a full-screen transparent `TextButton`, `Active = true` —
**stops the click and not the character**: the dynamic thumbstick belongs to the `PlayerModule`'s touch controls, which read
`UserInputService` rather than GUI hit-testing. Use `client/controls-lock.ts` (`lockControls()`, returning an idempotent release)
instead. It sets `GuiService.TouchControlsEnabled = false` synchronously — the mechanism that cannot silently no-op — and asks
`PlayerModule:GetControls():Disable()` on a background thread for gamepad and keyboard. **Never resolve `PlayerModule` inline**:
doing so blocked the client for 2.6 s in the first run of this feature.

**The lock follows the panel's visibility *and* the phase.** A panel left open across a phase change stays visible but gives
movement back, so a player who forgot to close the store can still race under it. A frozen joystick with no log line explaining it
is the failure this rule exists to prevent.

**The lock is counted, so two overlays may both hold it.** `lockControls()` increments on every call and restores on the last
release, so the store and a reveal open on top of it each take their own hold and neither can hand movement back while the other is
still up. That is why the reveal's `Modal` question has a boring answer: there is no `ScreenGui.Modal`, nothing to release, and the
store's own hold is simply left alone.

### 4.4 A card flip is `Size.X`, never `Rotation` (item 163)

**`Rotation` is a 2D spin and a `Frame` has no `CFrame`.** Rotating a card turns it like a page on a table — the text goes sideways
and the far edge still shows the *same face*, mirrored. It never shows the back of anything, which is the one thing a flip has to do.

**A flip is the width collapsing to nothing and coming back, with the face swapped at the zero-width instant** — the frame where
nobody can tell which side is which. `Size.X` tweens to `0`, `back.Visible = false` and `front.Visible = true`, `Size.X` tweens back.
The animation is entirely 2D; the third axis is supplied by the viewer.

**`UIScale` cannot do it**, and that is why the drop and the flip use different mechanisms: `UIScale` scales both axes together, so
taking it to zero is a collapse rather than a turn. The reveal therefore pops its cards in with a `UIScale` (the splash's idiom) and
turns them with `Size`, so each property has exactly one owner and neither tween has to start from whatever the other left behind.

---

## 5. Common Pitfalls

### 5.1 The empty square

**An `ImageLabel` whose image fails to resolve still occupies its box and draws nothing.** A placeholder asset
id therefore produces a correctly-sized, completely empty square in the middle of an otherwise finished
component — which looks exactly like a layout mistake and gets diagnosed as one.

Two habits:

- **Warn at build time** when a component is mounted with a placeholder id, naming the component and the id, so
  the empty square is attributed to the asset and not the layout.
- **Give the slot a fixed size** so it is obviously a slot. A missing icon should look like a reserved space,
  not like a gap.

### 5.2 `Scale = 1` inside a list overflows

A child sized `Scale (1, 0)` inside a `UIListLayout` with horizontal fill does **not** share the row with its
siblings — it asks for the *whole* width, and the layout's own padding and gaps are added on top of that. Two
such children overflow the parent by exactly the gap between them, and the overflow is invisible until something
clips.

Use a **negative offset** for the share: `(0.5, -gap/2)` for two equal columns, `(0.5, -gap)` for two with more
breathing room. The same applies vertically: `(1, 0, 1, 0)` inside a `UIListLayout` with padding is always a
little too tall.

### 5.3 A zero-height label clips its own glyphs

`Size = (1, 0)` with no `AutomaticSize` is a label with no room for text. It renders as nothing, and it looks
like a missing font or a colour bug. Either give it a real height (the variant's line height) or make it
`AutomaticSize.Y`.

### 5.4 `ZIndex` ties between a background and a label

A tie is resolved by creation order, which means the result depends on which line ran first. If a background is
created after a label at the same `ZIndex`, the label disappears — on some instances and not others.

**State the ordering.** Every plate, overlay, label and badge gets an explicit `ZIndex` in the intended stacking
order, and a child of a face is at least `face.ZIndex + 1`.

### 5.5 A child cannot draw behind its own parent's background

So a **control's** shadow plate is a sibling of its face and both live under a transparent container. This is also why
"add depth to an existing button" means *inverting the stack*: the button becomes a transparent hit area and the
plates become its children. The consequence to remember: **the button's own `Text` is then covered**, and its
caption has to move to a `TextLabel` inside the face.

**A panel does not face this problem, because it has no plate (§1.2b).** Do not read this section as a reason to give a
sheet a sibling plate: the sibling has to be measured, and a measured sibling inside an `AutomaticSize` container is
exactly what left a sliver of plate and a black line at a corner.

### 5.6 One `UIStroke` per object

See §1.5. Reaching for a second stroke on the same frame is silent, and it costs the black border.

### 5.7 Tuning constants from a stale docblock

Docblocks in this project describe the numbers they sit beside, and they drift. **Read the constant, not the
paragraph.** Two separate rounds in this project's history were spent chasing behaviour that a comment described
and the code no longer did.

---

## 6. Reference Implementation

`src/shared/ui/chunky-button.ts` is the canonical example. It is worth reading in full before building anything
new, because it is the smallest complete instance of every rule above:

- **Depth arithmetic** — `CHUNKY_DEPTH = 8` against `BORDER_THICKNESS = 4`, with the "why 8 and not 4"
  paragraph in the constant's docblock being the clearest statement of §1.1 anywhere in the tree.
- **Layer order** — container, shadow, face, border, pattern, icon, title, badge, in that order, with the
  `ZIndex` ladder spelled out.
- **Colour as argument, not theme lookup** — the builder knows no colours; a caller supplies the face/shadow
  pair. That is what makes it reusable without exporting new art per component.
- **Pressed state** — `setRaised(false)` grows the face to cover the shadow, and the docblock explains why it
  must grow rather than slide.
- **Text outline** — a `UIStroke` on the title in the default contextual mode, plus a `UITextSizeConstraint` on
  a `TextScaled` label.
- **Badge** — a circle via `UDim.new(1, 0)`, not a fixed pixel radius, so it stays circular at any diameter.

Companions, in increasing scale:

| File | What it contributes |
|---|---|
| `src/shared/ui/chunky-button.ts` | the card: depth, outline, icon slot, outlined title, badge |
| `src/shared/ui/chunky-chrome.ts` | the same chrome applied to an **existing** button; the ring helper; the disabled wash |
| `src/shared/ui/chunky-panel.ts` | panel scale: neutral face, thicker stroke, auto-height face |
| `src/shared/ui/text.ts` | the one glyph-outline helper |
| `src/shared/ui/theme.ts` | the chunky dark direction: opaque charcoal surfaces, pale ink |
| `src/shared/ui/scale.ts` | the type ladder and the one-step-up derived table |

---

## 7. Checklist

Before calling a chunky screen finished:

- [ ] Every **control** plate's depth satisfies `D ≥ 2X`, and the visible strip was computed rather than eyeballed.
- [ ] No **panel** has a shadow plate at all — one face, one outline, one radius.
- [ ] Every shadow is a saturated shade of its own face, and face/shadow/border form a three-value ladder.
- [ ] Every plate stroke names `ApplyStrokeMode.Border`; every text stroke does **not**.
- [ ] No object carries two `UIStroke`s.
- [ ] A control's shadow and its face carry the **same** corner radius; neither is square.
- [ ] Every label is outlined, including the ones on buttons that carry their own text.
- [ ] `TextScaled` appears only with a `UITextSizeConstraint`.
- [ ] Selection is expressed by the pressed state, not by a second colour.
- [ ] Disabled state dims the face and its labels, not the button's `TextTransparency`.
- [ ] No `ZIndex` tie between a background and anything drawn on it.
- [ ] Placeholder asset ids warn at mount; every icon slot has a fixed size.
- [ ] Checked at phone portrait, phone landscape and desktop.
