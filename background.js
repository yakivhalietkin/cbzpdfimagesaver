
importScripts('libs/jszip.min.js', 'libs/jspdf.umd.min.js');

const { jsPDF } = jspdf;
const tabImages = new Map();
const tabStates = new Map();
let lastActiveTabId = null;

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'igr-download-browser',
      title: 'Download image with Image Grabber',
      contexts: ['image']
    });
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'igr-download-browser' || !info.srcUrl || !tab?.id) return;

  try {
    const entry = {
      url: info.srcUrl,
      name: getFilenameFromUrl(info.srcUrl),
      pageUrl: info.frameUrl || tab.url || '',
      frameUrl: info.frameUrl || tab.url || '',
      tabId: tab.id,
      frameId: Number.isInteger(info.frameId) ? info.frameId : 0
    };

    const fetched = await acquireImage(entry, { downloadMethod: 'browser' });
    const meta = getImageMetadata(entry, 0, fetched.blob);
    await chrome.downloads.download({
      url: await blobToDataUrl(fetched.blob),
      filename: (meta.baseName || 'image') + '.' + meta.extension,
      saveAs: true
    });
  } catch (error) {
    console.error('Browser-context image download failed:', error);
  }
});

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
  } catch (_) {}
}

async function hydrateTabData(tabId) {
  if (tabId == null) return;
  if (!tabImages.has(tabId) || !tabStates.has(tabId)) {
    try {
      const stored = await chrome.storage.session.get(['tabImages', 'tabStates']);
      if (!tabImages.has(tabId) && stored.tabImages?.[tabId]) {
        tabImages.set(tabId, stored.tabImages[tabId]);
      }
      if (!tabStates.has(tabId) && stored.tabStates?.[tabId]) {
        tabStates.set(tabId, stored.tabStates[tabId]);
      }
    } catch (_) {}
  }
}

function sendProgress(tabId, current, total, message) {
  if (tabId == null) return;
  chrome.runtime.sendMessage({
    action: 'download-progress',
    tabId,
    current,
    total,
    message
  }).catch?.(() => {});
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const senderTabId = sender.tab?.id;

  switch (request.action) {
    case 'content-script-ready': {
      if (senderTabId != null) {
        tabStates.set(senderTabId, {
          ...(tabStates.get(senderTabId) || {}),
          ready: true
        });
        lastActiveTabId = senderTabId;
      }
      break;
    }

    case 'update-images': {
      if (senderTabId != null) {
        const frameId = Number.isInteger(sender.frameId) ? sender.frameId : 0;
        const frameUrl = sender.url || '';
        const incoming = (Array.isArray(request.images) ? request.images : []).map((entry) => ({
          ...entry,
          tabId: senderTabId,
          frameId,
          frameUrl: entry.frameUrl || frameUrl,
          pageUrl: entry.pageUrl || frameUrl
        }));
        const existing = tabImages.get(senderTabId) || [];
        const merged = existing.filter((entry) => entry.frameId !== frameId);
        tabImages.set(senderTabId, merged.concat(incoming));
        lastActiveTabId = senderTabId;
        persistTabData(senderTabId);
      }
      break;
    }

    case 'update-images-from-popup': {
      const tabId = request.tabId ?? lastActiveTabId;
      if (tabId != null) {
        const normalized = (Array.isArray(request.images) ? request.images : []).map((entry) => ({
          ...entry,
          tabId: entry.tabId ?? tabId
        }));
        tabImages.set(tabId, normalized);
        lastActiveTabId = tabId;
        persistTabData(tabId);
      }
      break;
    }

    case 'selection-mode-state': {
      if (senderTabId != null) {
        tabStates.set(senderTabId, {
          ...(tabStates.get(senderTabId) || {}),
          selectMode: Boolean(request.enabled)
        });
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

        tabStates.set(tabId, {
          ...(tabStates.get(tabId) || {}),
          selectMode: enabled
        });
        lastActiveTabId = tabId;
        persistTabData(tabId);

        try {
          await chrome.scripting.insertCSS({
            target: { tabId, allFrames: true },
            files: ['content.css']
          });
        } catch (_) {}

        try {
          await chrome.scripting.executeScript({
            target: { tabId, allFrames: true },
            files: ['content.js']
          });
          await chrome.tabs.sendMessage(tabId, {
            action: 'set-select-mode',
            enabled
          });
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
          url: chrome.runtime.getURL('popup.html') + '?tabId=' + (tabId ?? ''),
          type: 'popup',
          width: 420,
          height: 700
        });
      });
      break;
    }

    case 'download-images': {
      handleDownload(request.images || [], request.settings || {}, request.tabId ?? lastActiveTabId)
        .then((result) => sendResponse({ ok: true, result }))
        .catch((error) => {
          console.error('Download failed:', error);
          sendResponse({
            ok: false,
            error: error?.message || String(error)
          });
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
    await chrome.storage.session.set({
      tabImages: stored.tabImages || {},
      tabStates: stored.tabStates || {}
    });
  } catch (_) {}
});

