import { drawGrid, redrawTrack } from './canvas.js';
import { 
    initAudio, audioCtx, masterGain, analyser, fxNodes, trackSends, 
    updateTrackVolume, connectTrackToFX, getDistortionCurve, mapYToFrequency, quantizeFrequency 
} from './audio.js';
import { setupKnob, updatePadUI, resetFXUI } from './ui.js';

// --- Globaler App-Status (Synchronisiert mit Pigeon-3) ---
let patternBanks = { A: [null, null, null, null], B: [null, null, null, null], C: [null, null, null, null] };
let isPlaying = false;
let isSaveMode = false;
let playbackStartTime = 0;
let playbackDuration = 0;
let animationFrameId;
let undoStack = [];
let liveNodes = [];
let liveGainNode = null;
let liveFilterNode = null;
let activeNodes = [];
let lastAvg = 0;

// Performance & Trace-Pad Status
let currentTargetTrack = 0;
let traceCurrentY = 50;
let isTracing = false;
let isEffectMode = false;
let traceCurrentSeg = null;
let queuedPattern = null;

const chordIntervals = { major: [0, 4, 7], minor: [0, 3, 7], diminished: [0, 3, 6], augmented: [0, 4, 8], sus2: [0, 2, 7], sus4: [0, 5, 7] };
const chordColors = ['#FF5733', '#33FF57', '#3357FF'];

// --- DOM Elemente ---
const toolSelect = document.getElementById("toolSelect");
const brushSelect = document.getElementById("brushSelect");
const sizeSlider = document.getElementById("brushSizeSlider");
const chordSelect = document.getElementById("chordSelect");
const harmonizeCheckbox = document.getElementById("harmonizeCheckbox");
const scaleSelect = document.getElementById("scaleSelect");
const pigeonImg = document.getElementById("pigeon");
const tracePad = document.getElementById("trace-pad");

const tracks = Array.from(document.querySelectorAll(".track-container")).map((c, i) => ({
    index: i,
    canvas: c.querySelector("canvas"),
    ctx: c.querySelector("canvas").getContext("2d"),
    segments: [],
    wave: "sine",
    mute: false,
    vol: 0.8,
    snap: false,
    gainNode: null
}));

// --- Hilfsfunktionen ---
function getPos(e, c) {
    const r = c.getBoundingClientRect();
    const cx = e.touches ? e.touches[0].clientX : e.clientX;
    const cy = e.touches ? e.touches[0].clientY : e.clientY;
    return { x: (cx - r.left) * (c.width / r.width), y: (cy - r.top) * (c.height / r.height) };
}

// --- Initialisierung ---
document.addEventListener("DOMContentLoaded", () => {
    tracks.forEach(t => {
        drawGrid(t);
        setupTrackControls(t);
        setupDrawing(t);
    });
    loadInitialData();
    setupFX();
    setupMainControls();
    setupPads();
    setupTracePad();
    resetFXUI(updateRoutingFromUI);
});

function loadInitialData() {
    const saved = localStorage.getItem("pigeonBanks");
    if (saved) {
        try {
            patternBanks = JSON.parse(saved);
            updatePadUI(patternBanks);
        } catch (e) {
            localStorage.removeItem("pigeonBanks");
        }
    }
    fetch('default_set.json').then(res => res.json()).then(data => {
        if (data.banks) {
            patternBanks = data.banks;
            updatePadUI(patternBanks);
        }
        if (data.current) loadPatternData(data.current);
    }).catch(e => console.log("Default-Set nicht gefunden."));
}

