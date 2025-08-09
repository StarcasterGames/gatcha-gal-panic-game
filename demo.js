/*
 * Gatcha Gal Panic Demo v0.6
 *
 * This module implements a lightweight prototype of the core gameplay loops.
 * The goal of this build is to provide an interactive overworld map, a café
 * interior with a mission system, and three functional crane machine modes: a
 * soft‑body girls pickup, a rigid capsule pickup, and a simple bridge‑style
 * bar drop. The code is intentionally verbose for clarity and extensibility.
 */

import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.152.2/build/three.module.js';
import { OrbitControls } from 'https://cdn.jsdelivr.net/npm/three@0.152.2/examples/jsm/controls/OrbitControls.js';
import * as CANNON from 'https://cdn.jsdelivr.net/npm/cannon-es@0.20.0/dist/cannon-es.js';

// DOM elements for HUD
const yenEl = document.getElementById('yen');
const locationEl = document.getElementById('location');
const missionsEl = document.getElementById('missions');
const inventoryEl = document.getElementById('inventory');
const promptEl = document.getElementById('prompt');

// Define mission templates. Each mission specifies a class, a set of rarities to count
// towards progress, a goal count and a reward in Yen. Decor items simply store
// names to indicate what unlocks visually in the café.
const MISSION_DEFS = [
  {
    id: 1,
    description: 'Rescue a Maid of Rare+ rarity',
    targetClass: 'Maid',
    rarities: ['Rare', 'Super Rare', 'Legendary', 'Ultimate'],
    required: 1,
    reward: 1000,
    decor: 'Lanterns'
  },
  {
    id: 2,
    description: 'Collect two Neko commons',
    targetClass: 'Neko',
    rarities: ['Common'],
    required: 2,
    reward: 600,
    decor: 'Neko Poster'
  },
  {
    id: 3,
    description: 'Obtain a Tech Legendary or better',
    targetClass: 'Tech',
    rarities: ['Legendary', 'Ultimate'],
    required: 1,
    reward: 2000,
    decor: 'Hologram Sign'
  },
];

// Utility: Weighted random rarity selection
function rollRarity() {
  const roll = Math.random();
  if (roll < 0.01) return 'Ultimate';
  if (roll < 0.05) return 'Legendary';
  if (roll < 0.15) return 'Super Rare';
  if (roll < 0.40) return 'Rare';
  return 'Common';
}

// Utility: Random class selection based on arcade themes
function rollClass(themes) {
  // Pick from provided themes first; fallback to a random class
  const classes = ['Maid', 'Idol', 'Tech', 'Shrine', 'Neko'];
  if (themes && themes.length > 0) {
    return themes[Math.floor(Math.random() * themes.length)];
  }
  return classes[Math.floor(Math.random() * classes.length)];
}

// Primary state object storing game variables and references to scenes
const STATE = {
  mode: 'overworld', // 'overworld' | 'cafe' | 'arcade'
  yen: 2000,
  missions: [],
  missionIndex: 0,
  inventory: [],
  decor: [],
  selectedArcade: null,
  currentMachine: null,
  scene: null,
  world: null,
  camera: null,
  renderer: null,
  player: {
    mesh: null,
    velocity: new THREE.Vector3(),
    speed: 8,
    target: new THREE.Vector3(),
  },
  keys: {},
  arcades: [
    { name: 'Joybox Alley', pos: new THREE.Vector3(-20, 0, -10), color: 0xff62a1, machines: ['girls', 'bridge'], themes: ['Neko', 'Maid'] },
    { name: 'Neo-Taito', pos: new THREE.Vector3(20, 0, -10), color: 0x7a6cff, machines: ['capsules', 'bridge'], themes: ['Tech', 'Idol'] },
    { name: 'Giga Dome', pos: new THREE.Vector3(-20, 0, 10), color: 0xffc857, machines: ['girls', 'capsules'], themes: ['Maid', 'Shrine'] },
    { name: 'Otome Plaza', pos: new THREE.Vector3(20, 0, 10), color: 0x00c7ff, machines: ['girls'], themes: ['Idol', 'Neko'] },
    { name: 'Mecha Mart', pos: new THREE.Vector3(0, 0, 20), color: 0x7abeff, machines: ['capsules', 'bridge'], themes: ['Tech'] },
  ],
  cafe: { name: 'Cafe', pos: new THREE.Vector3(0, 0, 0), color: 0xffdbe6 },
  physicsObjects: [],
  machineObjects: [],
};

// Handle keyboard input
function onKeyDown(event) {
  STATE.keys[event.code] = true;
  // Interact in café
  if (STATE.mode === 'cafe' && event.code === 'Space') {
    // Talk to Uka: show current mission info
    if (STATE.missions.length > 0) {
      const current = STATE.missions[STATE.missions.length - 1];
      showPrompt(`Mission: ${current.description} — Progress ${current.progress}/${current.required}`);
    }
  }
}

