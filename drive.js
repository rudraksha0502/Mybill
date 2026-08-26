/* MYBILL — Google Drive Sync (optional)
 * -------------------------------------------------------------
 * This module is INACTIVE until you put your own OAuth Client ID
 * into js/config.js. Nothing here ever needs a client SECRET —
 * OAuth Client IDs for browser apps are public by design and safe
 * to commit. See ../SETUP.md for the exact Google Cloud steps.
 *
 * Scope requested: https://www.googleapis.com/auth/drive.file
 * -> this is the MINIMAL Drive scope: it only lets MYBILL see and
 * edit files IT created. It cannot browse or read the rest of the
 * user's Drive.
 *
 * Data flow:
 *   Local state (localStorage, source of truth for instant UI)
 *      <---sync--->  MYBILL/data/mybill_data.json  (Drive)
 *
 * Sync is queued + debounced so flaky hostel wifi never blocks
 * the UI, and a small status pill in the header reflects
 * online / offline / syncing / synced / sync failed.
 */

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const DRIVE_FOLDER_NAME = 'MYBILL';
const DRIVE_FILE_NAME = 'mybill_data.json';

const MyBillDrive = (() => {
  let tokenClient = null;
  let accessToken = null;
  let folderId = null;
  let fileId = null;
  let connected = false;
  let syncTimer = null;
  let statusListeners = [];

  function setStatus(status) {
    statusListeners.forEach(fn => fn(status));
  }
  function onStatus(fn) { statusListeners.push(fn); }

  function isConfigured() {
    return typeof window.MYBILL_CONFIG !== 'undefined' &&
      window.MYBILL_CONFIG.GOOGLE_CLIENT_ID &&
      !window.MYBILL_CONFIG.GOOGLE_CLIENT_ID.includes('YOUR_CLIENT_ID');
  }
  function isConnected() { return connected; }

  function loadGis() {
    return new Promise((resolve, reject) => {
      if (window.google && window.google.accounts) return resolve();
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  async function connect() {
    if (!isConfigured()) {
      throw new Error('Google Drive is not configured yet. Add your OAuth Client ID to js/config.js (see SETUP.md).');
    }
    await loadGis();
    return new Promise((resolve, reject) => {
      tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: window.MYBILL_CONFIG.GOOGLE_CLIENT_ID,
        scope: DRIVE_SCOPE,
        callback: async (resp) => {
          if (resp.error) return reject(resp);
          accessToken = resp.access_token;
          connected = true;
          setStatus('syncing');
          try {
            await ensureFolderAndFile();
            setStatus('synced');
            resolve();
          } catch (e) {
            setStatus('sync failed');
            reject(e);
          }
        }
      });
      tokenClient.requestAccessToken();
    });
  }

  function disconnect() {
    if (accessToken && window.google) {
      google.accounts.oauth2.revoke(accessToken, () => {});
    }
    accessToken = null; connected = false; folderId = null; fileId = null;
    setStatus('offline');
  }

  async function apiFetch(url, options = {}) {
    const res = await fetch(url, {
      ...options,
      headers: { ...(options.headers || {}), Authorization: `Bearer ${accessToken}` }
    });
    if (!res.ok) throw new Error(`Drive API error ${res.status}: ${await res.text()}`);
    return res;
  }

  async function ensureFolderAndFile() {
    // 1. find or create the MYBILL folder
    const q = encodeURIComponent(`name='${DRIVE_FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
    let res = await apiFetch(`https://www.googleapis.com/drive/v3/files?q=${q}&spaces=drive&fields=files(id,name)`);
    let data = await res.json();
    if (data.files && data.files.length) {
      folderId = data.files[0].id;
    } else {
      res = await apiFetch('https://www.googleapis.com/drive/v3/files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: DRIVE_FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' })
      });
      folderId = (await res.json()).id;
    }
    // 2. find or create the data file inside it
    const qf = encodeURIComponent(`name='${DRIVE_FILE_NAME}' and '${folderId}' in parents and trashed=false`);
    res = await apiFetch(`https://www.googleapis.com/drive/v3/files?q=${qf}&spaces=drive&fields=files(id,name)`);
    data = await res.json();
    if (data.files && data.files.length) {
      fileId = data.files[0].id;
    } else {
      fileId = await uploadNewFile(window.MyBillStore ? window.MyBillStore.exportJSON() : '{}');
    }
  }

  async function uploadNewFile(content) {
    const boundary = 'mybill_boundary';
    const metadata = { name: DRIVE_FILE_NAME, parents: [folderId], mimeType: 'application/json' };
    const body =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\nContent-Type: application/json\r\n\r\n${content}\r\n--${boundary}--`;
    const res = await apiFetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body
    });
    return (await res.json()).id;
  }

  async function pushToDrive(content) {
    if (!fileId) { fileId = await uploadNewFile(content); return; }
    await apiFetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: content
    });
  }

  async function pullFromDrive() {
    if (!fileId) return null;
    const res = await apiFetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`);
    return res.text();
  }

  // debounced queue so rapid edits (e.g. quick-add) don't fire a Drive call each keystroke
  function queueSync(state) {
    if (!connected) return;
    setStatus('syncing');
    clearTimeout(syncTimer);
    syncTimer = setTimeout(async () => {
      try {
        await pushToDrive(JSON.stringify(state));
        setStatus('synced');
      } catch (e) {
        console.warn('MYBILL Drive sync failed, will retry on next change.', e);
        setStatus('sync failed');
      }
    }, 2500);
  }

  async function restoreFromDrive() {
    const json = await pullFromDrive();
    if (json) window.MyBillStore.importJSON(json);
  }

  return { connect, disconnect, isConfigured, isConnected, queueSync, restoreFromDrive, onStatus };
})();

window.MyBillDrive = MyBillDrive;
