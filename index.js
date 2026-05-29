// ══════════════════════════════════════════════════════════════════
// ── API 对接模块 ─────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

const API_URL = 'YOUR_API_URL';
const SIGN_KEY = 'YOUR_SIGN_KEY';

// ── 解析 URL 参数（小程序跳转时携带） ──
function getUrlParams() {
	const params = {};
	const search = window.location.search.substring(1);
	if (!search) return params;
	search.split('&').forEach(function (pair) {
		const idx = pair.indexOf('=');
		if (idx > 0) {
			const key = decodeURIComponent(pair.substring(0, idx));
			const val = decodeURIComponent(pair.substring(idx + 1));
			params[key] = val;
		}
	});
	return params;
}

const urlParams = getUrlParams();

// 从 URL 读取小程序传入的固定参数
const LaunchParams = {
	act_config_id: urlParams.act_config_id || '',
	token:         urlParams.token || '',
	pid:           parseInt(urlParams.pid) || 0,
	gid:           parseInt(urlParams.gid) || 0,
	dsid:          urlParams.dsid || '',
	drid:          urlParams.drid || '',
	dsname:        urlParams.dsname || '',
	drname:        urlParams.drname || '',
	challenge_count:   'challenge_count' in urlParams ? parseInt(urlParams.challenge_count) : 3,
};

// ── 唯一业务流水号生成 ──
// 格式: GAME + YYYYMMDD + HHMMSSmmm + 5位随机数
let _bizSeq = 0;
function generateBizNo() {
	const now = new Date();
	const pad2 = (n) => String(n).padStart(2, '0');
	const pad3 = (n) => String(n).padStart(3, '0');
	const date = '' + now.getFullYear() + pad2(now.getMonth() + 1) + pad2(now.getDate());
	const time = pad2(now.getHours()) + pad2(now.getMinutes()) + pad2(now.getSeconds()) + pad3(now.getMilliseconds());
	const seq   = String(++_bizSeq).padStart(3, '0');
	const rnd   = String(Math.floor(Math.random() * 100)).padStart(2, '0');
	return 'GAME' + date + time + seq + rnd;
}

// ── 签名：字典序拼接 + 末尾追加 key + MD5 ──
function makeSign(params) {
	const keys = Object.keys(params).filter(k => k !== 'sign').sort();
	let raw = '';
	for (const k of keys) {
		const v = params[k] === null || params[k] === undefined ? '' : params[k];
		raw += k + '=' + v;
	}
	raw += SIGN_KEY;
	return md5(raw); // blueimp-md5 全局函数，返回小写
}

// ── 结算防重入：每局递增，回调中校验是否仍是当前局 ──
let _settleId = 0;

// ── 调用结算接口 ──
async function callFinishChallenge(score) {
	const timestamp = Math.floor(Date.now() / 1000);
	const biz_no = generateBizNo();

	const params = {
		act_config_id:             LaunchParams.act_config_id,
		token:                     LaunchParams.token,
		pid:                       LaunchParams.pid,
		gid:                       LaunchParams.gid,
		dsid:                      LaunchParams.dsid,
		drid:                      LaunchParams.drid,
		dsname:                    LaunchParams.dsname,
		drname:                    LaunchParams.drname,
		biz_no:                    biz_no,
		score:                     score,
		timestamp:                 timestamp,
		version:                   'v1',
	};

	params.sign = makeSign(params);

	console.log('[API] callFinishChallenge params:', params);

	const resp = await fetch(API_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(params),
	});

	if (!resp.ok) {
		throw new Error('HTTP ' + resp.status);
	}

	const json = await resp.json();
	console.log('[API] callFinishChallenge response:', json);

	if (json.state !== 0) {
		throw new Error(json.message || 'API error state=' + json.state);
	}

	return json.data;
}

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
const wallInset = 18; // sprite比碰撞体大21%，墙内收防止视觉溢出
const loseHeight = 174;
const previewBallHeight = 100;

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
  '#C8A050','#D4B060','#B08830','#6B80C0','#5B6EB0','#8090D0','#ffffff','#ffe8a0'
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

