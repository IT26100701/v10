/* A browser-local GIF override. The shared trava-bg.gif remains the site default. */
(() => {
  'use strict';

  const DATABASE = 'trava-appearance';
  const STORE = 'assets';
  const KEY = 'background-gif';
  let activeUrl = null;

  function openDatabase() {
    return new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) {
        reject(new Error('Browser storage is unavailable.'));
        return;
      }
      const request = indexedDB.open(DATABASE, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE)) {
          request.result.createObjectStore(STORE);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Could not open browser storage.'));
    });
  }

  async function transact(mode, operation) {
    const database = await openDatabase();
    try {
      return await new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE, mode);
        const request = operation(transaction.objectStore(STORE));
        let result;
        request.onsuccess = () => { result = request.result; };
        request.onerror = () => reject(request.error || new Error('Could not save the GIF.'));
        transaction.onerror = () => reject(transaction.error || new Error('Could not save the GIF.'));
        transaction.oncomplete = () => resolve(result);
      });
    } finally {
      database.close();
    }
  }

  function display(blob) {
    const nextUrl = URL.createObjectURL(blob);
    document.documentElement.style.setProperty('--trava-background-image', `url("${nextUrl}")`);
    if (activeUrl) URL.revokeObjectURL(activeUrl);
    activeUrl = nextUrl;
  }

  function restoreDefault() {
    document.documentElement.style.removeProperty('--trava-background-image');
    if (activeUrl) URL.revokeObjectURL(activeUrl);
    activeUrl = null;
  }

  const ready = transact('readonly', store => store.get(KEY))
    .then(blob => {
      if (blob instanceof Blob && blob.type === 'image/gif') {
        display(blob);
        return true;
      }
      return false;
    })
    .catch(() => false);

  window.TravaBackground = {
    ready,
    async save(blob) {
      await ready;
      if (!(blob instanceof Blob) || blob.type !== 'image/gif') {
        throw new TypeError('Choose a GIF file.');
      }
      if (blob.size > 15 * 1024 * 1024) {
        throw new RangeError('Choose a GIF smaller than 15 MB.');
      }
      await transact('readwrite', store => store.put(blob, KEY));
      display(blob);
    },
    async reset() {
      await ready;
      await transact('readwrite', store => store.delete(KEY));
      restoreDefault();
    }
  };
})();
