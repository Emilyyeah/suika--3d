// const Matter = require('matter-js');

function mulberry32(a) {
	return function() {
		let t = a += 0x6D2B79F5;
		t = Math.imul(t ^ t >>> 15, t | 1);
		t ^= t + Math.imul(t ^ t >>> 7, t | 61);
		return ((t ^ t >>> 14) >>> 0) / 4294967296;
	}
}

const rand = mulberry32(Date.now());

const {
	Engine, Render, Runner, Composites, Common, MouseConstraint, Mouse,
	Composite, Bodies, Events, Body,
} = Matter;

const wallPad = 64;
const loseHeight = 84;
const previewBallHeight = 32;

// 越线多少毫秒后才判负（防止弹起瞬间误判）
const LOSE_GRACE_MS = 500;
let loseTimer = null;

// ── 粒子系统 ────────────────────────────────────────────────
const fxCanvas = document.getElementById('fx-canvas');
const fxCtx = fxCanvas.getContext('2d');
// 粒子池
const particles = [];

// 每帧更新粒子
function tickParticles() {
  fxCtx.clearRect(0, 0, fxCanvas.width, fxCanvas.height);
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.x  += p.vx;
    p.y  += p.vy;
    p.vy += 0.35;          // 重力
    p.vx *= 0.97;
    p.life -= 1;
    p.alpha = Math.max(0, p.life / p.maxLife);

    if (p.type === 'score') {
      // 飞字
      fxCtx.save();
      fxCtx.globalAlpha = p.alpha;
      fxCtx.font = `900 ${p.fontSize}px 'Azeret Mono', sans-serif`;
      fxCtx.fillStyle = p.color;
      fxCtx.strokeStyle = 'rgba(0,0,0,0.3)';
      fxCtx.lineWidth = 3;
      fxCtx.strokeText(p.text, p.x, p.y);
      fxCtx.fillText(p.text, p.x, p.y);
      fxCtx.restore();
    } else {
      // 圆形粒子
      fxCtx.save();
      fxCtx.globalAlpha = p.alpha;
      fxCtx.fillStyle = p.color;
      fxCtx.beginPath();
      fxCtx.arc(p.x, p.y, p.radius * p.alpha + 1, 0, Math.PI * 2);
      fxCtx.fill();
      fxCtx.restore();
    }

    if (p.life <= 0) particles.splice(i, 1);
  }
  requestAnimationFrame(tickParticles);
}
requestAnimationFrame(tickParticles);

// 爆出彩色粒子（合并特效）
const PARTICLE_COLORS = [
  '#ff5500','#ffaa00','#ffdd00','#66dd00','#00ccff','#cc44ff','#ff44aa','#ffffff'
];
function spawnParticles(x, y, r, count = 18) {
  for (let i = 0; i < count; i++) {
    const angle = rand() * Math.PI * 2;
    const speed = 2 + rand() * 5 * (r / 80);
    particles.push({
      type: 'dot',
      x, y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 2,
      radius: 3 + rand() * 5,
      color: PARTICLE_COLORS[Math.floor(rand() * PARTICLE_COLORS.length)],
      life: 28 + Math.floor(rand() * 20),
      maxLife: 48,
      alpha: 1,
    });
  }
}

// 分数飞字
function spawnScoreText(x, y, points, isCombo = false) {
  const colors = isCombo
    ? ['#ffdd00', '#ff8800', '#ff4400']
    : ['#ffffff', '#ffe080', '#ffcc00'];
  particles.push({
    type: 'score',
    x: x - 20,
    y: y,
    vx: (rand() - 0.5) * 1.5,
    vy: -3.5 - rand() * 2,
    text: isCombo ? `+${points} 连击！` : `+${points}`,
    fontSize: isCombo ? 28 : 22,
    color: colors[Math.floor(rand() * colors.length)],
    life: 55,
    maxLife: 55,
    alpha: 1,
  });
}

