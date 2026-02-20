export let audioCtx, masterGain, analyser, fxNodes, trackSends = [{}, {}, {}, {}];

export function getDistortionCurve() {
    const n = 22050, curve = new Float32Array(n), amount = 80;
    for (let i = 0; i < n; ++i) { 
        let x = i * 2 / n - 1; 
        curve[i] = (3 + amount) * x * 20 * (Math.PI / 180) / (Math.PI + amount * Math.abs(x)); 
    }
    return curve;
}

function generateReverbIR(ctx, duration) {
    const sampleRate = ctx.sampleRate;
    const length = sampleRate * duration;
    const impulse = ctx.createBuffer(2, length, sampleRate);
    for (let c = 0; c < 2; c++) {
        const data = impulse.getChannelData(c);
        for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (sampleRate * 0.7));
    }
    return impulse;
}

export function initAudio(tracks, updateRoutingFromUI) { 
    if(audioCtx) return; 
    audioCtx = new (window.AudioContext || window.webkitAudioContext)(); 
    masterGain = audioCtx.createGain(); 
    masterGain.gain.value = 0.5; 
    analyser = audioCtx.createAnalyser(); 
    analyser.fftSize = 64; 
    const compressor = audioCtx.createDynamicsCompressor(); 
    masterGain.connect(compressor).connect(analyser).connect(audioCtx.destination); 

    fxNodes = {
        delay: { in: audioCtx.createGain(), node: audioCtx.createDelay(), feedback: audioCtx.createGain() },
        reverb: { in: audioCtx.createGain(), node: audioCtx.createConvolver(), mix: audioCtx.createGain() },
        vibrato: { in: audioCtx.createGain(), node: audioCtx.createDelay(), lfo: audioCtx.createOscillator(), depthNode: audioCtx.createGain() }
    };

    // Delay Routing
    fxNodes.delay.node.delayTime.value = 0.4;
    fxNodes.delay.feedback.gain.value = 0.4;
    fxNodes.delay.in.connect(fxNodes.delay.node);
    fxNodes.delay.node.connect(fxNodes.delay.feedback);
    fxNodes.delay.feedback.connect(fxNodes.delay.node);
    fxNodes.delay.node.connect(masterGain);

    // Reverb Routing
    fxNodes.reverb.node.buffer = generateReverbIR(audioCtx, 2.0);
    fxNodes.reverb.mix.gain.value = 0.3;
    fxNodes.reverb.in.connect(fxNodes.reverb.node);
    fxNodes.reverb.node.connect(fxNodes.reverb.mix);
    fxNodes.reverb.mix.connect(masterGain);

    // Vibrato Routing
    fxNodes.vibrato.node.delayTime.value = 0.005;
    fxNodes.vibrato.lfo.frequency.value = 5;
    fxNodes.vibrato.lfo.connect(fxNodes.vibrato.depthNode);
    fxNodes.vibrato.depthNode.connect(fxNodes.vibrato.node.delayTime);
    fxNodes.vibrato.lfo.start();
    fxNodes.vibrato.in.connect(fxNodes.vibrato.node);
    fxNodes.vibrato.node.connect(masterGain);

    // WICHTIG: Sends permanent für alle Tracks erstellen
    tracks.forEach((_, i) => {
        ['delay', 'reverb', 'vibrato'].forEach(fx => {
            let send = audioCtx.createGain(); 
            send.gain.value = 0; // Standardmäßig aus, wird über Matrix gesteuert
            send.connect(fxNodes[fx].in); 
            trackSends[i][fx] = send;
        });
    });

    if(updateRoutingFromUI) updateRoutingFromUI();
}

export function connectTrackToFX(node, trackIdx) {
    if(!node || !audioCtx) return;
    ['delay', 'reverb', 'vibrato'].forEach(fx => {
        node.connect(trackSends[trackIdx][fx]);
    });
}

export function updateTrackVolume(track) { 
    if(track.gainNode && audioCtx) {
        track.gainNode.gain.setTargetAtTime(track.mute ? 0 : track.vol, audioCtx.currentTime, 0.05); 
    }
}

export function mapYToFrequency(y, h) { return Math.max(20, Math.min(1000-(y/h)*920, 20000)); }

export function quantizeFrequency(f, scale) {
    let m = Math.round(69 + 12 * Math.log2(f / 440));
    let pat = (scale === "major") ? [0, 2, 4, 5, 7, 9, 11] : (scale === "minor") ? [0, 2, 3, 5, 7, 8, 10] : [0, 3, 5, 7, 10];
    let mod = m % 12, b = pat[0], md = 99;
    pat.forEach(p => { if (Math.abs(p - mod) < md) { md = Math.abs(p - mod); b = p; } });
    return 440 * Math.pow(2, (m - mod + b - 69) / 12);
}