function loadPatternData(d) {
    if (d.settings) {
        document.getElementById("bpmInput").value = d.settings.bpm;
        document.getElementById("loopCheckbox").checked = d.settings.loop;
        scaleSelect.value = d.settings.scale;
        harmonizeCheckbox.checked = d.settings.harmonize;
        playbackDuration = (60 / (parseFloat(d.settings.bpm) || 120)) * 32;
    }
    const tData = d.tracks || d;
    if (Array.isArray(tData)) {
        tData.forEach((td, idx) => {
            if (!tracks[idx]) return;
            let t = tracks[idx];
            t.segments = JSON.parse(JSON.stringify(td.segments || td || []));
            if (!Array.isArray(td)) {
                t.vol = td.vol ?? 0.8;
                t.mute = td.mute ?? false;
                t.wave = td.wave ?? "sine";
                t.snap = td.snap ?? false;
            }
            const cont = t.canvas.parentElement;
            cont.querySelector(".volume-slider").value = t.vol;
            cont.querySelector(".mute-btn").style.backgroundColor = t.mute ? "#ff4444" : "";
            cont.querySelector(".snap-checkbox").checked = t.snap;
            cont.querySelectorAll(".wave-btn").forEach(btn => btn.classList.toggle("active", btn.dataset.wave === t.wave));
            redrawTrack(t, undefined, brushSelect.value, chordIntervals, chordColors);
        });
    }
}

function setupDrawing(track) {
    let drawing = false;
    const start = e => {
        e.preventDefault();
        initAudio(tracks, updateRoutingFromUI);
        const pos = getPos(e, track.canvas);
        const x = track.snap ? Math.round(pos.x / (track.canvas.width / 32)) * (track.canvas.width / 32) : pos.x;
        if (toolSelect.value === "draw") {
            drawing = true;
            let jX = 0, jY = 0;
            if (brushSelect.value === "fractal") { jX = Math.random() * 20 - 10; jY = Math.random() * 40 - 20; }
            traceCurrentSeg = { points: [{ x, y: pos.y, jX, jY }], brush: brushSelect.value, thickness: parseInt(sizeSlider.value), chordType: chordSelect.value };
            track.segments.push(traceCurrentSeg);
            redrawTrack(track, undefined, brushSelect.value, chordIntervals, chordColors);
            if (brushSelect.value === "particles") triggerParticleGrain(track, pos.y);
            else startLiveSynth(track, pos.y);
        } else erase(track, x, pos.y);
    };
    const move = e => {
        if (!drawing && toolSelect.value !== "erase") return;
        e.preventDefault();
        const pos = getPos(e, track.canvas);
        const x = track.snap ? Math.round(pos.x / (track.canvas.width / 32)) * (track.canvas.width / 32) : pos.x;
        if (drawing) {
            let jX = 0, jY = 0;
            if (brushSelect.value === "fractal") { jX = Math.random() * 20 - 10; jY = Math.random() * 40 - 20; }
            traceCurrentSeg.points.push({ x, y: pos.y, jX, jY });
            redrawTrack(track, undefined, brushSelect.value, chordIntervals, chordColors);
            if (brushSelect.value !== "particles") updateLiveSynth(track, pos.y + jY);
        } else if (toolSelect.value === "erase" && (e.buttons === 1 || e.type === "touchmove")) erase(track, x, pos.y);
    };
    const stop = () => { if (drawing) { drawing = false; undoStack.push({ trackIdx: track.index, segment: traceCurrentSeg }); stopLiveSynth(); redrawTrack(track); } };
    track.canvas.addEventListener("mousedown", start);
    track.canvas.addEventListener("mousemove", move);
    window.addEventListener("mouseup", stop);
    track.canvas.addEventListener("touchstart", start, { passive: false });
    track.canvas.addEventListener("touchmove", move, { passive: false });
    track.canvas.addEventListener("touchend", stop);
}

function erase(t, x, y) {
    t.segments = t.segments.filter(s => !s.points.some(p => Math.hypot(p.x - x, p.y - y) < 20));
    redrawTrack(t, undefined, brushSelect.value, chordIntervals, chordColors);
}

