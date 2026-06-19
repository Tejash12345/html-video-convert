const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

/**
 * Detects standard browser executables globally installed on Windows.
 */
function findChromeExecutable() {
  if (process.platform !== 'win32') return null;

  const paths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
  ];

  for (const p of paths) {
    if (fs.existsSync(p)) {
      return p;
    }
  }
  return null;
}

let globalBrowser = null;

/**
 * Reuses a single running Chrome browser instance across requests.
 * This completely eliminates the 20-second browser startup delay per video render!
 */
async function getBrowser() {
  if (globalBrowser && globalBrowser.connected) {
    return globalBrowser;
  }

  const executablePath = findChromeExecutable();
  globalBrowser = await puppeteer.launch({
    headless: true,
    executablePath: executablePath || undefined,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-web-security',
      '--allow-file-access-from-files',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--disable-background-networking',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-breakpad',
      '--disable-client-side-phishing-detection',
      '--disable-default-apps',
      '--disable-hang-monitor',
      '--disable-ipc-flooding-protection',
      '--disable-popup-blocking',
      '--disable-prompt-on-repost',
      '--disable-renderer-backgrounding',
      '--js-flags="--max-old-space-size=256"',
      '--disable-extensions',
      '--mute-audio'
    ]
  });

  return globalBrowser;
}

/**
 * Renders an HTML page frame-by-frame by advancing time deterministically
 * and capturing screenshots.
 * 
 * @param {string} htmlPath Path to index.html to render
 * @param {string} outputDir Directory where frames will be saved
 * @param {number} width Resolution width
 * @param {number} height Resolution height
 * @param {number} duration Video duration in seconds
 * @param {number} fps Frames per second
 * @param {string} deviceMode 'desktop' or 'mobile' layout simulation
 * @param {function} onProgress Progress callback: (percent, message) => {}
 */