// DOM 飞字：从画布内逻辑坐标飞向总分区（顶栏）
// x/y 是 Matter.js 逻辑坐标（640×700空间）
function spawnDomScoreText(logicX, logicY, text, color) {
  const canvasEl = document.getElementById('game-canvas');
  const rect = canvasEl.getBoundingClientRect();
  // 将逻辑坐标换算成画布 CSS 像素
  const scaleX = rect.width  / Game.width;
  const scaleY = rect.height / Game.height;
  const startX = rect.left + logicX * scaleX;
  const startY = rect.top  + logicY * scaleY;

  // 目标：顶部总分元素中心
  const scoreEl = document.getElementById('top-score-value');
  const scoreRect = scoreEl.getBoundingClientRect();
  const endX = scoreRect.left + scoreRect.width  / 2;
  const endY = scoreRect.top  + scoreRect.height / 2;

  const el = document.createElement('div');
  el.textContent = text;
  el.style.cssText = [
    'position:fixed',
    `left:${startX}px`,
    `top:${startY}px`,
    `color:${color}`,
    'font:900 32px "Azeret Mono",sans-serif',
    'text-shadow:0 0 8px rgba(0,0,0,0.5)',
    'pointer-events:none',
    'z-index:9999',
    'transform:translate(-50%,-50%)',
    'transition:left 1.2s cubic-bezier(.2,.8,.4,1),top 1.2s cubic-bezier(.2,.8,.4,1)',
    'will-change:left,top,opacity',
  ].join(';');
  document.body.appendChild(el);

  // 第一段：飞向总分（1.2s，全程不透明）
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      el.style.left = `${endX}px`;
      el.style.top  = `${endY}px`;
    });
  });

  // 第二段：到达后停留 0.4s 再淡出
  setTimeout(() => {
    el.style.transition = 'opacity 0.4s ease';
    el.style.opacity    = '0';
  }, 1200 + 400);

  setTimeout(() => el.remove(), 1200 + 400 + 450);
}

// 大合成专属飞字：居中弹出大字，停留 1s 后飞向总分
function spawnBigMergeText(points, label) {
  const canvasEl = document.getElementById('game-canvas');
  const rect = canvasEl.getBoundingClientRect();
  const centerX = rect.left + rect.width  / 2;
  const centerY = rect.top  + rect.height * 0.45;

  const scoreEl = document.getElementById('top-score-value');
  const scoreRect = scoreEl.getBoundingClientRect();
  const endX = scoreRect.left + scoreRect.width  / 2;
  const endY = scoreRect.top  + scoreRect.height / 2;

  const el = document.createElement('div');
  el.textContent = `+${points}`;
  el.style.cssText = [
    'position:fixed',
    `left:${centerX}px`,
    `top:${centerY}px`,
    'color:#ffd700',
    'font:900 72px "Azeret Mono",sans-serif',
    'text-shadow:0 0 20px #ff8800,0 0 40px #ff4400,3px 3px 0 rgba(0,0,0,0.4)',
    'pointer-events:none',
    'z-index:9999',
    'transform:translate(-50%,-50%) scale(0.4)',
    'opacity:0',
    'transition:transform 0.3s cubic-bezier(.2,1.4,.4,1),opacity 0.25s ease',
    'will-change:transform,opacity,left,top',
  ].join(';');
  document.body.appendChild(el);

  // 第一段：弹出放大
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      el.style.transform = 'translate(-50%,-50%) scale(1)';
      el.style.opacity   = '1';
    });
  });

  // 第二段：停留 1s 后缩小飞向总分
  setTimeout(() => {
    el.style.transition = [
      'left 1.0s cubic-bezier(.2,.8,.4,1)',
      'top 1.0s cubic-bezier(.2,.8,.4,1)',
      'transform 1.0s ease',
      'opacity 0.4s ease 0.6s',
    ].join(',');
    el.style.left      = `${endX}px`;
    el.style.top       = `${endY}px`;
    el.style.transform = 'translate(-50%,-50%) scale(0.5)';
    el.style.opacity   = '0';
  }, 1000);

  setTimeout(() => el.remove(), 1000 + 1100);
}

