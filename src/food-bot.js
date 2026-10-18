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
             `AGAR BOT 0.4\n` +
             `Status: ${enabled ? "ON" : "OFF"}\n` +
             `Mode: ${lastMode}\n` +
             `Target: ${lastTarget}\n` +
             `${lastDetails || lastError || ""}\n` +
             `[B] Toggle bot`;
     }

     // =========================================================
     // MANUAL MOUSE CONTROL
     // =========================================================

     function blockManualMouseMovement(event) {
         if (!enabled || !event.isTrusted) return;

         const canvas = document.querySelector("#canvas");
         if (!canvas) return;

         const path =
             typeof event.composedPath === "function"
                 ? event.composedPath()
                 : [];

         const isGameMouseEvent =
             event.target === canvas ||
             path.includes(canvas);

         if (!isGameMouseEvent) return;

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

             // -------------------------------------------------
             // 2. SCORE VISIBLE FOOD
             // -------------------------------------------------

             const canvas = document.querySelector("#canvas");

             if (!canvas) {
                 lastError = "Game canvas not found";
                 updateHUD();
                 return;
             }

             const rect = canvas.getBoundingClientRect();

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

             lastMode = "Collecting food";
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

             if (
                 event.key.toLowerCase() === TOGGLE_KEY
             ) {
                 enabled = !enabled;

                 lastMode = enabled
                     ? "Starting"
                     : "Disabled";

                 lastTarget = "None";
                 lastError = "";
                 lastDetails = "";

                 resetProgressTracking();
                 blockedTargets.clear();
                 lastEscapeVector = null;
                 escapeLockUntil = 0;

                 lastAimX = null;
                 lastAimY = null;

                 updateHUD(true);

                 console.info(
                     `[Agar Bot] ${
                         enabled ? "Enabled" : "Disabled"
                     }`
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
         "[Agar Bot] v0.4 ready. Press B to toggle."
     );
 })();
