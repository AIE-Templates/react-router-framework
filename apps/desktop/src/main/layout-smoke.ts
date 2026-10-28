import type { BrowserWindow } from "electron";

import { checkHeaderRegion, type HeaderRegionMeasurement, type TopBandGeometry } from "./layout-geometry.ts";

export interface LayoutSmokeResult {
  ok: boolean;
  cases: unknown[];
}

/** Real Chromium checks: container queries, actual overflow and width-preserved module state. */
export async function runLayoutSmoke(win: BrowserWindow): Promise<LayoutSmokeResult> {
  const original = win.getContentBounds();
  const backgroundThrottling = win.webContents.getBackgroundThrottling();
  // Keep frame-based checks running when another app covers the smoke window.
  win.webContents.setBackgroundThrottling(false);
  const cases: unknown[] = [];
  const evaluate = async (code: string): Promise<unknown> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        win.webContents.executeJavaScript(`(async () => { ${code} })()`),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("layout smoke timed out")), 8000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const settle = "await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));";
  let ok = true;
  try {
    for (const shell of ["basic", "navigation"]) {
      for (const header of ["fused", "standalone"]) {
        for (const direction of ["ltr", "rtl"]) {
          win.setContentSize(1320, 800);
          // Exercise the same React controls a person uses, including client route navigation.
          await evaluate(`
            for (const [index, value] of [[0, ${JSON.stringify(shell)}], [1, ${JSON.stringify(header)}]]) {
              const select = document.querySelectorAll('.layout-demo-controls select')[index];
              if (!select) throw new Error('layout demo select missing');
              select.value = value; select.dispatchEvent(new Event('change', { bubbles: true }));
              // Navigation can await a loader; two frames alone do not imply React committed it.
              const committed = () => index === 0
                ? document.querySelector('.app-shell')?.hasAttribute('data-navigation-shell') === (value === 'navigation')
                : document.querySelector('.app-shell')?.dataset.headerMode === value;
              while (!committed()) await new Promise((resolve) => setTimeout(resolve, 20));
              ${settle}
            }
            document.documentElement.dir = ${JSON.stringify(direction)};
            const input = document.querySelector('.layout-demo input');
            if (!input) throw new Error('module draft missing');
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Retained through all widths');
            input.dispatchEvent(new Event('input', { bubbles: true }));
            ${settle}
            for (const name of ['Sidebar', 'Auxiliary']) {
              const button = [...document.querySelectorAll('.module-workspace > .module-header button')].find((element) => element.textContent === name);
              if (!button) throw new Error('module toggle missing: ' + name);
              if (button.getAttribute('aria-expanded') !== 'true') button.click();
            }
            ${settle}
          `);
          for (const width of [1320, 900, 480]) {
            win.setContentSize(width, 800);
            const result = await evaluate(`
              ${settle}
              const shell = document.querySelector('.app-shell');
              const module = document.querySelector('.module-layout');
              const sidebar = document.querySelector('.module-sidebar');
              const auxiliary = document.querySelector('.module-auxiliary');
              const input = document.querySelector('.layout-demo input');
              const moduleWidth = module.getBoundingClientRect().width;
              const mode = moduleWidth <= 640 ? 'compact' : moduleWidth <= 960 ? 'medium' : 'expanded';
              const overflow = [document.documentElement, document.querySelector('.root-content'), ...document.querySelectorAll('.module-scroll')].filter((element) => element && element.getBoundingClientRect().width > 0).map((element) => ({ region: element.className || element.tagName, excess: element.scrollWidth - element.clientWidth })).filter((value) => value.excess > 1);
              const native = navigator.windowControlsOverlay;
              const safe = native?.getTitlebarAreaRect();
              const safeBottom = native?.visible ? safe.y + safe.height : 0;
              const separator = document.documentElement.dataset.platform === 'win32' && document.documentElement.dataset.chromeMode === 'native-overlay' ? 1 : 0;
              const expectedWindowHeight = Math.max(48, safeBottom) + separator;
              const overlaps = [...document.querySelectorAll('.module-header button,.shell-nav a,.shell-navigation-toggle')].filter((element) => {
                const rect = element.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0 && rect.top < safeBottom - 1 && !(safe && rect.left >= safe.x - 1 && rect.right <= safe.x + safe.width + 1 && rect.top >= safe.y - 1);
              }).length;
              const nav = document.querySelector('.shell-nav');
              const correctNav = ${JSON.stringify(shell)} === 'basic' ? !nav : !!nav;
              const band = document.querySelector('.shell-nav-chrome');
              const bandRect = band?.getBoundingClientRect();
              const moduleHeader = document.querySelector('.module-workspace > .module-header').getBoundingClientRect();
              const needsBand = !!nav && innerWidth > 768 && shell.dataset.headerMode === 'fused';
              const hit = needsBand && document.elementFromPoint(bandRect.left + bandRect.width / 2, bandRect.bottom - 2);
              const nativeDrag = !needsBand || (Math.abs(bandRect.height - expectedWindowHeight) <= 1 && Math.abs(bandRect.bottom - moduleHeader.bottom) <= 1 && getComputedStyle(hit).getPropertyValue('app-region') === 'drag' && !band.closest('[data-window-interactive]'));
              const navigationInteractive = !nav || getComputedStyle(nav.querySelector('.shell-nav-content')).getPropertyValue('app-region') === 'no-drag';
              const standaloneHeight = shell.dataset.headerMode !== 'standalone' || Math.abs(document.querySelector('.shell-titlebar').getBoundingClientRect().height - expectedWindowHeight) <= 1;

              const sidebarPosition = getComputedStyle(sidebar).position;
              const auxiliaryPosition = getComputedStyle(auxiliary).position;
              const headerRegions = [...document.querySelectorAll('.module-header')].map((element) => {
                const panel = element.parentElement;
                const expected = shell.dataset.headerMode === 'fused' && getComputedStyle(panel).position !== 'absolute' ? 'drag' : 'no-drag';
                // Alignment is judged in the main process (layout-geometry.ts) from these raw measurements.
                return { expected, actual: getComputedStyle(element).getPropertyValue('app-region'), height: element.getBoundingClientRect().height, border: parseFloat(getComputedStyle(element).borderBottomWidth) };
              });
              const standaloneTitlebarDrag = shell.dataset.headerMode !== 'standalone' || getComputedStyle(document.querySelector('.shell-titlebar-content')).getPropertyValue('app-region') === 'drag';
              const correctPanels = sidebarPosition === (mode === 'compact' ? 'absolute' : 'static') && auxiliaryPosition === (mode === 'expanded' ? 'static' : 'absolute');
              return { ok: standaloneTitlebarDrag && nativeDrag && navigationInteractive && standaloneHeight && correctNav && correctPanels && overflow.length === 0 && overlaps === 0 && input.value === 'Retained through all widths' && shell.dataset.headerMode === ${JSON.stringify(header)} && document.documentElement.dataset.shell === 'desktop', shell: ${JSON.stringify(shell)}, header: ${JSON.stringify(header)}, direction: ${JSON.stringify(direction)}, width: innerWidth, moduleWidth, mode, sidebarPosition, auxiliaryPosition, correctNav, expectedWindowHeight, separator, safeBottom, devicePixelRatio, headerRegions, standaloneTitlebarDrag, nativeDrag, navigationInteractive, standaloneHeight, overflow, overlaps, draft: input.value, fallbackHeight: document.querySelector('.root-chrome-fallback').getBoundingClientRect().height };
            `);
            const judged = judgeHeaderRegions(result);
            cases.push(judged);
            if (!isSuccess(judged)) ok = false;
          }
          const toggles = await evaluate(`
            ${settle}
            const sidebarToggle = [...document.querySelectorAll('.module-workspace > .module-header button')].find((element) => element.textContent === 'Sidebar');
            const navToggle = document.querySelector('.shell-navigation-trigger');
            let independentNavigation = true;
            if (navToggle) {
              const before = sidebarToggle.getAttribute('aria-expanded');
              navToggle.click(); ${settle}
              independentNavigation = getComputedStyle(document.querySelector('.shell-nav')).display !== 'none' && sidebarToggle.getAttribute('aria-expanded') === before;
              document.querySelector('.shell-nav button').click(); ${settle}
              independentNavigation = independentNavigation && document.activeElement === navToggle;
            }
            document.querySelector('[aria-label="Close sidebar"]').click();
            ${settle}
            const restored = document.activeElement === sidebarToggle;
            document.querySelector('[aria-label="Close auxiliary workspace"]').click();
            ${settle}
            return { ok: restored && independentNavigation && document.querySelector('.module-sidebar').hidden && document.querySelector('.module-auxiliary').hidden, shell: ${JSON.stringify(shell)}, header: ${JSON.stringify(header)}, direction: ${JSON.stringify(direction)}, panelCloseRestoresFocus: restored, independentNavigation };
          `);
          const hiddenSafety = await evaluate(`
            const fallback = document.querySelector('.root-chrome-fallback');
            const content = document.querySelector('.root-content');
            const overlay = navigator.windowControlsOverlay;
            const rect = overlay?.getTitlebarAreaRect();
            const safeTop = overlay?.visible ? rect.y + rect.height : 0;
            const selectors = ${JSON.stringify(header)} === 'standalone'
              ? ['.shell-titlebar', '.shell-titlebar-content', '.app-shell']
              : ['.module-workspace > .module-header', '.module-columns', '.module-layout', '.shell-body', '.app-shell'];
            const samples = selectors.map((selector) => {
              const element = document.querySelector(selector);
              const hidden = element.hidden;
              try {
                element.hidden = true;
                return { selector, height: fallback.getBoundingClientRect().height, top: content.getBoundingClientRect().top, display: getComputedStyle(fallback).display };
              } finally { element.hidden = hidden; }
            });
            return { ok: samples.every((sample) => sample.display !== 'none' && Math.abs(sample.height - safeTop) <= 1 && sample.top >= safeTop - 1) && getComputedStyle(fallback).display === 'none', shell: ${JSON.stringify(shell)}, header: ${JSON.stringify(header)}, direction: ${JSON.stringify(direction)}, safeTop, hiddenSafety: samples };
          `);
          cases.push(hiddenSafety);
          if (!isSuccess(hiddenSafety)) ok = false;
          cases.push(toggles);
          if (!isSuccess(toggles)) ok = false;
        }
      }
    }
  } catch (error) {
    ok = false;
    cases.push({ ok: false, error: error instanceof Error ? error.message : String(error) });
  } finally {
    if (!win.isDestroyed()) {
      try {
        win.setContentSize(original.width, original.height);
        await evaluate(`document.documentElement.dir = 'ltr'; ${settle}`);
      } finally {
        if (!win.webContents.isDestroyed()) win.webContents.setBackgroundThrottling(backgroundThrottling);
      }
    }
  }
  return { ok, cases };
}