// ── 大合成特效（合成出 circle8/9/10 时触发）──────────────────
const BIG_MERGE_LEVELS = {
  8:  { label: 'GOOD',    color: '#D4B060', shadow: '#B08830', bonus: 50  },
  9:  { label: 'GREAT',   color: '#8090D0', shadow: '#4A5A9A', bonus: 100 },
  10: { label: 'AMAZING', color: '#ffe080', shadow: '#C8A050', bonus: 300 },
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

  // 额外加分由调用处处理，这里只做特效展示

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

// ── 连击系统（时间窗口制）────────────────────────────────────
// 定义：任意合并发生后 2s 内再次发生合并即为连击，超时重置。
// 从 2× 开始显示横幅，最高封顶 10×，10× 后不再加分。
const COMBO_BONUS_BASE = 1; // 连击每层固定奖励分
const COMBO_WINDOW_MS  = 1200; // 时间窗口
const COMBO_MAX        = 10;   // 连击封顶
let comboCount    = 0;       // 当前连击次数
let comboTimer    = null;    // 窗口定时器

const comboBanner = document.getElementById('combo-banner');

function triggerCombo(x, y) {
  // 已封顶：不刷新窗口，让定时器自然到期重置，本次合并静默忽略
  if (comboCount >= COMBO_MAX) return;

  // 延续窗口
  if (comboTimer !== null) {
    clearTimeout(comboTimer);
    comboTimer = null;
  }

  comboCount += 1;

  if (comboCount >= 2) {
    const isCapped = comboCount >= COMBO_MAX;
    const bonus    = isCapped ? 0 : COMBO_BONUS_BASE * (comboCount - 1);

    if (bonus > 0) {
      Game._comboBonus = (Game._comboBonus || 0) + bonus;
      spawnDomScoreText(x, y, `+${bonus}`, '#ffdd00');
      Game.calculateScore();
    }

    comboBanner.textContent = isCapped ? `${COMBO_MAX}× MAX！` : `${comboCount}× 连击！`;
    comboBanner.classList.remove('show');
    void comboBanner.offsetWidth;
    comboBanner.classList.add('show');
  }

  // 窗口到期则重置，开启新一轮
  comboTimer = setTimeout(() => {
    comboCount = 0;
    comboTimer = null;
  }, COMBO_WINDOW_MS);
}

function resetCombo() {
  if (comboTimer !== null) { clearTimeout(comboTimer); comboTimer = null; }
  comboCount = 0;
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

// ── 挑战次数（从 URL 参数读取）──────────────────────────────────
let challengeCount = LaunchParams.challenge_count;

function initChallengeUI() {
	const numEl    = document.getElementById('challenge-count-num');
	const disabled = document.getElementById('btn-start-disabled');
	const overlay  = document.getElementById('menu-overlay');

	numEl.textContent = challengeCount;

	if (challengeCount <= 0) {
		// 次数为0：显示置灰按钮，遮住 Matter.js 的开始按钮
		disabled.style.display = 'flex';
	} else {
		disabled.style.display = 'none';
	}
}

function onBtnBack() {
	// 菜单页（还没开始游戏）直接返回
	if (Game.stateIndex === GameStates.MENU || Game.stateIndex === GameStates.LOSE) {
		doBack();
		return;
	}
	// 游戏进行中：暂停并弹确认框
	runner.enabled = false;
	document.getElementById('quit-modal').classList.add('show');
}

function doBack() {
	console.log('[Challenge] 返回小程序');
	if (window.wx && wx.miniProgram) {
		wx.miniProgram.navigateBack();
	} else {
		// 非小程序环境（调试用）：尝试关闭窗口或回退历史
		window.history.back();
	}
}

document.getElementById('btn-back').addEventListener('click', onBtnBack);

document.getElementById('quit-cancel').addEventListener('click', function () {
	document.getElementById('quit-modal').classList.remove('show');
	if (Game.stateIndex !== GameStates.LOSE) {
		runner.enabled = true;
	}
});

document.getElementById('quit-confirm').addEventListener('click', function () {
	// 确认退出：以当前得分结算，走正常结束流程
	document.getElementById('quit-modal').classList.remove('show');
	Game.loseGame();
});

// 结束弹窗里的返回按钮
document.getElementById('game-end-back-link').addEventListener('click', function(e) {
	e.preventDefault();
	doBack();
});
document.getElementById('game-end-back-link2').addEventListener('click', function(e) {
	e.preventDefault();
	doBack();
});
document.getElementById('game-end-back-link3').addEventListener('click', function(e) {
	e.preventDefault();
	doBack();
});
// 结算失败弹窗的"再来一局"按钮：复用已有的再来一局逻辑
document.getElementById('game-end-retry-link').addEventListener('click', function(e) {
	e.preventDefault();
	document.getElementById('game-end-link').click();
});

const GameStates = {
	MENU: 0,
	READY: 1,
	DROP: 2,
	LOSE: 3,
};

const Game = {
	width: 640,
	height: 800,
	elements: {
		canvas: document.getElementById('game-canvas'),
		ui: document.getElementById('game-ui'),
		score: document.getElementById('top-score-value'),
		end: document.getElementById('game-end-container'),
		endScore: document.getElementById('game-end-score-value'),
		endLink: document.getElementById('game-end-link'),
		endHasChance: document.getElementById('game-end-has-chance'),
		endNoChance: document.getElementById('game-end-no-chance'),
		menuOverlay: document.getElementById('menu-overlay'),
		nextFruitImg: document.getElementById('game-next-fruit'),
		compendiumItems: document.querySelectorAll('.compendium-item'),
		previewBall: null,
	},
	cache: {},
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
		}, 0) + (Game._comboBonus || 0) + (Game._bigMergeBonus || 0);

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
		// 随机掉落 circle1~4
		Game.nextFruitSize = 1 + Math.floor(rand() * 4);
		Game.elements.nextFruitImg.src = `./assets/img/circle${Game.nextFruitSize}.png`;
	},

	initGame: function () {
		Render.run(render);
		Runner.run(runner, engine);


		Game.elements.ui.style.display = 'none';
		Game.fruitsMerged = Array.apply(null, Array(Game.fruitSizes.length)).map(() => 0);

		// 初始化挑战次数 UI
		initChallengeUI();

		// 开始按钮交互（DOM层）
		const btnStartHtml = document.getElementById('btn-start-html');
		btnStartHtml.addEventListener('click', function onStartClick() {
			if (challengeCount <= 0) return;
			btnStartHtml.removeEventListener('click', onStartClick);
			Game.startGame();
		});
	},

	startGame: function () {
		Game.sounds.click.play();

		// 挑战次数由结算接口返回值更新，此处不再客户端扣减
		// challengeCount 会在 loseGame → callFinishChallenge 回调中更新

		// 隐藏菜单覆盖层和 HTML 层标题/按钮
		Game.elements.menuOverlay.style.display = 'none';
		document.getElementById('menu-title').style.display = 'none';
		document.getElementById('btn-start-html').classList.add('hidden');
		document.getElementById('menu-bg').classList.add('hidden');
		render.canvas.style.background = "url(./assets/img/游戏逻辑区.png) bottom/100% auto no-repeat";

		Composite.add(engine.world, gameStatics);

		Game.score = 0;
		Game._comboBonus = 0;
		Game._bigMergeBonus = 0;
		resetCombo();
		Game.calculateScore();
		Game.elements.ui.style.display = 'block';
		Game.elements.end.classList.remove('show');
		Game.elements.previewBall = Game.generateFruitBody(Game.width / 2, previewBallHeight, 1, { isStatic: true });
		Composite.add(engine.world, Game.elements.previewBall);
		Game.unlockCompendium(1);
		Game.setNextFruitSize();

		setTimeout(() => {
			Game.stateIndex = GameStates.READY;
		}, 250);

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
		runner.enabled = false;

		// 弹窗：先显示本轮得分 + "结算中..."
		Game.elements.endScore.textContent = Game.score;

		const settlingEl = document.getElementById('game-end-settling');
		const totalWrap  = document.getElementById('game-end-total-wrap');
		const totalValue = document.getElementById('game-end-total-value');

		settlingEl.style.display = 'block';
		settlingEl.textContent   = '结算中...';
		totalWrap.style.display  = 'none';
		Game.elements.endHasChance.style.display = 'none';
		Game.elements.endNoChance.style.display  = 'none';
		document.getElementById('game-end-error').style.display = 'none';
		Game.elements.end.classList.add('show');

		// 调用结算接口
		const thisSettle = ++_settleId;
		callFinishChallenge(Game.score)
			.then(function (data) {
				// 防重入：如果已经开始新一局，丢弃过期回调
				if (thisSettle !== _settleId) return;

				// 用接口返回值更新 UI
				challengeCount = data.remain_challenge_count;

				settlingEl.style.display = 'none';
				totalWrap.style.display = 'none';

				// 刷新顶栏剩余次数
				initChallengeUI();

				// 根据剩余次数决定按钮
				if (challengeCount > 0) {
					Game.elements.endHasChance.style.display = 'flex';
					Game.elements.endNoChance.style.display  = 'none';
				} else {
					Game.elements.endHasChance.style.display = 'none';
					Game.elements.endNoChance.style.display  = 'block';
				}
			})
			.catch(function (err) {
				if (thisSettle !== _settleId) return;
				console.error('[API] 结算失败:', err);
				settlingEl.textContent = '结算失败，请返回重试';

				// 结算失败：只显示返回按钮，不显示"次数已用完"
				Game.elements.endHasChance.style.display = 'none';
				Game.elements.endNoChance.style.display  = 'none';
				document.getElementById('game-end-error').style.display = 'block';
			});
	},

	generateFruitBody: function (x, y, sizeIndex, extraConfig = {}) {
		const size = Game.fruitSizes[sizeIndex];
		const circle = Bodies.circle(x, y, size.radius, {
			...friction,
			...extraConfig,
			render: { sprite: { texture: size.img, xScale: size.radius / 422, yScale: size.radius / 422 } },
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
		const clampedX = Math.max(wallInset + r, Math.min(Game.width - wallInset - r, x));

		Game.stateIndex = GameStates.DROP;
		const latestFruit = Game.generateFruitBody(clampedX, previewBallHeight, Game.currentFruitSize);
		latestFruit.birthTime = Date.now(); // 只有从顶部投下的球才有出生保护
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
		background: 'transparent'
	}
});


