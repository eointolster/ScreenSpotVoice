export {};

const status = document.getElementById('status')!;
const allow = document.getElementById('allow') as HTMLButtonElement;
const back = document.getElementById('back') as HTMLButtonElement;

async function refresh() {
  try {
    const permission = await navigator.permissions.query({ name: 'microphone' as PermissionName });
    if (permission.state === 'granted') {
      status.textContent = 'Microphone permission is allowed. Return to the webpage and click Start Session.';
      allow.disabled = true;
    } else if (permission.state === 'denied') {
      status.textContent = 'Microphone permission is blocked. Use the Site settings path below to allow it, then retry.';
    } else {
      status.textContent = 'Click Allow microphone, then accept Chrome’s permission prompt.';
    }
  } catch {
    status.textContent = 'Click Allow microphone, then accept Chrome’s permission prompt.';
  }
}

allow.addEventListener('click', async () => {
  allow.disabled = true;
  status.textContent = 'Waiting for Chrome’s microphone prompt…';
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    stream.getTracks().forEach(track => track.stop());
    status.textContent = 'Microphone allowed. Return to the webpage and click Start Session.';
  } catch (error) {
    const failure = error as DOMException;
    status.textContent = `Microphone permission was not granted (${failure.name || 'unknown error'}). Check Chrome’s prompt and Site settings below, then retry.`;
  } finally {
    allow.disabled = false;
    const permission = await navigator.permissions.query({ name: 'microphone' as PermissionName }).catch(() => null);
    if (permission?.state === 'granted') allow.disabled = true;
  }
});

back.addEventListener('click', async () => {
  const tabId = Number(new URLSearchParams(location.search).get('returnTab'));
  if (Number.isSafeInteger(tabId) && tabId > 0) {
    await chrome.tabs.update(tabId, { active: true }).catch(() => {});
  }
  const current = await chrome.tabs.getCurrent();
  if (current?.id) await chrome.tabs.remove(current.id);
});

void refresh();
