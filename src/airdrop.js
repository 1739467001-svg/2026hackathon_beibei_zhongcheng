// Tripo 空投礼盒：每局掉下几个 AI 生成的补给礼盒，开到就补弹药、修装甲。
// 模型是 Tripo AI（tripo3d.ai）文生 3D 出的 GLB（assets/tripo_gift_crate.glb）；
// 文件不在时自动退回程序画的低配礼盒，玩法照常，只是不好看。

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { CONFIG } from './config.js';
import { rand } from './utils.js';

const CFG = CONFIG.airdrop;
const GIFT_URL = './assets/tripo_gift_crate.glb';

export class AirdropManager {
  constructor(game) {
    this.game = game;
    this.crates = [];
    this.template = null;     // GLB 模板（加载完成后 clone 出每局的礼盒）
    // 开局就预载：玩家在菜单里点「进军」的工夫，GLB 基本都到位了
    // （Tripo 导出的是 meshopt 压缩格式，必须挂上解码器）
    new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).load(
      GIFT_URL,
      (gltf) => { this.template = this._normalize(gltf.scene); },
      undefined,
      () => { /* 404 / 解析失败：全部走程序画的兜底礼盒，静默即可 */ }
    );
  }

  // 每局重抽：清掉上一局的礼盒，重新撒 count 个
  reset() {
    this.dispose();
    const g = this.game;
    if (g.pureAir) return;   // 纯空战没有地面，礼盒无处可落
    for (let i = 0; i < CFG.count; i++) {
      const pos = this._pickSpot();
      if (pos) this.crates.push(new GiftCrate(this, pos));
    }
    if (this.crates.length) {
      g.hud.feed('🎁 侦察兵：发现 Tripo 空投礼盒正在降落，开过去拾取！', 'air');
    }
  }

  update(dt) {
    for (const c of this.crates) c.update(dt);
    for (let i = this.crates.length - 1; i >= 0; i--) {
      if (this.crates[i].dead) this.crates.splice(i, 1);
    }
  }

  dispose() {
    for (const c of this.crates) c.dispose();
    this.crates = [];
  }

  // 挑一块干燥、平坦、离玩家和火山都够远的落脚点
  _pickSpot() {
    const t = this.game.terrain;
    const half = t.playable * 0.72;
    const player = this.game.player;
    for (let tries = 0; tries < 24; tries++) {
      const x = rand(-half, half);
      const z = rand(-half, half);
      if (t.isWater(x, z)) continue;
      const v = t.volcano;
      if (v && Math.hypot(x - v.x, z - v.z) < v.r + 14) continue;
      if (player && Math.hypot(x - player.pos.x, z - player.pos.z) < 26) continue;
      return new THREE.Vector3(x, t.heightAt(x, z), z);
    }
    return null;
  }

  // GLB 归一化：把包围盒最大边缩到 CFG.size、底面贴地、水平居中
  _normalize(scene) {
    const box = new THREE.Box3().setFromObject(scene);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const k = CFG.size / Math.max(size.x, size.y, size.z);
    const wrap = new THREE.Group();
    scene.position.sub(center).multiplyScalar(k);
    scene.position.y += (size.y * k) / 2;
    scene.scale.setScalar(k);
    wrap.add(scene);
    return wrap;
  }
}

class GiftCrate {
  constructor(mgr, pos) {
    this.mgr = mgr;
    this.game = mgr.game;
    this.scene = mgr.game.scene;
    this.state = 'falling';
    this.dead = false;
    this.t = rand(0, Math.PI * 2);   // 摇摆/浮动的相位，几个礼盒错开
    this.groundY = pos.y;
    this.baseX = pos.x;
    this.baseZ = pos.z;

    // 模型：有 GLB 用 GLB，没有就现画一个低配礼盒
    this.box = mgr.template ? mgr.template.clone(true) : this._buildFallback();
    this.parachute = this._buildParachute();
    this.beam = this._buildBeam();
    this.group = new THREE.Group();
    this.group.add(this.box, this.parachute, this.beam);
    this.group.position.set(pos.x, pos.y + CFG.dropAlt, pos.z);
    this.beam.visible = false;
    this.scene.add(this.group);
  }

  update(dt) {
    this.t += dt;
    const g = this.group;

    if (this.state === 'falling') {
      g.position.y -= CFG.fallSpeed * dt;
      g.position.x = this.baseX + Math.sin(this.t * CFG.swaySpeed * Math.PI * 2) * CFG.swayAmp * (g.position.y - this.groundY) / CFG.dropAlt;
      g.rotation.y += dt * 0.6;
      if (g.position.y <= this.groundY) {
        g.position.y = this.groundY;
        g.position.x = this.baseX;
        this.state = 'landed';
        this.parachute.visible = false;
        this.beam.visible = true;
      }
    } else if (this.state === 'landed') {
      // 落地后：缓缓自转 + 轻轻浮动 + 光柱呼吸，让玩家老远就能看见
      g.rotation.y += CFG.spinSpeed * dt;
      this.box.position.y = Math.abs(Math.sin(this.t * CFG.bobSpeed)) * CFG.bobAmp;
      this.beam.material.opacity = 0.24 + Math.sin(this.t * 2.4) * 0.1;
      this._tryPickup();
    } else if (this.state === 'opening') {
      // 开盒：加速自转 + 缩小，缩没了就算拾取完成
      this.openT += dt;
      const k = 1 - this.openT / CFG.openTime;
      g.rotation.y += dt * 9;
      g.scale.setScalar(Math.max(k, 0.001) * (this._baseScale ?? 1));
      if (this.openT >= CFG.openTime) {
        this.dead = true;
        this._disposeGroup();
      }
    }
  }

