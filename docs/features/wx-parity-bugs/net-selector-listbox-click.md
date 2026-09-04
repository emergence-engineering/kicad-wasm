# Net selector dropdown: rows cannot be picked with the mouse (DOM listbox click contract)

Status 2026-09-04: FIXED in the wx port (see "Fix"); reproduced deterministically
by `tests/kicad/zone-net-selector.spec.ts` (in-app) and
`tests/e2e/combopopup.spec.ts` (wx-level, standalone app
`tests/apps/standalone/combopopup`) — both RED on the pre-fix build, GREEN after.

## Symptom

User report (staging `blinky-328`, build `staging-d7656b7`): pcbnew → Draw Filled
Zones → click on the board → *Copper Zone Properties* opens → the *Net name*
dropdown opens and lists the nets, but clicking a net does nothing: the popup
stays open and the combo keeps `<no net>`. Only Escape closes the list.

Reproduced in the harness (`tests/apps/kicad/pcbnew.html`, pic_programmer):
after the click the browser has selected the `GND` `<option>` (it is
highlighted, focus is on the `<select>`), the wxComboCtrl still shows
`<no net>`, the popup stays open, and an outside click on the dialog does not
close it either.

## Three port defects

KiCad's `NET_SELECTOR` is a `FILTER_COMBOBOX` (`wxComboCtrl`); its popup
`FILTER_COMBOPOPUP` (`common/widgets/filter_combobox.cpp`) is a `wxPanel`
holding a filter `wxTextCtrl` and a `wxListBox`. It accepts a row from the
mouse in exactly one way:

```
m_listBox->Connect( wxEVT_LEFT_DOWN, ... FILTER_COMBOPOPUP::onMouseClick )
onMouseClick: m_listBox->SetSelection( m_listBox->HitTest( pos ) ); Accept();
Accept(): Dismiss(); GetComboCtrl()->SetValue( ... ); post FILTERED_ITEM_SELECTED
```

