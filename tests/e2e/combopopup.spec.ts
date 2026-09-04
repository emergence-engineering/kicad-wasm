// wxComboCtrl custom popup + wxListBox mouse contract (DOM port).
//
// KiCad's FILTER_COMBOPOPUP (NET_SELECTOR in Copper Zone Properties, the
// footprint/symbol filter combos) accepts a row from the mouse through
// wxEVT_LEFT_DOWN on its wxListBox + wxListBox::HitTest — the only mouse path
// it has. The DOM port renders wxListBox as a <select multiple>; before the
// fix it never forwarded LEFT clicks on interactive DOM controls into the wx
// mouse pipeline and left HitTest at the wxListBoxBase default (wxNOT_FOUND),
// so the browser changed the <select>'s own selection and the popup never
// accepted anything (user report: "can't select from the dropdown").
//
// Two more port defects surfaced by the same flow and are covered here: a
// transient popup did not dismiss on an outside click when its content is a
// panel (the generic focus handler watched a window that never held focus),
// and the mouse converter turned ANY second press within 500 ms into a
// double-click, whatever the distance (desktop ports require ~5 px).
//
// The app (tests/apps/standalone/combopopup/combopopup_test.cpp) is the KiCad
// popup shape verbatim, plus a plain wxListBox for the bare widget contract.
// Companion in-app spec: tests/kicad/zone-net-selector.spec.ts.
// Write-up: docs/features/wx-parity-bugs/net-selector-listbox-click.md
import type { Page } from '@playwright/test';
import { test, expect, waitForWxApp } from './utils/fixtures';
import { findRenderedByType, stableShot } from './utils/element-tracker';

const APP = '/standalone/combopopup/combopopup_test.html';
const ITEMS = ['<no net>', '+5V', '/A0', '/D2', 'GND', 'Net-(R1-Pad1)', 'VCC'];

// Viewport centre of an <option> of a DOM listbox. `inPopup` picks the list
// living in a .popup window (the combo's) vs the frame's plain list; both
// hold the same items. Null while the wanted list is not visible.
function optionCenter(page: Page, text: string, inPopup: boolean) {
    return page.evaluate(([wanted, popup]) => {
        const selects = Array.from(document.querySelectorAll<HTMLSelectElement>('select[multiple].wx-dom-control'));
        for (const sel of selects) {
            if (!!sel.closest('.window.popup') !== popup) continue;
            const r = sel.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) continue;
            const opt = Array.from(sel.options).find((o) => o.text === wanted);
            if (!opt) continue;
            const or = opt.getBoundingClientRect();
            return { x: or.left + or.width / 2, y: or.top + or.height / 2 };
        }
        return null;
    }, [text, inPopup] as [string, boolean]);
}

async function comboLabel(page: Page): Promise<string | null> {
    const b = (await findRenderedByType(page, 'combobutton'))[0];
    return b ? b.label : null;
}

async function bootApp(page: Page) {
    await page.goto(APP);
    await waitForWxApp(page);
    await expect.poll(() => optionCenter(page, 'GND', false), {
        message: 'the plain listbox should render its rows',
    }).not.toBeNull();
}

