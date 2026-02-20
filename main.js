import { drawGrid, redrawTrack } from './canvas.js';
import { 
    initAudio, audioCtx, masterGain, analyser, fxNodes, trackSends, 
    updateTrackVolume, connectTrackToFX, getDistortionCurve 
} from './audio.js';
import { setupKnob, updatePadUI, resetFXUI } from './ui.js';

// --- Globaler App-Status (Synchronisiert mit script.js) ---
let patternBanks = { A: [null, null, null, null], B: [null, null, null, null], C: [null, null, null, null] };
let isPlaying = false, isSaveMode = false, playbackStartTime = 0, playbackDuration = 0, animationFrameId;
let undoStack = [], liveNodes = [], liveGainNode = null, activeNodes = [], lastAvg = 0;
let currentTargetTrack = 0, traceCurrentY = 50, isTracing = false, isEffectMode = false, traceCurrentSeg = null, queuedPattern = null;

const chordIntervals = { major: [0, 4, 7], minor: [0, 3, 7], diminished: [0, 3, 6], augmented: [0, 4, 8], sus2: [0, 2, 7], sus4: [0, 5, 7] };
const chordColors = ['#FF5733', '#33FF57', '#3357FF'];

// --- DOM Elemente ---
const toolSelect = document.getElementById("toolSelect"), brushSelect = document.getElementById("brushSelect"), sizeSlider = document.getElementById("brushSizeSlider"), chordSelect = document.getElementById("chordSelect"), harmonizeCheckbox = document.getElementById("harmonizeCheckbox"), scaleSelect = document.getElementById("scaleSelect"), pigeonImg = document.getElementById("pigeon"), tracePad = document.getElementById("trace-pad");

const tracks = Array.from(document.querySelectorAll(".track-container")).map((c, i) => ({
    index: i, canvas: c.querySelector("canvas"), ctx: c.querySelector("canvas").getContext("2d"), segments: [], wave: "sine", mute: false, vol: 0.8, snap: false, gainNode: null
}));

// --- Hilfsfunktionen ---
function mapY(y, h) { return Math.max(20, Math.min(1000-(y/h)*920, 20000)); }
function quantize(f) { const s=scaleSelect.value; let m=Math.round(69+12*Math.log2(f/440)), pat=(s==="major")?[0,2,4,5,7,9,11]:(s==="minor")?[0,2,3,5,7,8,10]:[0,3,5,7,10], mod=m%12, b=pat[0], md=99; pat.forEach(p=>{if(Math.abs(p-mod)<md){md=Math.abs(p-mod);b=p;}}); return 440*Math.pow(2,(m-mod+b-69)/12); }
function getPos(e, c) { const r=c.getBoundingClientRect(); const cx=e.touches?e.touches[0].clientX:e.clientX, cy=e.touches?e.touches[0].clientY:e.clientY; return {x:(cx-r.left)*(c.width/r.width), y:(cy-r.top)*(c.height/r.height)}; }

// --- Initialisierung ---
document.addEventListener("DOMContentLoaded", () => {
    tracks.forEach(t => { drawGrid(t); setupTrackControls(t); setupDrawing(t); });
    loadInitialData();
    setupFX();
    setupMainControls();
    setupPads();
    setupTracePad();
    resetFXUI(updateRoutingFromUI);
});

// --- Datenverwaltung ---
function loadInitialData() {
    const saved = localStorage.getItem("pigeonBanks");
    if (saved) { try { patternBanks = JSON.parse(saved); updatePadUI(patternBanks); } catch(e) { localStorage.removeItem("pigeonBanks"); } }
    fetch('default_set.json').then(res => res.json()).then(data => { if(data.banks) { patternBanks = data.banks; updatePadUI(patternBanks); } if(data.current) loadPatternData(data.current); }).catch(e => console.log("Default Set nicht gefunden."));
}