const wallProps = {
	isStatic: true,
	render: { fillStyle: 'transparent', strokeStyle: 'transparent', lineWidth: 0 },
	...friction,
};

const gameStatics = [
	// Left
	Bodies.rectangle(wallInset - (wallPad / 2), Game.height / 2, wallPad, Game.height, wallProps),

	// Right
	Bodies.rectangle(Game.width - wallInset + (wallPad / 2), Game.height / 2, wallPad, Game.height, wallProps),

	// Bottom
	Bodies.rectangle(Game.width / 2, 790 + (wallPad / 2), Game.width, wallPad, wallProps),
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

// ── 透明背景：每帧手动清屏，避免帧叠加 ──
Events.on(render, 'beforeRender', function() {
	const ctx = render.context;
	ctx.clearRect(0, 0, render.options.width, render.options.height);
});

Game.initGame();

// ── 全局事件注册（只注册一次，用状态守卫控制行为）──────────────
Events.on(mouseConstraint, 'mouseup', function (e) {
	Game.addFruit(e.mouse.position.x);
});

Events.on(mouseConstraint, 'mousemove', function (e) {
	if (Game.stateIndex !== GameStates.READY) return;
	if (Game.elements.previewBall === null) return;

	const r = Game.fruitSizes[Game.currentFruitSize].radius;
	const clampedX = Math.max(wallInset + r, Math.min(Game.width - wallInset - r, e.mouse.position.x));
	Body.setPosition(Game.elements.previewBall, {
		x: clampedX,
		y: previewBallHeight,
	});
});

Events.on(engine, 'collisionStart', function (e) {
	// 已结束或菜单阶段忽略
	if (Game.stateIndex === GameStates.LOSE || Game.stateIndex === GameStates.MENU) return;

	// ── 检测投出球是否首次碰撞（落地）→ 解锁下一次投球 ──
	if (dropBall !== null && Game.stateIndex === GameStates.DROP) {
		for (const pair of e.pairs) {
			if (pair.bodyA === dropBall || pair.bodyB === dropBall) {
				unlockNextDrop();
				break;
			}
		}
	}

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

		const newFruit = Game.generateFruitBody(midPosX, midPosY, newSize);
		Composite.add(engine.world, newFruit);

		Game.addPop(midPosX, midPosY, bodyA.circleRadius);

		const particleCount = 12 + bodyA.sizeIndex * 3;
		spawnParticles(midPosX, midPosY, bodyA.circleRadius, particleCount);

		const mergePoints = Game.fruitSizes[bodyA.sizeIndex].scoreValue;
		spawnScoreText(midPosX, midPosY, mergePoints);

		// 大合成特效：合成出 circle8→GOOD，circle9→GREAT，circle10→AMAZING
		triggerBigMerge(newSize, Game.fruitSizes[newSize].img);

		// 大合成额外加分（写入独立字段，专属大飞字）
		const bigMergeCfg = BIG_MERGE_LEVELS[newSize];
		if (bigMergeCfg) {
			Game._bigMergeBonus = (Game._bigMergeBonus || 0) + bigMergeCfg.bonus;
			spawnBigMergeText(bigMergeCfg.bonus, bigMergeCfg.label);
		}

		Game.fruitsMerged[bodyA.sizeIndex] += 1;
		Game.calculateScore();
		Game.unlockCompendium(bodyA.sizeIndex);
		Game.unlockCompendium(newSize);

		// 每次合并直接触发连击时间窗口
		triggerCombo(midPosX, midPosY);
	}
});

