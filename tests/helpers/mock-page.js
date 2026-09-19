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
    last: () => buttons[buttons.length - 1] ?? mockButton({ visible: false }),
    all: async () => [...buttons],
    filter: () => chain,
    count: async () => {
      let n = 0;
      for (const b of buttons) {
        if (await b.isVisible().catch(() => false)) n += 1;
      }
      return n;
    },
  };
  return {
    presses: seen,
    locator: () => chain,
    keyboard: {
      press: async (key) => { seen.push(key); },
      type: async (key) => { seen.push(`type:${key}`); },
    },
    waitForTimeout: async () => {},
  };
}

/**
 * Selector-aware variant: visibility/text/behavior scripted per selector
 * (first match wins). Supports the shallow page.locator(sel).first() /
 * .last() / .count() shapes plus page.url/title/evaluate/keyboard for
 * context readers. Multi-element enumeration still needs mockPage above.
 */
export function mockPageRoutes(routes = [], opts = {}) {
  const presses = [];
  const find = (sel) => routes.find((r) =>
    typeof r.match === 'string' ? String(sel).includes(r.match) : r.match.test(String(sel)));
  const elFor = (sel) => {
    const r = find(sel);
    if (!r) return mockButton({ visible: false });
    if (r.element) return r.element;
    return mockButton({
      visible: r.visible ?? true,
      text: r.text ?? '',
      pressed: r.pressed ?? null,
      evaluateResult: r.evaluateResult ?? false,
      onClick: r.onClick,
    });
  };
  const chainFor = (sel) => {
    const el = elFor(sel);
    const chain = {
      ...el,
      first: () => chain,
      last: () => chain,
      all: async () => [],
      filter: () => chainFor(sel),
      count: async () => ((await el.isVisible().catch(() => false)) ? 1 : 0),
    };
    return chain;
  };
  return {
    presses,
    locator: (sel) => chainFor(sel),
    keyboard: {
      press: async (key) => { presses.push(key); },
      type: async (key) => { presses.push(`type:${key}`); },
    },
    waitForTimeout: async () => {},
    url: () => opts.url ?? 'https://flow.google.com/',
    title: async () => opts.title ?? '',
    evaluate: async (...a) => {
      if (opts.evaluateImpl) return opts.evaluateImpl(...a);
      return opts.evaluateResult ?? null;
    },
  };
}
