import { drawGrid, redrawTrack } from './canvas.js';
import { 
    initAudio, audioCtx, masterGain, analyser, fxNodes, trackSends, 
    updateTrackVolume, connectTrackToFX, getDistortionCurve, mapYToFrequency, quantizeFrequency 
} from './audio.js';
import { setupKnob, updatePadUI, resetFXUI } from './ui.js';

// --- State Management ---
let patternBanks = { A: [null, null, null, null], B: [null, null, null, null], C: [null, null, null, null] };
let isPlaying = false, isSaveMode = false, playbackStartTime = 0, playbackDuration = 0, animationFrameId;
let undoStack = [], liveNodes = [], liveGainNode = null, liveFilterNode = null, activeNodes = [], lastAvg = 0;
let currentTargetTrack = 0, traceCurrentY = 50, isTracing = false, isEffectMode = false, traceCurrentSeg = null, queuedPattern = null;

const chordIntervals = { major: [0, 4, 7], minor: [0, 3, 7], diminished: [0, 3, 6], augmented: [0, 4, 8], sus2: [0, 2, 7], sus4: [0, 5, 7] };
const chordColors = ['#FF5733', '#33FF57', '#3357FF'];

// --- DOM Elemente ---
const toolSelect = document.getElementById("toolSelect"),
      brushSelect = document.getElementById("brushSelect"),
      sizeSlider = document.getElementById("brushSizeSlider"),
      chordSelect = document.getElementById("chordSelect"),
      harmonizeCheckbox = document.getElementById("harmonizeCheckbox"),
      scaleSelect = document.getElementById("scaleSelect"),
      pigeonImg = document.getElementById("pigeon"),
      tracePad = document.getElementById("trace-pad"),
      customEraser = document.getElementById("custom-eraser");

const tracks = Array.from(document.querySelectorAll(".track-container")).map((c, i) => ({
    index: i, canvas: c.querySelector("canvas"), ctx: c.querySelector("canvas").getContext("2d"),
    segments: [], wave: "sine", mute: false, vol: 0.8, snap: false, gainNode: null, curSeg: null
}));

// --- Boot Routine ---
document.addEventListener("DOMContentLoaded", () => {
    tracks.forEach(t => { drawGrid(t); setupTrackControls(t); setupDrawing(t); });
    loadInitialData();
    setupFX();
    setupMainControls();
    setupPads();
    setupTracePad();
    resetFXUI(updateRoutingFromUI);
    document.body.classList.toggle("eraser-mode", toolSelect.value === "erase");
});

// --- Hilfsfunktionen & WAV Converter ---
function getPos(e, c) {
    const r = c.getBoundingClientRect();
    const cx = e.touches ? e.touches[0].clientX : e.clientX, cy = e.touches ? e.touches[0].clientY : e.clientY;
    return { x: (cx - r.left) * (c.width / r.width), y: (cy - r.top) * (c.height / r.height) };
}

function saveState() {
    undoStack.push(JSON.stringify(tracks.map(t => t.segments)));
    if (undoStack.length > 25) undoStack.shift(); 
}

function getKnobVal(paramName) {
    let val = 0;
    document.querySelectorAll('.knob').forEach(k => {
        if (k.nextElementSibling.innerText === paramName) val = parseFloat(k.dataset.val || 0.5);
    });
    return val;
}

// FIX: Kugelsicheres Auslesen der Matrix über den Titel (ignoriert die HTML-Reihenfolge)
function getMatrixStateByName(fxName, trackIndex) {
    let isActive = false;
    document.querySelectorAll('.fx-unit').forEach(unit => {
        const header = unit.querySelector('.fx-header');
        if (header && header.innerText.toUpperCase().includes(fxName)) {
            const btn = unit.querySelectorAll('.matrix-btn')[trackIndex];
            if (btn && btn.classList.contains('active')) isActive = true;
        }
    });
    return isActive;
}

// FIX: Kugelsicheres Setzen der Matrix über den Titel
function setMatrixStateByName(fxName, trackIndex, isActive) {
    document.querySelectorAll('.fx-unit').forEach(unit => {
        const header = unit.querySelector('.fx-header');
        if (header && header.innerText.toUpperCase().includes(fxName)) {
            const btn = unit.querySelectorAll('.matrix-btn')[trackIndex];
            if (btn) {
                if (isActive) btn.classList.add('active');
                else btn.classList.remove('active');
            }
            const led = unit.querySelector('.led');
            if (led) led.classList.toggle('on', unit.querySelectorAll('.matrix-btn.active').length > 0);
        }
    });
}