function startLiveSynth(track, y) {
    if (track.mute || track.vol < 0.01) return;
    liveNodes = [];
    liveGainNode = audioCtx.createGain();
    liveGainNode.gain.setValueAtTime(0, audioCtx.currentTime);
    liveGainNode.gain.linearRampToValueAtTime(0.3, audioCtx.currentTime + 0.01);
    
    liveFilterNode = audioCtx.createBiquadFilter();
    liveFilterNode.type = "lowpass"; liveFilterNode.frequency.value = 20000;

    let freq = mapYToFrequency(y, track.canvas.height);
    if (harmonizeCheckbox.checked) freq = quantizeFrequency(freq, scaleSelect.value);
    const ivs = (brushSelect.value === "chord") ? chordIntervals[chordSelect.value] : [0];
    ivs.forEach(iv => {
        const osc = audioCtx.createOscillator();
        osc.type = track.wave;
        osc.frequency.setValueAtTime(freq * Math.pow(2, iv / 12), audioCtx.currentTime);
        if(brushSelect.value === "fractal") {
            const sh = audioCtx.createWaveShaper(); sh.curve = getDistortionCurve();
            osc.connect(sh).connect(liveGainNode);
        } else { osc.connect(liveGainNode); }
        osc.start();
        liveNodes.push(osc);
    });
    const trackG = audioCtx.createGain();
    trackG.gain.value = track.vol;
    liveGainNode.connect(liveFilterNode).connect(trackG).connect(masterGain);
    connectTrackToFX(trackG, track.index);
    liveGainNode.out = trackG;
}

function updateLiveSynth(track, y) {
    if (!liveGainNode) return;
    let freq = mapYToFrequency(y, track.canvas.height);
    if (harmonizeCheckbox.checked) freq = quantizeFrequency(freq, scaleSelect.value);
    liveNodes.forEach((n, i) => {
        const ivs = (brushSelect.value === "chord") ? chordIntervals[chordSelect.value] : [0];
        n.frequency.setTargetAtTime(freq * Math.pow(2, (ivs[i] || 0) / 12), audioCtx.currentTime, 0.02);
    });
}

function stopLiveSynth() {
    if (!liveGainNode) return;
    const gn = liveGainNode, ns = liveNodes;
    gn.gain.setTargetAtTime(0, audioCtx.currentTime, 0.05);
    setTimeout(() => { ns.forEach(n => { try { n.stop(); } catch (e) { } }); if (gn.out) gn.out.disconnect(); if (liveFilterNode) liveFilterNode.disconnect(); gn.disconnect(); }, 100);
    liveNodes = []; liveGainNode = null; liveFilterNode = null;
}

function triggerParticleGrain(track, y) {
    if (track.mute || track.vol < 0.01) return;
    let freq = mapYToFrequency(y, track.canvas.height);
    if (harmonizeCheckbox.checked) freq = quantizeFrequency(freq, scaleSelect.value);
    const osc = audioCtx.createOscillator();
    osc.type = track.wave;
    osc.frequency.value = freq;
    const env = audioCtx.createGain();
    const now = audioCtx.currentTime;
    env.gain.setValueAtTime(0, now);
    env.gain.linearRampToValueAtTime(0.4, now + 0.01);
    env.gain.exponentialRampToValueAtTime(0.01, now + 0.15);
    const trackG = audioCtx.createGain();
    trackG.gain.value = track.vol;
    osc.connect(env).connect(trackG).connect(masterGain);
    connectTrackToFX(trackG, track.index);
    osc.start(now); osc.stop(now + 0.2); activeNodes.push(osc);
}