function loadPatternData(d) {
    if(d.settings) { 
        document.getElementById("bpmInput").value = d.settings.bpm; 
        document.getElementById("loopCheckbox").checked = d.settings.loop; 
        scaleSelect.value = d.settings.scale; 
        harmonizeCheckbox.checked = d.settings.harmonize; 
        playbackDuration = (60 / (parseFloat(d.settings.bpm) || 120)) * 32;
    }
    const tData = d.tracks || d;
    if(Array.isArray(tData)) {
        tData.forEach((td, idx) => {
            if(!tracks[idx]) return; let t = tracks[idx];
            t.segments = JSON.parse(JSON.stringify(td.segments || td || [])); 
            if(!Array.isArray(td)) { t.vol = td.vol ?? 0.8; t.mute = td.mute ?? false; t.wave = td.wave ?? "sine"; t.snap = td.snap ?? false; }
            const cont = t.canvas.parentElement; cont.querySelector(".volume-slider").value = t.vol; cont.querySelector(".mute-btn").style.backgroundColor = t.mute ? "#ff4444" : ""; cont.querySelector(".snap-checkbox").checked = t.snap;
            cont.querySelectorAll(".wave-btn").forEach(btn => btn.classList.toggle("active", btn.dataset.wave === t.wave));
            redrawTrack(t, undefined, brushSelect.value, chordIntervals, chordColors);
        });
    }
}

// --- Zeichen-Logik ---
function setupDrawing(track) {
    let drawing = false;
    const start = e => {
        e.preventDefault(); initAudio(tracks, updateRoutingFromUI); 
        const pos = getPos(e, track.canvas); 
        const x = track.snap ? Math.round(pos.x/(track.canvas.width/32))*(track.canvas.width/32) : pos.x;
        if(toolSelect.value === "draw") {
            drawing = true; let jX=0, jY=0; if(brushSelect.value==="fractal"){ jX=Math.random()*20-10; jY=Math.random()*40-20; }
            traceCurrentSeg = { points: [{x, y:pos.y, jX, jY}], brush: brushSelect.value, thickness: parseInt(sizeSlider.value), chordType: chordSelect.value };
            track.segments.push(traceCurrentSeg); redrawTrack(track, undefined, brushSelect.value, chordIntervals, chordColors);
            if(brushSelect.value === "particles") triggerParticleGrain(track, pos.y); else startLiveSynth(track, pos.y);
        } else erase(track, x, pos.y);
    };
    const move = e => {
        if(!drawing && toolSelect.value!=="erase") return; e.preventDefault(); const pos = getPos(e, track.canvas);
        const x = track.snap ? Math.round(pos.x/(track.canvas.width/32))*(track.canvas.width/32) : pos.x;
        if(drawing) {
            let jX=0, jY=0; if(brushSelect.value==="fractal"){ jX=Math.random()*20-10; jY=Math.random()*40-20; }
            traceCurrentSeg.points.push({x, y:pos.y, jX, jY}); redrawTrack(track, undefined, brushSelect.value, chordIntervals, chordColors);
            if(brushSelect.value !== "particles") updateLiveSynth(track, pos.y+jY);
        } else if(toolSelect.value==="erase" && (e.buttons===1 || e.type==="touchmove")) erase(track, x, pos.y);
    };
    const stop = () => { if(drawing) { drawing = false; undoStack.push({trackIdx: track.index, segment: traceCurrentSeg}); stopLiveSynth(); } };
    track.canvas.addEventListener("mousedown", start); track.canvas.addEventListener("mousemove", move); window.addEventListener("mouseup", stop);
    track.canvas.addEventListener("touchstart", start, {passive:false}); track.canvas.addEventListener("touchmove", move, {passive:false}); track.canvas.addEventListener("touchend", stop);
}

function erase(t,x,y) { t.segments=t.segments.filter(s=>!s.points.some(p=>Math.hypot(p.x-x,p.y-y)<20)); redrawTrack(t, undefined, brushSelect.value, chordIntervals, chordColors); }

// --- Audio Engine: Live Synthese & Scheduling ---
function startLiveSynth(track, y) {
    if(track.mute || track.vol < 0.01) return;
    liveNodes = []; liveGainNode = audioCtx.createGain(); liveGainNode.gain.setValueAtTime(0, audioCtx.currentTime); liveGainNode.gain.linearRampToValueAtTime(0.3, audioCtx.currentTime+0.01);
    let freq = mapY(y, track.canvas.height); if(harmonizeCheckbox.checked) freq = quantize(freq);
    const ivs = (brushSelect.value==="chord") ? chordIntervals[chordSelect.value] : [0];
    ivs.forEach(iv => { 
        const osc = audioCtx.createOscillator(); osc.type = track.wave; osc.frequency.value = freq * Math.pow(2, iv/12);
        if(brushSelect.value === "fractal") { const sh = audioCtx.createWaveShaper(); sh.curve = getDistortionCurve(); osc.connect(sh).connect(liveGainNode); }
        else osc.connect(liveGainNode); osc.start(); liveNodes.push(osc); 
    });
    const trackG = audioCtx.createGain(); trackG.gain.value = track.vol;
    liveGainNode.connect(trackG).connect(masterGain); connectTrackToFX(trackG, track.index); liveGainNode.out = trackG;
}

