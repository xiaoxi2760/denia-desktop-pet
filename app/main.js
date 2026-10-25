// 娅娅桌面版 · 渲染层
// 负责：加载 PMX、待机呼吸/眨眼/视线、被点有反应、把"她的矩形"报给主进程做鼠标穿透
import * as THREE from 'three';
import { MMDLoader } from './lib/examples/jsm/loaders/MMDLoader.js';
import { MMDPhysics } from './lib/examples/jsm/animation/MMDPhysics.js';
import { createSparseMorphController } from './lib/SparseMorphController.js';

const params = new URLSearchParams(location.search);
if (params.get('hud') === '1') document.body.classList.add('dev');

const FORMS = {
  red: [
    '鸣潮_达妮娅（红色一形态-修模绑骨后',
    '鸣潮_达妮娅（红色毛茸袖形态）',
    '鸣潮_达妮娅1.4(red ver).pmx',
  ],
  blue: [
    '鸣潮_达妮娅（蓝色二形态-修模绑骨后',
    '鸣潮_达妮娅（蓝色形态）',
    '鸣潮_达妮娅1.2（blue ver）.pmx',
  ],
  // 2026-10-25 新增两套（体检报告见 research/model-adapt-2026-10-25/）：
  // 两套的 16 个白名单表情与全部需求骨骼都逐个核对过，MORPH_ALLOW 无需改。
  solar5: [
    '达妮娅_Solar5打歌服（领带uv修正）',
    '达妮娅_Solar5打歌服1.12',
    '达妮娅_Solar5打歌服1.12.pmx',
  ],
  white: [
    '鸣潮_达妮娅_白裙绷带(修模绑骨后）_by_鸣潮_556e8ac6dabdfeb7db46131a387ec923',
    '白裙绷带1.02',
    '鸣潮_达妮娅_白裙绷带1.02（额头前碎发修复）.pmx',
  ],
};
// 形态选择：URL ?form= 优先（托盘换装/调试用），否则用上次记住的选择，最后才落回红色。
// 记在 localStorage：托盘换装是整页重载，重启后仍保持上次的形态。
const qForm = params.get('form');
const savedForm = (() => { try { return localStorage.getItem('deniaForm'); } catch { return null; } })();
const formKey = (qForm && FORMS[qForm]) ? qForm : ((savedForm && FORMS[savedForm]) ? savedForm : 'red');
if (qForm && FORMS[qForm]) { try { localStorage.setItem('deniaForm', qForm); } catch { /* 忽略 */ } }
const form = FORMS[formKey];

// 浏览器调试走本地静态服务，Electron 里走 denia:// 协议
const viaProtocol = location.protocol === 'denia:';
// 模型走 denia://model/（主进程会带上 CORS 头，跨 host 也能取）
const modelRoot = viaProtocol ? 'denia://model/' : '/model/';
const modelDir = modelRoot + form.slice(0, 2).map(encodeURIComponent).join('/') + '/';
const modelUrl = modelDir + encodeURIComponent(form[2]);

const hud = document.getElementById('hud');
const bubbleEl = document.getElementById('bubble');
const status = (t) => { hud.textContent = t; window.__status = t; };

// ── 渲染器：整窗透明 ────────────────────────────────────────────────
const canvas = document.getElementById('stage');
// preserveDrawingBuffer 改成 false（2026-10-15）：全文没有任何 toDataURL/toBlob/getImageData
//   （截屏走主进程 desktopCapturer，截的是屏幕不是这个 canvas），开着它只是让 Chromium
//   多留一份完整绘图缓冲。实测这项省的不多，但白白开着没有任何意义。
//   ⚠️ 另外两项试过但**无效，已回退**，别再重复试：
//     · 像素比 2→1.5：工作集 2118.9→2125.1 MB（噪声级别），画质白亏
//     · 加载后把 2048×2048 贴图降采样到 1024：私有内存 2948→3642→3759 MB，**反而更差**
//   这些是旧实验记录；运行时缩图会临时保留多份位图，不能据此排除贴图成本。
//   当前版采用离线贴图、加载前 morph 白名单与稀疏表情，见 docs/第二轮内存优化.md。
// 画质（2026-10-25）：?dpr= 设置渲染像素比上限（启动器「画质」选项），默认 2。
// 流畅=1.25（最省显存）/ 标准=2 / 高清=3（高分屏更锐更占显存）。夹在 [1,3]。
const DPR_CAP = Math.min(3, Math.max(1, Number(params.get('dpr')) || 2));
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, DPR_CAP));
renderer.setClearAlpha(0);
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 4000);
window.__threeCamera = camera;      // 调试/自检用（把骨骼投影到屏幕坐标）
scene.add(new THREE.AmbientLight(0xffffff, 1.2));
const keyLight = new THREE.DirectionalLight(0xffffff, 1.2);
keyLight.position.set(0.5, 1.2, 1.6);
scene.add(keyLight);
const rimLight = new THREE.DirectionalLight(0xcfe0ff, 0.45);
rimLight.position.set(-0.8, 0.6, -1.2);
scene.add(rimLight);

let mesh = null;
let physics = null;          // 头发/裙摆/袖口的物理
let bones = {};
let morphs = { dict: {}, inf: [] };
let sparseMorphController = null;
let basePose = {};
let bodyHeight = 18;

let stanceWeight = 0;

// ── 站姿预设（照官方立绘 + 她的性子挑的几套）──────────────────────
// 注意：她这身袖子权重主要挂在**上臂那一支**（腕捩）上，光弯手肘几乎带不动袖子，
// 得抬整条上臂才读得出来（试摆时实测）；另外手放腰上会被袖子完全盖住，所以不放腰。
// 走路/做动作时站姿会平滑让开（见 applyIdle 里的 stanceWeight）。
// 每套就是一串"相对基础姿态"的骨骼偏移；她每隔一会儿自己换一套，
// 换的时候按帧插值（不会跳）。新增姿势只要往这里加一条。
const STANCES = {
  // ⚠️ 2026-10-10 用户决定：**「招牌」（左手叉腰 + 右手放背后）整套不要了**，已删除。
  //    原因：这模型的手指和拇指相对夹角是固定的（拇指只是手骨上的一个小分支），
  //    做不出参考图里"四指朝前下 + 拇指朝后上"那种接近 90° 的叉腰手型，试了几版都"完全不行"。
  //    要恢复：从交付包的 diff 里把这一条拣回来即可（或照 自检证据\10 那组角度重摆）。
  // 两只手都搭在身后，悠闲站着
  双手身后: {
    // 2026-10-10 重做：原来两只手只是"往后放一点"，长袖子会兜到身前、手藏在裙子两侧，
    // 看着就是"半背不背"。现在上臂再往后转 23°、前臂往身后收拢，手在身后交叠，
    // 袖子整条落到背后（实拍对照过，见交付包 图\11）。
    左腕: { x: 0.40 }, 右腕: { x: 0.40 },
    左ひじ: { z: -1.10, y: 0.45 }, 右ひじ: { z: 1.10, y: -0.45 },
    左手首: { y: 0.15 }, 右手首: { y: -0.15 },
    下半身: { y: 0.05 }, 上半身: { y: 0.04 },
    首: { z: -0.03, y: 0.06 },
  },
  // 手自然垂着，最放松（微微含胸）
  垂手: {
    左腕: { x: 0.06 }, 左ひじ: { z: -0.18 },
    右腕: { x: 0.06 }, 右ひじ: { z: 0.18 },
    上半身: { x: 0.02 }, 首: { x: -0.03 },
  },
  // 右手抬起来卷**胸前那缕**发梢（"右发5~8"那一条，挂在右肩前、胸口位置，
  // 实测它在 (−0.80, +4.05, +0.53)~( −0.70, +3.25, +1.05)），左手背在身后。
  // 手指的 z 左右是镜像的：右手**正 z** 才是"屈"（见 HAND_RELAX 注释）。
  卷发: {
    // 手臂改成"前臂竖起来"：肘在下面外侧，手抬到发梢那儿（用户点单：右手要竖着）
    右腕: { x: -0.50, y: 0.60, z: 0 }, 右ひじ: { x: -1.90, y: -0.60, z: 1.80 },
    // 只让**食指**卷（用户点单：一根手指卷头发），其余三指自然放松
    右人指１: { z: 0.55 }, 右人指２: { z: 0.90 }, 右人指３: { z: 0.80 },
    左腕: { x: 0.40 }, 左ひじ: { z: -1.10, y: 0.45 }, 左手首: { y: 0.15 },
    首: { z: -0.10, y: 0.08 }, 上半身: { x: 0.02 },
  },
  // 歪头看你（把重心放一边，头歪得明显一点）
  歪头: {
    // 2026-10-10 按用户点单：两只手完全背在身后 + 身体前倾一点
    左腕: { x: 0.42 }, 右腕: { x: 0.42 },
    左ひじ: { z: -1.15, y: 0.50 }, 右ひじ: { z: 1.15, y: -0.50 },
    左手首: { y: 0.18 }, 右手首: { y: -0.18 },
    下半身: { y: 0.06, z: 0.02 }, 上半身: { x: 0.18, z: 0.02, y: -0.04 }, 上半身2: { x: 0.10 },
    首: { z: 0.14, y: 0.06, x: -0.08 }, 頭: { z: 0.08, y: 0.05 },
  },
};
const STANCE_NAMES = Object.keys(STANCES);
let stanceName = params.get('stance') || 'auto';        // auto = 自己轮换；也可以指定某一套
let stanceCurrent = {};                                 // 当前插值出来的姿势（逐骨骼）
let stanceNextAt = 0;                                   // 下一次换姿势的时间

/** 指定/轮换站姿。name = 'auto' 表示按时间自己换。 */
function setStance(name, holdMs) {
  if (name && name !== 'auto' && !STANCES[name]) return false;
  stanceName = name || 'auto';
  if (stanceName === 'auto') {
    pickStance();
  } else {
    // 指定某一套：要把目标也换过去（之前只改了名字，姿势一直是旧的 —— bug）
    stanceCurrent.name = stanceName;
    stanceCurrent.target = STANCES[stanceName];
    window.__stance = stanceName;
  }
  if (holdMs) stanceNextAt = performance.now() + holdMs;
  return true;
}
function pickStance() {
  const pool = STANCE_NAMES.filter((n) => n !== stanceCurrent.name);
  const next = pool[Math.floor(Math.random() * pool.length)] || STANCE_NAMES[0];
  stanceCurrent.name = next;
  stanceCurrent.target = STANCES[next];
  stanceNextAt = performance.now() + 45000 + Math.random() * 60000;   // 45~105 秒换一次
  window.__stance = next;
}
/** 每帧：把当前姿势朝目标姿势插值（约 1.2 秒过渡完），并到点换下一套。 */
function updateStance(dt) {
  if (!stanceCurrent.target) pickStance();
  if (stanceName === 'auto' && performance.now() > stanceNextAt && behavior.mode !== 'walking' && !motionPlaying) pickStance();
  const k = Math.min(1, dt * 1.8);
  const target = stanceCurrent.target || {};
  const names = new Set([...Object.keys(stanceCurrent.values || {}), ...Object.keys(target)]);
  const values = stanceCurrent.values || (stanceCurrent.values = {});
  for (const bone of names) {
    const t = target[bone] || { x: 0, y: 0, z: 0 };
    const c = values[bone] || (values[bone] = { x: 0, y: 0, z: 0 });
    c.x += ((t.x || 0) - c.x) * k;
    c.y += ((t.y || 0) - c.y) * k;
    c.z += ((t.z || 0) - c.z) * k;
  }
}

// ── 放松的手型 ──────────────────────────────────────────────────
// 手指骨的弯曲轴是 **z**（实测：弯 1.0 rad 时指尖到手腕距离 1.218→0.898，
// x/y 轴只缩 0.13）。模型原始是半张开的"僵硬手"，这里给它一点自然的屈度；
// 待机、走路、动作、手势都吃这套（动作文件本来也不含手指轨道）。
const HAND_RELAX = (() => {
  const out = {};
  for (const side of ['左', '右']) {
    // 屈度别太大：太紧会像"爪子"（实拍对比过，半屈最像自然放松的手）
    const curls = { 人指: [0.16, 0.28, 0.21], 中指: [0.17, 0.29, 0.23], 薬指: [0.18, 0.31, 0.25], 小指: [0.17, 0.30, 0.24] };
    // ⚠️ 这模型左右手是**镜像绑骨**：同一个 z 值，右手是"屈"，左手就变成"往反方向伸"
    //    （实测指尖位移：右手 +x 收、往上；左手 +x 往外、往下 = 伸直）。所以左手取负号。
    //    左右手肘在程序化姿势表里也是这个规律（左 z:-16 / 右 z:+16）。
    const sgn = side === '左' ? -1 : 1;
    for (const [finger, [a, b, c]] of Object.entries(curls)) {
      out[`${side}${finger}１`] = { z: sgn * a };
      out[`${side}${finger}２`] = { z: sgn * b };
      out[`${side}${finger}３`] = { z: sgn * c };
    }
    out[`${side}親指１`] = { z: sgn * 0.09 };
    out[`${side}親指２`] = { z: sgn * 0.11 };
  }
  return out;
})();

// ── 程序化姿态（C 方案）：用标准 MMD 骨骼直接摆姿势，素材到位后可以替换 ──
// 单位：角度（deg）。键是骨骼名，值为相对"默认站姿"的偏移。
const POSTURES = {
  stand: { label: '站着', bones: {}, root: { y: 0, rotX: 0 }, cam: { dy: 0, dist: 1, yaw: 0, pitch: 0 } },
  sit: {
    // 2026-10-10 用户点单改版（五）：**坐在椅子上**（"坐着的时候，给个椅子"）——
    // 她坐在三.js 里现搭的一把椅子（金腿 + 白框 + 软粉坐垫 + 正常高度的金框靠背，见
    // 「椅子」一节），腿自然垂下、脚踩到"地板"（≈她站立时脚底；root.y 是负数，
    // 整个人跟着坐下去）、双手搭在膝上；视线在 applyIdle 里整体偏上、只轻轻游移。
    // 取景（用户点单）：**正面 + 半身以上 + 正视**——画面到腰/上裙一带就够，
    // 椅子收成正常高度（腿/脚在画面外，但一直在、随她一起起坐）；
    // 视线在 applyIdle 的 sit 分支里锁向镜头（带一点校准偏置）。
    label: '坐着',
    bones: {
      上半身: { x: -2 }, 上半身2: { x: -1 },              // 腰背放松
      首: { x: 3 }, 頭: { x: 0 },                          // 正视（把后仰抵掉：头摆平、正对镜头）
      左足: { x: -74, z: 2 }, 左ひざ: { x: 100 }, 左足首: { x: 6, z: -2 },   // 大腿放平、小腿垂下、脚踩地
      右足: { x: -70, z: -2 }, 右ひざ: { x: 104 }, 右足首: { x: 4, z: 2 },
      左腕: { x: 14, z: 2 }, 左ひじ: { z: -30 },           // 双手搭在膝上
      右腕: { x: 12, z: -2 }, 右ひじ: { z: 32 },
    },
    root: { y: -4.4, rotX: 0 },
    // 正面"半身以上"取景（用户点单）：她**贴着屏幕底部坐**——坐垫落到画面底边、
    // 下面只留一点裙边/坐垫，画面上缘到头发上方一点（"大概这么高、贴近屏幕下方"）
    // 2026-10-11 用户点单：透明框加高（+200px）后重校取景——头顶留空、不再顶到窗口上沿
    cam: { dy: -0.16, dist: 0.58, yaw: 0, pitch: 0 },
    windowDy: 0,
  },
  // 2026-10-10 用户点单改版（三）：**"趴着"改成「困」**——她站着快睡着：人发软、
  // 头一点一点、身体一晃一晃。鼠标/键盘长时间没动静时自动进（见 tickDrowsy），
  // 人一回来就"突然惊醒"。晃/点头/惊醒的动态在 applyIdle 的「困」层里；
  // 这里只是站着发软的静态底子。
  drowsy: {
    label: '困',
    bones: {
      上半身: { x: 5 }, 上半身2: { x: 3 },                 // 人发软、微微含着
      首: { x: 9 }, 頭: { x: 5 },                          // 头撑不太住
      左足: { x: -3 }, 左ひざ: { x: 5 },                   // 膝盖很轻的一点点弯
      右足: { x: -3 }, 右ひざ: { x: 5 },
      左腕: { x: 8, z: 2 }, 左ひじ: { z: -13 },
      右腕: { x: 8, z: -2 }, 右ひじ: { z: 13 },
    },
    root: { y: -0.4, rotX: 0 },
    cam: { dy: -0.01, dist: 1.03, yaw: 8, pitch: 2 },
    windowDy: 0,
    morphs: { まばたき: 0.42 },          // 眼皮快睁不开了（留一条缝，别真的睡死）
  },
  lie: {
    // 2026-10-10 用户点单：趴 → "侧身倚靠"（侧身站、背轻靠虚拟平面、一条腿微屈一条腿承重、
    // 手臂交叉轻放腹前、脸保持侧脸）。⚠️ 整体侧身必须转 **センター**：
    // 下半身只管腿（它挂在"腰"底下，上半身是另一支），只转下半身会"腿侧了身子还正着"。
    // 这套只在**靠近屏幕边缘**时用（用户要求）——不在边上会先走到最近的边缘（见 setPosture）。
    label: '侧身倚靠',
    bones: {
      センター: { y: -90 },              // 整体侧身（面向屏幕左，背靠右边那条"虚拟平面"）
      上半身: { x: -12, y: 4 }, 上半身2: { x: -5 },   // 上身微微后仰，靠上平面
      // 头慢慢转向镜头（用户要求）：身子侧着、脸朝观众。
      // 角度是实测解出来的——首 y +49°、頭 y +43° 时"头的正面"正好指回镜头。
      首: { y: 49, x: 3 }, 頭: { y: 43, x: 1 },
      下半身: { z: 3 },                  // 重心挪一点
      左足: { x: -6, z: 4 }, 左ひざ: { x: 20 }, 左足首: { x: -6 },   // 前腿微屈
      右足: { x: 4 }, 右ひざ: { x: 6 },                              // 后腿直立承重
      左腕: { x: -31, z: 6 }, 右腕: { x: -31, z: -6 },               // 上臂轻轻往前
      左ひじ: { z: -77 }, 右ひじ: { z: 77 },                         // 前臂在腹前交叠
    },
    root: { y: 0, rotX: 0 },
    cam: { dy: -0.02, dist: 1.03, yaw: 16, pitch: 6 },
    windowDy: 0,
  },
  // （「蹲着」2026-10-10 用户决定删除，已移除。）
  lean: {
    label: '靠着',
    bones: {
      下半身: { z: -6 }, 上半身: { z: 8, x: -3 }, 上半身2: { z: 4 },
      首: { z: -5, x: 4 }, 頭: { z: -4 },
      左足: { x: 8, z: 4 }, 右足: { x: -6, z: -6 },
      左ひざ: { x: 14 }, 右ひざ: { x: 10 },
      左腕: { x: 10 }, 右腕: { x: 12 },
      左ひじ: { z: -20 }, 右ひじ: { z: 26 },
    },
    root: { y: -0.6, rotX: 0 },
    cam: { dy: -0.04, dist: 1.05, yaw: 12, pitch: 4 },
  },
};

// 2026-10-10 用户点单："靠左边屏幕的边缘就往左，靠右边就往右" ——
// 上面那套 lean 是往左斜的（实测头朝屏幕左偏 0.67 单位），
// 这里镜像出一套往右斜的；setPosture 里按她窗口在屏幕哪半边自动挑。
POSTURES.leanR = {
  ...POSTURES.lean,
  label: '靠着（贴右边）',
  bones: mirrorPose(POSTURES.lean.bones),
  cam: { ...POSTURES.lean.cam, yaw: -(POSTURES.lean.cam?.yaw || 0) },
};
POSTURES.lean.label = '靠着（贴左边）';

// "侧身倚靠"也有左右两版：默认那套背靠屏幕右边，镜像一套背靠左边。
POSTURES.lieL = {
  ...POSTURES.lie,
  bones: mirrorPose(POSTURES.lie.bones),
  cam: { ...POSTURES.lie.cam, yaw: -(POSTURES.lie.cam?.yaw || 0) },
};

let posture = 'stand';
let postureTarget = 'stand';
let poseRemainder = 0;         // 姿态过渡还剩多远（弧度）：>0 说明身体正在换姿势
let poseOffset = {};        // 骨骼名 -> {x,y,z}（平滑后的偏移，单位 rad）
let poseRootOffset = { y: 0, rotX: 0 };
let camPose = { dy: 0, dist: 1, yaw: 0, pitch: 0 };
let camBase = null;         // 相机基准（站姿取景）
let baseRot = {};           // 骨骼名 -> 默认旋转
let basePos = {};           // 骨骼名 -> 默认位置（向量）
const ZERO_POS = new THREE.Vector3(0, 0, 0);
const deg = (d) => (d * Math.PI) / 180;
const ZERO3 = { x: 0, y: 0, z: 0 };
const POSTURE_MORPH = {};      // 姿势自带的"神态"（如困时眼皮半垂）平滑值

