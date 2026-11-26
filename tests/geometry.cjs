// Run with node --test tests/geometry.cjs.
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { test } = require("node:test");
const { runInNewContext } = require("node:vm");

const source = readFileSync(`${__dirname}/../src/geometry.js`, "utf8");
const copy = (value) => JSON.parse(JSON.stringify(value));
const normal = { x: 300, y: 200, width: 1280, height: 800 };
const target = { x: -1832, y: 88, width: 1744, height: 904 };

function signal() {
    const listeners = [];
    return {
        connect(fn) { listeners.push(fn); },
        emit(...args) { listeners.forEach((fn) => fn(...args)); },
    };
}

function window(pid = 42, normalWindow = true) {
    let geometry = copy(normal);
    let fullscreen = false;
    let noBorder = false;
    return {
        pid, normalWindow, deleted: false, maximized: false, writes: 0,
        frameGeometryChanged: signal(),
        fullScreenChanged: signal(),
        maximizedChanged: signal(),
        decorationChanged: signal(),
        get noBorder() { return noBorder; },
        set noBorder(value) {
            if (value === noBorder) return;
            noBorder = value;
            // Server decorations occupy real height, outside the GTK content.
            geometry.height += value ? -28 : 28;
            this.decorationChanged.emit();
            this.frameGeometryChanged.emit();
        },
        get frameGeometry() { return copy(geometry); },
        set frameGeometry(value) {
            assert.ok(++this.writes < 100, "geometry must settle without a signal loop");
            geometry = copy(value);
            this.frameGeometryChanged.emit();
        },
        get fullScreen() { return fullscreen; },
        set fullScreen(value) {
            if (value === fullscreen) return;
            fullscreen = value;
            this.fullScreenChanged.emit();
        },
        setMaximize(vertical, horizontal) {
            const maximized = vertical || horizontal;
            if (this.maximized === maximized) return;
            this.maximized = maximized;
            this.maximizedChanged.emit();
        },
    };
}

function load(bounds, windows, saved = normal) {
    let remembered = copy(saved);
    let records = 0;
    const added = signal();
    const pending = [];
    // Unloading the KWin script disconnects its old signal handlers.
    for (const win of windows) {
        win.frameGeometryChanged = signal();
        win.fullScreenChanged = signal();
        win.maximizedChanged = signal();
        win.decorationChanged = signal();
    }
    runInNewContext(source
        .replaceAll("__PID__", "42")
        .replaceAll("__SERVICE__", "org.overlay.Geometry.test")
        .replaceAll("__TARGET__", JSON.stringify(bounds)), {
        workspace: {
            windowList: () => windows,
            windowAdded: added,
            screenOrder: [{ geometry: { x: -1920, y: 0, width: 3840, height: 1080 } }],
            clientArea: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
        },
        KWin: { WorkArea: 1 },
        callDBus(service, path, iface, method, value) {
            if (method === "Read") pending.push(() => value(JSON.stringify(remembered)));
            else if (method === "Record") {
                records++;
                remembered = JSON.parse(value);
            } else assert.fail(`unexpected D-Bus method ${method}`);
        },
    });
    pending.splice(0).forEach((fn) => fn());
    return {
        get remembered() { return remembered; },
        get records() { return records; },
        added,
    };
}

test("forced placement fits outer edges and rejects moves, resizes and fullscreen", () => {
    const app = window();
    const script = load(target, [app]);
    assert.deepEqual(app.frameGeometry, target);
    assert.equal(app.noBorder, true);
    app.frameGeometry = { x: 0, y: 0, width: 800, height: 600 };
    assert.deepEqual(app.frameGeometry, target);
    app.fullScreen = true;
    assert.equal(app.fullScreen, false);
    app.setMaximize(true, true);
    assert.equal(app.maximized, false);
    assert.deepEqual(app.frameGeometry, target);
    app.noBorder = false;
    assert.equal(app.noBorder, true);
    assert.deepEqual(app.frameGeometry, target);
    assert.equal(script.records, 0);
    assert.deepEqual(script.remembered, normal);
});

test("target changes follow the frame and turning off restores manual placement", () => {
    const app = window();
    load(target, [app]);
    const resized = { x: 152, y: 100, width: 1600, height: 800 };
    const forced = load(resized, [app]);
    assert.deepEqual(app.frameGeometry, resized);
    const restored = load(null, [app], forced.remembered);
    assert.deepEqual(app.frameGeometry, normal);
    assert.equal(app.noBorder, false);
    const moved = { ...normal, x: 400, width: 1000 };
    app.frameGeometry = moved;
    assert.deepEqual(restored.remembered, moved);
});

test("fractional output scaling settles within a physical pixel", () => {
    const app = window();
    load(target, [app]);
    const writes = app.writes;
    app.frameGeometry = { ...target, height: target.height + 0.4 };
    assert.equal(app.writes, writes + 1, "rounding must not trigger another resize");
    app.frameGeometry = { ...target, height: target.height + 28 };
    assert.deepEqual(app.frameGeometry, target, "decoration overflow must still be corrected");
});

test("only this helper's normal windows are fitted, including reopened apps", () => {
    const otherApp = window(99);
    const popup = window(42, false);
    const script = load(target, [otherApp, popup]);
    assert.deepEqual(otherApp.frameGeometry, normal);
    assert.deepEqual(popup.frameGeometry, normal);
    const reopened = window();
    script.added.emit(reopened);
    assert.deepEqual(reopened.frameGeometry, target);
    const closed = window();
    closed.deleted = true;
    script.added.emit(closed);
    assert.deepEqual(closed.frameGeometry, normal);
});