function updateLiveSynth(track, y) { if(!liveGainNode) return; let freq = mapY(y, track.canvas.height); if(harmonizeCheckbox.checked) freq = quantize(freq); liveNodes.forEach((n, i) => { const ivs = (brushSelect.value==="chord") ? chordIntervals[chordSelect.value] : [0]; n.frequency.setTargetAtTime(freq * Math.pow(2, (ivs[i]||0)/12), audioCtx.currentTime, 0.02); }); }
function stopLiveSynth() { if(!liveGainNode) return; const gn = liveGainNode, ns = liveNodes; gn.gain.setTargetAtTime(0, audioCtx.currentTime, 0.05); setTimeout(() => { ns.forEach(n=>n.stop()); if(gn.out) gn.out.disconnect(); gn.disconnect(); }, 100); liveNodes = []; liveGainNode = null; }

function triggerParticleGrain(track, y) {
    if (track.mute || track.vol < 0.01) return;
    let freq = mapY(y, track.canvas.height); if (harmonizeCheckbox.checked) freq = quantize(freq);
    const osc = audioCtx.createOscillator(); osc.type = track.wave; osc.frequency.value = freq;
    const env = audioCtx.createGain(); const now = audioCtx.currentTime;
    env.gain.setValueAtTime(0, now); env.gain.linearRampToValueAtTime(0.4, now + 0.01); env.gain.exponentialRampToValueAtTime(0.01, now + 0.15);
    const trackG = audioCtx.createGain(); trackG.gain.value = track.vol;
    osc.connect(env).connect(trackG).connect(masterGain); connectTrackToFX(trackG, track.index);
    osc.start(now); osc.stop(now + 0.2); activeNodes.push(osc);
}

function scheduleTracks(start) {
    tracks.forEach(track => {
        const trkG = audioCtx.createGain(); trkG.connect(masterGain); trkG.gain.value = track.mute ? 0 : track.vol;
        track.gainNode = trkG; connectTrackToFX(trkG, track.index);
        track.segments.forEach(seg => {
            const brush = seg.brush || "standard";
            if(brush==="particles") { 
                seg.points.forEach(p => { 
                    const t = Math.max(0, start + (p.x/track.canvas.width)*playbackDuration); const osc = audioCtx.createOscillator(); osc.type = track.wave; 
                    let f = mapY(p.y, 100); if(harmonizeCheckbox.checked) f = quantize(f); osc.frequency.value = f;
                    const env = audioCtx.createGain(); env.gain.setValueAtTime(0, t); env.gain.linearRampToValueAtTime(0.4, t+0.01); env.gain.exponentialRampToValueAtTime(0.01, t+0.15); 
                    osc.connect(env).connect(trkG); osc.start(t); osc.stop(t+0.2); activeNodes.push(osc); 
                }); return; 
            }
            const sorted = seg.points.slice().sort((a,b)=>a.x-b.x); if(sorted.length<2) return;
            let sT = Math.max(0, start + (sorted[0].x/track.canvas.width)*playbackDuration), eT = Math.max(0, start + (sorted[sorted.length-1].x/track.canvas.width)*playbackDuration);
            if(brush==="chord") { 
                chordIntervals[seg.chordType||"major"].forEach(iv => { 
                    const osc = audioCtx.createOscillator(); osc.type=track.wave; const g=audioCtx.createGain(); g.gain.setValueAtTime(0, sT); g.gain.linearRampToValueAtTime(0.2, sT+0.005); g.gain.setValueAtTime(0.2, eT); g.gain.linearRampToValueAtTime(0, eT+0.05); 
                    osc.connect(g).connect(trkG); sorted.forEach(p=>{ const t = Math.max(0, start + (p.x/track.canvas.width)*playbackDuration); let f = mapY(p.y, 100); if(harmonizeCheckbox.checked) f = quantize(f); osc.frequency.linearRampToValueAtTime(f * Math.pow(2, iv/12), t); }); 
                    osc.start(sT); osc.stop(eT+0.1); activeNodes.push(osc); 
                }); return; 
            }
            const osc = audioCtx.createOscillator(); osc.type=track.wave; const g=audioCtx.createGain(); g.gain.setValueAtTime(0, sT); g.gain.linearRampToValueAtTime(0.3, sT+0.02); g.gain.setValueAtTime(0.3, eT); g.gain.linearRampToValueAtTime(0, eT+0.1); 
            if(brush==="fractal"){ const sh = audioCtx.createWaveShaper(); sh.curve=getDistortionCurve(); osc.connect(sh).connect(g); } else { osc.connect(g); }
            g.connect(trkG); sorted.forEach(p=>{ const t = Math.max(0, start + (p.x/track.canvas.width)*playbackDuration); let f = mapY(p.y, 100); if(harmonizeCheckbox.checked) f = quantize(f); osc.frequency.linearRampToValueAtTime(f, t); }); 
            osc.start(sT); osc.stop(eT+0.2); activeNodes.push(osc); 
        });
    });
}

