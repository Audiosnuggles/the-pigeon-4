/**
 * THE PIGEON - Flat Design FX Rack & Audio Engine Update
 */

let patternBanks = { A: [null, null, null, null], B: [null, null, null, null], C: [null, null, null, null] };
let isSaveMode = false;
let queuedPattern = null;
let activeNodes = []; 

const chordIntervals = { major: [0, 4, 7], minor: [0, 3, 7], diminished: [0, 3, 6], augmented: [0, 4, 8], sus2: [0, 2, 7], sus4: [0, 5, 7] };
const chordColors = ['#FF5733', '#33FF57', '#3357FF'];

function getDistortionCurve() {
  const n = 22050, curve = new Float32Array(n), amount = 80;
  for (let i = 0; i < n; ++i) { let x = i * 2 / n - 1; curve[i] = (3 + amount) * x * 20 * (Math.PI / 180) / (Math.PI + amount * Math.abs(x)); }
  return curve;
}

// --- BRUSH LOGIC ---
function drawSegmentStandard(ctx, pts, idx1, idx2, size) { ctx.lineWidth = size; ctx.lineCap = "round"; ctx.beginPath(); ctx.moveTo(pts[idx1].x, pts[idx1].y); ctx.lineTo(pts[idx2].x, pts[idx2].y); ctx.stroke(); }
function drawSegmentVariable(ctx, pts, idx1, idx2, size) { const dist = Math.hypot(pts[idx2].x - pts[idx1].x, pts[idx2].y - pts[idx1].y); ctx.lineWidth = size * (1 + Math.max(0, (10 - dist) / 5)); ctx.lineCap = "round"; ctx.beginPath(); ctx.moveTo(pts[idx1].x, pts[idx1].y); ctx.lineTo(pts[idx2].x, pts[idx2].y); ctx.stroke(); }
function drawSegmentCalligraphy(ctx, pts, idx1, idx2, size) { const angle = -Math.PI / 4, dx = Math.cos(angle) * size, dy = Math.sin(angle) * size; ctx.fillStyle = "#000"; ctx.beginPath(); ctx.moveTo(pts[idx1].x - dx, pts[idx1].y - dy); ctx.lineTo(pts[idx1].x + dx, pts[idx1].y + dy); ctx.lineTo(pts[idx2].x + dx, pts[idx2].y + dy); ctx.lineTo(pts[idx2].x - dx, pts[idx2].y - dy); ctx.fill(); }
function drawSegmentParticles(ctx, pts, idx1, idx2, size) { ctx.fillStyle = "rgba(0,0,0,0.6)"; for(let i=0; i<2; i++) { const ox = (Math.random()-0.5)*size*2, oy = (Math.random()-0.5)*size*2; ctx.beginPath(); ctx.arc(pts[idx2].x+ox, pts[idx2].y+oy, Math.max(1, size/3), 0, Math.PI*2); ctx.fill(); } }
function drawSegmentFractal(ctx, pts, idx1, idx2, size) { ctx.lineWidth = size; ctx.lineCap = "round"; ctx.beginPath(); ctx.moveTo(pts[idx1].x + (pts[idx1].jX||0), pts[idx1].y + (pts[idx1].jY||0)); ctx.lineTo(pts[idx2].x + (pts[idx2].jX||0), pts[idx2].y + (pts[idx2].jY||0)); ctx.stroke(); }

