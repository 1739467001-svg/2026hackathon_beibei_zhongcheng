// 触屏操控：左半屏虚拟摇杆（移动）+ 右半屏滑动（转视角）+ 开火/维修/静音按钮
// 只在触屏设备上激活（桌面可用 ?touch=1 强制打开来调试，?no-touch=1 强制关闭）。
// 全部走 Pointer Events：手机上是手指，桌面上用鼠标也能跑同一套逻辑。

const DEADZONE = 0.22;   // 摇杆死区：推这么小不算数，防手抖
const STICK_RADIUS = 52; // 摇杆头最多推离中心多少像素
const LOOK_SCALE = 1.45; // 滑动转视角比鼠标灵敏一点（手指行程短）

const clamp1 = (v) => Math.max(-1, Math.min(1, v));

export function isTouchDevice() {
  const q = new URLSearchParams(location.search);
  if (q.has('no-touch')) return false;
  if (q.has('touch')) return true;
  if (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches) return true;
  return navigator.maxTouchPoints > 0;
}

export class TouchControls {
  constructor(game) {
    this.game = game;
    this.input = game.input;
    this.input.touchMode = true;
    document.body.classList.add('touch');   // CSS / HUD 文案按这个类切换到触屏形态
    this.active = false;

    // 两根手指各干各的：一根在左半屏 = 摇杆，一根在右半屏 = 转视角
    this.stickId = null;
    this.lookId = null;
    this.stickOrigin = { x: 0, y: 0 };
    this.lookLast = { x: 0, y: 0 };

    this.el = {
      ui: document.getElementById('touch-ui'),
      stick: document.getElementById('touch-stick'),
      knob: document.getElementById('touch-stick-knob'),
      fire: document.getElementById('tb-fire'),
      repair: document.getElementById('tb-repair'),
      mute: document.getElementById('tb-mute'),
      gyro: document.getElementById('tb-gyro'),
    };

    // 重力感应状态：开着才监听 deviceorientation；校准基线 = 开启那一刻的握持姿态
    this.gyroOn = false;
    this.gyroBase = { roll: 0, pitch: 0 };
    this._onOrient = (e) => this._gyroEvent(e);
    this._onGyroBtn = (e) => {
      e.preventDefault();
      this._toggleGyro();
    };

    this._onCanvasDown = (e) => this._pointerDown(e);
    this._onCanvasMove = (e) => this._pointerMove(e);
    this._onCanvasUp = (e) => this._pointerUp(e);
    this._onFireDown = (e) => {
      e.preventDefault();
      this.input.tFirePressed = true;
      this.input.tFireHeld = true;
    };
    this._onFireUp = () => {
      this.input.tFireHeld = false;
    };
    this._onRepair = (e) => {
      e.preventDefault();
      this.input.repairPressed = true;
    };
    this._onMute = (e) => {
      e.preventDefault();
      this.game.toggleMute();
    };

    this._bind(true);
    this.el.ui.classList.add('hidden');   // 没开打之前不显示按钮
  }

  _bind(on) {
    const add = on
      ? (t, ev, fn, opts) => t.addEventListener(ev, fn, opts)
      : (t, ev, fn, opts) => t.removeEventListener(ev, fn, opts);
    add(this.game.canvas, 'pointerdown', this._onCanvasDown);
    add(this.game.canvas, 'pointermove', this._onCanvasMove);
    add(this.game.canvas, 'pointerup', this._onCanvasUp);
    add(this.game.canvas, 'pointercancel', this._onCanvasUp);
    add(this.el.fire, 'pointerdown', this._onFireDown);
    add(window, 'pointerup', this._onFireUp);
    add(this.el.repair, 'pointerdown', this._onRepair);
    add(this.el.mute, 'pointerdown', this._onMute);
    add(this.el.gyro, 'pointerdown', this._onGyroBtn);
  }

  // 开打/结算时切换按钮层。视角监听常驻（canvas 上没有 UI 时也收不到指针，不碍事）
  setActive(v) {
    this.active = v;
    this.el.ui.classList.toggle('hidden', !v);
    if (!v) this._releaseAll();
  }

  // 开坦克时藏掉「重力感应」（那是飞行才用的），开飞机时反过来
  setSide(side) {
    this.el.repair.classList.toggle('hidden', side === 'plane');
    this.el.gyro.classList.toggle('hidden', side !== 'plane');
    if (side !== 'plane') this._setGyro(false, true);
  }

  // ---------- 重力感应（飞机） ----------
  // 倾斜手机 = 压杆：左右倾斜转弯、前倾俯冲、后仰爬升。
  // iOS 要求必须由用户点按钮那次手势来申请权限，所以开关做成按钮。

  async _toggleGyro() {
    if (this.gyroOn) {
      this._setGyro(false);
      return;
    }
    try {
      // iOS 13+ 要显式要权限；Android / 桌面没有这个 API，直接监听就行
      if (typeof DeviceOrientationEvent !== 'undefined'
        && typeof DeviceOrientationEvent.requestPermission === 'function') {
        const res = await DeviceOrientationEvent.requestPermission();
        if (res !== 'granted') {
          this.game.hud.feed('没拿到重力感应权限，继续用摇杆开', 'danger');
          return;
        }
      }
      if (typeof DeviceOrientationEvent === 'undefined') {
        this.game.hud.feed('这台设备不支持重力感应', 'danger');
        return;
      }
    } catch {
      this.game.hud.feed('重力感应开启失败，继续用摇杆开', 'danger');
      return;
    }
    this.gyroBase = { roll: 0, pitch: 0 };   // 先归零，首帧事件里再校准
    window.addEventListener('deviceorientation', this._onOrient);
    this._setGyro(true);
    this.game.hud.feed('重力感应已开启：倾斜手机转弯 / 爬升俯冲，再点一次关闭', 'air');
  }

