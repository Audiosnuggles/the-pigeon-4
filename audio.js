export let audioCtx;
export let masterGain;
export let analyser;
export const fxNodes = { delay: {}, reverb: {}, vibrato: {}, filter: {}, stutter: {} };
export const trackSends = [[], [], [], []];

export function initAudio(tracks, updateRoutingCallback) {
    if (audioCtx) return;
    
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    audioCtx = new AudioContext();
    
    masterGain = audioCtx.createGain();
    masterGain.gain.value = 0.8;
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    
    masterGain.connect(analyser);
    analyser.connect(audioCtx.destination);

    // 1. DELAY
    fxNodes.delay.node = audioCtx.createDelay(5.0);
    fxNodes.delay.feedback = audioCtx.createGain();
    fxNodes.delay.input = audioCtx.createGain();
    
    fxNodes.delay.node.delayTime.value = 0.4;
    fxNodes.delay.feedback.gain.value = 0.3;
    
    fxNodes.delay.input.connect(fxNodes.delay.node);
    fxNodes.delay.node.connect(fxNodes.delay.feedback);
    fxNodes.delay.feedback.connect(fxNodes.delay.node);
    fxNodes.delay.node.connect(masterGain);

    // 2. REVERB
    fxNodes.reverb.convolver = audioCtx.createConvolver();
    fxNodes.reverb.mix = audioCtx.createGain();
    fxNodes.reverb.input = audioCtx.createGain();
    
    fxNodes.reverb.mix.gain.value = 0.2;
    updateReverbDecay(0.5); 
    
    fxNodes.reverb.input.connect(fxNodes.reverb.convolver);
    fxNodes.reverb.convolver.connect(fxNodes.reverb.mix);
    fxNodes.reverb.mix.connect(masterGain);

    // 3. VIBRATO
    fxNodes.vibrato.node = audioCtx.createDelay(1.0);
    fxNodes.vibrato.input = audioCtx.createGain();
    fxNodes.vibrato.lfo = audioCtx.createOscillator();
    fxNodes.vibrato.depthNode = audioCtx.createGain();
    
    fxNodes.vibrato.node.delayTime.value = 0.03;
    fxNodes.vibrato.lfo.frequency.value = 5;
    fxNodes.vibrato.depthNode.gain.value = 0;
    
    fxNodes.vibrato.lfo.connect(fxNodes.vibrato.depthNode);
    fxNodes.vibrato.depthNode.connect(fxNodes.vibrato.node.delayTime);
    fxNodes.vibrato.lfo.start();
    
    fxNodes.vibrato.input.connect(fxNodes.vibrato.node);
    fxNodes.vibrato.node.connect(masterGain);

    // 4. FILTER (Warmer Moog-Style: 24dB Ladder + Soft Saturation)
    fxNodes.filter.input = audioCtx.createGain();
    fxNodes.filter.node1 = audioCtx.createBiquadFilter(); // Filter 1 (12dB)
    fxNodes.filter.node2 = audioCtx.createBiquadFilter(); // Filter 2 (12dB) = Total 24dB
    fxNodes.filter.drive = audioCtx.createWaveShaper();
    
    fxNodes.filter.node1.type = 'lowpass';
    fxNodes.filter.node2.type = 'lowpass';
    fxNodes.filter.node1.frequency.value = 20000;
    fxNodes.filter.node2.frequency.value = 20000;
    fxNodes.filter.node1.Q.value = 0;
    fxNodes.filter.node2.Q.value = 0;
    
    fxNodes.filter.drive.curve = getWarmDistortionCurve(0);
    fxNodes.filter.drive.oversample = '4x';
    
    // Signal Flow: Input -> Soft Drive -> Filter 1 -> Filter 2 -> Output
    fxNodes.filter.input.connect(fxNodes.filter.drive);
    fxNodes.filter.drive.connect(fxNodes.filter.node1);
    fxNodes.filter.node1.connect(fxNodes.filter.node2);
    fxNodes.filter.node2.connect(masterGain);

    // 5. STUTTER GATE
    fxNodes.stutter.input = audioCtx.createGain();
    fxNodes.stutter.gate = audioCtx.createGain();
    fxNodes.stutter.lfo = audioCtx.createOscillator();
    
    fxNodes.stutter.lfo.type = 'square';
    fxNodes.stutter.lfo.frequency.value = 8;
    
    const stutterAmp = audioCtx.createGain();
    stutterAmp.gain.value = 0.5;
    const stutterOffset = audioCtx.createConstantSource();
    stutterOffset.offset.value = 0.5;
    stutterOffset.start();

    fxNodes.stutter.gate.gain.value = 0;
    fxNodes.stutter.lfo.connect(stutterAmp);
    stutterAmp.connect(fxNodes.stutter.gate.gain);
    stutterOffset.connect(fxNodes.stutter.gate.gain);
    fxNodes.stutter.lfo.start();

    fxNodes.stutter.input.connect(fxNodes.stutter.gate);
    fxNodes.stutter.gate.connect(masterGain); 

    // Setup Routing Matrix
    tracks.forEach((t, i) => {
        trackSends[i] = {
            dry: audioCtx.createGain(),
            delay: audioCtx.createGain(),
            reverb: audioCtx.createGain(),
            vibrato: audioCtx.createGain(),
            filter: audioCtx.createGain(),
            stutter: audioCtx.createGain()
        };
        
        trackSends[i].dry.gain.value = 1.0;
        trackSends[i].delay.gain.value = 0;
        trackSends[i].reverb.gain.value = 0;
        trackSends[i].vibrato.gain.value = 0;
        trackSends[i].filter.gain.value = 0;
        trackSends[i].stutter.gain.value = 0;

        trackSends[i].dry.connect(masterGain);
        trackSends[i].delay.connect(fxNodes.delay.input);
        trackSends[i].reverb.connect(fxNodes.reverb.input);
        trackSends[i].vibrato.connect(fxNodes.vibrato.input);
        trackSends[i].filter.connect(fxNodes.filter.input);
        trackSends[i].stutter.connect(fxNodes.stutter.input);
    });

    if (updateRoutingCallback) updateRoutingCallback();
}