// ── 每物理帧扫描所有球，持续在死亡线以上就判负 ──
Events.on(engine, 'afterUpdate', function () {
	if (Game.stateIndex === GameStates.LOSE || Game.stateIndex === GameStates.MENU) return;

	const bodies = Composite.allBodies(engine.world);
	let overLine = false;

	for (const body of bodies) {
		if (body.isStatic) continue;
		if (body.birthTime && Date.now() - body.birthTime < 1000) continue;
		if (body.position.y - body.circleRadius < loseHeight) {
			overLine = true;
			break;
		}
	}

	if (overLine) {
		if (loseTimer === null) {
			loseTimer = setTimeout(() => {
				if (Game.stateIndex !== GameStates.LOSE) {
					Game.loseGame();
				}
			}, LOSE_GRACE_MS);
		}
	} else {
		if (loseTimer !== null) {
			clearTimeout(loseTimer);
			loseTimer = null;
		}
	}
});

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

// 防抖：窗口 resize 结束 100ms 后才执行，避免频繁触发let resizeTimer = null;
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
	const clampedX = Math.max(wallInset + r, Math.min(Game.width - wallInset - r, x));
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

// ── 再来一局按钮（跳过菜单，直接开始新一局）──────────────────
document.getElementById('game-end-link').addEventListener('click', function(e) {
	e.preventDefault();
	if (challengeCount <= 0) return;

	// 重置物理引擎
	runner.enabled = true;
	Composite.clear(engine.world, false);
	Engine.clear(engine);

	// 重置游戏状态
	Game.stateIndex = GameStates.MENU;
	Game.score = 0;
	Game._comboBonus = 0;
	Game._bigMergeBonus = 0;
	resetCombo();
	Game.fruitsMerged = Array.apply(null, Array(Game.fruitSizes.length)).map(() => 0);
	Game.currentFruitSize = 1;
	Game.nextFruitSize = 1;
	Game.elements.previewBall = null;
	dropBall = null;
	if (dropWatchTimer) { clearTimeout(dropWatchTimer); dropWatchTimer = null; }
	if (loseTimer) { clearTimeout(loseTimer); loseTimer = null; }

	// 重置图鉴
	Game.elements.compendiumItems.forEach(el => el.classList.remove('unlocked'));

	// 重置得分显示
	Game.calculateScore();

	// 关闭结束弹窗
	Game.elements.end.classList.remove('show');
	document.getElementById('game-end-error').style.display = 'none';
	document.getElementById('game-end-settling').style.display = 'none';

	// 更新顶栏次数
	initChallengeUI();

	// 跳过菜单，直接开始游戏
	Game.startGame();
});
