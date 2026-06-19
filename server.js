const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const AdmZip = require('adm-zip');
const { renderFrames } = require('./src/renderer');
const { encodeVideo } = require('./src/encoder');

const app = express();
const PORT = process.env.PORT || 3000;

// Setup directories
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const TEMP_DIR = path.join(__dirname, 'temp');
const VIDEOS_DIR = path.join(__dirname, 'public', 'videos');

[UPLOADS_DIR, TEMP_DIR, VIDEOS_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOADS_DIR);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  }
});
const upload = multer({ storage });

// Serve static UI files
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// In-memory jobs store
const jobs = new Map();

function updateJobProgress(jobId, percent, message) {
  const job = jobs.get(jobId);
  if (!job) return;
  job.progress = percent;
  job.message = message;

  job.sseClients.forEach(res => {
    res.write(`data: ${JSON.stringify({ type: 'progress', percent, message })}\n\n`);
  });
}

function completeJob(jobId, videoUrl) {
  const job = jobs.get(jobId);
  if (!job) return;
  job.status = 'completed';
  job.videoUrl = videoUrl;

  job.sseClients.forEach(res => {
    res.write(`data: ${JSON.stringify({ type: 'done', videoUrl })}\n\n`);
    res.end();
  });

  // Persist the job details briefly so client has time to establish SSE connection
  setTimeout(() => {
    jobs.delete(jobId);
  }, 2 * 60 * 1000);
}

function failJob(jobId, errorMessage) {
  const job = jobs.get(jobId);
  if (!job) return;
  job.status = 'failed';
  job.error = errorMessage;

  job.sseClients.forEach(res => {
    res.write(`data: ${JSON.stringify({ type: 'error', message: errorMessage })}\n\n`);
    res.end();
  });

  // Persist the job details briefly so client has time to establish SSE connection
  setTimeout(() => {
    jobs.delete(jobId);
  }, 2 * 60 * 1000);
}

// REST API to upload HTML / ZIP and start job
app.post('/api/generate', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const { filename, path: filePath, originalname } = req.file;
    const width = parseInt(req.body.width, 10) || 1920;
    const height = parseInt(req.body.height, 10) || 1080;
    const duration = parseFloat(req.body.duration) || 5;
    const fps = parseInt(req.body.fps, 10) || 30;
    const deviceMode = req.body.deviceMode || 'desktop';

    const jobId = `job-${Date.now()}`;

    // Create job entry
    jobs.set(jobId, {
      id: jobId,
      status: 'pending',
      progress: 0,
      message: 'Initializing...',
      sseClients: []
    });

    // Start background processing
    processHtmlToVideo(jobId, filePath, originalname, width, height, duration, fps, deviceMode);

    // Return jobId so frontend can subscribe
    res.json({ jobId });
  } catch (err) {
    console.error('Error starting video generation:', err);
    res.status(500).json({ error: 'Failed to start video generation process' });
  }
});

// SSE endpoint to subscribe to progress updates
app.get('/api/progress/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);

  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  // Set headers for Server-Sent Events
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no' // Prevent Nginx/Render proxy from buffering SSE progress updates
  });

  // If the job has already finished before SSE was connected:
  if (job.status === 'completed') {
    res.write(`data: ${JSON.stringify({ type: 'done', videoUrl: job.videoUrl })}\n\n`);
    res.end();
    return;
  }
  if (job.status === 'failed') {
    res.write(`data: ${JSON.stringify({ type: 'error', message: job.error })}\n\n`);
    res.end();
    return;
  }

  // Keep-alive heartbeat (reduced interval to keep sockets open on Render)
  const keepAlive = setInterval(() => {
    res.write(': keepalive\n\n');
  }, 10000);

  // Register client
  job.sseClients.push(res);

  // Send current state immediately
  res.write(`data: ${JSON.stringify({ type: 'progress', percent: job.progress, message: job.message })}\n\n`);

  req.on('close', () => {
    clearInterval(keepAlive);
    if (jobs.has(jobId)) {
      const activeJob = jobs.get(jobId);
      activeJob.sseClients = activeJob.sseClients.filter(c => c !== res);
    }
  });
});

