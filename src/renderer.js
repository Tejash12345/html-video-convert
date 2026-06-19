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
 * @param {function} onProgress Progress callback: (percent, message) => {}
 */
async function renderFrames(htmlPath, outputDir, width, height, duration, fps, onProgress) {
  const executablePath = findChromeExecutable();
  
  // Launch Puppeteer headless browser
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: executablePath || undefined,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-web-security',
      '--allow-file-access-from-files'
    ]
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width, height });

    // Inject time mocking script before page loads
    await page.evaluateOnNewDocument(() => {
      let currentTime = 0;
      let timerIdCounter = 0;
      const timers = new Map();
      const rafCallbacks = new Map();
      let rafIdCounter = 0;

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

        // Pause and seek CSS Keyframe animations (via negative delay)
        const elements = document.querySelectorAll('*');
        elements.forEach(el => {
          try {
            const style = window.getComputedStyle(el);
            if (style.animationName && style.animationName !== 'none') {
              el.style.animationPlayState = 'paused';
              el.style.animationDelay = `-${currentTime / 1000}s`;
            }
          } catch (err) {
            // Ignore elements that computed style check fails on
          }
        });
      };
    });

    // Navigate to page using local file URL scheme
    const fileUrl = `file://${path.resolve(htmlPath).replace(/\\/g, '/')}`;
    if (onProgress) onProgress(0, 'Loading HTML page...');
    
    await page.goto(fileUrl, { waitUntil: 'networkidle0' });

    // Allow static image loading and font face rendering to finish
    await new Promise(resolve => setTimeout(resolve, 1000));

    const totalFrames = Math.ceil(duration * fps);
    const frameDurationMs = 1000 / fps;

    for (let frame = 1; frame <= totalFrames; frame++) {
      // For all frames after the first, step the clocks forward
      if (frame > 1) {
        await page.evaluate((ms) => {
          window.__advanceTime__(ms);
        }, frameDurationMs);
      }

      // Render frame screenshot
      const frameFilename = `frame_${String(frame).padStart(4, '0')}.png`;
      const framePath = path.join(outputDir, frameFilename);
      
      await page.screenshot({
        path: framePath,
        type: 'png',
        omitBackground: false
      });

      const percent = Math.round((frame / totalFrames) * 100);
      if (onProgress) {
        onProgress(percent, `Rendered frame ${frame}/${totalFrames} (${percent}%)`);
      }
    }
  } finally {
    await browser.close();
  }
}

module.exports = { renderFrames };
