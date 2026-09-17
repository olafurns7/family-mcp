// Paste into the browser console on either landing-page locale.
// Exercises the real buttons without changing the system clipboard.
(async () => {
  const check = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const buttons = [...document.querySelectorAll('[data-copy]')];
  const status = document.querySelector('.copy-status');
  const clipboard = navigator.clipboard;
  const original = Object.getOwnPropertyDescriptor(clipboard, 'writeText');
  const labels = buttons.map((button) => button.querySelector('span').textContent);
  const copied = [];
  check(buttons.length === 4 && status, 'Expected four install buttons and status');
  try {
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
      check(status.textContent.includes(button.dataset.name), 'Missing accessible confirmation');
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
    buttons[0].click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const command = document.getElementById(`${buttons[0].dataset.copy}-command`).textContent;
    check(
      window.getSelection()?.toString() === command,
      'Fallback did not select the full command',
    );
    check(status.textContent === buttons[0].dataset.error, 'Missing translated recovery message');
    return 'PASS: all four copy buttons, reset, and permission-denied fallback';
  } finally {
    if (original) Object.defineProperty(clipboard, 'writeText', original);
    else delete clipboard.writeText;
    window.getSelection()?.removeAllRanges();
  }
})();