// ── 大合成特效（合成出 circle8/9/10 时触发）──────────────────
const BIG_MERGE_LEVELS = {
  // newSize（合成后产生的球等级） → 配置
  8:  { label: 'GOOD！',    color: '#ff9900', shadow: '#ff5500' },
  9:  { label: 'GREAT！',   color: '#ff44cc', shadow: '#aa00aa' },
  10: { label: 'AMAZING！', color: '#00ddff', shadow: '#0044ff' },
};
let bigMergeTimer = null;

function triggerBigMerge(sizeIndex, fruitImg) {
  const cfg = BIG_MERGE_LEVELS[sizeIndex];
  if (!cfg) return;

  if (bigMergeTimer) { clearTimeout(bigMergeTimer); bigMergeTimer = null; }

  // 每次实时获取 DOM，避免引用失效
  const overlay = document.getElementById('big-merge-overlay');
  const fruit   = document.getElementById('big-merge-fruit');
  const textEl  = document.getElementById('big-merge-text');

  // 1. 移除 show class + 强制清除内联 animation
  [overlay, fruit, textEl].forEach(el => {
    el.classList.remove('show');
    el.style.animation = 'none';
  });

  // 2. 一次 reflow 让浏览器确认重置
  void overlay.offsetWidth;

  // 3. 设置内容
  fruit.src        = fruitImg;
  textEl.textContent = cfg.label;
  textEl.style.color = cfg.color;
  textEl.style.textShadow =
    `0 0 20px ${cfg.shadow}, 0 0 40px ${cfg.color}, 3px 3px 0 rgba(0,0,0,0.3)`;

  // 4. 恢复 animation 并触发
  [overlay, fruit, textEl].forEach(el => {
    el.style.animation = '';
    el.classList.add('show');
  });

  // 粒子爆炸
  spawnParticles(Game.width / 2, Game.height / 2, 120, 60);

  bigMergeTimer = setTimeout(() => {
    const o = document.getElementById('big-merge-overlay');
    const f = document.getElementById('big-merge-fruit');
    const t = document.getElementById('big-merge-text');
    [o, f, t].forEach(el => el.classList.remove('show'));
    bigMergeTimer = null;
  }, 3500);
}

// ── 连击系统 ────────────────────────────────────────────────
// 连击定义：同一颗投下球引发的连锁合成次数（用 dropId 追踪归属）。
// 每次新投球时产生新 dropId，合成出的子球继承父球的 dropId。
// 相同 dropId 的合成才计连击，跨球不累积。
const COMBO_BONUS_BASE = 5; // 连击每层固定奖励分

// 每个 dropId 独立维护一个 comboCount
const comboMap = new Map(); // dropId -> count

let currentDropId = 0; // 单调递增，每次 addFruit +1

const comboBanner = document.getElementById('combo-banner');

function triggerCombo(dropId, x, y) {
  const count = (comboMap.get(dropId) || 0) + 1;
  comboMap.set(dropId, count);

  if (count >= 2) {
    const bonus = COMBO_BONUS_BASE * (count - 1);
    Game._comboBonus = (Game._comboBonus || 0) + bonus;

    comboBanner.textContent = `${count}× 连击！`;
    comboBanner.classList.remove('show');
    void comboBanner.offsetWidth;
    comboBanner.classList.add('show');

    spawnScoreText(x, y - 30, bonus, true);
    Game.calculateScore();
  }
}

// ── 投放冷却：等球首次碰撞才允许投下一颗 ──────────────────
// "落地" = 投出的球第一次碰到任何物体（地板/其他球）。
// 用 collisionStart 监听，避免轮询，最准确。
const MAX_WAIT_MS = 2500; // 兜底超时，防止球永远悬空
let dropBall = null;
let dropWatchTimer = null;

function watchDropBall(ball) {
  dropBall = ball;

  // 兜底定时器
  dropWatchTimer = setTimeout(() => {
    unlockNextDrop();
  }, MAX_WAIT_MS);
}