function onKeyUp(event) {
  STATE.keys[event.code] = false;
  // Global key actions
  if (event.code === 'Escape') {
    if (STATE.mode === 'cafe' || STATE.mode === 'arcade') {
      // Return to overworld
      buildOverworld();
    }
  }
  // Enter action to interact with buildings
  if (event.code === 'Enter') {
    if (STATE.mode === 'overworld') {
      // Determine if near a location
      const p = STATE.player.mesh.position;
      const cafeDist = p.distanceTo(STATE.cafe.pos);
      if (cafeDist < 4) {
        buildCafe();
        return;
      }
      for (const arcade of STATE.arcades) {
        if (p.distanceTo(arcade.pos) < 4) {
          STATE.selectedArcade = arcade;
          showArcadeMenu();
          return;
        }
      }
    }
  }
  // Machine selection within arcade
  if (STATE.mode === 'arcade' && STATE.currentMachine == null) {
    let index = null;
    if (event.code === 'Digit1' || event.code === 'Numpad1') index = 0;
    if (event.code === 'Digit2' || event.code === 'Numpad2') index = 1;
    if (event.code === 'Digit3' || event.code === 'Numpad3') index = 2;
    if (index !== null && STATE.selectedArcade.machines[index]) {
      // Check for yen cost
      const cost = 200;
      if (STATE.yen >= cost) {
        STATE.yen -= cost;
        const machine = STATE.selectedArcade.machines[index];
        buildArcadeMachine(machine);
      } else {
        showPrompt('Not enough yen!');
      }
    }
  }
}

// Add rescued girl to inventory and update missions
function addGirlToInventory(girl) {
  STATE.inventory.push(girl);
  // Update missions
  for (const mission of STATE.missions) {
    if (!mission.completed && mission.targetClass === girl.class && mission.rarities.includes(girl.rarity)) {
      mission.progress++;
      if (mission.progress >= mission.required) {
        mission.completed = true;
        STATE.yen += mission.reward;
        STATE.decor.push(mission.decor);
        // Display completion message
        showPrompt(`Mission complete! ${mission.description}. Reward: ¥${mission.reward}`);
        // Automatically accept next mission if available
        acceptNextMission();
      }
    }
  }
}

// Accept next mission from definitions
function acceptNextMission() {
  if (STATE.missionIndex < MISSION_DEFS.length) {
    const def = MISSION_DEFS[STATE.missionIndex++];
    STATE.missions.push({ ...def, progress: 0, completed: false });
    showPrompt(`New mission: ${def.description}`);
  }
}

// Show prompt overlay text briefly
let promptTimeout;
function showPrompt(message) {
  promptEl.textContent = message;
  promptEl.style.display = 'block';
  clearTimeout(promptTimeout);
  promptTimeout = setTimeout(() => {
    promptEl.style.display = 'none';
  }, 4000);
}

