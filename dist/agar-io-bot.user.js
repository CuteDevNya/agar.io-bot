// ==UserScript==
// @name         Agar.io Bot + Food Radar
// @namespace    local.agario.botbundle
// @version      0.4.0
// @description  Combined Agar.io food radar and bot
// @match        https://agar.io/*
// @match        https://*.agar.io/*
// @run-at       document-start
// @grant        none
// @updateURL    https://raw.githubusercontent.com/CuteDevNya/agar.io-bot/main/dist/agar-io-bot.meta.js
// @downloadURL  https://raw.githubusercontent.com/CuteDevNya/agar.io-bot/main/dist/agar-io-bot.user.js
// ==/UserScript==

/* ==================== FOOD RADAR ==================== */
(() => {
    "use strict";

    // ==================== SETTINGS ====================

    const EKS = 0x7999;
    const MARKER_COLOR = "#00ffff";
    const MIN_MARKER_RADIUS = 3.5;
    const TRANSFORM_MAX_AGE_MS = 250;

    let zoomCorrection = 1.0;

    // ==================== GLOBAL STATE ====================

    if (window.agarFoodRadar) {
        console.warn("[Food Radar] Already installed.");
        return;
    }

    const NativeWebSocket = window.WebSocket;
    const OriginalRAF = window.requestAnimationFrame;
    const NativeRAF = OriginalRAF.bind(window);

    const connections = [];

    let stopped = false;
    let gameCanvas = null;
    let overlayCanvas = null;
    let overlayContext = null;
    let statusElement = null;
    let animationId = 0;

    let WrappedRAF = null;
    let overlaySchedulerStarted = false;

    // The transform is captured directly from the game's 2D canvas.
    let lastWorldTransform = null;

    // Canvas arc() is called thousands of times in some frames.
    // Probe only every few milliseconds, rather than inspecting every arc.
    const TRANSFORM_PROBE_INTERVAL_MS = 3;
    let lastTransformProbeAt = -Infinity;

    // Fast lookup for known food coordinates.
    let foodCoordinateIndex = new Set();
    let foodIndexState = null;
    let foodIndexWorldUpdates = -1;
    let foodIndexFoodCount = -1;

    // Canvas method interception.
    const canvas2DPrototype =
        window.CanvasRenderingContext2D?.prototype ?? null;

    const originalArc = canvas2DPrototype?.arc ?? null;

    let patchedArc = null;

    // ==================== BINARY HELPERS ====================

    function getView(bytes) {
        return new DataView(
            bytes.buffer,
            bytes.byteOffset,
            bytes.byteLength
        );
    }

    function readAsciiString(bytes, offset, maxLength = 32) {
        const chars = [];

        for (
            let i = 0;
            i < maxLength && offset < bytes.length;
            i++, offset++
        ) {
            if (bytes[offset] === 0) break;

            const value = bytes[offset];

            if (value < 32 || value > 126) {
                return "";
            }

            chars.push(String.fromCharCode(value));
        }

        return chars.join("");
    }

    function normalizeData(data) {
        if (data instanceof ArrayBuffer) {
            return Promise.resolve(new Uint8Array(data));
        }

        if (ArrayBuffer.isView(data)) {
            return Promise.resolve(
                new Uint8Array(
                    data.buffer,
                    data.byteOffset,
                    data.byteLength
                )
            );
        }

        if (typeof Blob !== "undefined" && data instanceof Blob) {
            return data.arrayBuffer().then(
                buffer => new Uint8Array(buffer)
            );
        }

        return Promise.resolve(null);
    }

    // ==================== LZ4 BLOCK DECODER ====================

    function decompressLZ4(input, expectedSize) {
        if (
            !Number.isInteger(expectedSize) ||
            expectedSize <= 0 ||
            expectedSize > 8_000_000
        ) {
            throw new Error("Invalid decompressed size");
        }

        const output = new Uint8Array(expectedSize);

        let src = 0;
        let dst = 0;

        while (src < input.length) {
            const token = input[src++];

            let literalLength = token >>> 4;

            if (literalLength === 15) {
                let value;

                do {
                    if (src >= input.length) {
                        throw new Error(
                            "Truncated LZ4 literal length"
                        );
                    }

                    value = input[src++];
                    literalLength += value;
                } while (value === 255);
            }

            if (
                src + literalLength > input.length ||
                dst + literalLength > output.length
            ) {
                throw new Error("Invalid LZ4 literal range");
            }

            output.set(
                input.subarray(src, src + literalLength),
                dst
            );

            src += literalLength;
            dst += literalLength;

            if (src >= input.length) break;

            if (src + 2 > input.length) {
                throw new Error("Truncated LZ4 match offset");
            }

            const matchOffset =
                input[src] | (input[src + 1] << 8);

            src += 2;

            if (matchOffset === 0 || matchOffset > dst) {
                throw new Error("Invalid LZ4 match offset");
            }

            let matchLength = (token & 0x0f) + 4;

            if ((token & 0x0f) === 15) {
                let value;

                do {
                    if (src >= input.length) {
                        throw new Error(
                            "Truncated LZ4 match length"
                        );
                    }

                    value = input[src++];
                    matchLength += value;
                } while (value === 255);
            }

            if (dst + matchLength > output.length) {
                throw new Error("LZ4 output overflow");
            }

            for (let i = 0; i < matchLength; i++) {
                output[dst] =
                    output[dst - matchOffset];

                dst++;
            }
        }

        if (dst !== expectedSize) {
            throw new Error(
                `LZ4 size mismatch: expected ${expectedSize}, got ${dst}`
            );
        }

        return output;
    }

    // ==================== SESSION STATE ====================

    function createConnection(socket, url) {
        const state = {
            socket,
            url: String(url || ""),

            dks: null,
            serverVersion: "",

            lastPacket: 0,
            lastWorldUpdate: 0,

            worldUpdates: 0,
            decodedPackets: 0,
            errors: 0,

            closed: false,
            queue: Promise.resolve(),

            cells: new Map(),
            foods: new Map(),
            ownedIds: new Set(),

            view: null,
            viewAt: 0,

            border: null
        };

        connections.push(state);

        return state;
    }

    // ==================== ACTIVE CONNECTION ====================

    function getActiveConnection() {
        const now = Date.now();

        return connections
            .filter(state =>
                !state.closed &&
                state.worldUpdates > 0 &&
                now - state.lastWorldUpdate < 15000
            )
            .sort(
                (a, b) => b.lastWorldUpdate - a.lastWorldUpdate
            )[0] || null;
    }

    // ==================== FOOD COORDINATE INDEX ====================

    function foodKey(x, y) {
        return `${Math.round(x)},${Math.round(y)}`;
    }

    function refreshFoodCoordinateIndex(state) {
        if (!state) return;

        if (
            foodIndexState === state &&
            foodIndexWorldUpdates === state.worldUpdates &&
            foodIndexFoodCount === state.foods.size
        ) {
            return;
        }

        const nextIndex = new Set();

        for (const food of state.foods.values()) {
            if (
                Number.isFinite(food.x) &&
                Number.isFinite(food.y)
            ) {
                nextIndex.add(foodKey(food.x, food.y));
            }
        }

        foodCoordinateIndex = nextIndex;
        foodIndexState = state;
        foodIndexWorldUpdates = state.worldUpdates;
        foodIndexFoodCount = state.foods.size;
    }

    function isKnownFoodPosition(x, y) {
        return foodCoordinateIndex.has(foodKey(x, y));
    }

    // ==================== LIVE CANVAS TRANSFORM PROBE ====================

    function captureWorldTransform(context, x, y, source) {
        try {
            const canvas = context?.canvas;

            if (
                !canvas ||
                (canvas !== gameCanvas && canvas.id !== "canvas")
            ) {
                return;
            }

            const probeNow = performance.now();

            if (
                probeNow - lastTransformProbeAt <
                TRANSFORM_PROBE_INTERVAL_MS
            ) {
                return;
            }

            lastTransformProbeAt = probeNow;

            if (
                !Number.isFinite(x) ||
                !Number.isFinite(y)
            ) {
                return;
            }

            // Record a transform only when the coordinates correspond
            // to food positions already known to the packet tracker.
            if (!isKnownFoodPosition(x, y)) {
                return;
            }

            if (typeof context.getTransform !== "function") {
                return;
            }

            const matrix = context.getTransform();

            if (
                !Number.isFinite(matrix.a) ||
                !Number.isFinite(matrix.b) ||
                !Number.isFinite(matrix.c) ||
                !Number.isFinite(matrix.d) ||
                !Number.isFinite(matrix.e) ||
                !Number.isFinite(matrix.f)
            ) {
                return;
            }

            const determinant =
                matrix.a * matrix.d -
                matrix.b * matrix.c;

            if (
                !Number.isFinite(determinant) ||
                Math.abs(determinant) < 1e-9
            ) {
                return;
            }

            lastWorldTransform = {
                a: matrix.a,
                b: matrix.b,
                c: matrix.c,
                d: matrix.d,
                e: matrix.e,
                f: matrix.f,

                canvasWidth: canvas.width,
                canvasHeight: canvas.height,

                capturedAt: probeNow,

                matchedX: x,
                matchedY: y,

                source
            };
        } catch {
            // Instrumentation must never interrupt the game renderer.
        }
    }

    function installCanvasTransformProbe() {
        if (!canvas2DPrototype) return;

        if (typeof originalArc === "function") {
            patchedArc = function (x, y, ...rest) {
                captureWorldTransform(
                    this,
                    x,
                    y,
                    "arc"
                );

                return originalArc.call(
                    this,
                    x,
                    y,
                    ...rest
                );
            };

            canvas2DPrototype.arc = patchedArc;
        }


    }

    function uninstallCanvasTransformProbe() {
        if (!canvas2DPrototype) return;

        if (
            patchedArc &&
            canvas2DPrototype.arc === patchedArc
        ) {
            canvas2DPrototype.arc = originalArc;
        }

    }

    // Install early, before Agar.io starts drawing frames.
    installCanvasTransformProbe();

    // ==================== PACKET PROCESSING ====================

    function processRawPacket(state, raw) {
        if (stopped || !raw || raw.length === 0) {
            return;
        }

        state.lastPacket = Date.now();

        // DKS handshake.
        if (raw[0] === 0xf1 && raw.length >= 7) {
            const version = readAsciiString(raw, 5);

            if (
                /^[0-9][0-9A-Za-z._-]{1,24}$/.test(version)
            ) {
                const view = getView(raw);
                const newDks = view.getUint32(1, true);

                if (state.dks !== newDks) {
                    state.cells.clear();
                    state.foods.clear();
                    state.ownedIds.clear();

                    state.view = null;
                    state.worldUpdates = 0;

                    if (foodIndexState === state) {
                        foodCoordinateIndex.clear();
                        foodIndexWorldUpdates = -1;
                        foodIndexFoodCount = -1;
                    }
                }

                state.dks = newDks;
                state.serverVersion = version;

                console.info(
                    `[Food Radar] Connection detected; server ${version}.`
                );

                return;
            }
        }

        if (state.dks === null) return;

        const xorKey = (state.dks ^ EKS) >>> 0;
        const decoded = new Uint8Array(raw.length);

        for (let i = 0; i < raw.length; i++) {
            const keyByte =
                (xorKey >>> ((i & 3) * 8)) & 0xff;

            decoded[i] = raw[i] ^ keyByte;
        }

        let packet = decoded;

        if (decoded[0] === 0xff) {
            if (decoded.length < 5) return;

            const view = getView(decoded);
            const expectedSize = view.getUint32(1, true);

            packet = decompressLZ4(
                decoded.subarray(5),
                expectedSize
            );
        }

        if (packet.length === 0) return;

        state.decodedPackets++;

        processGamePacket(state, packet);
    }

    function processGamePacket(state, packet) {
        const opcode = packet[0];
        const view = getView(packet);

        // 0x10: world update.
        if (opcode === 0x10) {
            parseWorldUpdate(state, packet);
            return;
        }

        // 0x11: possible viewport/camera packet.
        if (opcode === 0x11 && packet.length >= 13) {
            const x = view.getFloat32(1, true);
            const y = view.getFloat32(5, true);
            const zoom = view.getFloat32(9, true);

            if (
                Number.isFinite(x) &&
                Number.isFinite(y) &&
                Number.isFinite(zoom) &&
                zoom > 0
            ) {
                state.view = { x, y, zoom };
                state.viewAt = Date.now();
            }

            return;
        }

        // 0x12: reset.
        if (opcode === 0x12) {
            state.cells.clear();
            state.foods.clear();
            state.ownedIds.clear();

            if (foodIndexState === state) {
                foodCoordinateIndex.clear();
                foodIndexWorldUpdates = -1;
                foodIndexFoodCount = -1;
            }

            return;
        }

        // 0x20: owned cell ID.
        if (opcode === 0x20 && packet.length >= 5) {
            state.ownedIds.add(
                view.getUint32(1, true)
            );

            return;
        }

        // 0x40: map boundaries.
        if (opcode === 0x40 && packet.length >= 33) {
            state.border = {
                left: view.getFloat64(1, true),
                top: view.getFloat64(9, true),
                right: view.getFloat64(17, true),
                bottom: view.getFloat64(25, true)
            };
        }
    }

    // ==================== WORLD UPDATE PARSER ====================

    function parseWorldUpdate(state, packet) {
        try {
            const view = getView(packet);

            if (
                !packet ||
                packet.length < 7 ||
                view.byteLength !== packet.length
            ) {
                return;
            }

            const readString = (bytes, offset) => {
                const start = offset;

                while (
                    offset < bytes.length &&
                    bytes[offset] !== 0
                ) {
                    offset++;
                }

                if (offset >= bytes.length) {
                    throw new Error(
                        "Unterminated cell metadata string"
                    );
                }

                return {
                    value: new TextDecoder("utf-8").decode(
                        bytes.subarray(start, offset)
                    ),
                    next: offset + 1
                };
            };

            const removeCell = id => {
                state.cells.delete(id);
                state.foods.delete(id);
                state.ownedIds.delete(id);
            };

            let offset = 1;

            const eatCount = view.getUint16(offset, true);
            offset += 2;

            if (offset + eatCount * 8 > packet.length) {
                return;
            }

            for (let i = 0; i < eatCount; i++) {
                const victimId =
                    view.getUint32(offset + 4, true);

                removeCell(victimId);
                offset += 8;
            }

            const now = Date.now();
            let foundEndMarker = false;

            while (offset + 4 <= packet.length) {
                const id = view.getUint32(offset, true);
                offset += 4;

                if (id === 0) {
                    foundEndMarker = true;
                    break;
                }

                // x, y, radius and flags.
                if (offset + 11 > packet.length) {
                    return;
                }

                const x = view.getInt32(offset, true);
                offset += 4;

                const y = view.getInt32(offset, true);
                offset += 4;

                const radius = view.getUint16(offset, true);
                offset += 2;

                const flags = packet[offset++];

                const previous = state.cells.get(id);

                let flags2 = previous?.flags2 ?? 0;
                let flags2Present = false;

                if (flags & 0x80) {
                    if (offset >= packet.length) {
                        return;
                    }

                    flags2 = packet[offset++];
                    flags2Present = true;
                }

                let color = previous?.color ?? null;
                let skin = previous?.skin ?? null;
                let name = previous?.name ?? null;
                let accountId =
                    previous?.accountId ?? null;

                // Color.
                if (flags & 0x02) {
                    if (offset + 3 > packet.length) {
                        return;
                    }

                    const r = packet[offset++];
                    const g = packet[offset++];
                    const b = packet[offset++];

                    color =
                        "#" +
                        r.toString(16).padStart(2, "0") +
                        g.toString(16).padStart(2, "0") +
                        b.toString(16).padStart(2, "0");
                }

                // Skin.
                if (flags & 0x04) {
                    const result = readString(packet, offset);

                    skin = result.value;
                    offset = result.next;
                }

                // Name.
                if (flags & 0x08) {
                    const result = readString(packet, offset);

                    name = result.value;
                    offset = result.next;
                }

                // Account ID only when the field is present.
                if (flags2Present && (flags2 & 0x04)) {
                    if (offset + 4 > packet.length) {
                        return;
                    }

                    accountId =
                        view.getUint32(offset, true);

                    offset += 4;
                }

                if (offset > packet.length) {
                    return;
                }

                // Movement estimate from consecutive updates.
                let vx = previous?.vx ?? null;
                let vy = previous?.vy ?? null;
                let velocityValid = false;

                if (previous) {
                    const previousTime =
                        previous.lastSeenAt ??
                        previous.time ??
                        now;

                    const dt =
                        (now - previousTime) / 1000;

                    if (dt >= 0.01 && dt <= 5) {
                        const rawVx =
                            (x - previous.x) / dt;

                        const rawVy =
                            (y - previous.y) / dt;

                        const rawSpeed =
                            Math.hypot(rawVx, rawVy);

                        if (
                            Number.isFinite(rawSpeed) &&
                            rawSpeed <= 5000
                        ) {
                            const alpha = 0.35;

                            vx = previous.vx == null
                                ? rawVx
                                : previous.vx * (1 - alpha) +
                                  rawVx * alpha;

                            vy = previous.vy == null
                                ? rawVy
                                : previous.vy * (1 - alpha) +
                                  rawVy * alpha;

                            velocityValid = true;
                        }
                    }
                }

                const isFood = (flags2 & 0x01) !== 0;
                const isVirus = (flags & 0x01) !== 0;

                const cell = {
                    id,
                    x,
                    y,
                    radius,

                    mass: (radius * radius) / 100,

                    flags,
                    flags2,

                    isFood,
                    isVirus,

                    color,
                    skin,
                    name,
                    accountId,

                    vx,
                    vy,

                    speed:
                        vx == null || vy == null
                            ? null
                            : Math.hypot(vx, vy),

                    velocityValid,

                    firstSeenAt:
                        previous?.firstSeenAt ?? now,

                    lastSeenAt: now,
                    time: now,

                    updateCount:
                        (previous?.updateCount ?? 0) + 1
                };

                state.cells.set(id, cell);

                if (isFood) {
                    state.foods.set(id, cell);
                } else {
                    state.foods.delete(id);
                }
            }

            if (!foundEndMarker) {
                return;
            }

            // Deletion list.
            if (offset + 2 <= packet.length) {
                const deleteCount =
                    view.getUint16(offset, true);

                offset += 2;

                if (
                    offset + deleteCount * 4 <=
                    packet.length
                ) {
                    for (
                        let i = 0;
                        i < deleteCount;
                        i++
                    ) {
                        const id =
                            view.getUint32(offset, true);

                        removeCell(id);
                        offset += 4;
                    }
                }
            }

            state.worldUpdates++;
            state.lastWorldUpdate = now;

        } catch (error) {
            state.errors++;

            if (state.errors === 1) {
                console.warn(
                    "[Food Radar] Packet parsing error:",
                    error
                );
            }
        }
    }

    // ==================== WEBSOCKET OBSERVER ====================

    function attachSocket(socket, url) {
        const state = createConnection(socket, url);

        socket.addEventListener("message", event => {
            const data = event.data;

            state.queue = state.queue
                .then(async () => {
                    if (stopped) return;

                    const bytes = await normalizeData(data);

                    if (bytes) {
                        processRawPacket(state, bytes);
                    }
                })
                .catch(error => {
                    state.errors++;

                    if (state.errors === 1) {
                        console.warn(
                            "[Food Radar] WebSocket decode error:",
                            error
                        );
                    }
                });
        });

        socket.addEventListener("close", () => {
            state.closed = true;
        });
    }

    // Install before the game opens its connection.
    const WrappedWebSocket = new Proxy(NativeWebSocket, {
        construct(target, args, newTarget) {
            const socket = Reflect.construct(
                target,
                args,
                newTarget
            );

            attachSocket(socket, args[0]);

            return socket;
        }
    });

    window.WebSocket = WrappedWebSocket;

    // ==================== CAMERA FALLBACK ====================

    function getCamera(state, canvas) {
        const now = Date.now();

        if (
            state.view &&
            now - state.viewAt < 1200
        ) {
            return {
                x: state.view.x,
                y: state.view.y,
                scale: state.view.zoom * zoomCorrection,
                source: "viewport"
            };
        }

        const owned = [...state.ownedIds]
            .map(id => state.cells.get(id))
            .filter(cell =>
                cell &&
                Number.isFinite(cell.x) &&
                Number.isFinite(cell.y) &&
                cell.radius > 0
            );

        if (owned.length > 0) {
            const x = owned.reduce(
                (sum, cell) => sum + cell.x,
                0
            ) / owned.length;

            const y = owned.reduce(
                (sum, cell) => sum + cell.y,
                0
            ) / owned.length;

            const totalRadius = owned.reduce(
                (sum, cell) => sum + cell.radius,
                0
            );

            const viewportScale = Math.max(
                canvas.height / 1080,
                canvas.width / 1920
            );

            const cellScale = Math.pow(
                Math.min(
                    64 / Math.max(totalRadius, 1),
                    1
                ),
                0.4
            );

            return {
                x,
                y,
                scale:
                    cellScale *
                    viewportScale *
                    zoomCorrection,
                source: "estimated"
            };
        }

        if (
            state.view &&
            now - state.viewAt < 15000
        ) {
            return {
                x: state.view.x,
                y: state.view.y,
                scale: state.view.zoom * zoomCorrection,
                source: "viewport-stale"
            };
        }

        return null;
    }

    // ==================== OVERLAY UI ====================

    function ensureUI() {
        if (!document.body) return false;

        const canvas = document.querySelector("#canvas");

        if (!canvas) return false;

        if (canvas !== gameCanvas) {
            gameCanvas = canvas;
        }

        if (!overlayCanvas) {
            overlayCanvas =
                document.createElement("canvas");

            Object.assign(overlayCanvas.style, {
                position: "fixed",
                pointerEvents: "none",
                zIndex: "2147483646",
                left: "0",
                top: "0"
            });

            document.body.appendChild(overlayCanvas);

            overlayContext =
                overlayCanvas.getContext("2d");

            statusElement =
                document.createElement("div");

            Object.assign(statusElement.style, {
                position: "fixed",
                left: "12px",
                bottom: "12px",
                zIndex: "2147483647",
                pointerEvents: "none",
                padding: "6px 9px",
                borderRadius: "6px",
                background: "rgba(0, 0, 0, 0.72)",
                color: "#00ffff",
                font: "12px monospace",
                whiteSpace: "pre",
                maxWidth: "90vw"
            });

            document.body.appendChild(statusElement);
        }

        return true;
    }

    function resizeOverlay(rect) {
        const dpr = window.devicePixelRatio || 1;

        overlayCanvas.style.left = `${rect.left}px`;
        overlayCanvas.style.top = `${rect.top}px`;

        overlayCanvas.style.width =
            `${rect.width}px`;

        overlayCanvas.style.height =
            `${rect.height}px`;

        const width = Math.round(rect.width * dpr);
        const height = Math.round(rect.height * dpr);

        if (
            overlayCanvas.width !== width ||
            overlayCanvas.height !== height
        ) {
            overlayCanvas.width = width;
            overlayCanvas.height = height;
        }

        overlayContext.setTransform(
            dpr, 0,
            0, dpr,
            0, 0
        );

        overlayContext.clearRect(
            0, 0,
            rect.width,
            rect.height
        );
    }

    // ==================== MARKER DRAWING ====================

    function drawFoodMarkers(state, rect) {
        const ctx = overlayContext;
        const canvas = gameCanvas;
        const now = performance.now();

        let visibleCount = 0;

        const transform = lastWorldTransform;

        const transformUsable =
            transform &&
            now - transform.capturedAt <=
                TRANSFORM_MAX_AGE_MS &&
            transform.canvasWidth === canvas.width &&
            transform.canvasHeight === canvas.height &&
            canvas.width > 0 &&
            canvas.height > 0;

        let camera = null;

        if (!transformUsable) {
            camera = getCamera(state, canvas);
        }

        ctx.strokeStyle = MARKER_COLOR;
        ctx.fillStyle = MARKER_COLOR;
        ctx.lineWidth = 1.5;

        let scaleX = 0;
        let scaleY = 0;

        if (transformUsable) {
            // Convert actual game-canvas backing coordinates
            // into the overlay's CSS-pixel coordinates.
            scaleX =
                Math.hypot(transform.a, transform.b) *
                rect.width / canvas.width;

            scaleY =
                Math.hypot(transform.c, transform.d) *
                rect.height / canvas.height;
        }

        for (const food of state.foods.values()) {
            let x;
            let y;
            let radius;

            if (transformUsable) {
                // The same transformation used by the game's canvas.
                const backingX =
                    transform.a * food.x +
                    transform.c * food.y +
                    transform.e;

                const backingY =
                    transform.b * food.x +
                    transform.d * food.y +
                    transform.f;

                x = backingX * rect.width / canvas.width;
                y = backingY * rect.height / canvas.height;

                radius = Math.max(
                    MIN_MARKER_RADIUS,
                    food.radius * (scaleX + scaleY) / 2 + 2
                );
            } else if (
                camera &&
                Number.isFinite(camera.scale) &&
                camera.scale > 0
            ) {
                // Fallback projection when no live transform
                // could be matched to a known food position.
                const sx =
                    camera.scale *
                    rect.width / canvas.width;

                const sy =
                    camera.scale *
                    rect.height / canvas.height;

                x =
                    rect.width / 2 +
                    (food.x - camera.x) * sx;

                y =
                    rect.height / 2 +
                    (food.y - camera.y) * sy;

                radius = Math.max(
                    MIN_MARKER_RADIUS,
                    food.radius * sx + 2
                );
            } else {
                continue;
            }

            if (
                !Number.isFinite(x) ||
                !Number.isFinite(y) ||
                !Number.isFinite(radius)
            ) {
                continue;
            }

            if (
                x < -12 ||
                y < -12 ||
                x > rect.width + 12 ||
                y > rect.height + 12
            ) {
                continue;
            }

            ctx.beginPath();
            ctx.arc(x, y, radius, 0, Math.PI * 2);
            ctx.stroke();

            ctx.beginPath();
            ctx.arc(x, y, 1.2, 0, Math.PI * 2);
            ctx.fill();

            visibleCount++;
        }

        const transformAge = transform
            ? Math.round(now - transform.capturedAt)
            : null;

        return {
            visibleCount,
            transformUsable,
            transformAge,
            transformSource:
                transformUsable
                    ? transform.source
                    : "estimated",
            cameraSource:
                camera?.source ?? "unavailable"
        };
    }

    // ==================== RENDER LOOP ====================

    function renderLoop() {
        if (stopped) return;

        if (!ensureUI()) return;

        const rect = gameCanvas.getBoundingClientRect();

        if (rect.width <= 0 || rect.height <= 0) {
            return;
        }

        resizeOverlay(rect);

        const state = getActiveConnection();

        if (!state) {
            statusElement.textContent =
                `Food Radar | Waiting for world updates\n` +
                `Sockets observed: ${connections.length}`;

            return;
        }

        refreshFoodCoordinateIndex(state);

        const result = drawFoodMarkers(state, rect);

        const transformStatus =
            result.transformUsable
                ? `Canvas transform: LIVE (${result.transformAge} ms)`
                : `Canvas transform: ${result.transformSource}`;

        statusElement.textContent =
            `Food Radar | Food: ${state.foods.size}` +
            ` | Marked: ${result.visibleCount}\n` +
            `World updates: ${state.worldUpdates}` +
            ` | ${transformStatus}` +
            ` | Zoom: ${zoomCorrection.toFixed(2)}`;
    }

    // ==================== FRAME SCHEDULER ====================

    function scheduleOverlayAfterGameFrame() {
        if (stopped) return;

        animationId = NativeRAF(() => {
            if (stopped) return;

            renderLoop();
            scheduleOverlayAfterGameFrame();
        });
    }

    WrappedRAF = function (callback) {
        return OriginalRAF.call(
            window,
            function (timestamp) {
                callback.call(window, timestamp);

                if (
                    !overlaySchedulerStarted &&
                    !stopped
                ) {
                    overlaySchedulerStarted = true;
                    scheduleOverlayAfterGameFrame();
                }
            }
        );
    };

    window.requestAnimationFrame = WrappedRAF;

    // ==================== PUBLIC API ====================

    window.agarFoodRadar = {
        status() {
            console.table(
                connections.map(state => ({
                    url: state.url,
                    serverVersion: state.serverVersion,
                    dksCaptured: state.dks !== null,
                    worldUpdates: state.worldUpdates,
                    decodedPackets: state.decodedPackets,
                    cells: state.cells.size,
                    foods: state.foods.size,
                    ownedCells: state.ownedIds.size,
                    errors: state.errors,
                    closed: state.closed
                }))
            );

            console.log(
                "[Food Radar] Last canvas transform:",
                lastWorldTransform
            );
        },

        getCells() {
            const state = getActiveConnection();

            if (!state) return [];

            return [...state.cells.values()].map(cell => {
                const isFood =
                    !!(cell.flags2 & 0x01);

                const isVirus =
                    !!(cell.flags & 0x01);

                const isEjectedMass =
                    !!(cell.flags & 0x20) ||
                    !!(cell.flags & 0x40);

                return {
                    id: cell.id,
                    x: cell.x,
                    y: cell.y,
                    radius: cell.radius,

                    accountId:
                        cell.accountId ?? null,

                    mass: Math.round(
                        cell.radius ** 2 / 100
                    ),

                    isFood,
                    isVirus,
                    isEjectedMass,

                    isMine:
                        state.ownedIds.has(cell.id),

                    isPlayerCell:
                        !isFood &&
                        !isVirus &&
                        !isEjectedMass,

                    name: cell.name ?? null,
                    color: cell.color ?? null,
                    skin: cell.skin ?? null,

                    vx: cell.vx ?? null,
                    vy: cell.vy ?? null,

                    flags: cell.flags ?? null,
                    flags2: cell.flags2 ?? null,

                    speed:
                        cell.speed ??
                        (
                            cell.vx == null ||
                            cell.vy == null
                                ? null
                                : Math.hypot(
                                    cell.vx,
                                    cell.vy
                                )
                        ),

                    velocityValid:
                        cell.velocityValid ?? false,

                    firstSeenAt:
                        cell.firstSeenAt ?? null,

                    lastSeenAt:
                        cell.lastSeenAt ??
                        cell.time ??
                        null,

                    updateCount:
                        cell.updateCount ?? 0
                };
            });
        },

        getPlayers() {
            return this.getCells().filter(
                cell =>
                    cell.isPlayerCell &&
                    !cell.isMine
            );
        },

        getMyCells() {
            return this.getCells().filter(
                cell => cell.isMine
            );
        },

        getUniquePlayers() {
            const cells = this.getPlayers();
            const groups = new Map();

            for (const cell of cells) {
                const rawId = cell.accountId;

                const hasAccountId =
                    rawId !== null &&
                    rawId !== undefined &&
                    rawId !== 0 &&
                    Number.isFinite(Number(rawId));

                const key = hasAccountId
                    ? `account:${rawId}`
                    : `cell:${cell.id}`;

                if (!groups.has(key)) {
                    groups.set(key, {
                        accountId:
                            hasAccountId
                                ? Number(rawId)
                                : null,

                        identityConfidence:
                            hasAccountId
                                ? "account-id"
                                : "unlinked-cell",

                        name: cell.name || "(unknown)",

                        cells: [],
                        mass: 0,

                        weightedX: 0,
                        weightedY: 0,
                        positionWeight: 0,

                        weightedVx: 0,
                        weightedVy: 0,
                        velocityWeight: 0,

                        colors: new Set(),
                        skins: new Set()
                    });
                }

                const group = groups.get(key);
                const weight = Math.max(
                    1,
                    Number(cell.mass) || 1
                );

                group.cells.push(cell);
                group.mass += Number(cell.mass) || 0;

                group.weightedX += cell.x * weight;
                group.weightedY += cell.y * weight;
                group.positionWeight += weight;

                if (
                    Number.isFinite(cell.vx) &&
                    Number.isFinite(cell.vy)
                ) {
                    group.weightedVx += cell.vx * weight;
                    group.weightedVy += cell.vy * weight;
                    group.velocityWeight += weight;
                }

                if (cell.color) {
                    group.colors.add(cell.color);
                }

                if (cell.skin) {
                    group.skins.add(cell.skin);
                }
            }

            return [...groups.values()].map(group => ({
                accountId: group.accountId,

                identityConfidence:
                    group.identityConfidence,

                name: group.name,

                cellCount: group.cells.length,
                mass: group.mass,

                x:
                    group.weightedX /
                    group.positionWeight,

                y:
                    group.weightedY /
                    group.positionWeight,

                radius: Math.sqrt(group.mass * 100),

                vx:
                    group.velocityWeight
                        ? group.weightedVx /
                          group.velocityWeight
                        : null,

                vy:
                    group.velocityWeight
                        ? group.weightedVy /
                          group.velocityWeight
                        : null,

                colors: [...group.colors],
                skins: [...group.skins],
                cells: group.cells
            }));
        },

        get zoomCorrection() {
            return zoomCorrection;
        },

        set zoomCorrection(value) {
            const parsed = Number(value);

            if (
                Number.isFinite(parsed) &&
                parsed >= 0.1 &&
                parsed <= 5
            ) {
                zoomCorrection = parsed;
            }
        },

        worldToScreen(worldX, worldY) {
            const transform = lastWorldTransform;
            const canvas = gameCanvas;

            if (!transform || !canvas) return null;

            const ageMs = performance.now() - transform.capturedAt;

            if (ageMs > 250) return null;

            if (
                canvas.width !== transform.canvasWidth ||
                canvas.height !== transform.canvasHeight
            ) {
                return null;
            }

            const rect = canvas.getBoundingClientRect();

            if (
                rect.width <= 0 ||
                rect.height <= 0 ||
                !Number.isFinite(worldX) ||
                !Number.isFinite(worldY)
            ) {
                return null;
            }

            const backingX =
                  transform.a * worldX +
                  transform.c * worldY +
                  transform.e;

            const backingY =
                  transform.b * worldX +
                  transform.d * worldY +
                  transform.f;

            return {
                x: rect.left + backingX * rect.width / canvas.width,
                y: rect.top + backingY * rect.height / canvas.height,
                ageMs
            };
        },

        cameraDebug() {
            const state = getActiveConnection();

            return {
                activeConnection: !!state,
                viewportReceived: !!state?.view,

                viewportAgeMs: state?.view
                    ? Date.now() - state.viewAt
                    : null,

                transformCaptured: !!lastWorldTransform,

                transformAgeMs: lastWorldTransform
                    ? Math.round(
                        performance.now() -
                        lastWorldTransform.capturedAt
                    )
                    : null,

                transformSource:
                    lastWorldTransform?.source ?? null,

                transformCanvasSize:
                    lastWorldTransform
                        ? {
                            width:
                                lastWorldTransform.canvasWidth,
                            height:
                                lastWorldTransform.canvasHeight
                        }
                        : null,

                zoomCorrection
            };
        },

        stop() {
            stopped = true;

            cancelAnimationFrame(animationId);

            if (
                window.WebSocket === WrappedWebSocket
            ) {
                window.WebSocket = NativeWebSocket;
            }

            if (
                window.requestAnimationFrame === WrappedRAF
            ) {
                window.requestAnimationFrame = OriginalRAF;
            }

            uninstallCanvasTransformProbe();

            overlayCanvas?.remove();
            statusElement?.remove();

            console.log("[Food Radar] Stopped.");
        }
    };

    console.info(
        "[Food Radar] Installed. Reload Agar.io if it was already connected."
    );
})();

