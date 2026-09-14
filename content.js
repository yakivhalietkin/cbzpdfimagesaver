(() => {
  if (window.__imageGrabberSelectorInitialized) {
    chrome.runtime.sendMessage({ action: 'content-script-ready' });
    return;
  }
  window.__imageGrabberSelectorInitialized = true;

  let enabled = true;
  let minWidth = 50;
  let minHeight = 50;
  const selected = new Map();
  const cleanupHandlers = new Map();
  let processed = new WeakSet();

  function loadSettings() {
    chrome.storage.local.get(['settings'], (result) => {
      const settings = result.settings || {};
      minWidth = Math.max(0, Number.parseInt(settings.minWidth, 10) || 50);
      minHeight = Math.max(0, Number.parseInt(settings.minHeight, 10) || 50);
      if (enabled) initialize();
    });
  }

  function getImageUrl(image) {
    return image.currentSrc || image.src || image.getAttribute('src') || image.getAttribute('data-src') || '';
  }

  function getDisplayName(image, index) {
    const url = getImageUrl(image);
    try {
      const pathname = new URL(url, location.href).pathname;
      const name = decodeURIComponent(pathname.split('/').pop() || '');
      if (name) return name;
    } catch (_) {}
    return image.alt || `image-${String(index + 1).padStart(3, '0')}`;
  }

  function imageIsEligible(image) {
    return image instanceof HTMLImageElement &&
      image.naturalWidth >= minWidth &&
      image.naturalHeight >= minHeight;
  }

  function updateBadge() {
    selected.forEach((entry, key) => {
      entry.badge.textContent = String(Array.from(selected.keys()).indexOf(key) + 1);
    });
  }

  function emitSelection() {
    const images = Array.from(selected.values()).map((entry, index) => ({
      url: entry.url,
      name: entry.name || `image-${String(index + 1).padStart(3, '0')}`,
      position: index + 1
    }));
    chrome.runtime.sendMessage({ action: 'update-images', images });
  }

  function selectImage(image, overlay, badge) {
    const url = getImageUrl(image);
    if (!url) return;

    if (selected.has(image)) {
      selected.delete(image);
      overlay.classList.remove('igr-selected');
      badge.classList.remove('igr-visible');
    } else {
      const name = getDisplayName(image, selected.size);
      selected.set(image, { image, url, name, overlay, badge });
      overlay.classList.add('igr-selected');
      badge.classList.add('igr-visible');
    }
    updateBadge();
    emitSelection();
  }

  function createOverlay(image) {
    if (processed.has(image) || !imageIsEligible(image)) return;
    processed.add(image);

    const overlay = document.createElement('div');
    overlay.className = 'igr-overlay';
    overlay.setAttribute('data-image-grabber-overlay', 'true');
    overlay.__igrImage = image;
    overlay.title = 'Select image';

    const badge = document.createElement('div');
    badge.className = 'igr-badge';
    badge.textContent = '0';
    overlay.appendChild(badge);

    const handler = (event) => {
      if (!enabled) return;
      event.preventDefault();
      event.stopPropagation();
      selectImage(image, overlay, badge);
    };

    overlay.addEventListener('click', handler, true);
    document.documentElement.appendChild(overlay);

    const cleanup = () => {
      overlay.removeEventListener('click', handler, true);
      overlay.remove();
      selected.delete(image);
    };
    cleanupHandlers.set(image, cleanup);

    const position = () => {
      if (!overlay.isConnected) return;
      const rect = image.getBoundingClientRect();
      if (!rect.width || !rect.height) {
        overlay.style.display = 'none';
        return;
      }
      overlay.style.display = 'block';
      overlay.style.left = `${rect.left + window.scrollX}px`;
      overlay.style.top = `${rect.top + window.scrollY}px`;
      overlay.style.width = `${rect.width}px`;
      overlay.style.height = `${rect.height}px`;
    };

    image.addEventListener('load', position, { passive: true });
    position();
  }

  function processImage(image) {
    if (!(image instanceof HTMLImageElement)) return;
    if (image.complete) {
      createOverlay(image);
    } else {
      image.addEventListener('load', () => createOverlay(image), { once: true, passive: true });
    }
  }

  function scan() {
    document.querySelectorAll('img').forEach(processImage);
  }

  function initialize() {
    scan();

    if (!document.body) return;
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node instanceof HTMLImageElement) processImage(node);
          else if (node.querySelectorAll) node.querySelectorAll('img').forEach(processImage);
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    const positionAll = () => {
      document.querySelectorAll('.igr-overlay').forEach((overlay) => {
        const image = overlay.__igrImage;
        if (!image || !image.isConnected) {
          overlay.remove();
          return;
        }
        const rect = image.getBoundingClientRect();
        overlay.style.display = rect.width && rect.height ? 'block' : 'none';
        overlay.style.left = `${rect.left + window.scrollX}px`;
        overlay.style.top = `${rect.top + window.scrollY}px`;
        overlay.style.width = `${rect.width}px`;
        overlay.style.height = `${rect.height}px`;
      });
    };
    window.addEventListener('resize', () => {
      positionAll();
      scan();
    }, { passive: true });
  }

  function disable() {
    enabled = false;
    selected.clear();
    cleanupHandlers.forEach((cleanup) => cleanup());
    cleanupHandlers.clear();
    processed = new WeakSet();
    emitSelection();
    chrome.runtime.sendMessage({ action: 'selection-mode-state', enabled: false });
  }

  chrome.runtime.onMessage.addListener((request) => {
    if (request.action === 'set-select-mode') {
      enabled = Boolean(request.enabled);
      if (enabled) scan();
      else disable();
    }
    if (request.action === 'clear-selection') {
      selected.clear();
      document.querySelectorAll('.igr-overlay.igr-selected').forEach((overlay) => overlay.classList.remove('igr-selected'));
      document.querySelectorAll('.igr-badge.igr-visible').forEach((badge) => badge.classList.remove('igr-visible'));
      emitSelection();
    }
  });

  loadSettings();
  chrome.runtime.sendMessage({ action: 'content-script-ready' });
})();