// Build the overworld scene with simple geometry and no physics simulation
function buildOverworld() {
  STATE.mode = 'overworld';
  locationEl.textContent = 'Location: Overworld';
  // Ensure any arcade menu overlay is removed
  removeArcadeMenu();
  // Clean up previous physics world if any
  if (STATE.world) STATE.world = null;
  // Create Three.js scene
  STATE.scene = new THREE.Scene();
  STATE.scene.background = new THREE.Color(0xf5f5fa);
  // Lights
  const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1.0);
  hemi.position.set(0, 50, 0);
  STATE.scene.add(hemi);
  const dir = new THREE.DirectionalLight(0xffffff, 0.6);
  dir.position.set(30, 50, -30);
  STATE.scene.add(dir);
  // Ground plane
  const groundGeom = new THREE.PlaneGeometry(200, 200);
  const groundMat = new THREE.MeshLambertMaterial({ color: 0xf3f6ff });
  const ground = new THREE.Mesh(groundGeom, groundMat);
  ground.rotation.x = -Math.PI / 2;
  STATE.scene.add(ground);
  // Create buildings for arcades and cafe
  for (const arcade of STATE.arcades) {
    const boxGeom = new THREE.BoxGeometry(6, 6, 6);
    const boxMat = new THREE.MeshLambertMaterial({ color: arcade.color });
    const cube = new THREE.Mesh(boxGeom, boxMat);
    cube.position.copy(arcade.pos);
    cube.position.y = 3;
    STATE.scene.add(cube);
    // Label via sprite or simple text plane
    const spriteCanvas = document.createElement('canvas');
    spriteCanvas.width = 256;
    spriteCanvas.height = 64;
    const ctx = spriteCanvas.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.font = '32px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(arcade.name, 128, 40);
    const texture = new THREE.CanvasTexture(spriteCanvas);
    const spriteMat = new THREE.SpriteMaterial({ map: texture, transparent: true });
    const sprite = new THREE.Sprite(spriteMat);
    sprite.scale.set(6, 1.5, 1);
    sprite.position.set(arcade.pos.x, 6.8, arcade.pos.z);
    STATE.scene.add(sprite);
  }
  // Café building
  {
    const cafeGeom = new THREE.BoxGeometry(8, 6, 8);
    const cafeMat = new THREE.MeshLambertMaterial({ color: STATE.cafe.color });
    const cafeCube = new THREE.Mesh(cafeGeom, cafeMat);
    cafeCube.position.copy(STATE.cafe.pos);
    cafeCube.position.y = 3;
    STATE.scene.add(cafeCube);
    const spriteCanvas = document.createElement('canvas');
    spriteCanvas.width = 256;
    spriteCanvas.height = 64;
    const ctx = spriteCanvas.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.font = '32px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Cafe', 128, 40);
    const texture = new THREE.CanvasTexture(spriteCanvas);
    const spriteMat = new THREE.SpriteMaterial({ map: texture, transparent: true });
    const sprite = new THREE.Sprite(spriteMat);
    sprite.scale.set(6, 1.5, 1);
    sprite.position.set(STATE.cafe.pos.x, 6.8, STATE.cafe.pos.z);
    STATE.scene.add(sprite);
  }
  // Create player if not exists
  if (!STATE.player.mesh) {
    const sphereGeom = new THREE.SphereGeometry(0.8, 16, 16);
    const sphereMat = new THREE.MeshStandardMaterial({ color: 0x3333ff });
    const playerMesh = new THREE.Mesh(sphereGeom, sphereMat);
    playerMesh.position.set(0, 0.8, 0);
    STATE.scene.add(playerMesh);
    STATE.player.mesh = playerMesh;
  } else {
    STATE.scene.add(STATE.player.mesh);
  }
  // Set up camera
  if (!STATE.renderer) {
    STATE.renderer = new THREE.WebGLRenderer({ canvas: document.getElementById('game'), antialias: true });
    STATE.renderer.setPixelRatio(window.devicePixelRatio);
    STATE.renderer.setSize(window.innerWidth, window.innerHeight);
  }
  if (!STATE.camera) {
    STATE.camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 500);
  }
  STATE.camera.position.set(0, 20, 25);
  STATE.camera.lookAt(0, 0, 0);
  // Remove leftover machine objects
  STATE.physicsObjects = [];
  STATE.machineObjects = [];
  STATE.world = null;
  STATE.currentMachine = null;
  STATE.selectedArcade = null;
}

// Build café interior
function buildCafe() {
  STATE.mode = 'cafe';
  locationEl.textContent = 'Location: Cafe';
  // Clear world and scene
  STATE.scene = new THREE.Scene();
  STATE.scene.background = new THREE.Color(0xfaf8ff);
  STATE.world = null;
  // Lights
  const ambient = new THREE.AmbientLight(0xffffff, 0.7);
  STATE.scene.add(ambient);
  const spot = new THREE.PointLight(0xffffff, 0.8, 100);
  spot.position.set(0, 10, 0);
  STATE.scene.add(spot);
  // Floor
  const floorGeom = new THREE.PlaneGeometry(20, 20);
  const floorMat = new THREE.MeshLambertMaterial({ color: 0xfff0f5 });
  const floor = new THREE.Mesh(floorGeom, floorMat);
  floor.rotation.x = -Math.PI / 2;
  STATE.scene.add(floor);
  // Walls
  const wallGeom = new THREE.BoxGeometry(20, 6, 0.5);
  const wallMat = new THREE.MeshLambertMaterial({ color: 0xf5efff });
  const backWall = new THREE.Mesh(wallGeom, wallMat);
  backWall.position.set(0, 3, -10);
  STATE.scene.add(backWall);
  const frontWall = backWall.clone();
  frontWall.position.set(0, 3, 10);
  STATE.scene.add(frontWall);
  const sideWallGeom = new THREE.BoxGeometry(0.5, 6, 20);
  const leftWall = new THREE.Mesh(sideWallGeom, wallMat);
  leftWall.position.set(-10, 3, 0);
  STATE.scene.add(leftWall);
  const rightWall = leftWall.clone();
  rightWall.position.set(10, 3, 0);
  STATE.scene.add(rightWall);
  // Uka NPC represented by cylinder
  const ukaGeom = new THREE.CylinderGeometry(0.8, 0.8, 2.4, 16);
  const ukaMat = new THREE.MeshLambertMaterial({ color: 0xffaacc });
  const uka = new THREE.Mesh(ukaGeom, ukaMat);
  uka.position.set(0, 1.2, -3);
  STATE.scene.add(uka);
  // Accept next mission if none
  if (STATE.missions.length === 0) {
    acceptNextMission();
  }
  // Camera
  STATE.camera.position.set(0, 8, 12);
  STATE.camera.lookAt(0, 1, 0);
  // Prompt
  showPrompt('Press Space to talk to Uka. Press Escape to return to map.');
}