function unlockNextDrop() {
  if (Game.stateIndex !== GameStates.DROP) return;
  if (dropWatchTimer !== null) {
    clearTimeout(dropWatchTimer);
    dropWatchTimer = null;
  }
  dropBall = null;
  Composite.add(engine.world, Game.elements.previewBall);
  Game.stateIndex = GameStates.READY;
}

const friction = {
	friction: 0.006,
	frictionStatic: 0.006,
	frictionAir: 0,
	restitution: 0.1
};

const GameStates = {
	MENU: 0,
	READY: 1,
	DROP: 2,
	LOSE: 3,
};

const Game = {
	width: 640,
	height: 700,
	elements: {
		canvas: document.getElementById('game-canvas'),
		ui: document.getElementById('game-ui'),
		score: document.getElementById('top-score-value'),
		end: document.getElementById('game-end-container'),
		endTitle: document.getElementById('game-end-title'),
		nextFruitImg: document.getElementById('game-next-fruit'),
		compendiumItems: document.querySelectorAll('.compendium-item'),
		previewBall: null,
	},
	cache: { highscore: 0 },
	sounds: {
		click: new Audio('./assets/click.mp3'),
		pop0: new Audio('./assets/pop0.mp3'),
		pop1: new Audio('./assets/pop1.mp3'),
		pop2: new Audio('./assets/pop2.mp3'),
		pop3: new Audio('./assets/pop3.mp3'),
		pop4: new Audio('./assets/pop4.mp3'),
		pop5: new Audio('./assets/pop5.mp3'),
		pop6: new Audio('./assets/pop6.mp3'),
		pop7: new Audio('./assets/pop7.mp3'),
		pop8: new Audio('./assets/pop8.mp3'),
		pop9: new Audio('./assets/pop9.mp3'),
		pop10: new Audio('./assets/pop10.mp3'),
	},

	stateIndex: GameStates.MENU,

	score: 0,
	fruitsMerged: [],
	calculateScore: function () {
		const score = Game.fruitsMerged.reduce((total, count, sizeIndex) => {
			const value = Game.fruitSizes[sizeIndex].scoreValue * count;
			return total + value;
		}, 0) + (Game._comboBonus || 0);

		Game.score = score;
		Game.elements.score.innerText = Game.score;
	},

	// 图鉴：点亮已合成过的球（底部图鉴从 circle1 开始，索引需要 -1）
	unlockCompendium: function (sizeIndex) {
		const item = Game.elements.compendiumItems[sizeIndex - 1];
		if (item) item.classList.add('unlocked');
	},

	fruitSizes: [
		{ radius: 32,  scoreValue: 1,  img: './assets/img/circle0.png'  },
		{ radius: 38,  scoreValue: 3,  img: './assets/img/circle1.png'  },
		{ radius: 45,  scoreValue: 6,  img: './assets/img/circle2.png'  },
		{ radius: 53,  scoreValue: 10, img: './assets/img/circle3.png'  },
		{ radius: 62,  scoreValue: 15, img: './assets/img/circle4.png'  },
		{ radius: 73,  scoreValue: 21, img: './assets/img/circle5.png'  },
		{ radius: 86,  scoreValue: 28, img: './assets/img/circle6.png'  },
		{ radius: 102, scoreValue: 36, img: './assets/img/circle7.png'  },
		{ radius: 120, scoreValue: 45, img: './assets/img/circle8.png'  },
		{ radius: 142, scoreValue: 55, img: './assets/img/circle9.png'  },
		{ radius: 168, scoreValue: 66, img: './assets/img/circle10.png' },
	],
	currentFruitSize: 1,
	nextFruitSize: 1,
	setNextFruitSize: function () {
		// 随机掉落 circle1~5
		Game.nextFruitSize = 1 + Math.floor(rand() * 5);
		Game.elements.nextFruitImg.src = `./assets/img/circle${Game.nextFruitSize}.png`;
	},

	loadHighscore: function () {
		const gameCache = localStorage.getItem('suika-game-cache');
		if (gameCache !== null) {
			Game.cache = JSON.parse(gameCache);
		}
	},
	saveHighscore: function () {
		Game.calculateScore();
		if (Game.score < Game.cache.highscore) return;

		Game.cache.highscore = Game.score;
		Game.elements.endTitle.innerText = '新纪录！';

		localStorage.setItem('suika-game-cache', JSON.stringify(Game.cache));
	},

	initGame: function () {
		Render.run(render);
		Runner.run(runner, engine);

		Composite.add(engine.world, menuStatics);

		Game.loadHighscore();
		Game.elements.ui.style.display = 'none';
		Game.fruitsMerged = Array.apply(null, Array(Game.fruitSizes.length)).map(() => 0);

		const menuMouseDown = function () {
			if (mouseConstraint.body === null || mouseConstraint.body?.label !== 'btn-start') {
				return;
			}

			Events.off(mouseConstraint, 'mousedown', menuMouseDown);
			Game.startGame();
		}

		Events.on(mouseConstraint, 'mousedown', menuMouseDown);
	},

	startGame: function () {
		Game.sounds.click.play();

		Composite.remove(engine.world, menuStatics);
		Composite.add(engine.world, gameStatics);

		Game.score = 0;
		Game._comboBonus = 0;
		Game.calculateScore();
		Game.elements.endTitle.innerText = '游戏结束！';
		Game.elements.ui.style.display = 'block';
		Game.elements.end.style.display = 'none';
		Game.elements.previewBall = Game.generateFruitBody(Game.width / 2, previewBallHeight, 1, { isStatic: true });
		Composite.add(engine.world, Game.elements.previewBall);
		Game.unlockCompendium(1);

		setTimeout(() => {
			Game.stateIndex = GameStates.READY;
		}, 250);

		Events.on(mouseConstraint, 'mouseup', function (e) {
			Game.addFruit(e.mouse.position.x);
		});

		Events.on(mouseConstraint, 'mousemove', function (e) {
			if (Game.stateIndex !== GameStates.READY) return;
			if (Game.elements.previewBall === null) return;

			const r = Game.fruitSizes[Game.currentFruitSize].radius;
			const clampedX = Math.max(r, Math.min(Game.width - r, e.mouse.position.x));
			Body.setPosition(Game.elements.previewBall, {
				x: clampedX,
				y: previewBallHeight,
			});
		});

		Events.on(engine, 'collisionStart', function (e) {
			// 已结束则忽略所有碰撞
			if (Game.stateIndex === GameStates.LOSE) return;

			// ── 检测投出球是否首次碰撞（落地）→ 解锁下一次投球 ──
			if (dropBall !== null && Game.stateIndex === GameStates.DROP) {
				for (const pair of e.pairs) {
					if (pair.bodyA === dropBall || pair.bodyB === dropBall) {
						unlockNextDrop();
						break;
					}
				}
			}

			// 本帧按 dropId 分组，每个 dropId 最多触发一次连击计数
			const mergedDropIds = new Set();
			let firstMergeX = 0, firstMergeY = 0, firstMerged = false;

			for (let i = 0; i < e.pairs.length; i++) {
				const { bodyA, bodyB } = e.pairs[i];

				if (bodyA.isStatic || bodyB.isStatic) continue;
				if (bodyA.sizeIndex !== bodyB.sizeIndex) continue;
				if (bodyA.popped || bodyB.popped) continue;

				let newSize = bodyA.sizeIndex + 1;
				if (bodyA.circleRadius >= Game.fruitSizes[Game.fruitSizes.length - 1].radius) {
					newSize = 1;
				}

				const midPosX = (bodyA.position.x + bodyB.position.x) / 2;
				const midPosY = (bodyA.position.y + bodyB.position.y) / 2;

				bodyA.popped = true;
				bodyB.popped = true;

				const sound = Game.sounds[`pop${bodyA.sizeIndex}`];
				sound.currentTime = 0;
				sound.play();
				Composite.remove(engine.world, [bodyA, bodyB]);

				// 合成球继承父球的 dropId（优先用有 dropId 的那个）
				const inheritedDropId = bodyA.dropId ?? bodyB.dropId ?? 0;
				const newFruit = Game.generateFruitBody(midPosX, midPosY, newSize);
				newFruit.dropId = inheritedDropId;
				Composite.add(engine.world, newFruit);

				Game.addPop(midPosX, midPosY, bodyA.circleRadius);

				const particleCount = 12 + bodyA.sizeIndex * 3;
				spawnParticles(midPosX, midPosY, bodyA.circleRadius, particleCount);

				const mergePoints = Game.fruitSizes[bodyA.sizeIndex].scoreValue;
				spawnScoreText(midPosX, midPosY, mergePoints);

				// 大合成特效：合成出 circle8→GOOD，circle9→GREAT，circle10→AMAZING
				triggerBigMerge(newSize, Game.fruitSizes[newSize].img);

				Game.fruitsMerged[bodyA.sizeIndex] += 1;
				Game.calculateScore();
				Game.unlockCompendium(bodyA.sizeIndex);
				Game.unlockCompendium(newSize);

				// 记录每个 dropId 本帧首次合成位置
				if (inheritedDropId && !mergedDropIds.has(inheritedDropId)) {
					mergedDropIds.add(inheritedDropId);
					if (!firstMerged) {
						firstMergeX = midPosX;
						firstMergeY = midPosY;
						firstMerged = true;
					}
				}
			}

			// 每个 dropId 各自触发一次连击计数
			for (const dropId of mergedDropIds) {
				triggerCombo(dropId, firstMergeX, firstMergeY);
			}
		});

		// ── 每物理帧扫描所有球，只要有球顶部持续在死亡线以上就判负 ──
		// collisionStart 只在新碰撞时触发，球静止堆在线上不会再触发，
		// 必须用 afterUpdate 做持续检测。
		Events.on(engine, 'afterUpdate', function () {
			if (Game.stateIndex === GameStates.LOSE) return;

			const bodies = Composite.allBodies(engine.world);
			let overLine = false;

			for (const body of bodies) {
				if (body.isStatic) continue;
				// 刚投放的球（出生 < 1000ms）从顶部落下，跳过避免误判
				if (body.birthTime && Date.now() - body.birthTime < 1000) continue;
				// 球的顶部超过死亡线（注意：y 向下，顶部 = y - radius）
				if (body.position.y - body.circleRadius < loseHeight) {
					overLine = true;
					break;
				}
			}

			if (overLine) {
				if (loseTimer === null) {
					// 首次越线：启动 500ms 容错计时（防止弹起瞬间误判）
					loseTimer = setTimeout(() => {
						if (Game.stateIndex !== GameStates.LOSE) {
							Game.loseGame();
						}
					}, LOSE_GRACE_MS);
				}
			} else {
				// 这帧没有任何球越线，取消计时器
				if (loseTimer !== null) {
					clearTimeout(loseTimer);
					loseTimer = null;
				}
			}
		});
	},

	addPop: function (x, y, r) {
		const circle = Bodies.circle(x, y, r, {
			isStatic: true,
			collisionFilter: { mask: 0x0040 },
			angle: rand() * (Math.PI * 2),
			render: {
				sprite: {
					texture: './assets/img/pop.png',
					xScale: r / 384,
					yScale: r / 384,
				}
			},
		});

		Composite.add(engine.world, circle);
		setTimeout(() => {
			Composite.remove(engine.world, circle);
		}, 100);
	},

	loseGame: function () {
		if (loseTimer !== null) {
			clearTimeout(loseTimer);
			loseTimer = null;
		}
		Game.stateIndex = GameStates.LOSE;
		Game.elements.end.style.display = 'flex';
		runner.enabled = false;
		Game.saveHighscore();
	},

	generateFruitBody: function (x, y, sizeIndex, extraConfig = {}) {
		const size = Game.fruitSizes[sizeIndex];
		const circle = Bodies.circle(x, y, size.radius, {
			...friction,
			...extraConfig,
			render: { sprite: { texture: size.img, xScale: size.radius / 512, yScale: size.radius / 512 } },
		});
		circle.sizeIndex = sizeIndex;
		circle.popped = false;
		// birthTime 不在这里设置，由调用方按需打标（只有从顶部投下的球才需要）

		return circle;
	},

	addFruit: function (x) {
		if (Game.stateIndex !== GameStates.READY) return;

		Game.sounds.click.play();

		// 投放位置也做边界裁剪，防止球落在墙外
		const r = Game.fruitSizes[Game.currentFruitSize].radius;
		const clampedX = Math.max(r, Math.min(Game.width - r, x));

		Game.stateIndex = GameStates.DROP;
		const latestFruit = Game.generateFruitBody(clampedX, previewBallHeight, Game.currentFruitSize);
		latestFruit.birthTime = Date.now(); // 只有从顶部投下的球才有出生保护
		latestFruit.dropId = ++currentDropId; // 归属批次，用于连击追踪
		Composite.add(engine.world, latestFruit);

		// 投放时点亮图鉴（首次出现即解锁）
		Game.unlockCompendium(Game.currentFruitSize);

		Game.currentFruitSize = Game.nextFruitSize;
		Game.setNextFruitSize();
		Game.calculateScore();

		Composite.remove(engine.world, Game.elements.previewBall);
		Game.elements.previewBall = Game.generateFruitBody(render.mouse.position.x, previewBallHeight, Game.currentFruitSize, {
			isStatic: true,
			collisionFilter: { mask: 0x0040 }
		});

		// 速度感知冷却：球落稳后才恢复 READY，最长等待 MAX_WAIT_MS
		if (dropWatchTimer !== null) clearTimeout(dropWatchTimer);
		watchDropBall(latestFruit);
	}
}