function scheduleTracks(start, targetCtx = audioCtx, targetDest = masterGain) {
    tracks.forEach(track => {
        const trkG = targetCtx.createGain();
        trkG.connect(targetDest);
        trkG.gain.value = track.mute ? 0 : track.vol;
        if (targetCtx === audioCtx) track.gainNode = trkG;
        
        track.segments.forEach(seg => {
            const brush = seg.brush || "standard";
            const currentWave = track.wave;
            
            if (brush === "particles") {
                seg.points.forEach(p => {
                    const t = Math.max(0, start + (p.x / track.canvas.width) * playbackDuration);
                    const osc = targetCtx.createOscillator();
                    osc.type = currentWave;
                    let f = mapYToFrequency(p.y, 100);
                    if (harmonizeCheckbox.checked) f = quantizeFrequency(f, scaleSelect.value);
                    osc.frequency.value = f;
                    const env = targetCtx.createGain();
                    env.gain.setValueAtTime(0, t);
                    env.gain.linearRampToValueAtTime(0.4, t + 0.01);
                    env.gain.exponentialRampToValueAtTime(0.01, t + 0.15);
                    osc.connect(env).connect(trkG);
                    osc.start(t); osc.stop(t + 0.2);
                    if (targetCtx === audioCtx) activeNodes.push(osc);
                });
                return;
            }

            const sorted = seg.points.slice().sort((a, b) => a.x - b.x);
            if (sorted.length < 2) return;
            let sT = Math.max(0, start + (sorted[0].x / track.canvas.width) * playbackDuration);
            let eT = Math.max(0, start + (sorted[sorted.length - 1].x / track.canvas.width) * playbackDuration);

            if (brush === "chord") {
                const intervals = chordIntervals[seg.chordType || "major"];
                intervals.forEach(iv => {
                    const osc = targetCtx.createOscillator();
                    osc.type = currentWave;
                    const g = targetCtx.createGain();
                    g.gain.setValueAtTime(0, sT);
                    g.gain.linearRampToValueAtTime(0.2, sT + 0.005);
                    g.gain.setValueAtTime(0.2, eT);
                    g.gain.linearRampToValueAtTime(0, eT + 0.05);
                    osc.connect(g).connect(trkG);
                    sorted.forEach(p => {
                        const t = Math.max(0, start + (p.x / track.canvas.width) * playbackDuration);
                        let f = mapYToFrequency(p.y, 100);
                        if (harmonizeCheckbox.checked) f = quantizeFrequency(f, scaleSelect.value);
                        osc.frequency.linearRampToValueAtTime(f * Math.pow(2, iv / 12), t);
                    });
                    osc.start(sT); osc.stop(eT + 0.1);
                    if (targetCtx === audioCtx) activeNodes.push(osc);
                });
            } else {
                const osc = targetCtx.createOscillator();
                osc.type = currentWave;
                const g = targetCtx.createGain();
                g.gain.setValueAtTime(0, sT);
                g.gain.linearRampToValueAtTime(0.3, sT + 0.02);
                g.gain.setValueAtTime(0.3, eT);
                g.gain.linearRampToValueAtTime(0, eT + 0.1);
                
                if (brush === "fractal") {
                    const sh = targetCtx.createWaveShaper();
                    sh.curve = getDistortionCurve();
                    osc.connect(sh).connect(g);
                } else {
                    osc.connect(g);
                }
                g.connect(trkG);
                sorted.forEach(p => {
                    const t = Math.max(0, start + (p.x / track.canvas.width) * playbackDuration);
                    let f = mapYToFrequency(p.y, 100);
                    if (harmonizeCheckbox.checked) f = quantizeFrequency(f, scaleSelect.value);
                    osc.frequency.linearRampToValueAtTime(f, t);
                });
                osc.start(sT); osc.stop(eT + 0.2);
                if (targetCtx === audioCtx) activeNodes.push(osc);
            }
        });
    });
}

function audioBufferToWav(buffer) {
    let n = buffer.numberOfChannels, len = buffer.length * n * 2 + 44, arr = new ArrayBuffer(len), view = new DataView(arr);
    const s32 = (v, o) => view.setUint32(o, v, true);
    s32(0x46464952, 0); s32(len - 8, 4); s32(0x45564157, 8); s32(0x20746d66, 12); s32(16, 16); 
    view.setUint16(20, 1, true); view.setUint16(22, n, true); s32(buffer.sampleRate, 24); 
    s32(buffer.sampleRate * n * 2, 28); view.setUint16(32, n * 2, true); view.setUint16(34, 16, true); 
    s32(0x61746164, 36); s32(len - 44, 40);
    let offset = 44; 
    for (let i = 0; i < buffer.length; i++) {
        for (let c = 0; c < n; c++) {
            let s = Math.max(-1, Math.min(1, buffer.getChannelData(c)[i]));
            view.setInt16(offset, (s < 0 ? s * 32768 : s * 32767), true); offset += 2;
        }
    }
    return new Blob([arr], { type: "audio/wav" });
}

