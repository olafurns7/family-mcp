// Paste into the browser console on either landing-page locale.
// Exercises the real buttons without changing the system clipboard.
(async () => {
  const check = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const buttons = [...document.querySelectorAll('[data-copy]')];
  const prompts = buttons.filter((button) => button.dataset.copy.endsWith('-agent'));
  const disclosures = [...document.querySelectorAll('details.agent-setup')];
  const opened = disclosures.map((disclosure) => disclosure.open);
  const status = document.querySelector('.copy-status');
  const clipboard = navigator.clipboard;
  const original = Object.getOwnPropertyDescriptor(clipboard, 'writeText');
  const labels = buttons.map((button) => button.querySelector('span').textContent);
  const copied = [];
  check(buttons.length === 10 && status, 'Expected ten copy buttons and status');
  check(prompts.length === 5, 'Expected five install and five agent-prompt buttons');
  check(
    disclosures.length === 5 && prompts.every((button) => button.closest('details.agent-setup')),
    'Each agent prompt belongs in its own disclosure',
  );
  check(
    new Set(buttons.map((button) => button.dataset.confirmation)).size === 2,
    'Install and agent-prompt buttons need different confirmations',
  );
  try {
    // A closed disclosure hides its prompt, so its text could not be selected.
    disclosures.forEach((disclosure) => (disclosure.open = true));
    Object.defineProperty(clipboard, 'writeText', {
      configurable: true,
      value: async (text) => copied.push(text),
    });
    for (const button of buttons) {
      button.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      const command = document.getElementById(`${button.dataset.copy}-command`).textContent;
      check(copied.at(-1) === command, 'Copied command differs from the displayed command');
      check(button.disabled && button.dataset.state === 'copied', 'Missing copied state');
      check(
        button.querySelector('span').textContent === button.dataset.copied,
        'Missing translated feedback',
      );
      check(
        status.textContent === `${button.dataset.confirmation} ${button.dataset.name}.`,
        'Missing accessible confirmation',
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 1900));
    buttons.forEach((button, index) => {
      check(!button.disabled && !button.dataset.state, 'Button did not reset');
      check(button.querySelector('span').textContent === labels[index], 'Label did not reset');
    });
    Object.defineProperty(clipboard, 'writeText', {
      configurable: true,
      value: async () => {
        throw new DOMException('Permission denied', 'NotAllowedError');
      },
    });
    for (const button of [buttons[0], prompts[0]]) {
      button.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      const command = document.getElementById(`${button.dataset.copy}-command`).textContent;
      check(window.getSelection()?.toString() === command, 'Fallback did not select the full text');
      check(status.textContent === button.dataset.error, 'Missing translated recovery message');
    }
    return 'PASS: five install and five agent-prompt copy buttons, reset, and permission-denied fallback';
  } finally {
    disclosures.forEach((disclosure, index) => (disclosure.open = opened[index]));
    if (original) Object.defineProperty(clipboard, 'writeText', original);
    else delete clipboard.writeText;
    window.getSelection()?.removeAllRanges();
  }
})();
