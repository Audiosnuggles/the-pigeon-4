export function drawGrid(t) { 
    t.ctx.save(); t.ctx.clearRect(0,0,t.canvas.width,t.canvas.height); t.ctx.strokeStyle="#eee"; 
    for(let i=0;i<=32;i++){ t.ctx.beginPath(); let x = i*(t.canvas.width/32); t.ctx.moveTo(x,0); t.ctx.lineTo(x,t.canvas.height); t.ctx.lineWidth = (i % 4 === 0) ? 2 : 1; t.ctx.stroke(); } 
    t.ctx.restore(); 
}

function drawSegmentParticles(ctx, pts, idx1, idx2, size) { ctx.fillStyle = "rgba(0,0,0,0.6)"; for(let i=0; i<2; i++) { const ox = (Math.random()-0.5)*size*2, oy = (Math.random()-0.5)*size*2; ctx.beginPath(); ctx.arc(pts[idx2].x+ox, pts[idx2].y+oy, Math.max(1, size/3), 0, Math.PI*2); ctx.fill(); } }

export function redrawTrack(track, playheadX, currentBrush, chordIntervals, chordColors) {
    drawGrid(track);
    const { ctx } = track;

    track.segments.forEach(seg => {
        const pts = seg.points; if (pts.length < 1) return;
        const brush = seg.brush || "standard";
        const size = seg.thickness || 5;
        ctx.beginPath(); ctx.strokeStyle = "#000"; ctx.lineWidth = size; ctx.lineCap = "round";

        if (brush === "chord") {
            const intervals = chordIntervals[seg.chordType || "major"];
            intervals.forEach((iv, i) => {
                ctx.save(); ctx.beginPath(); ctx.strokeStyle = chordColors[i % 3]; ctx.moveTo(pts[0].x, pts[0].y - iv * 5);
                pts.forEach(p => ctx.lineTo(p.x, p.y - iv * 5)); ctx.stroke(); ctx.restore();
            });
        } else if (brush === "particles") {
            for (let i = 1; i < pts.length; i++) drawSegmentParticles(ctx, pts, i - 1, i, size);
        } else {
            ctx.moveTo(pts[0].x, pts[0].y); pts.forEach(p => ctx.lineTo(p.x, p.y)); ctx.stroke();
        }
    });

    if (playheadX !== undefined) {
        ctx.save(); ctx.beginPath(); ctx.strokeStyle = "red"; ctx.lineWidth = 2; ctx.moveTo(playheadX, 0); ctx.lineTo(playheadX, 100); ctx.stroke(); ctx.restore();
    }
}