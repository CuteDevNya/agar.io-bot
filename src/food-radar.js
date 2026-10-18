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

    // Fast lookup for known food coordinates.
    let foodCoordinateIndex = new Set();
    let foodIndexState = null;
    let foodIndexWorldUpdates = -1;
    let foodIndexFoodCount = -1;

    // Canvas method interception.
    const canvas2DPrototype =
        window.CanvasRenderingContext2D?.prototype ?? null;

    const originalArc = canvas2DPrototype?.arc ?? null;
    const originalTranslate = canvas2DPrototype?.translate ?? null;

    let patchedArc = null;
    let patchedTranslate = null;

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

            if (!canvas) return;

            // Only inspect Agar.io's game canvas.
            if (
                canvas !== gameCanvas &&
                canvas.id !== "canvas"
            ) {
                return;
            }

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

                capturedAt: performance.now(),

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

        if (
            patchedTranslate &&
            canvas2DPrototype.translate === patchedTranslate
        ) {
            canvas2DPrototype.translate = originalTranslate;
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