export function updateReverbDecay(decayVal) {
    if (!audioCtx || !fxNodes.reverb.convolver) return;
    const duration = 0.1 + (decayVal * 4.0); 
    const sr = audioCtx.sampleRate;
    const len = Math.floor(sr * duration);
    const impulse = audioCtx.createBuffer(2, len, sr);
    for (let i = 0; i < 2; i++) {
        const chan = impulse.getChannelData(i);
        for (let j = 0; j < len; j++) chan[j] = (Math.random() * 2 - 1) * Math.pow(1 - j / len, 3);
    }
    fxNodes.reverb.convolver.buffer = impulse;
}

export function connectTrackToFX(trackGain, index) {
    if (!audioCtx || !trackSends[index]) return;
    trackGain.connect(trackSends[index].dry); 
    trackGain.connect(trackSends[index].delay);
    trackGain.connect(trackSends[index].reverb);
    trackGain.connect(trackSends[index].vibrato);
    trackGain.connect(trackSends[index].filter);
    trackGain.connect(trackSends[index].stutter);
}

export function updateTrackVolume(track) {
    if (track.gainNode && audioCtx) {
        track.gainNode.gain.setTargetAtTime(track.mute ? 0 : track.vol, audioCtx.currentTime, 0.05);
    }
}

// Harte Distortion (für Fractal Synth)
export function getDistortionCurve(amount = 50) {
    const k = typeof amount === 'number' ? amount : 50;
    const n_samples = 44100;
    const curve = new Float32Array(n_samples);
    const deg = Math.PI / 180;
    for (let i = 0; i < n_samples; ++i) {
        const x = i * 2 / n_samples - 1;
        curve[i] = (3 + k) * x * 20 * deg / (Math.PI + k * Math.abs(x));
    }
    return curve;
}

// NEU: Warme Sättigung (Tape-Style für den Filter)
export function getWarmDistortionCurve(amount = 0) {
    const k = amount / 10; 
    const n_samples = 44100;
    const curve = new Float32Array(n_samples);
    for (let i = 0; i < n_samples; ++i) {
        let x = i * 2 / n_samples - 1;
        curve[i] = Math.tanh(x * (1 + k));
    }
    return curve;
}

export function mapYToFrequency(y, height) {
    const minFreq = 80;
    const maxFreq = 1000;
    return maxFreq * Math.pow(minFreq / maxFreq, y / height);
}

export function quantizeFrequency(freq, scale) {
    const scales = {
        major: [0, 2, 4, 5, 7, 9, 11],
        minor: [0, 2, 3, 5, 7, 8, 10],
        pentatonic: [0, 2, 4, 7, 9],
        blues: [0, 3, 5, 6, 7, 10]
    };
    const activeScale = scales[scale] || scales.major;
    const baseC = 65.41;
    const semitonesFromC = 12 * Math.log2(freq / baseC);
    const octave = Math.floor(semitonesFromC / 12);
    const noteInOctave = semitonesFromC % 12;
    
    let closestNote = activeScale[0];
    let minDiff = 12;
    activeScale.forEach(n => {
        const diff = Math.abs(noteInOctave - n);
        if (diff < minDiff) { minDiff = diff; closestNote = n; }
    });
    
    return baseC * Math.pow(2, octave + (closestNote / 12));
}