(plus `wxEVT_LISTBOX_DCLICK` → `Accept()`, "Enter in a ListBox comes in as a
double-click on GTK"). wxGTK/wxMSW/wxOSX deliver `wxEVT_LEFT_DOWN` for their
native list widgets and implement `HitTest`.

### 1. The DOM port never delivered LEFT_DOWN to a wxListBox, and HitTest was a stub

`wxListBox` is a real `<select multiple>` (`wx-dom.js` node type `listbox`).
The input-forwarding layer in `wx-dom.js` deliberately keeps LEFT clicks on
interactive DOM controls on the native path only (their own `click`/`change`
listeners → `wx_dom_event`); only passive controls forwarded left presses into
the wx mouse pipeline (`wx_dom_mouse` → `wxApp::HandleMouseEvent`). So the
popup's handler never ran. Had it run, `wxListBox::HitTest` was still the
`wxListBoxBase` default (`wxNOT_FOUND`) — the port's `listbox.cpp` never
implemented `DoListHitTest`. The DOM `change` did fire `wxEVT_LISTBOX`, which
the popup does not listen to, and no `dblclick` was mapped at all.

### 2. Transient popups did not dismiss on an outside click when their content is a panel

`wxPopupTransientWindow` (generic `src/common/popupcmn.cpp`) dismisses on an
outside click through a pointer grab (GTK) / activation (MSW), and otherwise
through `wxPopupFocusHandler` pushed on *the one window* `Popup()` focused.
For a `wxComboCtrl` popup that window is the popup control (the
`FILTER_COMBOPOPUP` panel) — and `wxControlContainer` delegates a panel's
`SetFocus()` to a child, so the handler's window never actually held focus and
never saw it leave. The port has no grab, so nothing dismissed the dropdown on
an outside click (the toolbar palettes in `e2e/popup.spec.ts` were fine: they
focus the popup window itself).

### 3. Any second press within 500 ms was a double-click, whatever the distance

`src/wasm/mouse.cpp` synthesizes `wxEVT_*_DCLICK` itself (Emscripten's event
has no click count): two MOUSEDOWNs of the same button within
`WASM_DCLICK_MSEC` (500 ms). Every desktop port also requires the two presses
to land within a few pixels of each other (GTK `gtk-double-click-distance` 5,
MSW `SM_CXDOUBLECLK` 4). Without that test a toolbar click followed 400 ms
later by a click on the canvas, or the combo's drop button followed by a pick
in its list, arrived as `wxEVT_LEFT_DCLICK`. KiCad's zone tool acts on
`IsClick()` only (`runPolygonEventLoop`), so the first board click after
picking *Draw Filled Zones* quickly did nothing (that is why the in-app spec's
first attempts never saw the dialog, with the tool button drawn checked); the
filter popup binds LEFT_DOWN only, so a quick open-then-pick was ignored; and
the outside-click dismissal (2.) was skipped for the same reason.

## Fix (all in the wasm layer)

`wxwidgets` (`staging-wasm-port`):

- `build/wasm/wx-dom.js`: `listbox` nodes carry `data-wx-forward-left`; the
  document-level `mousedown`/`mouseup` forwarders now forward LEFT presses for
  those (alongside passive controls; middle/right unchanged), so the browser
  still selects the row natively *and* wx gets `wxEVT_LEFT_DOWN`/`UP` with
  client coordinates. New `wxDomListHitTest(domId, x, y)` maps a client point
  to the `<option>` (or checklist row) under it from live layout. `dblclick`
  on a listbox dispatches the new `wxDOM_EVENT_DBLCLICK`.
- `src/wasm/listbox.cpp` + `include/wx/wasm/listbox.h`: `DoListHitTest`
  override → `wxDomListHitTest`; `OnDomEvent(DBLCLICK)` fires
  `wxEVT_LISTBOX_DCLICK` for the current selection.
- `src/wasm/window.cpp` + `src/wasm/app.cpp`: `wxWasmDismissTransientPopupsOutside(target)`
  dismisses (with `OnDismiss` notification, like a grab-dismissed click) every
  shown `wxPopupTransientWindow` that does not contain `target`; called from
  `wxApp::HandleMouseEvent` for every button press (target = window under the
  pointer) and from `wxWindowWasm::SetFocus()` when focus leaves a popup's
  subtree. `include/wx/popupwin.h`: the helper is a `friend` of
  `wxPopupTransientWindowBase` under `__WXWASM__` (`DismissAndNotify()` is
  protected; the generic handlers are friends the same way).
- `src/wasm/mouse.cpp`: the double-click synthesis also requires the two
  presses within `WASM_DCLICK_DISTANCE` (5 CSS px per axis) of each other.

No KiCad change.

## Tests

- `tests/e2e/combopopup.spec.ts` + `tests/apps/standalone/combopopup/`
  (`Makefile.wasm` target `combopopup`): the KiCad popup shape verbatim
  (wxComboCtrl + panel popup with filter + wxListBox, LEFT_DOWN → HitTest →
  Accept) plus a plain wxListBox. Asserts: LEFT_DOWN arrives with
  `hit=<row>`, `wxEVT_LISTBOX`, `wxEVT_LISTBOX_DCLICK`; a row click accepts
  and closes the combo popup; opening and picking within the double-click
  interval is two single clicks; an outside click dismisses without
  accepting. Pre-fix: RED (3/3 of the original tests). Post-fix: GREEN (with
  `e2e/popup.spec.ts` still 7/7).
- `tests/kicad/zone-net-selector.spec.ts`: pcbnew, File → Open pic_programmer,
  Draw Filled Zones, click the board, open the Net name dropdown, click `GND`
  → the combo must read `GND` and the popup must close. The board-load wait
  is the frame title mirrored into `document.title` plus a settled GL canvas
  (`waitForBoardLoaded` alone can return before the progress dialog paints).
  Pre-fix the spec is RED at the dialog step already (defect 3: the board
  click 400 ms after the toolbar click is a double-click the zone tool
  ignores); with a 700 ms dwell inserted it is RED at the pick step (defects
  1 and 2: `Expected "GND", Received "<no net>"`). Post-fix: GREEN without
  any dwell.

## Investigation notes

- The in-app symptom was first mis-attributed to a board-load race (a tool
  activated during `SetBoard`'s tool reset); the load actually completes
  within ~0.5 s of the File dialog closing. The trace timing (toolbar click →
  board press 400 ms) and the wx-level outside-click test (press 30 ms after
  the popup opened) pointed at the converter.
- Drag-and-drop of a `.kicad_pcb` onto the harness canvas does NOT open the
  board in this harness (the collab bundle imports the items into its model,
  the view stays empty) — use File → Open.

## Verification (2026-09-04, main clone, host wx build via build-wx-wasm.sh)

| Run | Build | Result |
|---|---|---|
| `e2e/combopopup.spec.ts` (3 original tests) | wx 13f9fdf0cc (pre-fix) | 3/3 RED: no LEFT_DOWN on either listbox, popup not dismissed by an outside click |
| `e2e/combopopup.spec.ts` (4 tests) + `e2e/popup.spec.ts` | fixed wx | 11/11 GREEN |
| full `wx-chromium` project (all standalone apps relinked) | fixed wx | 359 passed, 7 skipped, 0 failed |
| `kicad/zone-net-selector.spec.ts`, kicad-chromium | pre-fix kicad_editor (CDN-equivalent staging-d7656b7 build) | RED at the dialog step (defect 3); with a 700 ms dwell copy RED at the pick: `Expected "GND", Received "<no net>"` |
| `kicad/zone-net-selector.spec.ts`, kicad-chromium + kicad-firefox | kicad_editor rebuilt with the fixed wx (docker, findings-group-e cache volume) | kicad-chromium: GREEN (with grid-combo-editor-caret, grid-editors-typing, footprint-chooser-close/confirm, pcbnew-move, contextmenu-scrollbar-pcbnew, quasimodal-strand: 10/10); kicad-firefox: GREEN (with grid-combo-editor-caret, footprint-chooser-close: 3/3) |