// Show arcade menu overlay in Overworld (choose machine)
function showArcadeMenu() {
  STATE.mode = 'arcade';
  locationEl.textContent = `Location: ${STATE.selectedArcade.name}`;
  STATE.scene = new THREE.Scene();
  STATE.scene.background = new THREE.Color(0xfefafe);
  STATE.world = null;
  // Lights
  const light = new THREE.AmbientLight(0xffffff, 0.8);
  STATE.scene.add(light);
  const spot = new THREE.PointLight(0xffffff, 0.6, 100);
  spot.position.set(0, 10, 0);
  STATE.scene.add(spot);
  // Floor
  const planeGeom = new THREE.PlaneGeometry(20, 20);
  const planeMat = new THREE.MeshLambertMaterial({ color: 0xfffdf8 });
  const plane = new THREE.Mesh(planeGeom, planeMat);
  plane.rotation.x = -Math.PI / 2;
  STATE.scene.add(plane);
  // Display machine selection text using sprites
  const instructions = document.createElement('div');
  instructions.style.position = 'absolute';
  instructions.style.top = '50%';
  instructions.style.left = '50%';
  instructions.style.transform = 'translate(-50%, -50%)';
  instructions.style.padding = '20px';
  instructions.style.background = 'rgba(255,255,255,0.9)';
  instructions.style.borderRadius = '16px';
  instructions.style.fontSize = '18px';
  instructions.style.color = '#1b1e27';
  instructions.style.textAlign = 'center';
  instructions.innerHTML = `<strong>${STATE.selectedArcade.name}</strong><br/>` +
    'Press 1: ' + STATE.selectedArcade.machines[0] + '<br/>' +
    (STATE.selectedArcade.machines[1] ? 'Press 2: ' + STATE.selectedArcade.machines[1] + '<br/>' : '') +
    (STATE.selectedArcade.machines[2] ? 'Press 3: ' + STATE.selectedArcade.machines[2] + '<br/>' : '') +
    '<small>Esc: back to map</small>';
  // Append to body
  instructions.id = 'arcade-menu';
  document.body.appendChild(instructions);
  // Remove instructions on machine start or exit
}

// Remove arcade menu DOM element if present
function removeArcadeMenu() {
  const menu = document.getElementById('arcade-menu');
  if (menu) menu.remove();
}

// Build a specific machine game within an arcade
function buildArcadeMachine(type) {
  removeArcadeMenu();
  STATE.currentMachine = type;
  // Setup physics world for machines
  STATE.world = new CANNON.World({ gravity: new CANNON.Vec3(0, -9.82, 0) });
  STATE.scene = new THREE.Scene();
  STATE.scene.background = new THREE.Color(0xfff9fb);
  // Lights
  const ambient = new THREE.AmbientLight(0xffffff, 0.8);
  STATE.scene.add(ambient);
  const dir = new THREE.DirectionalLight(0xffffff, 0.6);
  dir.position.set(10, 15, 5);
  STATE.scene.add(dir);
  // Floor physics and mesh
  const floorBody = new CANNON.Body({ mass: 0, shape: new CANNON.Plane(), material: new CANNON.Material('floor') });
  floorBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
  STATE.world.addBody(floorBody);
  const floorGeom = new THREE.PlaneGeometry(20, 20);
  const floorMat = new THREE.MeshLambertMaterial({ color: 0xfef0fa });
  const floorMesh = new THREE.Mesh(floorGeom, floorMat);
  floorMesh.rotation.x = -Math.PI / 2;
  STATE.scene.add(floorMesh);
  // Setup camera for machine
  STATE.camera.position.set(0, 15, 20);
  STATE.camera.lookAt(0, 0, 0);
  // Reset arrays
  STATE.physicsObjects = [];
  STATE.machineObjects = [];
  // Create environment per type
  if (type === 'girls') {
    spawnGirlsMachine();
    showPrompt('Girls Machine: use WASD to move, Space to grab/release. Esc to quit.');
  } else if (type === 'capsules') {
    spawnCapsuleMachine();
    showPrompt('Capsule Machine: use WASD to move, Space to grab/release. Esc to quit.');
  } else if (type === 'bridge') {
    spawnBridgeMachine();
    showPrompt('Bridge Machine: press Space to nudge boxes. Esc to quit.');
  }

  // Update location text to include machine type
  locationEl.textContent = `Location: ${STATE.selectedArcade.name} — ${type}`;
}