// --- Steuerungs-Elemente ---
function setupMainControls() {
    document.getElementById("playButton").addEventListener("click", () => {
        if(isPlaying) return; initAudio(tracks, updateRoutingFromUI);
        playbackDuration = (60 / (parseFloat(document.getElementById("bpmInput").value) || 120)) * 32;
        playbackStartTime = audioCtx.currentTime + 0.1; isPlaying = true; scheduleTracks(playbackStartTime); loop();
    });
    document.getElementById("stopButton").addEventListener("click", () => {
        isPlaying = false; cancelAnimationFrame(animationFrameId);
        activeNodes.forEach(n => { try { n.stop(); n.disconnect(); } catch(e){} }); activeNodes = [];
        tracks.forEach(t => redrawTrack(t, undefined, brushSelect.value, chordIntervals, chordColors)); pigeonImg.style.transform = "scale(1)";
    });
    document.getElementById("clearButton").addEventListener("click", () => { tracks.forEach(t=>{t.segments=[]; redrawTrack(t, undefined, brushSelect.value, chordIntervals, chordColors);}); });
    document.getElementById("undoButton").addEventListener("click", () => { if(undoStack.length){const o=undoStack.pop(); tracks[o.trackIdx].segments.pop(); redrawTrack(tracks[o.trackIdx], undefined, brushSelect.value, chordIntervals, chordColors);} });
    
    // Export/Import
    document.getElementById("exportButton").addEventListener("click", () => { 
        const data = JSON.stringify({current:{settings:{bpm:document.getElementById("bpmInput").value,loop:document.getElementById("loopCheckbox").checked,scale:scaleSelect.value,harmonize:harmonizeCheckbox.checked},tracks:tracks.map(t=>({segments:t.segments,vol:t.vol,mute:t.mute,wave:t.wave,snap:t.snap}))},banks:patternBanks});
        const blob = new Blob([data], {type: "application/json"}); const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "pigeon_set.json"; a.click();
    });
    document.getElementById("importButton").addEventListener("click", () => document.getElementById("importFileInput").click());
    document.getElementById("importFileInput").addEventListener("change", e => { 
        const r = new FileReader(); r.onload = evt => { const d = JSON.parse(evt.target.result); if(d.banks) patternBanks = d.banks; loadPatternData(d.current||d); updatePadUI(patternBanks); }; r.readAsText(e.target.files[0]);
    });
}

// --- Pattern & FX Pads ---
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
            traceCurrentSeg = { points: [{x: currentX, y: traceCurrentY}], brush: brushSelect.value, thickness: parseInt(sizeSlider.value), chordType: chordSelect.value };
            tracks[currentTargetTrack].segments.push(traceCurrentSeg); startLiveSynth(tracks[currentTargetTrack], traceCurrentY);
        }
    });
    tracePad.addEventListener("mousemove", e => { if (!isTracing || !isPlaying) return; const pos = getPadPos(e); traceCurrentY = pos.y; if (!isEffectMode) updateLiveSynth(tracks[currentTargetTrack], traceCurrentY); });
    window.addEventListener("mouseup", () => { if (isTracing) { if (!isEffectMode) stopLiveSynth(); isTracing = false; } });

    document.querySelectorAll(".picker-btn").forEach(btn => btn.addEventListener("click", () => { document.querySelectorAll(".picker-btn").forEach(b=>b.classList.remove("active")); btn.classList.add("active"); currentTargetTrack = parseInt(btn.dataset.target); }));
    document.getElementById("traceClearBtn").addEventListener("click", () => { tracks[currentTargetTrack].segments = []; redrawTrack(tracks[currentTargetTrack], undefined, brushSelect.value, chordIntervals, chordColors); });
}

