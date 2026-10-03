// 键鼠输入：WASD 开车、鼠标转视角与瞄准、左键/空格开炮
// 触屏设备的摇杆/滑动/开火按钮（touch.js）也汇进同一套接口：
// tForward / tTurn 是模拟量（-1~1），touchDX/DY 并进视角位移，tFire* 并进开火。

const clamp1 = (v) => Math.max(-1, Math.min(1, v));

export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.pointerLocked = false;
    this.firePressed = false;
    this._fireHeld = false;
    this.dragging = false;
    this.enabled = true;
    this.lastLookTime = 0;
    this.modeTogglePressed = false;
    this.repairPressed = false;
    // 触屏那一路的输入（没接 touch.js 时永远是 0 / false）
    this.tForward = 0;
    this.tTurn = 0;
    this.tPitch = 0;        // 触屏摇杆上下（飞机用：正 = 爬升）
    this.tFirePressed = false;
    this.tFireHeld = false;
    this.touchDX = 0;
    this.touchDY = 0;
    // 重力感应那一路（touch.js 的陀螺仪开关送进来，正 = 右转 / 爬升）
    this.gTurn = 0;
    this.gPitch = 0;
    // 触屏设备标记：touch.js 激活时置 true，用来跳过指针锁定这类桌面专属逻辑
    this.touchMode = false;

    this._onKeyDown = (e) => {
      const k = e.key.toLowerCase();
      if (k === ' ' || k.startsWith('arrow')) e.preventDefault();  // 别让方向键把页面滚了
      if (k === 'f') this.modeTogglePressed = true;
      if (k === 'r') this.repairPressed = true;
      this.keys.add(k);
      if (k === ' ') this.firePressed = true;
    };
    this._onKeyUp = (e) => this.keys.delete(e.key.toLowerCase());
    this._onBlur = () => this.keys.clear();

    this._onMouseMove = (e) => {
      if (!this.enabled) return;
      // 不管有没有拿到指针锁定，鼠标移动都用来转视角
      // （预览窗口/iframe 里常常拿不到指针锁定，之前会被这里过滤掉，导致视角永远朝北）
      this.mouseDX += e.movementX || 0;
      this.mouseDY += e.movementY || 0;
      this.lastLookTime = performance.now();
    };
    this._onMouseDown = (e) => {
      if (!this.enabled) return;
      if (e.button === 0) {
        this.firePressed = true;
        this.fireHeld = true;
        this.dragging = true;
        if (!this.pointerLocked) this.requestLock();
      }
    };
    this._onMouseUp = (e) => {
      if (e.button === 0) {
        this.fireHeld = false;
        this.dragging = false;
      }
    };    this._onLockChange = () => {
      this.pointerLocked = document.pointerLockElement === this.canvas;
      if (!this.pointerLocked) this.dragging = false;
    };

    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('blur', this._onBlur);
    window.addEventListener('mousemove', this._onMouseMove);
    canvas.addEventListener('mousedown', this._onMouseDown);
    window.addEventListener('mouseup', this._onMouseUp);
    document.addEventListener('pointerlockchange', this._onLockChange);
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  requestLock() {
    // 纯触屏设备没有指针锁定，直接跳过（有的浏览器会抛异常）
    if (this.touchMode) return;
    try {
      if (this.canvas.requestPointerLock) {
        const p = this.canvas.requestPointerLock();
        if (p && p.catch) p.catch(() => {});
      }
    } catch { /* 拿不到锁就算了，游戏照常 */ }
  }

  releaseLock() {
    if (document.exitPointerLock) document.exitPointerLock();
  }

  // 开火按住状态：鼠标按住 或 触屏开火按钮按住，任一都算
  get fireHeld() {
    return this._fireHeld || this.tFireHeld;
  }

  set fireHeld(v) {
    this._fireHeld = v;
  }

  addLookDelta(dx, dy) {
    this.touchDX += dx;
    this.touchDY += dy;
    this.lastLookTime = performance.now();
  }

  get forward() {
    return (this.keys.has('w') ? 1 : 0) - (this.keys.has('s') ? 1 : 0) || this.tForward;
  }

  get turn() {
    return clamp1((this.keys.has('d') ? 1 : 0) - (this.keys.has('a') ? 1 : 0) + this.tTurn);
  }

  // 键盘转视角：Q/E 或 左右方向键
  get camTurn() {
    const left = this.keys.has('q') || this.keys.has('arrowleft');
    const right = this.keys.has('e') || this.keys.has('arrowright');
    return (right ? 1 : 0) - (left ? 1 : 0);
  }

  // 键盘调瞄准高低：上下方向键
  get camPitchAdjust() {
    return (this.keys.has('arrowup') ? 1 : 0) - (this.keys.has('arrowdown') ? 1 : 0);
  }

  takeMouseDelta() {
    // 触屏滑动和鼠标位移汇成同一路视角增量（滑动单独乘了增益，这里直接相加）
    const d = {
      x: this.mouseDX + this.touchDX,
      y: this.mouseDY + this.touchDY,
    };
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.touchDX = 0;
    this.touchDY = 0;
    return d;
  }

  consumeFire() {
    const f = this.firePressed || this.keys.has(' ') || this.tFirePressed || this.tFireHeld;
    this.firePressed = false;
    this.tFirePressed = false;
    return f;
  }

  // F 键切换移动/瞄准模式（点 HUD 上的按钮也行）
  consumeModeToggle() {
    const v = this.modeTogglePressed;
    this.modeTogglePressed = false;
    return v;
  }

  // R 键应急修复
  consumeRepair() {
    const v = this.repairPressed;
    this.repairPressed = false;
    return v;
  }
}
