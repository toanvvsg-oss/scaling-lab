export async function getJSON(url) {
  const r = await fetch(url);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `request failed ${r.status}`);
  return body;
}

export async function postJSON(url, payload) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload || {}),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `request failed ${r.status}`);
  return body;
}

export async function delJSON(url) {
  const r = await fetch(url, { method: 'DELETE' });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `request failed ${r.status}`);
  return body;
}

export function downloadBlob(name, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
