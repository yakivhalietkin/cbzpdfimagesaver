importScripts('libs/jszip.min.js', 'libs/jspdf.umd.min.js');

const { jsPDF } = jspdf;
const tabImages = new Map();
const tabStates = new Map();
let lastActiveTabId = null;

async function persistTabData(tabId) {
  if (tabId == null) return;
  const images = tabImages.get(tabId) || [];
  const state = tabStates.get(tabId) || {};
  try {
    const stored = await chrome.storage.session.get(['tabImages', 'tabStates']);
    await chrome.storage.session.set({
      tabImages: { ...(stored.tabImages || {}), [tabId]: images },
      tabStates: { ...(stored.tabStates || {}), [tabId]: state }
    });
  } catch (_) {
    // Fall back to in-memory state if session storage is unavailable.
  }
}

async function hydrateTabData(tabId) {
  if (tabId == null) return;
  if (!tabImages.has(tabId) || !tabStates.has(tabId)) {
    try {
      const stored = await chrome.storage.session.get(['tabImages', 'tabStates']);
      if (!tabImages.has(tabId) && stored.tabImages?.[tabId]) tabImages.set(tabId, stored.tabImages[tabId]);
      if (!tabStates.has(tabId) && stored.tabStates?.[tabId]) tabStates.set(tabId, stored.tabStates[tabId]);
    } catch (_) {}
  }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const senderTabId = sender.tab?.id;

  switch (request.action) {
    case 'content-script-ready': {
      if (senderTabId != null) tabStates.set(senderTabId, { ...(tabStates.get(senderTabId) || {}), ready: true });
      break;
    }

    case 'update-images':
    case 'update-images-from-popup': {
      if (senderTabId != null) {
        tabImages.set(senderTabId, Array.isArray(request.images) ? request.images : []);
        lastActiveTabId = senderTabId;
        persistTabData(senderTabId);
      } else {
        const tabId = request.tabId ?? lastActiveTabId;
        if (tabId != null) {
          tabImages.set(tabId, Array.isArray(request.images) ? request.images : []);
          persistTabData(tabId);
        } else {
          chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            const currentTabId = tabs[0]?.id;
            if (currentTabId != null) {
              tabImages.set(currentTabId, Array.isArray(request.images) ? request.images : []);
              lastActiveTabId = currentTabId;
              persistTabData(currentTabId);
            }
          });
        }
      }
      break;
    }

    case 'selection-mode-state': {
      if (senderTabId != null) {
        tabStates.set(senderTabId, { ...(tabStates.get(senderTabId) || {}), selectMode: Boolean(request.enabled) });
        persistTabData(senderTabId);
      }
      break;
    }

    case 'get-selected-images': {
      chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
        const activeTabId = tabs[0]?.id;
        lastActiveTabId = activeTabId ?? lastActiveTabId;
        await hydrateTabData(activeTabId);
        sendResponse({
          tabId: activeTabId ?? null,
          images: activeTabId != null ? (tabImages.get(activeTabId) || []) : [],
          selectMode: activeTabId != null ? Boolean(tabStates.get(activeTabId)?.selectMode) : false
        });
      });
      return true;
    }

    case 'toggle-select-mode': {
      chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
        const tabId = tabs[0]?.id;
        if (tabId == null) return;
        const enabled = Boolean(request.selectMode);
        tabStates.set(tabId, { ...(tabStates.get(tabId) || {}), selectMode: enabled });
        lastActiveTabId = tabId;
        persistTabData(tabId);
        try {
          await chrome.scripting.insertCSS({ target: { tabId }, files: ['content.css'] });
        } catch (_) {
          // CSS may already be injected. Continue to script injection.
        }
        try {
          await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
          await chrome.tabs.sendMessage(tabId, { action: 'set-select-mode', enabled });
        } catch (error) {
          console.error('Unable to toggle selection mode:', error);
        }
      });
      break;
    }

    case 'clear-selection': {
      chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
        const tabId = tabs[0]?.id;
        if (tabId == null) return;
        tabImages.set(tabId, []);
        persistTabData(tabId);
        try {
          await chrome.tabs.sendMessage(tabId, { action: 'clear-selection' });
        } catch (_) {}
      });
      break;
    }

    case 'open-in-new-window': {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tabId = tabs[0]?.id;
        if (tabId != null) lastActiveTabId = tabId;
        chrome.windows.create({
          url: `${chrome.runtime.getURL('popup.html')}?tabId=${tabId ?? ''}`,
        type: 'popup',
        width: 420,
          height: 700
        });
      });
      break;
    }

    case 'download-images': {
      handleDownload(request.images || [], request.settings || {})
        .then(() => sendResponse({ ok: true }))
        .catch((error) => {
          console.error('Download failed:', error);
          sendResponse({ ok: false, error: error?.message || String(error) });
        });
      return true;
    }
  }

  return false;
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  tabImages.delete(tabId);
  tabStates.delete(tabId);
  try {
    const stored = await chrome.storage.session.get(['tabImages', 'tabStates']);
    delete stored.tabImages?.[tabId];
    delete stored.tabStates?.[tabId];
    await chrome.storage.session.set({ tabImages: stored.tabImages || {}, tabStates: stored.tabStates || {} });
  } catch (_) {}
});

