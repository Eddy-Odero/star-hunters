document.addEventListener("DOMContentLoaded", () => {
    const canvas = document.getElementById("sky-canvas");
    const ctx = canvas.getContext("2d");
    const chkInvert = document.getElementById("chk-invert");
    const epochItems = document.querySelectorAll(".epoch-item");
    const epochDisplay = document.getElementById("epoch-display");

    // Resize canvas for high resolution
    function resizeCanvas() {
        const rect = canvas.getBoundingClientRect();
        canvas.width = rect.width * window.devicePixelRatio;
        canvas.height = rect.height * window.devicePixelRatio;
        ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
        drawSky();
    }

    // Realistic FITS Detector Sky Simulator
    function drawSky() {
        const width = canvas.clientWidth;
        const height = canvas.clientHeight;
        const isInverted = chkInvert.checked;

        // Background color based on Inverted toggle (WiseView negative vs Dark Navy)
        ctx.fillStyle = isInverted ? "#0b1329" : "#f1f5f9";
        ctx.fillRect(0, 0, width, height);

        // Draw pixelated FITS detector grid
        const gridSize = 24;
        const cols = Math.floor(width / gridSize);
        const rows = Math.floor(height / gridSize);

        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                const noise = Math.sin(r * 12.9898 + c * 78.233) * 43758.5453;
                const val = (noise - Math.floor(noise));
                
                if (isInverted) {
                    const shade = Math.floor(15 + val * 25);
                    ctx.fillStyle = `rgb(${shade}, ${shade + 4}, ${shade + 12})`;
                } else {
                    const shade = Math.floor(225 - val * 25);
                    ctx.fillStyle = `rgb(${shade}, ${shade}, ${shade})`;
                }
                ctx.fillRect(c * gridSize, r * gridSize, gridSize - 1, gridSize - 1);
            }
        }

        // Draw Stars & Galaxies
        drawStar(ctx, width * 0.62, height * 0.45, 12, isInverted); // W18E 0855 Target
        drawStar(ctx, width * 0.70, height * 0.18, 16, isInverted); // Galaxy G
        drawStar(ctx, width * 0.38, height * 0.75, 8, isInverted);  // Asteroid A1
        drawStar(ctx, width * 0.25, height * 0.30, 6, isInverted);
        drawStar(ctx, width * 0.82, height * 0.85, 5, isInverted);
    }

    function drawStar(context, x, y, size, isInverted) {
        context.save();
        context.shadowBlur = size * 1.5;
        context.shadowColor = isInverted ? "rgba(56, 189, 248, 0.6)" : "rgba(15, 23, 42, 0.4)";
        
        context.fillStyle = isInverted ? "#ffffff" : "#0f172a";
        context.beginPath();
        context.arc(x, y, size * 0.4, 0, Math.PI * 2);
        context.fill();

        // Diffraction spikes
        context.strokeStyle = isInverted ? "rgba(255, 255, 255, 0.8)" : "rgba(15, 23, 42, 0.6)";
        context.lineWidth = 1.5;
        context.beginPath();
        context.moveTo(x - size, y); context.lineTo(x + size, y);
        context.moveTo(x, y - size); context.lineTo(x, y + size);
        context.stroke();
        context.restore();
    }

    // Toggle Invert Listener
    chkInvert.addEventListener("change", () => {
        drawSky();
    });

    // Epoch Switching Logic
    epochItems.forEach((item, index) => {
        item.addEventListener("click", () => {
            epochItems.forEach(el => el.classList.remove("active"));
            item.classList.add("active");
            
            const strongText = item.querySelector("strong").textContent;
            epochDisplay.textContent = strongText.replace("Frame " + (index+1) + ": ", "");
            drawSky();
        });
    });

    window.addEventListener("resize", resizeCanvas);
    resizeCanvas();
});