const engine = Engine.create();
const runner = Runner.create();
const render = Render.create({
	element: Game.elements.canvas,
	engine,
	options: {
		width: Game.width,
		height: Game.height,
		wireframes: false,
		background: '#ffdcae'
	}
});

const menuStatics = [
	Bodies.rectangle(Game.width / 2, Game.height * 0.4, 512, 512, {
		isStatic: true,
		render: { sprite: { texture: './assets/img/bg-menu.png' } },
	}),

	// Add each fruit in a circle
	...Array.apply(null, Array(Game.fruitSizes.length)).map((_, index) => {
		const x = (Game.width / 2) + 192 * Math.cos((Math.PI * 2 * index)/12);
		const y = (Game.height * 0.4) + 192 * Math.sin((Math.PI * 2 * index)/12);
		const r = 64;

		return Bodies.circle(x, y, r, {
			isStatic: true,
			render: {
				sprite: {
					texture: `./assets/img/circle${index}.png`,
					xScale: r / 1024,
					yScale: r / 1024,
				},
			},
		});
	}),

	Bodies.rectangle(Game.width / 2, Game.height * 0.75, 512, 96, {
		isStatic: true,
		label: 'btn-start',
		render: { sprite: { texture: './assets/img/btn-start.png' } },
	}),
];

