/**
 * Thin Playwright page/locator mock (P2-1). Implements just enough of the
 * surface browser automation uses — page.locator(sel).first()/.all(),
 * .filter() chaining, isVisible(), getAttribute(), evaluate(), click(),
 * keyboard.press, waitForTimeout — with scripted elements, so selector
 * logic fails in `npm test` instead of only surfacing during a live run.
 * Not a DOM: each mock element is an explicit script, no parsing involved.
 */
export function mockButton({
  visible = true,
  text = '',
  pressed = null,
  evaluateResult = false,
  onClick = null,
} = {}) {
  return {
    isVisible: async () => visible,
    getAttribute: async (name) => (name === 'aria-pressed' ? pressed : null),
    evaluate: async () => evaluateResult,
    click: async () => { await onClick?.(); },
    textContent: async () => text,
  };
}

export function mockPage({ buttons = [], presses = null } = {}) {
  const seen = presses || [];
  const chain = {
    first: () => buttons[0] ?? mockButton({ visible: false }),
    all: async () => [...buttons],
    filter: () => chain,
  };
  return {
    presses: seen,
    locator: () => chain,
    keyboard: { press: async (key) => { seen.push(key); } },
    waitForTimeout: async () => {},
  };
}
