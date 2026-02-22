// midi.js - The Pigeon Sync Engine
export let midiSyncActive = false;

export async function initMidiEngine(syncBtnId, selectId, callbacks) {
    const syncBtn = document.getElementById(syncBtnId);
    const midiSelect = document.getElementById(selectId);
    let midiAccess = null;

    let lastTickTime = 0;
    let smoothedBpm = 0;
    let tickCount = 0;

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
                if (midiSelect.options.length > 0) attachListener(midiAccess, midiSelect.value);
            } catch (err) {
                console.error("Web MIDI API blockiert.", err);
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
        for (let input of access.inputs.values()) input.onmidimessage = null; 
        if (!inputId) return;
        const input = access.inputs.get(inputId);
        if (input) input.onmidimessage = handleMessage;
    }

    function handleMessage(event) {
        if (!midiSyncActive) return;
        const status = event.data[0];
        const timeStamp = event.timeStamp; 

        if (status === 248) { // CLOCK TICK
            if (lastTickTime > 0) {
                const interval = timeStamp - lastTickTime;
                
                // Filtere extreme Lags raus
                if (interval > 5 && interval < 100) {
                    const currentBpm = 60000 / (interval * 24);
                    
                    if (smoothedBpm === 0) {
                        smoothedBpm = currentBpm;
                    } else {
                        // Träger Durchschnitt für maximale mathematische Stabilität
                        smoothedBpm = (smoothedBpm * 0.98) + (currentBpm * 0.02);
                    }
                    
                    tickCount++;
                    // Update alle 24 Ticks (1 Viertelnote)
                    if (tickCount >= 24) {
                        tickCount = 0;
                        if (callbacks.onBpm && smoothedBpm > 30 && smoothedBpm < 300) {
                            // WICHTIG: Sende den exakten, ungerundeten Wert!
                            callbacks.onBpm(smoothedBpm);
                        }
                    }
                }
            }
            lastTickTime = timeStamp;
        } 
        else if (status === 250 || status === 251) { // START / CONTINUE
            lastTickTime = 0;
            smoothedBpm = 0;
            tickCount = 0;
            if (callbacks.onStart) callbacks.onStart();
        } 
        else if (status === 252) { // STOP
            if (callbacks.onStop) callbacks.onStop();
        }
    }
}