/* ==================== FOOD BOT ==================== */
(() => {
     "use strict";

     // =========================================================
     // SETTINGS
     // =========================================================

     const TOGGLE_KEY = "b";
     const TICK_MS = 130;
     const MOUSE_UPDATE_THRESHOLD = 2;

     // Stable target selection.
     const MIN_TARGET_LOCK_MS = 700;
     const MAX_TARGET_LOCK_MS = 4500;
     const TARGET_SWITCH_MARGIN = 0.22;

     // Progress monitoring.
     const STUCK_TIMEOUT_MS = 4000;
     const STUCK_PROGRESS_DISTANCE = 12;
     const TARGET_BLACKLIST_MS = 3500;

     // Enemy danger.
     const DANGER_SIZE_RATIO = 1.12;
     const DANGER_BASE_DISTANCE = 240;
     const DANGER_RADIUS_MULTIPLIER = 3.2;
     const PREDICTION_HORIZON = 1.25;
     const MAX_VELOCITY_AGE_MS = 650;

     // Virus avoidance.
     const VIRUS_HAZARD_RATIO = 0.92;
     const VIRUS_BASE_DISTANCE = 140;
     const VIRUS_DISTANCE_MULTIPLIER = 1.4;

     // Food scoring.
     const FOOD_RISK_SEARCH_DISTANCE = 2200;
     const FOOD_RISK_RADIUS_MULTIPLIER = 2.7;
     const FOOD_RISK_PENALTY = 2.2;
     const FOOD_CLUSTER_GRID_SIZE = 180;
     const FOOD_CLUSTER_RADIUS = 250;
     const FOOD_CLUSTER_REWARD = 12;

     // Limit expensive risk calculations to the nearest candidates.
     // Keep the current target in the pool while it remains visible.
     const MAX_FOOD_CANDIDATES_TO_SCORE = 96;

     // Keep steering away briefly if a threat flickers out between updates.
     const ESCAPE_RECOVERY_MS = 850;

     // Movement.
     const ESCAPE_DISTANCE_MULTIPLIER = 1.3;
     const EDGE_MARGIN = 24;

     // New ability: opportunistic hunting.
     const HUNT_SIZE_RATIO = 1.25;
     const HUNT_LEAD_SECONDS = 0.28;
     const HUNT_TARGET_LOCK_MS = 900;
     const HUNT_SWITCH_MARGIN = 0.20;
     const HUNT_PREDATOR_DANGER_RADIUS = 760;

     // Optional split attack, disabled by default.
     const AUTO_SPLIT_MIN_RADIUS_RATIO = 1.65;
     const AUTO_SPLIT_COOLDOWN_MS = 1800;
     const AUTO_SPLIT_TARGET_RETRY_MS = 10000;
     const AUTO_SPLIT_SCREEN_RANGE_RATIO = 0.32;

     // =========================================================
     // STATE
     // =========================================================

     let enabled = false;
     let hud = null;
     let lastHudUpdate = 0;

     let lastAimX = null;
     let lastAimY = null;

     let lastMode = "Disabled";
     let lastTarget = "None";
     let lastError = "";
     let lastDetails = "";

     let currentTargetId = null;
     let targetLockedAt = 0;

     let progressTargetId = null;
     let bestTargetDistance = Infinity;
     let lastProgressAt = 0;

     const blockedTargets = new Map();

     // Escape hysteresis avoids immediately switching back to food.
     let lastEscapeVector = null;
     let escapeLockUntil = 0;

     let huntMode = false;
     let autoSplitEnabled = false;

     let currentPreyId = null;
     let preyLockedAt = 0;

     let lastSplitAt = 0;
     const splitTriedTargets = new Map();

     // =========================================================
     // HUD
     // =========================================================

     function ensureHUD() {
         if (hud || !document.body) return;

         hud = document.createElement("div");

         Object.assign(hud.style, {
             position: "fixed",
             top: "12px",
             left: "12px",
             zIndex: "2147483647",
             pointerEvents: "none",
             background: "rgba(10, 12, 24, 0.90)",
             color: "#a8ffff",
             border: "1px solid rgba(0, 255, 255, 0.55)",
             borderRadius: "8px",
             padding: "10px 12px",
             font: "12px/1.6 monospace",
             whiteSpace: "pre-line",
             minWidth: "245px"
         });

         document.body.appendChild(hud);
     }

     function updateHUD(force = false) {
         const now = Date.now();

         if (!force && now - lastHudUpdate < 200) return;

         lastHudUpdate = now;
         ensureHUD();

         if (!hud) return;

         hud.textContent =
             `AGAR BOT 0.5\n` +
             `Status: ${enabled ? "ON" : "OFF"}\n` +
             `Mode: ${lastMode}\n` +
             `Target: ${lastTarget}\n` +
             `Hunt: ${huntMode ? "ON" : "OFF"} | Split: ${autoSplitEnabled ? "ON" : "OFF"}\n` +
             `${lastDetails || lastError || ""}\n` +
             `[B] Bot  [H] Hunt  [J] Auto-split`;
     }

     // =========================================================
     // MANUAL MOUSE CONTROL
     // =========================================================

     function blockManualMouseMovement(event) {
         if (!enabled || !event.isTrusted) return;

         // Agar.io's gameplay input comes from the game canvas.
         // Avoid querySelector() and composedPath() on every mouse event.
         if (event.target?.id !== "canvas") return;

         event.preventDefault();
         event.stopImmediatePropagation();
     }

     window.addEventListener(
         "mousemove",
         blockManualMouseMovement,
         true
     );

     window.addEventListener(
         "pointermove",
         blockManualMouseMovement,
         true
     );

     // =========================================================
     // TRACKER API
     // =========================================================

     function getAPI() {
         const api = window.agarFoodRadar;

         if (
             !api ||
             typeof api.getCells !== "function" ||
             typeof api.getMyCells !== "function" ||
             typeof api.worldToScreen !== "function"
         ) {
             return null;
         }

         return api;
     }

     function validCell(cell) {
         return Boolean(
             cell &&
             Number.isFinite(cell.x) &&
             Number.isFinite(cell.y) &&
             Number.isFinite(cell.radius) &&
             cell.radius > 0
         );
     }

     function cellAge(cell, now = Date.now()) {
         if (!Number.isFinite(cell.lastSeenAt)) {
             return Infinity;
         }

         return Math.max(0, now - cell.lastSeenAt);
     }

     function isFreshCell(cell, maxAge, now = Date.now()) {
         return cellAge(cell, now) <= maxAge;
     }

     function distance(a, b) {
         return Math.hypot(a.x - b.x, a.y - b.y);
     }

     // =========================================================
     // PLAYER POSITION AND VELOCITY
     // =========================================================

     function getPlayerCenter(myCells) {
         let totalWeight = 0;
         let x = 0;
         let y = 0;

         for (const cell of myCells) {
             if (!validCell(cell)) continue;

             const weight = Math.max(
                 1,
                 Number(cell.mass) || cell.radius ** 2 / 100
             );

             x += cell.x * weight;
             y += cell.y * weight;
             totalWeight += weight;
         }

         if (totalWeight <= 0) return null;

         return {
             x: x / totalWeight,
             y: y / totalWeight
         };
     }

     function getVelocity(cell, now = Date.now()) {
         if (
             cell.velocityValid !== true ||
             !isFreshCell(cell, MAX_VELOCITY_AGE_MS, now) ||
             !Number.isFinite(cell.vx) ||
             !Number.isFinite(cell.vy) ||
             Math.hypot(cell.vx, cell.vy) > 4000
         ) {
             return { x: 0, y: 0, valid: false };
         }

         return {
             x: cell.vx,
             y: cell.vy,
             valid: true
         };
     }

     function predictPosition(cell, seconds, now = Date.now()) {
         const velocity = getVelocity(cell, now);

         return {
             x: cell.x + velocity.x * seconds,
             y: cell.y + velocity.y * seconds
         };
     }

     function clamp(value, min, max) {
         return Math.max(min, Math.min(max, value));
     }

     function pointSegmentDistance(point, start, end) {
         const dx = end.x - start.x;
         const dy = end.y - start.y;
         const lengthSquared = dx * dx + dy * dy;

         if (lengthSquared < 1e-9) {
             return distance(point, start);
         }

         const t = clamp(
             (
                 (point.x - start.x) * dx +
                 (point.y - start.y) * dy
             ) / lengthSquared,
             0,
             1
         );

         return distance(point, {
             x: start.x + t * dx,
             y: start.y + t * dy
         });
     }

     // =========================================================
     // MOUSE CONTROL
     // =========================================================

     function moveMouse(screenX, screenY) {
         const canvas = document.querySelector("#canvas");

         if (!canvas) {
             lastError = "Game canvas not found";
             return false;
         }

         if (
             !Number.isFinite(screenX) ||
             !Number.isFinite(screenY)
         ) {
             return false;
         }

         if (
             lastAimX !== null &&
             Math.abs(screenX - lastAimX) < MOUSE_UPDATE_THRESHOLD &&
             Math.abs(screenY - lastAimY) < MOUSE_UPDATE_THRESHOLD
         ) {
             return true;
         }

         canvas.dispatchEvent(
             new MouseEvent("mousemove", {
                 bubbles: true,
                 cancelable: true,
                 view: window,
                 clientX: screenX,
                 clientY: screenY
             })
         );

         lastAimX = screenX;
         lastAimY = screenY;

         return true;
     }

     function clampToCanvas(x, y) {
         const canvas = document.querySelector("#canvas");

         if (!canvas) return null;

         const rect = canvas.getBoundingClientRect();

         return {
             x: clamp(
                 x,
                 rect.left + EDGE_MARGIN,
                 rect.right - EDGE_MARGIN
             ),
             y: clamp(
                 y,
                 rect.top + EDGE_MARGIN,
                 rect.bottom - EDGE_MARGIN
             )
         };
     }

     function aimAtWorldPoint(api, point) {
         const screen = api.worldToScreen(point.x, point.y);

         if (!screen) {
             lastError = "Waiting for fresh canvas transform";
             return false;
         }

         return moveMouse(screen.x, screen.y);
     }

     // =========================================================
     // THREAT ASSESSMENT
     // =========================================================

     function findThreats(myCells, enemies, now) {
         const threats = [];

         for (const mine of myCells) {
             if (!validCell(mine)) continue;

             const mineVelocity = getVelocity(mine, now);

             for (const enemy of enemies) {
                 if (!validCell(enemy)) continue;

                 if (
                     enemy.radius <
                     mine.radius * DANGER_SIZE_RATIO
                 ) {
                     continue;
                 }

                 const enemyVelocity = getVelocity(enemy, now);

                 const rx = enemy.x - mine.x;
                 const ry = enemy.y - mine.y;

                 const rvx = enemyVelocity.x - mineVelocity.x;
                 const rvy = enemyVelocity.y - mineVelocity.y;

                 const relativeSpeedSquared =
                     rvx * rvx + rvy * rvy;

                 let closestTime = 0;

                 if (relativeSpeedSquared > 1) {
                     closestTime = clamp(
                         -(
                             rx * rvx +
                             ry * rvy
                         ) / relativeSpeedSquared,
                         0,
                         PREDICTION_HORIZON
                     );
                 }

                 const currentDistance = Math.hypot(rx, ry);

                 const futureMine = {
                     x: mine.x + mineVelocity.x * closestTime,
                     y: mine.y + mineVelocity.y * closestTime
                 };

                 const futureEnemy = {
                     x: enemy.x + enemyVelocity.x * closestTime,
                     y: enemy.y + enemyVelocity.y * closestTime
                 };

                 const futureDistance = distance(
                     futureMine,
                     futureEnemy
                 );

                 const dangerDistance = Math.max(
                     DANGER_BASE_DISTANCE,
                     (
                         mine.radius +
                         enemy.radius
                     ) * DANGER_RADIUS_MULTIPLIER
                 );

                 const immediateDanger =
                     currentDistance < dangerDistance;

                 const approachingDanger =
                     closestTime > 0.05 &&
                     futureDistance < dangerDistance * 1.05 &&
                     currentDistance < dangerDistance * 2.0;

                 if (!immediateDanger && !approachingDanger) {
                     continue;
                 }

                 const closestDistance = Math.min(
                     currentDistance,
                     futureDistance
                 );

                 const proximity = clamp(
                     1 - closestDistance / dangerDistance,
                     0.05,
                     1
                 );

                 const sizeFactor = Math.min(
                     enemy.radius / Math.max(mine.radius, 1),
                     4
                 );

                 const urgency = proximity * sizeFactor;

                 // Direction away from the enemy at closest approach.
                 let awayX = futureMine.x - futureEnemy.x;
                 let awayY = futureMine.y - futureEnemy.y;

                 let magnitude = Math.hypot(awayX, awayY);

                 if (magnitude < 1) {
                     awayX = mine.x - enemy.x;
                     awayY = mine.y - enemy.y;
                     magnitude = Math.hypot(awayX, awayY);
                 }

                 if (magnitude > 0) {
                     awayX /= magnitude;
                     awayY /= magnitude;
                 }

                 threats.push({
                     type: "enemy",
                     mine,
                     enemy,
                     distance: currentDistance,
                     futureDistance,
                     dangerDistance,
                     urgency,
                     awayX,
                     awayY,
                     closestTime
                 });
             }
         }

         return threats;
     }

     // =========================================================
     // VIRUS HAZARDS
     // =========================================================

     function findVirusHazards(myCells, viruses) {
         const hazards = [];

         if (!viruses.length || !myCells.length) {
             return hazards;
         }

         const largestOwnRadius = Math.max(
             ...myCells.map(cell => cell.radius)
         );

         // Small cells usually can use a virus differently than
         // very large cells, so only apply this rule when relevant.
         for (const virus of viruses) {
             if (!validCell(virus)) continue;

             if (
                 largestOwnRadius <
                 virus.radius * VIRUS_HAZARD_RATIO
             ) {
                 continue;
             }

             for (const mine of myCells) {
                 if (!validCell(mine)) continue;

                 // Do not treat a virus as dangerous to a cell
                 // that is much smaller than it.
                 if (
                     mine.radius <
                     virus.radius * VIRUS_HAZARD_RATIO
                 ) {
                     continue;
                 }

                 const d = distance(mine, virus);

                 const dangerDistance = Math.max(
                     VIRUS_BASE_DISTANCE,
                     (
                         mine.radius +
                         virus.radius
                     ) * VIRUS_DISTANCE_MULTIPLIER
                 );

                 if (d >= dangerDistance) continue;

                 let awayX = mine.x - virus.x;
                 let awayY = mine.y - virus.y;
                 const magnitude = Math.hypot(awayX, awayY);

                 if (magnitude < 1) continue;

                 awayX /= magnitude;
                 awayY /= magnitude;

                 hazards.push({
                     type: "virus",
                     mine,
                     enemy: virus,
                     distance: d,
                     dangerDistance,
                     urgency: (
                         1 - d / dangerDistance
                     ) * 1.3,
                     awayX,
                     awayY,
                     closestTime: 0
                 });
             }
         }

         return hazards;
     }

     // =========================================================
     // MULTI-HAZARD ESCAPE
     // =========================================================

     function aimAlongWorldVector(api, center, vectorX, vectorY) {
         const canvas = document.querySelector("#canvas");
         if (!canvas) return false;

         const rect = canvas.getBoundingClientRect();
         const centerScreen = api.worldToScreen(center.x, center.y);
         const probeScreen = api.worldToScreen(
             center.x + vectorX * 100,
             center.y + vectorY * 100
         );

         if (!centerScreen || !probeScreen) {
             lastError = "Waiting for fresh canvas transform";
             return false;
         }

         let screenDX = probeScreen.x - centerScreen.x;
         let screenDY = probeScreen.y - centerScreen.y;
         const screenLength = Math.hypot(screenDX, screenDY);

         if (!Number.isFinite(screenLength) || screenLength < 1e-4) {
             return false;
         }

         screenDX /= screenLength;
         screenDY /= screenLength;

         const escapeDistance =
             Math.max(rect.width, rect.height) * ESCAPE_DISTANCE_MULTIPLIER;

         const target = clampToCanvas(
             centerScreen.x + screenDX * escapeDistance,
             centerScreen.y + screenDY * escapeDistance
         );

         return target ? moveMouse(target.x, target.y) : false;
     }

     function escapeFromHazards(api, hazards, center) {
         if (!hazards.length) return false;

         let vectorX = 0;
         let vectorY = 0;

         for (const hazard of hazards) {
             const weight = Math.max(0.01, hazard.urgency);
             vectorX += hazard.awayX * weight;
             vectorY += hazard.awayY * weight;
         }

         let magnitude = Math.hypot(vectorX, vectorY);

         // If threats surround the player and vectors cancel,
         // follow the direction away from the most urgent threat.
         if (magnitude < 0.05) {
             const nearest = [...hazards].sort(
                 (a, b) => b.urgency - a.urgency
             )[0];

             if (!nearest) return false;

             vectorX = nearest.awayX;
             vectorY = nearest.awayY;
             magnitude = Math.hypot(vectorX, vectorY);
         }

         if (!Number.isFinite(magnitude) || magnitude < 1e-6) {
             return false;
         }

         vectorX /= magnitude;
         vectorY /= magnitude;

         if (!aimAlongWorldVector(api, center, vectorX, vectorY)) {
             return false;
         }

         // Remember direction briefly to avoid flicker-induced oscillation.
         lastEscapeVector = { x: vectorX, y: vectorY };
         escapeLockUntil = Date.now() + ESCAPE_RECOVERY_MS;

         const mostUrgent = [...hazards].sort(
             (a, b) => b.urgency - a.urgency
         )[0];

         lastMode =
             mostUrgent.type === "virus"
                 ? "Avoiding virus"
                 : hazards.length > 1
                     ? "Escaping multiple threats"
                     : "Fleeing";

         lastTarget =
             mostUrgent.type === "virus"
                 ? "Virus"
                 : (
                     mostUrgent.enemy.name ||
                     `Enemy ${mostUrgent.enemy.id}`
                 );

         lastDetails =
             `Hazards: ${hazards.length}\\n` +
             `Nearest distance: ${Math.round(
                 Math.min(...hazards.map(h => h.distance))
             )}`;

         return true;
     }

     function continueEscape(api, center, now) {
         if (!lastEscapeVector || now >= escapeLockUntil) {
             return false;
         }

         lastMode = "Escape recovery";
         lastTarget = "Maintaining safe distance";
         lastDetails =
             `Recovery: ${Math.ceil(escapeLockUntil - now)} ms`;

         return aimAlongWorldVector(
             api,
             center,
             lastEscapeVector.x,
             lastEscapeVector.y
         );
     }

     // =========================================================
     // FOOD RISK SCORING
     // =========================================================

     function getFoodRiskPenalty(
         food,
         enemies,
         viruses,
         myCells,
         center,
         now
     ) {
         let penalty = 0;

         const smallestOwnRadius = Math.min(
             ...myCells.map(cell => cell.radius)
         );

         const maxOwnRadius = Math.max(
             ...myCells.map(cell => cell.radius)
         );

         // Penalize food near opponents that can threaten us.
         for (const enemy of enemies) {
             if (!validCell(enemy)) continue;

             if (
                 enemy.radius <
                 smallestOwnRadius * DANGER_SIZE_RATIO
             ) {
                 continue;
             }

             if (
                 distance(enemy, center) >
                 FOOD_RISK_SEARCH_DISTANCE
             ) {
                 continue;
             }

             const predictedEnemy = predictPosition(
                 enemy,
                 0.35,
                 now
             );

             const distanceToFood = distance(
                 predictedEnemy,
                 food
             );

             const directRiskRadius = Math.max(
                 170,
                 enemy.radius *
                     FOOD_RISK_RADIUS_MULTIPLIER +
                     food.radius
             );

             if (distanceToFood < directRiskRadius) {
                 const proximity =
                     1 - distanceToFood / directRiskRadius;

                 penalty +=
                     proximity *
                     260 *
                     Math.min(
                         enemy.radius /
                         Math.max(smallestOwnRadius, 1),
                         3
                     );
             }

             // Also penalize targets whose approach path passes
             // close to a dangerous opponent.
             const pathDistance = pointSegmentDistance(
                 predictedEnemy,
                 center,
                 food
             );

             const pathRiskRadius = Math.max(
                 140,
                 enemy.radius * 1.7
             );

             if (pathDistance < pathRiskRadius) {
                 const proximity =
                     1 - pathDistance / pathRiskRadius;

                 penalty += proximity * 170;
             }
         }

         // Avoid targets requiring us to pass dangerously close
         // to a virus when one of our cells is large enough to split.
         if (maxOwnRadius >= 70) {
             for (const virus of viruses) {
                 if (!validCell(virus)) continue;

                 if (
                     maxOwnRadius <
                     virus.radius * VIRUS_HAZARD_RATIO
                 ) {
                     continue;
                 }

                 const directDistance = distance(
                     virus,
                     food
                 );

                 const riskRadius = Math.max(
                     150,
                     virus.radius * 1.5
                 );

                 if (directDistance < riskRadius) {
                     penalty += (
                         1 - directDistance / riskRadius
                     ) * 180;
                 }

                 const pathDistance = pointSegmentDistance(
                     virus,
                     center,
                     food
                 );

                 if (pathDistance < riskRadius) {
                     penalty += (
                         1 - pathDistance / riskRadius
                     ) * 140;
                 }
             }
         }

         return penalty;
     }

     // =========================================================
     // FOOD CLUSTER GRID
     // =========================================================

     function gridCoordinates(cell) {
         return {
             x: Math.floor(cell.x / FOOD_CLUSTER_GRID_SIZE),
             y: Math.floor(cell.y / FOOD_CLUSTER_GRID_SIZE)
         };
     }

     function buildFoodGrid(foods) {
         const grid = new Map();

         for (const food of foods) {
             const p = gridCoordinates(food);
             const key = `${p.x},${p.y}`;

             grid.set(key, (grid.get(key) || 0) + 1);
         }

         return grid;
     }

     function getNearbyFoodCount(food, grid) {
         const centerGrid = gridCoordinates(food);
         const cellsToCheck = Math.ceil(
             FOOD_CLUSTER_RADIUS / FOOD_CLUSTER_GRID_SIZE
         );

         let count = 0;

         for (
             let gx = centerGrid.x - cellsToCheck;
             gx <= centerGrid.x + cellsToCheck;
             gx++
         ) {
             for (
                 let gy = centerGrid.y - cellsToCheck;
                 gy <= centerGrid.y + cellsToCheck;
                 gy++
             ) {
                 count += grid.get(`${gx},${gy}`) || 0;
             }
         }

         return Math.max(0, count - 1);
     }

     // =========================================================
     // TARGET SCORING
     // =========================================================

     function getFoodCandidates(
         api,
         center,
         allCells,
         myCells,
         enemies,
         viruses,
         rect,
         now
     ) {
         const candidates = [];

         for (const [id, expiry] of blockedTargets) {
             if (expiry <= now) {
                 blockedTargets.delete(id);
             }
         }

         const visibleFoods = [];

         for (const food of allCells) {
             if (
                 !food.isFood ||
                 !validCell(food) ||
                 blockedTargets.has(food.id)
             ) {
                 continue;
             }

             const screen = api.worldToScreen(
                 food.x,
                 food.y
             );

             if (!screen) continue;

             if (
                 screen.x < rect.left + 3 ||
                 screen.x > rect.right - 3 ||
                 screen.y < rect.top + 3 ||
                 screen.y > rect.bottom - 3
             ) {
                 continue;
             }

             visibleFoods.push({ food, screen, distance: distance(food, center) });
         }

         const foodGrid = buildFoodGrid(
             visibleFoods.map(item => item.food)
         );

         // Score only nearby options to reduce repeated enemy-risk
         // calculations. Keep the current target if still visible.
         const scoredFoodPool = visibleFoods
             .slice()
             .sort((a, b) => a.distance - b.distance)
             .slice(0, MAX_FOOD_CANDIDATES_TO_SCORE);

         const currentVisibleTarget = visibleFoods.find(
             item => item.food.id === currentTargetId
         );

         if (
             currentVisibleTarget &&
             !scoredFoodPool.some(
                 item => item.food.id === currentTargetId
             )
         ) {
             scoredFoodPool.push(currentVisibleTarget);
         }

         for (const item of scoredFoodPool) {
             const food = item.food;
             const screen = item.screen;

             const travelDistance = item.distance;

             const riskPenalty = getFoodRiskPenalty(
                 food,
                 enemies,
                 viruses,
                 myCells,
                 center,
                 now
             );

             const nearbyFoodCount = getNearbyFoodCount(
                 food,
                 foodGrid
             );

             const clusterReward = Math.min(
                 100,
                 nearbyFoodCount * FOOD_CLUSTER_REWARD
             );

             // Prefer useful, reachable food clusters but never
             // let cluster size outweigh serious risk.
             const sizeReward = Math.min(
                 food.radius,
                 25
             ) * 1.5;

             const score =
                 travelDistance +
                 riskPenalty -
                 clusterReward -
                 sizeReward;

             candidates.push({
                 food,
                 screen,
                 distance: travelDistance,
                 riskPenalty,
                 clusterReward,
                 score
             });
         }

         candidates.sort(
             (a, b) => a.score - b.score
         );

         return candidates;
     }

     // =========================================================
     // STABLE TARGET SELECTION
     // =========================================================

     function resetProgressTracking() {
         currentTargetId = null;
         progressTargetId = null;
         bestTargetDistance = Infinity;
         targetLockedAt = 0;
         lastProgressAt = 0;
     }

     function selectStableTarget(candidates, now) {
         if (!candidates.length) {
             resetProgressTracking();
             return null;
         }

         const best = candidates[0];

         const current = candidates.find(
             candidate =>
                 candidate.food.id === currentTargetId
         );

         let chosen = best;

         if (current && current.food.id !== best.food.id) {
             const lockAge = now - targetLockedAt;

             const switchThreshold = Math.max(
                 35,
                 Math.abs(current.score) *
                     TARGET_SWITCH_MARGIN
             );

             const clearlyBetter =
                 best.score <
                 current.score - switchThreshold;

             if (
                 lockAge < MIN_TARGET_LOCK_MS ||
                 (
                     !clearlyBetter &&
                     lockAge < MAX_TARGET_LOCK_MS
                 )
             ) {
                 chosen = current;
             }
         } else if (current) {
             chosen = current;
         }

         if (currentTargetId !== chosen.food.id) {
             currentTargetId = chosen.food.id;
             targetLockedAt = now;

             progressTargetId = chosen.food.id;
             bestTargetDistance = chosen.distance;
             lastProgressAt = now;
         }

         if (progressTargetId !== chosen.food.id) {
             progressTargetId = chosen.food.id;
             bestTargetDistance = chosen.distance;
             lastProgressAt = now;

         } else if (
             chosen.distance <
             bestTargetDistance - STUCK_PROGRESS_DISTANCE
         ) {
             bestTargetDistance = chosen.distance;
             lastProgressAt = now;
         }

         if (
             now - lastProgressAt >
             STUCK_TIMEOUT_MS
         ) {
             blockedTargets.set(
                 chosen.food.id,
                 now + TARGET_BLACKLIST_MS
             );

             resetProgressTracking();
             return null;
         }

         return chosen;
     }

     // =========================================================
     // HUNTING MODE
     // =========================================================

     function resetHuntTarget() {
         currentPreyId = null;
         preyLockedAt = 0;
     }

     function findHuntCandidates(api, center, myCells, enemies, rect, now) {
         const largestOwnRadius = myCells.reduce(
             (max, cell) => Math.max(max, cell.radius),
             0
         );

         if (largestOwnRadius <= 0) return [];

         const candidates = [];

         for (const enemy of enemies) {
             if (
                 !validCell(enemy) ||
                 !isFreshCell(enemy, 900, now) ||
                 largestOwnRadius < enemy.radius * HUNT_SIZE_RATIO
             ) {
                 continue;
             }

             // Lead the aim slightly when the tracker's velocity estimate is fresh.
             const predicted = predictPosition(
                 enemy,
                 HUNT_LEAD_SECONDS,
                 now
             );

             const screen = api.worldToScreen(
                 predicted.x,
                 predicted.y
             );

             if (!screen) continue;

             if (
                 screen.x < rect.left + 6 ||
                 screen.x > rect.right - 6 ||
                 screen.y < rect.top + 6 ||
                 screen.y > rect.bottom - 6
             ) {
                 continue;
             }

             const travelDistance = distance(center, predicted);
             let predatorPenalty = 0;

             // Penalize prey positioned close to a cell capable of eating us.
             for (const other of enemies) {
                 if (other.id === enemy.id || !validCell(other)) continue;

                 if (other.radius < largestOwnRadius * DANGER_SIZE_RATIO) {
                     continue;
                 }

                 const predatorDistance = distance(other, predicted);

                 if (predatorDistance < HUNT_PREDATOR_DANGER_RADIUS) {
                     predatorPenalty +=
                         (1 - predatorDistance / HUNT_PREDATOR_DANGER_RADIUS) *
                         900;
                 }
             }

             const reward = Math.min(
                 enemy.radius,
                 largestOwnRadius * 0.75
             ) * 0.55;

             const score =
                 travelDistance +
                 predatorPenalty -
                 reward;

             candidates.push({
                 enemy,
                 aimPoint: predicted,
                 screen,
                 distance: travelDistance,
                 predatorPenalty,
                 score,
                 ownRadius: largestOwnRadius,
                 sizeRatio: largestOwnRadius / enemy.radius
             });
         }

         candidates.sort((a, b) => a.score - b.score);
         return candidates;
     }

     function selectStablePrey(candidates, now) {
         if (!candidates.length) {
             resetHuntTarget();
             return null;
         }

         const best = candidates[0];
         const current = candidates.find(
             candidate => candidate.enemy.id === currentPreyId
         );

         let chosen = best;

         if (current && current.enemy.id !== best.enemy.id) {
             const lockAge = now - preyLockedAt;
             const switchThreshold = Math.max(
                 70,
                 Math.abs(current.score) * HUNT_SWITCH_MARGIN
             );

             const clearlyBetter =
                 best.score < current.score - switchThreshold;

             if (
                 lockAge < HUNT_TARGET_LOCK_MS ||
                 !clearlyBetter
             ) {
                 chosen = current;
             }
         } else if (current) {
             chosen = current;
         }

         if (currentPreyId !== chosen.enemy.id) {
             currentPreyId = chosen.enemy.id;
             preyLockedAt = now;
         }

         return chosen;
     }

     // =========================================================
     // OPTIONAL AUTO-SPLIT ATTACK
     // =========================================================

     function getSplitCapableCore() {
         try {
             if (
                 typeof core !== "undefined" &&
                 core &&
                 typeof core.split === "function"
             ) {
                 return core;
             }
         } catch {
             // Continue to the window property fallback.
         }

         if (
             window.core &&
             typeof window.core.split === "function"
         ) {
             return window.core;
         }

         return null;
     }

     function tryAutoSplitAttack(api, target, myCells, rect, now) {
         if (!autoSplitEnabled || !target) return false;

         for (const [id, expiry] of splitTriedTargets) {
             if (expiry <= now) splitTriedTargets.delete(id);
         }

         if (
             now - lastSplitAt < AUTO_SPLIT_COOLDOWN_MS ||
             splitTriedTargets.has(target.enemy.id)
         ) {
             return false;
         }

         const eligibleCells = myCells.filter(cell =>
             validCell(cell) &&
             cell.radius >=
                 target.enemy.radius * AUTO_SPLIT_MIN_RADIUS_RATIO
         );

         if (!eligibleCells.length) return false;

         const screenTarget = target.screen;
         let nearestScreenDistance = Infinity;

         for (const mine of eligibleCells) {
             const screenMine = api.worldToScreen(mine.x, mine.y);

             if (!screenMine) continue;

             nearestScreenDistance = Math.min(
                 nearestScreenDistance,
                 distance(screenMine, screenTarget)
             );
         }

         const splitRange = clamp(
             Math.min(rect.width, rect.height) *
                 AUTO_SPLIT_SCREEN_RANGE_RATIO,
             180,
             360
         );

         if (nearestScreenDistance > splitRange) return false;

         const gameCore = getSplitCapableCore();

         if (!gameCore) {
             lastDetails =
                 "Hunt works; split() is not exposed by this game build";
             return false;
         }

         try {
             // The mouse is already aimed at the prey this tick.
             gameCore.split();

             lastSplitAt = now;
             splitTriedTargets.set(
                 target.enemy.id,
                 now + AUTO_SPLIT_TARGET_RETRY_MS
             );

             lastMode = "Split attack";
             lastTarget =
                 target.enemy.name ||
                 "Cell " + target.enemy.id;

             lastDetails =
                 "Size ratio: " + target.sizeRatio.toFixed(2) + "x\n" +
                 "Aim distance: " + Math.round(nearestScreenDistance) + " px";

             return true;
         } catch (error) {
             lastError =
                 "Split failed: " + String(error?.message || error);
             return false;
         }
     }

     // =========================================================
     // MAIN BOT TICK
     // =========================================================

     function tick() {
         ensureHUD();

         if (!enabled) {
             lastMode = "Disabled";
             lastDetails = "";
             updateHUD();
             return;
         }

         if (document.hidden) {
             lastMode = "Paused (tab hidden)";
             updateHUD();
             return;
         }

         const api = getAPI();

         if (!api) {
             lastMode = "Waiting for tracker";
             lastTarget = "None";
             lastError =
                 "Enable Food Radar and reload Agar.io";
             updateHUD();
             return;
         }

         try {
             const now = Date.now();

             const allCells = api.getCells();

             const myCells = api.getMyCells()
                 .filter(validCell)
                 .filter(cell =>
                     isFreshCell(cell, 2500, now)
                 );

             if (!myCells.length) {
                 lastMode = "Waiting for own cells";
                 lastTarget = "None";
                 lastError =
                     "No fresh owned cells detected";
                 updateHUD();
                 return;
             }

             const center = getPlayerCenter(myCells);

             if (!center) {
                 lastMode = "Waiting for player position";
                 updateHUD();
                 return;
             }

             lastError = "";
             lastDetails = "";

             // Use fresh enemy and virus data only.
             const enemies = allCells.filter(cell =>
                 cell.isPlayerCell &&
                 !cell.isMine &&
                 validCell(cell) &&
                 isFreshCell(cell, 2500, now)
             );

             const viruses = allCells.filter(cell =>
                 cell.isVirus &&
                 validCell(cell) &&
                 isFreshCell(cell, 5000, now)
             );

             // -------------------------------------------------
             // 1. IMMEDIATE AND PREDICTED THREATS
             // -------------------------------------------------

             const enemyThreats = findThreats(
                 myCells,
                 enemies,
                 now
             );

             const virusThreats = findVirusHazards(
                 myCells,
                 viruses
             );

             const hazards = [
                 ...enemyThreats,
                 ...virusThreats
             ];

             if (hazards.length > 0) {
                 escapeFromHazards(
                     api,
                     hazards,
                     center
                 );

                 updateHUD();
                 return;
             }

             // Keep moving away briefly if a hazard temporarily vanished.
             if (now < escapeLockUntil && lastEscapeVector) {
                 continueEscape(api, center, now);
                 updateHUD();
                 return;
             }

             const canvas = document.querySelector("#canvas");

             if (!canvas) {
                 lastError = "Game canvas not found";
                 updateHUD();
                 return;
             }

             const rect = canvas.getBoundingClientRect();

             // -------------------------------------------------
             // 2. HUNT MODE: PRIORITIZE SAFELY EDIBLE PREY
             // -------------------------------------------------

             if (huntMode) {
                 const preyCandidates = findHuntCandidates(
                     api,
                     center,
                     myCells,
                     enemies,
                     rect,
                     now
                 );

                 const prey = selectStablePrey(
                     preyCandidates,
                     now
                 );

                 if (prey) {
                     lastMode = "Hunting prey";
                     lastTarget =
                         prey.enemy.name ||
                         "Cell " + prey.enemy.id;

                     lastDetails =
                         "Size ratio: " + prey.sizeRatio.toFixed(2) + "x\n" +
                         "Distance: " + Math.round(prey.distance) + "\n" +
                         "Nearby predator risk: " + Math.round(prey.predatorPenalty);

                     moveMouse(
                         prey.screen.x,
                         prey.screen.y
                     );

                     if (autoSplitEnabled) {
                         tryAutoSplitAttack(
                             api,
                             prey,
                             myCells,
                             rect,
                             now
                         );
                     }

                     updateHUD();
                     return;
                 }
             }

             // -------------------------------------------------
             // 3. SCORE VISIBLE FOOD
             // -------------------------------------------------

             const candidates = getFoodCandidates(
                 api,
                 center,
                 allCells,
                 myCells,
                 enemies,
                 viruses,
                 rect,
                 now
             );

             // -------------------------------------------------
             // 3. KEEP A STABLE TARGET
             // -------------------------------------------------

             const target = selectStableTarget(
                 candidates,
                 now
             );

             if (!target) {
                 lastMode = "Searching";
                 lastTarget = "No suitable food";

                 // Stop continuing towards a stale target.
                 moveMouse(
                     rect.left + rect.width / 2,
                     rect.top + rect.height / 2
                 );

                 lastDetails =
                     `Visible food: ${candidates.length}\n` +
                     "Searching for a better route";

                 updateHUD();
                 return;
             }

             // -------------------------------------------------
             // 4. MOVE TOWARDS THE CHOSEN TARGET
             // -------------------------------------------------

             lastMode = huntMode ? "Foraging (no safe prey)" : "Collecting food";
             lastTarget = `Food ${target.food.id}`;

             lastDetails =
                 `Distance: ${Math.round(target.distance)}\n` +
                 `Risk: ${Math.round(target.riskPenalty)} | ` +
                 `Cluster: ${Math.round(target.clusterReward)}`;

             moveMouse(
                 target.screen.x,
                 target.screen.y
             );

             updateHUD();

         } catch (error) {
             lastMode = "Error";
             lastError = String(
                 error?.message || error
             );

             updateHUD(true);

             console.error(
                 "[Agar Bot]",
                 error
             );
         }
     }

     // =========================================================
     // ENABLE / DISABLE
     // =========================================================

     window.addEventListener(
         "keydown",
         event => {
             if (
                 event.repeat ||
                 event.ctrlKey ||
                 event.altKey ||
                 event.metaKey
             ) {
                 return;
             }

             const element = event.target;

             if (
                 element instanceof HTMLInputElement ||
                 element instanceof HTMLTextAreaElement ||
                 element?.isContentEditable
             ) {
                 return;
             }

             const key = event.key.toLowerCase();

             if (key === TOGGLE_KEY) {
                 enabled = !enabled;

                 lastMode = enabled ? "Starting" : "Disabled";
                 lastTarget = "None";
                 lastError = "";
                 lastDetails = "";

                 resetProgressTracking();
                 resetHuntTarget();
                 blockedTargets.clear();
                 splitTriedTargets.clear();

                 lastEscapeVector = null;
                 escapeLockUntil = 0;
                 lastAimX = null;
                 lastAimY = null;

                 updateHUD(true);

                 console.info(
                     `[Agar Bot] ${enabled ? "Enabled" : "Disabled"}`
                 );

             } else if (key === "h") {
                 huntMode = !huntMode;
                 resetHuntTarget();

                 lastMode = huntMode
                     ? "Hunt mode enabled"
                     : "Food mode enabled";

                 lastDetails =
                     "H toggles hunting for safely smaller cells";

                 updateHUD(true);

                 console.info(
                     `[Agar Bot] Hunt mode ${huntMode ? "enabled" : "disabled"}`
                 );

             } else if (key === "j") {
                 autoSplitEnabled = !autoSplitEnabled;

                 if (autoSplitEnabled) {
                     huntMode = true;
                     resetHuntTarget();
                 }

                 lastMode = autoSplitEnabled
                     ? "Auto-split enabled"
                     : "Auto-split disabled";

                 lastDetails =
                     "J toggles split attacks; only favorable targets qualify";

                 updateHUD(true);

                 console.info(
                     `[Agar Bot] Auto-split ${autoSplitEnabled ? "enabled" : "disabled"}`
                 );
             }
         },
         true
     );

     

     // =========================================================
     // START
     // =========================================================

     ensureHUD();
     updateHUD(true);

     setInterval(tick, TICK_MS);

     console.info(
         "[Agar Bot] v0.5 ready. B=bot, H=hunt, J=auto-split."
     );
 })();