// Spawn girls with soft‑body proxy (approximated via spheres) and claw
function spawnGirlsMachine() {
  // Boundaries / walls
  const wallMat = new CANNON.Material('wall');
  const planeSize = 16;
  // Four walls around edges
  const walls = [];
  function addWall(x, z, rotation) {
    const body = new CANNON.Body({ mass: 0, material: wallMat });
    body.addShape(new CANNON.Plane());
    body.position.set(x, 0, z);
    body.quaternion.setFromEuler(0, rotation, 0);
    STATE.world.addBody(body);
  }
  // +X wall
  addWall(planeSize / 2, 0, Math.PI / 2);
  // -X wall
  addWall(-planeSize / 2, 0, -Math.PI / 2);
  // +Z wall
  addWall(0, planeSize / 2, Math.PI);
  // -Z wall
  addWall(0, -planeSize / 2, 0);
  // Visual walls
  const wallGeom = new THREE.BoxGeometry(0.5, 3, planeSize);
  const wallMeshMat = new THREE.MeshLambertMaterial({ color: 0xe0d6ff });
  const wall1 = new THREE.Mesh(wallGeom, wallMeshMat);
  wall1.position.set(planeSize / 2, 1.5, 0);
  STATE.scene.add(wall1);
  const wall2 = wall1.clone(); wall2.position.set(-planeSize / 2, 1.5, 0); STATE.scene.add(wall2);
  const wallGeom2 = new THREE.BoxGeometry(planeSize, 3, 0.5);
  const wall3 = new THREE.Mesh(wallGeom2, wallMeshMat);
  wall3.position.set(0, 1.5, planeSize / 2);
  STATE.scene.add(wall3);
  const wall4 = wall3.clone(); wall4.position.set(0, 1.5, -planeSize / 2); STATE.scene.add(wall4);
  // Claw representation
  const clawGeom = new THREE.BoxGeometry(1, 0.5, 1);
  const clawMat = new THREE.MeshLambertMaterial({ color: 0x8888ff });
  const clawMesh = new THREE.Mesh(clawGeom, clawMat);
  clawMesh.position.set(0, 8, 0);
  STATE.scene.add(clawMesh);
  STATE.machineObjects.push({ type: 'claw', mesh: clawMesh, grabbing: false, grabbed: null });
  // Spawn girls as soft spheres
  for (let i = 0; i < 8; i++) {
    const radius = 0.6;
    const shape = new CANNON.Sphere(radius);
    const body = new CANNON.Body({ mass: 0.5, shape });
    body.position.set((Math.random() - 0.5) * 10, 3 + Math.random() * 2, (Math.random() - 0.5) * 10);
    STATE.world.addBody(body);
    // Three.js mesh
    const color = new THREE.Color().setHSL(Math.random(), 0.6, 0.7);
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 16, 16), new THREE.MeshLambertMaterial({ color }));
    STATE.scene.add(mesh);
    // Assign class and rarity
    const girlClass = rollClass(STATE.selectedArcade.themes);
    const girlRarity = rollRarity();
    STATE.physicsObjects.push({ body, mesh, class: girlClass, rarity: girlRarity });
  }
}

