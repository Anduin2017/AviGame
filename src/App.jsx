import React, { useState, useEffect, useRef, useCallback } from 'react';

// ==========================================
// ✈️ 硬核飞行气动物理常量 (Aero Dynamics)
// ==========================================
const MASS = 1.0;                  
const GRAVITY = 500;               
const LIFT_COEFF = 0.015;          
const DRAG_COEFF = 0.05;           
const MAX_THRUST = 900;            
const STALL_ANGLE = 0.38;          
const GEAR_DRAG = 0.15;            
const FUEL_CONSUMPTION = 0.05;     

// 降落安全阈值
const MAX_LANDING_VY = 180;        // 最大安全接地垂直率
const MAX_LANDING_SPEED = 320;     // 最大安全进场空速

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
    const [throttleY, setThrottleY] = useState(126); // 对齐初始 40% 油门视觉位置 
    const [flapsLevel, setFlapsLevel] = useState(0); // 0, 1, 2, 3
    const [isGearDown, setIsGearDown] = useState(false);
    
    // 游戏核心状态
    const gameState = useRef(null);
    const isDraggingStick = useRef(false);
    const isDraggingThrottle = useRef(false);

    // 初始化物理状态
    const initGameState = (width, height) => ({
        y: height / 2,         
        vx: 250,               
        vy: 0,                 
        pitch: 0,              
        
        worldX: -800,          
        fuel: 100,             
        score: 0,              
        obstaclesGenerated: 0, 
        nextObstacleDist: 650, // 动态障碍物生成间距控制
        
        aoa: 0,                
        gamma: 0,              
        speed: 250,            
        isStalled: false,      
        onGround: false,       // 是否在跑道上滑行
        
        inputY: 0,             // 摇杆
        throttle: 0.4,         
        flaps: 0,              
        gear: false,           
        
        obstacles: [],
        runways: [],           // 跑道数组
        lastObstacleX: 0,
        particles: [],
        messages: [],          // 浮动文本提示 (如完美降落)
        
        isGameOver: false,
        failReason: '',
    });

    const startGame = () => {
        const canvas = canvasRef.current;
        gameState.current = initGameState(canvas.width, canvas.height);
        
        setUiScore(0);
        setKnobY(0);
        setThrottleY(126); // 视觉复位
        setFlapsLevel(0);
        setIsGearDown(false);
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
        const elevatorRate = -state.inputY * 1.5 * fbwElevatorLimit;

        let pitchRate = 0;
        if (state.isStalled) {
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
        const DragMag = DRAG_COEFF * q * CD;
        
        let actualThrust = 0;
        if (state.fuel > 0) {
            actualThrust = MAX_THRUST * state.throttle;
            state.fuel -= state.throttle * FUEL_CONSUMPTION * dt;
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
        if (state.vx < 80) state.vx = 80;

        const dx = state.vx * dt;
        state.worldX += dx;
        state.y += state.vy * dt;

        // ================= 动态生成 (对数级缩小缝隙 & 跑道长进场空域) =================
        if (state.worldX - state.lastObstacleX > state.nextObstacleDist) { 
            state.lastObstacleX = state.worldX;
            state.obstaclesGenerated += 1;
            
            if (state.obstaclesGenerated % 10 === 0) {
                // 生成降落跑道
                state.runways.push({
                    x: canvas.width + 100,
                    width: 3000, 
                    scored: false
                });
                // 【物理修复】：跑道上方绝对不刷柱子，强制推迟下一次生成检测
                state.nextObstacleDist = 3400; 
            } else {
                // 生成普通障碍物
                const baseGap = 250;
                const minGapRatio = 0.125; 
                const gapRatio = Math.max(minGapRatio, Math.pow(0.5, state.obstaclesGenerated / 20));
                const gapSize = baseGap * gapRatio;

                const safeMinPillar = Math.min(120, canvas.height * 0.2);
                const safeMaxGapTop = Math.max(safeMinPillar, canvas.height - safeMinPillar - gapSize);
                const gapTop = safeMinPillar + Math.random() * (safeMaxGapTop - safeMinPillar);

                state.obstacles.push({
                    x: canvas.width + 100, width: 80,
                    gapTop: gapTop, gapBottom: gapTop + gapSize,
                    passed: false
                });

                // 【物理修复】：如果下一个就是跑道了(逢9)，给予极长的进场空域让你降高度
                if (state.obstaclesGenerated % 10 === 9) {
                    state.nextObstacleDist = 1200; 
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
            if (r.x + r.width < -100) state.runways.splice(i, 1);
        }

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
                x: canvas.width, y: Math.random() * canvas.height,
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
                    if (state.vy > MAX_LANDING_VY || state.speed > MAX_LANDING_SPEED || !state.gear) {
                        state.isGameOver = true;
                        if (!state.gear) state.failReason = '未放起落架，机腹擦地损毁';
                        else if (state.vy > MAX_LANDING_VY) state.failReason = `接地垂直率过大解体 (${Math.round(state.vy)} > ${MAX_LANDING_VY})`;
                        else state.failReason = `进场速度过快冲出跑道 (${Math.round(state.speed)} > ${MAX_LANDING_SPEED})`;
                    } else {
                        // 成功着陆！
                        state.onGround = true;
                        if (!onRunway.scored) {
                            onRunway.scored = true;
                            state.score += 10;
                            setUiScore(state.score);
                            state.messages.push({ text: '✅ PERFECT LANDING! +10 PTS', life: 3.0 });
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

        // 背景
        ctx.fillStyle = '#1A202C'; ctx.fillRect(0, 0, w, h);
        ctx.strokeStyle = '#2D3748'; ctx.lineWidth = 1;
        const offsetX = -(state.worldX % 100);
        for(let x = offsetX; x < w; x+=100) {
            ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
        }

        // 绘制通用地面 (非铺装)
        const GROUND_Y = h - 20;
        ctx.fillStyle = '#171923'; 
        ctx.fillRect(0, GROUND_Y, w, 20);

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
            // 跑道中线
            for (let i = 150; i < r.width - 150; i += 80) {
                if (r.x + i > 0 && r.x + i < w) {
                    ctx.fillRect(r.x + i, GROUND_Y + 8, 40, 4);
                }
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
        ctx.rotate(state.gamma); 
        ctx.strokeStyle = '#00FF00'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(80, 0, 6, 0, Math.PI*2); 
        ctx.moveTo(74, 0); ctx.lineTo(60, 0); ctx.moveTo(86, 0); ctx.lineTo(100, 0); 
        ctx.moveTo(80, -6); ctx.lineTo(80, -15); ctx.stroke();
        ctx.restore();

        ctx.fillStyle = '#00FF00'; ctx.font = '14px monospace'; ctx.textAlign = 'left';
        
        ctx.fillText(`SPD:  ${Math.round(state.speed)} kts`, planeX - 50, planeY - 60);
        ctx.fillStyle = Math.abs(state.aoa) > STALL_ANGLE * 0.8 ? '#FF0000' : '#00FF00';
        ctx.fillText(`AOA:  ${(state.aoa * 180 / Math.PI).toFixed(1)}°`, planeX - 50, planeY - 45);
        
        // HUD 状态指示与降落检查单
        ctx.fillStyle = '#00FF00';
        ctx.fillText(`FLP:  ${state.flaps}`, planeX - 50, planeY - 30);
        if (state.gear) {
            ctx.fillStyle = '#FFA500';
            ctx.fillText(`GEAR: DOWN`, planeX - 50, planeY - 15);
            
            // 显示降落条件检查器
            const vyOk = state.vy < MAX_LANDING_VY;
            const spdOk = state.speed < MAX_LANDING_SPEED;
            ctx.fillStyle = (vyOk && spdOk) ? '#00FF00' : '#FF0000';
            ctx.fillText(`LND CHK: ${vyOk && spdOk ? 'OK' : 'WARN'}`, planeX - 50, planeY + 15);
        }

        // 浮动文本绘制
        state.messages.forEach((msg, idx) => {
            ctx.fillStyle = `rgba(74, 222, 128, ${Math.min(1, msg.life)})`; // 绿色
            ctx.font = 'bold 36px sans-serif'; ctx.textAlign = 'center';
            ctx.fillText(msg.text, w/2, h/3 - (idx * 40));
        });

        if (state.isStalled && Math.floor(Date.now() / 200) % 2 === 0) {
            ctx.fillStyle = '#FF0000'; ctx.font = 'bold 48px sans-serif'; ctx.textAlign = 'center';
            ctx.fillText('STALL WARNING', w/2, h/4);
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

    const [dashFuel, setDashFuel] = useState(100);
    const [dashAlt, setDashAlt] = useState(0);
    useEffect(() => {
        if (gameStatus !== 'playing') return;
        const interval = setInterval(() => {
            if (gameState.current) {
                setDashFuel(gameState.current.fuel);
                setDashAlt(Math.max(0, Math.round((window.innerHeight - 20 - gameState.current.y) * 10))); 
            }
        }, 100);
        return () => clearInterval(interval);
    }, [gameStatus]);

    return (
        <div className="relative w-full h-screen bg-black overflow-hidden touch-none select-none font-mono">
            <canvas ref={canvasRef} className="block w-full h-full" />

            <div className="absolute top-4 w-full flex justify-between px-10 pointer-events-none text-green-400 z-10">
                <div className="flex flex-col items-start bg-green-900/20 px-4 py-2 rounded border border-green-500/30 backdrop-blur-sm">
                    <span className="text-xs text-green-200">ALTITUDE</span>
                    <span className="text-3xl font-bold">{dashAlt} FT</span>
                </div>
                <div className="flex flex-col items-center">
                    <span className="text-xs text-green-200 tracking-widest">MISSION SCORE</span>
                    <span className="text-5xl font-black text-white drop-shadow-[0_0_10px_#4ADE80]">{uiScore}</span>
                </div>
                <div className="flex flex-col items-end bg-green-900/20 px-4 py-2 rounded border border-green-500/30 backdrop-blur-sm">
                    <span className="text-xs text-green-200">FUEL QTY</span>
                    <div className="w-32 h-4 bg-gray-800 border border-green-500 mt-1">
                        <div className="h-full transition-all duration-200"
                            style={{ width: `${Math.max(0, dashFuel)}%`, backgroundColor: dashFuel > 20 ? '#4ADE80' : '#F87171' }}/>
                    </div>
                </div>
            </div>

            {/* ================= 左手侧：飞行控制杆 ================= */}
            <div className="absolute left-8 top-1/2 -translate-y-1/2 flex items-center pointer-events-none z-20">
                <div 
                    className="relative w-32 h-[450px] flex justify-center items-center pointer-events-auto touch-none"
                    onPointerDown={(e) => { e.target.setPointerCapture(e.pointerId); handleStickEvent(e, true); }}
                    onPointerMove={handleStickEvent}
                    onPointerUp={(e) => { handleStickUp(); try{e.target.releasePointerCapture(e.pointerId)}catch(e){} }}
                >
                    <div ref={stickTrackRef} className="relative w-10 h-[300px] bg-gray-900/80 rounded-full border border-gray-600 shadow-[inset_0_0_20px_#000] flex justify-center items-center pointer-events-none">
                        <div className="absolute w-12 h-[80%] border-x-4 border-gray-800 rounded-full opacity-50"></div>
                        <div 
                            style={{ transform: `translateY(${knobY}px)` }}
                            className="absolute w-20 h-24 bg-gradient-to-b from-gray-300 to-gray-600 rounded-t-2xl rounded-b-lg shadow-[0_15px_30px_rgba(0,0,0,0.8)] border-2 border-gray-400 flex flex-col items-center justify-start pt-2"
                        >
                            <div className="w-6 h-4 bg-red-500 rounded-sm mb-1 shadow-[inset_0_2px_4px_rgba(0,0,0,0.5)]"></div> 
                            <div className="w-12 h-1 bg-gray-800 rounded-full opacity-50 mt-2"></div>
                            <div className="w-12 h-1 bg-gray-800 rounded-full opacity-50 mt-1"></div>
                        </div>
                    </div>
                </div>
                
                <div className="ml-6 flex flex-col justify-between h-[300px] text-left text-xs opacity-70 border-l border-green-500/30 pl-4">
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
            <div className="absolute right-8 top-1/2 -translate-y-1/2 h-[500px] flex items-center gap-6 pointer-events-none z-20">
                <div className="flex flex-col items-center gap-12 pointer-events-auto h-full justify-center mt-10">
                    <div className="flex flex-col items-center relative group">
                        <span className="text-[10px] text-gray-400 mb-2 font-bold tracking-widest">GEAR (G)</span>
                        <div 
                            onClick={toggleGear}
                            className={`w-16 h-16 rounded-full border-4 cursor-pointer transition-all duration-200 flex items-center justify-center shadow-lg ${
                                isGearDown ? 'bg-orange-500 border-orange-200 shadow-[0_0_15px_orange]' : 'bg-gray-800 border-gray-600'
                            }`}
                        >
                            <span className={`font-black text-sm ${isGearDown ? 'text-white' : 'text-gray-500'}`}>DN</span>
                        </div>
                    </div>
                </div>

                <div className="flex flex-col items-center pointer-events-auto h-[250px] justify-between bg-gray-900/50 p-2 rounded-lg border border-gray-700 mt-10 relative">
                    <span className="text-[10px] text-green-400 font-bold mb-2">FLAPS (F/⇧F)</span>
                    <div className="flex flex-col gap-2 flex-1 justify-between">
                        {/* 修正：0档位在最上，3档位在最下 */}
                        {[0, 1, 2, 3].map(level => (
                            <button 
                                key={level}
                                onClick={() => handleFlapsSelect(level)}
                                className={`w-10 h-10 rounded text-sm font-bold border transition-colors ${
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

                <div className="relative flex flex-col items-center h-full ml-4">
                    <span className="text-green-400 font-bold mb-3 tracking-widest">THR (PgUp/Dn)</span>
                    <div 
                        className="relative w-16 flex-1 bg-gray-900 rounded-sm border-2 border-gray-600 pointer-events-auto shadow-[0_0_20px_rgba(0,0,0,0.8)] touch-none"
                        ref={throttleTrackRef}
                        onPointerDown={(e) => { e.target.setPointerCapture(e.pointerId); handleThrottleEvent(e, true); }}
                        onPointerMove={handleThrottleEvent}
                        onPointerUp={(e) => { handleThrottleEvent(e, false); try{e.target.releasePointerCapture(e.pointerId)}catch(e){} }}
                    >
                        <div className="absolute left-0 w-full h-full flex flex-col justify-between py-4 pointer-events-none opacity-50">
                            {[100,80,60,40,20,0].map(val => (
                                <div key={val} className="flex items-center text-[10px] text-white">
                                    <div className="w-3 h-px bg-white ml-1"></div>
                                    <span className="ml-1">{val}%</span>
                                </div>
                            ))}
                        </div>
                        <div 
                            style={{ top: `${throttleY}px` }}
                            className="absolute left-1/2 -translate-x-1/2 w-24 h-14 bg-gradient-to-r from-gray-600 via-gray-400 to-gray-600 border border-gray-300 rounded-sm shadow-2xl cursor-pointer flex items-center justify-end pr-2"
                        >
                            <div className="w-2 h-8 bg-red-500/80 rounded-sm"></div>
                        </div>
                    </div>
                </div>
            </div>

            {/* ================= 菜单 / 任务简报界面 ================= */}
            {gameStatus !== 'playing' && (
                <div className="absolute inset-0 bg-black/85 backdrop-blur-md flex flex-col justify-center items-center z-50">
                    {gameStatus === 'menu' ? (
                        <>
                            <h1 className="text-6xl font-black text-white mb-2 tracking-[0.2em] border-b-4 border-green-500 pb-4">AERO DYNAMICS</h1>
                            <p className="text-green-400 tracking-widest mb-10 text-xl">全真HOTAS模拟 & 跑道降落挑战</p>
                        </>
                    ) : (
                        <>
                            <h1 className="text-5xl font-black text-red-500 mb-2">MISSION FAILED</h1>
                            <p className="text-white text-xl mb-4 bg-red-900/50 px-6 py-2 border border-red-500">事故原因: {gameState.current?.failReason}</p>
                            <p className="text-green-400 text-lg mb-8">总任务积分: <span className="font-bold text-3xl text-white">{uiScore}</span></p>
                        </>
                    )}
                    
                    <button 
                        onClick={startGame}
                        className="px-12 py-4 bg-green-600/20 border-2 border-green-500 text-green-400 hover:bg-green-500 hover:text-white text-2xl font-bold tracking-widest transition-all duration-200"
                    >
                        {gameStatus === 'menu' ? 'REQUEST TAKEOFF' : 'RESTART SORTIE'}
                    </button>

                    <div className="mt-12 bg-gray-900/90 p-6 border border-gray-700 max-w-4xl text-left shadow-2xl relative overflow-hidden">
                        <div className="absolute top-0 left-0 w-1 h-full bg-green-500"></div>
                        <h3 className="text-gray-300 font-bold mb-4 tracking-wider">航线简报 (已接入键盘协议)</h3>
                        <div className="grid grid-cols-3 gap-6 text-sm">
                            <div className="space-y-2">
                                <p><strong className="text-green-400">跑道降落挑战：</strong> 每过9个柱子，第10关是平坦跑道！在跑道上安全触地奖励 <strong className="text-white">+10分</strong>。跑道很短，必须完成触地复飞(Touch & Go)。</p>
                                <p className="bg-gray-800 border border-gray-600 p-2 text-gray-300 text-xs">安全降落条件：<br/>1. 必须放下起落架<br/>2. 垂直率 (VY) &lt; 180<br/>3. 空速 (SPD) &lt; 320</p>
                            </div>
                            <div className="space-y-2">
                                <p><strong className="text-orange-400">减速防撞系统：</strong></p>
                                <ul className="list-disc pl-4 text-gray-400 space-y-1">
                                    <li>随着分数增加，柱子缝隙将**对数级缩小**。</li>
                                    <li>后期必须利用**起落架**与**襟翼**配合降低进场速度，否则绝对会撞毁。</li>
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