function sanitizeFilename(name) {
  return String(name || 'images')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'images';
}

function pageBaseName() {
  return 'selected-images';
}

function getExtensionFromType(type) {
  const subtype = String(type || '').split('/')[1]?.toLowerCase();
  const aliases = {
    jpeg: 'jpg',
    jpg: 'jpg',
    svg: 'svg',
    webp: 'webp',
    png: 'png',
    gif: 'gif',
    avif: 'avif',
    bmp: 'bmp',
    'x-icon': 'ico',
    tiff: 'tiff'
  };
  return aliases[subtype] || 'img';
}

function getFilenameFromUrl(url) {
  try {
    const pathname = new URL(url).pathname;
    const filename = decodeURIComponent(pathname.substring(pathname.lastIndexOf('/') + 1));
    const withoutQuery = filename.split('?')[0].split('#')[0];
    return sanitizeFilename(withoutQuery || 'image').replace(/\\.[^.]+$/, '') || 'image';
  } catch (_) {
    return 'image';
  }
}

function isDataUrl(url) {
  return /^data:/i.test(String(url || ''));
}

function isBlobUrl(url) {
  return /^blob:/i.test(String(url || ''));
}

function dataUrlToArrayBuffer(dataUrl) {
  const match = /^data:([^;,]+)?(?:;charset=[^;,]+)?(;base64)?,(.*)$/is.exec(dataUrl);
  if (!match) throw new Error('Invalid data URL');

  const mime = match[1] || 'application/octet-stream';
  const isBase64 = Boolean(match[2]);
  const payload = match[3];

  if (isBase64) {
    const binary = atob(payload.replace(/\\s/g, ''));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return { bytes, type: mime };
  }

  const text = decodeURIComponent(payload);
  return { bytes: new TextEncoder().encode(text), type: mime };
}

async function fetchBlob(url, options = {}) {
  const response = await fetch(url, {
    credentials: 'include',
    cache: 'force-cache',
    referrer: options.referrer || 'about:client',
    referrerPolicy: options.referrerPolicy || 'strict-origin-when-cross-origin'
  });

  if (!response.ok) throw new Error('HTTP ' + response.status);
  const blob = await response.blob();
  if (!blob.size) throw new Error('Empty image response');
  return {
    blob,
    arrayBuffer: await blob.arrayBuffer(),
    url
  };
}

async function extractImageInPage(tabId, frameId, url) {
  if (tabId == null) throw new Error('No page context is available for this image.');

  const target = { tabId };
  if (Number.isInteger(frameId) && frameId >= 0) {
    target.frameIds = [frameId];
  }

  const results = await chrome.scripting.executeScript({
    target,
    func: async (sourceUrl) => {
      const toDataUrl = async (blob) => {
        const buffer = await blob.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        const chunkSize = 0x8000;
        let binary = '';
        for (let i = 0; i < bytes.length; i += chunkSize) {
          binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
        }
        return 'data:' + (blob.type || 'application/octet-stream') +
          ';base64,' + btoa(binary);
      };

      const response = await fetch(sourceUrl, {
        credentials: 'include',
        cache: 'force-cache',
        referrer: location.href,
        referrerPolicy: 'strict-origin-when-cross-origin'
      });

      if (!response.ok) throw new Error('HTTP ' + response.status);
      const blob = await response.blob();
      if (!blob.size) throw new Error('Empty image response');

      return {
        dataUrl: await toDataUrl(blob),
        type: blob.type || 'application/octet-stream',
        size: blob.size,
        url: sourceUrl
      };
    },
    args: [url],
    world: 'MAIN'
  });

  const result = results?.[0]?.result;
  if (!result) throw new Error('The page did not return image data.');

  const decoded = dataUrlToArrayBuffer(result.dataUrl);
  return {
    blob: new Blob([decoded.bytes], { type: result.type || decoded.type }),
    arrayBuffer: decoded.bytes.buffer,
    url: result.url || url
  };
}

async function acquireImage(entry, options = {}) {
  const normalized = typeof entry === 'string' ? { url: entry } : { ...(entry || {}) };
  const url = normalized.url;
  if (!url) throw new Error('Missing image URL');

  const method = options.downloadMethod || 'browser';

  if (isDataUrl(url)) {
    const decoded = dataUrlToArrayBuffer(url);
    return {
      blob: new Blob([decoded.bytes], { type: decoded.type }),
      arrayBuffer: decoded.bytes.buffer,
      url
    };
  }

  if (method === 'browser' && isBlobUrl(url)) {
    return await extractImageInPage(
      normalized.tabId ?? options.tabId,
      normalized.frameId,
      url
    );
  }

  try {
    return await fetchBlob(url, {
      referrer: normalized.pageUrl || normalized.frameUrl || options.pageUrl || ''
    });
  } catch (directError) {
    if (method !== 'browser') throw directError;

    try {
      return await extractImageInPage(
        normalized.tabId ?? options.tabId,
        normalized.frameId,
        url
      );
    } catch (pageError) {
      throw new Error(
        'Browser acquisition failed: ' + directError.message +
        '; page context: ' + pageError.message
      );
    }
  }
}