// ──「困」（站着打瞌睡）的运行时状态 ────────────────────────────────
// on：现在困不困；mode：'auto'（没动静自动触发，回来就惊醒）/ 'manual'（右键菜单点的）
// blend：动态层权重（平滑进出）；startle：惊醒余波计时（秒）；t0：本次开始时刻（排点头节奏用）
const drowsy = { on: false, mode: 'auto', blend: 0, startle: 0, t0: 0, holdStance: 0 };
let idleSeconds = 0;           // 鼠标/键盘"没动静"的秒数（主进程 powerMonitor 每秒来一发）
// ──「投喂」状态（2026-10-11 用户点单）：咀嚼动态 + 今天喂了几次 ──────
// ── 2026-10-11 用户点单：说话动作（手势层）默认关、坐姿椅子默认关 ──
// 想恢复：网址参数加 ?gestures=1 / ?chair=1
const GESTURES_ON = params.get('gestures') === '1';
const CHAIR_ON = params.get('chair') === '1';
const feed = { active: false, flying: false, t: 0, dur: 1.55 };
const FOODS = {
  cake: { emoji: '🍰', name: '一块小蛋糕' },
  strawberry: { emoji: '🍓', name: '一颗草莓' },
  soup: { emoji: '🥣', name: '一碗温汤' },
};
let feedCountToday = 0;
try {
  const today = new Date().toISOString().slice(0, 10);
  if (localStorage.getItem('feedDay') === today) feedCountToday = Number(localStorage.getItem('feedCount') || 0) || 0;
  else { localStorage.setItem('feedDay', today); localStorage.setItem('feedCount', '0'); }
} catch { /* 没有 localStorage 就只当次计数 */ }

/** 把一组姿势偏移左右镜像：左右骨名对调、y/z 取反、x 不动。
 *  （这模型左右骨是镜像绑的：同一个 z 在右骨就是"另一边"，所以镜像要连 z 一起翻。） */
function mirrorPose(bones) {
  const flipName = (n) => (n.startsWith('左') ? '右' + n.slice(1) : (n.startsWith('右') ? '左' + n.slice(1) : n));
  const out = {};
  for (const [n, v] of Object.entries(bones)) {
    const o = {};
    if (v.x !== undefined) o.x = v.x;
    if (v.y !== undefined) o.y = -v.y;
    if (v.z !== undefined) o.z = -v.z;
    out[flipName(n)] = o;
  }
  return out;
}

function setPosture(name) {
  let want = POSTURES[name] ? name : 'stand';
  // 选「困」= 手动进困；选了别的姿势 = 安静地醒过来（不惊醒；被戳 / 人回来才"一激灵"）
  if (want === 'drowsy') { enterDrowsy('manual'); return; }
  if (drowsy.on) exitDrowsy(false);
  // "靠着"分左右两版（用户点单）：贴左边缘就往左靠，贴右边缘就往右靠。
  // 判断用的是"她窗口中心在屏幕哪半边"（window.screenX 是同步可读的）。
  if (want === 'lean') {
    const center = (window.screenX || 0) + window.innerWidth / 2;
    const availW = window.screen?.availWidth || window.innerWidth;
    want = center > availW / 2 ? 'leanR' : 'lean';
  }
  // "侧身倚靠"只在靠近屏幕边缘时出现（用户要求）：背朝最近的那条边。
  // 不在边上就先生起来走到最近的边缘，到了再倚上去（走的时候保持站姿，不会滑着走）。
  if (want === 'lie') {
    const availW = window.screen?.availWidth || window.innerWidth;
    const w = window.innerWidth;
    const center = (window.screenX || 0) + w / 2;
    const band = availW * 0.22;                       // 边上 22% 以内算"靠近边缘"
    const onLeft = center < availW / 2;
    if (center > band && center < availW - band) {
      const x = onLeft ? 4 : Math.max(4, availW - w - 4);
      postureTarget = 'stand';
      window.__posture = 'stand';
      physics?.reset?.();
      window.pet?.setWindowOffset?.(0);
      window.pet?.walkTo?.(x, window.screenY, 900);
      setTimeout(() => { if (postureTarget === 'stand') setPosture('lie'); }, 1000);
      return;
    }
    want = onLeft ? 'lieL' : 'lie';                  // 左边 → 背朝左；右边 → 背朝右
  }
  // 「坐着」的专属落点：屏幕右下角（用户点单：坐姿直接放右下角，别被别的窗口挡）。
  // 手动点菜单、她自己决定坐，都从 setPosture('sit') 这条路进来，所以放这里最稳。
  if (want === 'sit' && postureTarget !== 'sit' && params.get('sitcorner') !== '0') {
    goSitCorner(700);
  }
  postureTarget = want;
  window.__posture = postureTarget;
  physics?.reset?.();          // 换姿势时把物理状态归位，避免残留动量把她甩穿
  // 有些姿势可以靠"窗口下移"来表现（windowDy；现在这几套都是 0，不再往下沉）
  if (window.pet?.setWindowOffset) {
    const dy = (POSTURES[postureTarget].windowDy || 0) * window.innerHeight;
    window.pet.setWindowOffset(Math.round(dy));
  }
}

/** 她"坐"的专属位置：屏幕右下角（窗口右下角留 20px、底边照旧贴着任务栏，
 *  和启动时她站的位置同一套算法）。拿着屏信息滑过去，700ms 起步。
 *  手动点「坐着」和她自己决定坐，都从这里走；行为那一路还会直接把"要走的目标"
 *  改成这个落点（见 walkToSpot），所以她其实是"走到角落再坐下"。 */
async function goSitCorner(ms = 700) {
  if (posLocked) return;                  // 锁定位置：不往角落挪
  try {
    const s = (window.pet?.getScreen ? await window.pet.getScreen() : behavior.screen) || null;
    const wa = s?.workArea;
    if (!wa) return;
    const x = Math.round(wa.x + wa.width - window.innerWidth - 20);
    const y = Math.round(wa.y + wa.height - window.innerHeight + 10);
    window.pet?.walkTo?.(x, y, ms);
  } catch { /* 拿不到屏幕信息就原地坐 */ }
}

// ──「困」的进出（2026-10-10 用户点单改版三：趴着 → 困）────────────────
// 站着打瞌睡：tickDrowsy 里看"没动静秒数"自动进出；被戳或人回来时"突然惊醒"（一激灵）。
/** 进困：mode='auto' 是没动静自动触发，'manual' 是右键菜单点的。 */
function enterDrowsy(mode = 'auto') {
  if (drowsy.on) { drowsy.mode = mode; return; }
  drowsy.on = true;
  drowsy.mode = mode;
  drowsy.t0 = clock.elapsedTime;
  drowsy.startle = 0;
  behavior.pendingDecision = null;          // 取消"正准备去哪儿"
  behavior.timer = Math.max(behavior.timer, 6);
  window.pet?.walkStop?.();
  behavior.mode = 'idle';                   // 万一在走路，就地停下（别卡在"半走"状态）
  behavior.walkEndsAt = 0;
  postureTarget = 'drowsy';
  window.__posture = 'drowsy';
  physics?.reset?.();
  window.pet?.setWindowOffset?.(0);
}

/** 从困里出来。withStartle=true = 被弄醒的（突然惊醒）；false = 安静退出（比如她换别的姿势）。 */
function exitDrowsy(withStartle = true) {
  if (!drowsy.on) return;
  drowsy.on = false;
  if (withStartle) {
    drowsy.startle = 0.75;                  // 惊醒余波（applyIdle 里按这个值猛地抬头）
    state.surprise = 0.9;                   // 复用"びっくり"表情 + 弹一下
    state.jump = bodyHeight * 0.05;
    state.lookTargetX = 0;                  // 醒过来先直直看你一会儿，再恢复正常游移
    state.lookTargetY = 0;
    state.lookNext = clock.elapsedTime + 1.4;
    drowsy.holdStance = 1.1;                // 先别急着摆招牌站姿，让"一激灵"读干净
  }
  postureTarget = 'stand';
  window.__posture = 'stand';
  behavior.timer = Math.max(behavior.timer, 4);
}

/** 困的自动进出（每帧看一眼，很便宜）：没动静 ≥ 阈值就困；人回来（有动静）就惊醒。 */
function tickDrowsy() {
  if (params.get('drowsy') === '0') return;                    // ?drowsy=0 整个关掉
  const after = Number(window.__drowsyAfter ?? params.get('drowsyAfter') ?? 60);
  const idle = Number(window.__idleOverride ?? idleSeconds);
  if (!drowsy.on) {
    const busy = behavior.mode === 'walking' || motionPlaying || state.composerOpen
      || voicePlaying || performance.now() / 1000 < state.speakingUntil;
    if (idle >= after && !busy) enterDrowsy('auto');
  } else if (drowsy.mode === 'auto' && idle < 2) {
    exitDrowsy(true);                                          // 人回来了 → 一激灵
  }
}

// "没动静"秒数：主进程 powerMonitor.getSystemIdleTime()（整个系统，鼠标或键盘都算）
if (window.pet?.idleTime) {
  setInterval(async () => {
    try {
      const s = await window.pet.idleTime();
      if (typeof s === 'number') idleSeconds = s;
    } catch { /* 拿不到就维持上一次的值 */ }
  }, 1000);
}

/** 调试用：?dbg=左腕:x=-70,右腕:x=-70 —— 直接给某几根骨骼加角度，方便试姿势 */
const DEBUG_BONES = (() => {
  const raw = params.get('dbg');
  if (!raw) return null;
  const out = {};
  for (const part of raw.split(',')) {
    const [name, kv] = part.split(':');
    if (!name || !kv) continue;
    out[name.trim()] = out[name.trim()] || {};
    for (const pair of kv.split('|')) {
      const [axis, val] = pair.split('=');
      if (!axis || val === undefined) continue;
      out[name.trim()][axis.trim()] = Number(val);
    }
  }
  return out;
})();

function applyPosture(dt) {
  const cfg = POSTURES[postureTarget] || POSTURES.stand;
  const k = Math.min(1, dt * 2.6);          // 换姿势的平滑速度
  // ⚠️ MMD 的"付与"关系：腿真正的形变骨头是 `足D / ひざD / 足首D`，
  //    它们靠 grant 从 足/ひざ/足首 继承旋转；three.js 只在用 MMDAnimationHelper 时才应用 grant，
  //    所以这里直接把同样的旋转写给 D 骨骼。
  const want = {};
  for (const [name, v] of Object.entries(cfg.bones || {})) {
    want[name] = v;
    if (bones[`${name}D`]) want[`${name}D`] = v;
  }
  if (DEBUG_BONES) {
    for (const [name, v] of Object.entries(DEBUG_BONES)) {
      want[name] = { ...(want[name] || ZERO3), ...v };
      if (bones[`${name}D`]) want[`${name}D`] = want[name];
    }
  }
  const names = new Set([...Object.keys(poseOffset), ...Object.keys(want)]);
  let remain = Math.abs((cfg.root?.y || 0) - poseRootOffset.y);   // 身体还在换姿势时 >0
  for (const name of names) {
    const w = want[name] || ZERO3;
    const cur = poseOffset[name] || ZERO3;
    remain = Math.max(remain, Math.abs(deg(w.x || 0) - cur.x), Math.abs(deg(w.y || 0) - cur.y), Math.abs(deg(w.z || 0) - cur.z));
    poseOffset[name] = {
      x: cur.x + (deg(w.x || 0) - cur.x) * k,
      y: cur.y + (deg(w.y || 0) - cur.y) * k,
      z: cur.z + (deg(w.z || 0) - cur.z) * k,
    };
  }
  poseRemainder = remain;
  poseRootOffset.y += ((cfg.root?.y || 0) - poseRootOffset.y) * k;
  poseRootOffset.rotX += ((cfg.root?.rotX || 0) - poseRootOffset.rotX) * k;
  // 播 VMD 动作时自动拉远到全身，否则跳舞/坐下这类大动作会出画
  const camWant = motionPlaying
    ? { dy: -0.26, dist: 1.95, yaw: 0, pitch: 0 }
    : (cfg.cam || {});
  const k2 = motionPlaying ? Math.min(1, dt * 2.2) : k;
  camPose.dy += ((camWant.dy || 0) - camPose.dy) * k2;
  camPose.dist += ((camWant.dist ?? 1) - camPose.dist) * k2;
  camPose.yaw += ((camWant.yaw || 0) - camPose.yaw) * k2;
  camPose.pitch += ((camWant.pitch || 0) - camPose.pitch) * k2;
  posture = postureTarget;
}

function applyCameraPose(dt) {
  if (!camBase) return;
  const k = Math.min(1, dt * 3);
  const targetY = camBase.ty + bodyHeight * camPose.dy;
  let dir = new THREE.Vector3(camBase.x - camBase.tx, camBase.y - camBase.ty, camBase.z - camBase.tz).normalize();
  // 换姿势时转一点机位角度，让"坐/趴"这种姿势读得出来（正对镜头看不出弧度）
  if (camPose.yaw) dir.applyAxisAngle(new THREE.Vector3(0, 1, 0), deg(camPose.yaw));
  if (camPose.pitch) {
    const side = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0)).normalize();
    dir.applyAxisAngle(side, deg(camPose.pitch));
  }
  const dist = camBase.dist * camPose.dist;
  const want = new THREE.Vector3(camBase.tx, targetY, camBase.tz).add(dir.multiplyScalar(dist));
  camera.position.lerp(want, k);
  camera.lookAt(camBase.tx, targetY, camBase.tz);
}

const clock = new THREE.Clock();
const state = {
  blink: 0, blinkNext: 0, blinkStart: -1,
  lookX: 0, lookY: 0, lookTargetX: 0, lookTargetY: 0, lookNext: 0,
  surprise: 0, jump: 0, smile: 0.25, wave: 0, bubbleUntil: 0,
  speakingUntil: 0, speakNext: 0, speakVowel: '', speakValue: 0, composerOpen: false,
};

// ── 取景 ───────────────────────────────────────────────────────────
function frameCamera() {
  mesh.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(mesh);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  bodyHeight = size.y;
  const view = params.get('view') || 'bust';
  const want = view === 'full' ? size.y * 1.02 : size.y * 0.76;
  const dist = want / (2 * Math.tan((camera.fov * Math.PI / 180) / 2));
  const targetY = view === 'full' ? center.y : center.y + size.y * 0.26;
  camera.position.set(center.x, targetY + size.y * 0.015, center.z + dist);
  camera.lookAt(center.x, targetY, center.z);
  camera.updateProjectionMatrix();
  camBase = {
    x: camera.position.x, y: camera.position.y, z: camera.position.z,
    tx: center.x, ty: targetY, tz: center.z, dist,
  };
  window.__bbox = { h: size.y, w: size.x, cy: center.y };
  // 屏幕上"1 个模型单位 = 多少像素"（窗口高度正好覆盖 want 个单位）
  pxPerUnit = (window.innerHeight || 780) / Math.max(1, want);
  updateWalkSpeed();
}

// ── 走路：步频 ↔ 移动速度 ──────────────────────────────────────────
// 步幅（像素/步）= 2·sin(摆幅)·腿长(单位)·每单位像素数；一个步周期 = 两步。
// 于是"窗口移动速度"要和"步频"一致，才不会溜冰。改摆幅/窗口大小都会自动跟上。
let pxPerUnit = 58;
const LEG_LEN_UNITS = 9.5;           // 髋→踝（实测：大腿 4.72 + 小腿 4.81）
const LEG_SWING = 0.24;              // 与走路动画里的 legSwing 保持一致
// 走路预设：步频（rad/s）与摆臂幅度（度）配套；速度按 stridePx 反推，三者永远自洽
const WALK_STYLES = [
  { name: '悠闲', cadence: 4.2, armSwingDeg: 18 },
  { name: '轻快', cadence: 5.4, armSwingDeg: 24 },
  { name: '慢晃', cadence: 3.2, armSwingDeg: 12 },
];
function stridePx() { return 2 * Math.sin(LEG_SWING) * LEG_LEN_UNITS * pxPerUnit; }
function updateWalkSpeed() {
  behavior.speed = Math.round((behavior.cadence / Math.PI) * stridePx());   // 像素/秒
  window.__walkSpeed = { speed: behavior.speed, cadence: behavior.cadence, stridePx: Math.round(stridePx()), pxPerUnit: Math.round(pxPerUnit) };
}

function resize() {
  const w = window.innerWidth || 460;
  const h = window.innerHeight || 820;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  // 窗口被缩放（托盘"放大/缩小"、拖边框）之后重新取景，保证她还完整在框里
  if (mesh) frameCamera();
}
window.addEventListener('resize', resize);

// ── 表情 / 骨骼工具 ────────────────────────────────────────────────
function setMorph(name, v) {
  const i = morphs.dict[name];
  if (i === undefined) return false;
  morphs.inf[i] = Math.max(0, Math.min(1, v));
  return true;
}