// Explicit download endpoint to force correct attachment header naming
app.get('/api/download/:filename', (req, res) => {
  const { filename } = req.params;
  const filePath = path.join(VIDEOS_DIR, filename);

  if (fs.existsSync(filePath)) {
    res.download(filePath, filename);
  } else {
    res.status(404).send('Video not found or expired.');
  }
});

// Background process manager
async function processHtmlToVideo(jobId, uploadedFilePath, originalName, width, height, duration, fps, deviceMode) {
  const jobTempDir = path.join(TEMP_DIR, jobId);
  const framesDir = path.join(jobTempDir, 'frames');

  try {
    fs.mkdirSync(framesDir, { recursive: true });

    let entryHtmlPath = '';

    if (originalName.endsWith('.zip')) {
      updateJobProgress(jobId, 5, 'Extracting zip contents...');
      const zip = new AdmZip(uploadedFilePath);
      zip.extractAllTo(jobTempDir, true);

      // Find index.html or first html file in extracted content
      const findHtml = (dir) => {
        const files = fs.readdirSync(dir);
        // Look for index.html first
        if (files.includes('index.html')) {
          return path.join(dir, 'index.html');
        }
        // Fallback to first HTML file
        for (const file of files) {
          const fullPath = path.join(dir, file);
          const stat = fs.statSync(fullPath);
          if (stat.isDirectory()) {
            const nested = findHtml(fullPath);
            if (nested) return nested;
          } else if (file.endsWith('.html')) {
            return fullPath;
          }
        }
        return null;
      };

      entryHtmlPath = findHtml(jobTempDir);
      if (!entryHtmlPath) {
        throw new Error('No HTML file found in ZIP archive.');
      }
    } else {
      updateJobProgress(jobId, 5, 'Preparing HTML file...');
      // Copy single HTML file to jobTempDir as index.html
      entryHtmlPath = path.join(jobTempDir, 'index.html');
      fs.copyFileSync(uploadedFilePath, entryHtmlPath);
    }

    updateJobProgress(jobId, 10, 'Opening Puppeteer render sandbox...');

    // Render frames
    await renderFrames(entryHtmlPath, framesDir, width, height, duration, fps, deviceMode, (percent, msg) => {
      // Scale Puppeteer render progress to occupy 10% to 80% range of the total workflow
      const overallPercent = Math.round(10 + percent * 0.7);
      updateJobProgress(jobId, overallPercent, msg);
    });

    updateJobProgress(jobId, 85, 'Initializing FFmpeg video encoder...');

    const outputVideoFilename = `${jobId}.mp4`;
    const outputVideoPath = path.join(VIDEOS_DIR, outputVideoFilename);

    // Encode video
    await encodeVideo(framesDir, outputVideoPath, fps, (percent, msg) => {
      // Scale FFmpeg progress to occupy 85% to 98% range of total workflow
      const overallPercent = Math.round(85 + percent * 0.13);
      updateJobProgress(jobId, overallPercent, msg);
    });

    updateJobProgress(jobId, 100, 'Video creation completed! Finalizing...');

    // Clean up temporary job folder and uploaded file
    try {
      fs.rmSync(jobTempDir, { recursive: true, force: true });
      fs.unlinkSync(uploadedFilePath);
    } catch (cleanupErr) {
      console.warn(`[Cleanup Warning] Failed to clean up temp files for ${jobId}:`, cleanupErr.message);
    }

    completeJob(jobId, `/videos/${outputVideoFilename}`);

  } catch (err) {
    console.error(`[Job Error] Job ${jobId} failed:`, err);

    // Attempt cleanup on failure
    try {
      if (fs.existsSync(jobTempDir)) {
        fs.rmSync(jobTempDir, { recursive: true, force: true });
      }
      if (fs.existsSync(uploadedFilePath)) {
        fs.unlinkSync(uploadedFilePath);
      }
    } catch (cleanupErr) {
      console.warn(`[Cleanup Warning] Failed to clean up temp files on job failure:`, cleanupErr.message);
    }

    failJob(jobId, err.message || 'An unknown error occurred during video creation.');
  }
}

// Start server if run directly
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`==================================================`);
    console.log(` HTML-to-MP4 Video Generator Server running!`);
    console.log(` URL: http://localhost:${PORT}`);
    console.log(`==================================================`);
  });
}

module.exports = app;
