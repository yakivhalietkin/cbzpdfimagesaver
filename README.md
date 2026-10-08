# Image Grabber — PDF / CBZ

Chrome Manifest V3 extension for selecting images directly on a webpage and downloading the ordered selection as a single PDF or CBZ archive.

## Install

1. Unzip this project.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked** and choose the project folder.

## Usage

1. Open a page containing the images you want.
2. Open the extension and enable **Selection mode**.
3. Click images on the page to add/remove them.
4. Open the extension again to review and drag the selected images into the desired order.
5. Choose **PDF** or **CBZ** and click **Save**.

## Browser-context image acquisition

The downloader now uses a browser-context acquisition path by default. The intent is to handle images more like a normal browser save operation instead of relying only on a service-worker `fetch()`.

The acquisition path:

- preserves the source tab and frame for each selected image;
- handles normal HTTP(S) image URLs;
- handles `blob:` and `data:` URLs through the page context;
- sends page referrer information with browser-context requests;
- falls back between extension-context and page-context acquisition;
- continues the archive when an individual image fails.

There is also a browser-context right-click test action:

**Right click an image → Download image with Image Grabber**

That downloads the single image through the same acquisition path.

This does not invoke Chrome's private built-in **Save image as…** command directly; Chrome does not expose that command as an extension API. The feature instead reproduces the useful browser/page context available to an extension.

Selection mode uses an overlay, so images are not moved or reparented in the page DOM.
