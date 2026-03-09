import React, { useState, useEffect, useRef, useCallback } from 'react';

// ==========================================
// ✈️ 硬核飞行气动物理常量 (Aero Dynamics)
// ==========================================
const MASS = 1.0;                  
const GRAVITY = 500;               
const LIFT_COEFF = 0.015;          
const DRAG_COEFF = 0.09;           // 提高基础阻力系数；配合三次项，巡航极速≈330 kts
const MAX_THRUST = 900;            
const STALL_ANGLE = 0.38;          
const GEAR_DRAG = 0.15;            
const FUEL_CONSUMPTION = 1.1;      // 基础燃耗 %/s，按油门线性；另加起落架/襟翼附加消耗

// 降落安全阈值
const MAX_LANDING_VY = 110;        // 最大安全接地垂直率
const MAX_LANDING_SPEED = 160;     // 最大安全进场空速

export default function App() {
    const canvasRef = useRef(null);
    const stickTrackRef = useRef(null);    // 左侧：摇杆
    const throttleTrackRef = useRef(null); // 右侧：油门台
    const requestRef = useRef(null);
    const lastTimeRef = useRef(0);
    
    // UI 状态
    const [gameStatus, setGameStatus] = useState('menu');
    const [uiScore, setUiScore] = useState(0);
    
    // 控制器视觉状态
    const [knobY, setKnobY] = useState(0);         
    const [throttleY, setThrottleY] = useState(9999); // 初始设为极大值，让 clamp 处理；将在 mount 后由 DOM 动态纠正
    const [flapsLevel, setFlapsLevel] = useState(1); // 初始设定为 Flaps 1
    const [isGearDown, setIsGearDown] = useState(true); // 起飞前起落架放下
    
    // 游戏核心状态
    const gameState = useRef(null);
    const isDraggingStick = useRef(false);
    const isDraggingThrottle = useRef(false);

    // 初始化物理状态
    const initGameState = (width, height) => ({
        y: height - 38,        // 起始在跑道上 (GROUND_Y=height-20, gearExt=18)
        vx: 0,                 // 初始静止
        vy: 0,                 
        pitch: 0,              
        
        worldX: -800,          
        fuel: 100,             
        score: 0,              
        obstaclesGenerated: 0, 
        nextObstacleDist: 650, // 动态障碍物生成间距控制
        
        aoa: 0,                
        gamma: 0,              
        speed: 0,              // 初始速度为零
        isStalled: false,      
        onGround: true,        // 游戏开始时在跑道上
        
        inputY: 0,             // 摇杆
        throttle: 0.0,         // 油门完全慢车
        flaps: 1,              // 襟翼 1
        gear: true,            // 起落架放下

        // ---- 视差背景 ----
        bg: {
            offsets: [0, 0, 0, 0],  // 4层山脉的水平偏移（最后一层不动）
            clouds: Array.from({ length: 18 }, (_, i) => {
                const layer = i % 3; // 0=最远, 1=中, 2=最近
                const layerSpeeds = [0.04, 0.11, 0.22];
                return {
                    x: Math.random() * width * 2.5,
                    y: 20 + Math.random() * (height * 0.38),
                    w: 70 + Math.random() * 160,
                    h: 22 + Math.random() * 40,
                    speed: layerSpeeds[layer],
                    layer,
                };
            }),
        },
        
        obstacles: [],
        runways: [{ x: 0, width: 2500, scored: true }], // 起始跑道 (scored避免重复计分)
        lastObstacleX: 0,
        runwaysGenerated: 0, // 已生成的跑道降落挑战次数
        particles: [],
        messages: [{ text: '✈  READY FOR DEPARTURE', life: 3.0 }],
        
        lowFuelWarned20: false,  // 20% 低油量警告已弹出
        lowFuelWarned10: false,  // 10% BINGO 警告已弹出
        flameoutWarned:  false,  // 熄火提示已弹出

        isGameOver: false,
        failReason: '',
    });

    const startGame = () => {
        const canvas = canvasRef.current;
        gameState.current = initGameState(canvas.width, canvas.height);
        
        setUiScore(0);
        setKnobY(0);
        // 动态计算慢车位置：throttle=0 时滑块在轨道最底部
        if (throttleTrackRef.current) {
            const maxY = throttleTrackRef.current.getBoundingClientRect().height - 40;
            setThrottleY(maxY);
        }
        setFlapsLevel(1);  // 襟翼 1
        setIsGearDown(true); // 起落架放下
        setGameStatus('playing');
        
        lastTimeRef.current = performance.now();
        requestRef.current = requestAnimationFrame(gameLoop);
    };

    // ================= 键盘 HOTAS 映射 =================
    useEffect(() => {
        const handleKeyDown = (e) => {
            if (gameStatus !== 'playing' || !gameState.current) return;
            const state = gameState.current;

            // 用于强制同步键盘操作与UI视觉位置
            const updateThrottleUI = (val) => {
                if (throttleTrackRef.current) {
                    const maxY = throttleTrackRef.current.getBoundingClientRect().height - 40;
                    setThrottleY((1 - val) * maxY);
                }
            };

            if (e.key.toLowerCase() === 'g') {
                const nextGear = !state.gear;
                state.gear = nextGear;
                setIsGearDown(nextGear);
            }
            if (e.key.toLowerCase() === 'f') {
                if (e.shiftKey) {
                    const nextFlaps = Math.max(0, state.flaps - 1);
                    state.flaps = nextFlaps;
                    setFlapsLevel(nextFlaps);
                } else {
                    const nextFlaps = Math.min(3, state.flaps + 1);
                    state.flaps = nextFlaps;
                    setFlapsLevel(nextFlaps);
                }
            }
            if (e.key === 'PageUp') {
                e.preventDefault();
                // 加油门 (推力增加，滑块向上)
                state.throttle = Math.min(1.0, state.throttle + 0.1);
                updateThrottleUI(state.throttle);
            }
            if (e.key === 'PageDown') {
                e.preventDefault();
                // 减油门 (推力减少，滑块向下)
                state.throttle = Math.max(0.0, state.throttle - 0.1);
                updateThrottleUI(state.throttle);
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [gameStatus]);

    // ================= 左手：飞行摇杆事件 =================
    const handleStickEvent = (e, isDown) => {
        if (gameStatus !== 'playing') return;
        if (isDown !== undefined) isDraggingStick.current = isDown;
        if (!isDraggingStick.current) return;

        const rect = stickTrackRef.current.getBoundingClientRect();
        const centerY = rect.top + rect.height / 2;
        let dy = e.clientY - centerY;
        const maxDy = rect.height / 2 - 20;
        dy = Math.max(-maxDy, Math.min(maxDy, dy));
        
        setKnobY(dy);
        gameState.current.inputY = dy / maxDy; 
    };

    const handleStickUp = () => {
        isDraggingStick.current = false;
        setKnobY(0);
        if (gameState.current) gameState.current.inputY = 0;
    };

    // ================= 右手：HOTAS 油门与控制台事件 =================
    const handleThrottleEvent = (e, isDown) => {
        if (gameStatus !== 'playing') return;
        if (isDown !== undefined) isDraggingThrottle.current = isDown;
        if (!isDraggingThrottle.current) return;

        const rect = throttleTrackRef.current.getBoundingClientRect();
        let y = e.clientY - rect.top;
        const maxY = rect.height - 40;
        y = Math.max(0, Math.min(maxY, y));
        
        setThrottleY(y);
        gameState.current.throttle = 1 - (y / maxY);
    };

    const toggleGear = () => {
        if (gameStatus !== 'playing') return;
        const nextState = !isGearDown;
        setIsGearDown(nextState);
        if (gameState.current) gameState.current.gear = nextState;
    };

    const handleFlapsSelect = (level) => {
        if (gameStatus !== 'playing') return;
        setFlapsLevel(level);
        if (gameState.current) gameState.current.flaps = level;
    };

    // ================= 核心物理引擎 =================
    const updateEngine = (dtMs) => {
        const dt = Math.min(dtMs / 1000, 0.05); 
        const state = gameState.current;
        const canvas = canvasRef.current;
        if (!state || !canvas) return;

        state.speed = Math.hypot(state.vx, state.vy);
        state.gamma = Math.atan2(state.vy, state.vx); 

        // FBW 俯仰控制
        const restoringRate = (state.gamma - state.pitch) * 2.5; 
        const dynamicPressure = Math.max(state.speed * state.speed, 10000);
        const fbwElevatorLimit = Math.min(1.0, 90000 / dynamicPressure);

        // 在跑道上且起落架放下且空速 < 110 时，操纵杆不影响飞机姿态（地面操控不够气动权限）
        const groundLocked = state.onGround && state.gear && state.speed < 110;
        const elevatorRate = groundLocked ? 0 : (-state.inputY * 1.5 * fbwElevatorLimit);

        let pitchRate = 0;
        if (groundLocked) {
            // 强制将俯仰角归零，杆输入无效
            state.pitch *= 0.85;
            pitchRate = 0;
        } else if (state.isStalled) {
            pitchRate = restoringRate * 2.0 + elevatorRate * 0.1; 
        } else {
            pitchRate = restoringRate + elevatorRate;
        }

        state.pitch += pitchRate * dt;
        state.aoa = state.gamma - state.pitch;

        // 襟翼系统：极大增加基础升力系数，但也增加阻力
        const currentLiftCoeff = LIFT_COEFF * (1 + state.flaps * 0.5); 
        let CL = 0; 
        let CD = 0.08 + (state.flaps * 0.015); 

        if (state.gear) CD += GEAR_DRAG; 

        if (Math.abs(state.aoa) > STALL_ANGLE) {
            state.isStalled = true;
            CL = Math.sign(state.aoa) * 0.4; 
            CD += 0.8;                       
        } else {
            state.isStalled = false;
            CL = 5.0 * state.aoa;            
            CD += 1.5 * Math.pow(state.aoa, 2); 
        }

        const q = state.speed * state.speed;
        const LiftMag = currentLiftCoeff * q * Math.abs(CL); 
        // 阻力 = 经典平方项 + 三次方波阻项（高速时急剧增大，模拟压缩性阻力）
        const DragMag = DRAG_COEFF * q * CD + 0.000003 * state.speed * state.speed * state.speed;
        
        let actualThrust = 0;
        if (state.fuel > 0) {
            actualThrust = MAX_THRUST * state.throttle;
            // 燃料消耗：基础油门消耗 + 起落架阻力附加 + 逐档襟翼附加
            const gearDrain  = state.gear  ? 0.17 : 0.0;           // 起落架：+0.17%/s
            const flapsDrain = state.flaps * 0.08;                  // 每档襟翼：+0.08%/s
            state.fuel -= (state.throttle * FUEL_CONSUMPTION + gearDrain + flapsDrain) * dt;
            state.fuel = Math.max(0, state.fuel);

            // 低燃料警告（只弹一次）
            if (state.fuel <= 20 && !state.lowFuelWarned20) {
                state.lowFuelWarned20 = true;
                state.messages.push({ text: '⚠ FUEL LOW — 20%', life: 3.0 });
            }
            if (state.fuel <= 10 && !state.lowFuelWarned10) {
                state.lowFuelWarned10 = true;
                state.messages.push({ text: '🔴 BINGO FUEL — 10%  LAND NOW!', life: 4.0 });
            }
        } else {
            // 燃料耗尽：熄火，在 HUD 给出提示（只弹一次）
            if (!state.flameoutWarned) {
                state.flameoutWarned = true;
                state.messages.push({ text: '💀 ENGINE FLAMEOUT — NO FUEL', life: 99 });
            }
        }

        const ThrustX = actualThrust * Math.cos(state.pitch);
        const ThrustY = actualThrust * Math.sin(state.pitch);
        const DragX = -DragMag * Math.cos(state.gamma);
        const DragY = -DragMag * Math.sin(state.gamma);

        const liftDirStr = Math.sign(state.aoa) >= 0 ? 1 : -1;
        const liftAngle = state.gamma - liftDirStr * (Math.PI / 2);
        const LiftX = LiftMag * Math.cos(liftAngle);
        const LiftY = LiftMag * Math.sin(liftAngle); 

        const GravityY = MASS * GRAVITY;

        const ax = (ThrustX + DragX + LiftX) / MASS;
        const ay = (ThrustY + DragY + LiftY + GravityY) / MASS;

        state.vx += ax * dt;
        state.vy += ay * dt;
        // 只有在空中才强制最低速度，在跑道滑跑时允许从零开始
        if (!state.onGround && state.vx < 80) state.vx = 80;

        const dx = state.vx * dt;
        state.worldX += dx;
        state.y += state.vy * dt;

        // 移动端水平视野拉伸系数（与 drawEngine 中保持一致）
        // 用于将生成位置推到屏幕真正的右边缘之外
        const VIEW_ZOOM = canvas.width < 640 ? 0.52 : 1.0;
        // 屏幕右边缘对应的世界坐标 (camTx + worldX*ZOOM = canvasWidth → worldX = (canvasWidth - camTx)/ZOOM)
        // camTx = canvas.width*0.2*(1-ZOOM)，化简后 = canvas.width*(0.8/ZOOM + 0.2)
        const VIEW_RIGHT_EDGE = Math.ceil(canvas.width * (0.8 / VIEW_ZOOM + 0.2));
        const SPAWN_X = VIEW_RIGHT_EDGE + 120; // 就在屏幕右边缘外生成

        // ================= 动态生成 (对数级缩小缝隙 & 跑道长进场空域) =================
        if (state.worldX - state.lastObstacleX > state.nextObstacleDist) { 
            state.lastObstacleX = state.worldX;
            state.obstaclesGenerated += 1;
            
            if (state.obstaclesGenerated % 15 === 0) {
                // 生成降落跑道（每次越来越短；4次后锁死在最短长度）
                state.runwaysGenerated += 1;
                const MIN_RUNWAY_WIDTH = 400;
                const BASE_RUNWAY_WIDTH = 3000;
                const runwayWidth = state.runwaysGenerated <= 4
                    ? Math.max(MIN_RUNWAY_WIDTH, Math.round(BASE_RUNWAY_WIDTH * Math.pow(0.6, state.runwaysGenerated - 1)))
                    : MIN_RUNWAY_WIDTH;
                // 油箱位于跑道进近端（右侧）前 35% 处
                // 平面坐标: 跑道从 canvas.width+100 起，向右延伸 runwayWidth
                // 进近方向为向左（plane 从右侧飞入），所以 35% 区域靠近右端
                const fuelTankOffsetFromLeft = runwayWidth * 0.65; // 距左端 65% = 距右端 35%
                state.runways.push({
                    x: SPAWN_X,
                    width: runwayWidth,
                    scored: false,
                    challengeNum: state.runwaysGenerated,
                    fuelTankX: SPAWN_X + fuelTankOffsetFromLeft,
                    fuelTankCollected: false,
                });
                const isMinLength = runwayWidth <= MIN_RUNWAY_WIDTH;
                state.messages.push({
                    text: `🛬 RUNWAY CHALLENGE #${state.runwaysGenerated}  ${runwayWidth}m${isMinLength ? '  ⚠ MINIMUM!' : ''}`,
                    life: 5.0
                });
                // 【物理修复】：跑道上方绝对不刷柱子，强制推迟下一次生成检测
                state.nextObstacleDist = 3400; 
            } else {
                // 生成普通障碍物
                const baseGap = 250;
                const minGapRatio = 0.25; 
                const gapRatio = Math.max(minGapRatio, Math.pow(0.5, state.obstaclesGenerated / 120));
                const gapSize = baseGap * gapRatio;

                const safeMinPillar = Math.min(120, canvas.height * 0.2);
                const safeMaxGapTop = Math.max(safeMinPillar, canvas.height - safeMinPillar - gapSize);

                // 前100个障碍物：开口位置锁定在屏幕中央，随进度线性扩展到完全随机
                const progressRatio = Math.min(1, state.obstaclesGenerated / 100);
                const centerY = canvas.height / 2 - gapSize / 2;
                const interpolatedMin = centerY * (1 - progressRatio) + safeMinPillar * progressRatio;
                const interpolatedMax = centerY * (1 - progressRatio) + safeMaxGapTop * progressRatio;
                const gapTop = interpolatedMin + Math.random() * Math.max(0, interpolatedMax - interpolatedMin);

                state.obstacles.push({
                    x: SPAWN_X, width: 80,
                    gapTop: gapTop, gapBottom: gapTop + gapSize,
                    passed: false
                });

                // 【物理修复】：如果下一个就是跑道了(逢14)，给予极长的进场空域让你降高度
                if (state.obstaclesGenerated % 15 === 14) {
                    // 预告即将来临的跑道长度
                    const nextNum = state.runwaysGenerated + 1;
                    const nextWidth = nextNum <= 4
                        ? Math.max(400, Math.round(3000 * Math.pow(0.6, nextNum - 1)))
                        : 400;
                    state.messages.push({ text: `⚠ RUNWAY AHEAD: ${nextWidth}m — PREPARE TO LAND`, life: 4.0 });
                    state.nextObstacleDist = 2500; 
                } else {
                    state.nextObstacleDist = 650;
                }
            }
        }

        // 更新障碍物
        for (let i = state.obstacles.length - 1; i >= 0; i--) {
            let obs = state.obstacles[i];
            obs.x -= dx; 
            if (!obs.passed && (canvas.width * 0.2) > obs.x + obs.width) {
                obs.passed = true;
                state.score += 1; 
                setUiScore(state.score); 
            }
            if (obs.x + obs.width < -100) state.obstacles.splice(i, 1);
        }

        // 更新跑道
        for (let i = state.runways.length - 1; i >= 0; i--) {
            let r = state.runways[i];
            r.x -= dx;
            if (r.fuelTankX !== undefined) r.fuelTankX -= dx;
            if (r.x + r.width < -100) state.runways.splice(i, 1);
        }

        // ---- 更新视差背景偏移 ----
        // 越近的层（index越大）移动越快；最后一层 index=0 完全不动
        const bgScrollSpeeds = [0, 0.06, 0.18, 0.40];
        for (let i = 0; i < bgScrollSpeeds.length; i++) {
            state.bg.offsets[i] += dx * bgScrollSpeeds[i];
        }
        // 云朵按各自速度滚动，出屏后从右侧重新随机生成（需覆盖到视野拉伸后的右边缘）
        state.bg.clouds.forEach(c => {
            c.x -= dx * c.speed;
            if (c.x + c.w < 0) {
                c.x = VIEW_RIGHT_EDGE + c.w + Math.random() * 400;
                c.y = 20 + Math.random() * (canvas.height * 0.38);
            }
        });

        // 更新浮动文本
        state.messages.forEach(msg => msg.life -= dt);
        state.messages = state.messages.filter(m => m.life > 0);

        // 粒子系统
        if (actualThrust > MAX_THRUST * 0.5 && !state.isStalled) {
            state.particles.push({
                x: canvas.width * 0.2 - 20, y: state.y,
                vx: -state.vx * 0.5 + (Math.random() - 0.5) * 50, vy: -state.vy * 0.5 + (Math.random() - 0.5) * 50,
                life: 1.0, type: 'flame'
            });
        }
        if (state.speed > 400 && Math.random() < 0.2) {
            state.particles.push({
                x: VIEW_RIGHT_EDGE, y: Math.random() * canvas.height,
                vx: -state.speed * 1.5, vy: 0,
                life: 1.0, type: 'wind'
            });
        }
        for (let i = state.particles.length - 1; i >= 0; i--) {
            let p = state.particles[i];
            p.x += p.vx * dt; p.y += p.vy * dt; p.life -= dt * 2;
            if (p.life <= 0) state.particles.splice(i, 1);
        }

        // ================= 碰撞与着陆检测 =================
        const px = canvas.width * 0.2; 
        const py = state.y;
        const hitboxRadius = 14;

        // 油箱收集检测（飞机必须在地面滑过油箱位置才能加油）
        for (let r of state.runways) {
            if (r.fuelTankX !== undefined && !r.fuelTankCollected) {
                const relX = r.fuelTankX - px; // 正=油箱在飞机右前方，负=油箱已在飞机后方
                if (relX <= 0 && relX >= -80) {
                    // 油箱刚刚滚过飞机位置的窗口期（80px 容差）
                    if (state.onGround) {
                        // 飞机在地面 → 成功拾取
                        r.fuelTankCollected = true;
                        state.fuel = 100;
                        state.lowFuelWarned20 = false;
                        state.lowFuelWarned10 = false;
                        state.flameoutWarned  = false;
                        state.messages.push({ text: '⛽ 燃油已满！FUEL FULL', life: 3.5 });
                    }
                    // 若飞机在空中飞越油箱，不触发（油箱继续留在跑道等待）
                } else if (relX < -80) {
                    // 油箱已远远滚过，且飞机从未在地面经过 → 错过，移除标志
                    r.fuelTankCollected = true;
                }
            }
        }
        
        // 天花板极限
        if (py < -100) {
            state.isGameOver = true; state.failReason = '超出升限失控';
        }

        // 障碍物碰撞检测
        for (let obs of state.obstacles) {
            if (px + hitboxRadius > obs.x && px - hitboxRadius < obs.x + obs.width) {
                if (py - hitboxRadius < obs.gapTop || py + hitboxRadius > obs.gapBottom) {
                    state.isGameOver = true; state.failReason = '撞击建筑物';
                }
            }
        }

        // 地面与着陆判定
        const GROUND_Y = canvas.height - 20;
        const gearExt = state.gear ? 18 : 14; 
        const currentBottom = py + gearExt;

        if (currentBottom >= GROUND_Y) {
            // 检查下方是否有跑道
            const onRunway = state.runways.find(r => px > r.x && px < r.x + r.width);
            
            if (onRunway) {
                // 如果是瞬间刚接触地面
                if (!state.onGround) {
                    // 接地姿态检查：画布坐标系中 pitch 负值=抬头，正值=低头，与航空惯例相反
                    // 显示值 = -pitchInternal；安全范围随已完成跑道数收敛：-5~+11 → 0~+6
                    const pitchDeg = state.pitch * 180 / Math.PI; // 内部值
                    const t = Math.min(1, state.runwaysGenerated / 8);
                    const minPitchDisp = -5 + 5 * t;   // -5 → 0
                    const maxPitchDisp = 11 - 5 * t;   // 11 → 6
                    // 内部安全范围 = [-maxPitchDisp, -minPitchDisp]
                    const PITCH_INTERNAL_MIN = -maxPitchDisp;
                    const PITCH_INTERNAL_MAX = -minPitchDisp;
                    const pitchBad = pitchDeg < PITCH_INTERNAL_MIN || pitchDeg > PITCH_INTERNAL_MAX;

                    if (!state.gear) {
                        state.isGameOver = true;
                        state.failReason = '未放起落架，机腹擦地损毁';
                    } else if (pitchBad) {
                        state.isGameOver = true;
                        state.failReason = `接地姿态异常 (俯仰 ${(-pitchDeg).toFixed(1)}°，安全范围 ${minPitchDisp.toFixed(0)}° ~ +${maxPitchDisp.toFixed(0)}°)`;
                    } else if (state.vy > MAX_LANDING_VY) {
                        state.isGameOver = true;
                        state.failReason = `接地垂直率过大解体 (${Math.round(state.vy)} > ${MAX_LANDING_VY})`;
                    } else if (state.speed > MAX_LANDING_SPEED) {
                        state.isGameOver = true;
                        state.failReason = `进场速度过快冲出跑道 (${Math.round(state.speed)} > ${MAX_LANDING_SPEED})`;
                    } else {
                        // 成功着陆！
                        state.onGround = true;
                        if (!onRunway.scored) {
                            onRunway.scored = true;
                            state.score += 10;
                            setUiScore(state.score);
                            const rwLen = onRunway.width;
                            const isMin = rwLen <= 400;
                            // 检查是否已拿到油箱
                            const gotFuel = onRunway.fuelTankCollected;
                            state.messages.push({
                                text: `✅ PERFECT LANDING! +10  RWY ${rwLen}m${isMin ? ' 🏆 EXTREME!' : ''}${gotFuel ? '  ⛽' : '  ⚠ NO FUEL'}`,
                                life: 4.0
                            });
                        }
                    }
                }

                // 保持在地面上滑行
                if (!state.isGameOver) {
                    state.y = GROUND_Y - gearExt;
                    if (state.vy > 0) state.vy = 0; 
                    
                    state.vx -= state.vx * 0.2 * dt; // 车轮摩擦减速
                    
                    // 轻微压平机头，但不限制玩家拉杆起飞
                    if (state.pitch > 0) state.pitch *= 0.8; 
                }
            } else {
                // 跑道外触地 = 坠毁
                state.isGameOver = true;
                state.failReason = '偏离航线，坠毁于非铺装地面 (CFIT)';
            }
        } else {
            state.onGround = false;
        }
    };

    // ================= 渲染系统 =================
    const drawEngine = (ctx) => {
        const state = gameState.current;
        if (!state) return;
        const w = ctx.canvas.width; const h = ctx.canvas.height;
        const GROUND_Y = h - 20;

        // ── 移动端水平视野拉伸：缩小 X 轴比例，让画面往右露出更多世界，Y 轴不动 ──
        // 飞机锚点保持在屏幕 20% 处，障碍物在生成瞬间就进入视野，给足反应时间。
        const ZOOM = w < 640 ? 0.52 : 1.0;
        const planeWorldX = w * 0.2;
        // 令 ZOOM * planeWorldX + tx = planeWorldX → tx = planeWorldX * (1 - ZOOM)
        const camTx = planeWorldX * (1 - ZOOM);

        // =====================================================
        // 视差背景 —— 天空 · 星星 · 多层山脉 · 云朵
        // =====================================================

        // --- 天空渐变（静止）---
        const skyGrad = ctx.createLinearGradient(0, 0, 0, GROUND_Y);
        skyGrad.addColorStop(0.0,  '#04080f');  // 极深暗蓝
        skyGrad.addColorStop(0.45, '#0b1929');  // 深夜蓝
        skyGrad.addColorStop(0.78, '#122240');  // 地平线蓝
        skyGrad.addColorStop(1.0,  '#1c3355');  // 地平线微亮
        ctx.fillStyle = skyGrad;
        ctx.fillRect(0, 0, w, GROUND_Y + 2);

        // --- 星星（静止，用固定伪随机散布）---
        ctx.save();
        for (let i = 0; i < 120; i++) {
            const sx = ((i * 1279 + 37) % 997) / 997 * w;
            const sy = ((i * 853  + 19) % 991) / 991 * (GROUND_Y * 0.55);
            const bright = 0.3 + ((i * 521) % 100) / 100 * 0.7;
            const sr = 0.4 + ((i * 173) % 10) / 10 * 0.8;
            ctx.globalAlpha = bright;
            ctx.fillStyle = '#ffffff';
            ctx.beginPath(); ctx.arc(sx, sy, sr, 0, Math.PI * 2); ctx.fill();
        }
        ctx.globalAlpha = 1;
        ctx.restore();

        // --- 山脉层（从最远→最近，越近越快越暗）---
        // offsets[0]=不动(最远), offsets[1~3]=逐渐加速
        const mtLayers = [
            //  offset              填色         基线比  [频率1,   频率2,   频率3]  [振幅1, 振幅2, 振幅3]
            { off: state.bg.offsets[0], color:'#1a2b47', base:0.38, freqs:[0.0022,0.0048,0.0097], amps:[0.20,0.10,0.04] },
            { off: state.bg.offsets[1], color:'#152033', base:0.47, freqs:[0.0036,0.0079,0.0160], amps:[0.15,0.07,0.03] },
            { off: state.bg.offsets[2], color:'#0f1826', base:0.56, freqs:[0.0055,0.0115,0.0240], amps:[0.11,0.05,0.025]},
            { off: state.bg.offsets[3], color:'#090f1a', base:0.66, freqs:[0.0080,0.0170,0.0360], amps:[0.08,0.038,0.019]},
        ];
        mtLayers.forEach(layer => {
            ctx.fillStyle = layer.color;
            ctx.beginPath();
            ctx.moveTo(0, GROUND_Y + 2);
            for (let x = 0; x <= w + 5; x += 3) {
                const xo = x + layer.off;
                let y = GROUND_Y * layer.base;
                layer.freqs.forEach((f, fi) => {
                    y += Math.sin(xo * f + fi * 2.1) * GROUND_Y * layer.amps[fi];
                });
                ctx.lineTo(x, y);
            }
            ctx.lineTo(w + 5, GROUND_Y + 2);
            ctx.closePath();
            ctx.fill();
        });

        // === 游戏世界层：水平缩放（Y 轴不变，地面线保持原位）===
        ctx.save();
        ctx.translate(camTx, 0);
        ctx.scale(ZOOM, 1);

        // --- 云朵（按层半透明）---
        if (state.bg.clouds) {
            // 云朵颜色按层：越远越暗越淡
            const cloudColors = [
                'rgba(110,145,185,0.22)',  // 远
                'rgba(135,165,200,0.28)',  // 中
                'rgba(160,185,215,0.35)',  // 近
            ];
            // 先画远层云，再画近层云（排序）
            const sorted = [...state.bg.clouds].sort((a, b) => a.layer - b.layer);
            sorted.forEach(c => {
                const col = cloudColors[c.layer];
                const cx = c.x, cy = c.y, cw = c.w, ch = c.h;
                ctx.fillStyle = col;
                // 主体椭圆
                ctx.beginPath(); ctx.ellipse(cx + cw*0.5, cy + ch*0.55, cw*0.5, ch*0.45, 0, 0, Math.PI*2); ctx.fill();
                // 左鼓包
                ctx.beginPath(); ctx.ellipse(cx + cw*0.28, cy + ch*0.6, cw*0.30, ch*0.38, 0, 0, Math.PI*2); ctx.fill();
                // 右鼓包
                ctx.beginPath(); ctx.ellipse(cx + cw*0.72, cy + ch*0.6, cw*0.30, ch*0.38, 0, 0, Math.PI*2); ctx.fill();
                // 顶部小凸起
                ctx.beginPath(); ctx.ellipse(cx + cw*0.5, cy + ch*0.28, cw*0.22, ch*0.32, 0, 0, Math.PI*2); ctx.fill();
            });
        }

        // =====================================================
        // 以下为原有游戏元素
        // =====================================================

        // 绘制通用地面 (非铺装) — 覆盖整个视口世界范围（含左侧负坐标区）
        ctx.fillStyle = '#171923'; 
        ctx.fillRect(-300, GROUND_Y, w / ZOOM + 600, 20);

        // 绘制跑道
        state.runways.forEach(r => {
            ctx.fillStyle = '#4A5568';
            ctx.fillRect(r.x, GROUND_Y, r.width, 20);
            
            ctx.fillStyle = '#CBD5E0';
            // 跑道起降端标志线
            ctx.fillRect(r.x + 20, GROUND_Y, 20, 20);
            ctx.fillRect(r.x + 60, GROUND_Y, 20, 20);
            ctx.fillRect(r.x + r.width - 40, GROUND_Y, 20, 20);
            ctx.fillRect(r.x + r.width - 80, GROUND_Y, 20, 20);
            // 跑道中线（可见范围用 w/ZOOM 判断，确保移动端缩放视口内全程绘制）
            for (let i = 150; i < r.width - 150; i += 80) {
                if (r.x + i > 0 && r.x + i < w / ZOOM) {
                    ctx.fillRect(r.x + i, GROUND_Y + 8, 40, 4);
                }
            }
            // 跑道长度标签（仅挑战跑道显示）
            if (r.challengeNum != null) {
                const labelX = r.x + r.width / 2;
                const labelY = GROUND_Y - 8;
                const isMin = r.width <= 400;
                ctx.save();
                ctx.font = 'bold 13px monospace';
                ctx.textAlign = 'center';
                ctx.fillStyle = isMin ? '#FF6B6B' : '#F6E05E';
                ctx.fillText(`#${r.challengeNum}  ${r.width}m${isMin ? ' ⚠' : ''}`, labelX, labelY);
                ctx.restore();
            }

            // 绘制油箱标志（35% 进近区，未被拾取时显示）
            if (r.fuelTankX !== undefined && !r.fuelTankCollected) {
                const tx = r.fuelTankX;
                const ty = GROUND_Y;
                ctx.save();
                // 闪烁效果：每 0.5 秒闪一次
                const blink = Math.floor(Date.now() / 500) % 2 === 0;
                ctx.globalAlpha = blink ? 1.0 : 0.6;

                // 阴影发光
                ctx.shadowColor = '#FFD700';
                ctx.shadowBlur = 10;

                // 桶身（圆角矩形近似）
                const bx = tx - 10, by = ty - 22, bw = 20, bh = 18;
                ctx.fillStyle = '#E53E3E';
                ctx.beginPath();
                ctx.roundRect(bx, by, bw, bh, 3);
                ctx.fill();

                // 桶盖
                ctx.fillStyle = '#FC8181';
                ctx.fillRect(bx + 3, by - 4, bw - 6, 5);

                // 油嘴
                ctx.fillStyle = '#CBD5E0';
                ctx.fillRect(tx + 2, by - 9, 4, 6);

                // ⛽ 符号
                ctx.shadowBlur = 0;
                ctx.globalAlpha = 1.0;
                ctx.font = 'bold 11px sans-serif';
                ctx.textAlign = 'center';
                ctx.fillStyle = '#FFD700';
                ctx.fillText('⛽', tx, by - 10);

                // 下方地面标线（黄色区域提示）
                ctx.globalAlpha = 0.35;
                ctx.fillStyle = '#FFD700';
                ctx.fillRect(r.x + r.width * 0.60, ty, r.width * 0.40, 20);
                ctx.globalAlpha = 1.0;

                ctx.restore();
            }
        });

        // 绘制障碍物
        state.obstacles.forEach(obs => {
            ctx.fillStyle = '#4A5568';
            ctx.fillRect(obs.x, 0, obs.width, obs.gapTop);
            ctx.fillRect(obs.x, obs.gapBottom, obs.width, GROUND_Y - obs.gapBottom);
            ctx.fillStyle = '#E53E3E'; ctx.fillRect(obs.x, obs.gapTop - 4, obs.width, 4);
            ctx.fillStyle = '#3182CE'; ctx.fillRect(obs.x, obs.gapBottom, obs.width, 4);
        });

        // 绘制粒子
        state.particles.forEach(p => {
            if (p.type === 'flame') {
                ctx.fillStyle = `rgba(255, ${Math.random()*150 + 100}, 0, ${p.life})`;
                ctx.beginPath(); ctx.arc(p.x, p.y, p.life * 6, 0, Math.PI*2); ctx.fill();
            } else {
                ctx.strokeStyle = `rgba(255, 255, 255, ${p.life * 0.3})`; ctx.lineWidth = 2;
                ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x + 100, p.y); ctx.stroke();
            }
        });

        const planeX = w * 0.2; const planeY = state.y;
        
        ctx.save();
        ctx.translate(planeX, planeY);
        ctx.scale(1 / ZOOM, 1);  // 还原水平比例，飞机形状不变形
        ctx.rotate(state.pitch);

        if (state.isStalled) ctx.translate((Math.random()-0.5)*8, (Math.random()-0.5)*8);

        // 绘制起落架
        if (state.gear) {
            ctx.fillStyle = '#4A5568';
            ctx.fillRect(12, 5, 2, 10);  
            ctx.fillRect(-8, 5, 3, 10);  
            ctx.fillStyle = '#111';
            ctx.beginPath(); ctx.arc(13, 15, 3, 0, Math.PI*2); ctx.fill(); 
            ctx.beginPath(); ctx.arc(-6.5, 15, 4, 0, Math.PI*2); ctx.fill(); 
        }

        // 绘制襟翼
        if (state.flaps > 0) {
            ctx.fillStyle = '#A0AEC0';
            ctx.save();
            ctx.translate(-15, 0); 
            ctx.rotate(state.flaps * 0.2); 
            ctx.fillRect(-8, -2, 8, 4);
            ctx.restore();
        }

        // 机身
        ctx.fillStyle = '#E2E8F0';
        ctx.beginPath();
        ctx.moveTo(25, 0); ctx.lineTo(5, -6); ctx.lineTo(-15, -6); ctx.lineTo(-20, -15);    
        ctx.lineTo(-25, -15); ctx.lineTo(-20, 0); ctx.lineTo(-25, 0); ctx.lineTo(-20, 6);
        ctx.lineTo(-5, 6); ctx.lineTo(0, 15); ctx.lineTo(15, 5); ctx.fill();
        ctx.fillStyle = '#63B3ED'; 
        ctx.beginPath(); ctx.moveTo(15, -4); ctx.quadraticCurveTo(5, -12, -5, -6); ctx.fill();

        ctx.restore();

        // HUD 数据投影
        ctx.save();
        ctx.translate(planeX, planeY);
        ctx.scale(1 / ZOOM, 1);  // 还原水平比例，HUD 符号不变形
        ctx.rotate(state.gamma); 
        ctx.strokeStyle = '#00FF00'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(80, 0, 6, 0, Math.PI*2); 
        ctx.moveTo(74, 0); ctx.lineTo(60, 0); ctx.moveTo(86, 0); ctx.lineTo(100, 0); 
        ctx.moveTo(80, -6); ctx.lineTo(80, -15); ctx.stroke();
        ctx.restore();

        // === 结束游戏世界缩放层 ===
        ctx.restore();

        // --- AOA 标注（屏幕坐标：Y 无缩放，X 锚定飞机屏幕位置）---
        // 飞机屏幕 X = planeWorldX（由 camTx 锚定），Y = state.y（y轴未缩放）
        ctx.font = `${ZOOM < 1 ? 11 : 13}px monospace`; ctx.textAlign = 'left';
        ctx.fillStyle = Math.abs(state.aoa) > STALL_ANGLE * 0.8 ? '#FF4444' : '#00FF00';
        ctx.fillText(`AOA ${(state.aoa * 180 / Math.PI).toFixed(1)}°`, planeWorldX - 50, state.y - 42);

        // 浮动文本绘制（屏幕坐标）
        const msgFontSize = ZOOM < 1 ? 20 : 36;
        state.messages.forEach((msg, idx) => {
            ctx.fillStyle = `rgba(74, 222, 128, ${Math.min(1, msg.life)})`;
            ctx.font = `bold ${msgFontSize}px sans-serif`; ctx.textAlign = 'center';
            ctx.fillText(msg.text, w / 2, h / 3 - (idx * (msgFontSize + 4)));
        });

        if (state.isStalled && Math.floor(Date.now() / 200) % 2 === 0) {
            ctx.fillStyle = '#FF0000';
            ctx.font = `bold ${ZOOM < 1 ? 32 : 48}px sans-serif`;
            ctx.textAlign = 'center';
            ctx.fillText('STALL WARNING', w / 2, h / 4);
        }
    };

    const gameLoop = useCallback((time) => {
        if (!gameState.current) return;
        if (gameState.current.isGameOver) { setGameStatus('gameover'); return; }
        
        const dt = time - lastTimeRef.current;
        lastTimeRef.current = time;
        updateEngine(dt);
        drawEngine(canvasRef.current.getContext('2d'));
        requestRef.current = requestAnimationFrame(gameLoop);
    }, []);

    useEffect(() => {
        if (gameStatus === 'playing') {
            lastTimeRef.current = performance.now();
            requestRef.current = requestAnimationFrame(gameLoop);
        }
        return () => cancelAnimationFrame(requestRef.current);
    }, [gameStatus, gameLoop]);

    useEffect(() => {
        const handleResize = () => {
            if (canvasRef.current) {
                canvasRef.current.width = window.innerWidth;
                canvasRef.current.height = window.innerHeight;
                if (!gameState.current) gameState.current = initGameState(window.innerWidth, window.innerHeight);
                if (gameStatus !== 'playing') drawEngine(canvasRef.current.getContext('2d'));
            }
        };
        window.addEventListener('resize', handleResize);
        handleResize();
        return () => window.removeEventListener('resize', handleResize);
    }, [gameStatus]);

    // 挂载后动态计算油门初始位置（慢车 = 轨道最底部），避免硬编码像素值在不同屏幕出错
    useEffect(() => {
        if (throttleTrackRef.current) {
            const maxY = throttleTrackRef.current.getBoundingClientRect().height - 40;
            setThrottleY(maxY);
        }
    }, []);

    // 窗口 resize 时同步油门滑块位置（非游戏中保持在慢车底部）
    useEffect(() => {
        if (gameStatus !== 'playing' && throttleTrackRef.current) {
            const maxY = throttleTrackRef.current.getBoundingClientRect().height - 40;
            setThrottleY(maxY);
        }
    }, [gameStatus]);

    const [dashFuel, setDashFuel] = useState(100);
    const [dashAlt, setDashAlt] = useState(0);
    const [dashVS, setDashVS] = useState(0);
    const [dashSpd, setDashSpd] = useState(0);
    const [dashNearRunway, setDashNearRunway] = useState(null);
    const [gearWarnActive, setGearWarnActive] = useState(false);

    // 移动端检测：宽度 < 640px 视为移动设备
    const [isMobile, setIsMobile] = useState(() => window.innerWidth < 640);
    useEffect(() => {
        const onResize = () => setIsMobile(window.innerWidth < 640);
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
    }, []);
    useEffect(() => {
        if (gameStatus !== 'playing') return;
        const interval = setInterval(() => {
            if (gameState.current) {
                const s = gameState.current;
                const cw = canvasRef.current?.width ?? window.innerWidth;
                const ch = canvasRef.current?.height ?? window.innerHeight;
                setDashFuel(s.fuel);
                const altFt = Math.max(0, Math.round((ch - 20 - s.y) * 10));
                setDashAlt(altFt);
                const vsVal = Math.round(-s.vy); // positive = climbing
                setDashVS(vsVal);
                // 起落架警告：高于 2000ft 且正在爬升且起落架放下
                setGearWarnActive(!s.isGameOver && s.gear && altFt > 2000 && vsVal > 30);
                setDashSpd(Math.round(s.speed));
                const planeX = cw * 0.2;
                const near = s.runways.find(r => {
                    const mid = r.x + r.width / 2;
                    return !r.scored && mid > planeX && (mid - planeX) < 700;
                });
                if (near) {
                    const t = Math.min(1, s.runwaysGenerated / 8);
                    const minP = -5 + 5 * t;
                    const maxP = 11 - 5 * t;
                    const pitchDeg = -(s.pitch * 180 / Math.PI);
                    const pitchOk = pitchDeg >= minP && pitchDeg <= maxP;
                    const vyOk   = s.vy < MAX_LANDING_VY;
                    const spdOk  = s.speed < MAX_LANDING_SPEED;
                    const gearOk = s.gear;
                    setDashNearRunway({ pitchDeg, minP, maxP, pitchOk, vyOk, spdOk, gearOk,
                        speed: s.speed, vs: s.vy, allOk: pitchOk && vyOk && spdOk && gearOk });
                } else {
                    setDashNearRunway(null);
                }
            }
        }, 100);
        return () => clearInterval(interval);
    }, [gameStatus]);

    return (
        <div className="relative w-full h-screen bg-black overflow-hidden touch-none select-none font-mono">
            <canvas ref={canvasRef} className="block w-full h-full" />

            <div className="absolute top-2 w-full flex justify-between px-2 sm:top-4 sm:px-10 pointer-events-none text-green-400 z-10">
                {/* 空速 — 左 */}
                <div className="flex flex-col items-start bg-green-900/20 px-2 py-1 sm:px-4 sm:py-2 rounded border border-green-500/30 backdrop-blur-sm">
                    <span className="text-[9px] sm:text-xs text-green-200 tracking-widest">AIRSPEED</span>
                    <span className="text-lg sm:text-3xl font-bold">{dashSpd} <span className="text-xs sm:text-base font-normal opacity-70">KTS</span></span>
                </div>
                {/* 积分 — 中 */}
                <div className="flex flex-col items-center">
                    <span className="text-[9px] sm:text-xs text-green-200 tracking-widest">MISSION SCORE</span>
                    <span className="text-2xl sm:text-5xl font-black text-white drop-shadow-[0_0_10px_#4ADE80]">{uiScore}</span>
                </div>
                {/* 高度 + 垂直速度 + 燃料 — 右 */}
                <div className="flex flex-col items-end gap-1">
                    <div className="flex items-end gap-2 sm:gap-4 bg-green-900/20 px-2 py-1 sm:px-4 sm:py-2 rounded border border-green-500/30 backdrop-blur-sm">
                        <div className="flex flex-col items-end">
                            <span className="text-[9px] sm:text-xs text-green-200 tracking-widest">ALTITUDE</span>
                            <span className="text-lg sm:text-3xl font-bold">{dashAlt} <span className="text-xs sm:text-base font-normal opacity-70">FT</span></span>
                        </div>
                        <div className="flex flex-col items-end border-l border-green-500/30 pl-2 sm:pl-4">
                            <span className="text-[9px] sm:text-xs text-green-200 tracking-widest">V/S</span>
                            <span className={`text-sm sm:text-xl font-bold ${
                                dashVS > 30 ? 'text-green-400' : dashVS < -30 ? 'text-orange-400' : 'text-yellow-400'
                            }`}>{dashVS > 0 ? '+' : ''}{dashVS}</span>
                        </div>
                    </div>
                    <div className="flex items-center gap-1 sm:gap-2 bg-green-900/20 px-2 py-1 sm:px-4 sm:py-1.5 rounded border border-green-500/30 backdrop-blur-sm w-full">
                        <span className="text-[9px] sm:text-[10px] text-green-200 tracking-widest">FUEL</span>
                        <div className="flex-1 h-2 sm:h-3 bg-gray-800 border border-green-500/50">
                            <div className="h-full transition-all duration-200"
                                style={{ width: `${Math.max(0, dashFuel)}%`, backgroundColor: dashFuel > 20 ? '#4ADE80' : '#F87171' }}/>
                        </div>
                        <span className="text-[9px] sm:text-[10px] text-green-200 w-6 sm:w-8 text-right">{Math.round(dashFuel)}%</span>
                    </div>
                </div>
            </div>

            {/* ================= 左手侧：飞行控制杆 ================= */}
            {/* 移动端: 左下角小型控制杆；桌面端: 左侧居中大型控制杆 */}
            <div className="absolute left-2 bottom-3 sm:left-8 sm:bottom-auto sm:top-1/2 sm:-translate-y-1/2 flex items-end sm:items-center pointer-events-none z-20">
                <div 
                    className="relative w-20 h-[170px] sm:w-32 sm:h-[450px] flex justify-center items-center pointer-events-auto touch-none"
                    onPointerDown={(e) => { e.target.setPointerCapture(e.pointerId); handleStickEvent(e, true); }}
                    onPointerMove={handleStickEvent}
                    onPointerUp={(e) => { handleStickUp(); try{e.target.releasePointerCapture(e.pointerId)}catch(e){} }}
                >
                    <div ref={stickTrackRef} className="relative w-7 h-[130px] sm:w-10 sm:h-[300px] bg-gray-900/80 rounded-full border border-gray-600 shadow-[inset_0_0_20px_#000] flex justify-center items-center pointer-events-none">
                        <div className="absolute w-8 sm:w-12 h-[80%] border-x-4 border-gray-800 rounded-full opacity-50"></div>
                        <div 
                            style={{ transform: `translateY(${knobY}px)` }}
                            className="absolute w-12 h-14 sm:w-20 sm:h-24 bg-gradient-to-b from-gray-300 to-gray-600 rounded-t-2xl rounded-b-lg shadow-[0_15px_30px_rgba(0,0,0,0.8)] border-2 border-gray-400 flex flex-col items-center justify-start pt-1 sm:pt-2"
                        >
                            <div className="w-4 h-3 sm:w-6 sm:h-4 bg-red-500 rounded-sm mb-1 shadow-[inset_0_2px_4px_rgba(0,0,0,0.5)]"></div> 
                            <div className="w-8 sm:w-12 h-1 bg-gray-800 rounded-full opacity-50 mt-1 sm:mt-2"></div>
                            <div className="w-8 sm:w-12 h-1 bg-gray-800 rounded-full opacity-50 mt-1"></div>
                        </div>
                    </div>
                </div>
                
                {/* 桌面端才显示操作提示标签 */}
                <div className="hidden sm:flex ml-6 flex-col justify-between h-[300px] text-left text-xs opacity-70 border-l border-green-500/30 pl-4">
                    <div className="text-green-300">
                        <span className="block font-bold">▲ NOSE DOWN</span>
                        <span>俯冲加速</span>
                    </div>
                    <div className="text-green-300">
                        <span className="block font-bold">▼ NOSE UP</span>
                        <span>拉升减速</span>
                    </div>
                </div>
            </div>

            {/* ================= 右手侧：HOTAS 油门与控制面板 ================= */}
            {/* 移动端: 右下角紧凑布局；桌面端: 右侧居中大型面板 */}
            <div className="absolute right-2 bottom-3 sm:right-8 sm:bottom-auto sm:top-1/2 sm:-translate-y-1/2 sm:h-[500px] flex items-end sm:items-center gap-2 sm:gap-6 pointer-events-none z-20">
                {/* ===== 起落架手柄 ===== */}
                <div className="flex flex-col items-center pointer-events-auto select-none">
                    <span className="text-[8px] sm:text-[10px] text-gray-400 mb-0.5 sm:mb-1 font-bold tracking-widest">GEAR (G)</span>
                    {/* 滑轨 */}
                    <div className="relative w-8 h-24 sm:w-12 sm:h-40 bg-gray-950 border border-gray-600 rounded-2xl shadow-[inset_0_0_12px_rgba(0,0,0,0.8)]">
                        {/* UP / DN 标签 */}
                        <span className="absolute top-1 sm:top-2 left-1/2 -translate-x-1/2 text-[7px] sm:text-[9px] text-gray-500 font-bold z-10 pointer-events-none">UP</span>
                        <span className="absolute bottom-1 sm:bottom-2 left-1/2 -translate-x-1/2 text-[7px] sm:text-[9px] text-gray-500 font-bold z-10 pointer-events-none">DN</span>
                        {/* 中央导轨线 */}
                        <div className="absolute top-4 sm:top-6 bottom-4 sm:bottom-6 left-1/2 -translate-x-1/2 w-0.5 bg-gray-700 rounded-full"></div>
                        {/* 手柄（带轮子图案）*/}
                        <div
                            onClick={toggleGear}
                            style={{
                                top: isGearDown ? (isMobile ? '46px' : '76px') : (isMobile ? '4px' : '8px'),
                                transition: 'top 0.45s cubic-bezier(0.25,0.46,0.45,0.94)',
                            }}
                            className={`absolute left-1/2 -translate-x-1/2 w-7 h-8 sm:w-11 sm:h-14 rounded-xl cursor-pointer flex flex-col items-center justify-center gap-0.5 shadow-lg border-2 ${
                                gearWarnActive
                                    ? 'bg-gradient-to-b from-red-700 to-red-900 border-red-400 animate-gear-warn'
                                    : isGearDown
                                    ? 'bg-gradient-to-b from-orange-600 to-orange-800 border-orange-400 shadow-[0_0_12px_rgba(251,146,60,0.6)]'
                                    : 'bg-gradient-to-b from-gray-500 to-gray-700 border-gray-400'
                            }`}
                        >
                            {/* 轮子 SVG */}
                            <svg width="16" height="16" viewBox="0 0 26 26" fill="none" className="sm:hidden">
                                <circle cx="13" cy="13" r="11" stroke={isGearDown ? '#fcd34d' : '#9ca3af'} strokeWidth="2.2"/>
                                <circle cx="13" cy="13" r="3" fill={isGearDown ? '#fcd34d' : '#9ca3af'}/>
                                <line x1="13" y1="2" x2="13" y2="24" stroke={isGearDown ? '#fcd34d' : '#9ca3af'} strokeWidth="1.4"/>
                                <line x1="2" y1="13" x2="24" y2="13" stroke={isGearDown ? '#fcd34d' : '#9ca3af'} strokeWidth="1.4"/>
                                <line x1="4.8" y1="4.8" x2="21.2" y2="21.2" stroke={isGearDown ? '#fcd34d' : '#9ca3af'} strokeWidth="1.4"/>
                                <line x1="21.2" y1="4.8" x2="4.8" y2="21.2" stroke={isGearDown ? '#fcd34d' : '#9ca3af'} strokeWidth="1.4"/>
                            </svg>
                            <svg width="26" height="26" viewBox="0 0 26 26" fill="none" className="hidden sm:block">
                                <circle cx="13" cy="13" r="11" stroke={isGearDown ? '#fcd34d' : '#9ca3af'} strokeWidth="2.2"/>
                                <circle cx="13" cy="13" r="3" fill={isGearDown ? '#fcd34d' : '#9ca3af'}/>
                                <line x1="13" y1="2" x2="13" y2="24" stroke={isGearDown ? '#fcd34d' : '#9ca3af'} strokeWidth="1.4"/>
                                <line x1="2" y1="13" x2="24" y2="13" stroke={isGearDown ? '#fcd34d' : '#9ca3af'} strokeWidth="1.4"/>
                                <line x1="4.8" y1="4.8" x2="21.2" y2="21.2" stroke={isGearDown ? '#fcd34d' : '#9ca3af'} strokeWidth="1.4"/>
                                <line x1="21.2" y1="4.8" x2="4.8" y2="21.2" stroke={isGearDown ? '#fcd34d' : '#9ca3af'} strokeWidth="1.4"/>
                            </svg>
                            {/* 手柄纹理横条：仅桌面端显示 */}
                            <div className="hidden sm:flex flex-col gap-0.5">
                                <div className={`w-7 h-0.5 rounded-full ${isGearDown ? 'bg-orange-300/50' : 'bg-gray-400/40'}`}></div>
                                <div className={`w-7 h-0.5 rounded-full ${isGearDown ? 'bg-orange-300/50' : 'bg-gray-400/40'}`}></div>
                            </div>
                        </div>
                    </div>
                    {/* 三绿灯：起落架锁定指示 */}
                    <div className="mt-1 sm:mt-2 flex gap-1 sm:gap-1.5">
                        {[0,1,2].map(i => (
                            <div key={i} className={`w-2 h-2 sm:w-2.5 sm:h-2.5 rounded-full border transition-all duration-300 ${
                                isGearDown ? 'bg-green-400 border-green-300 shadow-[0_0_5px_#4ADE80]' : 'bg-gray-800 border-gray-600'
                            }`}/>
                        ))}
                    </div>
                </div>

                <div className="flex flex-col items-center pointer-events-auto h-auto sm:h-[250px] justify-between bg-gray-900/50 p-1.5 sm:p-2 rounded-lg border border-gray-700 mt-0 sm:mt-10 relative">
                    <span className="text-[8px] sm:text-[10px] text-green-400 font-bold mb-1 sm:mb-2">FLAPS</span>
                    <div className="flex flex-col gap-1 sm:gap-2 flex-1 justify-between">
                        {/* 修正：0档位在最上，3档位在最下 */}
                        {[0, 1, 2, 3].map(level => (
                            <button 
                                key={level}
                                onClick={() => handleFlapsSelect(level)}
                                className={`w-7 h-7 sm:w-10 sm:h-10 rounded text-xs sm:text-sm font-bold border transition-colors ${
                                    flapsLevel === level 
                                    ? 'bg-green-600 border-green-300 text-white shadow-[0_0_10px_#4ADE80]' 
                                    : 'bg-gray-800 border-gray-600 text-gray-400 hover:bg-gray-700'
                                }`}
                            >
                                {level}
                            </button>
                        ))}
                    </div>
                </div>

                <div className="relative flex flex-col items-center h-[130px] sm:h-full ml-1 sm:ml-4">
                    <span className="hidden sm:block text-green-400 font-bold mb-3 tracking-widest">THR (PgUp/Dn)</span>
                    <div 
                        className="relative w-8 sm:w-16 h-[110px] sm:flex-1 bg-gray-900 rounded-sm border-2 border-gray-600 pointer-events-auto shadow-[0_0_20px_rgba(0,0,0,0.8)] touch-none"
                        ref={throttleTrackRef}
                        onPointerDown={(e) => { e.target.setPointerCapture(e.pointerId); handleThrottleEvent(e, true); }}
                        onPointerMove={handleThrottleEvent}
                        onPointerUp={(e) => { handleThrottleEvent(e, false); try{e.target.releasePointerCapture(e.pointerId)}catch(e){} }}
                    >
                        <div className="absolute left-0 w-full h-full flex flex-col justify-between py-2 sm:py-4 pointer-events-none opacity-50">
                            {[100,60,20].map(val => (
                                <div key={val} className="flex items-center text-[8px] sm:text-[10px] text-white">
                                    <div className="w-2 sm:w-3 h-px bg-white ml-0.5 sm:ml-1"></div>
                                    <span className="ml-0.5 sm:ml-1 hidden sm:inline">{val}%</span>
                                </div>
                            ))}
                        </div>
                        <div 
                            style={{ top: `${throttleY}px` }}
                            className="absolute left-1/2 -translate-x-1/2 w-12 h-8 sm:w-24 sm:h-14 bg-gradient-to-r from-gray-600 via-gray-400 to-gray-600 border border-gray-300 rounded-sm shadow-2xl cursor-pointer flex items-center justify-end pr-1 sm:pr-2"
                        >
                            <div className="w-1.5 h-5 sm:w-2 sm:h-8 bg-red-500/80 rounded-sm"></div>
                        </div>
                    </div>
                </div>
            </div>

            {/* ================= 着陆检查单（右下角，移动端上移避免与控制区重叠） ================= */}
            {gameStatus === 'playing' && dashNearRunway && (
                <div className="absolute bottom-40 right-2 sm:bottom-6 sm:right-8 z-20 pointer-events-none">
                    <div className="bg-black/75 border border-green-500/40 backdrop-blur-sm px-4 py-3 rounded text-xs font-mono text-green-400 min-w-[230px]">
                        <div className="text-green-300 font-bold tracking-widest mb-2 border-b border-green-500/30 pb-1">LANDING CHECKLIST</div>
                        <div className={`flex items-center gap-2 mb-1 ${dashNearRunway.gearOk ? 'text-green-400' : 'text-red-400'}`}>
                            <span className="w-4">{dashNearRunway.gearOk ? '✓' : '✗'}</span>
                            <span>GEAR DOWN</span>
                        </div>
                        <div className={`flex items-center gap-2 mb-1 ${dashNearRunway.spdOk ? 'text-green-400' : 'text-red-400'}`}>
                            <span className="w-4">{dashNearRunway.spdOk ? '✓' : '✗'}</span>
                            <span>SPD &lt; {MAX_LANDING_SPEED}  <span className="opacity-70">({Math.round(dashNearRunway.speed)})</span></span>
                        </div>
                        <div className={`flex items-center gap-2 mb-1 ${dashNearRunway.vyOk ? 'text-green-400' : 'text-red-400'}`}>
                            <span className="w-4">{dashNearRunway.vyOk ? '✓' : '✗'}</span>
                            <span>V/S &lt; {MAX_LANDING_VY}  <span className="opacity-70">({Math.round(dashNearRunway.vs)})</span></span>
                        </div>
                        <div className={`flex items-center gap-2 mb-2 ${dashNearRunway.pitchOk ? 'text-green-400' : 'text-red-400'}`}>
                            <span className="w-4">{dashNearRunway.pitchOk ? '✓' : '✗'}</span>
                            <span>PITCH {dashNearRunway.pitchDeg.toFixed(1)}°  <span className="opacity-70">[{dashNearRunway.minP.toFixed(0)}~+{dashNearRunway.maxP.toFixed(0)}]</span></span>
                        </div>
                        <div className={`text-center font-black tracking-widest border-t pt-1.5 ${
                            dashNearRunway.allOk ? 'text-green-400 border-green-500/40' : 'text-red-400 border-red-500/40'
                        }`}>
                            {dashNearRunway.allOk ? '✈  CLEARED TO LAND' : '⚠  CORRECT & RETRY'}
                        </div>
                    </div>
                </div>
            )}

            {/* ================= 菜单 / 任务简报界面 ================= */}
            {gameStatus !== 'playing' && (
                <div className="absolute inset-0 bg-black/85 backdrop-blur-md flex flex-col justify-center items-center z-50">
                    {gameStatus === 'menu' ? (
                        <>
                            <h1 className="text-3xl sm:text-6xl font-black text-white mb-2 tracking-[0.2em] border-b-4 border-green-500 pb-4 text-center">AERO DYNAMICS</h1>
                            <p className="text-green-400 tracking-widest mb-6 sm:mb-10 text-base sm:text-xl text-center">全真HOTAS模拟 & 跑道降落挑战</p>
                        </>
                    ) : (
                        <>
                            <h1 className="text-3xl sm:text-5xl font-black text-red-500 mb-2">MISSION FAILED</h1>
                            <p className="text-white text-base sm:text-xl mb-4 bg-red-900/50 px-4 sm:px-6 py-2 border border-red-500 text-center">事故原因: {gameState.current?.failReason}</p>
                            <p className="text-green-400 text-base sm:text-lg mb-6 sm:mb-8">总任务积分: <span className="font-bold text-2xl sm:text-3xl text-white">{uiScore}</span></p>
                        </>
                    )}
                    
                    <button 
                        onClick={startGame}
                        className="px-8 sm:px-12 py-3 sm:py-4 bg-green-600/20 border-2 border-green-500 text-green-400 hover:bg-green-500 hover:text-white text-xl sm:text-2xl font-bold tracking-widest transition-all duration-200"
                    >
                        {gameStatus === 'menu' ? 'REQUEST TAKEOFF' : 'RESTART SORTIE'}
                    </button>

                    <div className="mt-6 sm:mt-12 bg-gray-900/90 p-4 sm:p-6 border border-gray-700 max-w-4xl w-full text-left shadow-2xl relative overflow-hidden mx-2">
                        <div className="absolute top-0 left-0 w-1 h-full bg-green-500"></div>
                        <h3 className="text-gray-300 font-bold mb-3 sm:mb-4 tracking-wider text-sm sm:text-base">航线简报 (已接入键盘协议)</h3>
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 sm:gap-6 text-xs sm:text-sm">
                            <div className="space-y-2">
                                <p><strong className="text-green-400">跑道降落挑战：</strong> 每15个障碍物出现一次跑道，安全触地奖励 <strong className="text-white">+10分</strong>，同时<strong className="text-yellow-300">燃料立刻加满</strong>。跑道随关卡越来越短。</p>
                                <p className="bg-gray-800 border border-gray-600 p-2 text-gray-300 text-xs">安全降落条件：<br/>1. 必须放下起落架<br/>2. 俯仰角 -5°~+11°（随关卡收紧至 0~+6°）<br/>3. 垂直率 (VY) &lt; 180<br/>4. 空速 (SPD) &lt; 320</p>
                            </div>
                            <div className="space-y-2">
                                <p><strong className="text-orange-400">燃料管理：</strong></p>
                                <ul className="list-disc pl-4 text-gray-400 space-y-1">
                                    <li>油门越大、起落架/襟翼开着，<strong className="text-white">耗油越快</strong>。</li>
                                    <li>经济飞行（收轮收翼，低油门）可跳过一个跑道；高阻力飞行必须每次降落加油。</li>
                                    <li>燃料耗尽 → 引擎熄火，无论油门多大都没有推力。</li>
                                </ul>
                            </div>
                            <div className="space-y-2">
                                <p><strong className="text-blue-400">键盘快捷键：</strong></p>
                                <ul className="list-disc pl-4 text-gray-400 space-y-1">
                                    <li><strong className="text-white">G</strong>：收放起落架</li>
                                    <li><strong className="text-white">F</strong>：放下一档襟翼 (向下为高档)</li>
                                    <li><strong className="text-white">Shift + F</strong>：收起一档襟翼</li>
                                    <li><strong className="text-white">Page Up/Down</strong>：增减油门</li>
                                </ul>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