document.addEventListener("DOMContentLoaded", function() {
  
  let audioCtx, masterGain, analyser, isPlaying=false;
  let playbackStartTime=0, playbackDuration=0, animationFrameId;
  let undoStack=[], liveNodes=[], liveGainNode=null, liveFilterNode=null;
  let dataArray, lastAvg = 0;

  // --- FX ENGINE VARIABLES ---
  let fxNodes = {
      delay: { in: null, node: null, feedback: null, time: 0.4, fdbk: 0.5 },
      reverb: { in: null, node: null, mix: null, decay: 0.5, mixVal: 0.3 },
      vibrato: { in: null, node: null, lfo: null, depthNode: null, rate: 5, depth: 0.002 }
  };
  // Send-Gains per Track per Effect [trackIdx][fxName]
  let trackSends = [{}, {}, {}, {}];

  const toolSelect = document.getElementById("toolSelect"), brushSelect = document.getElementById("brushSelect"), sizeSlider = document.getElementById("brushSizeSlider"), chordSelect = document.getElementById("chordSelect"), harmonizeCheckbox = document.getElementById("harmonizeCheckbox"), pigeonImg = document.getElementById("pigeon");
  const tracks = Array.from(document.querySelectorAll(".track-container")).map((c, i) => ({ index: i, canvas: c.querySelector("canvas"), ctx: c.querySelector("canvas").getContext("2d"), segments: [], wave: "sine", mute: false, vol: 0.8, snap: false, gainNode: null }));

  // STORAGE & UI INIT
  const savedBanks = localStorage.getItem("pigeonBanks");
  if (savedBanks) { try { patternBanks = JSON.parse(savedBanks); updatePadUI(); } catch(e) { localStorage.removeItem("pigeonBanks"); loadDefaultSet(); } } else { loadDefaultSet(); }

  function loadDefaultSet() { fetch('default_set.json').then(res => res.json()).then(data => { if(data.banks) { patternBanks = data.banks; updatePadUI(); } if(data.current) loadPatternData(data.current); }).catch(err => console.log("Kein default_set.json")); }
  function updatePadUI() { document.querySelectorAll(".pad").forEach(pad => { const b = pad.dataset.bank, i = parseInt(pad.dataset.idx); pad.classList.toggle("filled", !!(patternBanks[b] && patternBanks[b][i])); }); }

  document.getElementById("saveModeBtn").addEventListener("click", (e) => { isSaveMode = !isSaveMode; e.target.classList.toggle("active", isSaveMode); });

  document.querySelectorAll(".pad").forEach(pad => {
    pad.addEventListener("click", () => {
      const b = pad.dataset.bank, i = parseInt(pad.dataset.idx);
      if (isSaveMode) {
        const state = { settings: { bpm: document.getElementById("bpmInput").value, loop: document.getElementById("loopCheckbox").checked, scale: document.getElementById("scaleSelect").value, harmonize: document.getElementById("harmonizeCheckbox").checked }, tracks: tracks.map(t => ({ segments: t.segments, vol: t.vol, mute: t.mute, wave: t.wave, snap: t.snap })) };
        patternBanks[b][i] = JSON.parse(JSON.stringify(state));
        localStorage.setItem("pigeonBanks", JSON.stringify(patternBanks)); 
        isSaveMode = false; document.getElementById("saveModeBtn").classList.remove("active"); updatePadUI();
        document.querySelectorAll(".pad").forEach(p => p.classList.remove("active", "queued")); pad.classList.add("active");
      } else if (patternBanks[b] && patternBanks[b][i]) {
        if (isPlaying) { queuedPattern = { data: patternBanks[b][i], pad: pad }; document.querySelectorAll(".pad").forEach(p => p.classList.remove("queued")); pad.classList.add("queued"); }
        else { loadPatternData(patternBanks[b][i]); document.querySelectorAll(".pad").forEach(p => { p.classList.remove("active"); p.classList.remove("queued"); }); pad.classList.add("active"); }
      }
    });
  });

  function loadPatternData(d) {
    if(d.settings) { 
        document.getElementById("bpmInput").value = d.settings.bpm; 
        document.getElementById("loopCheckbox").checked = d.settings.loop; 
        document.getElementById("scaleSelect").value = d.settings.scale; 
        document.getElementById("harmonizeCheckbox").checked = d.settings.harmonize; 
        document.getElementById("scaleSelectContainer").style.display = d.settings.harmonize ? "inline" : "none";
        const bpmVal = parseFloat(d.settings.bpm) || 120;
        playbackDuration = (60 / bpmVal) * 32;
    }
    const tData = d.tracks || d;
    if(Array.isArray(tData)) {
      tData.forEach((td, idx) => {
        if(!tracks[idx]) return; let t = tracks[idx];
        t.segments = JSON.parse(JSON.stringify(td.segments || td || [])); 
        if(!Array.isArray(td)) { t.vol = td.vol ?? 0.8; t.mute = td.mute ?? false; t.wave = td.wave ?? "sine"; t.snap = td.snap ?? false; }
        const cont = t.canvas.parentElement; cont.querySelector(".volume-slider").value = t.vol; cont.querySelector(".mute-btn").style.backgroundColor = t.mute ? "#ff4444" : ""; cont.querySelector(".snap-checkbox").checked = t.snap;
        cont.querySelectorAll(".wave-btn").forEach(btn => btn.classList.toggle("active", btn.dataset.wave === t.wave));
        redrawTrack(t);
      });
    }
  }

  harmonizeCheckbox.addEventListener("change", () => {
    document.getElementById("scaleSelectContainer").style.display = harmonizeCheckbox.checked ? "inline" : "none";
  });

  let isEraserMode = false;
  const customEraser = document.getElementById("custom-eraser");

  toolSelect.addEventListener("change", (e) => {
    isEraserMode = e.target.value === "erase";
    document.body.classList.toggle("eraser-mode", isEraserMode);
  });

  window.addEventListener("mousemove", (e) => {
    if (isEraserMode && customEraser) { customEraser.style.left = e.clientX + "px"; customEraser.style.top = e.clientY + "px"; }
  });

  tracks.forEach(track => {
    drawGrid(track);
    const cont = track.canvas.parentElement;
    cont.querySelectorAll(".wave-btn").forEach(b => b.addEventListener("click", () => { track.wave = b.dataset.wave; cont.querySelectorAll(".wave-btn").forEach(btn => btn.classList.remove("active")); b.classList.add("active"); }));
    cont.querySelector(".mute-btn").addEventListener("click", e => { track.mute = !track.mute; e.target.style.backgroundColor = track.mute ? "#ff4444" : ""; updateTrackVolume(track); });
    cont.querySelector(".volume-slider").addEventListener("input", e => { track.vol = parseFloat(e.target.value); updateTrackVolume(track); });
    cont.querySelector(".snap-checkbox").addEventListener("change", e => track.snap = e.target.checked);

    let drawing = false, curSeg = null;
    const start = e => {
      e.preventDefault(); if(!audioCtx) initAudio(); if(audioCtx.state === "suspended") audioCtx.resume();
      const pos = getPos(e, track.canvas); const x = track.snap ? snap(pos.x, track.canvas.width) : pos.x;
      if(toolSelect.value === "draw") {
        drawing = true; let jX=0, jY=0; if(brushSelect.value==="fractal"){ jX=Math.random()*20-10; jY=Math.random()*40-20; }
        curSeg = { points: [{x, y:pos.y, jX, jY}], brush: brushSelect.value, thickness: parseInt(sizeSlider.value), chordType: chordSelect.value };
        track.segments.push(curSeg); redrawTrack(track);
        if(brushSelect.value === "particles") triggerParticleGrain(track, pos.y); else startLiveSynth(track, pos.y);
      } else erase(track, x, pos.y);
    };
    const move = e => {
      if(!drawing && toolSelect.value!=="erase") return; e.preventDefault();
      const pos = getPos(e, track.canvas); const x = track.snap ? snap(pos.x, track.canvas.width) : pos.x;
      if(drawing) {
        let jX=0, jY=0; if(brushSelect.value==="fractal"){ jX=Math.random()*20-10; jY=Math.random()*40-20; }
        curSeg.points.push({x, y:pos.y, jX, jY}); redrawTrack(track); 
        if(brushSelect.value === "particles") triggerParticleGrain(track, pos.y);
        else updateLiveSynth(track, pos.y+jY);
      } else if(toolSelect.value==="erase" && (e.buttons===1 || e.type==="touchmove")) erase(track, x, pos.y);
    };
    const stopDraw = () => { 
      if(drawing) { 
        if(curSeg && curSeg.points.length === 1) curSeg.points.push({x: curSeg.points[0].x + 0.5, y: curSeg.points[0].y, jX: curSeg.points[0].jX, jY: curSeg.points[0].jY});
        undoStack.push({trackIdx:track.index, segment:curSeg}); stopLiveSynth(); redrawTrack(track);
      } 
      drawing = false; 
    };
    
    track.canvas.addEventListener("mousedown", start); track.canvas.addEventListener("mousemove", move); track.canvas.addEventListener("mouseup", stopDraw); track.canvas.addEventListener("mouseleave", stopDraw);
    track.canvas.addEventListener("touchstart", start, {passive:false}); track.canvas.addEventListener("touchmove", move, {passive:false}); track.canvas.addEventListener("touchend", stopDraw);
  });

  // ==========================================
  // --- AUDIO ENGINE & VINTAGE FX ---
  // ==========================================
  function generateReverbIR(ctx, duration) {
      const sampleRate = ctx.sampleRate; const length = sampleRate * duration;
      const impulse = ctx.createBuffer(2, length, sampleRate);
      const left = impulse.getChannelData(0); const right = impulse.getChannelData(1);
      for (let i = 0; i < length; i++) {
          const decay = Math.exp(-i / (sampleRate * (duration/3))); // Exponential decay
          left[i] = (Math.random() * 2 - 1) * decay;
          right[i] = (Math.random() * 2 - 1) * decay;
      }
      return impulse;
  }

  function initAudio() { 
    if(audioCtx) return; audioCtx = new (window.AudioContext || window.webkitAudioContext)(); 
    masterGain = audioCtx.createGain(); masterGain.gain.value = 0.5; 
    analyser = audioCtx.createAnalyser(); analyser.fftSize = 64; 
    dataArray = new Uint8Array(analyser.frequencyBinCount); 
    const compressor = audioCtx.createDynamicsCompressor(); 
    masterGain.connect(compressor).connect(analyser).connect(audioCtx.destination); 

    // Initialize FX Busses
    // 1. TAPE DELAY
    fxNodes.delay.in = audioCtx.createGain();
    fxNodes.delay.node = audioCtx.createDelay();
    fxNodes.delay.feedback = audioCtx.createGain();
    fxNodes.delay.node.delayTime.value = fxNodes.delay.time;
    fxNodes.delay.feedback.gain.value = fxNodes.delay.fdbk;
    fxNodes.delay.in.connect(fxNodes.delay.node);
    fxNodes.delay.node.connect(fxNodes.delay.feedback);
    fxNodes.delay.feedback.connect(fxNodes.delay.node);
    fxNodes.delay.node.connect(masterGain);

    // 2. SPRING REVERB
    fxNodes.reverb.in = audioCtx.createGain();
    fxNodes.reverb.node = audioCtx.createConvolver();
    fxNodes.reverb.node.buffer = generateReverbIR(audioCtx, 2.0); // 2 Sek IR
    fxNodes.reverb.mix = audioCtx.createGain();
    fxNodes.reverb.mix.gain.value = fxNodes.reverb.mixVal;
    fxNodes.reverb.in.connect(fxNodes.reverb.node);
    fxNodes.reverb.node.connect(fxNodes.reverb.mix);
    fxNodes.reverb.mix.connect(masterGain);

    // 3. VIBRATO
    fxNodes.vibrato.in = audioCtx.createGain();
    fxNodes.vibrato.node = audioCtx.createDelay();
    fxNodes.vibrato.node.delayTime.value = 0.005; // Base delay
    fxNodes.vibrato.lfo = audioCtx.createOscillator();
    fxNodes.vibrato.depthNode = audioCtx.createGain();
    fxNodes.vibrato.lfo.frequency.value = fxNodes.vibrato.rate;
    fxNodes.vibrato.depthNode.gain.value = fxNodes.vibrato.depth;
    fxNodes.vibrato.lfo.connect(fxNodes.vibrato.depthNode);
    fxNodes.vibrato.depthNode.connect(fxNodes.vibrato.node.delayTime);
    fxNodes.vibrato.lfo.start();
    fxNodes.vibrato.in.connect(fxNodes.vibrato.node);
    fxNodes.vibrato.node.connect(masterGain);

    // Set Send Gains per track to 0 initially
    tracks.forEach((t, i) => {
        ['delay', 'reverb', 'vibrato'].forEach(fx => {
            let send = audioCtx.createGain();
            send.gain.value = 0;
            send.connect(fxNodes[fx].in);
            trackSends[i][fx] = send;
        });
    });
    updateRoutingFromUI(); // Lade Initiale Matrix Werte
  }
  
  function connectTrackToFX(trackGainNode, trackIndex) {
      if(!trackGainNode || !audioCtx) return;
      ['delay', 'reverb', 'vibrato'].forEach(fx => {
          trackGainNode.connect(trackSends[trackIndex][fx]);
      });
  }

  function startLiveSynth(track, y) { 
    if(track.mute || track.vol < 0.01) return; 
    liveNodes = []; liveGainNode = audioCtx.createGain(); 
    liveGainNode.gain.setValueAtTime(0, audioCtx.currentTime); 
    liveGainNode.gain.linearRampToValueAtTime(0.3, audioCtx.currentTime+0.01); 

    liveFilterNode = audioCtx.createBiquadFilter(); 
    liveFilterNode.type = "lowpass"; liveFilterNode.Q.value = 10; liveFilterNode.frequency.value = 20000;

    let freq = mapY(y, track.canvas.height); if(harmonizeCheckbox.checked) freq = quantize(freq); 
    const ivs = (brushSelect.value==="chord") ? chordIntervals[chordSelect.value] : [0]; 
    ivs.forEach(iv => { 
        const osc = audioCtx.createOscillator(); osc.type = track.wave; 
        osc.frequency.setValueAtTime(freq * Math.pow(2, iv/12), audioCtx.currentTime); 
        if(brushSelect.value === "fractal") {
            const sh = audioCtx.createWaveShaper(); sh.curve = getDistortionCurve();
            osc.connect(sh).connect(liveGainNode);
        } else { osc.connect(liveGainNode); }
        osc.start(); liveNodes.push(osc); 
    }); 
    const trackG = audioCtx.createGain(); trackG.gain.value = track.vol;
    liveGainNode.connect(liveFilterNode).connect(trackG).connect(masterGain); 
    connectTrackToFX(trackG, track.index); // NEU: LIVE SIGNAL IN FX ROUTEN
    liveGainNode.out = trackG;
  }

  function updateLiveSynth(track, y) { if(!liveGainNode) return; let freq = mapY(y, track.canvas.height); if(harmonizeCheckbox.checked) freq = quantize(freq); liveNodes.forEach((n, i) => { const ivs = (brushSelect.value==="chord") ? chordIntervals[chordSelect.value] : [0]; n.frequency.setTargetAtTime(freq * Math.pow(2, (ivs[i]||0)/12), audioCtx.currentTime, 0.02); }); }
  
  function stopLiveSynth() { 
    if(!liveGainNode) return; const gn = liveGainNode, ns = liveNodes; const isChord = (brushSelect.value === "chord");
    gn.gain.setTargetAtTime(0, audioCtx.currentTime, isChord ? 0.005 : 0.05); 
    setTimeout(() => { ns.forEach(n=>n.stop()); if(gn.out) gn.out.disconnect(); if(liveFilterNode) liveFilterNode.disconnect(); gn.disconnect(); }, 100); 
    liveNodes = []; liveGainNode = null; liveFilterNode = null;
  }
  
  function triggerParticleGrain(track, y) { 
    if(track.mute || track.vol < 0.01) return; 
    let freq = mapY(y, track.canvas.height); if(harmonizeCheckbox.checked) freq = quantize(freq); 
    const osc = audioCtx.createOscillator(); osc.type = track.wave; osc.frequency.value = freq; 
    const env = audioCtx.createGain(); const now = audioCtx.currentTime;
    env.gain.setValueAtTime(0, now); env.gain.linearRampToValueAtTime(0.4, now + 0.01); env.gain.exponentialRampToValueAtTime(0.01, now + 0.15); 
    const trackG = audioCtx.createGain(); trackG.gain.value = track.vol;
    osc.connect(env).connect(trackG).connect(masterGain); 
    connectTrackToFX(trackG, track.index);
    osc.start(now); osc.stop(now + 0.2); 
    activeNodes.push(osc);
  }

  function scheduleTracks(start, targetCtx = audioCtx, targetDest = masterGain) {
    tracks.forEach(track => {
      const trkG = targetCtx.createGain(); trkG.connect(targetDest); trkG.gain.value = track.mute ? 0 : track.vol;
      if (targetCtx === audioCtx) { track.gainNode = trkG; connectTrackToFX(trkG, track.index); }

      track.segments.forEach(seg => {
        const brush = seg.brush || "standard";
        if(brush==="particles") { 
          seg.points.forEach(p => { 
            const t = Math.max(0, start + (p.x/track.canvas.width)*playbackDuration); 
            const osc = targetCtx.createOscillator(); osc.type = track.wave; 
            let f = mapY(p.y, 100); if(harmonizeCheckbox.checked) f = quantize(f); osc.frequency.value = f;
            const env = targetCtx.createGain(); env.gain.setValueAtTime(0, t); env.gain.linearRampToValueAtTime(0.4, t+0.01); env.gain.exponentialRampToValueAtTime(0.01, t+0.15); 
            osc.connect(env).connect(trkG); osc.start(t); osc.stop(t+0.2); 
            if (targetCtx === audioCtx) activeNodes.push(osc); 
          }); return; 
        }
        const sorted = seg.points.slice().sort((a,b)=>a.x-b.x); if(sorted.length<2) return;
        let sT = Math.max(0, start + (sorted[0].x/track.canvas.width)*playbackDuration), eT = Math.max(0, start + (sorted[sorted.length-1].x/track.canvas.width)*playbackDuration);
        if(brush==="chord") { 
          chordIntervals[seg.chordType||"major"].forEach(iv => { 
            const osc = targetCtx.createOscillator(); osc.type=track.wave; const g=targetCtx.createGain(); g.gain.setValueAtTime(0, sT); g.gain.linearRampToValueAtTime(0.2, sT+0.005); g.gain.setValueAtTime(0.2, eT); g.gain.linearRampToValueAtTime(0, eT+0.05); 
            osc.connect(g).connect(trkG); sorted.forEach(p=>{ const t = Math.max(0, start + (p.x/track.canvas.width)*playbackDuration); let f = mapY(p.y, 100); if(harmonizeCheckbox.checked) f = quantize(f); osc.frequency.linearRampToValueAtTime(f * Math.pow(2, iv/12), t); }); 
            osc.start(sT); osc.stop(eT+0.1); 
            if (targetCtx === audioCtx) activeNodes.push(osc); 
          }); return; 
        }
        const osc = targetCtx.createOscillator(); osc.type=track.wave; const g=targetCtx.createGain(); g.gain.setValueAtTime(0, sT); g.gain.linearRampToValueAtTime(0.3, sT+0.02); g.gain.setValueAtTime(0.3, eT); g.gain.linearRampToValueAtTime(0, eT+0.1); if(brush==="fractal"){ const sh = targetCtx.createWaveShaper(); sh.curve=getDistortionCurve(); osc.connect(sh).connect(g); } else { osc.connect(g); } g.connect(trkG); sorted.forEach(p=>{ const t = Math.max(0, start + (p.x/track.canvas.width)*playbackDuration); let f = mapY(p.y, 100); if(harmonizeCheckbox.checked) f = quantize(f); osc.frequency.linearRampToValueAtTime(f, t); }); 
        osc.start(sT); osc.stop(eT+0.2); 
        if (targetCtx === audioCtx) activeNodes.push(osc); 
      });
    });
  }

  // ==========================================
  // --- TRACE PAD & FX XY LINK LOGIC ---
  // ==========================================
  let isTracing = false, traceCurrentSeg = null, currentTargetTrack = 0, traceCurrentY = 50; 
  const tracePad = document.getElementById("trace-pad");

  // Read which FX has XY Link Active
  function getLinkedFX() {
      const links = document.querySelectorAll('.fx-xy-link.active');
      let linked = [];
      links.forEach(l => {
          const title = l.closest('.fx-unit').querySelector('.fx-header').innerText;
          if(title.includes("DELAY")) linked.push("delay");
          if(title.includes("REVERB")) linked.push("reverb");
          if(title.includes("VIBRATO")) linked.push("vibrato");
      });
      return linked;
  }

  function loop() {
    if(!isPlaying) return; let elapsed = audioCtx.currentTime - playbackStartTime;
    if(elapsed >= playbackDuration) { 
      activeNodes = activeNodes.filter(n => n.playbackState !== 'finished'); 
      if (queuedPattern) { loadPatternData(queuedPattern.data); document.querySelectorAll(".pad").forEach(p=>p.classList.remove("active", "queued")); queuedPattern.pad.classList.add("active"); queuedPattern = null; } 
      if(document.getElementById("loopCheckbox").checked) { 
          playbackStartTime = audioCtx.currentTime; scheduleTracks(playbackStartTime); elapsed = 0; 
          if (isTracing && traceCurrentSeg) {
              undoStack.push({trackIdx: currentTargetTrack, segment: traceCurrentSeg});
              traceCurrentSeg = { points: [], brush: brushSelect.value, thickness: parseInt(sizeSlider.value), chordType: chordSelect.value };
              tracks[currentTargetTrack].segments.push(traceCurrentSeg);
          }
      } else { isPlaying=false; return; } 
    }
    const x = (elapsed/playbackDuration) * 750; 
    
    // Trace Pad Drawing
    if (isTracing && traceCurrentSeg) {
        let jX = 0, jY = 0; if (brushSelect.value === "fractal") { jX = Math.random() * 20 - 10; jY = Math.random() * 40 - 20; }
        if (traceCurrentSeg.points.length > 0 && x < traceCurrentSeg.points[traceCurrentSeg.points.length - 1].x - 20) {
            traceCurrentSeg = { points: [], brush: brushSelect.value, thickness: parseInt(sizeSlider.value), chordType: chordSelect.value };
            tracks[currentTargetTrack].segments.push(traceCurrentSeg);
        }
        traceCurrentSeg.points.push({x: x, y: traceCurrentY, jX, jY});

        // X/Y FX Modulation!
        if(audioCtx) {
            const linkedFX = getLinkedFX();
            const normX = x / 750; // 0.0 to 1.0
            const normY = 1.0 - (traceCurrentY / 100); // Invert Y (top is 1)
            linkedFX.forEach(fx => {
                if(fx === "delay" && fxNodes.delay.node) {
                    fxNodes.delay.node.delayTime.setTargetAtTime(normX * 1.0, audioCtx.currentTime, 0.05); // X = Time (0-1s)
                    fxNodes.delay.feedback.gain.setTargetAtTime(normY * 0.9, audioCtx.currentTime, 0.05); // Y = Feedback (0-0.9)
                }
                if(fx === "vibrato" && fxNodes.vibrato.lfo) {
                    fxNodes.vibrato.lfo.frequency.setTargetAtTime(normX * 20, audioCtx.currentTime, 0.05); // X = Rate (0-20Hz)
                    fxNodes.vibrato.depthNode.gain.setTargetAtTime(normY * 0.01, audioCtx.currentTime, 0.05); // Y = Depth
                }
                if(fx === "reverb" && fxNodes.reverb.mix) {
                    fxNodes.reverb.mix.gain.setTargetAtTime(normY * 1.5, audioCtx.currentTime, 0.05); // Y = Mix
                }
            });
        }
    }

    tracks.forEach(t => redrawTrack(t, x)); updateViz(x);
    animationFrameId = requestAnimationFrame(loop);
  }

  function updateViz(currentX) { 
    analyser.getByteFrequencyData(dataArray); let avg = dataArray.reduce((a,b)=>a+b)/dataArray.length; let d = avg - lastAvg; lastAvg = avg; 
    let filterStr = ""; pigeonImg.style.transform = `scale(${1+Math.min(0.2, d/100)}, ${1-Math.min(0.5, d/50)})`; 
  }

  function getPos(e, c) { const r=c.getBoundingClientRect(); const cx=e.touches?e.touches[0].clientX:e.clientX, cy=e.touches?e.touches[0].clientY:e.clientY; return {x:(cx-r.left)*(c.width/r.width), y:(cy-r.top)*(c.height/r.height)}; }
  function snap(x, w) { return Math.round(x/(w/32))*(w/32); }
  function mapY(y, h) { return Math.max(20, Math.min(1000-(y/h)*920, 20000)); }
  function quantize(f) { const s=document.getElementById("scaleSelect").value; let m=Math.round(69+12*Math.log2(f/440)), pat=(s==="major")?[0,2,4,5,7,9,11]:(s==="minor")?[0,2,3,5,7,8,10]:[0,3,5,7,10], mod=m%12, b=pat[0], md=99; pat.forEach(p=>{if(Math.abs(p-mod)<md){md=Math.abs(p-mod);b=p;}}); return 440*Math.pow(2,(m-mod+b-69)/12); }
  function updateTrackVolume(t) { if(t.gainNode && audioCtx) { t.gainNode.gain.setTargetAtTime(t.mute ? 0 : t.vol, audioCtx.currentTime, 0.05); } }

  function drawGrid(t) { 
    t.ctx.save(); t.ctx.clearRect(0,0,t.canvas.width,t.canvas.height); t.ctx.strokeStyle="#eee"; 
    for(let i=0;i<=32;i++){ t.ctx.beginPath(); let x = i*(t.canvas.width/32); t.ctx.moveTo(x,0); t.ctx.lineTo(x,t.canvas.height); t.ctx.lineWidth = (i % 4 === 0) ? 2 : 1; t.ctx.stroke(); } 
    t.ctx.restore(); 
  }

  function erase(t,x,y) { t.segments=t.segments.filter(s=>!s.points.some(p=>Math.hypot(p.x-x,p.y-y)<20)); redrawTrack(t); }

  function redrawTrack(t, hx) {
    drawGrid(t);
    t.segments.forEach(seg => {
      const pts=seg.points; if (pts.length < 1) return;
      const brush=seg.brush||"standard", size=seg.thickness||5;
      t.ctx.beginPath(); t.ctx.strokeStyle="#000"; t.ctx.lineWidth=size;
      if(brush==="chord"){ chordIntervals[seg.chordType||"major"].forEach((iv,i)=>{ t.ctx.save(); t.ctx.beginPath(); t.ctx.strokeStyle=chordColors[i%3]; t.ctx.lineWidth=size; t.ctx.moveTo(pts[0].x, pts[0].y-iv*5); for(let k=1;k<pts.length;k++) t.ctx.lineTo(pts[k].x,pts[k].y-iv*5); t.ctx.stroke(); t.ctx.restore(); }); } 
      else if(brush==="particles"){ for(let i=1;i<pts.length;i++) drawSegmentParticles(t.ctx, pts, i-1, i, size); } 
      else { t.ctx.moveTo(pts[0].x,pts[0].y); for(let i=1;i<pts.length;i++){ switch(brush){ case"variable": drawSegmentVariable(t.ctx, pts, i-1, i, size); break; case"calligraphy": drawSegmentCalligraphy(t.ctx, pts, i-1, i, size); break; case"fractal": drawSegmentFractal(t.ctx, pts, i-1, i, size); break; default: drawSegmentStandard(t.ctx, pts, i-1, i, size); } } t.ctx.stroke(); } 
    });
    if(hx!==undefined){ t.ctx.save(); t.ctx.beginPath(); t.ctx.strokeStyle="red"; t.ctx.lineWidth=2; t.ctx.moveTo(hx,0); t.ctx.lineTo(hx,100); t.ctx.stroke(); t.ctx.restore(); }
  }

  document.getElementById("playButton").addEventListener("click", () => { if(isPlaying) return; initAudio(); if(audioCtx.state==="suspended")audioCtx.resume(); playbackDuration=(60/(parseFloat(document.getElementById("bpmInput").value)||120))*32; playbackStartTime=audioCtx.currentTime+0.1; isPlaying=true; scheduleTracks(playbackStartTime); loop(); });
  document.getElementById("stopButton").addEventListener("click", () => { isPlaying = false; cancelAnimationFrame(animationFrameId); activeNodes.forEach(node => { try { node.stop(); node.disconnect(); } catch (e) {} }); activeNodes = []; tracks.forEach(t => { if(t.gainNode) t.gainNode.disconnect(); redrawTrack(t); }); if(pigeonImg) { pigeonImg.style.transform = "scale(1)"; pigeonImg.style.filter = ""; } document.querySelectorAll(".pad").forEach(p => p.classList.remove("queued")); });
  document.getElementById("clearButton").addEventListener("click", () => { tracks.forEach(t=>{t.segments=[]; redrawTrack(t);}); });
  
  // ==========================================
  // --- UI INTERACTION FOR FX RACK ---
  // ==========================================
  
  function getFxNameFromUnit(unit) {
      const t = unit.querySelector('.fx-header').innerText;
      if(t.includes("DELAY")) return "delay";
      if(t.includes("REVERB")) return "reverb";
      if(t.includes("VIBRATO")) return "vibrato";
      return null;
  }

  function updateRoutingFromUI() {
      if(!audioCtx) return;
      document.querySelectorAll('.fx-unit').forEach(unit => {
          const fxName = getFxNameFromUnit(unit);
          const btns = unit.querySelectorAll('.matrix-btn');
          const led = unit.querySelector('.led');
          let anyActive = false;
          btns.forEach((btn, idx) => {
              const isActive = btn.classList.contains('active');
              if(isActive) anyActive = true;
              if(trackSends[idx] && trackSends[idx][fxName]) {
                  trackSends[idx][fxName].gain.setTargetAtTime(isActive ? 1 : 0, audioCtx.currentTime, 0.05);
              }
          });
          if(led) led.classList.toggle('on', anyActive);
      });
  }

  document.querySelectorAll('.matrix-btn').forEach(btn => {
      btn.addEventListener('click', function() {
          if(!audioCtx) initAudio();
          this.classList.toggle('active');
          updateRoutingFromUI();
      });
  });

  document.querySelectorAll('.fx-xy-link').forEach(btn => {
      btn.addEventListener('click', function() { this.classList.toggle('active'); });
  });

  // KNOB DRAG LOGIC
  document.querySelectorAll('.knob').forEach(knob => {
      // Default value 0.5 (Mitte)
      knob.dataset.val = knob.dataset.val || 0.5;
      
      knob.addEventListener('mousedown', (e) => {
          let isDragging = true; let startY = e.clientY; let startVal = parseFloat(knob.dataset.val);
          document.body.style.cursor = 'ns-resize';
          
          const onMove = (ev) => {
              if(!isDragging) return;
              if(!audioCtx) initAudio();
              const delta = startY - ev.clientY;
              let newVal = Math.max(0, Math.min(1, startVal + (delta * 0.005)));
              knob.dataset.val = newVal;
              const deg = -135 + (newVal * 270); // -135 bis +135 Grad
              knob.style.transform = `rotate(${deg}deg)`;
              
              // Apply FX Values
              const unit = knob.closest('.fx-unit');
              const fxName = getFxNameFromUnit(unit);
              const paramName = knob.nextElementSibling.innerText;
              
              if(fxName === "delay" && fxNodes.delay.node) {
                  if(paramName === "TIME") fxNodes.delay.node.delayTime.setTargetAtTime(newVal * 1.0, audioCtx.currentTime, 0.05);
                  if(paramName === "FDBK") fxNodes.delay.feedback.gain.setTargetAtTime(newVal * 0.9, audioCtx.currentTime, 0.05);
              }
              if(fxName === "reverb" && fxNodes.reverb.mix) {
                  if(paramName === "MIX") fxNodes.reverb.mix.gain.setTargetAtTime(newVal * 1.5, audioCtx.currentTime, 0.05);
                  // Decay is static IR length for now, could be simulated differently
              }
              if(fxName === "vibrato" && fxNodes.vibrato.lfo) {
                  if(paramName === "RATE") fxNodes.vibrato.lfo.frequency.setTargetAtTime(newVal * 20, audioCtx.currentTime, 0.05);
                  if(paramName === "DEPTH") fxNodes.vibrato.depthNode.gain.setTargetAtTime(newVal * 0.01, audioCtx.currentTime, 0.05);
              }
          };
          
          const onUp = () => { isDragging = false; document.body.style.cursor = 'default'; window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
          window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp);
      });
      // Init visual rotation
      const deg = -135 + (parseFloat(knob.dataset.val) * 270);
      knob.style.transform = `rotate(${deg}deg)`;
  });

  if (tracePad) {
    const getPadPos = (e) => {
      const r = tracePad.getBoundingClientRect(); const cx = e.touches ? e.touches[0].clientX : e.clientX; const cy = e.touches ? e.touches[0].clientY : e.clientY;
      return { x: (cx - r.left) * (750 / r.width), y: (cy - r.top) * (100 / r.height) }; 
    };
    const startTrace = (e) => {
      e.preventDefault(); if (!isPlaying) return; if (!audioCtx) initAudio(); if (audioCtx.state === "suspended") audioCtx.resume();
      isTracing = true; const pos = getPadPos(e); traceCurrentY = pos.y; 
      const elapsed = audioCtx.currentTime - playbackStartTime; const currentX = (elapsed / playbackDuration) * 750;
      traceCurrentSeg = { points: [{x: currentX, y: traceCurrentY, jX: 0, jY: 0}], brush: brushSelect.value, thickness: parseInt(sizeSlider.value), chordType: chordSelect.value };
      tracks[currentTargetTrack].segments.push(traceCurrentSeg);
      if (brushSelect.value === "particles") triggerParticleGrain(tracks[currentTargetTrack], traceCurrentY); else startLiveSynth(tracks[currentTargetTrack], traceCurrentY);
    };
    const moveTrace = (e) => {
      if (!isTracing || !isPlaying) return; e.preventDefault();
      const pos = getPadPos(e); traceCurrentY = pos.y; 
      if (brushSelect.value === "particles") triggerParticleGrain(tracks[currentTargetTrack], traceCurrentY); else updateLiveSynth(tracks[currentTargetTrack], traceCurrentY); 
    };
    const stopTrace = () => {
      if (isTracing) {
        const elapsed = audioCtx.currentTime - playbackStartTime; const currentX = (elapsed / playbackDuration) * 750;
        if(traceCurrentSeg) { traceCurrentSeg.points.push({x: currentX, y: traceCurrentY, jX: 0, jY: 0}); undoStack.push({trackIdx: currentTargetTrack, segment: traceCurrentSeg}); }
        redrawTrack(tracks[currentTargetTrack]); stopLiveSynth(); isTracing = false; traceCurrentSeg = null;
      }
    };

    tracePad.addEventListener("mousedown", startTrace); tracePad.addEventListener("mousemove", moveTrace); tracePad.addEventListener("mouseup", stopTrace); tracePad.addEventListener("mouseleave", stopTrace);
    tracePad.addEventListener("touchstart", startTrace, {passive: false}); tracePad.addEventListener("touchmove", moveTrace, {passive: false}); tracePad.addEventListener("touchend", stopTrace);
    
    document.querySelectorAll(".picker-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".picker-btn").forEach(b => b.classList.remove("active"));
        btn.classList.add("active"); currentTargetTrack = parseInt(btn.dataset.target);
      });
    });
    document.getElementById("traceClearBtn").addEventListener("click", () => { tracks[currentTargetTrack].segments = []; redrawTrack(tracks[currentTargetTrack]); });
  }
});