function audioBufferToWav(buffer) {
    let numOfChan = buffer.numberOfChannels, length = buffer.length * numOfChan * 2 + 44,
        bufferArray = new ArrayBuffer(length), view = new DataView(bufferArray),
        channels = [], i, sample, offset = 0, pos = 0;
    const setUint16 = data => { view.setUint16(pos, data, true); pos += 2; };
    const setUint32 = data => { view.setUint32(pos, data, true); pos += 4; };
    setUint32(0x46464952); setUint32(length - 8); setUint32(0x45564157);
    setUint32(0x20746d66); setUint32(16); setUint16(1); setUint16(numOfChan);
    setUint32(buffer.sampleRate); setUint32(buffer.sampleRate * 2 * numOfChan);
    setUint16(numOfChan * 2); setUint16(16); setUint32(0x61746164); setUint32(length - 44);
    for (i = 0; i < buffer.numberOfChannels; i++) channels.push(buffer.getChannelData(i));
    while (pos < length) {
        for (i = 0; i < numOfChan; i++) {
            sample = Math.max(-1, Math.min(1, channels[i][offset]));
            sample = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
            view.setInt16(pos, sample, true); pos += 2;
        }
        offset++;
    }
    return new Blob([bufferArray], { type: "audio/wav" });
}

// --- Radiergummi Cursor Logik ---
toolSelect.addEventListener("change", (e) => {
    document.body.classList.toggle("eraser-mode", e.target.value === "erase");
});

const updateEraserPos = (e) => {
    if (toolSelect.value === "erase" && customEraser) {
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const clientY = e.touches ? e.touches[0].clientY : e.clientY;
        customEraser.style.left = clientX + "px";
        customEraser.style.top = clientY + "px";
    }
};
window.addEventListener("mousemove", updateEraserPos);
window.addEventListener("touchmove", updateEraserPos, { passive: true });

// --- Datenverwaltung & Preset Routing ---
function applyAllFXFromUI() {
    if (!audioCtx) return;
    document.querySelectorAll('.knob').forEach(knob => {
        const val = parseFloat(knob.dataset.val || 0.5);
        const param = knob.nextElementSibling.innerText;
        if (param === "TIME") fxNodes.delay.node.delayTime.value = val * 1.0;
        if (param === "FDBK") fxNodes.delay.feedback.gain.value = val * 0.9;
        if (param === "MIX") fxNodes.reverb.mix.gain.value = val * 1.5;
        if (param === "RATE") fxNodes.vibrato.lfo.frequency.value = val * 20;
        if (param === "DEPTH") fxNodes.vibrato.depthNode.gain.value = val * 0.01;
    });
    updateRoutingFromUI();
}

function loadInitialData() {
    const saved = localStorage.getItem("pigeonBanks");
    let hasLocalBanks = false;
    if (saved) { 
        try { 
            patternBanks = JSON.parse(saved); 
            updatePadUI(patternBanks); 
            hasLocalBanks = true; 
        } catch(e) {} 
    }
    fetch('default_set.json').then(res => res.json()).then(data => {
        if (!hasLocalBanks && data.banks) { patternBanks = data.banks; updatePadUI(patternBanks); }
        if (data.current) loadPatternData(data.current);
    }).catch(() => console.log("Default-Set nicht gefunden."));
}

function loadPatternData(d) {
    if (d.settings) {
        document.getElementById("bpmInput").value = d.settings.bpm;
        document.getElementById("loopCheckbox").checked = d.settings.loop;
        scaleSelect.value = d.settings.scale;
        harmonizeCheckbox.checked = d.settings.harmonize;
        document.getElementById("scaleSelectContainer").style.display = harmonizeCheckbox.checked ? "inline" : "none";
        playbackDuration = (60 / (parseFloat(d.settings.bpm) || 120)) * 32;
    }
    
    if (d.fx) {
        if (d.fx.matrix) {
            d.fx.matrix.forEach((m, i) => {
                setMatrixStateByName("DELAY", i, m.delay);
                setMatrixStateByName("REVERB", i, m.reverb);
                setMatrixStateByName("VIBRATO", i, m.vibrato);
            });
        }
        
        const updateKnob = (paramName, rawVal, multiplier) => {
            document.querySelectorAll('.knob').forEach(knob => {
                if (knob.nextElementSibling.innerText === paramName) {
                    const normVal = rawVal / multiplier;
                    knob.dataset.val = normVal;
                    knob.style.transform = `rotate(${-135 + (normVal * 270)}deg)`;
                }
            });
        };

        if (d.fx.delay) { updateKnob("TIME", d.fx.delay.time, 1.0); updateKnob("FDBK", d.fx.delay.feedback, 0.9); }
        if (d.fx.reverb) { updateKnob("MIX", d.fx.reverb.mix, 1.5); }
        if (d.fx.vibrato) { updateKnob("RATE", d.fx.vibrato.rate, 20); updateKnob("DEPTH", d.fx.vibrato.depth, 0.01); }

        applyAllFXFromUI();
    }

    const tData = d.tracks || d;
    if (Array.isArray(tData)) {
        tData.forEach((td, idx) => {
            if (!tracks[idx]) return;
            let t = tracks[idx]; t.segments = JSON.parse(JSON.stringify(td.segments || td || []));
            if (!Array.isArray(td)) { t.vol = td.vol ?? 0.8; t.mute = td.mute ?? false; t.wave = td.wave ?? "sine"; t.snap = td.snap ?? false; }
            const cont = t.canvas.parentElement;
            cont.querySelector(".volume-slider").value = t.vol;
            cont.querySelector(".mute-btn").style.backgroundColor = t.mute ? "#ff4444" : "";
            const snapBox = cont.querySelector(".snap-checkbox"); if(snapBox) snapBox.checked = t.snap;
            cont.querySelectorAll(".wave-btn").forEach(btn => btn.classList.toggle("active", btn.dataset.wave === t.wave));
            redrawTrack(t, undefined, brushSelect.value, chordIntervals, chordColors);
        });
    }
}