  _setGyro(on, silent) {
    this.gyroOn = on;
    this.el.gyro.classList.toggle('on', on);
    if (!on) {
      window.removeEventListener('deviceorientation', this._onOrient);
      this.input.gTurn = 0;
      this.input.gPitch = 0;
    }
  }

  // 把设备姿态角换算成"横屏握持"下的两个操控量：
  //   roll：绕屏幕法线左右压（右压为正 → 右转）
  //   pitch：前后倾（顶部朝怀里的方向仰为正 → 爬升）
  // 不同屏幕朝向下 beta/gamma 轴会互换，按 screen.orientation.angle 分派。
  _gyroAxes(e) {
    const angle = screen.orientation?.angle ?? window.orientation ?? 0;
    switch (angle) {
      case 90: return { roll: e.beta ?? 0, pitch: -(e.gamma ?? 0) };
      case -90: case 270: return { roll: -(e.beta ?? 0), pitch: (e.gamma ?? 0) };
      case 180: return { roll: -(e.gamma ?? 0), pitch: -(e.beta ?? 0) };
      default: return { roll: (e.gamma ?? 0), pitch: (e.beta ?? 0) };
    }
  }

  _gyroEvent(e) {
    if (!this.gyroOn) return;
    const raw = this._gyroAxes(e);
    // 首帧校准：开感应那一刻怎么握着，哪个方向就是"水平"
    if (this.gyroBase.roll === 0 && this.gyroBase.pitch === 0) {
      this.gyroBase = { roll: raw.roll, pitch: raw.pitch };
    }
    this.input.gTurn = this._tilt(raw.roll - this.gyroBase.roll);
    this.input.gPitch = this._tilt(raw.pitch - this.gyroBase.pitch);
  }

  // 角度 → -1~1：3° 死区防手抖，压到 28° 拉满
  _tilt(deg) {
    const dz = 3;
    const s = Math.sign(deg);
    const a = Math.abs(deg);
    if (a < dz) return 0;
    return clamp1(s * Math.min(1, (a - dz) / (28 - dz)));
  }

  _releaseAll() {
    this.stickId = null;
    this.lookId = null;
    this.el.stick.style.display = 'none';
    this.input.tForward = 0;
    this.input.tTurn = 0;
    this.input.tPitch = 0;
    this.input.tFireHeld = false;
  }

  _pointerDown(e) {
    if (!this.active) return;
    e.preventDefault();
    // 左半屏 → 摇杆（动态出现：按在哪，摇杆底座就落在哪）
    if (e.clientX < window.innerWidth * 0.44 && this.stickId === null) {
      this.stickId = e.pointerId;
      this.stickOrigin.x = e.clientX;
      this.stickOrigin.y = e.clientY;
      const s = this.el.stick;
      s.style.display = 'block';
      s.style.left = `${e.clientX - s.offsetWidth / 2}px`;
      s.style.top = `${e.clientY - s.offsetHeight / 2}px`;
      this._moveKnob(0, 0);
    } else if (this.lookId === null) {
      // 其余区域 → 转视角
      this.lookId = e.pointerId;
      this.lookLast.x = e.clientX;
      this.lookLast.y = e.clientY;
    }
  }

  _pointerMove(e) {
    if (e.pointerId === this.stickId) {
      const dx = e.clientX - this.stickOrigin.x;
      const dy = e.clientY - this.stickOrigin.y;
      const len = Math.hypot(dx, dy);
      const k = len > STICK_RADIUS ? STICK_RADIUS / len : 1;
      const nx = dx * k / STICK_RADIUS;
      const ny = dy * k / STICK_RADIUS;
      this._moveKnob(dx * k, dy * k);
      // 摇杆 x = 左右转向；y = 上推前进（坦克）/ 爬升（飞机），带死区
      this.input.tTurn = Math.abs(nx) < DEADZONE ? 0 : nx;
      this.input.tForward = Math.abs(ny) < DEADZONE ? 0 : -ny;
      this.input.tPitch = this.input.tForward;   // 飞机：摇杆上下 = 爬升 / 俯冲
    } else if (e.pointerId === this.lookId) {
      this.input.addLookDelta(
        (e.clientX - this.lookLast.x) * LOOK_SCALE,
        (e.clientY - this.lookLast.y) * LOOK_SCALE
      );
      this.lookLast.x = e.clientX;
      this.lookLast.y = e.clientY;
    }
  }

  _pointerUp(e) {
    if (e.pointerId === this.stickId) {
      this.stickId = null;
      this.el.stick.style.display = 'none';
      this.input.tForward = 0;
      this.input.tTurn = 0;
      this.input.tPitch = 0;
    } else if (e.pointerId === this.lookId) {
      this.lookId = null;
    }
  }

  _moveKnob(dx, dy) {
    const knob = this.el.knob;
    knob.style.transform = `translate(${dx}px, ${dy}px)`;
  }
}