interface MeasuredCase extends TopBandGeometry {
  ok: boolean;
  headerRegions: (HeaderRegionMeasurement & { actual: string })[];
}

/** Adds each header's expected height and alignment; the case fails if any header is misplaced. */
function judgeHeaderRegions(value: unknown): unknown {
  if (!isMeasuredCase(value)) return { ok: false, malformed: value };
  const headerRegions = value.headerRegions.map((region) => ({ ...region, ...checkHeaderRegion(region, value) }));
  const correctHeaderRegions = headerRegions.every(({ expected, actual, aligned }) => actual === expected && aligned);
  return { ...value, ok: value.ok && correctHeaderRegions, correctHeaderRegions, headerRegions };
}

function isMeasuredCase(value: unknown): value is MeasuredCase {
  return (
    typeof value === "object" &&
    value !== null &&
    "ok" in value &&
    typeof value.ok === "boolean" &&
    "expectedWindowHeight" in value &&
    typeof value.expectedWindowHeight === "number" &&
    "separator" in value &&
    typeof value.separator === "number" &&
    "safeBottom" in value &&
    typeof value.safeBottom === "number" &&
    "devicePixelRatio" in value &&
    typeof value.devicePixelRatio === "number" &&
    "headerRegions" in value &&
    Array.isArray(value.headerRegions)
  );
}

function isSuccess(value: unknown): boolean {
  return typeof value === "object" && value !== null && "ok" in value && value.ok === true;
}