// Spawn capsule machine
function spawnCapsuleMachine() {
  // Walls same as girls machine
  const planeSize = 16;
  const wallMat = new CANNON.Material('wall');
  function addWall(x, z, rotation) {
    const body = new CANNON.Body({ mass: 0, material: wallMat });
    body.addShape(new CANNON.Plane());
    body.position.set(x, 0, z);
    body.quaternion.setFromEuler(0, rotation, 0);
    STATE.world.addBody(body);
  }
  addWall(planeSize / 2, 0, Math.PI / 2);
  addWall(-planeSize / 2, 0, -Math.PI / 2);
  addWall(0, planeSize / 2, Math.PI);
  addWall(0, -planeSize / 2, 0);
  // Visual walls
  const wallGeom = new THREE.BoxGeometry(0.5, 3, planeSize);
  const wallMatViz = new THREE.MeshLambertMaterial({ color: 0xd0f0ff });
  const w1 = new THREE.Mesh(wallGeom, wallMatViz);
  w1.position.set(planeSize / 2, 1.5, 0);
  STATE.scene.add(w1);
  const w2 = w1.clone(); w2.position.set(-planeSize / 2, 1.5, 0); STATE.scene.add(w2);
  const wallGeom2 = new THREE.BoxGeometry(planeSize, 3, 0.5);
  const w3 = new THREE.Mesh(wallGeom2, wallMatViz);
  w3.position.set(0, 1.5, planeSize / 2);
  STATE.scene.add(w3);
  const w4 = w3.clone(); w4.position.set(0, 1.5, -planeSize / 2); STATE.scene.add(w4);
  // Claw
  const clawGeom = new THREE.BoxGeometry(1, 0.5, 1);
  const clawMat = new THREE.MeshLambertMaterial({ color: 0x88ccff });
  const clawMesh = new THREE.Mesh(clawGeom, clawMat);
  clawMesh.position.set(0, 8, 0);
  STATE.scene.add(clawMesh);
  STATE.machineObjects.push({ type: 'claw', mesh: clawMesh, grabbing: false, grabbed: null });
  // Spawn capsules as rigid spheres
  for (let i = 0; i < 8; i++) {
    const radius = 0.7;
    const shape = new CANNON.Sphere(radius);
    const body = new CANNON.Body({ mass: 0.7, shape });
    body.position.set((Math.random() - 0.5) * 10, 3 + Math.random() * 2, (Math.random() - 0.5) * 10);
    STATE.world.addBody(body);
    // Visual: half clear (color on bottom, transparent top)
    const capsuleGeo = new THREE.SphereGeometry(radius, 16, 16);
    const material = new THREE.MeshLambertMaterial({ color: 0xffffff, transparent: true, opacity: 0.6 });
    const mesh = new THREE.Mesh(capsuleGeo, material);
    // Add colored half shell
    const shellGeo = new THREE.SphereGeometry(radius, 16, 16, 0, Math.PI * 2, 0, Math.PI / 2);
    const shellMat = new THREE.MeshLambertMaterial({ color: new THREE.Color().setHSL(Math.random(), 0.6, 0.6) });
    const shell = new THREE.Mesh(shellGeo, shellMat);
    shell.rotation.x = Math.PI;
    const capsuleGroup = new THREE.Group();
    capsuleGroup.add(mesh);
    capsuleGroup.add(shell);
    STATE.scene.add(capsuleGroup);
    // Assign class/rarity
    const girlClass = rollClass(STATE.selectedArcade.themes);
    const girlRarity = rollRarity();
    STATE.physicsObjects.push({ body, mesh: capsuleGroup, class: girlClass, rarity: girlRarity });
  }
}

// Spawn bridge‑style machine
function spawnBridgeMachine() {
  // Set up world boundaries but open at one end
  const planeSize = 16;
  // Bars: Represented by thin boxes suspended in mid‑air. Prize boxes sit on top.
  const barLength = 12;
  const barWidth = 0.5;
  const barHeight = 0.3;
  const barOffset = 1.0; // distance between bars
  // Physics bars (static bodies)
  const barShape = new CANNON.Box(new CANNON.Vec3(barLength / 2, barHeight / 2, barWidth / 2));
  const bar1 = new CANNON.Body({ mass: 0, shape: barShape });
  bar1.position.set(0, 2.5, -barOffset / 2);
  STATE.world.addBody(bar1);
  const bar2 = new CANNON.Body({ mass: 0, shape: barShape });
  bar2.position.set(0, 2.5, barOffset / 2);
  STATE.world.addBody(bar2);
  // Visual bars
  const barGeom = new THREE.BoxGeometry(barLength, barHeight, barWidth);
  const barMat = new THREE.MeshLambertMaterial({ color: 0xffd1e8 });
  const barMesh1 = new THREE.Mesh(barGeom, barMat);
  barMesh1.position.copy(bar1.position);
  STATE.scene.add(barMesh1);
  const barMesh2 = new THREE.Mesh(barGeom, barMat);
  barMesh2.position.copy(bar2.position);
  STATE.scene.add(barMesh2);
  // Prize boxes (rigid bodies)
  for (let i = 0; i < 5; i++) {
    const boxSize = 1;
    const shape = new CANNON.Box(new CANNON.Vec3(boxSize / 2, boxSize / 2, boxSize / 2));
    const body = new CANNON.Body({ mass: 1.0, shape });
    // Place randomly along bars
    const xPos = (Math.random() - 0.5) * (barLength - 2);
    const zPos = (Math.random() < 0.5 ? -barOffset / 2 : barOffset / 2);
    body.position.set(xPos, 3.5, zPos);
    STATE.world.addBody(body);
    // Visual
    const color = new THREE.Color().setHSL(Math.random(), 0.5, 0.7);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(boxSize, boxSize, boxSize), new THREE.MeshLambertMaterial({ color }));
    mesh.position.copy(body.position);
    STATE.scene.add(mesh);
    // Assign class/rarity
    const gClass = rollClass(STATE.selectedArcade.themes);
    const rarity = rollRarity();
    STATE.physicsObjects.push({ body, mesh, class: gClass, rarity });
  }
  // Bridge nudge control: We'll interpret "space" as applying impulse to nearest box
}

