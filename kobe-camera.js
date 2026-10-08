(function () {
  let active = null;

  function setStatus(state, message, retry) {
    const status = document.getElementById(state.statusId);
    const button = document.getElementById(state.buttonId);
    if (status) status.textContent = message;
    if (button) {
      button.style.display = retry ? 'inline-block' : 'none';
      if (retry) button.textContent = retry;
    }
  }

  function stop() {
    if (!active) return;
    active.stopped = true;
    clearTimeout(active.timer);
    if (active.stream) active.stream.getTracks().forEach(track => track.stop());
    if (active.video) {
      active.video.srcObject = null;
      active.video.remove();
    }
    active = null;
  }

  async function start(options) {
    stop();
    const state = Object.assign({ timer: null, stream: null, video: null, canvas: null, detector: null, stopped: false }, options);
    active = state;
    const frame = document.getElementById(state.frameId);
    if (!frame) return setStatus(state, 'Camera area is unavailable.', 'Try again');
    if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return setStatus(state, 'Camera access requires HTTPS and a supported browser.', 'Try again');
    }

    setStatus(state, 'Requesting camera permission…', '');
    try {
      state.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false
      });
    } catch (error) {
      if (active !== state) return;
      const name = error && error.name;
      const message = name === 'NotAllowedError' || name === 'SecurityError'
        ? 'Camera permission was blocked. Allow camera access in your browser settings.'
        : name === 'NotFoundError' || name === 'OverconstrainedError'
          ? 'No usable camera was found on this device.'
          : name === 'NotReadableError'
            ? 'The camera is busy in another app. Close it and try again.'
            : 'Could not open the camera. Check browser permissions and try again.';
      return setStatus(state, message, 'Try again');
    }

    if (active !== state) {
      state.stream.getTracks().forEach(track => track.stop());
      return;
    }

    const video = document.createElement('video');
    video.setAttribute('playsinline', '');
    video.muted = true;
    video.autoplay = true;
    video.dataset.kobeCamera = 'true';
    video.style.cssText = 'display:block;width:100%;height:100%;object-fit:cover';
    frame.replaceChildren(video);
    state.video = video;
    video.srcObject = state.stream;
    try { await video.play(); } catch (error) {}

    if ('BarcodeDetector' in window) {
      try { state.detector = new BarcodeDetector({ formats: ['qr_code'] }); } catch (error) {}
    }
    if (!state.detector && typeof window.jsQR !== 'function') {
      setStatus(state, 'The QR reader did not load. Check your connection and retry.', 'Try again');
      return stop();
    }

    const button = document.getElementById(state.buttonId);
    if (button) button.style.display = 'none';
    setStatus(state, 'Point the camera at a QR code.', '');
    const tick = async () => {
      if (active !== state || state.stopped || !state.video) return;
      let value = '';
      try {
        if (video.readyState >= 2 && video.videoWidth) {
          if (state.detector) {
            const codes = await state.detector.detect(video);
            if (codes.length) value = codes[0].rawValue;
          } else {
            const scale = Math.min(1, 960 / video.videoWidth);
            const width = Math.round(video.videoWidth * scale);
            const height = Math.round(video.videoHeight * scale);
            if (!state.canvas) state.canvas = document.createElement('canvas');
            state.canvas.width = width;
            state.canvas.height = height;
            const context = state.canvas.getContext('2d', { willReadFrequently: true });
            context.drawImage(video, 0, 0, width, height);
            const result = window.jsQR(context.getImageData(0, 0, width, height).data, width, height, { inversionAttempts: 'dontInvert' });
            if (result) value = result.data;
          }
        }
      } catch (error) {}
      if (value) {
        stop();
        state.onCode(value);
        return;
      }
      state.timer = setTimeout(tick, 220);
    };
    tick();
  }

  window.KobeCamera = { start, stop };
  if (typeof KobeScanner !== 'undefined' && KobeScanner.current) KobeScanner.start(KobeScanner.current);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && active) {
      const state = active;
      stop();
      setStatus(state, 'Camera paused while the app is in the background. Tap to resume.', 'Resume camera');
    }
  });
  window.addEventListener('pagehide', stop);
})();