// Loaded only for the lifetime of a browser helper. Never matches other apps.
(function () {
    const service = "__SERVICE__";
    const target = __TARGET__;
    function watch(window) {
        if (window.pid !== __PID__ || !window.normalWindow) return;
        if (target) {
            // KWin owns server decorations on Wayland; GTK's decoration hint
            // can be ignored after the pre-warmed window has been realized.
            // Fit the outer window frame. Guard
            // synchronous signals and skip equal geometry to avoid resize loops.
            let applying = false;
            function fit() {
                if (applying || window.deleted) return;
                applying = true;
                try {
                    window.noBorder = true;
                    window.fullScreen = false;
                    window.setMaximize(false, false);
                    const g = window.frameGeometry;
                    // Fractional output scaling can round to a physical pixel
                    // (for example 650 logical px becomes 650.4 at 125%).
                    if (Math.abs(g.x - target.x) > 0.5 || Math.abs(g.y - target.y) > 0.5
                        || Math.abs(g.width - target.width) > 0.5
                        || Math.abs(g.height - target.height) > 0.5) {
                        window.frameGeometry = target;
                    }
                } finally {
                    applying = false;
                }
            }
            window.frameGeometryChanged.connect(fit);
            window.fullScreenChanged.connect(fit);
            window.decorationChanged.connect(fit);
            if (window.maximizedChanged) window.maximizedChanged.connect(fit);
            fit();
            // Forced placement must not replace the user's normal geometry.
            return;
        }
        window.noBorder = false;
        let restoring = true;
        function record() {
            if (restoring || window.deleted) return;
            const g = window.frameGeometry;
            callDBus(service, "/Geometry", "org.overlay.Geometry", "Record",
                JSON.stringify({x: g.x, y: g.y, width: g.width, height: g.height}));
        }
        window.frameGeometryChanged.connect(record);
        callDBus(service, "/Geometry", "org.overlay.Geometry", "Read", function (value) {
            if (window.deleted) return;
            const saved = JSON.parse(value);
            if (saved) {
                // If a monitor disappeared, bring the window onto a current output.
                const visible = workspace.screenOrder.some(function (output) {
                    const r = output.geometry;
                    return saved.x < r.x + r.width && saved.x + saved.width > r.x
                        && saved.y < r.y + r.height && saved.y + saved.height > r.y;
                });
                if (!visible) {
                    const area = workspace.clientArea(KWin.WorkArea, window);
                    saved.x = area.x;
                    saved.y = area.y;
                    saved.width = Math.min(saved.width, area.width);
                    saved.height = Math.min(saved.height, area.height);
                }
                window.frameGeometry = saved;
            }
            restoring = false;
            record();
        });
    }
    workspace.windowList().forEach(watch);
    workspace.windowAdded.connect(watch);
})();
