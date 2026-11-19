// Run with node --test tests/browser_animation.cjs.
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { test } = require("node:test");
const { runInNewContext } = require("node:vm");

const source = readFileSync(`${__dirname}/../src/browser_animation.js`, "utf8")
    .replaceAll("__PID__", "42");

function harness(desktopFirst) {
    const handlers = { added: [], closed: [] };
    const running = new Map();
    let nextId = 0;
    const desktop = (window) => {
        if (!window.grabbed) window.desktopAnimation = true;
    };
    if (desktopFirst) handlers.added.push(desktop);
    runInNewContext(source, {
        effects: {
            windowAdded: { connect: (fn) => handlers.added.push(fn) },
            windowClosed: { connect: (fn) => handlers.closed.push(fn) },
        },
        effect: { grab(window, role, force) {
            assert.equal(force, true);
            window.grabbed = role;
            // Scale/Fade listen for WindowAddedGrabRole changes and cancel.
            window.desktopAnimation = false;
        } },
        Effect: { WindowAddedGrabRole: 1, WindowClosedGrabRole: 2, Opacity: 3 },
        QEasingCurve: { Linear: 0 },
        animate(settings) { running.set(++nextId, settings); return nextId; },
        cancel(id) { running.delete(id); },
    });
    if (!desktopFirst) handlers.added.push(desktop);
    return {
        running,
        open(id, pid = 42) {
            const window = { pid, windowClass: `overlay ${id}` };
            handlers.added.forEach((fn) => fn(window));
            return window;
        },
        close(window) { handlers.closed.forEach((fn) => fn(window)); },
    };
}

for (const desktopFirst of [false, true]) {
    test(`opening modes and PID isolation, desktop handler first: ${desktopFirst}`, () => {
        const effect = harness(desktopFirst);
        for (const [id, pid] of [["overlay-browser", 42], ["overlay-browser-instant", 99]]) {
            const window = effect.open(id, pid);
            assert.equal(window.desktopAnimation, true);
            effect.close(window);
            assert.equal(window.grabbed, undefined);
        }
        for (const id of ["overlay-browser-instant", "overlay-browser-fade-0"]) {
            // A fresh KWin window is created for every hide/show of the GTK view.
            for (let reopen = 0; reopen < 2; reopen++) {
                const window = effect.open(id);
                assert.equal(window.desktopAnimation, false);
                assert.equal(effect.running.size, 0);
                effect.close(window);
                assert.equal(window.grabbed, 2);
            }
        }
        for (const duration of [150, 375, 5000]) {
            const window = effect.open(`overlay-browser-fade-${duration}`);
            assert.equal(window.desktopAnimation, false);
            const fade = [...effect.running.values()][0];
            assert.equal(fade.duration, duration);
            assert.equal(fade.type, 3); // Opacity only: no scale or geometry change.
            assert.equal(fade.from, 0);
            assert.equal(fade.to, 1);
            effect.close(window); // Closing mid-fade cancels it before hiding.
            assert.equal(effect.running.size, 0);
        }
    });
}
