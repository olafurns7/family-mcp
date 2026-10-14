// Paste into the browser console on either landing-page locale.
// Exercises the real buttons without changing the system clipboard.
(async () => {
  const check = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const buttons = [...document.querySelectorAll('[data-copy]')];
  const start = document.querySelector('[data-copy="start-agent"]');
  const installs = buttons.filter((button) => !button.dataset.copy.endsWith('-agent'));
  const prompts = buttons.filter(
    (button) => button !== start && button.dataset.copy.endsWith('-agent'),
  );
  const disclosures = [...document.querySelectorAll('details.agent-setup')];
  const opened = disclosures.map((disclosure) => disclosure.open);
  const status = document.querySelector('.copy-status');
  const clipboard = navigator.clipboard;
  const original = Object.getOwnPropertyDescriptor(clipboard, 'writeText');
  const labels = buttons.map((button) => button.querySelector('span').textContent);
  const copied = [];
  check(buttons.length === 13 && status && start, 'Expected thirteen copy buttons and status');
  check(installs.length === 6 && prompts.length === 6, 'Expected six server button pairs');
  const startText = document.getElementById('start-agent-command').textContent;
  check(
    startText.includes('Only set up a scheduled task if my AI app can run it ON THIS COMPUTER') &&
      startText.includes('If its scheduler runs in the cloud or cannot use these MCP servers') &&
      startText.includes('A task that runs without me may use only the read tools it needs.'),
    'Scheduled routines need local MCP access, a cloud fallback and read-only permissions',
  );
  check(
    !startText
      .split('\n')
      .find((line) => line.startsWith('MORNING:'))
      .includes('shopping note'),
    'Morning routine must not offer the shopping note',
  );
  check(
    document.getElementById('start-agent-command').parentElement.getAttribute('aria-label') ===
      document.querySelector('.start-here .command-header > span').textContent,
    'Start prompt text needs its content label',
  );
  check(
    startText.endsWith(
      'Use your questions tool to ask me which of the MCP servers I want to install.',
    ),
    'Start prompt must end with the questions instruction',
  );
  for (const button of installs) {
    const command = document.getElementById(`${button.dataset.copy}-command`).textContent;
    const prompt = document.getElementById(`${button.dataset.copy}-agent-command`).textContent;
    const readme = prompt.match(/https:\/\/raw\.githubusercontent\.com\/[^\s]+\/README\.md/)?.[0];
    check(startText.includes(command), 'Start prompt is missing a server install command');
    check(readme && startText.includes(readme), 'Start prompt is missing a release README');
  }
  check(
    document.querySelector('.start-here').nextElementSibling.id === 'servers',
    'Start block must precede the server list',
  );
  check(
    disclosures.length === 7 && prompts.every((button) => button.closest('details.agent-setup')),
    'Each agent prompt belongs in its own disclosure',
  );
  check(
    new Set(buttons.map((button) => button.dataset.confirmation)).size === 2,
    'Install and agent-prompt buttons need different confirmations',
  );
  try {
    // A closed disclosure hides its prompt, so its text could not be selected.
    prompts.forEach((button) => (button.closest('details').open = true));
    document.querySelector('details.start-prompt').open = false;
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
    for (const button of [installs[0], prompts[0], start]) {
      if (button === start) document.querySelector('details.start-prompt').open = false;
      button.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      const command = document.getElementById(`${button.dataset.copy}-command`).textContent;
      check(window.getSelection()?.toString() === command, 'Fallback did not select the full text');
      check(status.textContent === button.dataset.error, 'Missing translated recovery message');
      if (button === start) {
        check(
          document.querySelector('details.start-prompt').open,
          'Fallback must reveal the prompt',
        );
      }
    }
    return 'PASS: six install, six server prompts and start prompt; content, reset and permission-denied fallback';
  } finally {
    disclosures.forEach((disclosure, index) => (disclosure.open = opened[index]));
    if (original) Object.defineProperty(clipboard, 'writeText', original);
    else delete clipboard.writeText;
    window.getSelection()?.removeAllRanges();
  }
})();
