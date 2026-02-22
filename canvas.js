export function drawGrid(t) { 
    t.ctx.save(); t.ctx.clearRect(0,0,t.canvas.width,t.canvas.height); t.ctx.strokeStyle="#eee"; 
    for(let i=0;i<=32;i++){ t.ctx.beginPath(); let x = i*(t.canvas.width/32); t.ctx.moveTo(x,0); t.ctx.lineTo(x,t.canvas.height); t.ctx.lineWidth = (i % 4 === 0) ? 2 : 1; t.ctx.stroke(); } 
    t.ctx.restore(); 
}

// Hilfsfunktionen für die Pinsel-Stile
function drawSegmentStandard(ctx, pts, idx1, idx2, size) { ctx.lineWidth = size; ctx.lineCap = "round"; ctx.beginPath(); ctx.moveTo(pts[idx1].x, pts[idx1].y); ctx.lineTo(pts[idx2].x, pts[idx2].y); ctx.stroke(); }
function drawSegmentVariable(ctx, pts, idx1, idx2, size) { const dist = Math.hypot(pts[idx2].x - pts[idx1].x, pts[idx2].y - pts[idx1].y); ctx.lineWidth = size * (1 + Math.max(0, (10 - dist) / 5)); ctx.lineCap = "round"; ctx.beginPath(); ctx.moveTo(pts[idx1].x, pts[idx1].y); ctx.lineTo(pts[idx2].x, pts[idx2].y); ctx.stroke(); }
function drawSegmentCalligraphy(ctx, pts, idx1, idx2, size) { const angle = -Math.PI / 4, dx = Math.cos(angle) * size, dy = Math.sin(angle) * size; ctx.fillStyle = "#000"; ctx.beginPath(); ctx.moveTo(pts[idx1].x - dx, pts[idx1].y - dy); ctx.lineTo(pts[idx1].x + dx, pts[idx1].y + dy); ctx.lineTo(pts[idx2].x + dx, pts[idx2].y + dy); ctx.lineTo(pts[idx2].x - dx, pts[idx2].y - dy); ctx.fill(); }

// FIX: Particles nutzen wieder pures Math.random() für die ständige Animation
function drawSegmentParticles(ctx, pts, idx1, idx2, size) { 
    ctx.fillStyle = "rgba(0,0,0,0.6)"; 
    for(let i=0; i<2; i++) { 
        const ox = (Math.random()-0.5)*size*2, oy = (Math.random()-0.5)*size*2; 
        ctx.beginPath(); 
        ctx.arc(pts[idx2].x+ox, pts[idx2].y+oy, Math.max(1, size/3), 0, Math.PI*2); 
        ctx.fill(); 
    } 
}

// FIX: Fractal nutzt die gespeicherten rX/rY für konsistentes Chaos
function drawSegmentFractal(ctx, pts, idx1, idx2, size, liveChaos) { 
    ctx.lineWidth = size; ctx.lineCap = "round"; ctx.beginPath(); 
    const jx1 = (pts[idx1].rX||0) * 50 * liveChaos; const jy1 = (pts[idx1].rY||0) * 100 * liveChaos;
    const jx2 = (pts[idx2].rX||0) * 50 * liveChaos; const jy2 = (pts[idx2].rY||0) * 100 * liveChaos;
    ctx.moveTo(pts[idx1].x + jx1, pts[idx1].y + jy1); 
    ctx.lineTo(pts[idx2].x + jx2, pts[idx2].y + jy2); 
    ctx.stroke(); 
}

export function redrawTrack(t, hx, brushSelectValue, chordIntervals, chordColors) {
    drawGrid(t);
    
    // Live-Chaos abgreifen
    let liveChaos = 0;
    document.querySelectorAll('.fx-unit').forEach(unit => {
        const header = unit.querySelector('.fx-header');
        if (header && header.textContent.toUpperCase().includes("FRACTAL")) {
            unit.querySelectorAll('.knob').forEach(k => {
                if (k.nextElementSibling && k.nextElementSibling.textContent.trim() === "CHAOS") {
                    liveChaos = parseFloat(k.dataset.val || 0);
                }
            });
        }
    });

    t.segments.forEach(seg => {
        const pts = seg.points; if (pts.length < 1) return;
        const brush = seg.brush || "standard"; const size = seg.thickness || 5;
        t.ctx.beginPath(); t.ctx.strokeStyle = "#000"; t.ctx.lineWidth = size;
        
        if(brush === "chord"){ 
            chordIntervals[seg.chordType||"major"].forEach((iv,i) => { 
                t.ctx.save(); t.ctx.beginPath(); t.ctx.strokeStyle = chordColors[i%3]; t.ctx.lineWidth = size; 
                t.ctx.moveTo(pts[0].x, pts[0].y-iv*5); for(let k=1;k<pts.length;k++) t.ctx.lineTo(pts[k].x,pts[k].y-iv*5); 
                t.ctx.stroke(); t.ctx.restore(); 
            }); 
        } else if(brush === "particles"){ 
            for(let i=1;i<pts.length;i++) drawSegmentParticles(t.ctx, pts, i-1, i, size); 
        } else { 
            for(let i=1;i<pts.length;i++){ 
                switch(brush){ 
                    case "variable": drawSegmentVariable(t.ctx, pts, i-1, i, size); break; 
                    case "calligraphy": drawSegmentCalligraphy(t.ctx, pts, i-1, i, size); break; 
                    case "fractal": drawSegmentFractal(t.ctx, pts, i-1, i, size, liveChaos); break; 
                    default: drawSegmentStandard(t.ctx, pts, i-1, i, size); 
                } 
            }
        } 
    });
    
    if(hx !== undefined){ 
        t.ctx.save(); t.ctx.beginPath(); t.ctx.strokeStyle = "red"; t.ctx.lineWidth = 2; 
        t.ctx.moveTo(hx,0); t.ctx.lineTo(hx,100); t.ctx.stroke(); t.ctx.restore(); 
    }
}