// Update physics and meshes each frame
function updatePhysics(dt) {
  if (!STATE.world) return;
  STATE.world.step(1 / 60, dt);
  // Sync meshes with bodies
  for (const obj of STATE.physicsObjects) {
    obj.mesh.position.copy(obj.body.position);
    obj.mesh.quaternion.copy(obj.body.quaternion);
  }
}

// Update claw logic
function updateClaw(dt) {
  for (const claw of STATE.machineObjects) {
    if (claw.type !== 'claw') continue;
    // Move claw horizontally according to keys
    const speed = 8;
    const moveX = (STATE.keys['ArrowRight'] || STATE.keys['KeyD'] ? 1 : 0) - (STATE.keys['ArrowLeft'] || STATE.keys['KeyA'] ? 1 : 0);
    const moveZ = (STATE.keys['ArrowUp'] || STATE.keys['KeyW'] ? -1 : 0) + (STATE.keys['ArrowDown'] || STATE.keys['KeyS'] ? 1 : 0);
    claw.mesh.position.x += moveX * speed * dt;
    claw.mesh.position.z += moveZ * speed * dt;
    // Clamp within bounds
    const limit = 7;
    claw.mesh.position.x = Math.max(-limit, Math.min(limit, claw.mesh.position.x));
    claw.mesh.position.z = Math.max(-limit, Math.min(limit, claw.mesh.position.z));
    // Handle grabbing
    if (STATE.keys['Space']) {
      if (!claw.grabbing) {
        // Attempt to grab nearest prize below the claw
        let nearest = null;
        let nearestDist = 1.2; // threshold
        const clawPos = claw.mesh.position;
        for (const obj of STATE.physicsObjects) {
          if (obj.body.sleepState === CANNON.Body.SLEEPING) continue;
          const dist = clawPos.distanceTo(obj.body.position);
          if (dist < nearestDist) {
            nearest = obj;
            nearestDist = dist;
          }
        }
        if (nearest) {
          claw.grabbing = true;
          claw.grabbed = nearest;
          // Disable physics for grabbed body temporarily
          nearest.body.type = CANNON.Body.KINEMATIC;
          nearest.body.velocity.setZero();
        }
      }
    } else {
      // Release if currently grabbing
      if (claw.grabbing && claw.grabbed) {
        const obj = claw.grabbed;
        obj.body.type = CANNON.Body.DYNAMIC;
        // Drop downward by small offset
        obj.body.position.set(claw.mesh.position.x, 6, claw.mesh.position.z);
        claw.grabbing = false;
        claw.grabbed = null;
      }
    }
    // If grabbing, update grabbed position to follow claw
    if (claw.grabbing && claw.grabbed) {
      claw.grabbed.body.position.set(claw.mesh.position.x, 6, claw.mesh.position.z);
    }
  }
}

// Check for prizes delivered to chute (within bounding box near origin)
function checkChute() {
  if (!STATE.currentMachine) return;
  const chuteRange = 2;
  for (let i = STATE.physicsObjects.length - 1; i >= 0; i--) {
    const obj = STATE.physicsObjects[i];
    if (!obj.body || !obj.mesh) continue;
    // Consider a drop successful if object's Y < 0.5 and distance to origin < range
    if (obj.body.position.y < 0.5 && Math.abs(obj.body.position.x) < chuteRange && Math.abs(obj.body.position.z) < chuteRange) {
      // Remove from physics world and scene
      STATE.world.removeBody(obj.body);
      STATE.scene.remove(obj.mesh);
      // Add to inventory (only if it's not a bridge box)
      addGirlToInventory({ class: obj.class, rarity: obj.rarity });
      // Remove from array
      STATE.physicsObjects.splice(i, 1);
    }
  }
}

// Update loop for bridge machine: apply nudge on space press and handle falls
function updateBridge(dt) {
  // Nudge: if space pressed in this frame
  if (STATE.keys['Space']) {
    // For each body, apply small impulse
    for (const obj of STATE.physicsObjects) {
      obj.body.applyImpulse(new CANNON.Vec3((Math.random() - 0.5) * 0.5, 0, (Math.random() - 0.5) * 0.5), obj.body.position);
    }
    // Clear space key to avoid continuous impulse
    STATE.keys['Space'] = false;
  }
  // Check for any box falling below bars (y < 1.5) -> success
  for (let i = STATE.physicsObjects.length - 1; i >= 0; i--) {
    const obj = STATE.physicsObjects[i];
    if (obj.body.position.y < 1.4) {
      // Success! Remove and reward
      STATE.world.removeBody(obj.body);
      STATE.scene.remove(obj.mesh);
      STATE.physicsObjects.splice(i, 1);
      addGirlToInventory({ class: obj.class, rarity: obj.rarity });
    }
  }
}