// --- Audio Engine ---
function startLiveSynth(track, y) {
    if (track.mute || track.vol < 0.01) return;
    liveNodes = []; liveGainNode = audioCtx.createGain(); liveGainNode.gain.setValueAtTime(0, audioCtx.currentTime);
    liveGainNode.gain.linearRampToValueAtTime(0.3, audioCtx.currentTime + 0.01);
    let freq = mapYToFrequency(y, track.canvas.height); if (harmonizeCheckbox.checked) freq = quantizeFrequency(freq, scaleSelect.value);
    const brush = brushSelect.value; const ivs = (brush === "chord") ? chordIntervals[chordSelect.value] : [0];
    ivs.forEach(iv => {
        const osc = audioCtx.createOscillator(); osc.type = track.wave;
        osc.frequency.setValueAtTime(freq * Math.pow(2, iv / 12), audioCtx.currentTime);
        if(brush === "fractal") { const sh = audioCtx.createWaveShaper(); sh.curve = getDistortionCurve(); osc.connect(sh).connect(liveGainNode); }
        else osc.connect(liveGainNode);
        osc.start(); liveNodes.push(osc);
    });
    const trackG = audioCtx.createGain(); trackG.gain.value = track.vol;
    liveGainNode.connect(trackG).connect(masterGain); connectTrackToFX(trackG, track.index); liveGainNode.out = trackG;
}

function updateLiveSynth(track, y) {
    if (!liveGainNode) return;
    let freq = mapYToFrequency(y, track.canvas.height); if (harmonizeCheckbox.checked) freq = quantizeFrequency(freq, scaleSelect.value);
    liveNodes.forEach((n, i) => { const ivs = (brushSelect.value === "chord") ? chordIntervals[chordSelect.value] : [0]; n.frequency.setTargetAtTime(freq * Math.pow(2, (ivs[i] || 0) / 12), audioCtx.currentTime, 0.02); });
}

function stopLiveSynth() {
    if (!liveGainNode) return;
    const gn = liveGainNode; 
    const ns = liveNodes; 
    gn.gain.setTargetAtTime(0, audioCtx.currentTime, 0.05);
    setTimeout(() => { 
        ns.forEach(n => { try { n.stop(); } catch(e){} }); 
        if (gn.out) gn.out.disconnect(); 
        gn.disconnect(); 
    }, 100);
    liveNodes = []; liveGainNode = null;
}

function triggerParticleGrain(track, y) {
    if (track.mute || track.vol < 0.01) return;
    let freq = mapYToFrequency(y, track.canvas.height); if (harmonizeCheckbox.checked) freq = quantizeFrequency(freq, scaleSelect.value);
    const osc = audioCtx.createOscillator(), env = audioCtx.createGain(), trkG = audioCtx.createGain(), now = audioCtx.currentTime;
    osc.type = track.wave; osc.frequency.value = freq; trkG.gain.value = track.vol;
    env.gain.setValueAtTime(0, now); env.gain.linearRampToValueAtTime(0.4, now + 0.01); env.gain.exponentialRampToValueAtTime(0.01, now + 0.15);
    osc.connect(env).connect(trkG).connect(masterGain); connectTrackToFX(trkG, track.index);
    
    osc.onended = () => { const idx = activeNodes.indexOf(osc); if (idx > -1) activeNodes.splice(idx, 1); };
    osc.start(now); osc.stop(now + 0.2); 
    activeNodes.push(osc);
}

