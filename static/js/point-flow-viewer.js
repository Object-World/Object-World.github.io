function decodeBytes(base64) {
  const binary = atob(base64), bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function unpackCoordinates(packed) {
  if (!packed) return [];
  const bytes = decodeBytes(packed.data), values = new Uint16Array(bytes.buffer);
  const frames = packed.shape[0], points = packed.shape[1], result = new Array(frames);
  let cursor = 0;
  for (let t = 0; t < frames; t++) {
    const frame = new Array(points);
    for (let i = 0; i < points; i++) frame[i] = [0,1,2].map(a => packed.offset[a] + values[cursor++] * packed.scale[a]);
    result[t] = frame;
  }
  return result;
}

function unpackColors(packed) {
  if (!packed) return [];
  const values = decodeBytes(packed.data), frames = packed.shape[0], points = packed.shape[1], result = new Array(frames);
  let cursor = 0;
  for (let t = 0; t < frames; t++) {
    const frame = new Array(points);
    for (let i = 0; i < points; i++) frame[i] = [values[cursor++], values[cursor++], values[cursor++]];
    result[t] = frame;
  }
  return result;
}

class PointFlowViewer {
  constructor(root) {
    this.root = root;
    this.canvas = root.querySelector("canvas");
    this.ctx = this.canvas.getContext("2d");
    this.select = root.querySelector("[data-scene]");
    this.gallery = document.querySelector(root.dataset.gallery || "[data-scene-gallery]");
    this.manifestUrl = root.dataset.manifest || "static/data/scene-manifest.json";
    this.slider = root.querySelector("[data-frame]");
    this.frameLabel = root.querySelector("[data-frame-label]");
    this.status = root.querySelector("[data-status]");
    this.video = root.querySelector("[data-source-video]");
    this.instruction = root.querySelector("[data-execution-instruction]");
    this.datasetDescription = root.querySelector("[data-dataset-description]");
    this.playButton = root.querySelector("[data-play]");
    this.sceneToggle = root.querySelector("[data-scene-toggle]");
    this.trailsToggle = root.querySelector("[data-trails-toggle]");
    this.data = null;
    this.manifest = [];
    this.frame = 0;
    this.timelineFrame = 0;
    this.timelineFrames = Number(root.dataset.timelineFrames) || 0;
    this.playing = true;
    this.yaw = 0;
    this.pitch = 0;
    this.zoom = 1;
    this.dragging = false;
    this.scrubbing = false;
    this.endHoldRemaining = null;
    this.lastTick = performance.now();
    this.loadController = null;
    this.bind();
    this.loadManifest();
  }

  bind() {
    this.select.addEventListener("change", () => this.loadScene(this.select.value));
    this.slider.addEventListener("pointerdown", () => {
      this.endHoldRemaining = null;
      this.scrubbing = true;
      if (this.video && this.data && this.data.syncPlayback) this.video.pause();
    });
    const finishScrub = () => {
      if (!this.scrubbing) return;
      this.scrubbing = false;
      this.lastTick = performance.now();
      if (this.playing && this.video && this.data && this.data.syncPlayback) {
        this.resumeVideo();
      }
    };
    window.addEventListener("pointerup", finishScrub);
    window.addEventListener("pointercancel", finishScrub);
    this.slider.addEventListener("input", () => {
      this.endHoldRemaining = null;
      this.setTimelineFrame(Number(this.slider.value));
      if (this.video && this.data && this.data.syncPlayback && this.video.duration) {
        this.video.currentTime = this.video.duration * this.timelineFrame / Math.max(this.timelineFrameCount() - 1, 1);
      }
      // Keyboard seeks do not produce pointerup; resume a held video here.
      if (!this.scrubbing && this.playing && this.video && this.data &&
          this.data.syncPlayback && this.video.paused) this.resumeVideo();
    });
    this.playButton.addEventListener("click", () => {
      this.playing = !this.playing;
      this.playButton.textContent = this.playing ? "Pause" : "Play";
      if (this.video && this.data && this.data.syncPlayback) {
        if (this.playing) {
          if (this.endHoldRemaining != null) this.endHoldLastTick = performance.now();
          else this.resumeVideo();
        } else this.video.pause();
      }
    });
    this.sceneToggle.addEventListener("change", () => this.draw());
    this.trailsToggle.addEventListener("change", () => this.draw());
    if (this.video) {
      this.video.addEventListener("loadedmetadata", () => {
        this.video.playbackRate = (this.data && this.data.playbackRate) || 1;
        this.draw();
        if (this.playing && this.data && this.data.syncPlayback) this.video.play().catch(() => {});
      });
      this.video.addEventListener("ended", () => {
        if (!this.data || !this.data.syncPlayback || !this.playing || this.scrubbing) return;
        this.holdAtEnd();
      });
    }
    this.canvas.addEventListener("pointerdown", event => {
      this.dragging = true; this.lastX = event.clientX; this.lastY = event.clientY;
      this.canvas.setPointerCapture(event.pointerId);
    });
    this.canvas.addEventListener("pointermove", event => {
      if (!this.dragging) return;
      this.yaw += (event.clientX - this.lastX) * 0.009;
      // Trackball convention: dragging upward tilts the view upward.
      this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch - (event.clientY - this.lastY) * 0.009));
      this.lastX = event.clientX; this.lastY = event.clientY; this.draw();
    });
    this.canvas.addEventListener("pointerup", () => { this.dragging = false; });
    this.canvas.addEventListener("wheel", event => {
      event.preventDefault();
      this.zoom = Math.max(0.45, Math.min(4, this.zoom * Math.exp(-event.deltaY * 0.001)));
      this.draw();
    }, {passive: false});
    this.root.querySelector("[data-reset]").addEventListener("click", () => {
      this.yaw = 0; this.pitch = 0; this.zoom = 1; this.draw();
    });
    new ResizeObserver(() => this.resize()).observe(this.canvas);
  }

  resumeVideo() {
    if (this.video.duration && this.video.currentTime >= this.video.duration) this.holdAtEnd();
    else this.video.play().catch(() => {});
  }

  timelineFrameCount() {
    return this.data.syncPlayback
      ? Math.max(this.data.flow.length, this.timelineFrames || 0)
      : this.data.flow.length;
  }

  setTimelineFrame(index) {
    this.timelineFrame = Math.max(0, Math.min(this.timelineFrameCount() - 1, Math.round(index)));
    // Flow finishes early on a longer execution timeline, then stays at its
    // final pose. Do not fabricate additional motion frames or repeat trails.
    this.frame = Math.min(this.timelineFrame, this.data.flow.length - 1);
    this.slider.value = this.timelineFrame;
    this.draw();
  }

  holdAtEnd() {
    this.video.pause();
    this.setTimelineFrame(this.timelineFrameCount() - 1);
    this.endHoldRemaining = Math.max(0, this.data.endHoldSeconds || 0) * 1000;
    this.endHoldLastTick = performance.now();
    if (this.endHoldRemaining === 0) this.restartVideo();
  }

  restartVideo() {
    this.endHoldRemaining = null;
    this.video.currentTime = 0;
    this.setTimelineFrame(0);
    if (this.playing && !this.scrubbing) this.video.play().catch(() => {});
  }

  async loadManifest() {
    try {
      const response = await fetch(this.manifestUrl, {cache: "no-store"});
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const manifest = await response.json();
      this.manifest = manifest.scenes;
      const groups = manifest.groups || {real: "REAL-WORLD", simulation: "SIMULATION"};
      for (const split of [...new Set(this.manifest.map(item => item.split))]) {
        const group = document.createElement("optgroup");
        const scenes = this.manifest.filter(item => item.split === split);
        group.label = `${groups[split] || split.toUpperCase()} · ${scenes.length} SCENES`;
        for (const scene of scenes) {
          const option = document.createElement("option");
          option.value = scene.id;
          option.textContent = `${scene.label} — ${scene.source}`;
          group.append(option);
        }
        this.select.append(group);
      }
      this.buildGallery();
      const requested = new URLSearchParams(window.location.search).get("scene");
      const initial = this.manifest.some(item => item.id === requested) ? requested : this.manifest[0].id;
      await this.loadScene(initial);
      requestAnimationFrame(time => this.animate(time));
    } catch (error) {
      this.status.textContent = "Unable to load interactive data. Serve this directory over HTTP to view it.";
      console.error(error);
    }
  }

  buildGallery() {
    if (!this.gallery) return;
    this.gallery.textContent = "";
    for (const scene of this.manifest) {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "scene-card";
      card.dataset.sceneId = scene.id;
      card.innerHTML = `<img src="${scene.thumbnail}" alt=""><span class="scene-card-copy"><b>${scene.description}</b><small>${scene.source}</small></span>`;
      card.addEventListener("click", async () => {
        this.root.scrollIntoView({behavior: "smooth", block: "center"});
        await this.loadScene(scene.id);
      });
      this.gallery.append(card);
    }
  }

  async loadScene(id) {
    const meta = this.manifest.find(item => item.id === id);
    if (!meta) return;
    this.endHoldRemaining = null;
    if (this.video) this.video.pause();
    if (this.loadController) this.loadController.abort();
    this.loadController = new AbortController();
    const signal = this.loadController.signal;
    this.select.value = id;
    this.status.textContent = "Loading point flow…";
    if (this.instruction) this.instruction.textContent = "";
    if (this.datasetDescription) this.datasetDescription.textContent = "";
    let response;
    try {
      response = await fetch(meta.file, {signal, cache: "no-store"});
      if (!response.ok) throw new Error(`Unable to load ${meta.file}`);
    this.data = await response.json();
    if (this.data.flowPacked) this.data.flow = unpackCoordinates(this.data.flowPacked);
    if (this.data.trackingFlowPacked) this.data.trackingFlow = unpackCoordinates(this.data.trackingFlowPacked);
    if (this.data.scenePacked) this.data.scene = unpackCoordinates(this.data.scenePacked);
    if (this.data.sceneColorsPacked) this.data.sceneColors = unpackColors(this.data.sceneColorsPacked);
    } catch (error) {
      if (error.name === "AbortError") return;
      this.status.textContent = "Unable to load this scene.";
      throw error;
    }
    if (this.gallery) this.gallery.querySelectorAll("[data-scene-id]").forEach(card => card.classList.toggle("active", card.dataset.sceneId === id));
    this.frame = 0;
    this.timelineFrame = 0;
    this.slider.max = this.timelineFrameCount() - 1;
    this.slider.value = 0;
    this.sceneToggle.disabled = !this.data.scene.length;
    this.sceneToggle.checked = Boolean(this.data.scene.length);
    if (this.video) {
      this.video.src = this.data.video || meta.video || "";
      this.video.hidden = !this.video.src;
      this.video.load();
    }
    if (this.instruction) this.instruction.textContent = meta.instruction || "";
    if (this.datasetDescription) {
      this.datasetDescription.textContent = meta.description || "";
    }
    this.fitData();
    this.status.innerHTML = `<strong>${this.data.description}</strong><span>${this.data.source}</span>`;
    this.draw();
  }

  fitData() {
    const first = this.data.flow[0];
    const all = this.data.scene.length ? first.concat(this.data.scene[0]) : first;
    this.center = [0, 1, 2].map(axis => {
      const values = first.map(point => point[axis]).sort((a, b) => a - b);
      return values[Math.floor(values.length / 2)];
    });
    const distances = all.map(point => Math.hypot(point[0] - this.center[0], point[1] - this.center[1], point[2] - this.center[2])).sort((a,b) => a-b);
    this.radius = Math.max(distances[Math.floor(distances.length * 0.97)] || 1, 0.05);
    this.baseCamera = this.data.cameras && this.data.cameras.length ? this.data.cameras[0] : null;
    this.flowCenters = this.data.flow.map(frame => [0, 1, 2].map(axis => {
      const values = frame.map(point => point[axis]).sort((a, b) => a - b);
      return values[Math.floor(values.length / 2)];
    }));
    this.yaw = 0; this.pitch = 0; this.zoom = 1;
  }

  rotate(point, isFlow = false, flowFrame = this.frame) {
    const x = point[0] - this.center[0], y = point[1] - this.center[1], z = point[2] - this.center[2];
    const cameraYSign = this.data.cameraYSign || -1;
    let bx = x, by = cameraYSign * y, bz = z;
    if (this.baseCamera) {
      const r = this.baseCamera;
      // camera-to-world inverse rotation: the default view matches frame 0.
      bx = r[0][0] * x + r[1][0] * y + r[2][0] * z;
      by = cameraYSign * (r[0][1] * x + r[1][1] * y + r[2][1] * z);
      bz = r[0][2] * x + r[1][2] * y + r[2][2] * z;
    }
    if (isFlow && this.data.flowViewSigns && this.flowCenters) {
      const fc = this.flowCenters[Math.min(flowFrame, this.flowCenters.length - 1)];
      const fx = fc[0] - this.center[0], fy = fc[1] - this.center[1], fz = fc[2] - this.center[2];
      let cbx = fx, cby = cameraYSign * fy;
      if (this.baseCamera) {
        const r = this.baseCamera;
        cbx = r[0][0] * fx + r[1][0] * fy + r[2][0] * fz;
        cby = cameraYSign * (r[0][1] * fx + r[1][1] * fy + r[2][1] * fz);
      }
      bx = cbx + (bx - cbx) * this.data.flowViewSigns[0];
      by = cby + (by - cby) * this.data.flowViewSigns[1];
    }
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw), cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const x1 = cy * bx - sy * bz, z1 = sy * bx + cy * bz;
    return [x1, cp * by - sp * z1, sp * by + cp * z1];
  }

  project(point, isFlow = false, flowFrame = this.frame) {
    const p = this.rotate(point, isFlow, flowFrame);
    const scale = this.zoom * Math.min(this.canvas.clientWidth, this.canvas.clientHeight) / (this.radius * 2.35);
    return [this.canvas.clientWidth * 0.5 + p[0] * scale, this.canvas.clientHeight * 0.51 - p[1] * scale, p[2]];
  }

  resize() {
    const ratio = window.devicePixelRatio || 1;
    const width = Math.max(1, this.canvas.clientWidth), height = Math.max(1, this.canvas.clientHeight);
    this.canvas.width = Math.floor(width * ratio); this.canvas.height = Math.floor(height * ratio);
    this.ctx.setTransform(ratio, 0, 0, ratio, 0, 0); this.draw();
  }

  drawGrid() {
    const ctx = this.ctx, span = this.radius * 1.25, z = this.center[2] - this.radius * 0.72;
    ctx.strokeStyle = "rgba(166, 196, 216, .12)"; ctx.lineWidth = 1;
    for (let i = -5; i <= 5; i++) {
      const a = this.project([this.center[0] - span, this.center[1] + i * span / 5, z]);
      const b = this.project([this.center[0] + span, this.center[1] + i * span / 5, z]);
      const c = this.project([this.center[0] + i * span / 5, this.center[1] - span, z]);
      const d = this.project([this.center[0] + i * span / 5, this.center[1] + span, z]);
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(c[0], c[1]); ctx.lineTo(d[0], d[1]); ctx.stroke();
    }
  }

  drawPoints(points, color, size, opacity = 1, isFlow = false, flowFrame = this.frame) {
    // Camera +Z points away from the viewer: draw far points first. Keep the
    // original index through sorting so each point retains its first-frame RGB.
    const projected = points.map((point, index) => ({p: this.project(point, isFlow, flowFrame), index})).sort((a,b) => b.p[2] - a.p[2]);
    this.ctx.globalAlpha = opacity;
    for (const item of projected) {
      this.ctx.fillStyle = typeof color === "function" ? color(item.index) : color;
      this.ctx.beginPath(); this.ctx.arc(item.p[0], item.p[1], size, 0, Math.PI * 2); this.ctx.fill();
    }
    this.ctx.globalAlpha = 1;
  }

  drawTrails() {
    const trajectories = this.data.trackingFlow || this.data.flow;
    const sourceCount = Math.min(this.data.trackingSourceCount || trajectories[0].length, trajectories[0].length);
    const ctx = this.ctx, stride = Math.max(1, Math.floor(sourceCount / 64));
    const oldColor = [236, 152, 217], currentColor = [149, 206, 225];
    ctx.lineWidth = 1.45;
    for (let pointIndex = 0; pointIndex < sourceCount; pointIndex += stride) {
      for (let t = 1; t <= this.frame; t++) {
        const a = this.project(trajectories[t - 1][pointIndex], true, t - 1);
        const b = this.project(trajectories[t][pointIndex], true, t);
        const colorAt = index => {
          const u = index / Math.max(this.frame, 1);
          return `rgba(${Math.round(oldColor[0] + (currentColor[0] - oldColor[0]) * u)},${Math.round(oldColor[1] + (currentColor[1] - oldColor[1]) * u)},${Math.round(oldColor[2] + (currentColor[2] - oldColor[2]) * u)},1)`;
        };
        const gradient = ctx.createLinearGradient(a[0], a[1], b[0], b[1]);
        gradient.addColorStop(0, colorAt(t - 1));
        gradient.addColorStop(1, colorAt(t));
        ctx.strokeStyle = gradient;
        ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
      }
    }
  }

  drawCamera() {
    if (!this.data.cameras || !this.data.cameras.length) return;
    const matrix = this.data.cameras[Math.min(this.frame, this.data.cameras.length - 1)];
    const origin = [matrix[0][3], matrix[1][3], matrix[2][3]];
    const scale = this.radius * .12;
    const corners = [[-.75,-.5,1],[.75,-.5,1],[.75,.5,1],[-.75,.5,1]].map(v => [
      origin[0] + scale * (matrix[0][0]*v[0] + matrix[0][1]*v[1] + matrix[0][2]*v[2]),
      origin[1] + scale * (matrix[1][0]*v[0] + matrix[1][1]*v[1] + matrix[1][2]*v[2]),
      origin[2] + scale * (matrix[2][0]*v[0] + matrix[2][1]*v[1] + matrix[2][2]*v[2])]);
    const projectedOrigin = this.project(origin), projected = corners.map(p => this.project(p));
    const ctx = this.ctx; ctx.strokeStyle = "rgba(255,190,96,.95)"; ctx.lineWidth = 1.5;
    for (const p of projected) { ctx.beginPath(); ctx.moveTo(projectedOrigin[0], projectedOrigin[1]); ctx.lineTo(p[0], p[1]); ctx.stroke(); }
    ctx.beginPath(); projected.forEach((p,i) => i ? ctx.lineTo(p[0],p[1]) : ctx.moveTo(p[0],p[1])); ctx.closePath(); ctx.stroke();
    ctx.fillStyle = "#ffbe60"; ctx.beginPath(); ctx.arc(projectedOrigin[0], projectedOrigin[1], 3.5, 0, Math.PI*2); ctx.fill();
  }

  draw() {
    if (!this.data) return;
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.canvas.clientWidth, this.canvas.clientHeight);
    this.drawGrid();
    if (this.sceneToggle.checked && this.data.scene.length) {
      const sceneFrame = this.data.scene[Math.min(this.frame, this.data.scene.length - 1)];
      const colorFrame = this.data.sceneColors[Math.min(this.frame, this.data.sceneColors.length - 1)] || [];
      this.drawPoints(sceneFrame, index => {
      const color = colorFrame[index] || [150,160,165];
      return `rgb(${color[0]},${color[1]},${color[2]})`;
      }, 1.2, 0.72);
    }
    if (this.trailsToggle.checked) this.drawTrails();
    const currentFlow = this.data.flow[this.frame];
    const surfaceFlow = currentFlow;
    if (this.data.objectColors && this.data.objectColors.length) {
      const objectRadius = this.data.objectPointRadius || 2.35;
      // A subtle under-splat closes screen-space pinholes without inventing
      // geometry; the visible surface still consists of the 8,192 RGB points.
      if (this.data.objectHalo !== false) {
        this.drawPoints(surfaceFlow, "rgba(120,135,140,.34)", objectRadius + .65, .7, true, this.frame);
      }
      this.drawPoints(surfaceFlow, index => {
        const color = this.data.objectColors[index] || [190, 190, 190];
        return `rgb(${color[0]},${color[1]},${color[2]})`;
      }, objectRadius, 1, true, this.frame);
    }
    // Only the same sparse points used by the trails receive blue markers.
    const objectColor = "rgb(149,206,225)";
    const currentTracking = this.data.trackingFlow ? this.data.trackingFlow[this.frame] : currentFlow;
    const trackingSourceCount = Math.min(this.data.trackingSourceCount || currentTracking.length, currentTracking.length);
    const trackingStride = Math.max(1, Math.floor(trackingSourceCount / 64));
    const trackingPoints = currentTracking.slice(0, trackingSourceCount).filter((_, index) => index % trackingStride === 0);
    this.drawPoints(trackingPoints, objectColor, 2.35, 1, true, this.frame);
    this.drawCamera();
    const timelineFrame = this.timelineFrame == null ? this.frame : this.timelineFrame;
    this.frameLabel.textContent = `${String(timelineFrame + 1).padStart(2, "0")} / ${String(this.timelineFrameCount()).padStart(2, "0")}`;
    this.frameLabel.title = `Flow frame ${this.frame + 1} / ${this.data.flow.length}`;
    if (this.video && this.video.duration && Number.isFinite(this.video.duration) &&
        !this.data.syncPlayback) {
      const target = this.video.duration * this.frame / Math.max(this.data.flow.length - 1, 1);
      if (Math.abs(this.video.currentTime - target) > 0.06) this.video.currentTime = target;
    }
  }

  animate(now) {
    if (this.endHoldRemaining != null) {
      const elapsed = Math.max(0, now - this.endHoldLastTick);
      this.endHoldLastTick = now;
      if (this.playing && !this.scrubbing) {
        this.endHoldRemaining -= elapsed;
        if (this.endHoldRemaining <= 0) this.restartVideo();
      }
    } else if (!this.scrubbing && this.playing && this.data && this.data.syncPlayback && this.video && this.video.duration && !this.video.paused && !this.video.seeking) {
      const nextFrame = Math.min(this.timelineFrameCount() - 1,
        Math.round(this.video.currentTime / this.video.duration * (this.timelineFrameCount() - 1)));
      if (nextFrame !== this.timelineFrame) this.setTimelineFrame(nextFrame);
    } else if (!this.scrubbing && this.playing && this.data && !this.data.syncPlayback && now - this.lastTick > 75) {
      this.lastTick = now;
      this.setTimelineFrame((this.frame + 1) % this.data.flow.length);
    }
    requestAnimationFrame(time => this.animate(time));
  }
}

document.querySelectorAll("[data-point-flow-viewer]").forEach(root => new PointFlowViewer(root));
