/** Durable binary storage for demo assets that are too large for localStorage. */

const DB_NAME = 'sigils-demo';
const DB_VERSION = 1;
const ASSET_STORE = 'assets';

let databasePromise = null;

function openDatabase() {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) {
      reject(new Error('IndexedDB is unavailable.'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.addEventListener('upgradeneeded', () => {
      if (!request.result.objectStoreNames.contains(ASSET_STORE)) {
        request.result.createObjectStore(ASSET_STORE);
      }
    });
    request.addEventListener('success', () => resolve(request.result));
    request.addEventListener('error', () => reject(request.error ?? new Error('Could not open demo storage.')));
    request.addEventListener('blocked', () => reject(new Error('Demo storage upgrade was blocked.')));
  });
  return databasePromise;
}

export async function saveDemoAsset(key, value) {
  const database = await openDatabase();
  await new Promise((resolve, reject) => {
    const transaction = database.transaction(ASSET_STORE, 'readwrite');
    transaction.objectStore(ASSET_STORE).put(value, key);
    transaction.addEventListener('complete', resolve);
    transaction.addEventListener('abort', () => reject(transaction.error ?? new Error('Asset save was aborted.')));
    transaction.addEventListener('error', () => reject(transaction.error ?? new Error('Could not save demo asset.')));
  });
}

export async function loadDemoAsset(key) {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(ASSET_STORE, 'readonly');
    const request = transaction.objectStore(ASSET_STORE).get(key);
    request.addEventListener('success', () => resolve(request.result ?? null));
    request.addEventListener('error', () => reject(request.error ?? new Error('Could not load demo asset.')));
  });
}
