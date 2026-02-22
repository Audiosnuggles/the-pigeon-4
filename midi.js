// midi.js - The Pigeon Sync Engine
export let midiSyncActive = false;

export async function initMidiEngine(syncBtnId, selectId, callbacks) {
    const syncBtn = document.getElementById(syncBtnId);
    const midiSelect = document.getElementById(selectId); // Das ist das Dropdown!
    let midiAccess = null;

    let clockCount = 0;
    let lastTickTime = performance.now();
    let tickIntervals = []; // Für den Glättungs-Durchschnitt (Smoothing)

    if (!syncBtn || !midiSelect) return;

    syncBtn.addEventListener("click", async () => {
        midiSyncActive = !midiSyncActive;
        syncBtn.classList.toggle("active", midiSyncActive);
        
        syncBtn.innerText = midiSyncActive ? "SLAVE MODE" : "EXT SYNC";
        
        midiSelect.disabled = !midiSyncActive;
        midiSelect.style.background = midiSyncActive ? "#fff" : "#eee";
        
        if (callbacks.onToggle) callbacks.onToggle(midiSyncActive);

        if (midiSyncActive && !midiAccess) {
            try {
                midiAccess = await navigator.requestMIDIAccess();
                populateDropdown(midiAccess, midiSelect);
                
                midiAccess.onstatechange = () => populateDropdown(midiAccess, midiSelect);
                midiSelect.addEventListener('change', () => attachListener(midiAccess, midiSelect.value));
                
                if (midiSelect.options.length > 0) {
                    attachListener(midiAccess, midiSelect.value);
                }
            } catch (err) {
                console.error("Web MIDI API blockiert oder nicht unterstützt.", err);
                midiSyncActive = false;
                syncBtn.classList.remove("active");
                syncBtn.innerText = "EXT SYNC";
                midiSelect.disabled = true;
            }
        }
    });

    function populateDropdown(access, select) {
        const currentVal = select.value;
        select.innerHTML = '';
        
        let count = 0;
        for (let input of access.inputs.values()) {
            const opt = document.createElement('option');
            opt.value = input.id;
            opt.text = input.name;
            select.appendChild(opt);
            count++;
        }

        if (count === 0) {
            const opt = document.createElement('option');
            opt.text = "No Devices Found";
            select.appendChild(opt);
        } else if (currentVal && select.querySelector(`option[value="${currentVal}"]`)) {
            select.value = currentVal;
        } else {
            select.value = select.options[0].value;
            if (midiSyncActive) attachListener(access, select.value);
        }
    }

    function attachListener(access, inputId) {
        for (let input of access.inputs.values()) {
            input.onmidimessage = null; // Stoppe alte Listener
        }
        if (!inputId) return;
        const input = access.inputs.get(inputId);
        if (input) {
            input.onmidimessage = handleMessage;
        }
    }

    function handleMessage(message) {
        if (!midiSyncActive) return;
        const status = message.data[0];

        if (status === 248) { // CLOCK
            const now = performance.now();
            const interval = now - lastTickTime;
            lastTickTime = now;

            if (interval > 0 && interval < 100) {
                tickIntervals.push(interval);
                if (tickIntervals.length > 48) tickIntervals.shift(); 
            }

            clockCount++;
            if (clockCount >= 24) { 
                clockCount = 0;
                if (tickIntervals.length >= 24) {
                    const avgInterval = tickIntervals.reduce((a, b) => a + b) / tickIntervals.length;
                    const bpm = 60000 / (avgInterval * 24);
                    const smoothBPM = Math.round(bpm * 10) / 10;
                    
                    if (smoothBPM > 30 && smoothBPM < 300) {
                        if (callbacks.onBpm) callbacks.onBpm(smoothBPM);
                    }
                }
            }
        } 
        else if (status === 250 || status === 251) { // START / CONTINUE
            clockCount = 0;
            tickIntervals = [];
            if (callbacks.onStart) callbacks.onStart();
        } 
        else if (status === 252) { // STOP
            if (callbacks.onStop) callbacks.onStop();
        }
    }
}