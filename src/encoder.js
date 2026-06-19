const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');

// Configure fluent-ffmpeg path (supports Render Linux system FFmpeg & Windows static fallback)
if (process.platform === 'win32') {
  ffmpeg.setFfmpegPath(ffmpegInstaller.path);
} else {
  const globalFfmpegPaths = ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg'];
  let foundGlobal = false;
  for (const p of globalFfmpegPaths) {
    if (fs.existsSync(p)) {
      ffmpeg.setFfmpegPath(p);
      foundGlobal = true;
      console.log(`[Encoder] Using system FFmpeg path: ${p}`);
      break;
    }
  }
  if (!foundGlobal) {
    ffmpeg.setFfmpegPath(ffmpegInstaller.path);
  }
}

/**
 * Combines rendered frame images into an MP4 video.
 * 
 * @param {string} framesDir Directory containing the frame images (e.g. frame_0001.png)
 * @param {string} outputPath Target path for the MP4 video output
 * @param {number} fps Output frame rate (FPS)
 * @param {number} targetWidth Output scaling width
 * @param {number} targetHeight Output scaling height
 * @param {function} onProgress Progress callback: (percent, message) => {}
 */
function encodeVideo(framesDir, outputPath, fps, targetWidth, targetHeight, renderQuality, onProgress) {
  return new Promise((resolve, reject) => {
    let totalFrames = 0;
    let extension = 'jpg';
    try {
      const files = fs.readdirSync(framesDir);
      const frameFiles = files.filter(f => f.startsWith('frame_'));
      if (frameFiles.length > 0) {
        extension = frameFiles[0].split('.').pop();
      }
      totalFrames = frameFiles.filter(f => f.endsWith(`.${extension}`)).length;
    } catch (e) {
      console.warn('[Encoder] Failed to determine frame count:', e.message);
    }

    if (totalFrames === 0) {
      return reject(new Error('No frame images found to encode.'));
    }

    const isHighQuality = renderQuality === 'high';
    const crfValue = isHighQuality ? '12' : '18';
    const presetValue = isHighQuality ? 'medium' : 'ultrafast';

    ffmpeg()
      .input(path.join(framesDir, `frame_%04d.${extension}`))
      .inputFPS(fps)
      .output(outputPath)
      .outputFPS(fps)
      .videoCodec('libx264')
      .videoFilters(`scale=${targetWidth}:${targetHeight}:flags=lanczos`)
      .outputOptions([
        '-pix_fmt yuv420p',  // Standard pixel format for maximum browser compatibility
        `-crf ${crfValue}`,   // Visually lossless for high quality (12) vs standard (18)
        `-preset ${presetValue}`, // Speed vs compression efficiency preset
        '-threads 1'         // Limit to 1 CPU thread to prevent memory allocation spikes in container
      ])
      .on('start', (commandLine) => {
        console.log('[FFmpeg Command]:', commandLine);
        if (onProgress) onProgress(0, 'Initializing video compiler...');
      })
      .on('progress', (progress) => {
        if (progress.frames && totalFrames > 0) {
          const percent = Math.min(Math.round((progress.frames / totalFrames) * 100), 100);
          if (onProgress) {
            onProgress(percent, `Compiling frame ${progress.frames}/${totalFrames} (${percent}%)`);
          }
        } else {
          if (onProgress) onProgress(50, 'Compiling video...');
        }
      })
      .on('end', () => {
        if (onProgress) onProgress(100, 'Video compilation finished!');
        resolve();
      })
      .on('error', (err) => {
        console.error('[FFmpeg Error]:', err);
        reject(new Error(`Encoding process failed: ${err.message}`));
      })
      .run();
  });
}

module.exports = { encodeVideo };
