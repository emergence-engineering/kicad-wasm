/**
 * Copper Zone Properties → "Net name": the NET_SELECTOR dropdown must let the
 * user pick a net with the mouse.
 *
 * User report (2026-09-04, staging blinky-328): Draw Filled Zones → click on
 * the board → Copper Zone Properties opens → the Net name dropdown opens and
 * lists the nets, but clicking a net does nothing: the popup stays open and
 * the combo keeps "<no net>".
 *
 * KiCad's NET_SELECTOR is a FILTER_COMBOBOX (wxComboCtrl) whose popup
 * (FILTER_COMBOPOPUP, common/widgets/filter_combobox.cpp) is a wxPanel with a
 * filter wxTextCtrl and a wxListBox. It accepts a row from the mouse in exactly
 * one way: wxEVT_LEFT_DOWN on the listbox → `m_listBox->SetSelection(
 * m_listBox->HitTest(pos))` → Accept() (Dismiss + combo SetValue +
 * FILTERED_ITEM_SELECTED). wxGTK/wxMSW/wxOSX deliver that LEFT_DOWN for their
 * native list widgets and implement HitTest.
 *
 * The wasm port renders wxListBox as a real DOM <select multiple> and
 * (a) never forwards LEFT clicks on interactive DOM controls into the wx mouse
 * pipeline (wx-dom.js "Input forwarding" — only passive controls), and
 * (b) leaves wxListBox::HitTest at the wxListBoxBase default (wxNOT_FOUND).
 * The browser changes the <select>'s own selection (→ wxEVT_LISTBOX, which the
 * popup does not listen to) and nothing else happens.
 *
 * Expected (parity): clicking a row accepts it — the popup closes and the combo
 * shows the clicked net. wx-level contract test: e2e/combopopup.spec.ts.
 * Write-up: docs/features/wx-parity-bugs/net-selector-listbox-click.md
 */

import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { clickByTooltip, findByTooltip, findRenderedByType, stableShot, waitForCanvasStable, waitUntil } from '../e2e/utils/element-tracker';
import { waitForPcbnew } from './utils/pcbnew-ready';
import { loadBoard } from './utils/threed-viewer';
import { clickWxButton } from './utils/wx-dialogs';

const NET = 'GND'; // present in every KiCad demo board (pic_programmer here)

async function visibleGlCanvasBox(page: Page) {
    const glCanvasId = await page.evaluate(() => {
        const glCanvas = Array.from(document.querySelectorAll('[id^="glcanvas-"]'))
            .map((c) => c as HTMLCanvasElement)
            .find((c) => {
                const rect = c.getBoundingClientRect();
                return window.getComputedStyle(c).display !== 'none' && rect.width > 0 && rect.height > 0;
            });
        return glCanvas?.id ?? null;
    });
    expect(glCanvasId, 'visible GL canvas').not.toBeNull();
    const box = await page.locator(`#${glCanvasId}`).boundingBox();
    expect(box, 'GL canvas bounding box').not.toBeNull();
    return { id: glCanvasId!, ...box! };
}

// The net-list <select> of the OPEN NET_SELECTOR popup: a visible DOM listbox
// (select[multiple].wx-dom-control) that carries the wanted net as an option.
// Returns the viewport rect of that option, or null while the popup is closed.
function netOptionRect(page: Page, net: string) {
    return page.evaluate((wanted) => {
        const selects = Array.from(document.querySelectorAll<HTMLSelectElement>('select[multiple].wx-dom-control'));
        for (const sel of selects) {
            const r = sel.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) continue;
            const opt = Array.from(sel.options).find((o) => o.text === wanted);
            if (!opt) continue;
            const or = opt.getBoundingClientRect();
            return { x: or.left + or.width / 2, y: or.top + or.height / 2, listVisible: true };
        }
        return null;
    }, net);
}

// The NET_SELECTOR's drop button, keyed by the wxComboCtrl it belongs to
// (the main frame's layer selector is a wxComboCtrl too). Rendered elements
// carry their owner window's registry id as parentId.
async function netCombo(page: Page, parentId?: string) {
    const buttons = await findRenderedByType(page, 'combobutton');
    return buttons.find((b) => (parentId ? b.parentId === parentId : b.label === '<no net>')) ?? null;
}