function setupMainControls() {
    document.getElementById("playButton").addEventListener("click", () => {
        if (isPlaying) return;
        initAudio(tracks, updateRoutingFromUI);
        if (audioCtx.state === "suspended") audioCtx.resume();
        playbackDuration = (60 / (parseFloat(document.getElementById("bpmInput").value) || 120)) * 32;
        playbackStartTime = audioCtx.currentTime + 0.1;
        isPlaying = true;
        scheduleTracks(playbackStartTime);
        loop();
    });

    document.getElementById("stopButton").addEventListener("click", () => {
        isPlaying = false;
        cancelAnimationFrame(animationFrameId);
        activeNodes.forEach(n => { try { n.stop(); n.disconnect(); } catch (e) { } });
        activeNodes = [];
        tracks.forEach(t => { if(t.gainNode) t.gainNode.disconnect(); redrawTrack(t); });
        pigeonImg.style.transform = "scale(1)";
    });

    document.getElementById("clearButton").addEventListener("click", () => { tracks.forEach(t => { t.segments = []; redrawTrack(t, undefined, brushSelect.value, chordIntervals, chordColors); }); });
    
    document.getElementById("undoButton").addEventListener("click", () => {
        if (undoStack.length) {
            const o = undoStack.pop();
            tracks[o.trackIdx].segments.pop();
            redrawTrack(tracks[o.trackIdx], undefined, brushSelect.value, chordIntervals, chordColors);
        }
    });

    document.getElementById("exportWavButton").addEventListener("click", () => {
        const btn = document.getElementById("exportWavButton");
        btn.innerText = "Rendering...";
        setTimeout(() => {
            const bpm = parseFloat(document.getElementById("bpmInput").value) || 120;
            const dur = (60 / bpm) * 32;
            const offCtx = new OfflineAudioContext(2, 44100 * dur, 44100);
            const offMaster = offCtx.createGain();
            offMaster.gain.value = 0.5;
            offMaster.connect(offCtx.destination);
            scheduleTracks(0, offCtx, offMaster);
            offCtx.startRendering().then(buf => {
                const wav = audioBufferToWav(buf);
                const a = document.createElement("a");
                a.href = URL.createObjectURL(wav); a.download = "pigeon_loop.wav"; a.click();
                btn.innerText = "Export WAV";
            });
        }, 50);
    });

    document.getElementById("exportButton").addEventListener("click", () => {
        const data = JSON.stringify({ current: { settings: { bpm: document.getElementById("bpmInput").value, loop: document.getElementById("loopCheckbox").checked, scale: scaleSelect.value, harmonize: harmonizeCheckbox.checked }, tracks: tracks.map(t => ({ segments: t.segments, vol: t.vol, mute: t.mute, wave: t.wave, snap: t.snap })) }, banks: patternBanks });
        const blob = new Blob([data], { type: "application/json" });
        const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "pigeon_set.json"; a.click();
    });

    document.getElementById("importButton").addEventListener("click", () => document.getElementById("importFileInput").click());
    document.getElementById("importFileInput").addEventListener("change", e => {
        const r = new FileReader();
        r.onload = evt => { const d = JSON.parse(evt.target.result); if (d.banks) patternBanks = d.banks; loadPatternData(d.current || d); updatePadUI(patternBanks); };
        r.readAsText(e.target.files[0]);
    });
}

function setupPads() {
    document.getElementById("saveModeBtn").addEventListener("click", (e) => { isSaveMode = !isSaveMode; e.target.classList.toggle("active", isSaveMode); });
    document.querySelectorAll(".pad").forEach(pad => {
        pad.addEventListener("click", () => {
            const b = pad.dataset.bank, i = parseInt(pad.dataset.idx);
            if (isSaveMode) {
                patternBanks[b][i] = { settings: { bpm: document.getElementById("bpmInput").value, loop: document.getElementById("loopCheckbox").checked, scale: scaleSelect.value, harmonize: harmonizeCheckbox.checked }, tracks: tracks.map(t => ({ segments: t.segments, vol: t.vol, mute: t.mute, wave: t.wave, snap: t.snap })) };
                localStorage.setItem("pigeonBanks", JSON.stringify(patternBanks)); isSaveMode = false; document.getElementById("saveModeBtn").classList.remove("active"); updatePadUI(patternBanks);
            } else if (patternBanks[b][i]) {
                if (isPlaying) queuedPattern = { data: patternBanks[b][i], pad: pad };
                else loadPatternData(patternBanks[b][i]);
            }
        });
    });
}

