document.addEventListener('DOMContentLoaded', () => {
  // Elements
  const form = document.getElementById('generator-form');
  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('file-input');
  const fileDetails = document.getElementById('file-details');
  const fileNameText = document.getElementById('file-name-text');
  const fileSizeText = document.getElementById('file-size-text');
  const removeFileBtn = document.getElementById('remove-file-btn');

  const resolutionPreset = document.getElementById('resolution-preset');
  const customResGroup = document.getElementById('custom-resolution-group');
  const customWidth = document.getElementById('custom-width');
  const customHeight = document.getElementById('custom-height');

  const durationSlider = document.getElementById('duration-slider');
  const durationVal = document.getElementById('duration-val');

  const submitBtn = document.getElementById('submit-btn');
  const previewPlaceholder = document.getElementById('preview-placeholder');
  const progressContainer = document.getElementById('progress-container');
  const progressStatus = document.getElementById('progress-status');
  const progressPercentText = document.getElementById('progress-percent-text');
  const progressBarFill = document.getElementById('progress-bar-fill');
  const consoleLog = document.getElementById('console-log');

  const videoPreviewContainer = document.getElementById('video-preview-container');
  const previewPlayer = document.getElementById('preview-player');
  const previewSource = document.getElementById('preview-source');
  const downloadBtn = document.getElementById('download-btn');
  const resetBtn = document.getElementById('reset-btn');

  let selectedFile = null;
  let eventSource = null;

  // 1. Drag & Drop Handlers
  ['dragenter', 'dragover'].forEach(eventName => {
    dropzone.addEventListener(eventName, (e) => {
      e.preventDefault();
      dropzone.classList.add('dragover');
    }, false);
  });

  ['dragleave', 'drop'].forEach(eventName => {
    dropzone.addEventListener(eventName, (e) => {
      e.preventDefault();
      dropzone.classList.remove('dragover');
    }, false);
  });

  dropzone.addEventListener('drop', (e) => {
    const dt = e.dataTransfer;
    const files = dt.files;
    if (files.length > 0) {
      handleFileSelection(files[0]);
    }
  });

  fileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
      handleFileSelection(e.target.files[0]);
    }
  });

  function handleFileSelection(file) {
    const ext = file.name.split('.').pop().toLowerCase();
    if (ext !== 'html' && ext !== 'zip') {
      alert('Only .html and .zip files are supported.');
      return;
    }

    selectedFile = file;
    fileNameText.textContent = file.name;
    fileSizeText.textContent = formatBytes(file.size);

    dropzone.classList.add('hidden');
    fileDetails.classList.remove('hidden');
    fileInput.required = false; // Bypass default validation since we have the file in variable
  }

  removeFileBtn.addEventListener('click', () => {
    selectedFile = null;
    fileInput.value = '';
    fileInput.required = true;
    fileDetails.classList.add('hidden');
    dropzone.classList.remove('hidden');
  });

  function formatBytes(bytes, decimals = 2) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
  }

  // 2. Resolution Preset selection
  resolutionPreset.addEventListener('change', (e) => {
    if (e.target.value === 'custom') {
      customResGroup.classList.remove('hidden');
    } else {
      customResGroup.classList.add('hidden');
    }
  });

  // 3. Duration Slider updates
  durationSlider.addEventListener('input', (e) => {
    durationVal.textContent = parseFloat(e.target.value).toFixed(1) + 's';
  });

  // 4. Form Submission & Generation
  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    if (!selectedFile) {
      alert('Please upload an HTML or ZIP file first.');
      return;
    }

    // Disable UI
    submitBtn.disabled = true;
    submitBtn.querySelector('span').textContent = 'Processing...';

    // Set view states
    previewPlaceholder.classList.add('hidden');
    videoPreviewContainer.classList.add('hidden');
    progressContainer.classList.remove('hidden');

    // Clear logs
    consoleLog.innerHTML = '';
    writeLog('Initializing generation request...', 'info');

    // Get parameters
    let width = 1920;
    let height = 1080;
    const preset = resolutionPreset.value;

    if (preset === 'custom') {
      width = parseInt(customWidth.value, 10) || 1920;
      height = parseInt(customHeight.value, 10) || 1080;
    } else {
      const parts = preset.split('x');
      width = parseInt(parts[0], 10);
      height = parseInt(parts[1], 10);
    }

    const duration = parseFloat(durationSlider.value);
    const fps = parseInt(form.querySelector('input[name="fps"]:checked').value, 10);
    const deviceMode = document.getElementById('device-mode').value;

    // Prepare FormData
    const formData = new FormData();
    formData.append('file', selectedFile);
    formData.append('width', width);
    formData.append('height', height);
    formData.append('duration', duration);
    formData.append('fps', fps);
    formData.append('deviceMode', deviceMode);

    try {
      writeLog(`Uploading ${selectedFile.name} (${formatBytes(selectedFile.size)})...`, 'info');
      writeLog(`Target resolution: ${width}x${height} @ ${fps}fps, Duration: ${duration}s`, 'accent');

      const response = await fetch('/api/generate', {
        method: 'POST',
        body: formData
      });

      if (!response.ok) {
        const errData = await response.json();
        throw new Error(errData.error || 'Failed to start video rendering.');
      }

      const { jobId } = await response.json();
      writeLog(`Upload success. Job registered: ${jobId}`, 'success');

      // Start EventSource connection
      listenToProgress(jobId);
    } catch (err) {
      writeLog(`Error: ${err.message}`, 'error');
      progressStatus.textContent = 'Failed to generate video.';
      submitBtn.disabled = false;
      submitBtn.querySelector('span').textContent = 'Render Video';
    }
  });

  // 5. SSE progress listener
  function listenToProgress(jobId) {
    if (eventSource) {
      eventSource.close();
    }

    eventSource = new EventSource(`/api/progress/${jobId}`);

    eventSource.onmessage = (event) => {
      const data = JSON.parse(event.data);

      if (data.type === 'progress') {
        const { percent, message } = data;
        progressBarFill.style.width = `${percent}%`;
        progressPercentText.textContent = `${percent}%`;
        progressStatus.textContent = message;

        let type = 'info';
        if (message.includes('success') || message.includes('complete')) type = 'success';
        else if (message.includes('Compiler') || message.includes('FFmpeg')) type = 'accent';

        writeLog(message, type);
      }
      else if (data.type === 'done') {
        const { videoUrl } = data;
        writeLog(`Success! Video rendered successfully. File available at ${videoUrl}`, 'success');

        progressBarFill.style.width = '100%';
        progressPercentText.textContent = '100%';
        progressStatus.textContent = 'Completed!';

        eventSource.close();

        // Update and show video preview
        setTimeout(() => {
          previewPlayer.src = videoUrl;
          downloadBtn.href = `/api/download/${jobId}.mp4`;
          previewPlayer.load();

          progressContainer.classList.add('hidden');
          videoPreviewContainer.classList.remove('hidden');

          submitBtn.disabled = false;
          submitBtn.querySelector('span').textContent = 'Render Video';
        }, 800);
      }
      else if (data.type === 'error') {
        const { message } = data;
        writeLog(`FATAL ERROR: ${message}`, 'error');
        progressStatus.textContent = 'Generation failed.';

        eventSource.close();
        submitBtn.disabled = false;
        submitBtn.querySelector('span').textContent = 'Render Video';
      }
    };

    eventSource.onerror = (err) => {
      console.error('EventSource connection lost:', err);
      writeLog('EventSource connection lost. Checking status...', 'error');
      eventSource.close();
      submitBtn.disabled = false;
      submitBtn.querySelector('span').textContent = 'Render Video';
    };
  }

  // 6. Console logger helper
  function writeLog(text, type = 'info') {
    const line = document.createElement('div');
    line.className = `console-line console-line-${type}`;

    const timestamp = new Date().toLocaleTimeString();
    line.textContent = `[${timestamp}] ${text}`;

    consoleLog.appendChild(line);
    // Auto-scroll console
    consoleLog.scrollTop = consoleLog.scrollHeight;
  }

  // 7. Reset page UI
  resetBtn.addEventListener('click', () => {
    // Clear video element
    previewSource.src = '';
    previewPlayer.load();

    // Clear file selection
    selectedFile = null;
    fileInput.value = '';
    fileInput.required = true;
    fileDetails.classList.add('hidden');
    dropzone.classList.remove('hidden');

    // Restore views
    videoPreviewContainer.classList.add('hidden');
    progressContainer.classList.add('hidden');
    previewPlaceholder.classList.remove('hidden');

    progressBarFill.style.width = '0%';
    progressPercentText.textContent = '0%';

    // Reset form values
    form.reset();
    customResGroup.classList.add('hidden');
    durationVal.textContent = '5.0s';
  });
});