test.describe('Copper Zone Properties: net selector dropdown', () => {
    test.setTimeout(240000);

    test('clicking a net in the dropdown selects it', async ({ page, testLogger }) => {
        await page.goto('/kicad/pcbnew.html');
        await waitForPcbnew(page);
        await loadBoard(page, testLogger);
        // waitForBoardLoaded can return before the load has even started (the
        // progress dialog may not have painted yet). The frame title
        // (mirrored into document.title by the harness) is set at the end of
        // OpenProjectFiles; the settled canvas is the end of the first render.
        await expect.poll(() => page.title(), { message: 'board loaded (frame title)', timeout: 60000 })
            .toContain('pic_programmer');
        const glBox = await visibleGlCanvasBox(page);
        await waitForCanvasStable(page, `#${glBox.id}`, { stableFrames: 5, timeout: 60000 });

        // Draw Filled Zones tool, then the first click on the board opens the
        // Copper Zone Properties dialog (ZONE_CREATE_HELPER::OnFirstPoint).
        // NOTE: this press follows the toolbar click by well under 500 ms; the
        // port's converter used to report it as a double-click (no distance
        // test), which the zone tool ignores — defect 3 in the write-up and
        // why the dialog never opened on the pre-fix build.
        await waitUntil(page, () => {
            const r = window.wxElementRegistry;
            return !!r?.findAllRendered
                && r.findAllRendered({ elementType: 'tool' }).some((t) => t.tooltip?.includes('Draw Filled Zones'));
        }, 'Draw Filled Zones tool rendered');
        expect(await clickByTooltip(page, 'Draw Filled Zones', { elementType: 'tool' })).toBe(true);
        await expect.poll(async () =>
            ((await findByTooltip(page, 'Draw Filled Zones', { elementType: 'tool' }))?.label ?? '').includes('[checked]'),
            { message: 'Draw Filled Zones tool should be selected', timeout: 5000 }).toBe(true);

        const pt = { x: Math.round(glBox.x + glBox.width * 0.4), y: Math.round(glBox.y + glBox.height * 0.5) };
        await page.mouse.move(pt.x, pt.y);
        await page.waitForTimeout(350); // eslint-disable-line -- documented interaction dwell: asyncified pointer-move needs wall-clock time before press
        await page.mouse.down();
        await page.mouse.up();

        // The dialog is up once its NET_SELECTOR combo is rendered with the
        // default "<no net>".
        await expect.poll(async () => (await netCombo(page))?.label ?? null, {
            message: 'Copper Zone Properties should open with the net selector at <no net>',
            timeout: 30000,
        }).toBe('<no net>');
        const button = (await netCombo(page))!;
        const comboId = button.parentId;

        // Open the dropdown.
        await page.mouse.click(button.centerX, button.centerY);
        await expect.poll(() => netOptionRect(page, NET), {
            message: `net selector popup should list ${NET}`,
            timeout: 15000,
        }).not.toBeNull();

        await stableShot(page, 'zone-net-selector-01-dropdown-open.png', { fullPage: true });

        // Click the net row — the popup's LEFT_DOWN handler must accept it.
        const opt = (await netOptionRect(page, NET))!;
        await page.mouse.click(opt.x, opt.y);

        await expect.poll(async () => (await netCombo(page, comboId))?.label ?? null, {
            message: `clicking ${NET} in the dropdown must select it in the combo`,
            timeout: 10000,
        }).toBe(NET);
        await expect.poll(() => netOptionRect(page, NET), {
            message: 'the dropdown must close after the pick',
            timeout: 10000,
        }).toBeNull();
        await stableShot(page, 'zone-net-selector-02-net-picked.png', { fullPage: true });

        // Leave the board untouched.
        expect(await clickWxButton(page, 'Cancel'), 'Cancel button').toBe(true);
        await page.keyboard.press('Escape');
    });
});