const wallProps = {
	isStatic: true,
	render: { fillStyle: '#FFEEDB' },
	...friction,
};

const gameStatics = [
	// Left
	Bodies.rectangle(-(wallPad / 2), Game.height / 2, wallPad, Game.height, wallProps),

	// Right
	Bodies.rectangle(Game.width + (wallPad / 2), Game.height / 2, wallPad, Game.height, wallProps),

	// Bottom
	Bodies.rectangle(Game.width / 2, Game.height + (wallPad / 2), Game.width, wallPad, wallProps),
];

// add mouse control
const mouse = Mouse.create(render.canvas);
const mouseConstraint = MouseConstraint.create(engine, {
	mouse: mouse,
	constraint: {
		stiffness: 0.2,
		render: {
			visible: false,
		},
	},
});
render.mouse = mouse;

Game.initGame();

const resizeCanvas = () => {
	// 可用区域：#game-canvas-wrap 的实际尺寸
	const wrap = document.getElementById('game-canvas-wrap');
	const availW = wrap.clientWidth;
	const availH = wrap.clientHeight;

	// 按游戏宽高比 640:700 在可用区内最大化填充
	const gameRatio = Game.width / Game.height; // 640/700
	let canvasW, canvasH;

	if (availW / availH > gameRatio) {
		// 高度是瓶颈
		canvasH = availH;
		canvasW = canvasH * gameRatio;
	} else {
		// 宽度是瓶颈
		canvasW = availW;
		canvasH = canvasW / gameRatio;
	}

	const scaleUI = canvasW / Game.width;

	render.canvas.style.width  = `${canvasW}px`;
	render.canvas.style.height = `${canvasH}px`;

	// #game-canvas 显式设尺寸，确保绝对定位子元素（特效overlay等）能铺满
	Game.elements.canvas.style.width  = `${canvasW}px`;
	Game.elements.canvas.style.height = `${canvasH}px`;

	// fx-canvas 跟随逻辑尺寸，transform 同步缩放
	fxCanvas.width  = Game.width;
	fxCanvas.height = Game.height;
	fxCanvas.style.width  = `${canvasW}px`;
	fxCanvas.style.height = `${canvasH}px`;

	Game.elements.ui.style.width  = `${Game.width}px`;
	Game.elements.ui.style.height = `${Game.height}px`;
	Game.elements.ui.style.transform = `scale(${scaleUI})`;

	// combo-banner 跟随缩放
	comboBanner.style.transform = `translateX(-50%) scale(${scaleUI})`;
	comboBanner.style.transformOrigin = 'center top';
};