function sanitizeFilename(name) {
  return String(name || 'images')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'images';
}

function pageBaseName() {
  return 'selected-images';
}

function getExtensionFromType(type) {
  const subtype = String(type || '').split('/')[1]?.toLowerCase();
  const aliases = { jpeg: 'jpg', svg: 'svg', webp: 'webp', png: 'png', gif: 'gif', avif: 'avif', bmp: 'bmp' };
  return aliases[subtype] || 'img';
}

function getFilenameFromUrl(url) {
  try {
    const pathname = new URL(url).pathname;
    const filename = decodeURIComponent(pathname.substring(pathname.lastIndexOf('/') + 1));
    const withoutQuery = filename.split('?')[0].split('#')[0];
    return sanitizeFilename(withoutQuery || 'image').replace(/\.[^.]+$/, '') || 'image';
  } catch (_) {
    return 'image';
  }
}

async function fetchImage(entry) {
  const url = typeof entry === 'string' ? entry : entry.url;
  if (!url) throw new Error('Missing image URL');
  const response = await fetch(url, { credentials: 'include', cache: 'force-cache' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const blob = await response.blob();
  if (!blob.size) throw new Error('Empty image response');
  return { blob, arrayBuffer: await blob.arrayBuffer(), url };
}

function getImageMetadata(entry, index, blob) {
  const explicitName = typeof entry === 'object' ? entry.name : '';
  return {
    baseName: sanitizeFilename(explicitName ? explicitName.replace(/\.[^.]+$/, '') : getFilenameFromUrl(entry.url || entry)),
    index: index + 1,
    type: blob.type || 'image/jpeg',
    extension: getExtensionFromType(blob.type) || 'img'
  };
}

async function buildPdf(images, settings) {
  let doc = null;
  let added = 0;
  const compression = Number(settings.compression) >= 90 ? 'SLOW' : Number(settings.compression) >= 70 ? 'MEDIUM' : Number(settings.compression) >= 50 ? 'FAST' : 'NONE';

  for (let i = 0; i < images.length; i++) {
    const { blob } = await fetchImage(images[i]);
    let imageBlob = blob;
    let width;
    let height;

    // Normalize browser-supported image formats to PNG so jsPDF does not
    // depend on the source site's particular format (WebP/AVIF/etc.).
    try {
      const bitmap = await createImageBitmap(blob);
      width = bitmap.width;
      height = bitmap.height;
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext('2d', { alpha: false });
      ctx.drawImage(bitmap, 0, 0);
      imageBlob = await canvas.convertToBlob({ type: 'image/png' });
      bitmap.close();
    } catch (error) {
      const buffer = await blob.arrayBuffer();
      const props = jsPDF.getImageProperties(new Uint8Array(buffer));
      width = props.width;
      height = props.height;
    }

    const buffer = await imageBlob.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    const orientation = width > height ? 'l' : 'p';

    if (!doc) {
      doc = new jsPDF({ orientation, unit: 'pt', format: [width, height], compress: true });
    } else {
      doc.addPage([width, height], orientation);
    }

    doc.addImage(bytes, 'PNG', 0, 0, width, height, undefined, compression);
    added++;
  }

  if (!doc || added === 0) throw new Error('No images could be downloaded.');
  return doc.output('blob');
}

async function buildCbz(images) {
  const zip = new JSZip();
  let added = 0;
  for (let i = 0; i < images.length; i++) {
    const fetched = await fetchImage(images[i]);
    const meta = getImageMetadata(images[i], i, fetched.blob);
    const prefix = String(meta.index).padStart(4, '0');
    zip.file(`${prefix}.${meta.baseName || 'image'}.${meta.extension}`, fetched.arrayBuffer);
    added++;
  }
  if (!added) throw new Error('No images could be downloaded.');
  return zip.generateAsync({ type: 'blob', compression: 'STORE' });
}

async function blobToDataUrl(blob) {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);

  // Service workers do not provide URL.createObjectURL(), so create a
  // data URL directly from the generated Blob instead. Chunking avoids
  // overflowing the argument limit of String.fromCharCode.apply().
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return `data:${blob.type || 'application/octet-stream'};base64,${btoa(binary)}`;
}

async function handleDownload(images, settings) {
  if (!images.length) throw new Error('No images selected.');
  const format = settings.format || 'pdf';
  const filename = sanitizeFilename(settings.filename || pageBaseName());
  let blob;

  if (format === 'cbz') {
    blob = await buildCbz(images);
  } else {
    blob = await buildPdf(images, settings);
  }

  const url = await blobToDataUrl(blob);
  const extension = format === 'cbz' ? 'cbz' : 'pdf';

  await new Promise((resolve, reject) => {
    chrome.downloads.download({
      url,
      filename: `${filename}.${extension}`,
      saveAs: true
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (downloadId == null) {
        reject(new Error('Chrome did not start the save operation.'));
        return;
      }
      resolve(downloadId);
    });
  });
}