function setupTracePad() {
    if (!tracePad) return;
    const getPadPos = (e) => { const r = tracePad.getBoundingClientRect(); const cx = e.touches ? e.touches[0].clientX : e.clientX; const cy = e.touches ? e.touches[0].clientY : e.clientY; return { x: (cx - r.left) * (750 / r.width), y: (cy - r.top) * (100 / r.height) }; };
    tracePad.addEventListener("mousedown", e => {
        e.preventDefault(); if (!isPlaying) return; initAudio(tracks, updateRoutingFromUI); isTracing = true;
        const pos = getPadPos(e); traceCurrentY = pos.y; isEffectMode = document.querySelectorAll('.fx-xy-link.active').length > 0;
        if (!isEffectMode) {
            const elapsed = audioCtx.currentTime - playbackStartTime; const currentX = (elapsed / playbackDuration) * 750;
            traceCurrentSeg = { points: [{ x: currentX, y: traceCurrentY }], brush: brushSelect.value, thickness: parseInt(sizeSlider.value), chordType: chordSelect.value };
            tracks[currentTargetTrack].segments.push(traceCurrentSeg); startLiveSynth(tracks[currentTargetTrack], traceCurrentY);
        }
    });
    tracePad.addEventListener("mousemove", e => { if (!isTracing || !isPlaying) return; const pos = getPadPos(e); traceCurrentY = pos.y; if (!isEffectMode) updateLiveSynth(tracks[currentTargetTrack], traceCurrentY); });
    window.addEventListener("mouseup", () => { if (isTracing) { if (!isEffectMode) stopLiveSynth(); isTracing = false; redrawTrack(tracks[currentTargetTrack]); } });
    document.querySelectorAll(".picker-btn").forEach(btn => btn.addEventListener("click", () => { document.querySelectorAll(".picker-btn").forEach(b => b.classList.remove("active")); btn.classList.add("active"); currentTargetTrack = parseInt(btn.dataset.target); }));
    document.getElementById("traceClearBtn").addEventListener("click", () => { tracks[currentTargetTrack].segments = []; redrawTrack(tracks[currentTargetTrack], undefined, brushSelect.value, chordIntervals, chordColors); });
}

function setupFX() {
    document.querySelectorAll('.knob').forEach(knob => {
        setupKnob(knob, (val) => {
            if (!audioCtx) return;
            const unit = knob.closest('.fx-unit'), title = unit.querySelector('.fx-header').innerText, param = knob.nextElementSibling.innerText;
            if (title.includes("DELAY")) {
                if (param === "TIME") fxNodes.delay.node.delayTime.setTargetAtTime(val * 1.0, audioCtx.currentTime, 0.05);
                if (param === "FDBK") fxNodes.delay.feedback.gain.setTargetAtTime(val * 0.9, audioCtx.currentTime, 0.05);
            } else if (title.includes("REVERB") && param === "MIX") fxNodes.reverb.mix.gain.setTargetAtTime(val * 1.5, audioCtx.currentTime, 0.05);
            else if (title.includes("VIBRATO")) {
                if (param === "RATE") fxNodes.vibrato.lfo.frequency.setTargetAtTime(val * 20, audioCtx.currentTime, 0.05);
                if (param === "DEPTH") fxNodes.vibrato.depthNode.gain.setTargetAtTime(val * 0.01, audioCtx.currentTime, 0.05);
            }
        });
    });
    document.querySelectorAll('.matrix-btn').forEach(btn => btn.addEventListener('click', () => { if (!audioCtx) initAudio(tracks, updateRoutingFromUI); btn.classList.toggle('active'); updateRoutingFromUI(); }));
    document.querySelectorAll('.fx-xy-link').forEach(btn => btn.addEventListener('click', () => btn.classList.toggle('active')));
}