function applyIdle(dt, t) {
  const breathe = Math.sin(t * 1.15);
  const sway = Math.sin(t * 0.42);
  const swaySlow = Math.sin(t * 0.27);

  applyPosture(dt);

  // 最终旋转 = 模型默认姿态 + 姿态偏移（坐/趴/蹲/靠） + 待机微动
  const waveLift = state.wave * 0.9;
  const ZERO = { x: 0, y: 0, z: 0 };
  const idle = {
    上半身: { x: breathe * 0.012, y: 0, z: sway * 0.018 },
    上半身2: { x: 0, y: 0, z: sway * 0.012 },
    首: { x: state.lookY * 0.08, y: swaySlow * 0.07 + state.lookX * 0.12, z: 0 },
    頭: { x: 0, y: swaySlow * 0.05, z: 0 },
    左腕: { x: 0, y: 0, z: waveLift },      // z 只用于"挥手"（VMD 动作里的招手），其余时候保持 0
    右腕: { x: 0, y: 0, z: -sway * 0.012 },
    左ひじ: { x: 0, y: 0, z: -waveLift * 0.8 },
  };
  // 说话时的肢体语言（叠加在待机/姿态之上）
  const gest = tickGesture(dt);
  if (gest) {
    for (const [name, v] of Object.entries(gest)) {
      const cur = idle[name] || ZERO;
      idle[name] = {
        x: cur.x + (v.x || 0),
        y: cur.y + (v.y || 0),
        z: cur.z + (v.z || 0),
      };
    }
  }
  // ──「困」的动态层（2026-10-10 用户点单）：一晃一晃 + 一点一点点头 ──────
  // 静态底子在 POSTURES.drowsy；这里叠动态：身体慢悠悠左右/前后晃，
  // 头按"慢慢垂下（约 6 秒）→ 一下惊醒般抬回来（0.7 秒）"的节奏打盹；
  // 被弄醒时 startle 余波：猛地抬头、身子往回一挺。
  drowsy.blend += ((drowsy.on ? 1 : 0) - drowsy.blend) * Math.min(1, dt * (drowsy.on ? 1.7 : 3.4));
  if (drowsy.blend > 0.001 || drowsy.startle > 0) {
    const td = t - drowsy.t0;
    const swz = Math.sin(t * 1.05) * 0.040;                       // 左右晃（≈2.3°）
    const swx = Math.sin(t * 0.62 + 1.3) * 0.018;                 // 前后晃
    const CYC = 8.6, RISE = 6.2, FALL = 0.7;                      // 打盹节奏
    const p = ((td % CYC) + CYC) % CYC;
    const nod = p < RISE ? (0.5 - 0.5 * Math.cos((p / RISE) * Math.PI))
      : (p < RISE + FALL ? 1 - (p - RISE) / FALL : 0);
    const b = drowsy.blend;
    const add = {
      下半身: { x: 0, y: 0, z: -swz * 0.55 * b },
      上半身: { x: (swx + 0.10 * nod) * b, y: 0, z: swz * b },
      上半身2: { x: 0.05 * nod * b, y: 0, z: swz * 0.5 * b },
      首: { x: 0.30 * nod * b, y: 0, z: swz * 0.8 * b },
    };
    if (drowsy.startle > 0) {
      drowsy.startle = Math.max(0, drowsy.startle - dt);
      const k = Math.min(1, drowsy.startle / 0.75);
      add.首.x -= 0.24 * k; add.首.z += 0.06 * k;
      add.上半身.x -= 0.11 * k; add.上半身.z -= 0.05 * k;
      add.下半身.z += 0.03 * k;
    }
    for (const [n, v] of Object.entries(add)) {
      const cur = idle[n] || (idle[n] = { x: 0, y: 0, z: 0 });
      cur.x += v.x; cur.y += v.y; cur.z += v.z;
    }
  }
  // ──「投喂」咀嚼层（2026-10-11）：头一点一点地嚼，配一个缓慢的前倾 ──
  if (feed.active) {
    feed.t += dt;
    if (feed.t >= feed.dur) {
      feed.active = false;
      state.smile = Math.min(state.smile, 0.35);
    } else {
      const ft = feed.t;
      const chew = Math.sin(ft * Math.PI * 2 * 3.2) * (1 - Math.min(1, ft / feed.dur) * 0.8) * 0.085;
      const lean = Math.sin(Math.min(1, (ft / feed.dur) * 2.6) * Math.PI) * 0.055;
      const add = {
        首: { x: chew + lean * 0.35, y: 0, z: 0 },
        頭: { x: chew * 0.6, y: 0, z: 0 },
        上半身: { x: lean * 0.7, y: 0, z: 0 },
      };
      for (const [n, v] of Object.entries(add)) {
        const cur = idle[n] || (idle[n] = { x: 0, y: 0, z: 0 });
        cur.x += v.x; cur.y += v.y; cur.z += v.z;
      }
      state.smile = Math.max(state.smile, ft < 0.3 ? 0.7 - ft * 0.4 : 0.58);
    }
  }
  let walkBob = 0;
  // 待机"招牌姿势"的权重：站着不动时是 1，走路/做动作时让开（平滑过渡）
  const stanceTarget = (posture === 'stand' && behavior.mode !== 'walking' && !motionPlaying) ? 1 : 0;
  stanceWeight += (stanceTarget - stanceWeight) * Math.min(1, dt * 2.5);
  if (window.__stanceW !== undefined) stanceWeight = Number(window.__stanceW);   // 调姿势用：0 = 关掉招牌姿势
  // 惊醒后的 ~1 秒里先按住招牌站姿：不然手会立刻抬起来卷头发，把"一激灵"冲淡
  if (drowsy.holdStance > 0) {
    drowsy.holdStance = Math.max(0, drowsy.holdStance - dt);
    stanceWeight = Math.min(stanceWeight, 0.1);
  }
  updateStance(dt);
  if (behavior.mode === 'walking') {
    // 程序化走路：大腿/膝盖交替摆动 + 手臂反向摆 + 身体上下起伏
    // 步频按"能走到的速度"来定：一个完整步周期 = 两步，步幅由腿长×摆幅换算成像素。
    // 这样窗口移动和脚步才对得上（原来写死 6.4 rad/s，配 155px/s = 步子只有需求的六成，
    // 看着就像原地倒腾 / 溜冰）。
    behavior.phase += dt * behavior.cadence;
    const p = behavior.phase;
    const s1 = Math.sin(p);
    const s2 = Math.sin(p + Math.PI);
    // 摆幅收小：超出作者调物理时的姿势范围就会穿模
    const legSwing = 0.24;
    const kneeLift = (v) => Math.max(0, -v) * 0.45 + 0.08;
    idle['左足'] = { x: legSwing * s1, y: 0, z: 0 };
    idle['右足'] = { x: legSwing * s2, y: 0, z: 0 };
    idle['左ひざ'] = { x: kneeLift(s1), y: 0, z: 0 };
    idle['右ひざ'] = { x: kneeLift(s2), y: 0, z: 0 };
    idle['左足首'] = { x: -0.18 * s1, y: 0, z: 0 };
    idle['右足首'] = { x: -0.18 * s2, y: 0, z: 0 };
    // 走路摆手：上臂（MMD 的「腕」就是上臂）沿 x 轴前后摆，**和同侧腿反相**（人走路就这样），
    // 肘（ひじ）再跟一点，读起来才自然。
    // 摆幅默认 ±18°：Blender 里量过——手臂转到 24° 时裙摆材质 12218 个顶点位移为 0，
    // 跟着动的只有袖子/手套/毛袖（正确绑定），所以这个幅度不会让裙子穿模。
    // 想调可以用 ?armswing=<度>；实测 24° 以内裙摆都不动，再大袖子就开始盖裙子了。
    idle['左腕'] = { x: -behavior.armSwing * s1, y: 0, z: 0 };
    idle['右腕'] = { x: -behavior.armSwing * s2, y: 0, z: 0 };
    idle['左ひじ'] = { x: 0, y: 0, z: -behavior.armSwing * 0.35 * Math.max(0, s1) };
    idle['右ひじ'] = { x: 0, y: 0, z: behavior.armSwing * 0.35 * Math.max(0, s2) };
    idle['上半身'] = { x: 0.02, y: 0.05 * s1, z: 0.03 * s1 };
    idle['下半身'] = { x: 0, y: -0.04 * s1, z: 0 };
    walkBob = Math.abs(Math.sin(p)) * 0.22 - 0.11;
    for (const [name, v] of Object.entries(idle)) {
      if (bones[`${name}D`]) idle[`${name}D`] = v;      // 腿部形变骨头同样要写
    }
  }
  if (motionPlaying && mixer) {
    mixer.update(dt);                 // 有 VMD 动作时，骨骼交给动作驱动
  } else {
    for (const name of Object.keys(bones)) {
      const b = bones[name];
      const base = baseRot[name] || ZERO;
      const p = poseOffset[name] || ZERO;
      const i = idle[name] || ZERO;
      const d = (window.__dbgBones && window.__dbgBones[name]) || null;   // 实时调姿势用
      const s = (stanceWeight > 0.001 && stanceCurrent.values && stanceCurrent.values[name]) || null;   // 待机站姿（自动轮换）
      const h = HAND_RELAX[name] || null;                                 // 放松的手型（常开）
      b.rotation.set(
        base.x + p.x + i.x + (d?.x || 0) + (s?.x || 0) * stanceWeight + (h?.x || 0),
        base.y + p.y + i.y + (d?.y || 0) + (s?.y || 0) * stanceWeight + (h?.y || 0),
        base.z + p.z + i.z + (d?.z || 0) + (s?.z || 0) * stanceWeight + (h?.z || 0),
      );
      // ⚠️ 位置也要重置成静止值：物理（或别的环节）一旦把骨骼位置写飞，
      //    只重置旋转是救不回来的 —— 顶点会被拉成"糊满屏幕的巨大平面"。
      if (name !== 'センター') {
        const bp = basePos[name];
        if (bp) b.position.copy(bp);
      }
    }
    if (bones['センター']) {
      const bpC = basePos['センター'] || ZERO_POS;
      bones['センター'].position.set(
        bpC.x,
        bpC.y + poseRootOffset.y + breathe * bodyHeight * 0.004 + state.jump + walkBob,
        bpC.z,
      );
    }
  }
  applyMotionFade(dt);            // 动作播放的进出过渡（放在物理之前）
  applySecondaryMotion(dt);       // 扭腕骨 + 裙摆的次级运动（同样放在物理之前）
  // 转身：走路时侧身对着"要去的方向"，站住/做别的时转回正面。
  // 走得快一点转、停下慢慢转，都是平滑的（原来是一步跳到 0 或 π，所以看着像螃蟹走）。
  if (mesh) {
    const wantYaw = behavior.mode === 'walking' ? (behavior.dir < 0 ? -Math.PI / 2 : Math.PI / 2) : 0;
    let diff = ((wantYaw - mesh.rotation.y + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    const turnRate = behavior.mode === 'walking' ? 6 : 3.2;
    mesh.rotation.y += diff * Math.min(1, dt * turnRate);
    if (Math.abs(diff) < 0.02) mesh.rotation.y = wantYaw;
  }
  // 物理放在最后：头发、裙摆、袖口跟着刚才的姿态/动作甩起来
  maybeRetryPhysics();          // 之前如果因为写飞被收起来了，到点自己再试一次
  if (physics) {
    try {
      // 走动/做动作/换姿势时先让物理停一下：位移一大，布料就被甩进身体里穿模；
      // 停下来（或动作结束）之后 reset 一次再继续，布会自然落回去。
      // ⚠️ 换姿势也算"大位移"：身体在往新姿势转的过程中会把裙子拖着穿过身体，
      //    实测趴下那一下最容易把布料带炸（连炸 7 帧、最后自己回落 off）。
      const posing = poseRemainder > 0.02;                     // 约 1.1° 以内算"姿势稳了"
      // ⚠️ 实测：做动作时**不能**让布料继续模拟——这个模型的刚体是按站姿调的，
      //    快舞里（袖子/裙子一起）会连炸到自动回落 off（试过 safe/full、physblend 0.3/0.4 都一样）。
      //    所以动作期间照旧暂停物理；袖子和裙子的"活"由动作文件里额外烘焙的
      //    腕捩/手捩（扭腕）和裙摆次级运动来体现。
      const movingNow = behavior.mode === 'walking' || motionPlaying || posing;
      if (movingNow) {
        physics.reset?.();
        physicsWasPaused = true;
      } else {
        if (physicsWasPaused) { physics.reset?.(); physicsWasPaused = false; }
      // 先记下动画姿态（位置 + 旋转）：物理算完后用旋转按 physicsBlend 掺回去，
      // 同时"位置"这份快照也是判断"这一帧物理有没有把骨头写飞"的判据
      snapshotPhysicsBones();
      physics.update(Math.min(dt, 1 / 30));   // 掉帧时别让物理一步跳太大（会炸开穿模）
      // ⚠️ 写飞救援：Ammo 一旦被炸开的约束带飞，会把骨骼 pose 写到十万八千里
      //   （实测裙摆骨骼位置 = (422, -25, -786)、旋转偏 176°，模型才 18 单位高 →
      //    顶点被拉成"糊满屏幕的巨大平面"）。检测到就整批归位，再按阶梯走
      //    "就地复位 → 重建 → 回落 off"（见 recoverPhysics）。
      const blown = detectBlownPhysicsBones();
      if (blown) {
        recoverPhysics(blown);            // 骨骼已归位、刚体已重种，这一帧不再往里掺旋转
      } else if (physicsBones.length && physicsBlend < 1) {
        const k = 1 - Math.max(0.05, Math.min(1, physicsBlend));
        for (let i = 0; i < physicsBones.length; i++) {
          physicsBones[i].quaternion.slerp(physicsBeforeQ[i], k);
        }
      }
      }
    } catch (e) {
      window.__physicsError = String(e?.message || e);
    }
  }
  applyCameraPose(dt);

  // 眨眼：随机间隔
  if (t > state.blinkNext && state.blinkStart < 0) {
    state.blinkStart = t;
    state.blinkNext = t + 2.4 + Math.random() * 3.6;
  }
  if (state.blinkStart >= 0) {
    const p = (t - state.blinkStart) / 0.14;
    state.blink = p < 0.5 ? p * 2 : Math.max(0, 2 - p * 2);
    if (p >= 1) { state.blink = 0; state.blinkStart = -1; }
  }
  setMorph('まばたき', state.blink);

  // 姿势自带的"神态"（趴着：眼皮半垂）：平滑混入；眨眼时取两者里更大的那个
  const wantMorphs = (POSTURES[postureTarget] || POSTURES.stand).morphs || null;
  const morphKeys = new Set([...Object.keys(POSTURE_MORPH), ...Object.keys(wantMorphs || {})]);
  for (const k of morphKeys) {
    const target = Number(wantMorphs?.[k] || 0);
    POSTURE_MORPH[k] = (POSTURE_MORPH[k] || 0) + (target - (POSTURE_MORPH[k] || 0)) * Math.min(1, dt * 2);
    if (POSTURE_MORPH[k] < 0.002) { delete POSTURE_MORPH[k]; continue; }
    if (k === 'まばたき') setMorph(k, Math.max(POSTURE_MORPH[k], state.blink));
    else setMorph(k, POSTURE_MORPH[k]);
  }

  // 视线：几秒换一个目标，平滑过渡
  // ⚠️ 侧身倚靠时按住视线（要纯侧脸，一东张西望就会"转头看镜头"——用户要求）。
  const quietNow = postureTarget === 'lie' || postureTarget === 'lieL';
  if (quietNow) {
    state.lookTargetX = 0;
    state.lookTargetY = 0;
    state.lookNext = t + 1;
  } else if (drowsy.on) {
    // 困：眼神慢慢往下沉，跟着身体微微飘
    state.lookTargetX = Math.sin(t * 0.31) * 0.12;
    state.lookTargetY = 0.32 + Math.sin(t * 0.47) * 0.06;
    state.lookNext = t + 1.2;
  } else if (postureTarget === 'sit') {
    // 正视（用户点单）：直直看着镜头、不飘。
    // 偏置是拿实测校的：这个模型"零位视线"本身略微偏她自己的右（我们的左），
    // 而且镜头在她胸口高度、稍微往上看到她 —— 所以往她的左、往下各带一点点。
    state.lookTargetX = -0.09;
    state.lookTargetY = 0.10;
    state.lookNext = t + 1;
  } else if (t > state.lookNext) {
    state.lookTargetX = (Math.random() * 2 - 1) * 0.65;
    state.lookTargetY = (Math.random() * 2 - 1) * 0.45;
    state.lookNext = t + 1.8 + Math.random() * 3.4;
  }
  state.lookX += (state.lookTargetX - state.lookX) * Math.min(1, dt * 2.2);
  state.lookY += (state.lookTargetY - state.lookY) * Math.min(1, dt * 2.2);
  setMorph('left', Math.max(0, -state.lookX) * 0.7);
  setMorph('right', Math.max(0, state.lookX) * 0.7);
  setMorph('up', Math.max(0, -state.lookY) * 0.7);
  setMorph('down', Math.max(0, state.lookY) * 0.7);

  // 嘴型：有声音时按音频驱动；没声音（纯文字）时用元音轮转兜底
  const speaking = performance.now() / 1000 < state.speakingUntil;
  for (const v of ['あ', 'い', 'う', 'え', 'お']) setMorph(v, 0);
  setMorph('口', 0);
  if (voicePlaying) {
    mouthTarget = sampleMouth();
    mouthValue += (mouthTarget - mouthValue) * Math.min(1, dt * 20);
    setMorph('口', mouthValue);
    setMorph('あ', mouthValue * 0.55);
    setMorph('い', mouthValue * 0.18);
  } else if (speaking) {
    mouthValue = 0;
    const nowMs = performance.now();
    if (nowMs > state.speakNext) {
      state.speakNext = nowMs + 80 + Math.random() * 90;
      state.speakVowel = ['あ', 'い', 'う', 'え', 'お'][Math.floor(Math.random() * 5)];
      state.speakValue = 0.35 + Math.random() * 0.5;
    }
    if (state.speakVowel) setMorph(state.speakVowel, state.speakValue);
    setMorph('口', state.speakValue * 0.4);
  } else {
    mouthValue = 0;
  }

  // 情绪表情（先给温和的笑，接上大脑后由情绪驱动）
  const mood = state.surprise > 0 ? 0 : state.smile;
  setMorph('にこり', mood);
  setMorph('笑い', mood * 0.75);
  setMorph('照れ', mood * 0.35);
  setMorph('びっくり', state.surprise);
  setMorph('笑い目', mood * 0.5);

  state.surprise = Math.max(0, state.surprise - dt * 1.6);
  state.jump = Math.max(0, state.jump - dt * bodyHeight * 0.06);
  state.wave = Math.max(0, state.wave - dt * 1.2);
}

function say(text, seconds = 5) {
  bubbleEl.textContent = text;
  bubbleEl.classList.add('show');
  state.bubbleUntil = performance.now() / 1000 + seconds;
}

// ── 投喂（2026-10-11）：食物从鼠标处飞到她嘴边 → 她嚼一嚼 → 顺手告诉她 ──
// 计数只记在桌宠这台机（localStorage 按天重置），当"玩"的彩头。
function headScreenPos() {
  const b = bones['頭'] || bones['首'];
  if (!b) return { x: window.innerWidth / 2, y: window.innerHeight * 0.22 };
  const V = new THREE.Vector3();
  b.getWorldPosition(V);
  V.project(camera);
  const w = window.innerWidth;
  const h = window.innerHeight;
  return { x: (V.x * 0.5 + 0.5) * w, y: (-V.y * 0.5 + 0.5) * h + h * 0.035 };
}

function flyFood(emoji, from, dur = 0.65) {
  return new Promise((resolve) => {
    const el = document.createElement('div');
    el.textContent = emoji;
    el.style.cssText = 'position:fixed;left:0;top:0;font-size:36px;line-height:1;'
      + 'pointer-events:none;z-index:9999;filter:drop-shadow(0 4px 8px rgba(0,0,0,.35));';
    document.body.appendChild(el);
    const to = headScreenPos();
    const x0 = from?.x ?? window.innerWidth * 0.62;
    const y0 = from?.y ?? window.innerHeight * 0.82;
    const cx = (x0 + to.x) / 2 + 40;                 // 一点弧线，别直愣愣飞
    const cy = Math.min(y0, to.y) - 90;
    const t0 = performance.now();
    const step = () => {
      const p = Math.min(1, (performance.now() - t0) / (dur * 1000));
      const e = p * p * (3 - 2 * p);
      const x = (1 - e) * (1 - e) * x0 + 2 * (1 - e) * e * cx + e * e * to.x;
      const y = (1 - e) * (1 - e) * y0 + 2 * (1 - e) * e * cy + e * e * to.y;
      el.style.transform = `translate(${(x - 18).toFixed(1)}px, ${(y - 18).toFixed(1)}px) scale(${(1 - 0.25 * e).toFixed(3)})`;
      if (p < 1) requestAnimationFrame(step);
      else { el.remove(); resolve(); }
    };
    requestAnimationFrame(step);
  });
}

async function feedHer(kind, fromX, fromY) {
  if (feed.active || feed.flying) return;
  const keys = Object.keys(FOODS);
  const key = (kind === 'random' || !FOODS[kind]) ? keys[Math.floor(Math.random() * keys.length)] : kind;
  const food = FOODS[key];
  feed.flying = true;
  feedCountToday += 1;
  try { localStorage.setItem('feedCount', String(feedCountToday)); } catch { /* 忽略 */ }
  const suffix = feedCountToday >= 2 ? `（今天第 ${feedCountToday} 次）` : '';
  await flyFood(food.emoji, {
    x: Number.isFinite(fromX) ? fromX : undefined,
    y: Number.isFinite(fromY) ? fromY : undefined,
  });
  feed.flying = false;
  feed.active = true;
  feed.t = 0;
  state.jump = Math.max(state.jump, bodyHeight * 0.015);
  say(`你：（投喂）${food.name}${suffix}`, 2.5);
  sendText(`（投喂）主人喂你吃了${food.name}`, `你：（投喂）${food.name}${suffix}`);
}

const REACTIONS = [
  '干嘛呀，戳我一下。',
  '唔…又戳我。',
  '在的，怎么啦？',
  '你手上那点活干完了没？',
  '别闹，我先看着你。',
];

function onPoke() {
  state.surprise = 0.9;
  state.jump = bodyHeight * 0.045;
  if (Math.random() < 0.55) say(REACTIONS[Math.floor(Math.random() * REACTIONS.length)], 4);
}

// ── 接入她的大脑 ───────────────────────────────────────────────────
const composer = document.getElementById('composer');
const input = document.getElementById('input');
const sendBtn = document.getElementById('sendBtn');
const micBtn = document.getElementById('micBtn');
let lastSeenTs = 0;
let polling = false;

function openComposer() {
  state.composerOpen = true;
  document.body.classList.add('chat');
  window.pet?.setInteractive(true);
  input.focus();
}

function closeComposer() {
  state.composerOpen = false;
  document.body.classList.remove('chat');
  input.blur();
  lastInteractive = null;          // 让像素判定重新接管
  if (rec.active) stopListening();  // 收起输入条时别把录音丢在半路
}

function speakFor(text, msPerChar = 130) {
  const ms = Math.min(12000, Math.max(900, text.length * msPerChar));
  state.speakingUntil = performance.now() / 1000 + ms / 1000;
}

// ── 她的声音 + 口型 ────────────────────────────────────────────────
let audioCtx = null;
let analyser = null;
let analyserBuf = null;
let voicePlaying = false;
let mouthTarget = 0;
let mouthValue = 0;
let audioLevel = 0;              // 当前语音能量（0~1），手势幅度跟着它走
let currentAudio = null;          // 正在播的那一条
let audioPlayingCount = 0;        // 同时播放的条数（必须恒 ≤ 1）
window.__overlapPeak = 0;

function ensureAudio() {
  if (audioCtx) return audioCtx;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  audioCtx = new Ctx();
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = 0.6;
  analyserBuf = new Uint8Array(analyser.fftSize);
  analyser.connect(audioCtx.destination);
  return audioCtx;
}

/** 台词里那些（动作）【旁白】不该念出来 */
function cleanForSpeech(text) {
  return String(text || '')
    .replace(/（[^）]*）/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/【[^】]*】/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/[*_`#>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function playHerVoice(text) {
  const line = cleanForSpeech(text);
  if (!line) return false;
  try {
    const r = await window.pet.voice(line);
    if (!r?.ok || !r.url) { window.__voiceError = r?.error || '合成失败'; return false; }
    ensureAudio();
    if (audioCtx.state === 'suspended') await audioCtx.resume();
    const buf = await (await fetch(r.url)).arrayBuffer();
    const blobUrl = URL.createObjectURL(new Blob([buf], { type: 'audio/mpeg' }));

    const audio = new Audio();
    audio.src = blobUrl;
    const src = audioCtx.createMediaElementSource(audio);
    src.connect(analyser);
    let counted = false;
    let retired = false;

    // 收尾一个音频实例。**必须幂等**，因为有三条路都会走到这里：
    //   1) 正常播完 ended
    //   2) 被下一条顶掉（下面那个 pause 兜底）
    //   3) play() 被拒 / 解码失败 error
    //
    // 2026-10-15 修：以前**只有 ended 一条路**做收尾。于是——
    //   - 被顶掉的旧音频永远不触发 ended → audioPlayingCount 只加不减、blobUrl 不回收；
    //   - 更糟的是：若旧音频被顶掉、而新音频 play() 又失败，voicePlaying 就永久停在 true，
    //     pumpSpeech 的 `if (voicePlaying || …) return;` 会把整个说话队列彻底卡死 —— 她再也不出声。
    // advanceQueue：是否推进队列（被顶掉/失败时也要推进，否则队列停摆）。
    const retire = (advanceQueue) => {
      if (retired) return;
      retired = true;
      if (counted) { counted = false; audioPlayingCount = Math.max(0, audioPlayingCount - 1); window.__activeAudio = audioPlayingCount; }
      if (currentAudio === audio) currentAudio = null;
      voicePlaying = false;
      mouthTarget = 0;
      try { src.disconnect(); } catch { /* ignore */ }
      try { URL.revokeObjectURL(blobUrl); } catch { /* ignore */ }
      if (advanceQueue && onSpeechDone) onSpeechDone();
    };
    audio.__retire = retire;   // 供"顶掉旧音频"那条路调用

    // 兜底：万一还有漏网的旧音频，**完整收尾**掉，保证同一时刻只有一条在响
    if (currentAudio) {
      if (typeof currentAudio.__retire === 'function') currentAudio.__retire(true);
      else { try { currentAudio.pause(); } catch { /* ignore */ } }
    }
    currentAudio = audio;
    audio.addEventListener('play', () => {
      if (counted) return;
      counted = true;
      audioPlayingCount++;
      window.__activeAudio = audioPlayingCount;
      window.__overlapPeak = Math.max(window.__overlapPeak, audioPlayingCount);
    });
    audio.addEventListener('ended', () => retire(true));
    audio.addEventListener('error', () => { window.__voiceError = '音频解码失败'; retire(true); });
    try {
      await audio.play();
    } catch (e) {
      retire(true);          // ← 关键补：播不了也必须收尾，否则 voicePlaying 永久卡在 true
      throw e;
    }
    voicePlaying = true;
    window.__voicePlaying = true;
    window.__lastVoice = { url: r.url, ms: r.ms, label: r.label };
    return true;
  } catch (err) {
    window.__voiceError = String(err?.message || err);
    return false;
  }
}

// ── 说话队列：一次只播一句，重复的不播第二遍 ───────────────────────
const speech = { queue: [], spokenTs: 0, playingKey: '', started: 0, skipped: 0, pumping: false };
window.__speech = speech;
let onSpeechDone = null;
const recentlySpoken = new Map();   // 文本 -> 说完的时间（防同句复读）
const speechLog = [];               // 诊断：每一次入队/被跳过都留痕
speech.log = speechLog;
function noteSpeak(kind, text, extra = '') {
  speechLog.push(`${kind}|${String(text || '').slice(0, 18)}|${extra}`);
  if (speechLog.length > 60) speechLog.shift();
}

const normKey = (t) => String(t || '').replace(/[\s，。、！？~…,.!?]/g, '');

function enqueueSpeech(text, ts = 0) {
  const line = String(text || '').trim();
  if (!line) return;
  const key = normKey(line);
  if (!key) return;
  // 有消息时间戳就以它为准（同一句在她那边只算一条）；
  // 没有时间戳时才用 60 秒文本去重兜底 —— 否则"轮询先念了、发送路径后到"会把话吃掉。
  const lastAt = recentlySpoken.get(key) || 0;
  if (ts) {
    if (ts <= speech.spokenTs) { speech.skipped++; noteSpeak('skip-ts', line, `ts=${ts} spokenTs=${speech.spokenTs}`); return; }   // 这条消息已经说过了
    speech.spokenTs = ts;
  } else if (performance.now() - lastAt < 20000) {
    speech.skipped++;
    noteSpeak('skip-ttl', line, `lastAt=${Math.round(lastAt)}`);
    return;
  }
  if (speech.playingKey === key) { speech.skipped++; noteSpeak('skip-playing', line); return; }  // 正在说的就是这句
  if (speech.queue.some((q) => q.key === key)) { speech.skipped++; noteSpeak('skip-queued', line); return; }
  noteSpeak('enqueue', line, `ts=${ts}`);
  window.__speech = speech;
  speech.queue.push({ key, line });
  while (speech.queue.length > 3) speech.queue.shift();   // 别积压太多
  pumpSpeech();
}

async function pumpSpeech() {
  if (speech.pumping) return;                     // ⚠️ 同步锁：必须在上任何 await 之前就占住
  if (voicePlaying || !speech.queue.length) return;
  speech.pumping = true;
  const item = speech.queue.shift();
  try {
  speech.playingKey = item.key;
  speech.started++;
  noteSpeak('start', item.line);
    recentlySpoken.set(item.key, performance.now());
    say(item.line, Math.min(20, 4 + item.line.length / 18));   // 气泡和声音同时起
    speakFor(item.line);
    state.smile = 0.35;
    const ok = await playHerVoice(item.line);
    if (!ok) speech.playingKey = '';
  } finally {
    speech.pumping = false;
  }
  if (!voicePlaying && speech.queue.length) pumpSpeech();
}

onSpeechDone = () => {
  if (speech.playingKey) recentlySpoken.set(speech.playingKey, performance.now());
  speech.playingKey = '';
  setTimeout(pumpSpeech, 150);
};

function sampleMouth() {
  if (!analyser) return 0;
  analyser.getByteTimeDomainData(analyserBuf);
  let sum = 0;
  for (let i = 0; i < analyserBuf.length; i++) {
    const x = (analyserBuf[i] - 128) / 128;
    sum += x * x;
  }
  const rms = Math.sqrt(sum / analyserBuf.length);
  return Math.max(0, Math.min(1, rms * 4.6));
}

// ── 说话时的肢体语言（手势层）─────────────────────────────────────
// 思路：不播固定动作，而是"每 1~2.5 秒挑一个小手势"，
//      幅度跟着当前语音能量走，进出用缓动包络 —— 所以每句话都不一样、还跟声音同步。
//   ⚠️ 只用安全的旋转轴：手臂的 z 会把裙子拽变形，手势一律走 x / 头颈走 x·z。
const smoothstep = (t) => t * t * (3 - 2 * t);
const GESTURES = [
  // 点头
  (p, env, k) => ({ 首: { x: Math.sin(p * Math.PI * 2) * 0.20 * k * env }, 頭: { x: Math.sin(p * Math.PI * 2) * 0.13 * k * env } }),
  // 歪头听你说
  (p, env, k) => ({ 首: { z: Math.sin(p * Math.PI) * 0.26 * k * env }, 頭: { z: Math.sin(p * Math.PI) * 0.16 * k * env } }),
  // 抬起一只手比划（用"肩 + 肘"的小幅 z，正面看得见又不会拽裙子）
  (p, env, k) => {
    const w = Math.sin(p * Math.PI);
    return {
      右肩: { z: -0.30 * w * env * k },
      右腕: { z: -0.20 * w * env * k, x: -0.26 * w * env * k },
      右ひじ: { z: 0.78 * w * env * k, x: 0.16 * w * env * k },
      上半身: { z: -0.04 * w * env * k, y: -0.04 * w * env * k },
      首: { y: 0.05 * w * env * k },
    };
  },
  // 两只手一起（摊手/比划）
  (p, env, k) => {
    const w = Math.sin(p * Math.PI);
    return {
      左肩: { z: 0.28 * w * env * k }, 右肩: { z: -0.28 * w * env * k },
      左腕: { z: 0.18 * w * env * k, x: -0.10 * w * env * k },
      右腕: { z: -0.18 * w * env * k, x: -0.10 * w * env * k },
      左ひじ: { z: -0.70 * w * env * k }, 右ひじ: { z: 0.70 * w * env * k },
      上半身: { x: 0.03 * w * env * k },
    };
  },
  // 身体前倾，认真讲
  (p, env, k) => ({
    上半身: { x: 0.13 * env * k },
    上半身2: { x: 0.08 * env * k },
    首: { x: -0.09 * env * k },
  }),
  // 轻轻耸肩 + 摇头
  (p, env, k) => ({
    左肩: { z: 0.14 * env * k },
    右肩: { z: -0.14 * env * k },
    首: { y: Math.sin(p * Math.PI * 2) * 0.13 * env * k },
  }),
];

const gesture = { idx: -1, t: 0, dur: 1.2, next: 0, weight: 0, target: 0 };

function tickGesture(dt) {
  if (!GESTURES_ON) return null;   // 2026-10-11 用户点单：说话动作整套停用（?gestures=1 可恢复）
  // 说话（有声音）或有台词气泡时都算"在讲话"，这时候才比划
  const now = performance.now() / 1000;
  const speaking = voicePlaying || now < state.speakingUntil || now < state.bubbleUntil;
  gesture.target = speaking ? 1 : 0;
  gesture.weight += (gesture.target - gesture.weight) * Math.min(1, dt * 3.2);   // 平滑进出
  if (gesture.weight < 0.01) { gesture.idx = -1; return null; }
  if (gesture.locked) {                      // 调试用：锁住某个手势
    gesture.t += dt;
    const pl = Math.min(1, gesture.t / 1.6);
    const envL = Math.min(1, pl * 4);
    return GESTURES[gesture.idx](pl * 0.35, envL, 1);
  }
  if (gesture.idx < 0 || gesture.t > gesture.dur) {
    // 换一个手势（不连着用同一个）
    let pick = Math.floor(Math.random() * GESTURES.length);
    if (pick === gesture.idx) pick = (pick + 1 + Math.floor(Math.random() * (GESTURES.length - 1))) % GESTURES.length;
    gesture.idx = pick;
    gesture.t = 0;
    gesture.dur = 0.9 + Math.random() * 1.5;
  }
  gesture.t += dt;
  const p = Math.min(1, gesture.t / gesture.dur);
  const env = smoothstep(Math.min(1, p * 3)) * smoothstep(Math.min(1, (1 - p) * 3));  // 两头都缓
  const energy = 0.95 + audioLevel * 1.1;      // 说话大声 -> 手势明显（原来 0.65 起，几乎看不出来）
  if (voicePlaying) audioLevel = sampleMouth();
  return GESTURES[gesture.idx](p, env, energy * gesture.weight);
}

/** 把一句话交给她（与输入框发送同一条队列；displayText 可自定义气泡文案） */
function sendText(text, displayText) {
  const msg = String(text || '').trim();
  if (!msg) return;
  pendingSends.push(msg);
  say(displayText || ('你：' + msg), 2);
  updateSendButton();
  runSendQueue();
}

async function sendToHer() {
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  sendText(text);
}

// 发送串行化：同一时刻只允许一个请求在路上（否则两条回复会交错、还可能被超时中断）
const pendingSends = [];
let sending = false;

function updateSendButton() {
  sendBtn.disabled = sending;
  input.placeholder = sending ? '她正在想…' : '跟娅娅说点什么…（Enter 发送，Esc 收起）';
}

async function runSendQueue() {
  if (sending || !pendingSends.length) return;
  sending = true;
  updateSendButton();
  const text = pendingSends.shift();
  try {
    const data = await window.pet.say(text);
    if (data?.ok) {
      const reply = String(data.reply || '').trim();
      const recent = Array.isArray(data.recent) ? data.recent : [];
      const newestSelf = recent
        .filter((m) => !!(m.self ?? m.isSelf))
        .reduce((m, r) => Math.max(m, Number(r.ts ?? r.time) || 0), 0);
      if (reply) {
        enqueueSpeech(reply, newestSelf);        // 念一遍，并记住"这批已经说过"
      } else {
        say('（她这次没接话）', 3);
      }
      const newest = recent.reduce((m, r) => Math.max(m, Number(r.ts ?? r.time) || 0), lastSeenTs);
      lastSeenTs = newest;
      if (newestSelf) speech.spokenTs = Math.max(speech.spokenTs, newestSelf);
    } else {
      say('接不上她：' + (data?.error || '未知错误'), 6);
    }
  } catch (err) {
    say('接不上她：' + (err?.message || err), 6);
  } finally {
    sending = false;
    updateSendButton();
    if (document.body.classList.contains('chat')) input.focus();
    if (pendingSends.length) runSendQueue();
  }
}

// 她在 QQ 私聊里说的话，也会在桌面上冒出来
async function pollHerMessages() {
  if (polling) return;
  polling = true;
  try {
    const data = await window.pet.recent();
    if (data?.ok && Array.isArray(data.messages)) {
      const msgs = data.messages
        .map((m) => ({ ts: Number(m.ts ?? m.time) || 0, self: !!(m.self ?? m.isSelf), text: String(m.text ?? '') }))
        .filter((m) => m.ts && m.text);
      const newest = msgs.reduce((mx, m) => Math.max(mx, m.ts), 0);
      if (!lastSeenTs) {
        lastSeenTs = newest;            // 第一轮只记水位，不补历史
      } else {
        const fresh = msgs.filter((m) => m.ts > lastSeenTs && m.self);
        if (fresh.length) {
          lastSeenTs = newest;
          // 逐条排队：一条念完再念下一条，不会叠在一起
          for (const m of fresh) enqueueSpeech(m.text, m.ts);
        } else if (newest > lastSeenTs) {
          lastSeenTs = newest;
        }
      }
    }
  } catch { /* 网络抖动就下一轮再说 */ } finally {
    polling = false;
  }
}

sendBtn.addEventListener('click', sendToHer);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); sendToHer(); }
  if (e.key === 'Escape') { e.preventDefault(); closeComposer(); }
});

// ── 她的"耳朵"：按住 🎤 说话（2026-10-11 语音对讲）──────────────────
// 录音（webm/opus）→ 重采样成 16k 单声道 WAV → 主进程 whisper.cpp 转写 → 进现有发送队列
const rec = { active: false, mr: null, stream: null, chunks: [], t0: 0 };

// 2026-10-11 用户点单：语音两种模式（按住 / 免提）+ 位置锁
let posLocked = false;
try { posLocked = localStorage.getItem('posLocked') === '1'; } catch { /* 忽略 */ }
function getVoiceMode() { try { return localStorage.getItem('voiceMode') === 'hands' ? 'hands' : 'hold'; } catch { return 'hold'; } }
function reportUiState() { window.pet?.uiState?.({ locked: posLocked, voiceMode: getVoiceMode(), form: formKey }); }
reportUiState();
const hf = { on: false, stream: null, ctx: null, analyser: null, mr: null, chunks: [], speech: false, lastVoice: 0, t0: 0, timer: null, floor: 0.008, level: 0 };

async function blobToWav16k(blob) {
  const arr = await blob.arrayBuffer();
  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = new AC();
  let buf;
  try {
    buf = await ctx.decodeAudioData(arr);
  } finally {
    try { ctx.close(); } catch { /* 忽略 */ }
  }
  const sr = 16000;
  const n = Math.max(1, Math.ceil(buf.duration * sr));
  const off = new OfflineAudioContext(1, n, sr);
  const src = off.createBufferSource();
  src.buffer = buf;
  src.connect(off.destination);
  src.start();
  const rendered = await off.startRendering();
  const data = rendered.getChannelData(0);
  const out = new ArrayBuffer(44 + data.length * 2);
  const v = new DataView(out);
  const wstr = (o, s) => { for (let i = 0; i < s.length; i += 1) v.setUint8(o + i, s.charCodeAt(i)); };
  wstr(0, 'RIFF'); v.setUint32(4, 36 + data.length * 2, true); wstr(8, 'WAVE');
  wstr(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  wstr(36, 'data'); v.setUint32(40, data.length * 2, true);
  let o = 44;
  for (let i = 0; i < data.length; i += 1, o += 2) {
    const s = Math.max(-1, Math.min(1, data[i]));
    v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(out);
}

async function startListening() {
  if (rec.active) return;
  if (voicePlaying) { say('等她说完再按住说哦～', 3); return; }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    rec.stream = stream;
    rec.chunks = [];
    const mime = (window.MediaRecorder && MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) ? 'audio/webm;codecs=opus' : undefined;
    const mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    rec.mr = mr;
    mr.ondataavailable = (e) => { if (e.data && e.data.size) rec.chunks.push(e.data); };
    mr.start();
    rec.active = true;
    rec.t0 = performance.now();
    micBtn?.classList.add('listening');
    say('（正在听你说…松开就发给她）', 120);
  } catch (err) {
    say('麦克风起不来：' + (err?.message || err), 6);
  }
}

// 公共尾巴：blob → 文字（成功返回文字；空/失败返回 ''，气泡由这里负责）
async function transcribeBlob(blob) {
  say('（正在认字…）', 60);
  let text = '';
  try {
    const wav = await blobToWav16k(blob);
    const r = await window.pet.asr(wav);
    if (!r?.ok) { say('没听清：' + (r?.error || '识别失败'), 6); return ''; }
    text = String(r.text || '').trim();
  } catch (err) {
    say('没听清：' + (err?.message || err), 6);
    return '';
  }
  if (!text || /^[。,.，、!?！？…\s]*$/.test(text)) { say('（没听清你说啥，再来一次？）', 4); return ''; }
  if (window.__voiceMute) { say('（测得的文字：' + text + '）', 8); return ''; }  // 联测用：只显示不发送
  return text;
}

async function stopListening() {
  if (!rec.active || !rec.mr) return undefined;
  rec.active = false;
  micBtn?.classList.remove('listening');
  const mr = rec.mr;
  const stopped = new Promise((r) => { mr.onstop = r; });
  try { mr.stop(); } catch { /* 忽略 */ }
  await stopped;
  try { rec.stream?.getTracks().forEach((t) => t.stop()); } catch { /* 忽略 */ }
  const durMs = performance.now() - rec.t0;
  rec.mr = null;
  rec.stream = null;
  const blob = new Blob(rec.chunks, { type: 'audio/webm' });
  rec.chunks = [];
  if (durMs < 350 || blob.size < 1200) { say('（太短啦，按住多说几个字～）', 4); return undefined; }
  const text = await transcribeBlob(blob);
  if (text) sendText(text);
  return text || undefined;
}

// ── 免提对话（2026-10-11 用户点单）─────────────────────────────────
// 常开麦：检测到说话就录一小段，说完静音 ~1.2 秒自动转写发送；她说话/等回复时自动闭麦。
async function handsFreeStart() {
  if (hf.on || rec.active) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    hf.stream = stream;
    const AC = window.AudioContext || window.webkitAudioContext;
    hf.ctx = new AC();
    const src = hf.ctx.createMediaStreamSource(stream);
    hf.analyser = hf.ctx.createAnalyser();
    hf.analyser.fftSize = 1024;
    src.connect(hf.analyser);
    hf.on = true;
    hf.speech = false;
    micBtn?.classList.add('handsfree');
    say('（免提开着——直接说就行；再点 🎤 就关）', 6);
    hf.timer = setInterval(hfTick, 80);
  } catch (err) {
    say('麦克风起不来：' + (err?.message || err), 6);
  }
}

function handsFreeStop(quiet = false) {
  if (!hf.on) return;
  hf.on = false;
  if (hf.timer) { clearInterval(hf.timer); hf.timer = null; }
  if (hf.mr) { try { hf.mr.onstop = null; hf.mr.stop(); } catch { /* 忽略 */ } hf.mr = null; }
  hf.chunks = [];
  hf.speech = false;
  try { hf.stream?.getTracks().forEach((t) => t.stop()); } catch { /* 忽略 */ }
  try { hf.ctx?.close(); } catch { /* 忽略 */ }
  hf.stream = null;
  hf.ctx = null;
  hf.analyser = null;
  micBtn?.classList.remove('handsfree');
  if (!quiet) say('（免提关掉了）', 4);
}

function hfTick() {
  if (!hf.on || !hf.analyser) return;
  // 2026-10-11 放宽：只有她"正在出声"才必须让麦（防回声）；
  // 之前连"等回复中(sending)"也闭麦，导致陪看/聊天时你说什么她都收不到。
  const micHold = voicePlaying;
  micBtn?.classList.toggle('wait', hf.on && micHold);
  if (micHold) {
    if (hf.mr) { try { hf.mr.onstop = null; hf.mr.stop(); } catch { /* 忽略 */ } hf.mr = null; }
    hf.chunks = [];
    hf.speech = false;
    return;
  }
  const data = new Uint8Array(hf.analyser.fftSize);
  hf.analyser.getByteTimeDomainData(data);
  let sum = 0;
  for (let i = 0; i < data.length; i += 1) { const x = (data[i] - 128) / 128; sum += x * x; }
  const rms = Math.sqrt(sum / data.length);
  hf.level = rms;
  const now = performance.now();
  // 自适应环境噪声：门限 = max(0.016, 噪声底×2.2)（原来写死 0.03，小声说话会漏）
  if (!hf.mr) hf.floor = Math.min(0.05, hf.floor * 0.96 + rms * 0.04 + 0.00002);
  const loud = rms > Math.max(0.016, hf.floor * 2.2);
  if (loud) {
    hf.lastVoice = now;
    if (!hf.mr) {
      hf.chunks = [];
      const mime = (window.MediaRecorder && MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) ? 'audio/webm;codecs=opus' : undefined;
      const mr = new MediaRecorder(hf.stream, mime ? { mimeType: mime } : undefined);
      mr.ondataavailable = (e) => { if (e.data && e.data.size) hf.chunks.push(e.data); };
      mr.start();
      hf.mr = mr;
      hf.speech = true;
      hf.t0 = now;
    }
  } else if (hf.mr && hf.speech && now - hf.lastVoice > 1200) {
    hfStopSegment();
  } else if (hf.mr && hf.speech && now - hf.t0 > 20000) {
    hfStopSegment();                      // 单段太长就掐掉，别无限录
  }
}

async function hfStopSegment() {
  const mr = hf.mr;
  if (!mr) return;
  hf.mr = null;
  hf.speech = false;
  const stopped = new Promise((r) => { mr.onstop = r; });
  try { mr.stop(); } catch { /* 忽略 */ }
  await stopped;
  const blob = new Blob(hf.chunks, { type: 'audio/webm' });
  hf.chunks = [];
  if (blob.size < 2500) return;           // 太短（咳嗽/杂音）就算了
  const text = await transcribeBlob(blob);
  if (text) sendText(text);
}

if (micBtn) {
  micBtn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (getVoiceMode() === 'hands') return;      // 免提模式：用单击开关
    try { micBtn.setPointerCapture(e.pointerId); } catch { /* 忽略 */ }
    startListening();
  });
  const stopMic = (e) => { if (rec.active) { e.preventDefault?.(); stopListening(); } };
  micBtn.addEventListener('pointerup', stopMic);
  micBtn.addEventListener('pointercancel', stopMic);
  micBtn.addEventListener('lostpointercapture', () => { if (rec.active) stopListening(); });
  micBtn.addEventListener('click', () => {
    if (getVoiceMode() !== 'hands') return;
    if (hf.on) handsFreeStop();
    else handsFreeStart();
  });
  micBtn.addEventListener('contextmenu', (e) => e.preventDefault());
}

// ── 快速调大小的小按钮（鼠标挨着她时出现，2026-10-11 用户点单）─────
const sizeCtl = document.getElementById('sizeCtl');
function sizeCtlShow(on) { sizeCtl?.classList.toggle('show', !!on); }
function positionSizeCtl() {
  if (!sizeCtl || !sizeCtl.classList.contains('show') || !lastRect) return;
  const x = Math.max(6, Math.min(window.innerWidth - 44, lastRect.x + lastRect.w - 38));
  const y = Math.max(6, Math.min(window.innerHeight - 84, lastRect.y + lastRect.h * 0.30));
  sizeCtl.style.left = Math.round(x) + 'px';
  sizeCtl.style.top = Math.round(y) + 'px';
}
document.getElementById('sizeUp')?.addEventListener('click', (e) => { e.stopPropagation(); window.pet?.scale?.(1.08); });
document.getElementById('sizeDown')?.addEventListener('click', (e) => { e.stopPropagation(); window.pet?.scale?.(1 / 1.08); });
sizeCtl?.addEventListener('pointerdown', (e) => e.stopPropagation());

// ── 锁定位置（防误拖，2026-10-11 用户点单）──────────────────────────
function toggleLock() {
  posLocked = !posLocked;
  try { localStorage.setItem('posLocked', posLocked ? '1' : '0'); } catch { /* 忽略 */ }
  if (posLocked) window.pet?.walkStop?.();
  reportUiState();
  say(posLocked ? '（位置锁上了——放心，戳我不动窝）' : '（解锁啦，可以拖我了）', 4);
}

// 坐姿加高窗口（2026-10-11 用户点单：透明框拉高一点，给头顶留空间）
let sitTall = false;
function syncSitTall() {
  const want = postureTarget === 'sit';
  if (want !== sitTall) { sitTall = want; window.pet?.sitTall?.(want); }
}

// 陪看两档（2026-10-11 用户点单）：话痨 / 安静；默认记住上次选的那档
function getWatchMode() { try { return localStorage.getItem('watchMode') === 'chatty' ? 'chatty' : 'quiet'; } catch { return 'quiet'; } }
function startWatch(mode) {
  const m = mode === 'chatty' ? 'chatty' : 'quiet';
  try { localStorage.setItem('watchMode', m); } catch { /* 忽略 */ }
  setPosture('sit');
  sendText('陪我看会儿');
  say(m === 'chatty' ? '（陪看·话痨版——她会多念叨几句）' : '（陪看·安静版——静静陪你看）', 6);
  const t0 = Date.now();
  const iv = setInterval(() => {
    // 等这轮发送落地（她回话完）再把陪看参数换成对应档，避免和文本默认档互相顶掉
    if (!sending || Date.now() - t0 > 90000) {
      clearInterval(iv);
      window.pet?.watchPreset?.(m);
    }
  }, 800);
}

// ── 鼠标交互（窗口默认穿透，只有指向她时才接管）─────────────────────
let pointerDownAt = null;
let dragging = false;

canvas.addEventListener('pointerdown', (e) => {
  if (e.button === 2) return;
  pointerDownAt = { x: e.clientX, y: e.clientY };
  dragging = false;
});
canvas.addEventListener('pointermove', (e) => {
  if (!pointerDownAt) return;
  if (posLocked) return;                 // 锁定位置：拖不动（2026-10-11 用户点单）
  if (!dragging && Math.hypot(e.clientX - pointerDownAt.x, e.clientY - pointerDownAt.y) > 6) {
    dragging = true;
    window.pet?.dragStart();
  }
});
canvas.addEventListener('pointerup', () => {
  if (dragging) {
    window.pet?.dragEnd();
  } else if (pointerDownAt) {
    const now = performance.now();
    if (now - (onPoke.lastClick || 0) < 350) {
      onPoke.lastClick = 0;
      openComposer();
    } else if (drowsy.on) {
      // 睡着的时候被戳 → 一激灵醒过来（"突然惊醒"的手动版）
      onPoke.lastClick = now;
      exitDrowsy(true);
      say('（猛地惊醒）……我没睡着哦。', 3);
    } else {
      onPoke.lastClick = now;
      onPoke();
    }
  }
  pointerDownAt = null;
  dragging = false;
});
// ⚠️ 兜底：鼠标在她窗口外面松开 / 指针被系统取消 / 窗口失焦时，画布收不到 pointerup，
//    主进程会一直以为"还在拖拽"，于是每 16ms 按旧偏移钉住窗口 —— 实测能把她钉到屏幕外面
//    （y=−784，看着就像"坐/趴/蹲沉下去了"）。这几个监听专门用来收尾。
const endDragSafely = () => {
  pointerDownAt = null;
  if (!dragging) return;
  dragging = false;
  window.pet?.dragEnd();
};
window.addEventListener('pointerup', endDragSafely);
window.addEventListener('pointercancel', endDragSafely);
window.addEventListener('blur', endDragSafely);
window.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  window.pet?.contextMenu();
});

// ── 把她的矩形报给主进程（做鼠标穿透）─────────────────────────────
// （"坐着时屁股底下的泡泡"2026-10-10 晚按用户要求整套移除——想恢复可从
//   main.js.bak-20261010-sit2 里把这段拣回来。）
let lastRect = null;
function reportHitRect() {
  if (!mesh) return;
  mesh.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(mesh);
  const xs = [];
  const ys = [];
  for (const x of [box.min.x, box.max.x]) {
    for (const y of [box.min.y, box.max.y]) {
      for (const z of [box.min.z, box.max.z]) {
        const v = new THREE.Vector3(x, y, z).project(camera);
        xs.push((v.x + 1) / 2 * window.innerWidth);
        ys.push((1 - v.y) / 2 * window.innerHeight);
      }
    }
  }
  const rect = {
    x: Math.max(0, Math.min(...xs)),
    y: Math.max(0, Math.min(...ys)),
    w: 0,
    h: 0,
  };
  rect.w = Math.min(window.innerWidth, Math.max(...xs)) - rect.x;
  rect.h = Math.min(window.innerHeight, Math.max(...ys)) - rect.y;
  const changed = !lastRect || Math.abs(rect.x - lastRect.x) > 2 || Math.abs(rect.y - lastRect.y) > 2
    || Math.abs(rect.w - lastRect.w) > 2 || Math.abs(rect.h - lastRect.h) > 2;
  if (changed) {
    lastRect = rect;
    window.pet?.hitRect(rect);
    window.__hitRect = rect;
  }
}

// 像素级命中判定：只有鼠标真的压在她身上时才接管鼠标，
// 否则窗口保持穿透（可以点到底下的桌面/浏览器）
let cursorPos = null;
let lastInteractive = null;
window.addEventListener('mousemove', (e) => {
  cursorPos = { x: e.clientX, y: e.clientY };
});

function updateInteractive() {
  if (!cursorPos || !mesh) return;
  if (state.composerOpen) {                       // 打字时窗口必须接管鼠标
    if (lastInteractive !== true) {
      lastInteractive = true;
      window.pet?.setInteractive(true);
    }
    return;
  }
  const r = lastRect;
  let interactive = false;
  if (r && cursorPos.x >= r.x && cursorPos.x <= r.x + r.w && cursorPos.y >= r.y && cursorPos.y <= r.y + r.h) {
    const gl = renderer.getContext();
    const dpr = renderer.getPixelRatio();
    const px = Math.floor(cursorPos.x * dpr);
    const py = Math.floor((window.innerHeight - cursorPos.y) * dpr);
    const buf = new Uint8Array(4);
    try {
      gl.readPixels(px, py, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      interactive = buf[3] > 32;      // 有像素的地方才算"她"
    } catch {
      interactive = true;
    }
  }
  if (interactive !== lastInteractive) {
    lastInteractive = interactive;
    window.pet?.setInteractive(interactive);
    window.__interactive = interactive;
  }
}

// ── 椅子（2026-10-10 用户点单：坐着的时候给她一把椅子）──────────────
// 全用基础几何拼的：四条金腿 + 白框 + 软粉坐垫 + 金色圆环靠背（配她的配色）。
// 只在她「坐着」时淡入；坐垫顶面自动贴到屁股底下、椅腿自动落到"地板"（≈她站立脚底）。
// 刻度/落点能现场调：window.__chairCfg（下一帧生效）；__chairReset() 让她下次坐时重新落位。
const chairCfg = {
  seatW: 4.8,            // 坐垫宽（要宽过她的裙摆，两侧才露得出来）
  seatD: 3.0,            // 坐垫深（浅一点：前缘别顶出她裙子外面）
  seatTopOffset: 0.78,   // 坐垫顶面 = 骨盆高度 − 这个数
  floorY: 0.55,          // 椅脚落在"地板"上的高度（≈她站立时的脚底）
  backZ: 0.3,            // 靠背离坐垫后缘往里多少
  backTop: 3.3,          // 靠背顶（相对坐垫顶的高度；≈她坐着的肩膀一带，不再做过高的大靠背）
  backW: 4.4,            // 靠背宽
};
const chair = new THREE.Group();
const chairMats = [];
const chairLegs = [];
function buildChair() {
  chair.clear();
  chairMats.length = 0;
  chairLegs.length = 0;
  // ⚠️ 这个场景没有环境贴图，metalness 高了会发黑 —— 用低金属度提亮金
  const gold = new THREE.MeshStandardMaterial({ color: 0xe6c07a, metalness: 0.25, roughness: 0.42, transparent: true, opacity: 0 });
  const ivory = new THREE.MeshStandardMaterial({ color: 0xf4f0e8, roughness: 0.6, transparent: true, opacity: 0 });
  const blush = new THREE.MeshStandardMaterial({ color: 0xf5c6cf, roughness: 0.85, transparent: true, opacity: 0 });
  chairMats.push(gold, ivory, blush);
  const W = chairCfg.seatW; const D = chairCfg.seatD;
  // 软坐垫：压扁的球（顶面贴着本地 y=0）
  const pillow = new THREE.Mesh(new THREE.SphereGeometry(W / 2, 24, 16), blush);
  pillow.scale.set(1, 0.38, D / W);
  pillow.position.y = -(W / 2) * 0.38;
  chair.add(pillow);
  // 白框（坐垫底下的板）
  const board = new THREE.Mesh(new THREE.BoxGeometry(W - 0.25, 0.22, D - 0.2), ivory);
  board.position.y = -(W / 2) * 0.38 * 2 - 0.05;
  chair.add(board);
  // 四条金腿：单位长（顶端在本地 y=0、往下长 1），落位时按高度 scale.y
  const legGeo = new THREE.CylinderGeometry(0.1, 0.145, 1, 10);
  legGeo.translate(0, -0.5, 0);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const leg = new THREE.Mesh(legGeo, gold);
    leg.position.set(sx * (W / 2 - 0.32), board.position.y - 0.1, sz * (D / 2 - 0.28));
    leg.rotation.z = -sx * 0.045;
    leg.rotation.x = sz * 0.045;
    chairLegs.push(leg);
    chair.add(leg);
  }
  // 靠背：正常高度（顶在她坐着的肩膀一带）——金框 + 软粉背板
  const backCz = -(D / 2) + chairCfg.backZ;
  const backTop = chairCfg.backTop;
  const backW = chairCfg.backW;
  const backPad = new THREE.Mesh(new THREE.BoxGeometry(backW, backTop - 0.6, 0.3), blush);
  backPad.position.set(0, (backTop - 0.6) / 2 + 0.25, backCz);
  chair.add(backPad);
  const backRail = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, backW + 0.15, 12), gold);
  backRail.rotation.z = Math.PI / 2;
  backRail.position.set(0, backTop, backCz);
  chair.add(backRail);
  for (const sx of [-1, 1]) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, backTop - 0.3, 10), gold);
    post.position.set(sx * (backW / 2), (backTop - 0.3) / 2 + 0.15, backCz);
    chair.add(post);
  }
  chair.visible = false;
}
buildChair();
scene.add(chair);
window.__chair = chair;
window.__chairCfg = chairCfg;
window.__chairRebuild = () => { buildChair(); chairPlaced = false; };
let chairFade = 0;
let chairPlaced = false;
window.__chairReset = () => { chairPlaced = false; };
window.__chairDbg = () => ({ placed: chairPlaced, fade: Number(chairFade.toFixed(2)), rem: Number(poseRemainder.toFixed(3)), vis: chair.visible });
function updateChair(dt) {
  const want = CHAIR_ON && postureTarget === 'sit';   // 2026-10-11 用户点单：椅子整套关掉（?chair=1 可恢复）
  if (want && !chairPlaced && poseRemainder < 0.02 && bones['下半身']) {
    // 落位：坐垫顶面贴屁股、椅腿落到地板（都在她的画布坐标系里，窗口挪了也不跑）
    const V = bones['下半身'].position.constructor;
    const hip = bones['下半身'].getWorldPosition(new V());
    const seatTop = hip.y - chairCfg.seatTopOffset;
    chair.position.set(hip.x, seatTop, hip.z - 0.12);
    const legTopLocal = chairLegs[0].position.y;
    const legLen = Math.max(0.8, seatTop - chairCfg.floorY + legTopLocal);
    for (const leg of chairLegs) leg.scale.y = legLen;
    chairPlaced = true;
  }
  chairFade += ((want ? 1 : 0) - chairFade) * Math.min(1, dt * 3.0);
  chair.visible = chairFade > 0.01;
  if (chair.visible) for (const m of chairMats) m.opacity = Math.max(0, Math.min(1, chairFade));
  if (!want && chairFade < 0.02) chairPlaced = false;
}

// ── 主循环 ─────────────────────────────────────────────────────────
let hitTimer = 0;
function tick() {
  const dt = Math.min(0.05, clock.getDelta());
  const t = clock.elapsedTime;
  // 跨屏拖动时 devicePixelRatio 会变（如 1x 外接屏 ↔ 1.5x/2x 笔记本屏）。
  // 只在启动时设一次的话，拖过去后备缓冲还是旧 DPR，整只角色发虚。
  // 每帧一次数值比较可忽略；真变化时 setPixelRatio 才重建缓冲。上限来自 ?dpr=（默认 2）。
  const dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
  if (dpr !== renderer.getPixelRatio()) renderer.setPixelRatio(dpr);
  if (mesh) {
    applyIdle(dt, t);
    sparseMorphController?.update();
    tickBehavior(dt);
    tickDrowsy();               // 困的自动进出：没动静就犯困、人回来就惊醒
    updateChair(dt);            // 椅子：坐着时淡入，坐垫自动落到她屁股底下
    hitTimer += dt;
    // 2026-10-25：0.12s → 0.25s。命中矩形只在"她在窗口内移动"时变化（走路/换姿势），
    // 0.25s 的陈旧度对悬停判定无感；渲染层→主进程的常驻 IPC 频次减半。
    if (hitTimer > 0.25) { hitTimer = 0; reportHitRect(); }
    updateInteractive();
    positionSizeCtl();          // 大小按钮跟着她挪（2026-10-11）
    syncSitTall();              // 坐姿加高/还原窗口（2026-10-11）
  }
  if (state.bubbleUntil && performance.now() / 1000 > state.bubbleUntil) {
    bubbleEl.classList.remove('show');
    state.bubbleUntil = 0;
  }
  window.__mouth = Number(mouthValue.toFixed(3));
  window.__voicePlaying = voicePlaying;
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

// ── 加载模型 ───────────────────────────────────────────────────────
status('加载中：' + form[2]);
// ── 内存优化（2026-10-22）：morph 白名单前置到 GeometryBuilder ─────────
// 红色 PMX 自带 232 个 morph，全身 position 缓冲约 257 MiB；应用只用 16 个名字。
// 且 setMorph 对缺失 morph 安全 no-op。旧做法是加载完再裁 morph 缓冲，
// 峰值内存照样爆；现在交给 MMDLoader，在生成 morph attribute 之前就只产出这 16 个。
// 默认加载器行为不变：只有显式 setMorphWhitelist 才会过滤。
const MORPH_ALLOW = ['まばたき', 'left', 'right', 'up', 'down',
  'あ', 'い', 'う', 'え', 'お', '口', 'にこり', '笑い', '照れ', 'びっくり', '笑い目'];
const mmdLoader = new MMDLoader();
mmdLoader.setMorphWhitelist(MORPH_ALLOW);
mmdLoader.load(
  modelUrl,
  (loaded) => {
    mesh = loaded;
    scene.add(mesh);
    // ── 清晰度（2026-10-25）：贴图各向异性过滤 ──────────────────────
    // MMDLoader 产出的贴图默认 anisotropy=1：正对相机没问题，但袖口/裙摆/头发
    // 这类斜视角表面，1024 贴图被压进几百像素高的窗口里会明显发糊。
    // 在首帧渲染前设置（此时贴图尚未上传 GPU），首次上传即生效，无重传成本。
    // 代价可忽略（现代 GPU 各向异性采样是硬件能力），不增加显存。
    // gradientMap（toon 渐变查找表）不动：NearestFilter 是它的语义要求。
    {
      const maxAniso = renderer.capabilities.getMaxAnisotropy();
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        if (!material) continue;
        for (const key of ['map', 'matcap']) {
          const t = material[key];
          if (t && t.isTexture) t.anisotropy = maxAniso;
        }
      }
      window.__maxAnisotropy = maxAniso;   // 调试/验收用
    }
    // ── 形态条件化材质修复（2026-10-25）：黑娅娅胸口"声痕"镂空板透桌面 ──
    // 现象：blue 形态胸口星形饰件区域半透明，桌面文字穿透（用户截图 + blue-before-capture.png
    // 品红底透色都在同一位置）；red/solar5/white 无此症状。
    // 依据（research/blue-transparency-fix-2026-10-25/，全部为脚本实测）：
    //   · 材质表对照（dump-materials.mjs）：蓝模 28 个、红模 33 个材质的 PMX diffuse alpha
    //     全部 = 1.0，按名对齐无可疑差值——不存在"不透明度被调低"，改 opacity 无对象可修。
    //   · 「声痕」（蓝模材质表 idx 16）是蓝模独有材质，红模/solar5/white 的材质表里都没有
    //     （逐个解析核对过）。它的贴图 tex/T_R2T1DaniyaMd10011Fx_D.png 使用区 656 个采样点
    //     alpha 直方图 = {0:323, 1-127:3, 128-252:20, 253-254:2, 255:308}——一块比星形大的
    //     镂空板（约一半全透明），透明区 RGB 纯黑（check-textures.mjs / finalize.mjs）。
    //   · 机制：MMDLoader 给所有 MMD 材质恒设 CustomBlending+SrcAlpha（MMDLoader.js:1221-1225），
    //     three.module.js:23240 只对 NormalBlending&&!transparent 关混合 → 贴图 alpha 直接
    //     写进画布 alpha；透明窗口合成时 alpha<1 的像素就让桌面透进来。且镂空片元仍写深度，
    //     把她胸口皮肤挡在深度测试外，皮肤补不上来 → 文字穿透"身体"。
    // 修法：alphaTest=0.5 镂空。alpha<0.5 的片元整片 discard（不写色、不写深度）→ 身后皮肤
    //     正常渲染；星形主体（alpha=255）完全不透明。直方图 0/255 两极分布，0.5 阈值两侧都
    //     干净；透明区 RGB 本来就是黑色，也不存在"强制不透明露出黑底"的副作用。
    // 安全性：formKey==="blue" 且材质名精确匹配「声痕」双重限定；眼睛高光（hi li/hi*.png）、
    //     头发高光（*_hi.png）、圈、emo 这些两形态一致且本来就该镂空的材质一律不动；
    //     不复制贴图（零额外显存），不改共享 shader。
    if (formKey === 'blue') {
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        if (material?.name !== '声痕') continue;
        material.alphaTest = 0.5;                  // 驱动 USE_ALPHATEST（three.module.js:20574→20005）
        if (material.uniforms?.alphaTest) material.uniforms.alphaTest.value = 0.5; // ShaderMaterial 的 uniform 不会被 renderer 自动同步（refreshUniformsCommon 只管内置材质）
        material.needsUpdate = true;
      }
    }
    morphs = { dict: mesh.morphTargetDictionary || {}, inf: mesh.morphTargetInfluences || [] };
    if (params.get('morph') !== 'dense') sparseMorphController = createSparseMorphController(mesh);
    window.__sparseMorphStats = sparseMorphController?.stats || { mode: 'dense' };
    window.__sparseMorphUpdate = () => sparseMorphController?.update();
    if (sparseMorphController) {
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of materials) if (material) material.needsUpdate = true;
    }
    // 调试/验收：原始 vs 实际生成的 morph 数与字节
    const morphStats = mesh.geometry.userData?.MMD?.morphStats || null;
    window.__morphStats = morphStats;
    if (morphStats) {
      console.log(`[morph] 原始 ${morphStats.sourceMorphCount} 个 / `
        + `${(morphStats.sourceBytes / 1048576).toFixed(1)} MiB → 生成 `
        + `${morphStats.generatedMorphCount} 个 / ${(morphStats.generatedBytes / 1048576).toFixed(1)} MiB`);
    }

    // ── 内存优化（2026-10-15）：剥离未使用的 morph
    // （morph 白名单已在 MMDLoader 侧前置过滤，这里不再做后置裁剪。）
    for (const b of mesh.skeleton?.bones ?? []) bones[b.name] = b;
    // 手臂自然下垂一点（默认是 A 字站姿，收一点更像站在桌边）
    // 手臂放下多少（度）：模型原始是 A 字张开，放下来更像"站在旁边陪着"。
    // 2026-10-10 用 Blender 重新量过权重：手臂转到 24° 时**裙摆材质 12218 个顶点位移为 0**，
    // 跟着手臂走的是袖子 / 手套 / 毛袖（跟着动才是对的）。所以"裙子会被拽走"是误判——
    // 当初看到的其实是袖子层盖过来。实测 −25° 时袖子自然垂在身侧、裙子不受影响。
    // 想调：?armdrop=<度>（0 = 保持模型原始姿势；实测 −40° 起袖子会明显盖到裙子上）。
    const armDrop = (Number(params.get('armdrop') ?? -25) * Math.PI) / 180;
    if (armDrop && bones['左腕']) bones['左腕'].rotation.z += armDrop;
    if (armDrop && bones['右腕']) bones['右腕'].rotation.z -= armDrop;
    // 记录"默认姿态"作为基准：之后所有姿态/待机微动都是在这个基准上叠加
    baseRot = {};
    basePos = {};
    for (const [name, b] of Object.entries(bones)) {
      baseRot[name] = { x: b.rotation.x, y: b.rotation.y, z: b.rotation.z };
      basePos[name] = b.position.clone();
    }
    basePose = { centreY: basePos['センター']?.y ?? 0 };
    if (params.get('pose')) setPosture(params.get('pose'));
    window.__mesh = mesh;          // 调试用
    window.__camera = camera;      // 调试用（量姿势在屏幕上的实际范围）

    resize();
    frameCamera();
    tick();
    // 物理：Ammo 懒加载（2026-10-15 优化）——默认 off 不拉 wasm；开物理时才按需加载
    if (physicsMode === 'off') {
      setPhysicsMode('off');
    } else {
      window.__ensureAmmo?.().then((ok) => {
        if (!ok) { window.__physicsError = 'Ammo 没加载成功'; return; }
        setPhysicsMode(physicsMode);
      });
    }
    setInterval(pollHerMessages, 4000);
    setTimeout(async () => {
      const st = await window.pet?.bridgeStatus?.();
      if (st?.ok) {
        await pollHerMessages();
        say('我在这儿呢～', 4);
      } else {
        say('（连不上她的那边，先自己待会儿）', 5);
      }
    }, 800);
    window.__ready = true;
    window.__morphCount = Object.keys(morphs.dict).length;
    window.__boneCount = Object.keys(bones).length;
    status(`已加载 ${form[2]}\n顶点 ${mesh.geometry.attributes.position.count} · 骨骼 ${window.__boneCount} · 表情 ${window.__morphCount}`);
  },
  (ev) => { if (ev.total) status('加载中 ' + Math.round(ev.loaded / ev.total * 100) + '%'); },
  (err) => { status('加载失败：' + (err?.message || err)); window.__error = String(err?.message || err); },
);

window.pet?.onCommand?.((cmd) => {
  if (cmd === 'wave') { state.wave = 1; say('在呢在呢～', 3); }
  if (cmd === 'rest') { state.smile = 0.1; say('那我先歇会儿。', 3); }
  if (cmd === 'chat') {
    openComposer();
    say('嗯？你说。', 3);
  }
  if (cmd === 'chat:voice') {
    openComposer();
    say('按住 🎤 说话，松开就发给她～', 6);
  }
  if (cmd === 'voice:mode:hold' || cmd === 'voice:mode:hands') {
    const m = cmd.endsWith('hands') ? 'hands' : 'hold';
    try { localStorage.setItem('voiceMode', m); } catch { /* 忽略 */ }
    if (m === 'hold') handsFreeStop(true);
    if (m === 'hands') handsFreeStart();     // 2026-10-11：选免提就直接开麦（不用再点 🎤）
    reportUiState();
    say(m === 'hands' ? '（免提到手——已经开麦，直接说就行；再点 🎤 就关）' : '（按住说话模式：按着 🎤 说话）', 6);
  }
  if (cmd === 'lock:toggle') toggleLock();
  if (cmd === 'cursor:over') sizeCtlShow(true);
  if (cmd === 'cursor:out') sizeCtlShow(false);
  // 2026-10-11 用户点单：看屏幕接入（走现有 pet-chat；桥接会现拍全分辨率桌面挂给她）
  if (cmd === 'screen:look') { window.pet?.peek?.(); sendText('看看屏幕'); }
  if (cmd === 'screen:watch') startWatch(getWatchMode());
  if (cmd === 'screen:watch:quiet') startWatch('quiet');
  if (cmd === 'screen:watch:chatty') startWatch('chatty');
  if (cmd === 'screen:stop') sendText('别看了');
  if (cmd === 'screen:allow30') sendText('允许你看屏幕 30 分钟');
  if (cmd.startsWith('pose:')) {
    const name = cmd.slice(5);
    setPosture(name);
    const label = POSTURES[postureTarget]?.label || '';
    say(label ? '（换了个姿势：' + label + '）' : '', 2);
  }
  if (cmd.startsWith('motion:')) playMotion(cmd.slice(7));
  if (cmd === 'free:toggle') {
    behavior.free = !behavior.free;
    if (!behavior.free) window.pet?.walkStop?.();
    behavior.timer = behavior.free ? 3 : Infinity;
    say(behavior.free ? '那我到处走走了～' : '那我待在这儿不动。', 3);
  }
  if (cmd.startsWith('phys:')) {
    const mode = cmd.slice(5);
    if (mode.startsWith('blend')) {
      physicsBlend = Number(mode.slice(5)) || 0.55;
      window.__physics = { ...(window.__physics || {}), blend: physicsBlend };
      say('（飘动力度：' + Math.round(physicsBlend * 100) + '%）', 2.5);
      return;
    }
    setPhysicsMode(mode);
    const label = { safe: '只让裙摆和头发飘', skirt: '只让裙摆飘', full: '全部飘（可能穿模）', off: '不动了' }[mode] || mode;
    say('（物理：' + label + '）', 2.5);
  }
});

window.pet?.onFeed?.((p) => {
  const x = Number(p?.x);
  const y = Number(p?.y);
  feedHer(p?.kind || 'random', Number.isFinite(x) ? x : undefined, Number.isFinite(y) ? y : undefined);
});

window.__setPosture = setPosture;
window.__postures = Object.keys(POSTURES);
window.__POSTURES = POSTURES;            // 试摆用：能直接改数值再 setPosture 看效果
window.__setDrowsy = (on, startle = true) => (on ? enterDrowsy('manual') : exitDrowsy(startle));
window.__drowsyState = () => ({ on: drowsy.on, mode: drowsy.mode, blend: Number(drowsy.blend.toFixed(3)), startle: Number(drowsy.startle.toFixed(2)), idleSeconds });
window.__feed = (k, x, y) => feedHer(k || 'random', x, y);
window.__feedState = () => ({ active: feed.active, t: Number(feed.t.toFixed(2)), count: feedCountToday });
window.__headXY = headScreenPos;
window.__sendText = sendText;
window.__voice = { start: () => startListening(), stop: () => stopListening(), handsOn: () => handsFreeStart(), handsOff: (q) => handsFreeStop(q), seg: () => hfStopSegment(), state: () => ({ on: hf.on, rec: !!hf.mr, speech: hf.speech, floor: Number((hf.floor || 0).toFixed(4)), level: Number((hf.level || 0).toFixed(4)) }) };
window.__toggleLock = () => toggleLock();
window.__setVoiceMode = (m) => { try { localStorage.setItem('voiceMode', m); } catch { /* 忽略 */ } reportUiState(); };
window.__sizeCtlShow = (on) => sizeCtlShow(on);
window.__gesturesOn = GESTURES_ON;
window.__chairVisible = () => chair.visible;
window.__watchStart = (m) => startWatch(m);
window.__voiceTest = async (url) => {
  const resp = await fetch(url);
  const blob = await resp.blob();
  const wav = await blobToWav16k(blob);
  return await window.pet.asr(wav);
};

// ── VMD 动作播放（把 .vmd 丢进 E:\denia-desktop\motions\ 就能用）──────
let mixer = null;
let motionPlaying = false;
let motionRestoreMode = null;   // 动作开始时如果是 safe，动作结束要切回来
let motionFade = null;      // 动作进出时的过渡：{ from: [[bone, quat], ...], t, dur }

/** 记下当前所有骨骼的旋转，用于动作进出的"淡入/淡出"。 */
function snapshotBoneQuats() {
  const out = [];
  for (const name of Object.keys(bones)) out.push([bones[name], bones[name].quaternion.clone()]);
  return out;
}

/** 姿态算完之后调用：把过渡权重掺回去（k 从 1 衰减到 0）。 */
function applyMotionFade(dt) {
  if (!motionFade) return;
  motionFade.t += dt;
  const k = 1 - Math.min(1, motionFade.t / motionFade.dur);
  for (const [bone, q] of motionFade.from) bone.quaternion.slerp(q, k);
  if (k <= 0) motionFade = null;
}

// ── 物理：按部位开关（这个模型的刚体全是动态的，且按原始站姿调过参数）──
//  safe（默认）= 只让裙摆 + 头发模拟，披风/袖子/缎带/链子跟着骨骼走
//  skirt      = 只让裙摆模拟（头发也关掉，穿越最严重时用）
//  full       = 全部模拟（最飘，也最容易穿模）
//  off        = 完全关掉
// 2026-10-11 用户点单：默认 off（衣服头发不飘）；想飘用右键「衣服头发飘动」或 ?phys=safe。
// （写飞救援的机制仍在：谁把 safe 打开也照样有兜底。）
let physicsMode = params.get('phys') || 'off';
let lastPhysicsError = null;
let physicsBlend = Number(params.get('physblend') ?? 0.55);   // 物理结果只取多少（越小越不容易穿模）
let physicsBones = [];                                       // 参与模拟的骨骼
let physicsWasPaused = false;

// ── 物理"写飞"救援 ────────────────────────────────────────────────
// 背景：这个模型的布料/头发刚体一旦被约束解算带飞，会把骨骼 position 写到几百单位外
// （实测裙摆骨骼 = (422, -25, -786)，模型才 18 单位高），顶点被拉成糊满屏幕的巨大平面。
// 实测还踩过两个坑（都是"看着像修好了、其实每帧接着炸"的坑）：
//  ① 只判位置不判旋转：被打飞时旋转能偏到 176°，身体位置却只偏十几个单位，
//     漏掉旋转 → 坏姿态留在链上，下一帧又把整条链带炸（实测连炸 36 帧）。
//  ② 只用 physics.reset() 就地复位：reset() 是拿骨骼的 **matrixWorld** 重新种刚体的，
//     而物理写回时顺手刷新过 matrixWorld——不先刷新世界矩阵，等于把坏值原样种回去。
// 所以救援动作 = 整批骨骼拉回"模拟前姿态" → 刷新世界矩阵 → 整块重建物理世界（连约束里
// 的残留冲量一起扔掉；比就地 reset 干净得多）。
const PHYS_BONE_POS_LIMIT = () => Math.max(2, bodyHeight * 0.5);   // 相对"模拟前姿态"的容忍偏移（单位）
// 旋转阈值只作为"位置还正常、但布料整根翻过去"的兜底判据：定太高漏判、定太低会在
// 蹲/靠这类本来就穿模的姿势里反复触发救援（实测 150° 时 lean 每 4 秒救 5 次、裙子一直抖）。
// 写飞实测偏 176~180°，正常摆幅 ≤105°，取 170°。
const PHYS_BONE_ROT_LIMIT = 170;
const physicsBeforeP = [];        // 复用缓冲：物理前的骨骼位置
const physicsBeforeQ = [];        // 复用缓冲：物理前的骨骼旋转
let physicsRecoveries = 0;        // 累计救援次数
let physicsRebuilds = 0;          // 累计重建物理世界次数
let physicsFallbackOff = false;   // 是不是已经放弃物理、回落 off
let physicsRecoverAt = 0;         // 最近一次救援时间（判定"反复发作"用）
let physicsRecoverBurst = 0;      // 一个时间窗内的救援次数
let physicsMaxDev = 0;            // 见过的最大位置偏移（证据用）
let physicsFallbackAt = 0;        // 回落 off 的时间（用来自动重试）
let physicsRetryWait = 45000;     // 自动重试的间隔（失败一次翻倍，最长 10 分钟）

function isFiniteVec3(v) {
  return !!v && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

/** 记下物理模拟前的骨骼姿态（复用缓冲，正常运行时不产生垃圾）。 */
function snapshotPhysicsBones() {
  physicsBeforeP.length = physicsBones.length;
  physicsBeforeQ.length = physicsBones.length;
  for (let i = 0; i < physicsBones.length; i++) {
    const b = physicsBones[i];
    const p = physicsBeforeP[i] || (physicsBeforeP[i] = new THREE.Vector3());
    const q = physicsBeforeQ[i] || (physicsBeforeQ[i] = new THREE.Quaternion());
    p.copy(b.position);
    q.copy(b.quaternion);
  }
}

/** 判断这一帧物理有没有把骨头写飞（位置离谱或旋转离谱都算），返回中招骨骼数；只判定、不动手。 */
function detectBlownPhysicsBones() {
  const posLimit = PHYS_BONE_POS_LIMIT();
  const rotLimit = PHYS_BONE_ROT_LIMIT;
  let blown = 0;
  let worstDev = 0, worstName = '', worstRot = 0, worstRotName = '';
  for (let i = 0; i < physicsBones.length; i++) {
    const b = physicsBones[i];
    const p0 = physicsBeforeP[i];
    const q0 = physicsBeforeQ[i];
    if (!p0 || !q0) continue;
    const bad = !isFiniteVec3(b.position) || !isFiniteVec3(b.quaternion);
    const dev = bad ? Infinity
      : Math.max(Math.abs(b.position.x - p0.x), Math.abs(b.position.y - p0.y), Math.abs(b.position.z - p0.z));
    const rot = bad ? Infinity : 2 * Math.acos(Math.min(1, Math.abs(
      q0.x * b.quaternion.x + q0.y * b.quaternion.y + q0.z * b.quaternion.z + q0.w * b.quaternion.w,
    ))) * 180 / Math.PI;
    if (rot > worstRot) { worstRot = rot; worstRotName = b.name; }
    if (Number.isFinite(dev) && dev > physicsMaxDev) physicsMaxDev = dev;
    if (dev > worstDev) { worstDev = dev; worstName = b.name; }
    if (dev > posLimit || rot > rotLimit) blown += 1;
  }
  const info = window.__physics || (window.__physics = {});
  info.maxDev = Number(physicsMaxDev.toFixed(3));
  info.limit = Number(posLimit.toFixed(3));
  info.rotLimit = rotLimit;
  info.lastDev = Number.isFinite(worstDev) ? Number(worstDev.toFixed(3)) : 'Infinity';
  info.lastDevBone = worstName;
  info.lastRotDeg = Number.isFinite(worstRot) ? Number(worstRot.toFixed(1)) : 'Infinity';
  info.lastRotBone = worstRotName;
  return blown;
}

/** 把参与模拟的骨骼整批拉回"模拟前姿态"（位置和旋转都拉）。 */
function restorePhysicsBonesFromSnapshot() {
  for (let i = 0; i < physicsBones.length; i++) {
    const b = physicsBones[i];
    const p0 = physicsBeforeP[i];
    const q0 = physicsBeforeQ[i];
    if (p0 && q0) { b.position.copy(p0); b.quaternion.copy(q0); }
  }
}

/** 清掉所有刚体的线速度/角速度和残余外力：爆炸的冲劲不清，复位完下一帧照样再炸。 */
function calmPhysicsBodies() {
  const AmmoLib = window.Ammo;
  const zero = AmmoLib?.btVector3 ? new AmmoLib.btVector3(0, 0, 0) : null;
  // 注意：MMDPhysics 里的刚体数组叫 bodies（不是 rigidBodies）——名字写错会静默失效
  for (const rb of (physics?.bodies || [])) {
    const body = rb?.body;
    if (!body) continue;
    body.clearForces?.();
    if (zero) {
      body.setLinearVelocity?.(zero);
      body.setAngularVelocity?.(zero);
    }
  }
  if (zero) AmmoLib.destroy?.(zero);
}

/** 就地救援（首选、不新建对象）：骨骼归位 → 刷新世界矩阵 → reset() 把刚体重新种回去 → 清速度。 */
function resetPhysicsInPlace() {
  restorePhysicsBonesFromSnapshot();
  mesh?.updateMatrixWorld(true);   // reset() 是拿骨骼的 matrixWorld 种刚体的，不刷新就把坏值原样种回去
  physics?.reset?.();
  calmPhysicsBodies();
}

// ── Ammo 世界的创建与释放 ─────────────────────────────────────────
// 以前用 MMDPhysics 自建的世界，它把 config/dispatcher/broadphase/solver 全藏在内部，
// 从外面既拿不到、也释放不掉——实测反复切物理模式 9 次就 abort(OOM)、物理直接失效。
// 现在改成这边自己建、自己持有（MMDPhysics 支持 `params.world` 传外部世界），切模式时
// 能整套 destroy。注意：走外部世界这条路径 MMDPhysics 不会再设重力，得自己 setGravity。
let physicsWorldParts = null;

function createPhysicsWorldParts() {
  const AmmoLib = window.Ammo;
  const config = new AmmoLib.btDefaultCollisionConfiguration();
  const dispatcher = new AmmoLib.btCollisionDispatcher(config);
  const broadphase = new AmmoLib.btDbvtBroadphase();
  const solver = new AmmoLib.btSequentialImpulseConstraintSolver();
  const world = new AmmoLib.btDiscreteDynamicsWorld(dispatcher, broadphase, solver, config);
  return { world, config, dispatcher, broadphase, solver };
}

function disposePhysicsWorldParts(parts) {
  const AmmoLib = window.Ammo;
  if (!parts || !AmmoLib?.destroy) return;
  // 顺序：先世界，再它引用的那几个（Bullet 的约定是这些由调用方自己删）
  for (const key of ['world', 'solver', 'broadphase', 'dispatcher', 'config']) {
    const obj = parts[key];
    if (obj) AmmoLib.destroy(obj);
  }
}

/** 释放旧物理：刚体/形状/约束 → 世界 → 求解器/宽相/调度器/配置。Ammo 对象不 destroy 会一路漏到 abort(OOM)。 */
function disposePhysics(p) {
  const AmmoLib = window.Ammo;
  if (!p) { physicsWorldParts = null; return; }
  try {
    for (const rb of (p.bodies || [])) {
      const body = rb?.body;
      if (!body) continue;
      const shape = body.getCollisionShape?.();
      p.world?.removeRigidBody?.(body);
      AmmoLib.destroy(body);
      if (shape) AmmoLib.destroy(shape);      // 形状是 RigidBody 内部建的，跟着一起收
    }
    for (const c of (p.constraints || [])) {
      const con = c?.constraint;
      if (!con) continue;
      p.world?.removeConstraint?.(con);
      AmmoLib.destroy(con);
    }
    p.bodies = [];
    p.constraints = [];
    if (physicsWorldParts) disposePhysicsWorldParts(physicsWorldParts);
    else if (p.world) AmmoLib.destroy(p.world);   // 兜底：万一是模块自建的世界
  } catch (e) {
    window.__physicsDisposeError = String(e?.message || e);
  }
  physicsWorldParts = null;
}

/** 拆掉当前物理实例并重建一个干净的（mode 不变）。调试与"就地复位压不住"时用。 */
function rebuildPhysics() {
  const keep = physicsMode === 'off' ? 'safe' : physicsMode;
  disposePhysics(physics);
  physics = null;
  physicsBones = [];
  physicsRebuilds += 1;
  setPhysicsMode(keep);
  return window.__physics;
}
window.__physicsRebuildNow = rebuildPhysics;      // 调试/自检：连按多次，验证不会漏 Ammo 内存

/**
 * 救援：先就地复位；同一个时间窗里连着压不住才升级到"重建"，再压不住就回落 off。
 * 三级阶梯的理由：就地复位零开销、也不动 Ammo 堆；重建虽然干净，但每建一次都要新建
 * 544 个刚体 + 781 个约束，属于重活，不能当成每帧都走的路。
 */
function recoverPhysics(blown) {
  physicsRecoveries += 1;
  const now = performance.now();
  if (now - physicsRecoverAt > 8000) { physicsRecoverAt = now; physicsRecoverBurst = 0; }
  physicsRecoverBurst += 1;
  let action = 'reset';
  if (physicsRecoverBurst <= 3) {
    resetPhysicsInPlace();
  } else if (physicsRecoverBurst <= 6) {
    action = 'rebuild';
    rebuildPhysics();
  } else {
    action = 'off';
    disposePhysics(physics);
    physics = null;
    physicsBones = [];
    physicsFallbackOff = true;
    physicsFallbackAt = now;
    physicsRetryWait = 45000;
    setPhysicsMode('off');
    if (!recoverPhysics.said) {
      recoverPhysics.said = true;
      say('（布料物理老出岔子，我先把它收起来，衣服就先不飘了）', 4);
    }
  }
  const info = window.__physics || (window.__physics = {});
  info.recoveries = physicsRecoveries;
  info.rebuilds = physicsRebuilds;
  info.fallbackOff = physicsFallbackOff;
  info.lastBlown = blown;
  info.lastAction = action;
}

/**
 * 物理被"收起来"之后，过一阵子悄悄再试一次。
 * 场景：她趴下去（这个姿势布料刚体压不住）→ 物理收起；过一会儿站起来 → 应该自己飘回来。
 * 重试间隔失败一次翻倍（45s → 90s → …，上限 10 分钟），避免和"必炸的姿势"来回拉扯。
 */
function maybeRetryPhysics() {
  if (!physicsFallbackOff || physics) return;
  const now = performance.now();
  if (now - physicsFallbackAt < physicsRetryWait) return;
  physicsFallbackOff = false;
  physicsRecoverAt = 0;
  physicsRecoverBurst = 0;
  physicsRetryWait = Math.min(600000, physicsRetryWait * 2);
  setPhysicsMode('safe');
}

const PHYS_SAFE_OFF = /披风|袖|リボン|缎带|结|链子|发带|小辫子/;
const PHYS_SKIRT_ONLY = /^(?!スカート)/;

function setPhysicsMode(mode) {
  physicsMode = mode;
  window.__physicsMode = mode;
  if (!mesh) return;
  // Ammo 懒加载兜底：从 off 直接开物理（托盘菜单）时按需拉 wasm
  if (mode !== 'off' && !window.Ammo) {
    window.__ensureAmmo?.().then((ok) => {
      if (ok) setPhysicsMode(mode);
      else { window.__physicsError = 'Ammo 没加载成功'; }
    });
    return;
  }
  disposePhysics(physics);          // 先整套放掉旧世界（不释放的话切几次就 abort(OOM)）
  physics = null;
  physicsBones = [];
  const mmd = mesh.geometry.userData.MMD || {};
  const raw = mmd.rigidBodies || [];
  const joints = mmd.constraints || [];
  const bones = mesh.skeleton?.bones || [];
  if (mode === 'off') {
    window.__physicsObj = null;          // 调试/自检用（注入冲量复现"写飞"就是靠它）
    window.__physics = { mode, dynamic: 0 };
    return;
  }
  const test = mode === 'full' ? null : (mode === 'skirt' ? PHYS_SKIRT_ONLY : PHYS_SAFE_OFF);
  const bodies = test ? raw.map((b) => {
    const name = bones[b.boneIndex]?.name || '';
    return test.test(name) ? { ...b, type: 0 } : b;
  }) : raw;
  try {
    physicsWorldParts = createPhysicsWorldParts();
    physics = new MMDPhysics(mesh, bodies, joints, {
      unitStep: 1 / 65, maxStepNum: 3, world: physicsWorldParts.world,
    });
    physics.setGravity?.(physics.gravity);   // 自带重力和模块内部建世界时一致：(0, -98, 0)
    window.__physicsObj = physics;       // 调试/自检用
    physics.reset?.();
    // 记下"哪些骨骼是物理驱动的"——每帧把它往动画姿态拉回一点，限制摆幅
    const seen = new Set();
    for (const b of bodies) {
      if (b.type === 0 || b.boneIndex === undefined || b.boneIndex < 0) continue;
      const bone = bones[b.boneIndex];
      if (bone && !seen.has(bone)) { seen.add(bone); physicsBones.push(bone); }
    }
    window.__physics = {
      mode, rigidBodies: bodies.length, constraints: joints.length,
      dynamic: bodies.filter((b) => b.type !== 0).length,
      blend: physicsBlend, bones: physicsBones.length,
    };
    lastPhysicsError = null;
  } catch (e) {
    lastPhysicsError = String(e?.message || e);
    window.__physicsError = lastPhysicsError;
  }
}

window.__setPhysicsMode = setPhysicsMode;
window.__setStance = setStance;          // 调试/预设：window.__setStance('歪头')、window.__setStance('auto')
window.__stances = STANCE_NAMES;

// ── 动作期间的"次级运动"：扭腕骨 + 裙摆（邮件 YA-20261010-05）────────────
// 为什么要有这一段（2026-10-10 在模型里一条条量过，不是猜）：
//  ① 毛袖 / 手套的顶点挂在 腕捩1/2/3、手捩1/2/3 上（2923/2165/770 + 138/109/91
//     个顶点），可 VMD 只驱动主骨骼 —— 这几根"扭腕骨"从来没被驱动过，整条袖子只能
//     刚性跟着上臂扫过去，扫到裙子就是穿模、看着也僵。
//  ② 裙摆是 12 层 × 16 个方位 = 186 根骨，平时全靠物理飘；动作期间物理是停的
//     （快舞里布料会被骨头拽到约束解不开，实测必炸），于是裙子成了冻住的锥体，
//     腿在里头摆就从裙面穿出来。
// 这里补上"程序化的活"：不改模型、不动动作文件，走路时也一起生效。
// 整段关掉：?secondary=0；幅度可调：?twist= / ?swing=；动作速度：?motionrate=
let secondaryOn = params.get('secondary') !== '0';
const twistGain = Number(params.get('twist') ?? 1);           // 扭腕骨幅度（1 = 默认）
const swingGain = Number(params.get('swing') ?? 1);           // 裙摆摆幅（1 = 默认）
const motionRate = Number(params.get('motionrate') ?? 0.9);   // 非循环动作的播放速度

const SEC_HIST = 48;       // 每条骨柱留住最近多少帧的角度（给"层层延迟"用）
const SEC_FALL = 98;       // MMD 的重力加速度（单位/秒²）
const SEC_LAYER_LAG = 0.8; // 每往下一层，慢几帧（60fps 下 ≈ 13ms/层）
const SEC = {
  ready: false,
  restQuat: new Map(),     // 骨骼名 -> 静止姿态的旋转（模型空间）
  restPos: new Map(),      // 骨骼名 -> 静止姿态的位置（模型空间）
  baseQ: new Map(),        // 骨骼名 -> 静止的局部旋转
  twist: [],               // 两条手臂的扭腕骨
  cols: [],                // 裙摆的 16 条"骨柱"
  hipNow: new THREE.Vector3(), hipPrev: new THREE.Vector3(),
  hipVel: new THREE.Vector3(), hipAcc: new THREE.Vector3(),
  hipQ: new THREE.Quaternion(), omega: new THREE.Vector3(),
};
const meshQuatInv = new THREE.Quaternion();
const SEC_IDENT = new THREE.Quaternion();
const SEC_Q1 = new THREE.Quaternion();
const SEC_Q2 = new THREE.Quaternion();
const SEC_Q3 = new THREE.Quaternion();
const SEC_V1 = new THREE.Vector3();
const SEC_V2 = new THREE.Vector3();
const SEC_V3 = new THREE.Vector3();
const SEC_AXIS_X = new THREE.Vector3(1, 0, 0);
const SEC_AXIS_Z = new THREE.Vector3(0, 0, 1);
const secClamp = (v, lo, hi) => (v < lo ? lo : (v > hi ? hi : v));

/** 骨骼静止的局部旋转（baseRot 是欧拉角，这里统一成四元数）。 */
function baseQuatOf(name) {
  let q = SEC.baseQ.get(name);
  if (q) return q;
  const r = baseRot[name] || { x: 0, y: 0, z: 0 };
  q = new THREE.Quaternion().setFromEuler(new THREE.Euler(r.x, r.y, r.z, 'XYZ'));
  SEC.baseQ.set(name, q);
  return q;
}

/** 静止姿态的位置 + 旋转（模型空间 = 不含她转身的朝向）。一次算好，之后每帧用。 */
function buildRestPose() {
  const walk = (b, parentQ, parentP) => {
    const bq = baseQuatOf(b.name);
    const wq = parentQ ? parentQ.clone().multiply(bq) : bq.clone();
    const bp = basePos[b.name] || b.position;
    const wp = parentP ? parentP.clone().add(bp.clone().applyQuaternion(parentQ)) : bp.clone();
    SEC.restQuat.set(b.name, wq);
    SEC.restPos.set(b.name, wp);
    for (const c of b.children) if (c.isBone) walk(c, wq, wp);
  };
  for (const b of mesh.skeleton.bones) if (!b.parent || !b.parent.isBone) walk(b, null, null);
}

/**
 * 一条手臂的扭腕骨设置。
 * 绕的那根"臂轴" = 静止时 腕 → ひじ 的方向。量"拧了多少"和"往哪拧"都用这根轴，
 * 只是各自换算到相关骨骼的父级坐标系里 —— 这样转出来的方向和源动作里手腕的拧转
 * 一定同号（不然袖子会逆着手腕拧，看着更怪）。
 */
function setupTwistSide(pre) {
  const arm = bones[pre + '腕'];
  const fore = bones[pre + 'ひじ'];
  const hand = bones[pre + '手首'];
  if (!arm || !fore || !hand) return null;
  const pArm = SEC.restPos.get(arm.name);
  const pFore = SEC.restPos.get(fore.name);
  if (!pArm || !pFore) return null;
  const axisModel = pFore.clone().sub(pArm).normalize();
  const axisInParentOf = (b) => {
    const p = b.parent && b.parent.isBone ? b.parent : null;
    const rq = p ? (SEC.restQuat.get(p.name) || SEC_IDENT) : SEC_IDENT;
    return axisModel.clone().applyQuaternion(rq.clone().invert()).normalize();
  };
  const mk = (b, f) => ({ b, f, axis: axisInParentOf(b), q0: baseQuatOf(b.name) });
  return {
    fore,
    hand,
    foreAxis: axisInParentOf(fore),
    handAxis: axisInParentOf(hand),
    // 毛袖挂在 腕捩1/2/3 上：越靠肘的那根，跟前臂的拧转跟得越多
    sleeve: [1, 2, 3].map((i) => bones[pre + '腕捩' + i]).filter(Boolean).map((b, i) => mk(b, [0.30, 0.60, 0.90][i])),
    // 手套挂在 手捩1/2/3 上：它们只缺"手腕自己"那一段拧转
    glove: [1, 2, 3].map((i) => bones[pre + '手捩' + i]).filter(Boolean).map((b, i) => mk(b, [0.40, 0.70, 1.00][i])),
    smooth: 0,
    handSmooth: 0,
  };
}

/** 把 186 根裙摆骨按"方位"分成 16 条骨柱（每柱从上到下 12 层）。 */
function setupSkirtCols() {
  const rings = new Map();
  for (const name of Object.keys(bones)) {
    const m = /^スカート_(\d+)_(\d+)$/.exec(name);
    if (!m) continue;
    const ring = Number(m[2]);
    if (!rings.has(ring)) rings.set(ring, []);
    rings.get(ring).push({ layer: Number(m[1]), b: bones[name] });
  }
  const hipName = bones['下半身'] ? '下半身' : 'センター';
  const hipRest = SEC.restPos.get(hipName) || new THREE.Vector3();
  const flatDir = (p) => {
    const v = p.clone().sub(hipRest);
    v.y = 0;
    return v.lengthSq() > 1e-6 ? v.normalize() : new THREE.Vector3();
  };
  const dL = SEC.restPos.get('左足') ? flatDir(SEC.restPos.get('左足')) : new THREE.Vector3();
  const dR = SEC.restPos.get('右足') ? flatDir(SEC.restPos.get('右足')) : new THREE.Vector3();
  const out = [];
  for (const [ring, arr] of rings) {
    arr.sort((a, b) => a.layer - b.layer);
    const bs = arr.map((x) => x.b);
    const head = SEC.restPos.get(bs[0].name);
    const tail = SEC.restPos.get(bs[bs.length - 1].name);
    if (!head || !tail) continue;
    const dir = flatDir(head);
    const anchor = head.clone().sub(hipRest);
    anchor.y = 0;
    const len = Math.max(0.6, Math.abs(head.y - tail.y) + 0.35);   // 摆长（单位）≈ 柱高
    out.push({
      ring,
      bones: bs,
      q0: bs.map((b) => baseQuatOf(b.name)),
      pRest: bs.map((b) => SEC.restQuat.get(b.parent ? b.parent.name : '') || SEC_IDENT),
      dir,
      front: Math.max(0, dir.z),
      wL: Math.max(0, dir.dot(dL)),
      wR: Math.max(0, dir.dot(dR)),
      // 腿往前抬时"顶裙子"的权重：靠前的裙片最挡路（前方 0.6），同侧的再补 0.4。
      // 光看"离哪条腿近"是不够的 —— 正前方那片的 wL/wR 都是 0，恰恰是膝盖最容易顶出来的地方。
      legWL: 0.6 * Math.max(0, dir.z) + 0.4 * Math.max(0, dir.dot(dL)),
      legWR: 0.6 * Math.max(0, dir.z) + 0.4 * Math.max(0, dir.dot(dR)),
      anchor,
      len,
      ux: 0, uz: 0, vx: 0, vz: 0,
      hist: new Float32Array(SEC_HIST * 2),
      ptr: 0,
    });
  }
  out.sort((a, b) => a.ring - b.ring);
  return out;
}

/**
 * 骨骼"绕这根轴拧了多少"（弧度）。读前臂/手腕的拧转量用。
 * 轴要换算到"该骨骼父级的静止坐标系"里，增量也取同一坐标系（q_local ⊗ q_rest⁻¹），
 * 这样算出来的正负号就是"绕世界那根轴按右手方向转"的正负号，和写袖子的方向一致。
 */
function ownRollOf(b, axisInParent) {
  SEC_Q2.copy(b.quaternion).multiply(baseQuatOf(b.name).clone().invert());
  if (SEC_Q2.w < 0) SEC_Q2.set(-SEC_Q2.x, -SEC_Q2.y, -SEC_Q2.z, -SEC_Q2.w);
  const s = SEC_Q2.x * axisInParent.x + SEC_Q2.y * axisInParent.y + SEC_Q2.z * axisInParent.z;
  return 2 * Math.asin(secClamp(s, -1, 1));
}

/** 大腿往前抬了多少（弧度，正 = 往前）。走路/跳舞的腿摆都有这个量。 */
function swingForwardOf(b) {
  if (!b) return 0;
  SEC_Q2.copy(baseQuatOf(b.name)).invert().multiply(b.quaternion);
  const s = Math.hypot(SEC_Q2.x, SEC_Q2.y, SEC_Q2.z);
  if (s < 1e-6) return 0;
  const ang = 2 * Math.atan2(s, Math.abs(SEC_Q2.w));
  SEC_V2.set(SEC_Q2.x / s, SEC_Q2.y / s, SEC_Q2.z / s)
    .applyQuaternion(SEC.restQuat.get(b.name) || SEC_IDENT)
    .normalize();
  const sx = SEC_V2.x;                                  // 轴在模型空间的左右分量
  return ang * (sx <= 0 ? 1 : -1) * Math.min(1, Math.abs(sx) * 1.5);
}

/** 把一段"绕父级坐标系里某根轴"的旋转写进骨骼（保留它自己的静止旋转）。 */
function writeRollBone(t, theta) {
  SEC_Q1.setFromAxisAngle(t.axis, theta);
  t.b.quaternion.copy(t.q0).premultiply(SEC_Q1);
}

/** 裙摆骨：把"模型空间的一小段旋转"换算到它父级的坐标系里写进去。 */
function writeSkirtBone(c, i, dx, dz) {
  SEC_Q1.setFromAxisAngle(SEC_AXIS_X, dx).multiply(SEC_Q2.setFromAxisAngle(SEC_AXIS_Z, dz));
  SEC_Q3.copy(c.pRest[i]).invert().multiply(SEC_Q1).multiply(c.pRest[i]);
  c.bones[i].quaternion.copy(c.q0[i]).premultiply(SEC_Q3);
}

/** 每帧调用：先算骨盆在干什么，再把扭腕骨 / 裙摆写出来。 */
function applySecondaryMotion(dt) {
  if (!mesh || !mesh.skeleton || !window.__ready) return;
  if (!SEC.ready) {
    buildRestPose();
    SEC.twist = [setupTwistSide('左'), setupTwistSide('右')].filter(Boolean);
    SEC.cols = setupSkirtCols();
    SEC.ready = true;
    window.__secondaryInfo = {
      twistSides: SEC.twist.length,
      sleeve: SEC.twist.map((s) => s.sleeve.map((x) => x.b.name)),
      glove: SEC.twist.map((s) => s.glove.map((x) => x.b.name)),
      cols: SEC.cols.length,
      colsInfo: SEC.cols.map((c) => ({
        ring: c.ring, layers: c.bones.length,
        dir: [+c.dir.x.toFixed(2), +c.dir.z.toFixed(2)],
        wL: +c.wL.toFixed(2), wR: +c.wR.toFixed(2), len: +c.len.toFixed(2),
      })),
    };
  }
  if (!secondaryOn) {
    // 关掉的时候把写过的地方还原成静止姿态，别把"半截姿势"留在她身上
    if (SEC.applied) {
      SEC.applied = false;
      for (const side of SEC.twist) {
        for (const t of side.sleeve) t.b.quaternion.copy(t.q0);
        for (const t of side.glove) t.b.quaternion.copy(t.q0);
      }
      for (const c of SEC.cols) for (let i = 0; i < c.bones.length; i++) c.bones[i].quaternion.copy(c.q0[i]);
    }
    return;
  }
  const dtc = secClamp(dt, 0.001, 1 / 30);
  mesh.updateMatrixWorld(true);
  meshQuatInv.copy(mesh.quaternion).invert();
  // 她在动（走路/做动作/换姿势）时物理是停的，这时候次级运动由我们接管；
  // 站着不动时物理在跑，裙摆交给物理，别和它打架。
  const active = behavior.mode === 'walking' || motionPlaying || poseRemainder > 0.02 || !physics;

  // ── 骨盆在做什么（模型空间的位置/加速度/角速度）────────────────────
  const hipBone = bones['下半身'] || bones['センター'];
  SEC.hipNow.copy(hipBone.getWorldPosition(SEC_V1)).sub(mesh.position).applyQuaternion(meshQuatInv);
  if (!SEC.hipInit) { SEC.hipInit = true; SEC.hipPrev.copy(SEC.hipNow); }
  SEC_V2.copy(SEC.hipNow).sub(SEC.hipPrev).divideScalar(dtc);        // 瞬时速度
  SEC_V3.copy(SEC_V2).sub(SEC.hipVel).divideScalar(dtc);             // 瞬时加速度
  SEC.hipAcc.multiplyScalar(0.7).addScaledVector(SEC_V3, 0.3);       // 平滑一下，别被单帧抖动带跑
  SEC.hipVel.copy(SEC_V2);
  SEC.hipPrev.copy(SEC.hipNow);
  SEC_Q3.copy(meshQuatInv).multiply(hipBone.getWorldQuaternion(SEC_Q1));   // 骨盆当前的旋转（模型空间）
  if (SEC.hipQInit) {
    SEC_Q1.copy(SEC.hipQ).invert().multiply(SEC_Q3);
    if (SEC_Q1.w < 0) SEC_Q1.set(-SEC_Q1.x, -SEC_Q1.y, -SEC_Q1.z, -SEC_Q1.w);
    const s = Math.hypot(SEC_Q1.x, SEC_Q1.y, SEC_Q1.z);
    if (s > 1e-6) {
      const ang = (2 * Math.atan2(s, SEC_Q1.w)) / dtc;
      SEC.omega.set((SEC_Q1.x / s) * ang, (SEC_Q1.y / s) * ang, (SEC_Q1.z / s) * ang);
    } else SEC.omega.set(0, 0, 0);
  }
  SEC.hipQ.copy(SEC_Q3);
  SEC.hipQInit = true;

  // ── ① 扭腕骨：把"前臂 + 手腕自己拧了多少"分给袖子 / 手套 ──────────
  for (const side of SEC.twist) {
    const fore = ownRollOf(side.fore, side.foreAxis);
    const hand = ownRollOf(side.hand, side.handAxis);
    const sleeveWant = secClamp(fore + hand * 0.5, -1.2, 1.2) * twistGain;
    const gloveWant = secClamp(hand, -1.0, 1.0) * twistGain;
    side.smooth += (sleeveWant - side.smooth) * Math.min(1, dtc * 14);
    side.handSmooth += (gloveWant - side.handSmooth) * Math.min(1, dtc * 14);
    if (!active) continue;
    for (const t of side.sleeve) writeRollBone(t, side.smooth * t.f);
    for (const t of side.glove) writeRollBone(t, side.handSmooth * t.f);
    SEC.applied = true;
  }

  // ── ② 裙摆：每条骨柱一个"带阻尼的摆"，再加一点腿的推力 ────────────
  const swingL = swingForwardOf(bones['左足']);
  const swingR = swingForwardOf(bones['右足']);
  const ox = SEC.omega.x, oy = SEC.omega.y, oz = SEC.omega.z;
  for (const c of SEC.cols) {
    // 锚点的加速度 = 骨盆平动 + 转动（离心项）
    const rx = c.anchor.x, rz = c.anchor.z;
    const u1 = oy * rz, u2 = oz * rx - ox * rz, u3 = -oy * rx;    // u = ω × r
    const accX = SEC.hipAcc.x + (oy * u3 - oz * u2);
    const accZ = SEC.hipAcc.z + (ox * u2 - oy * u1);
    const w0 = Math.sqrt(SEC_FALL / c.len);
    const damp = 2 * 0.42 * w0;
    c.vz += (-(w0 * w0) * c.uz - damp * c.vz - accZ) * dtc;
    c.vx += (-(w0 * w0) * c.ux - damp * c.vx - accX) * dtc;
    c.uz = secClamp(c.uz + c.vz * dtc, -0.45 * c.len, 0.45 * c.len);
    c.ux = secClamp(c.ux + c.vx * dtc, -0.45 * c.len, 0.45 * c.len);
    // 腿往前抬：对应方位的裙片会被膝盖顶出去（这也是"腿从裙面穿出来"的解药）
    const legPush = (c.legWL * swingL + c.legWR * swingR) * 0.55 * c.len;
    const phiX = -(c.uz + legPush) / c.len;    // 绕模型 X 轴：正 = 前摆
    const phiZ = c.ux / c.len;                 // 绕模型 Z 轴：正 = 往左甩
    c.hist[c.ptr * 2] = phiX;
    c.hist[c.ptr * 2 + 1] = phiZ;
    c.ptr = (c.ptr + 1) % SEC_HIST;
    if (!active) continue;
    const n = c.bones.length;
    const readHist = (lag) => {
      const i = (((c.ptr - 1 - lag) % SEC_HIST) + SEC_HIST) % SEC_HIST;
      return [c.hist[i * 2], c.hist[i * 2 + 1]];
    };
    let tipX = 0;
    let layerMax = 0;
    // 每层的"总摆角"= 该层延迟后的摆角 × 该层的份量（越往下份量越大）；
    // 每根骨写的是"和上一层之差"。gain 一定放在做差**之前**：
    // 不然一个稳定的摆角（比如膝盖一直顶着裙子）做差之后就归零了，裙子会自己弹回去。
    const shaped = (i, lag) => {
      const g = i < 0 ? 0 : 0.35 + 0.65 * (n > 1 ? i / (n - 1) : 1);
      const h = readHist(lag);
      return [h[0] * g, h[1] * g];
    };
    for (let i = 0; i < n; i++) {
      const now = shaped(i, Math.round(i * SEC_LAYER_LAG));
      const prev = shaped(i - 1, i > 0 ? Math.round((i - 1) * SEC_LAYER_LAG) : 0);
      const dx = secClamp((now[0] - prev[0]) * swingGain, -0.16, 0.16);
      const dz = secClamp((now[1] - prev[1]) * swingGain, -0.16, 0.16);
      tipX += dx;
      layerMax = Math.max(layerMax, Math.abs(dx), Math.abs(dz));
      writeSkirtBone(c, i, dx, dz);
    }
    c.tipX = tipX;
    c.layerMax = layerMax;
    SEC.applied = true;
  }

  // 自检用：每 6 帧刷一次当前的拧转量 / 前两条骨柱的摆角
  SEC.frame = (SEC.frame || 0) + 1;
  if (SEC.frame % 6 === 1) {
    window.__secondary = {
      active,
      sleeveRoll: SEC.twist.map((s) => +s.smooth.toFixed(3)),
      handRoll: SEC.twist.map((s) => +s.handSmooth.toFixed(3)),
      sleeveDeg: SEC.twist.map((s) => +(s.smooth * 57.2958).toFixed(1)),
      handDeg: SEC.twist.map((s) => +(s.handSmooth * 57.2958).toFixed(1)),
      swingLegs: [+swingL.toFixed(3), +swingR.toFixed(3)],
      hipAcc: +SEC.hipAcc.length().toFixed(2),
      skirtDeg: SEC.cols.map((c) => +((c.tipX || 0) * 57.2958).toFixed(1)),
      skirtMaxDeg: +Math.max(0, ...SEC.cols.map((c) => (c.layerMax || 0) * 57.2958)).toFixed(1),
      cols: SEC.cols.slice(0, 4).map((c) => [+c.uz.toFixed(3), +c.ux.toFixed(3)]),
    };
  }
}

window.__setSecondary = (on) => { secondaryOn = !!on; return secondaryOn; };
window.__secondaryOn = () => secondaryOn;

/** VMD 只会驱动主骨骼；这个模型的腿等部位是靠"付与"的 D 骨骼形变的，
 *  所以把 `足` 的轨道复制一份给 `足D`（three.js 不跑 MMDAnimationHelper 时不会自动继承）。 */
function mirrorGrantTracks(clip) {
  const names = new Set(Object.keys(bones));
  const extra = [];
  for (const track of clip.tracks) {
    // three.js 的轨道名格式：".bones[センター].quaternion"（也可能是 "センター.quaternion"）
    const m = /^(?:\.bones\[([^\]]+)\]|([^.]+))\.(quaternion|position|scale)$/.exec(track.name);
    if (!m) continue;
    const bone = m[1] || m[2];
    const prop = m[3];
    if (bone.endsWith('D')) continue;
    const dName = `${bone}D`;
    if (!names.has(dName)) continue;
    const clone = track.clone();
    clone.name = m[1] ? `.bones[${dName}].${prop}` : `${dName}.${prop}`;
    extra.push(clone);
  }
  if (extra.length) {
    clip.tracks = clip.tracks.concat(extra);
    window.__grantTracks = extra.length;
  }
}

function playMotion(fileName) {
  if (!mesh) return;
  if (drowsy.on) exitDrowsy(false);          // 要播动作先安静地醒过来
  window.__motionError = null;
  const url = (viaProtocol ? 'denia://motions/' : '/motions/') + encodeURIComponent(fileName);
  const loop = /idle|待机|呼吸/i.test(fileName);
  new MMDLoader().loadAnimation(url, mesh, (clip) => {
    window.__lastClip = { names: clip.tracks.map((t) => t.name).slice(0, 25), total: clip.tracks.length };
    mirrorGrantTracks(clip);          // 让"付与"骨骼（足D 等）跟着动，否则腿不动
    if (mixer) { mixer.stopAllAction(); mixer.uncacheRoot(mesh); }
    mixer = new THREE.AnimationMixer(mesh);
    const action = mixer.clipAction(clip);
    action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1);
    action.clampWhenFinished = !loop;
    // 非循环动作稍微放慢一点：快舞对这个模型的布料本来就吃力，慢一点读起来更顺。
    // 想调回原速：?motionrate=1
    action.timeScale = loop ? 1 : motionRate;
    motionFade = { from: snapshotBoneQuats(), t: 0, dur: 0.30 };    // 淡入：从当前姿态滑进动作
    // ⚠️ 试过"动作时切 full（袖子也模拟）"：站着切没事，但快舞里袖子刚体会被骨头拽到
    //    约束解不开 → 连炸（实测一次舞蹈触发 7 次救援、最后自己回落 off）。所以先不切模式，
    //    袖子照旧跟骨走；袖子的"僵"改由动作文件里的腕捩/手捩（扭腕骨）来缓解。
    action.play();
    motionPlaying = true;
    mixer.addEventListener('finished', () => {
      motionFade = { from: snapshotBoneQuats(), t: 0, dur: 0.35 };  // 淡出：从动作最后一帧滑回姿态
      motionPlaying = false;
      mixer = null;
      if (motionRestoreMode) { setPhysicsMode(motionRestoreMode); motionRestoreMode = null; }
      setPosture(postureTarget);          // 动作结束后回到当前姿态
    });
    window.__motion = { file: fileName, loop, duration: clip.duration };
    say(loop ? '（活动了一下）' : '（做了个动作）', 2);
  }, undefined, (err) => {
    window.__motionError = String(err?.message || err);
    say('这个动作放不了：' + (err?.message || err), 5);
  });
}

window.__playMotion = playMotion;
window.__fakeSpeak = (sec) => { state.speakingUntil = performance.now() / 1000 + Number(sec || 5); };
window.__forceGesture = (idx) => {
  const i = Number(idx);
  if (!Number.isFinite(i) || i < 0 || i >= GESTURES.length) return;
  gesture.idx = i;
  gesture.t = 0;
  gesture.dur = 99;
  gesture.weight = 1;
  gesture.locked = true;
  state.speakingUntil = performance.now() / 1000 + 99;
};

// ── 自由活动：自己在桌面上走来走去 ─────────────────────────────────
const behavior = {
  free: params.get('free') !== '0',
  mode: 'idle',            // idle | walking
  timer: 8 + Math.random() * 10,
  phase: 0,
  dir: 1,
  speed: 155,              // 像素/秒（会被 updateWalkSpeed() 按步频重算）
  cadence: (Number(params.get('cadence')) || 4.2),   // 步周期角速度（rad/s）：4.2 ≈ 每秒 1.3 步
  armSwing: (Number(params.get('armswing') ?? 18) * Math.PI) / 180,   // 走路摆臂幅度（弧度）
  styleName: '悠闲',
  screen: null,
  screenAt: 0,
  walkEndsAt: 0,
  hoverSince: 0,
};
window.__behavior = behavior;

async function refreshScreen(force = false) {
  if (!window.pet?.getScreen) return behavior.screen;
  if (!force && behavior.screen && performance.now() - behavior.screenAt < 15000) return behavior.screen;
  try {
    behavior.screen = await window.pet.getScreen();
    behavior.screenAt = performance.now();
  } catch { /* 拿不到就沿用上次的 */ }
  return behavior.screen;
}

function standY() {
  const s = behavior.screen;
  if (!s?.bounds) return null;
  return s.workArea.y + s.workArea.height - s.bounds.height + 10;
}

async function startWalk() {
  if (!behavior.free || motionPlaying || posLocked) return;   // 锁定时她也不自己溜达
  const env = await (window.pet?.env ? window.pet.env() : refreshScreen(true));
  if (!env?.bounds) return;
  behavior.screen = { workArea: env.workArea, bounds: env.bounds };
  behavior.screenAt = performance.now();
  const decision = decideDestination(env);
  if (!decision) return;                    // 决定"先待着不动"
  behavior.lastDecision = decision;
  decisionLog.push({ t: new Date().toLocaleTimeString('zh-CN'), ...decision, fg: env.fg?.process || '' });
  if (decisionLog.length > 30) decisionLog.shift();
  if (decision.say) say(decision.say, 3.5);

  if (postureTarget !== 'stand') {          // 先站起来再走
    setPosture('stand');
    behavior.timer = 1.6;
    behavior.pendingDecision = decision;
    return;
  }
  walkToSpot(decision);
}

function walkToSpot(decision) {
  const s = behavior.screen;
  if (!s?.bounds) return;
  // 坐姿的落点固定在屏幕右下角（用户点单：坐着就在右下角，别被别的窗口挡）——
  // 这样她是"走到角落再坐下"，和手动点菜单的落点一致
  if (decision.posture === 'sit') {
    decision.x = Math.round(s.workArea.x + s.workArea.width - window.innerWidth - 20);
  }
  // 走路也有预设：每次出门随机挑一种（步频和摆臂配套，速度按步频反推）
  const style = WALK_STYLES[Math.floor(Math.random() * WALK_STYLES.length)];
  behavior.cadence = style.cadence;
  behavior.armSwing = (style.armSwingDeg * Math.PI) / 180;
  behavior.styleName = style.name;
  updateWalkSpeed();
  window.__walkStyle = style.name;
  const curX = s.bounds.x;
  const targetX = decision.x;
  const dist = Math.abs(targetX - curX);
  const duration = Math.max(1000, (dist / behavior.speed) * 1000);
  behavior.mode = 'walking';
  behavior.phase = 0;
  behavior.dir = targetX < curX ? -1 : 1;
  behavior.walkEndsAt = performance.now() + duration;
  behavior.arrivePosture = decision.posture || 'stand';
  behavior.spotId = decision.id;
  // 朝向交给"平滑转身"处理（见 applyIdle 里的 yaw）：走路时侧身对着行进方向，
  // 站住时再转回正面。这里不再直接写死（原来写 0/π = 正对镜头平移 / 背对镜头，看着像螃蟹走）。
  window.pet?.walkTo?.(targetX, standY() ?? decision.y, duration);
  behavior.screen = null;
  window.__behaviorLog = { dir: behavior.dir, dist: Math.round(dist), duration: Math.round(duration), spot: decision.id, why: decision.why };
}

// ── 她的"决定"：不是随机，是按自己的偏好 + 当下的情况挑地方 ─────────
const decisionLog = [];
const visitCooldown = new Map();     // 地点 -> 上次去的时间

// 她的性子（从人设来：懒散、爱打盹、喜欢靠在边上、也想被看见）
const PERSONALITY = {
  corner: 1.35,       // 喜欢待在角落
  edge: 1.15,         // 喜欢靠边
  window: 1.0,        // 陪在你正用的窗口边
  mouse: 1.05,        // 有点好奇你在点什么
  middle: 0.7,        // 不太喜欢正中间（挡人）
};
const GAME_HINTS = /game|steam|epic|genshin|wuthering|kuro|yuanshen|honkai|league|valorant|dota|cs2|witcher|eldenring|danganronpa/i;
const CHAT_HINTS = /chatgpt|qq|wechat|weixin|discord|telegram|feishu|lark|dingtalk/i;

// 她自己的偏好（存本地，跨重启保留）：今天喜欢待在哪个角、想不想黏人
const pref = (() => {
  try {
    const saved = JSON.parse(localStorage.getItem('denia.pref') || 'null');
    if (saved && saved.at && Date.now() - saved.at < 6 * 3600_000) return saved;   // 六小时内保持同一个性子
  } catch { /* 坏了就重来 */ }
  const fresh = {
    at: Date.now(),
    corner: Math.random() < 0.5 ? 'right' : 'left',
    sociability: 0.7 + Math.random() * 0.7,     // 0.7 高冷 ~ 1.4 黏人
    restful: 0.6 + Math.random() * 0.8,         // 越大越爱坐下/趴着
  };
  try { localStorage.setItem('denia.pref', JSON.stringify(fresh)); } catch { /* 忽略 */ }
  return fresh;
})();

function pickSpots(env) {
  const wa = env.workArea;
  const b = env.bounds;
  const standYv = wa.y + wa.height - b.height + 10;
  const minX = wa.x + 6;
  const maxX = Math.max(minX, wa.x + wa.width - b.width - 6);
  const clamp = (x) => Math.max(minX, Math.min(maxX, Math.round(x)));
  const out = [
    { id: 'corner-right', kind: 'corner', x: clamp(wa.x + wa.width - b.width - 24), y: standYv, label: '右下角' },
    { id: 'corner-left', kind: 'corner', x: clamp(wa.x + 24), y: standYv, label: '左下角' },
    { id: 'edge-left', kind: 'edge', x: clamp(minX), y: standYv, label: '左边缘' },
    { id: 'edge-right', kind: 'edge', x: clamp(maxX), y: standYv, label: '右边缘' },
    { id: 'bottom-mid', kind: 'middle', x: clamp(wa.x + wa.width / 2 - b.width / 2), y: standYv, label: '底边中间' },
  ];
  if (env.mouse) {
    const side = env.mouse.x > wa.x + wa.width / 2 ? -1 : 1;
    out.push({ id: 'near-mouse', kind: 'mouse', x: clamp(env.mouse.x + side * 280 - b.width / 2), y: standYv, label: '你鼠标旁边' });
  }
  const fg = env.fg;
  if (fg && fg.w > 400 && fg.h > 300 && fg.process !== 'electron') {
    out.push({ id: 'window-right', kind: 'window', x: clamp(fg.x + fg.w + 16), y: standYv, label: '你窗口右边' });
    out.push({ id: 'window-left', kind: 'window', x: clamp(fg.x - b.width - 16), y: standYv, label: '你窗口左边' });
  }
  return out;
}

/** 她自己的决定：返回 null 表示"这次不想动" */
function decideDestination(env) {
  const wa = env.workArea;
  const fg = env.fg || {};
  const hour = new Date().getHours();
  const late = hour >= 23 || hour < 7;
  const isGame = GAME_HINTS.test(String(fg.process || '')) || GAME_HINTS.test(String(fg.title || ''))
    || (fg.w >= wa.width - 8 && fg.h >= wa.height - 8);       // 全屏 = 多半在玩/看片
  const busyWork = !isGame && /code|devenv|pycharm|idea|word|excel|powerpnt|chrome|edge|notepad|obsidian|typora|zotero/i.test(String(fg.process || ''));
  const chatting = !isGame && CHAT_HINTS.test(String(fg.process || ''));

  // 她偶尔就是想待着不动（不是懒，是有主意）
  if (Math.random() < (late ? 0.45 : 0.3) / pref.sociability) {
    const comfortable = late || Math.random() < 0.35 * pref.restful;
    return {
      id: 'stay', x: env.bounds.x, y: env.bounds.y,
      posture: comfortable ? (Math.random() < 0.55 ? 'sit' : 'lie') : 'stand',
      why: comfortable ? '她懒得动，就地坐下' : '她想先待着',
      say: Math.random() < 0.25 ? '我就在这儿。' : '',
    };
  }

  const now = performance.now();
  let best = null;
  for (const spot of pickSpots(env)) {
    let score = PERSONALITY[spot.kind] ?? 1;
    if (isGame) {
      if (spot.kind === 'corner') score += 1.4;               // 你在玩，她去角落不挡视线
      if (spot.kind === 'mouse') score -= 1.2;
      if (spot.kind === 'window') score -= 0.8;
      if (spot.kind === 'middle') score -= 1.0;
    } else if (chatting) {
      // 你在聊天/跟 AI 说话 —— 她会想凑过来（黏人程度决定多想去）
      if (spot.kind === 'window') score += 1.0 * pref.sociability;
      if (spot.kind === 'mouse') score += 0.4 * pref.sociability;
    } else if (busyWork) {
      if (spot.kind === 'window') score += 1.2;               // 你在干活，她凑过去陪着
      if (spot.kind === 'mouse') score += 0.5;
      if (spot.kind === 'corner') score -= 0.2;
    } else {
      if (spot.kind === 'mouse') score += 0.6;                // 你闲着，她会来撩你
      if (spot.kind === 'middle') score += 0.2;
    }
    // 她自己偏好的那个角
    if (spot.id === `corner-${pref.corner}`) score += 0.9;
    if (spot.id === `edge-${pref.corner}`) score += 0.3;
    if (late) {
      if (spot.kind === 'corner') score += 0.8;
      if (spot.kind === 'mouse') score -= 0.5;
    }
    const last = visitCooldown.get(spot.id) || 0;
    const sinceMin = (now - last) / 60000;
    if (sinceMin < 3) score -= 1.5;                           // 刚去过的地方不想马上再去
    const cur = env.bounds;
    const dist = Math.abs(spot.x - cur.x);
    if (dist < 120) score -= 1.2;                             // 已经在这儿了，没必要挪
    score += Math.random() * 0.6;                             // 一点随性
    if (!best || score > best.score) best = { ...spot, score };
  }
  if (!best || best.id === 'stay') return null;
  visitCooldown.set(best.id, now);

  const sayPool = {
    corner: ['我去那边待着，不挡你。', '角落比较舒服～', '我在这儿坐会儿。'],
    window: ['我在这儿陪你。', '你忙你的，我看着。', '凑近点看你干嘛。'],
    mouse: ['你点什么呢？', '我过来了哦。', '手别动，我看看。'],
    edge: ['我到边上待着。', '这儿安静。', '我挪挪位置。'],
    middle: ['我出来逛逛。', '换个地方站站。'],
  };
  const postureFor = (kind) => {
    const lazy = 0.35 * pref.restful;
    if (isGame) return Math.random() < 0.6 ? 'lie' : 'sit';
    if (late) return Math.random() < 0.5 ? 'sit' : 'lean';
    if (kind === 'window') return Math.random() < 0.4 ? 'lean' : 'stand';
    if (kind === 'corner') return Math.random() < lazy ? 'sit' : 'stand';
    return 'stand';
  };
  const why = isGame ? '你在忙，她躲角落'
    : chatting ? '你在说话，她凑过来看'
      : busyWork ? '你在干活，她凑过来陪'
        : late ? '夜深了，她想安静一点'
          : '她自己想换个地方';
  const lines = sayPool[best.kind] || [''];
  return {
    id: best.id, x: best.x, y: best.y,
    posture: postureFor(best.kind),
    why,
    label: best.label,
    say: Math.random() < 0.45 ? lines[Math.floor(Math.random() * lines.length)] : '',
  };
}

// 调试出口（放在声明之后，避免 TDZ）
window.__decisions = decisionLog;
window.__decide = decideDestination;

function tickBehavior(dt) {
  if (!behavior.free || !mesh || state.composerOpen) return;
  if (drowsy.on) return;                    // 困着就不乱走了（醒了再恢复溜达）
  if (behavior.mode === 'walking') {
    if (performance.now() >= behavior.walkEndsAt) {
      behavior.mode = 'idle';
      behavior.timer = 10 + Math.random() * 22;
      window.pet?.walkStop?.();
      const want = behavior.arrivePosture || 'stand';
      setPosture(want);
      window.__behaviorLog = { mode: 'idle', posture: postureTarget };
    }
    return;
  }
  if (behavior.pendingDecision && postureTarget === 'stand') {
    const d = behavior.pendingDecision;
    behavior.pendingDecision = null;
    walkToSpot(d);
    return;
  }
  behavior.timer -= dt;
  // 每隔几秒看一眼"你在干嘛"：情况变了（比如开始打游戏）她就早点做新决定
  behavior.envTimer = (behavior.envTimer || 0) - dt;
  if (behavior.envTimer <= 0) {
    behavior.envTimer = 9;
    window.pet?.env?.().then((env) => {
      if (!env) return;
      const fg = env.fg || {};
      const wa = env.workArea || { width: 1920, height: 1040 };
      const busyNow = GAME_HINTS.test(String(fg.process || '')) || GAME_HINTS.test(String(fg.title || ''))
        || (fg.w >= wa.width - 8 && fg.h >= wa.height - 8);
      if (behavior.lastBusy !== undefined && busyNow !== behavior.lastBusy) {
        behavior.timer = Math.min(behavior.timer, 2.5);        // 你去玩了/回来了，她重新想一下
      }
      behavior.lastBusy = busyNow;
    }).catch(() => {});
  }
  if (behavior.timer <= 0) startWalk();
}