function scheduleTracks(start, targetCtx = audioCtx, targetDest = masterGain, offlineFX = null) {
    tracks.forEach(track => {
        const trkG = targetCtx.createGain(); trkG.connect(targetDest); trkG.gain.value = track.mute ? 0 : track.vol;
        if (targetCtx === audioCtx) { track.gainNode = trkG; connectTrackToFX(trkG, track.index); }
        else if (offlineFX) { 
            if (getMatrixStateByName("DELAY", track.index)) trkG.connect(offlineFX.delay);
            if (getMatrixStateByName("VIBRATO", track.index)) trkG.connect(offlineFX.vibrato);
        }
        
        track.segments.forEach(seg => {
            const brush = seg.brush || "standard", sorted = seg.points.slice().sort((a, b) => a.x - b.x);
            if (sorted.length < 2 && brush !== "particles") return;
            if (brush === "particles") {
                seg.points.forEach(p => {
                    const t = Math.max(0, start + (p.x / 750) * playbackDuration), osc = targetCtx.createOscillator(), env = targetCtx.createGain();
                    osc.type = track.wave; let f = mapYToFrequency(p.y, 100); if (harmonizeCheckbox.checked) f = quantizeFrequency(f, scaleSelect.value);
                    osc.frequency.value = f; env.gain.setValueAtTime(0, t); env.gain.linearRampToValueAtTime(0.4, t + 0.01); env.gain.exponentialRampToValueAtTime(0.01, t + 0.15);
                    osc.connect(env).connect(trkG); 
                    osc.onended = () => { const idx = activeNodes.indexOf(osc); if (idx > -1) activeNodes.splice(idx, 1); };
                    osc.start(t); osc.stop(t + 0.2); 
                    if (targetCtx === audioCtx) activeNodes.push(osc);
                });
            } else {
                const ivs = (brush === "chord") ? chordIntervals[seg.chordType || "major"] : [0];
                let sT = Math.max(0, start + (sorted[0].x / 750) * playbackDuration), eT = Math.max(0, start + (sorted[sorted.length-1].x / 750) * playbackDuration);
                ivs.forEach(iv => {
                    const osc = targetCtx.createOscillator(), g = targetCtx.createGain(); osc.type = track.wave;
                    g.gain.setValueAtTime(0, sT); g.gain.linearRampToValueAtTime(0.3, sT + 0.02); g.gain.setValueAtTime(0.3, eT); g.gain.linearRampToValueAtTime(0, eT + 0.1);
                    if (brush === "fractal") { const sh = targetCtx.createWaveShaper(); sh.curve = getDistortionCurve(); osc.connect(sh).connect(g); } else osc.connect(g);
                    g.connect(trkG); sorted.forEach(p => {
                        const t = Math.max(0, start + (p.x / 750) * playbackDuration); let f = mapYToFrequency(p.y, 100); if (harmonizeCheckbox.checked) f = quantizeFrequency(f, scaleSelect.value);
                        osc.frequency.linearRampToValueAtTime(f * Math.pow(2, iv/12), t);
                    });
                    osc.onended = () => { const idx = activeNodes.indexOf(osc); if (idx > -1) activeNodes.splice(idx, 1); };
                    osc.start(sT); osc.stop(eT + 0.2); 
                    if (targetCtx === audioCtx) activeNodes.push(osc);
                });
            }
        });
    });
}

// --- Interaction ---
function setupDrawing(track) {
    let drawing = false;
    const start = e => {
        e.preventDefault(); 
        initAudio(tracks, updateRoutingFromUI); 
        if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
        saveState(); 
        const pos = getPos(e, track.canvas); 
        const x = track.snap ? Math.round(pos.x / (750 / 32)) * (750 / 32) : pos.x;
        
        if (toolSelect.value === "draw") {
            drawing = true; 
            let jX = 0, jY = 0; if (brushSelect.value === "fractal") { jX = Math.random() * 20 - 10; jY = Math.random() * 40 - 20; }
            track.curSeg = { points: [{ x, y: pos.y, jX, jY }], brush: brushSelect.value, thickness: parseInt(sizeSlider.value), chordType: chordSelect.value };
            track.segments.push(track.curSeg); 
            redrawTrack(track, undefined, brushSelect.value, chordIntervals, chordColors);
            if (brushSelect.value === "particles") triggerParticleGrain(track, pos.y); else startLiveSynth(track, pos.y);
        } else {
            erase(track, pos.x, pos.y); 
        }
    };

    const move = e => {
        if (!drawing && toolSelect.value !== "erase") return; 
        const pos = getPos(e, track.canvas); 
        const x = track.snap ? Math.round(pos.x / (750 / 32)) * (750 / 32) : pos.x;
        
        if (drawing && track.curSeg) {
            let jX = 0, jY = 0; if (brushSelect.value === "fractal") { jX = Math.random() * 20 - 10; jY = Math.random() * 40 - 20; }
            track.curSeg.points.push({ x, y: pos.y, jX, jY }); 
            redrawTrack(track, undefined, brushSelect.value, chordIntervals, chordColors);
            if (brushSelect.value === "particles") triggerParticleGrain(track, pos.y); else updateLiveSynth(track, pos.y);
        } else if (toolSelect.value === "erase" && (e.buttons === 1 || e.type === "touchmove")) {
            erase(track, pos.x, pos.y); 
        }
    };

    const stop = () => { 
        if (drawing) { 
            if (track.curSeg && track.curSeg.points.length === 1) {
                track.curSeg.points.push({
                    x: track.curSeg.points[0].x + 0.5, y: track.curSeg.points[0].y, 
                    jX: track.curSeg.points[0].jX, jY: track.curSeg.points[0].jY
                });
            }
            drawing = false; 
            track.curSeg = null; 
            stopLiveSynth(); 
            redrawTrack(track, undefined, brushSelect.value, chordIntervals, chordColors); 
        } 
    };

    track.canvas.addEventListener("mousedown", start); 
    track.canvas.addEventListener("mousemove", move); 
    window.addEventListener("mouseup", stop); 
    track.canvas.addEventListener("mouseleave", stop);
    track.canvas.addEventListener("touchstart", start, {passive:false}); 
    track.canvas.addEventListener("touchmove", move, {passive:false}); 
    track.canvas.addEventListener("touchend", stop);
}

