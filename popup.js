const formatRadios = [...document.querySelectorAll('input[name="format"]')];
const compression = document.getElementById('compression');
const compressionRow = document.getElementById('compression-row');
const minWidth = document.getElementById('min-width');
const minHeight = document.getElementById('min-height');
const imageCount = document.getElementById('image-count');
const imageList = document.getElementById('image-list');
const emptyState = document.getElementById('empty-state');
const downloadBtn = document.getElementById('download');
const selectModeToggle = document.getElementById('select-mode');
const clearBtn = document.getElementById('clear-selection');
const errorBox = document.getElementById('error');
const status = document.getElementById('status');

let images = [];
let activeTabId = null;

const DEFAULTS = {
  format: 'pdf',
  compression: 95,
  minWidth: 50,
  minHeight: 50
};

function showError(message) {
  errorBox.textContent = message;
  errorBox.hidden = !message;
}

function currentFormat() {
  return formatRadios.find((radio) => radio.checked)?.value || 'pdf';
}

function saveSettings() {
  const settings = {
    format: currentFormat(),
    compression: Number(compression.value) || DEFAULTS.compression,
    minWidth: Number(minWidth.value) || DEFAULTS.minWidth,
    minHeight: Number(minHeight.value) || DEFAULTS.minHeight
  };
  chrome.storage.local.set({ settings });
  return settings;
}

function renderImages() {
  imageCount.textContent = String(images.length);
  emptyState.hidden = images.length > 0;
  downloadBtn.disabled = images.length === 0;
  imageList.innerHTML = '';

  images.forEach((entry, index) => {
    const li = document.createElement('li');
    li.dataset.index = String(index);

    const num = document.createElement('span');
    num.className = 'num';
    num.textContent = String(index + 1);

    const img = document.createElement('img');
    img.src = entry.url;
    img.loading = 'lazy';

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = entry.name || entry.url;
    name.title = entry.url;

    li.append(num, img, name);
    imageList.appendChild(li);
  });
}

function syncOrderFromDom() {
  const ordered = [...imageList.children].map((li) => images[Number(li.dataset.index)]).filter(Boolean);
  images = ordered;
  images.forEach((entry, index) => entry.position = index + 1);
  saveImagesToBackground();
  renderImages();
}

function saveImagesToBackground() {
  chrome.runtime.sendMessage({ action: 'update-images-from-popup', images, tabId: activeTabId });
}

function loadState() {
  chrome.storage.local.get(['settings'], (result) => {
    const settings = { ...DEFAULTS, ...(result.settings || {}) };
    const format = formatRadios.find((radio) => radio.value === settings.format) || formatRadios[0];
    format.checked = true;
    compression.value = settings.compression;
    minWidth.value = settings.minWidth;
    minHeight.value = settings.minHeight;
    compressionRow.style.display = settings.format === 'pdf' ? 'flex' : 'none';
  });

  chrome.runtime.sendMessage({ action: 'get-selected-images' }, (response) => {
    if (chrome.runtime.lastError) {
      showError(chrome.runtime.lastError.message);
      return;
    }
    activeTabId = response?.tabId ?? activeTabId;
    images = response?.images || [];
    selectModeToggle.checked = Boolean(response?.selectMode);
    status.textContent = selectModeToggle.checked ? 'Click images on the page to select them.' : 'Turn on selection mode to begin.';
    renderImages();
  });
}

formatRadios.forEach((radio) => radio.addEventListener('change', () => {
  compressionRow.style.display = currentFormat() === 'pdf' ? 'flex' : 'none';
  saveSettings();
}));
[compression, minWidth, minHeight].forEach((input) => input.addEventListener('change', saveSettings));

selectModeToggle.addEventListener('change', () => {
  const enabled = selectModeToggle.checked;
  chrome.storage.local.set({ selectMode: enabled });
  status.textContent = enabled ? 'Click images on the page to select them.' : 'Selection mode is off.';
  showError('');
  chrome.runtime.sendMessage({ action: 'toggle-select-mode', selectMode: enabled });
});

clearBtn.addEventListener('click', () => {
  images = [];
  renderImages();
  chrome.runtime.sendMessage({ action: 'clear-selection' });
});

downloadBtn.addEventListener('click', () => {
  if (!images.length) return;
  showError('');
  const settings = saveSettings();
  downloadBtn.disabled = true;
  downloadBtn.textContent = `Saving ${settings.format.toUpperCase()}…`;

  chrome.runtime.sendMessage({ action: 'download-images', images, settings }, (response) => {
    downloadBtn.disabled = false;
    downloadBtn.textContent = 'Save';

    if (chrome.runtime.lastError) {
      showError(chrome.runtime.lastError.message);
      return;
    }

    if (!response?.ok) {
      showError(response?.error || 'Unable to save the selected images.');
    }
  });
});

document.getElementById('open-in-new-window').addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'open-in-new-window' });
});

new Sortable(imageList, {
  animation: 150,
  ghostClass: 'sortable-ghost',
  onEnd: syncOrderFromDom
});

chrome.runtime.onMessage.addListener((request) => {
  if (request.action === 'update-popup-images') {
    images = request.images || [];
    renderImages();
  }
});

const queryTabId = Number(new URLSearchParams(location.search).get('tabId'));
if (Number.isInteger(queryTabId) && queryTabId > 0) activeTabId = queryTabId;
loadState();