function getImageMetadata(entry, index, blob) {
  const explicitName = typeof entry === 'object' ? entry.name : '';
  return {
    baseName: sanitizeFilename(
      explicitName
        ? explicitName.replace(/\\.[^.]+$/, '')
        : getFilenameFromUrl(entry.url || entry)
    ),
    index: index + 1,
    type: blob.type || 'image/jpeg',
    extension: getExtensionFromType(blob.type) || 'img'
  };
}

async function buildPdf(images, settings, tabId) {
  let doc = null;
  let added = 0;
  const failures = [];

  const compression = Number(settings.compression) >= 90
    ? 'SLOW'
    : Number(settings.compression) >= 70
      ? 'MEDIUM'
      : Number(settings.compression) >= 50
        ? 'FAST'
        : 'NONE';

  for (let i = 0; i < images.length; i++) {
    try {
      const fetched = await acquireImage(images[i], {
        downloadMethod: settings.downloadMethod || 'browser',
        tabId: images[i]?.tabId ?? tabId,
        pageUrl: images[i]?.pageUrl
      });

      let imageBlob = fetched.blob;
      let width;
      let height;

      try {
        const bitmap = await createImageBitmap(fetched.blob);
        width = bitmap.width;
        height = bitmap.height;

        const canvas = new OffscreenCanvas(width, height);
        const ctx = canvas.getContext('2d', { alpha: false });
        ctx.drawImage(bitmap, 0, 0);
        imageBlob = await canvas.convertToBlob({ type: 'image/png' });
        bitmap.close();
      } catch (error) {
        const buffer = await fetched.blob.arrayBuffer();
        const props = jsPDF.getImageProperties(new Uint8Array(buffer));
        width = props.width;
        height = props.height;
      }

      const buffer = await imageBlob.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      const orientation = width > height ? 'l' : 'p';

      if (!doc) {
        doc = new jsPDF({
          orientation,
          unit: 'pt',
          format: [width, height],
          compress: true
        });
      } else {
        doc.addPage([width, height], orientation);
      }

      doc.addImage(
        bytes,
        'PNG',
        0,
        0,
        width,
        height,
        undefined,
        compression
      );

      added++;
      sendProgress(tabId, i + 1, images.length, 'Saved ' + (i + 1) + ' of ' + images.length);
    } catch (error) {
      failures.push({
        index: i + 1,
        error: error?.message || String(error)
      });
      sendProgress(
        tabId,
        i + 1,
        images.length,
        'Skipped ' + (i + 1) + ': ' + (error?.message || error)
      );
    }
  }

  if (!doc || added === 0) {
    throw new Error(
      'No images could be downloaded.' +
      (failures.length ? ' ' + failures.length + ' failed.' : '')
    );
  }

  return {
    blob: await doc.output('blob'),
    added,
    failed: failures
  };
}

async function buildCbz(images, settings, tabId) {
  const zip = new JSZip();
  let added = 0;
  const failures = [];

  for (let i = 0; i < images.length; i++) {
    try {
      const fetched = await acquireImage(images[i], {
        downloadMethod: settings.downloadMethod || 'browser',
        tabId: images[i]?.tabId ?? tabId,
        pageUrl: images[i]?.pageUrl
      });

      const meta = getImageMetadata(images[i], i, fetched.blob);
      const prefix = String(meta.index).padStart(4, '0');

      zip.file(
        prefix + '.' + (meta.baseName || 'image') + '.' + meta.extension,
        fetched.arrayBuffer
      );

      added++;
      sendProgress(tabId, i + 1, images.length, 'Saved ' + (i + 1) + ' of ' + images.length);
    } catch (error) {
      failures.push({
        index: i + 1,
        error: error?.message || String(error)
      });
      sendProgress(
        tabId,
        i + 1,
        images.length,
        'Skipped ' + (i + 1) + ': ' + (error?.message || error)
      );
    }
  }

  if (!added) {
    throw new Error(
      'No images could be downloaded.' +
      (failures.length ? ' ' + failures.length + ' failed.' : '')
    );
  }

  return {
    blob: await zip.generateAsync({ type: 'blob', compression: 'STORE' }),
    added,
    failed: failures
  };
}

async function blobToDataUrl(blob) {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';

  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }

  return 'data:' + (blob.type || 'application/octet-stream') +
    ';base64,' + btoa(binary);
}

async function handleDownload(images, settings, tabId) {
  if (!images.length) throw new Error('No images selected.');

  const format = settings.format || 'pdf';
  const filename = sanitizeFilename(settings.filename || pageBaseName());

  const result = format === 'cbz'
    ? await buildCbz(images, settings, tabId)
    : await buildPdf(images, settings, tabId);

  const extension = format === 'cbz' ? 'cbz' : 'pdf';
  const url = await blobToDataUrl(result.blob);

  await new Promise((resolve, reject) => {
    chrome.downloads.download({
      url,
      filename: filename + '.' + extension,
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

  return {
    added: result.added,
    failed: result.failed
  };
}