// Main animation loop
const clock = new THREE.Clock();
function animate() {
  requestAnimationFrame(animate);
  const dt = clock.getDelta();
  if (STATE.mode === 'overworld') {
    updateOverworld(dt);
  } else if (STATE.mode === 'cafe') {
    // No physics; maybe add small idle animation
  } else if (STATE.mode === 'arcade' && STATE.currentMachine) {
    // Update physics and machine logic
    updatePhysics(dt);
    if (STATE.currentMachine === 'girls' || STATE.currentMachine === 'capsules') {
      updateClaw(dt);
      checkChute();
    } else if (STATE.currentMachine === 'bridge') {
      updateBridge(dt);
    }
  }
  // Render
  if (STATE.renderer && STATE.scene && STATE.camera) {
    STATE.renderer.render(STATE.scene, STATE.camera);
  }
  updateHUD();
}

// Update player in overworld
function updateOverworld(dt) {
  // Movement
  const dir = new THREE.Vector3();
  if (STATE.keys['ArrowUp'] || STATE.keys['KeyW']) dir.z -= 1;
  if (STATE.keys['ArrowDown'] || STATE.keys['KeyS']) dir.z += 1;
  if (STATE.keys['ArrowLeft'] || STATE.keys['KeyA']) dir.x -= 1;
  if (STATE.keys['ArrowRight'] || STATE.keys['KeyD']) dir.x += 1;
  dir.normalize();
  const moveSpeed = STATE.player.speed;
  STATE.player.mesh.position.x += dir.x * moveSpeed * dt;
  STATE.player.mesh.position.z += dir.z * moveSpeed * dt;
  // Boundaries to keep within map
  const limit = 35;
  STATE.player.mesh.position.x = Math.max(-limit, Math.min(limit, STATE.player.mesh.position.x));
  STATE.player.mesh.position.z = Math.max(-limit, Math.min(limit, STATE.player.mesh.position.z));
  // Camera follow (offset behind)
  const camOffset = new THREE.Vector3(0, 15, 25);
  const targetPos = STATE.player.mesh.position.clone().add(camOffset);
  STATE.camera.position.lerp(targetPos, 0.1);
  STATE.camera.lookAt(STATE.player.mesh.position.x, 0, STATE.player.mesh.position.z);
  // Prompt for nearby locations
  let nearest = null;
  let nearestDist = 4;
  // Check café
  const distCafe = STATE.player.mesh.position.distanceTo(STATE.cafe.pos);
  if (distCafe < nearestDist) {
    nearest = { name: 'Cafe' };
    nearestDist = distCafe;
  }
  // Check arcades
  for (const arcade of STATE.arcades) {
    const d = STATE.player.mesh.position.distanceTo(arcade.pos);
    if (d < nearestDist) {
      nearest = { name: arcade.name };
      nearestDist = d;
    }
  }
  if (nearest) {
    promptEl.textContent = `Press Enter to enter ${nearest.name}`;
    promptEl.style.display = 'block';
  } else {
    promptEl.style.display = 'none';
  }
}

// Update HUD elements
function updateHUD() {
  yenEl.textContent = `Yen: ¥${STATE.yen}`;
  // Location text is set when building scenes
  // Missions
  missionsEl.innerHTML = '';
  if (STATE.missions.length === 0) {
    const li = document.createElement('li');
    li.textContent = 'No missions';
    missionsEl.appendChild(li);
  } else {
    for (const mission of STATE.missions) {
      const li = document.createElement('li');
      li.textContent = mission.description + ' — ' + mission.progress + '/' + mission.required + (mission.completed ? ' (Complete)' : '');
      missionsEl.appendChild(li);
    }
  }
  // Inventory summary by rarity
  const counts = {};
  for (const g of STATE.inventory) {
    counts[g.rarity] = (counts[g.rarity] || 0) + 1;
  }
  inventoryEl.innerHTML = '';
  const rarities = ['Ultimate','Legendary','Super Rare','Rare','Common'];
  for (const r of rarities) {
    const count = counts[r] || 0;
    const li = document.createElement('li');
    li.textContent = `${r}: ${count}`;
    inventoryEl.appendChild(li);
  }
}

// Initialize renderer, events and start loop
function init() {
  // Build initial overworld scene
  buildOverworld();
  // Register event listeners
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('resize', onResize);
  animate();
}

// Resize handler
function onResize() {
  if (STATE.renderer && STATE.camera) {
    STATE.renderer.setSize(window.innerWidth, window.innerHeight);
    STATE.camera.aspect = window.innerWidth / window.innerHeight;
    STATE.camera.updateProjectionMatrix();
  }
}

// Kick off game
init();