function updateRoutingFromUI() {
    if (!audioCtx) return;
    document.querySelectorAll('.fx-unit').forEach(unit => {
        const title = unit.querySelector('.fx-header').innerText, fxName = title.includes("DELAY") ? "delay" : title.includes("REVERB") ? "reverb" : "vibrato";
        unit.querySelectorAll('.matrix-btn').forEach((btn, idx) => {
            const active = btn.classList.contains('active');
            trackSends[idx][fxName].gain.setTargetAtTime(active ? 1 : 0, audioCtx.currentTime, 0.05);
        });
        unit.querySelector('.led').classList.toggle('on', unit.querySelectorAll('.matrix-btn.active').length > 0);
    });
}

function setupTrackControls(t) {
    const cont = t.canvas.parentElement;
    cont.querySelectorAll(".wave-btn").forEach(b => b.addEventListener("click", () => { t.wave = b.dataset.wave; cont.querySelectorAll(".wave-btn").forEach(btn => btn.classList.remove("active")); b.classList.add("active"); }));
    cont.querySelector(".mute-btn").addEventListener("click", e => { t.mute = !t.mute; e.target.style.backgroundColor = t.mute ? "#ff4444" : ""; updateTrackVolume(t); });
    cont.querySelector(".volume-slider").addEventListener("input", e => { t.vol = parseFloat(e.target.value); updateTrackVolume(t); });
    cont.querySelector(".snap-checkbox").addEventListener("change", e => t.snap = e.target.checked);
}

function loop() {
    if (!isPlaying) return;
    let elapsed = audioCtx.currentTime - playbackStartTime;
    if (elapsed >= playbackDuration) {
        if (queuedPattern) { loadPatternData(queuedPattern.data); queuedPattern = null; }
        if (document.getElementById("loopCheckbox").checked) {
            playbackStartTime = audioCtx.currentTime; scheduleTracks(playbackStartTime); elapsed = 0;
            if (isTracing && traceCurrentSeg) {
                undoStack.push({ trackIdx: currentTargetTrack, segment: traceCurrentSeg });
                traceCurrentSeg = { points: [], brush: brushSelect.value, thickness: parseInt(sizeSlider.value), chordType: chordSelect.value };
                tracks[currentTargetTrack].segments.push(traceCurrentSeg);
            }
        } else { isPlaying = false; return; }
    }
    const x = (elapsed / playbackDuration) * 750;
    if (isTracing && traceCurrentSeg) {
        let jX = 0, jY = 0; if (brushSelect.value === "fractal") { jX = Math.random() * 20 - 10; jY = Math.random() * 40 - 20; }
        traceCurrentSeg.points.push({ x, y: traceCurrentY, jX, jY });
    }
    if (isTracing && isEffectMode) {
        const normX = x / 750, normY = 1.0 - (traceCurrentY / 100);
        document.querySelectorAll('.fx-xy-link.active').forEach(l => {
            const t = l.closest('.fx-unit').querySelector('.fx-header').innerText;
            if (t.includes("DELAY")) { fxNodes.delay.node.delayTime.setTargetAtTime(normX * 1.0, audioCtx.currentTime, 0.05); fxNodes.delay.feedback.gain.setTargetAtTime(normY * 0.9, audioCtx.currentTime, 0.05); }
            else if (t.includes("VIBRATO")) { fxNodes.vibrato.lfo.frequency.setTargetAtTime(normX * 20, audioCtx.currentTime, 0.05); fxNodes.vibrato.depthNode.gain.setTargetAtTime(normY * 0.01, audioCtx.currentTime, 0.05); }
            else if (t.includes("REVERB")) { fxNodes.reverb.mix.gain.setTargetAtTime(normY * 1.5, audioCtx.currentTime, 0.05); }
        });
    }
    tracks.forEach(t => redrawTrack(t, x, brushSelect.value, chordIntervals, chordColors));
    const dataArray = new Uint8Array(analyser.frequencyBinCount); analyser.getByteFrequencyData(dataArray);
    let avg = dataArray.reduce((a, b) => a + b) / dataArray.length;
    let d = avg - lastAvg; lastAvg = avg;
    pigeonImg.style.transform = `scale(${1 + Math.min(0.2, d / 100)}, ${1 - Math.min(0.5, d / 50)})`;
    animationFrameId = requestAnimationFrame(loop);
}