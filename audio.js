export let audioCtx, masterGain, analyser, fxNodes, trackSends = [{}, {}, {}, {}];

export function getDistortionCurve() {
  const n = 22050, curve = new Float32Array(n), amount = 80;
  for (let i = 0; i < n; ++i) { let x = i * 2 / n - 1; curve[i] = (3 + amount) * x * 20 * (Math.PI / 180) / (Math.PI + amount * Math.abs(x)); }
  return curve;
}

export function generateReverbIR(ctx, duration) {
    const sampleRate = ctx.sampleRate; const length = sampleRate * duration; const impulse = ctx.createBuffer(2, length, sampleRate);
    const left = impulse.getChannelData(0); const right = impulse.getChannelData(1);
    for (let i = 0; i < length; i++) { const decay = Math.exp(-i / (sampleRate * (duration/3))); left[i] = (Math.random() * 2 - 1) * decay; right[i] = (Math.random() * 2 - 1) * decay; }
    return impulse;
}

export function initAudio(tracks, updateRoutingFromUI) { 
    if(audioCtx) return; audioCtx = new (window.AudioContext || window.webkitAudioContext)(); 
    masterGain = audioCtx.createGain(); masterGain.gain.value = 0.5; 
    analyser = audioCtx.createAnalyser(); analyser.fftSize = 64; 
    const compressor = audioCtx.createDynamicsCompressor(); 
    masterGain.connect(compressor).connect(analyser).connect(audioCtx.destination); 

    fxNodes = {
        delay: { in: audioCtx.createGain(), node: audioCtx.createDelay(), feedback: audioCtx.createGain(), time: 0.4, fdbk: 0.0 },
        reverb: { in: audioCtx.createGain(), node: audioCtx.createConvolver(), mix: audioCtx.createGain(), decay: 0.5, mixVal: 0.0 },
        vibrato: { in: audioCtx.createGain(), node: audioCtx.createDelay(), lfo: audioCtx.createOscillator(), depthNode: audioCtx.createGain(), rate: 5, depth: 0.0 }
    };

    fxNodes.delay.node.delayTime.value = fxNodes.delay.time; fxNodes.delay.feedback.gain.value = fxNodes.delay.fdbk;
    fxNodes.delay.in.connect(fxNodes.delay.node); fxNodes.delay.node.connect(fxNodes.delay.feedback); fxNodes.delay.feedback.connect(fxNodes.delay.node); fxNodes.delay.node.connect(masterGain);

    fxNodes.reverb.node.buffer = generateReverbIR(audioCtx, 2.0); fxNodes.reverb.mix.gain.value = fxNodes.reverb.mixVal;
    fxNodes.reverb.in.connect(fxNodes.reverb.node); fxNodes.reverb.node.connect(fxNodes.reverb.mix); fxNodes.reverb.mix.connect(masterGain);

    fxNodes.vibrato.node.delayTime.value = 0.005; fxNodes.vibrato.lfo.frequency.value = fxNodes.vibrato.rate; fxNodes.vibrato.depthNode.gain.value = fxNodes.vibrato.depth;
    fxNodes.vibrato.lfo.connect(fxNodes.vibrato.depthNode); fxNodes.vibrato.depthNode.connect(fxNodes.vibrato.node.delayTime); fxNodes.vibrato.lfo.start();
    fxNodes.vibrato.in.connect(fxNodes.vibrato.node); fxNodes.vibrato.node.connect(masterGain);

    tracks.forEach((t, i) => {
        ['delay', 'reverb', 'vibrato'].forEach(fx => { let send = audioCtx.createGain(); send.gain.value = 0; send.connect(fxNodes[fx].in); trackSends[i][fx] = send; });
    });
    updateRoutingFromUI(); 
}

export function updateTrackVolume(t) { if(t.gainNode && audioCtx) t.gainNode.gain.setTargetAtTime(t.mute ? 0 : t.vol, audioCtx.currentTime, 0.05); }
export function connectTrackToFX(trackGainNode, trackIndex) { if(!trackGainNode || !audioCtx) return; ['delay', 'reverb', 'vibrato'].forEach(fx => { trackGainNode.connect(trackSends[trackIndex][fx]); }); }