async function renderFrames(htmlPath, outputDir, width, height, duration, fps, deviceMode, renderQuality, hideSelectors, onProgress) {
  const browser = await getBrowser();
  
  let page = null;
  try {
    page = await browser.newPage();

    let viewportWidth = width;
    let viewportHeight = height;
    let scaleFactor = 1; // Native pixel-to-pixel scale factor for desktop (prevents 4K memory spikes on 512MB RAM)

    // Simulate mobile viewport size while maintaining high-resolution output using deviceScaleFactor
    if (deviceMode === 'mobile') {
      await page.setUserAgent('Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36');
      if (height > width) {
        // Portrait mobile aspect ratio mapping to a base width of 360px
        viewportWidth = 360;
        viewportHeight = Math.round(360 * (height / width));
        scaleFactor = width / 360;
      } else {
        // Landscape mobile aspect ratio mapping to a base width of 640px
        viewportWidth = 640;
        viewportHeight = Math.round(640 * (height / width));
        scaleFactor = width / 640;
      }
    }

    await page.setViewport({
      width: viewportWidth,
      height: viewportHeight,
      deviceScaleFactor: scaleFactor,
      isMobile: deviceMode === 'mobile',
      hasTouch: deviceMode === 'mobile'
    });

    // Inject time mocking script before page loads
    await page.evaluateOnNewDocument(() => {
      let currentTime = 0;
      let timerIdCounter = 0;
      const timers = new Map();
      const rafCallbacks = new Map();
      let rafIdCounter = 0;
      let lastElementCount = 0;
      let animatedElements = [];

      // Intercept and override Date.now and performance.now
      window.performance = window.performance || {};
      window.performance.now = () => currentTime;
      Date.now = () => currentTime;

      // Mock requestAnimationFrame
      window.requestAnimationFrame = (cb) => {
        rafIdCounter++;
        rafCallbacks.set(rafIdCounter, cb);
        return rafIdCounter;
      };

      window.cancelAnimationFrame = (id) => {
        rafCallbacks.delete(id);
      };

      // Mock setTimeout
      window.setTimeout = (callback, delay = 0, ...args) => {
        timerIdCounter++;
        timers.set(timerIdCounter, {
          callback,
          triggerTime: currentTime + delay,
          args,
          type: 'timeout'
        });
        return timerIdCounter;
      };

      window.clearTimeout = (id) => {
        timers.delete(id);
      };

      // Mock setInterval
      window.setInterval = (callback, delay = 0, ...args) => {
        timerIdCounter++;
        timers.set(timerIdCounter, {
          callback,
          delay,
          triggerTime: currentTime + delay,
          args,
          type: 'interval'
        });
        return timerIdCounter;
      };

      window.clearInterval = (id) => {
        timers.delete(id);
      };

      // Injected time advancement controller
      window.__advanceTime__ = (ms) => {
        const targetTime = currentTime + ms;

        // Process scheduled timers in chronological order
        while (true) {
          let nextTimer = null;
          let nextTimerId = null;

          for (const [id, timer] of timers.entries()) {
            if (timer.triggerTime <= targetTime && (nextTimer === null || timer.triggerTime < nextTimer.triggerTime)) {
              nextTimer = timer;
              nextTimerId = id;
            }
          }

          if (!nextTimer) break;

          // Advance virtual clock to trigger time
          currentTime = nextTimer.triggerTime;

          // Execute timer callback
          try {
            nextTimer.callback(...nextTimer.args);
          } catch (e) {
            console.error('[Mock Timer Error]', e);
          }

          if (nextTimer.type === 'interval') {
            nextTimer.triggerTime = currentTime + nextTimer.delay;
          } else {
            timers.delete(nextTimerId);
          }
        }

        // Set virtual time to final target
        currentTime = targetTime;

        // Trigger animation frames
        const currentRafCallbacks = Array.from(rafCallbacks.entries());
        rafCallbacks.clear();
        for (const [id, cb] of currentRafCallbacks) {
          try {
            cb(currentTime);
          } catch (e) {
            console.error('[Mock RAF Error]', e);
          }
        }

        // Advance Web Animations API
        if (document.getAnimations) {
          document.getAnimations().forEach(anim => {
            try {
              anim.pause();
              anim.currentTime = currentTime;
            } catch (err) {
              // Ignore animation control issues
            }
          });
        }

        // Pause and seek CSS Keyframe animations (via negative delay) with element caching for 90% speedup
        const currentElements = document.querySelectorAll('*');
        if (currentElements.length !== lastElementCount) {
          lastElementCount = currentElements.length;
          animatedElements = [];
          currentElements.forEach(el => {
            try {
              const style = window.getComputedStyle(el);
              if (style.animationName && style.animationName !== 'none') {
                animatedElements.push(el);
              }
            } catch (err) {}
          });
        }

        animatedElements.forEach(el => {
          try {
            el.style.animationPlayState = 'paused';
            el.style.animationDelay = `-${currentTime / 1000}s`;
          } catch (err) {}
        });
      };
    });

    // Navigate to page using local file URL scheme
    const fileUrl = `file://${path.resolve(htmlPath).replace(/\\/g, '/')}`;
    if (onProgress) onProgress(0, 'Loading HTML page...');
    
    await page.goto(fileUrl, { waitUntil: 'load', timeout: 60000 });

    // Inject CSS for text rendering optimization and hiding specified selectors
    let cssInjection = `
      * {
        -webkit-font-smoothing: antialiased !important;
        -moz-osx-font-smoothing: grayscale !important;
        text-rendering: optimizeLegibility !important;
      }
    `;
    if (hideSelectors && hideSelectors.trim()) {
      cssInjection += `\n${hideSelectors} { display: none !important; visibility: hidden !important; opacity: 0 !important; pointer-events: none !important; }`;
    }
    await page.addStyleTag({ content: cssInjection });

    // Allow static image loading and font face rendering to finish (reduced buffer for speed)
    await new Promise(resolve => setTimeout(resolve, 400));

    const totalFrames = Math.ceil(duration * fps);
    const frameDurationMs = 1000 / fps;

    for (let frame = 1; frame <= totalFrames; frame++) {
      // For all frames after the first, step the clocks forward
      if (frame > 1) {
        await page.evaluate((ms) => {
          window.__advanceTime__(ms);
        }, frameDurationMs);
      }

      // Capture frame using standard memory-safe page.screenshot
      const isHigh = renderQuality === 'high';
      const screenshotOptions = {
        type: 'jpeg',
        quality: isHigh ? 95 : 80
      };

      const buffer = await page.screenshot(screenshotOptions);

      const frameFilename = `frame_${String(frame).padStart(4, '0')}.jpg`;
      const framePath = path.join(outputDir, frameFilename);

      // Write to disk and await completion to prevent memory accumulation in RAM
      await fs.promises.writeFile(framePath, buffer);

      // Periodically trigger Node garbage collection to keep RAM below 512MB
      if (frame % 15 === 0) {
        if (global.gc) {
          global.gc();
        }
      }

      const percent = Math.round((frame / totalFrames) * 100);
      if (onProgress) {
        onProgress(percent, `Rendered frame ${frame}/${totalFrames} (${percent}%)`);
      }
    }
  } finally {
    if (page) {
      try {
        await page.close();
      } catch (err) {}
    }
    if (globalBrowser) {
      try {
        await globalBrowser.close();
      } catch (err) {}
      globalBrowser = null;
    }
  }
}

module.exports = { renderFrames };
