import { drawGrid, redrawTrack } from './canvas.js';
import { initAudio, audioCtx, masterGain, analyser, fxNodes, trackSends, updateTrackVolume, connectTrackToFX, getDistortionCurve } from './audio.js';
import { setupKnob, updatePadUI, resetFXUI } from './ui.js';

let patternBanks = { A: [null, null, null, null], B: [null, null, null, null], C: [null, null, null, null] };
let isSaveMode = false, isPlaying = false, playbackStartTime = 0, playbackDuration = 0, animationFrameId;
let undoStack = [], liveNodes = [], liveGainNode = null, liveFilterNode = null, activeNodes = [];
let currentTargetTrack = 0, traceCurrentY = 50, isTracing = false, isEffectMode = false, traceCurrentSeg = null;

const chordIntervals = { major: [0, 4, 7], minor: [0, 3, 7], diminished: [0, 3, 6], augmented: [0, 4, 8], sus2: [0, 2, 7], sus4: [0, 5, 7] };
const chordColors = ['#FF5733', '#33FF57', '#3357FF'];

const toolSelect = document.getElementById("toolSelect"), brushSelect = document.getElementById("brushSelect"), sizeSlider = document.getElementById("brushSizeSlider"), chordSelect = document.getElementById("chordSelect"), harmonizeCheckbox = document.getElementById("harmonizeCheckbox"), scaleSelect = document.getElementById("scaleSelect"), pigeonImg = document.getElementById("pigeon"), tracePad = document.getElementById("trace-pad");

const tracks = Array.from(document.querySelectorAll(".track-container")).map((c, i) => ({
    index: i, canvas: c.querySelector("canvas"), ctx: c.querySelector("canvas").getContext("2d"), segments: [], wave: "sine", mute: false, vol: 0.8, snap: false, gainNode: null
}));

// --- HELPERS ---
function mapY(y, h) { return Math.max(20, Math.min(1000-(y/h)*920, 20000)); }
function quantize(f) { const s=scaleSelect.value; let m=Math.round(69+12*Math.log2(f/440)), pat=(s==="major")?[0,2,4,5,7,9,11]:(s==="minor")?[0,2,3,5,7,8,10]:[0,3,5,7,10], mod=m%12, b=pat[0], md=99; pat.forEach(p=>{if(Math.abs(p-mod)<md){md=Math.abs(p-mod);b=p;}}); return 440*Math.pow(2,(m-mod+b-69)/12); }
function getPos(e, c) { const r=c.getBoundingClientRect(); const cx=e.touches?e.touches[0].clientX:e.clientX, cy=e.touches?e.touches[0].clientY:e.clientY; return {x:(cx-r.left)*(c.width/r.width), y:(cy-r.top)*(c.height/r.height)}; }

// --- BOOT ---
document.addEventListener("DOMContentLoaded", () => {
    tracks.forEach(t => { drawGrid(t); setupTrackControls(t); setupDrawing(t); });
    loadPatternData();
    setupFX();
    setupMainControls();
});

function loadPatternData() {
    const saved = localStorage.getItem("pigeonBanks");
    if (saved) { patternBanks = JSON.parse(saved); updatePadUI(patternBanks); }
    fetch('default_set.json').then(res => res.json()).then(data => { if(data.banks) { patternBanks = data.banks; updatePadUI(patternBanks); } });
}

function setupDrawing(track) {
    let drawing = false;
    const start = e => {
        e.preventDefault(); initAudio(tracks, updateRoutingFromUI); 
        const pos = getPos(e, track.canvas); 
        if(toolSelect.value === "draw") {
            drawing = true; traceCurrentSeg = { points: [pos], brush: brushSelect.value, thickness: parseInt(sizeSlider.value), chordType: chordSelect.value };
            track.segments.push(traceCurrentSeg); redrawTrack(track, undefined, brushSelect.value, chordIntervals, chordColors);
            startLiveSynth(track, pos.y);
        }
    };
    const move = e => { if(drawing) { const pos = getPos(e, track.canvas); traceCurrentSeg.points.push(pos); redrawTrack(track, undefined, brushSelect.value, chordIntervals, chordColors); updateLiveSynth(track, pos.y); } };
    const stop = () => { if(drawing) { drawing = false; stopLiveSynth(); } };
    track.canvas.addEventListener("mousedown", start); track.canvas.addEventListener("mousemove", move); window.addEventListener("mouseup", stop);
}

