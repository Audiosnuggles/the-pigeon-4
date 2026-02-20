/**
 * Macht einen Drehregler (Knob) interaktiv.
 */
export function setupKnob(knob, onValueChange) {
    knob.addEventListener('mousedown', (e) => {
        let startY = e.clientY; 
        let startVal = parseFloat(knob.dataset.val || 0);
        document.body.style.cursor = 'ns-resize';
        
        const onMove = (ev) => {
            let newVal = Math.max(0, Math.min(1, startVal + ((startY - ev.clientY) * 0.005)));
            knob.dataset.val = newVal;
            knob.style.transform = `rotate(${-135 + (newVal * 270)}deg)`;
            onValueChange(newVal);
        };
        const onUp = () => { 
            document.body.style.cursor = 'default';
            window.removeEventListener('mousemove', onMove); 
            window.removeEventListener('mouseup', onUp); 
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
    });
}

/**
 * Aktualisiert die "Filled"-Anzeige der Pattern-Pads.
 */
export function updatePadUI(patternBanks) {
    document.querySelectorAll(".pad").forEach(pad => {
        const b = pad.dataset.bank;
        const i = parseInt(pad.dataset.idx);
        pad.classList.toggle("filled", !!(patternBanks[b] && patternBanks[b][i]));
    });
}

/**
 * Setzt das FX-Rack visuell auf die Standardwerte zurück.
 */
export function resetFXUI(updateRouting) {
    document.querySelectorAll('.matrix-btn').forEach(btn => btn.classList.remove('active'));
    document.querySelectorAll('.fx-xy-link').forEach(btn => btn.classList.remove('active'));
    document.querySelectorAll('.knob').forEach(knob => {
        const param = knob.nextElementSibling.innerText;
        let def = (param === "TIME") ? 0.4 : (param === "RATE" ? 0.3 : 0.0);
        knob.dataset.val = def;
        knob.style.transform = `rotate(${-135 + (def * 270)}deg)`;
    });
    if (updateRouting) updateRouting();
}