  _tryPickup() {
    const g = this.game;
    const p = g.player;
    // 死亡/复活切换的瞬间 player 可能是残缺对象,一律跳过
    if (!p || !p.pos || !p.alive || g.state !== 'playing') return;
    const dx = p.pos.x - this.baseX;
    const dz = p.pos.z - this.baseZ;
    const flat = Math.hypot(dx, dz);
    const isPlane = g.playerSide === 'plane';
    const hit = isPlane
      ? flat < CFG.airPickupRadius && p.pos.y - this.groundY < CFG.airPickupHeight
      : flat < CFG.pickupRadius;
    if (!hit) return;

    this.state = 'opening';
    this.openT = 0;
    this._baseScale = this.group.scale.x;
    this.beam.visible = false;
    this._reward(p, isPlane);
  }

  _reward(p, isPlane) {
    const g = this.game;
    if (isPlane) {
      p.burst = CONFIG.playerPlane.burst;
      p.fireCooldown = 0;
      g.hud.feed('🎁 Tripo 空投已拾取：机炮弹药补满！', 'air');
    } else {
      p.rounds = p.magazine;
      const ceiling = p.repairCeiling;
      if (p.health < ceiling - 0.5) {
        p.health = Math.min(ceiling, p.health + 30);
        g.hud.feed('🎁 Tripo 空投已拾取：弹药补满 + 应急装甲修复！', 'air');
      } else {
        g.hud.feed('🎁 Tripo 空投已拾取：弹药补满！', 'air');
      }
    }
  }

  // ---------- 兜底模型（没有 GLB 时用程序现画一个低配礼盒） ----------

  _buildFallback() {
    const g = new THREE.Group();
    const box = new THREE.Mesh(
      new THREE.BoxGeometry(CFG.size, CFG.size * 0.72, CFG.size),
      new THREE.MeshStandardMaterial({ color: 0x39c8d6, roughness: 0.55, metalness: 0.1 })
    );
    box.position.y = (CFG.size * 0.72) / 2;
    box.castShadow = true;
    const ribbon = new THREE.MeshStandardMaterial({ color: 0xf5c542, roughness: 0.35, metalness: 0.4 });
    const stripV = new THREE.Mesh(new THREE.BoxGeometry(CFG.size * 0.16, CFG.size * 0.74, CFG.size + 0.02), ribbon);
    stripV.position.y = box.position.y;
    const stripH = new THREE.Mesh(new THREE.BoxGeometry(CFG.size + 0.02, CFG.size * 0.74, CFG.size * 0.16), ribbon);
    stripH.position.y = box.position.y;
    const knot = new THREE.Mesh(new THREE.SphereGeometry(CFG.size * 0.11, 10, 8), ribbon);
    knot.position.y = CFG.size * 0.72 + 0.05;
    g.add(box, stripV, stripH, knot);
    return g;
  }

  _buildParachute() {
    // 降落伞只在飘落阶段可见：伞盖（锥）+ 三根伞绳
    const g = new THREE.Group();
    const canopy = new THREE.Mesh(
      new THREE.ConeGeometry(CFG.size * 1.15, CFG.size * 0.75, 10, 1, true),
      new THREE.MeshStandardMaterial({
        color: 0xf3f6f8, roughness: 0.8, metalness: 0,
        side: THREE.DoubleSide, transparent: true, opacity: 0.92,
      })
    );
    canopy.position.y = CFG.size * 1.7;
    canopy.castShadow = true;
    const ropeMat = new THREE.LineBasicMaterial({ color: 0xdddddd, transparent: true, opacity: 0.6 });
    const ropes = new THREE.Group();
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2;
      const geo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(Math.cos(a) * CFG.size * 0.5, CFG.size * 0.7, Math.sin(a) * CFG.size * 0.5),
        new THREE.Vector3(0, canopy.position.y - CFG.size * 0.35, 0),
      ]);
      ropes.add(new THREE.Line(geo, ropeMat));
    }
    g.add(canopy, ropes);
    return g;
  }

  _buildBeam() {
    const geo = new THREE.CylinderGeometry(CFG.size * 0.32, CFG.size * 0.5, CFG.beamHeight, 10, 1, true);
    const mat = new THREE.MeshBasicMaterial({
      color: 0x7fe7ff, transparent: true, opacity: 0.26,
      side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.y = CFG.beamHeight / 2;
    return mesh;
  }

  dispose() {
    this._disposeGroup();
  }

  _disposeGroup() {
    this.scene.remove(this.group);
    // 兜底模型是现画的几何体，得一起放掉；GLB 克隆体共享模板几何体，不能动
    if (!this.mgr.template) {
      this.group.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) {
          for (const m of Array.isArray(o.material) ? o.material : [o.material]) m.dispose();
        }
      });
    }
  }
}