function startLiveSynth(track, y) {
    if(track.mute || track.vol < 0.01) return;
    liveNodes = []; liveGainNode = audioCtx.createGain(); liveGainNode.gain.setValueAtTime(0, audioCtx.currentTime); liveGainNode.gain.linearRampToValueAtTime(0.3, audioCtx.currentTime+0.01);
    let freq = mapY(y, track.canvas.height); if(harmonizeCheckbox.checked) freq = quantize(freq);
    const ivs = (brushSelect.value==="chord") ? chordIntervals[chordSelect.value] : [0];
    ivs.forEach(iv => { 
        const osc = audioCtx.createOscillator(); osc.type = track.wave; osc.frequency.value = freq * Math.pow(2, iv/12);
        osc.connect(liveGainNode); osc.start(); liveNodes.push(osc); 
    });
    const trackG = audioCtx.createGain(); trackG.gain.value = track.vol;
    liveGainNode.connect(trackG).connect(masterGain); connectTrackToFX(trackG, track.index); liveGainNode.out = trackG;
}

function updateLiveSynth(track, y) { if(!liveGainNode) return; let freq = mapY(y, track.canvas.height); if(harmonizeCheckbox.checked) freq = quantize(freq); liveNodes.forEach((n, i) => { const ivs = (brushSelect.value==="chord") ? chordIntervals[chordSelect.value] : [0]; n.frequency.setTargetAtTime(freq * Math.pow(2, (ivs[i]||0)/12), audioCtx.currentTime, 0.02); }); }
function stopLiveSynth() { if(!liveGainNode) return; const gn = liveGainNode, ns = liveNodes; gn.gain.setTargetAtTime(0, audioCtx.currentTime, 0.05); setTimeout(() => { ns.forEach(n=>n.stop()); if(gn.out) gn.out.disconnect(); gn.disconnect(); }, 100); liveNodes = []; liveGainNode = null; }

function setupMainControls() {
    document.getElementById("playButton").addEventListener("click", () => {
        if(isPlaying) return; initAudio(tracks, updateRoutingFromUI);
        playbackDuration = (60 / (parseFloat(document.getElementById("bpmInput").value) || 120)) * 32;
        playbackStartTime = audioCtx.currentTime + 0.1; isPlaying = true; loop();
    });
    document.getElementById("stopButton").addEventListener("click", () => { isPlaying = false; cancelAnimationFrame(animationFrameId); });
}

function loop() {
    if(!isPlaying) return;
    let elapsed = audioCtx.currentTime - playbackStartTime;
    if(elapsed >= playbackDuration) { playbackStartTime = audioCtx.currentTime; elapsed = 0; }
    const x = (elapsed / playbackDuration) * 750;
    tracks.forEach(t => redrawTrack(t, x, brushSelect.value, chordIntervals, chordColors));
    animationFrameId = requestAnimationFrame(loop);
}

function updateRoutingFromUI() {
    if(!audioCtx) return;
    document.querySelectorAll('.fx-unit').forEach(unit => {
        const title = unit.querySelector('.fx-header').innerText, fxName = title.includes("DELAY") ? "delay" : title.includes("REVERB") ? "reverb" : "vibrato";
        unit.querySelectorAll('.matrix-btn').forEach((btn, idx) => {
            const active = btn.classList.contains('active');
            trackSends[idx][fxName].gain.setTargetAtTime(active ? 1 : 0, audioCtx.currentTime, 0.05);
        });
        unit.querySelector('.led').classList.toggle('on', unit.querySelectorAll('.matrix-btn.active').length > 0);
    });
}

function setupFX() {
    document.querySelectorAll('.knob').forEach(knob => {
        setupKnob(knob, (val) => {
            if(!audioCtx) return; const unit = knob.closest('.fx-unit'), title = unit.querySelector('.fx-header').innerText, param = knob.nextElementSibling.innerText;
            if(title.includes("DELAY")) { if(param === "TIME") fxNodes.delay.node.delayTime.setTargetAtTime(val, audioCtx.currentTime, 0.05); if(param === "FDBK") fxNodes.delay.feedback.gain.setTargetAtTime(val * 0.9, audioCtx.currentTime, 0.05); }
            else if(title.includes("REVERB") && param === "MIX") fxNodes.reverb.mix.gain.setTargetAtTime(val * 1.5, audioCtx.currentTime, 0.05);
        });
    });
    document.querySelectorAll('.matrix-btn').forEach(btn => btn.addEventListener('click', () => { if(!audioCtx) initAudio(tracks, updateRoutingFromUI); btn.classList.toggle('active'); updateRoutingFromUI(); }));
}

function setupTrackControls(t) {
    const cont = t.canvas.parentElement;
    cont.querySelector(".mute-btn").addEventListener("click", e => { t.mute = !t.mute; e.target.style.backgroundColor = t.mute ? "#ff4444" : ""; updateTrackVolume(t); });
    cont.querySelector(".volume-slider").addEventListener("input", e => { t.vol = parseFloat(e.target.value); updateTrackVolume(t); });
}