test.describe('wxComboCtrl popup / wxListBox mouse contract', () => {

    test('plain wxListBox: a left click arrives as wxEVT_LEFT_DOWN with a working HitTest', async ({ page, testLogger }) => {
        await bootApp(page);

        const gnd = (await optionCenter(page, 'GND', false))!;
        await page.mouse.click(gnd.x, gnd.y);

        // LEFT_DOWN must reach the wx control and HitTest must resolve the row.
        await expect.poll(
            () => testLogger.consoleLogs.find((l) => l.includes('[COMBOPOPUP] plain LEFT_DOWN')) ?? null,
            { message: 'wxEVT_LEFT_DOWN on the listbox' },
        ).toMatch(/hit=4\b/);
        // ...and the native selection still happens (wxEVT_LISTBOX).
        await expect.poll(
            () => testLogger.consoleLogs.some((l) => l.includes('[COMBOPOPUP] plain LISTBOX sel=4')),
            { message: 'wxEVT_LISTBOX for the clicked row' },
        ).toBe(true);

        // Double-click → wxEVT_LISTBOX_DCLICK (GTK parity: Enter/dblclick activate).
        const a0 = (await optionCenter(page, '/A0', false))!;
        await page.mouse.dblclick(a0.x, a0.y);
        await expect.poll(
            () => testLogger.consoleLogs.some((l) => l.includes('[COMBOPOPUP] plain DCLICK sel=2')),
            { message: 'wxEVT_LISTBOX_DCLICK for the double-clicked row' },
        ).toBe(true);
    });

    test('combo popup: clicking a listbox row accepts it and closes the popup', async ({ page, testLogger }) => {
        await bootApp(page);
        expect(await comboLabel(page)).toBe(ITEMS[0]);

        // Open the popup from the combo's drop button.
        const button = (await findRenderedByType(page, 'combobutton'))[0];
        await page.mouse.click(button.centerX, button.centerY);
        await expect.poll(
            () => testLogger.consoleLogs.some((l) => l.includes('[COMBOPOPUP] popup shown')),
            { message: 'wxComboPopup::OnPopup' },
        ).toBe(true);
        await expect.poll(() => optionCenter(page, 'GND', true), {
            message: 'the popup listbox should render its rows',
        }).not.toBeNull();
        await stableShot(page, 'combopopup-01-open.png', { fullPage: true });

        // Click the row: LEFT_DOWN → HitTest → Accept (Dismiss + SetValue).
        const gnd = (await optionCenter(page, 'GND', true))!;
        await page.mouse.click(gnd.x, gnd.y);

        await expect.poll(
            () => testLogger.consoleLogs.find((l) => l.includes('[COMBOPOPUP] list LEFT_DOWN')) ?? null,
            { message: 'wxEVT_LEFT_DOWN on the popup listbox' },
        ).toMatch(/hit=4\b/);
        await expect.poll(
            () => testLogger.consoleLogs.some((l) => l.includes('[COMBOPOPUP] accepted GND')),
            { message: 'the popup must accept the clicked row' },
        ).toBe(true);
        await expect.poll(() => comboLabel(page), { message: 'combo value after the pick' }).toBe('GND');
        await expect.poll(() => optionCenter(page, 'GND', true), {
            message: 'the popup must be dismissed after the pick',
        }).toBeNull();
        await stableShot(page, 'combopopup-02-accepted.png', { fullPage: true });
    });

    // Two presses within the double-click interval but far apart are two
    // single clicks on every desktop port (GTK/MSW require the presses to
    // land within ~5 px of each other). The port's converter used to turn
    // ANY second press within the interval into wxEVT_LEFT_DCLICK, so a
    // user who opened the dropdown and picked a row right away — or clicked
    // a toolbar tool and then the canvas — had the second press ignored by
    // handlers bound to LEFT_DOWN / IsClick() only.
    test('combo popup: opening and picking within the double-click interval is two single clicks', async ({ page, testLogger }) => {
        await bootApp(page);

        const button = (await findRenderedByType(page, 'combobutton'))[0];
        await page.mouse.click(button.centerX, button.centerY);
        await expect.poll(() => optionCenter(page, 'GND', true), {
            message: 'popup open',
            intervals: [10],
        }).not.toBeNull();

        // Straight to the row (the row is ~150 px from the drop button).
        const gnd = (await optionCenter(page, 'GND', true))!;
        await page.mouse.click(gnd.x, gnd.y);

        await expect.poll(
            () => testLogger.consoleLogs.find((l) => l.includes('[COMBOPOPUP] list LEFT_DOWN')) ?? null,
            { message: 'the quick second press must arrive as LEFT_DOWN, not as a double-click' },
        ).toMatch(/hit=4\b/);
        await expect.poll(() => comboLabel(page), { message: 'combo value after the quick pick' }).toBe('GND');
    });

    test('combo popup: an outside click still dismisses it without accepting', async ({ page, testLogger }) => {
        await bootApp(page);

        const button = (await findRenderedByType(page, 'combobutton'))[0];
        await page.mouse.click(button.centerX, button.centerY);
        await expect.poll(() => optionCenter(page, 'GND', true), {
            message: 'popup open',
        }).not.toBeNull();
        // Empty frame area, right of the controls.
        await page.mouse.click(560, 40);
        await expect.poll(() => optionCenter(page, 'GND', true), {
            message: 'popup dismissed by the outside click',
        }).toBeNull();
        expect(testLogger.consoleLogs.some((l) => l.includes('[COMBOPOPUP] accepted'))).toBe(false);
        expect(await comboLabel(page)).toBe(ITEMS[0]);
    });
});