// --- FX Rack Logic ---
function setupFX() {
    document.querySelectorAll('.knob').forEach(knob => {
        setupKnob(knob, (val) => {
            if(!audioCtx) return; const unit = knob.closest('.fx-unit'), title = unit.querySelector('.fx-header').innerText, param = knob.nextElementSibling.innerText;
            if(title.includes("DELAY")) { if(param === "TIME") fxNodes.delay.node.delayTime.setTargetAtTime(val * 1.0, audioCtx.currentTime, 0.05); if(param === "FDBK") fxNodes.delay.feedback.gain.setTargetAtTime(val * 0.9, audioCtx.currentTime, 0.05); }
            else if(title.includes("REVERB") && param === "MIX") fxNodes.reverb.mix.gain.setTargetAtTime(val * 1.5, audioCtx.currentTime, 0.05);
            else if(title.includes("VIBRATO")) { if(param === "RATE") fxNodes.vibrato.lfo.frequency.setTargetAtTime(val * 20, audioCtx.currentTime, 0.05); if(param === "DEPTH") fxNodes.vibrato.depthNode.gain.setTargetAtTime(val * 0.01, audioCtx.currentTime, 0.05); }
        });
    });
    document.querySelectorAll('.matrix-btn').forEach(btn => btn.addEventListener('click', () => { if(!audioCtx) initAudio(tracks, updateRoutingFromUI); btn.classList.toggle('active'); updateRoutingFromUI(); }));
    document.querySelectorAll('.fx-xy-link').forEach(btn => btn.addEventListener('click', () => btn.classList.toggle('active')));
}

function updateRoutingFromUI() {
    if(!audioCtx) return;
    document.querySelectorAll('.fx-unit').forEach(unit => {
        const title = unit.querySelector('.fx-header').innerText, fxName = title.includes("DELAY") ? "delay" : title.includes("REVERB") ? "reverb" : "vibrato";
        unit.querySelectorAll('.matrix-btn').forEach((btn, idx) => {
            trackSends[idx][fxName].gain.setTargetAtTime(btn.classList.contains('active') ? 1 : 0, audioCtx.currentTime, 0.05);
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

// --- Haupt-Loop ---
function loop() {
    if(!isPlaying) return;
    let elapsed = audioCtx.currentTime - playbackStartTime;
    if(elapsed >= playbackDuration) { 
        if(queuedPattern) { loadPatternData(queuedPattern.data); queuedPattern = null; }
        playbackStartTime = audioCtx.currentTime; scheduleTracks(playbackStartTime); elapsed = 0; 
    }
    const x = (elapsed / playbackDuration) * 750;
    
    // Performance Modulation
    if (isTracing && isEffectMode) {
        const normX = x / 750, normY = 1.0 - (traceCurrentY / 100);
        document.querySelectorAll('.fx-xy-link.active').forEach(l => {
            const t = l.closest('.fx-unit').querySelector('.fx-header').innerText;
            if(t.includes("DELAY")) { fxNodes.delay.node.delayTime.setTargetAtTime(normX * 1.0, audioCtx.currentTime, 0.05); fxNodes.delay.feedback.gain.setTargetAtTime(normY * 0.9, audioCtx.currentTime, 0.05); }
            else if(t.includes("VIBRATO")) { fxNodes.vibrato.lfo.frequency.setTargetAtTime(normX * 20, audioCtx.currentTime, 0.05); fxNodes.vibrato.depthNode.gain.setTargetAtTime(normY * 0.01, audioCtx.currentTime, 0.05); }
            else if(t.includes("REVERB")) { fxNodes.reverb.mix.gain.setTargetAtTime(normY * 1.5, audioCtx.currentTime, 0.05); }
        });
    }

    tracks.forEach(t => redrawTrack(t, x, brushSelect.value, chordIntervals, chordColors));
    
    // Viz
    analyser.getByteFrequencyData(new Uint8Array(analyser.frequencyBinCount));
    let avg = (new Uint8Array(analyser.frequencyBinCount)).reduce((a,b)=>a+b)/analyser.frequencyBinCount;
    pigeonImg.style.transform = `scale(${1 + avg/400})`;
    
    animationFrameId = requestAnimationFrame(loop);
}