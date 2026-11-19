// Temporary effect, loaded before the helper maps any windows. The app ID
// carries settings with the Wayland map, avoiding asynchronous D-Bus races.
(function () {
    function duration(window) {
        if (window.pid !== __PID__) return null;
        const match = /(?:^| )overlay-browser-(instant|fade-([0-9]+))(?: |$)/.exec(window.windowClass);
        if (!match) return null; // Desktop Default belongs to the desktop effect.
        return match[1] === "instant" ? 0 : Math.min(Number(match[2]), 5000);
    }
    effects.windowAdded.connect(function (window) {
        const ms = duration(window);
        if (ms === null) return;
        // Force also cancels Scale/Fade if their signal handler ran first.
        effect.grab(window, Effect.WindowAddedGrabRole, true);
        if (ms > 0) {
            window.overlayOpeningAnimation = animate({
                window: window,
                duration: ms,
                curve: QEasingCurve.Linear,
                type: Effect.Opacity,
                from: 0,
                to: 1
            });
        }
    });
    effects.windowClosed.connect(function (window) {
        if (duration(window) === null) return;
        if (window.overlayOpeningAnimation) {
            cancel(window.overlayOpeningAnimation);
            delete window.overlayOpeningAnimation;
        }
        effect.grab(window, Effect.WindowClosedGrabRole, true);
    });
})();