function erase(t, x, y) { 
    t.segments = t.segments.filter(s => !s.points.some(p => Math.hypot(p.x - x, p.y - y) < 20)); 
    redrawTrack(t, undefined, brushSelect.value, chordIntervals, chordColors); 
}

function setupMainControls() {
    let mediaRecorder = null;
    let recordedChunks = [];
    const recBtn = document.getElementById("recButton");
    
    if (recBtn) {
        recBtn.addEventListener("click", () => {
            if (!audioCtx) initAudio(tracks, updateRoutingFromUI);
            if (audioCtx.state === "suspended") audioCtx.resume();

            if (mediaRecorder && mediaRecorder.state === "recording") {
                mediaRecorder.stop();
                recBtn.innerText = "⏺ Rec";
                recBtn.style.color = ""; 
            } else {
                const dest = audioCtx.createMediaStreamDestination();
                masterGain.connect(dest);
                mediaRecorder = new MediaRecorder(dest.stream);
                recordedChunks = [];

                mediaRecorder.ondataavailable = e => { if (e.data.size > 0) recordedChunks.push(e.data); };
                mediaRecorder.onstop = async () => {
                    recBtn.innerText = "⏳ Saving...";
                    const webmBlob = new Blob(recordedChunks, { type: "audio/webm" });
                    const arrayBuffer = await webmBlob.arrayBuffer();
                    const decodedAudio = await audioCtx.decodeAudioData(arrayBuffer);
                    const wavBlob = audioBufferToWav(decodedAudio);

                    const url = URL.createObjectURL(wavBlob);
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = "pigeon_live_recording.wav";
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                    URL.revokeObjectURL(url);
                    masterGain.disconnect(dest);
                    recBtn.innerText = "⏺ Rec";
                };

                mediaRecorder.start();
                recBtn.innerText = "⏹ Stop Rec";
                recBtn.style.color = "#ff4444";
            }
        });
    }

    const exportWavBtn = document.getElementById("exportWavButton");
    exportWavBtn.addEventListener("click", async () => {
        exportWavBtn.innerText = "⏳ Exporting...";
        exportWavBtn.disabled = true;

        const bpm = parseFloat(document.getElementById("bpmInput").value) || 120;
        const loopDur = (60 / bpm) * 32;
        const sampleRate = audioCtx ? audioCtx.sampleRate : 44100;
        
        const offCtx = new OfflineAudioContext(2, sampleRate * loopDur, sampleRate);
        const mDest = offCtx.createGain(); 
        mDest.connect(offCtx.destination);
        
        const fxOff = {
            delay: offCtx.createDelay(),
            delayFbk: offCtx.createGain(),
            vibrato: offCtx.createDelay(),
            vibLfo: offCtx.createOscillator(),
            vibDepth: offCtx.createGain()
        };
        
        fxOff.delay.delayTime.value = getKnobVal("TIME") * 1.0;
        fxOff.delayFbk.gain.value = getKnobVal("FDBK") * 0.9;
        fxOff.delay.connect(fxOff.delayFbk); fxOff.delayFbk.connect(fxOff.delay);
        fxOff.delay.connect(mDest);
        
        fxOff.vibrato.delayTime.value = 0.03;
        fxOff.vibLfo.frequency.value = getKnobVal("RATE") * 20;
        fxOff.vibDepth.gain.value = getKnobVal("DEPTH") * 0.01;
        fxOff.vibLfo.connect(fxOff.vibDepth); fxOff.vibDepth.connect(fxOff.vibrato.delayTime);
        fxOff.vibLfo.start(0); fxOff.vibrato.connect(mDest);

        scheduleTracks(0, offCtx, mDest, fxOff);
        
        const renderedBuffer = await offCtx.startRendering();
        const wavBlob = audioBufferToWav(renderedBuffer);
        
        const url = URL.createObjectURL(wavBlob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "pigeon_perfect_loop.wav";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        
        exportWavBtn.innerText = "Export WAV";
        exportWavBtn.disabled = false;
    });

    document.getElementById("playButton").addEventListener("click", () => {
        if (isPlaying) return; 
        initAudio(tracks, updateRoutingFromUI); 
        applyAllFXFromUI(); 
        if (audioCtx.state === "suspended") audioCtx.resume();
        playbackDuration = (60 / (parseFloat(document.getElementById("bpmInput").value) || 120)) * 32;
        playbackStartTime = audioCtx.currentTime + 0.1; isPlaying = true; scheduleTracks(playbackStartTime); loop();
    });
    
    document.getElementById("stopButton").addEventListener("click", () => {
        isPlaying = false; cancelAnimationFrame(animationFrameId); activeNodes.forEach(n => { try { n.stop(); n.disconnect(); } catch (e) { } });
        activeNodes = []; tracks.forEach(t => { if(t.gainNode) t.gainNode.disconnect(); redrawTrack(t, undefined, brushSelect.value, chordIntervals, chordColors); });
        pigeonImg.style.transform = "scale(1)"; document.querySelectorAll(".pad").forEach(p => p.classList.remove("active", "queued"));
    });
    
    document.getElementById("fullscreenBtn")?.addEventListener("click", () => { if (!document.fullscreenElement) document.documentElement.requestFullscreen(); else document.exitFullscreen(); });
    
    document.getElementById("undoButton").addEventListener("click", () => { 
        if (undoStack.length > 0) { 
            const stateStr = undoStack.pop(); 
            const state = JSON.parse(stateStr);
            tracks.forEach((t, i) => {
                t.segments = state[i];
                redrawTrack(t, undefined, brushSelect.value, chordIntervals, chordColors);
            });
        } 
    });
    
    document.getElementById("clearButton").addEventListener("click", () => { 
        saveState();
        tracks.forEach(t => { t.segments = []; drawGrid(t); }); 
    });
    
    harmonizeCheckbox.addEventListener("change", () => {
        document.getElementById("scaleSelectContainer").style.display = harmonizeCheckbox.checked ? "inline" : "none";
    });

    document.getElementById("exportButton").addEventListener("click", () => {
        const data = JSON.stringify({ 
            current: { 
                settings: { bpm: document.getElementById("bpmInput").value, loop: document.getElementById("loopCheckbox").checked, scale: scaleSelect.value, harmonize: harmonizeCheckbox.checked }, 
                fx: { 
                    delay: { time: getKnobVal("TIME") * 1.0, feedback: getKnobVal("FDBK") * 0.9 }, 
                    reverb: { mix: getKnobVal("MIX") * 1.5 }, 
                    vibrato: { rate: getKnobVal("RATE") * 20, depth: getKnobVal("DEPTH") * 0.01 }, 
                    matrix: tracks.map((_, i) => ({ delay: getMatrixStateByName("DELAY", i), reverb: getMatrixStateByName("REVERB", i), vibrato: getMatrixStateByName("VIBRATO", i) })) 
                }, 
                tracks: tracks.map(t => ({ segments: t.segments, vol: t.vol, mute: t.mute, wave: t.wave, snap: t.snap })) 
            }, 
            banks: patternBanks 
        });
        const blob = new Blob([data], { type: "application/json" }), a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "pigeon_set.json"; a.click();
    });
    
    document.getElementById("importButton").addEventListener("click", () => document.getElementById("importFileInput").click());
    document.getElementById("importFileInput").addEventListener("change", e => { const r = new FileReader(); r.onload = evt => { const d = JSON.parse(evt.target.result); if (d.banks) { patternBanks = d.banks; updatePadUI(patternBanks); } loadPatternData(d.current || d); }; r.readAsText(e.target.files[0]); });
}

function setupPads() {
    document.getElementById("saveModeBtn").addEventListener("click", (e) => { isSaveMode = !isSaveMode; e.target.classList.toggle("active", isSaveMode); });
    document.querySelectorAll(".pad").forEach(pad => {
        pad.addEventListener("click", () => {
            const b = pad.dataset.bank, i = parseInt(pad.dataset.idx);
            if (isSaveMode) {
                patternBanks[b][i] = { 
                    settings: { bpm: document.getElementById("bpmInput").value, loop: document.getElementById("loopCheckbox").checked, scale: scaleSelect.value, harmonize: harmonizeCheckbox.checked }, 
                    fx: { 
                        delay: { time: getKnobVal("TIME") * 1.0, feedback: getKnobVal("FDBK") * 0.9 }, 
                        reverb: { mix: getKnobVal("MIX") * 1.5 }, 
                        vibrato: { rate: getKnobVal("RATE") * 20, depth: getKnobVal("DEPTH") * 0.01 }, 
                        matrix: tracks.map((_, trackIdx) => ({ delay: getMatrixStateByName("DELAY", trackIdx), reverb: getMatrixStateByName("REVERB", trackIdx), vibrato: getMatrixStateByName("VIBRATO", trackIdx) })) 
                    },
                    tracks: tracks.map(t => ({ segments: t.segments, vol: t.vol, mute: t.mute, wave: t.wave, snap: t.snap })) 
                };
                localStorage.setItem("pigeonBanks", JSON.stringify(patternBanks)); isSaveMode = false; document.getElementById("saveModeBtn").classList.remove("active"); updatePadUI(patternBanks);
            } else if (patternBanks[b] && patternBanks[b][i]) {
                if (isPlaying) { queuedPattern = { data: patternBanks[b][i], pad: pad }; document.querySelectorAll(".queued").forEach(p => p.classList.remove("queued")); pad.classList.add("queued"); }
                else { loadPatternData(patternBanks[b][i]); document.querySelectorAll(".active").forEach(p => p.classList.remove("active")); pad.classList.add("active"); }
            }
        });
    });
}

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

function setupTracePad() {
    const getPadPos = (e) => { const r = tracePad.getBoundingClientRect(), cx = e.touches ? e.touches[0].clientX : e.clientX, cy = e.touches ? e.touches[0].clientY : e.clientY; return { x: (cx - r.left) * (750 / r.width), y: (cy - r.top) * (100 / r.height) }; };
    
    tracePad.addEventListener("mousedown", e => {
        e.preventDefault(); if (!isPlaying) return; initAudio(tracks, updateRoutingFromUI); isTracing = true; const pos = getPadPos(e); traceCurrentY = pos.y;
        
        saveState(); 
        
        isEffectMode = document.querySelectorAll('.fx-xy-link.active').length > 0;
        if (!isEffectMode) { const elapsed = audioCtx.currentTime - playbackStartTime, currentX = (elapsed / playbackDuration) * 750; let jX = 0, jY = 0; if (brushSelect.value === "fractal") { jX = Math.random() * 20 - 10; jY = Math.random() * 40 - 20; } traceCurrentSeg = { points: [{ x: currentX, y: traceCurrentY, jX, jY }], brush: brushSelect.value, thickness: parseInt(sizeSlider.value), chordType: chordSelect.value }; tracks[currentTargetTrack].segments.push(traceCurrentSeg); if (brushSelect.value === "particles") triggerParticleGrain(tracks[currentTargetTrack], traceCurrentY); else startLiveSynth(tracks[currentTargetTrack], traceCurrentY); }
    });
    
    tracePad.addEventListener("mousemove", e => { if (isTracing) { const pos = getPadPos(e); traceCurrentY = pos.y; if (!isEffectMode) { if (brushSelect.value === "particles") triggerParticleGrain(tracks[currentTargetTrack], traceCurrentY); else updateLiveSynth(tracks[currentTargetTrack], traceCurrentY); } } });
    
    window.addEventListener("mouseup", () => { 
        if (isTracing) { 
            if (!isEffectMode) stopLiveSynth(); 
            isTracing = false; 
            redrawTrack(tracks[currentTargetTrack], undefined, brushSelect.value, chordIntervals, chordColors); 
        } 
    });
    
    document.querySelectorAll(".picker-btn").forEach(btn => btn.addEventListener("click", () => { document.querySelectorAll(".picker-btn").forEach(b => b.classList.remove("active")); btn.classList.add("active"); currentTargetTrack = parseInt(btn.dataset.target); }));
    
    document.getElementById("traceClearBtn").addEventListener("click", () => { 
        saveState();
        tracks[currentTargetTrack].segments = []; 
        redrawTrack(tracks[currentTargetTrack], undefined, brushSelect.value, chordIntervals, chordColors); 
    });
}

function setupFX() {
    document.querySelectorAll('.knob').forEach(knob => {
        setupKnob(knob, (val) => {
            if (!audioCtx) return; const unit = knob.closest('.fx-unit'), title = unit.querySelector('.fx-header').innerText, param = knob.nextElementSibling.innerText;
            if (title.includes("DELAY")) { if (param === "TIME") fxNodes.delay.node.delayTime.setTargetAtTime(val * 1.0, audioCtx.currentTime, 0.05); if (param === "FDBK") fxNodes.delay.feedback.gain.setTargetAtTime(val * 0.9, audioCtx.currentTime, 0.05); }
            else if (title.includes("REVERB") && param === "MIX") fxNodes.reverb.mix.gain.setTargetAtTime(val * 1.5, audioCtx.currentTime, 0.05);
            else if (title.includes("VIBRATO")) { if (param === "RATE") fxNodes.vibrato.lfo.frequency.setTargetAtTime(val * 20, audioCtx.currentTime, 0.05); if (param === "DEPTH") fxNodes.vibrato.depthNode.gain.setTargetAtTime(val * 0.01, audioCtx.currentTime, 0.05); }
        });
    });
    document.querySelectorAll('.matrix-btn').forEach(btn => btn.addEventListener('click', () => { if (!audioCtx) initAudio(tracks, updateRoutingFromUI); btn.classList.toggle('active'); updateRoutingFromUI(); }));
    document.querySelectorAll('.fx-xy-link').forEach(btn => btn.addEventListener('click', () => btn.classList.toggle('active')));
}

function updateRoutingFromUI() {
    if (!audioCtx) return;
    document.querySelectorAll('.fx-unit').forEach(unit => {
        const title = unit.querySelector('.fx-header').innerText, fxName = title.includes("DELAY") ? "delay" : title.includes("REVERB") ? "reverb" : "vibrato";
        unit.querySelectorAll('.matrix-btn').forEach((btn, idx) => { const active = btn.classList.contains('active'); trackSends[idx][fxName].gain.setTargetAtTime(active ? 1 : 0, audioCtx.currentTime, 0.05); });
        unit.querySelector('.led')?.classList.toggle('on', unit.querySelectorAll('.matrix-btn.active').length > 0);
    });
}

function loop() {
    if (!isPlaying) return; let elapsed = audioCtx.currentTime - playbackStartTime;
    if (elapsed >= playbackDuration) {
        if (queuedPattern) { loadPatternData(queuedPattern.data); document.querySelectorAll(".pad").forEach(p => p.classList.remove("active", "queued")); queuedPattern.pad.classList.add("active"); queuedPattern = null; }
        if (document.getElementById("loopCheckbox").checked) { 
            playbackStartTime = audioCtx.currentTime; scheduleTracks(playbackStartTime); elapsed = 0; 
            if (isTracing && traceCurrentSeg) { 
                saveState(); 
                traceCurrentSeg = { points: [], brush: brushSelect.value, thickness: parseInt(sizeSlider.value), chordType: chordSelect.value }; 
                tracks[currentTargetTrack].segments.push(traceCurrentSeg); 
            } 
        }
        else { isPlaying = false; return; }
    }
    const x = (elapsed / playbackDuration) * 750; 
    
    if (isTracing && traceCurrentSeg) { 
        let jX = 0, jY = 0; if (brushSelect.value === "fractal") { jX = Math.random() * 20 - 10; jY = Math.random() * 40 - 20; } 
        traceCurrentSeg.points.push({ x, y: traceCurrentY, jX, jY }); 
        
        if(audioCtx) {
            const linkedFX = getLinkedFX();
            const normX = x / 750; 
            const normY = 1.0 - (traceCurrentY / 100); 
            linkedFX.forEach(fx => {
                if(fx === "delay" && fxNodes.delay.node) {
                    fxNodes.delay.node.delayTime.setTargetAtTime(normX * 1.0, audioCtx.currentTime, 0.05); 
                    fxNodes.delay.feedback.gain.setTargetAtTime(normY * 0.9, audioCtx.currentTime, 0.05); 
                }
                if(fx === "vibrato" && fxNodes.vibrato.lfo) {
                    fxNodes.vibrato.lfo.frequency.setTargetAtTime(normX * 20, audioCtx.currentTime, 0.05); 
                    fxNodes.vibrato.depthNode.gain.setTargetAtTime(normY * 0.01, audioCtx.currentTime, 0.05); 
                }
                if(fx === "reverb" && fxNodes.reverb.mix) {
                    fxNodes.reverb.mix.gain.setTargetAtTime(normY * 1.5, audioCtx.currentTime, 0.05); 
                }
            });
        }
    }
    
    tracks.forEach(t => redrawTrack(t, x, brushSelect.value, chordIntervals, chordColors)); 
    const dataArray = new Uint8Array(analyser.frequencyBinCount); analyser.getByteFrequencyData(dataArray);
    let avg = dataArray.reduce((a, b) => a + b) / dataArray.length; let d = avg - lastAvg; lastAvg = avg;
    pigeonImg.style.transform = `scale(${1 + Math.min(0.2, d / 100)}, ${1 - Math.min(0.5, d / 50)})`; animationFrameId = requestAnimationFrame(loop);
}

function setupTrackControls(t) {
    const cont = t.canvas.parentElement;
    cont.querySelectorAll(".wave-btn").forEach(b => b.addEventListener("click", () => { t.wave = b.dataset.wave; cont.querySelectorAll(".wave-btn").forEach(btn => btn.classList.remove("active")); b.classList.add("active"); }));
    cont.querySelector(".mute-btn").addEventListener("click", e => { t.mute = !t.mute; e.target.style.backgroundColor = t.mute ? "#ff4444" : ""; updateTrackVolume(t); });
    cont.querySelector(".volume-slider").addEventListener("input", e => { t.vol = parseFloat(e.target.value); updateTrackVolume(t); });
    cont.querySelector(".snap-checkbox")?.addEventListener("change", e => t.snap = e.target.checked);
}