// 防抖：窗口 resize 结束 100ms 后才执行，避免频繁触发
let resizeTimer = null;
window.addEventListener('resize', () => {
	clearTimeout(resizeTimer);
	resizeTimer = setTimeout(resizeCanvas, 100);
});

// 初始化时立即执行一次
resizeCanvas();

// ── 触屏支持 ──────────────────────────────────────────────
// Matter.js Mouse 模块对触屏支持不稳定，手动补充 touch 事件。
// 将触摸坐标换算成画布内的逻辑坐标，再映射到对应操作。

function touchToCanvasX(touch) {
	const rect = render.canvas.getBoundingClientRect();
	// clientWidth 是 CSS 像素尺寸，Game.width 是逻辑坐标宽度
	const scaleX = Game.width / rect.width;
	return (touch.clientX - rect.left) * scaleX;
}

render.canvas.addEventListener('touchmove', (e) => {
	e.preventDefault();
	if (Game.stateIndex !== GameStates.READY) return;
	if (Game.elements.previewBall === null) return;

	const x = touchToCanvasX(e.touches[0]);
	const r = Game.fruitSizes[Game.currentFruitSize].radius;
	const clampedX = Math.max(r, Math.min(Game.width - r, x));
	Body.setPosition(Game.elements.previewBall, { x: clampedX, y: previewBallHeight });
}, { passive: false });

render.canvas.addEventListener('touchend', (e) => {
	e.preventDefault();
	// 用最后离开的触点坐标投球
	const touch = e.changedTouches[0];
	const x = touchToCanvasX(touch);

	// 菜单阶段：模拟点击 btn-start（Matter.js 的菜单交互保留鼠标）
	// 游戏阶段：直接投球
	if (Game.stateIndex === GameStates.READY || Game.stateIndex === GameStates.DROP) {
		Game.addFruit(x);
	}
}, { passive: false });
