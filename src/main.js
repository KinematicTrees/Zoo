import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Timer } from 'three';
import { GUI } from 'three/addons/libs/lil-gui.module.min.js';

import * as KT from './tree.mjs';

let singletonApp = null;

/**
 * Initialise the Zoo viewer.
 *
 * index.html should call this once, then use the returned handle to hot-swap robots.
 *
 * @param {string} robotPath e.g. "page1/" (served from /public)
 * @param {{ setStatus?: (text:string)=>void }} opts
 */
export async function init(robotPath, opts = {}) {
  if (singletonApp) {
    if (robotPath) await singletonApp.loadRobot(robotPath);
    window.__zooApp = singletonApp;
    return singletonApp;
  }

  const app = new ZooApp(opts);
  await app.start(robotPath);
  singletonApp = app;
  window.__zooApp = app;
  return app;
}

class ZooApp {
  constructor(opts = {}) {
    this.setStatus = typeof opts.setStatus === 'function' ? opts.setStatus : () => {};

    this.scene = null;
    this.camera = null;
    this.renderer = null;
    this.controls = null;
    this.timer = null;

    this.light = null;
    this.directionalLight = null;

    this.robotGroup = null;
    this.tree = null;

    this.gui = null;
    this.API = { angle: 0.0 };
    this.selection = -1;

    this.coords = new THREE.Vector2();
    this.raycaster = new THREE.Raycaster();

    this.loadSeq = 0;

    // IK demo/session state (kinematics_go backend)
    this.ikSessionId = null;
    this.ikDemoActive = false;
    this.ikObjectiveName = 'eyelid_lh';
    this.ikRootName = 'body';
    this.ikTargetPosition = new THREE.Vector3();
    this.ikLastSolveMs = 0;
    this.ikSolveIntervalMs = 80;
    this.ikSolveInFlight = false;
    this.ikTargetMarker = null;
    this.ikTargetConnector = null;
    this.ikObjectiveMarker = null;
    this.ikDraggingTarget = false;
    this.ikDragPlane = new THREE.Plane();
    this.ikDragPoint = new THREE.Vector3();
    this.ikConnectorStart = new THREE.Vector3();
    this.ikConnectorEnd = new THREE.Vector3();
    this.ikConnectorMid = new THREE.Vector3();
    this.ikConnectorDir = new THREE.Vector3();
    this.ikUpAxis = new THREE.Vector3(0, 1, 0);
    // Viewer root is rotated -90deg about X in tree.mjs; IK service expects unrotated tree frame.
    this.ikWorldToModelQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, 0, 0));
    this.ikModelToWorldQuat = this.ikWorldToModelQuat.clone().invert();

    this._onMouseMove = (event) => this.onMouseMove(event);
    this._onMouseDown = (event) => this.onMouseDown(event);
    this._onMouseUp = () => this.onMouseUp();
    this._onResize = () => this.onResize();
  }

  async start(initialRobotPath) {
    // SCENE/CAMERA/RENDERER
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    this.camera.position.z = 1;

    const winWidthScale = 1.0;
    this.renderer = new THREE.WebGLRenderer();
    this.renderer.setSize(window.innerWidth * winWidthScale, window.innerHeight);
    this.renderer.setClearColor(0x000000, 1);
    document.body.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;

    // LIGHTS
    this.light = new THREE.AmbientLight(0xffffff, 1);
    this.scene.add(this.light);

    this.directionalLight = new THREE.DirectionalLight(0xffffff, 1);
    this.directionalLight.position.set(0, 0, 1);
    this.directionalLight.target.position.set(0, 0, 0);
    this.scene.add(this.directionalLight);

    // ROBOT ROOT GROUP (so we can hot-swap cleanly)
    this.robotGroup = new THREE.Group();
    this.robotGroup.name = 'robot-root';
    this.scene.add(this.robotGroup);

    // INPUT
    this.renderer.domElement.addEventListener('mousemove', this._onMouseMove);
    this.renderer.domElement.addEventListener('mousedown', this._onMouseDown);
    this.renderer.domElement.addEventListener('mouseup', this._onMouseUp);
    this.renderer.domElement.addEventListener('mouseleave', this._onMouseUp);
    window.addEventListener('mouseup', this._onMouseUp);
    window.addEventListener('resize', this._onResize);

    // ANIMATION LOOP
    this.timer = new Timer();
    this.timer.connect(document);

    this.renderer.setAnimationLoop(() => this.animate());

    // Initial load
    if (initialRobotPath) {
      await this.loadRobot(initialRobotPath);
    }
  }

  normaliseRobotPath(robotPath) {
    if (!robotPath) return '';
    robotPath = robotPath.trim();
    if (robotPath.startsWith('/')) robotPath = robotPath.slice(1);
    if (!robotPath.endsWith('/')) robotPath += '/';
    return robotPath;
  }

  async loadRobot(robotPath) {
    robotPath = this.normaliseRobotPath(robotPath);
    if (!robotPath) return;

    const mySeq = ++this.loadSeq;
    this.setStatus(`Loading ${robotPath}...`);

    try {
      const [tree, meshesPromise] = await KT.loadRobot(`${robotPath}tree.json`, robotPath, [0.5, 0.5, 0.5]);

      // If another load started while we were fetching, drop this result.
      if (mySeq !== this.loadSeq) {
        this.disposeTree(tree);
        return;
      }

      // Swap
      this.clearRobot();
      this.tree = tree;
      this.robotGroup.add(tree.Root);

      this.selection = -1;
      this.rebuildJointGui(tree);

      // Meshes are async; don't block init/hot-swap on them.
      this.setStatus(`Loaded ${robotPath} (loading meshes...)`);

      meshesPromise
        .then(() => {
          if (mySeq !== this.loadSeq) {
            this.disposeTree(tree);
            return;
          }
          this.fitCameraToObject(tree.Root, 1.4);
          this.setStatus(`Loaded ${robotPath}`);
          this.render();
        })
        .catch((e) => {
          console.warn('Some meshes failed to load:', e);
          if (mySeq !== this.loadSeq) {
            this.disposeTree(tree);
            return;
          }
          this.fitCameraToObject(tree.Root, 1.4);
          this.setStatus(`Loaded ${robotPath} (some meshes failed)`);
          this.render();
        });

      this.render();

      // Auto-start IK demo for bridge validation.
      await this.setupIKDemo(robotPath);
    } catch (e) {
      console.error('Failed to load robot:', robotPath, e);
      this.setStatus(`Failed to load ${robotPath}`);
    }
  }

  fitCameraToObject(object, offset = 1.25) {
    if (!this.camera || !this.controls || !object) return;

    const box = new THREE.Box3().setFromObject(object);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());

    const maxDim = Math.max(size.x, size.y, size.z);
    if (!Number.isFinite(maxDim) || maxDim <= 0) {
      console.warn('fitCameraToObject: invalid bounds', { size, center });
      return;
    }

    const fov = this.camera.fov * (Math.PI / 180);
    let cameraZ = Math.abs((maxDim / 2) / Math.tan(fov / 2));
    cameraZ *= offset;

    this.controls.target.copy(center);
    this.camera.position.set(center.x, center.y, center.z + cameraZ);

    const minZ = box.min.z;
    const cameraToFarEdge = (minZ < 0) ? (-minZ + cameraZ) : (cameraZ - minZ);
    this.camera.far = Math.max(1000, cameraToFarEdge * 3);
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  clearRobot() {
    if (this.tree?.Root) {
      this.robotGroup.remove(this.tree.Root);
      this.disposeObject3D(this.tree.Root);
    }
    this.tree = null;

    while (this.robotGroup.children.length) {
      const c = this.robotGroup.children[this.robotGroup.children.length - 1];
      this.robotGroup.remove(c);
      this.disposeObject3D(c);
    }

    this.selection = -1;
    this.stopIKDemo();

    if (this.gui) {
      this.gui.destroy();
      this.gui = null;
    }
  }

  disposeTree(tree) {
    if (tree?.Root) this.disposeObject3D(tree.Root);
  }

  disposeObject3D(obj) {
    if (!obj) return;

    obj.traverse((o) => {
      if (o.isMesh) {
        if (o.geometry?.dispose) o.geometry.dispose();

        const disposeMaterial = (m) => {
          if (!m) return;
          for (const key of Object.keys(m)) {
            const v = m[key];
            if (v && v.isTexture && v.dispose) v.dispose();
          }
          if (m.dispose) m.dispose();
        };

        if (Array.isArray(o.material)) o.material.forEach(disposeMaterial);
        else disposeMaterial(o.material);
      }
    });
  }

  rebuildJointGui(tree) {
    if (this.gui) this.gui.destroy();

    this.gui = new GUI({ title: 'Joint Control', width: 300 });
    this.gui.domElement.id = 'gui';

    const jointMap = new Map();
    for (let i = 0; i < tree.Joints.length; i++) {
      if (tree.Joints[i].type === 'revolute') {
        jointMap.set(tree.Joints[i].name, i);
      }
    }

    // "Selected" joint control (uses raycast selection)
    this.gui
      .add(this.API, 'angle', -1, 1, 0.02)
      .name('Selected')
      .onChange(() => {
        if (this.selection !== -1) {
          if (tree.Links[this.selection].ParentID !== -1) {
            tree.Joints[tree.Links[this.selection].ParentID].SetByUnitScaling(this.API.angle);
          }
        }
        this.render();
      });

    // Per-joint controls
    for (const [jointName, jointIndex] of jointMap.entries()) {
      this.gui
        .add(this.API, 'angle', -1, 1, 0.02)
        .name(jointName)
        .onChange(() => {
          tree.Joints[jointIndex].SetByUnitScaling(this.API.angle);
          this.render();
        });
    }
  }

  normaliseRobotAbsoluteTreePath(robotPath) {
    const normalized = this.normaliseRobotPath(robotPath);
    return `/home/stuart/KinematicTrees/Zoo/public/${normalized}tree.json`;
  }

  getLinkWorldPositionByName(linkName) {
    if (!this.tree || !linkName) return null;
    const idx = this.tree.Links.findIndex((l) => l?.name === linkName);
    if (idx < 0) return null;
    const out = new THREE.Vector3();
    this.tree.Links[idx].origin.getWorldPosition(out);
    return out;
  }

  getObjectiveAnchorWorldPosition() {
    const idx = this.tree?.Links?.findIndex((l) => l?.name === this.ikObjectiveName);
    if (idx == null || idx < 0) return null;
    const linkOrigin = this.tree.Links[idx].origin;
    if (!linkOrigin) return null;

    // Prefer visual anchor (mesh bounds center) for connector so it matches what user sees.
    const box = new THREE.Box3().setFromObject(linkOrigin);
    if (!box.isEmpty()) {
      const center = new THREE.Vector3();
      box.getCenter(center);
      return center;
    }

    const out = new THREE.Vector3();
    linkOrigin.getWorldPosition(out);
    return out;
  }

  ensureIKTargetMarker() {
    if (this.ikTargetMarker) return;
    const g = new THREE.SphereGeometry(0.02, 18, 18);
    const m = new THREE.MeshStandardMaterial({ color: 0xffd166, emissive: 0x553300, emissiveIntensity: 0.5 });
    this.ikTargetMarker = new THREE.Mesh(g, m);
    this.ikTargetMarker.name = 'ik-target-marker';
    this.scene.add(this.ikTargetMarker);
  }

  ensureIKTargetConnector() {
    if (this.ikTargetConnector) return;
    // Radius = 1/5 of target sphere radius (0.02 / 5 = 0.004)
    const g = new THREE.CylinderGeometry(0.004, 0.004, 1.0, 14);
    const m = new THREE.MeshStandardMaterial({ color: 0x66ccff, emissive: 0x112233, emissiveIntensity: 0.35 });
    this.ikTargetConnector = new THREE.Mesh(g, m);
    this.ikTargetConnector.name = 'ik-target-connector';
    this.scene.add(this.ikTargetConnector);
  }

  ensureIKObjectiveMarker() {
    if (this.ikObjectiveMarker) return;
    const g = new THREE.SphereGeometry(0.012, 14, 14);
    const m = new THREE.MeshStandardMaterial({ color: 0x44aaff, emissive: 0x001133, emissiveIntensity: 0.55 });
    this.ikObjectiveMarker = new THREE.Mesh(g, m);
    this.ikObjectiveMarker.name = 'ik-objective-marker';
    this.scene.add(this.ikObjectiveMarker);
  }

  updateIKTargetConnector() {
    if (!this.ikDemoActive || !this.ikTargetMarker?.visible || !this.ikTargetConnector) {
      if (this.ikTargetConnector) this.ikTargetConnector.visible = false;
      if (this.ikObjectiveMarker) this.ikObjectiveMarker.visible = false;
    if (this.ikObjectiveMarker) this.ikObjectiveMarker.visible = false;
      return;
    }

    const objectivePos = this.getObjectiveAnchorWorldPosition();
    if (!objectivePos) {
      this.ikTargetConnector.visible = false;
      return;
    }

    this.ikConnectorStart.copy(objectivePos);
    if (this.ikObjectiveMarker) { this.ikObjectiveMarker.visible = true; this.ikObjectiveMarker.position.copy(objectivePos); }
    this.ikConnectorEnd.copy(this.ikTargetPosition);
    this.ikConnectorDir.subVectors(this.ikConnectorEnd, this.ikConnectorStart);

    const length = this.ikConnectorDir.length();
    if (!Number.isFinite(length) || length < 1e-6) {
      this.ikTargetConnector.visible = false;
      return;
    }

    this.ikTargetConnector.visible = true;
    this.ikConnectorMid.copy(this.ikConnectorStart).add(this.ikConnectorEnd).multiplyScalar(0.5);
    this.ikTargetConnector.position.copy(this.ikConnectorMid);
    this.ikTargetConnector.scale.set(1, length, 1);
    this.ikTargetConnector.quaternion.setFromUnitVectors(this.ikUpAxis, this.ikConnectorDir.normalize());
  }

  async setupIKDemo(robotPath) {
    this.stopIKDemo();
    if (!this.tree) return;

    // currently configured for MIRO-style models
    const objectivePos = this.getObjectiveAnchorWorldPosition();
    if (!objectivePos) {
      this.setStatus(`IK demo skipped: objective '${this.ikObjectiveName}' not found`);
      return;
    }

    const payload = {
      treeJsonPath: this.normaliseRobotAbsoluteTreePath(robotPath),
      rootLink: this.ikRootName,
      objectiveLinks: [this.ikObjectiveName],
      populationSize: 20,
      generations: 4,
      elites: 3,
      collisionSigma: 0,
    };

    try {
      const res = await fetch('http://localhost:8090/session/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const t = await res.text();
        this.setStatus(`IK session create failed: ${t || res.status}`);
        return;
      }
      const data = await res.json();
      this.ikSessionId = data.sessionId;
      this.ikTargetPosition.copy(objectivePos).add(new THREE.Vector3(0.12, 0, 0.06));
      this.ikLastSolveMs = 0;
      this.ikDemoActive = true;
      this.ensureIKTargetMarker();
      this.ensureIKTargetConnector();
      this.ensureIKObjectiveMarker();
      this.ikTargetMarker.visible = true;
      this.ikTargetMarker.position.copy(this.ikTargetPosition);
      this.updateIKTargetConnector();
      this.setStatus(`IK demo active (${this.ikObjectiveName}) — drag target sphere with mouse`);
    } catch (e) {
      console.error(e);
      this.setStatus(`IK demo unavailable: ${e.message || e}`);
    }
  }

  stopIKDemo() {
    this.ikDemoActive = false;
    this.ikSolveInFlight = false;
    this.ikSessionId = null;
    this.ikDraggingTarget = false;
    if (this.controls) this.controls.enabled = true;
    if (this.ikTargetMarker) this.ikTargetMarker.visible = false;
    if (this.ikTargetConnector) this.ikTargetConnector.visible = false;
      if (this.ikObjectiveMarker) this.ikObjectiveMarker.visible = false;
    if (this.ikObjectiveMarker) this.ikObjectiveMarker.visible = false;
  }

  applyIKSolution(solution) {
    if (!this.tree || !Array.isArray(solution)) return;
    const n = Math.min(solution.length, this.tree.Joints.length);
    for (let i = 0; i < n; i++) {
      const joint = this.tree.Joints[i];
      if (!joint) continue;
      joint.Set(solution[i]);
    }
  }

  ikWorldToModel(v) {
    // only rotation needed (no root translation currently)
    return v.clone().applyQuaternion(this.ikWorldToModelQuat);
  }

  async tickIKDemo() {
    if (!this.ikDemoActive || !this.ikSessionId || this.ikSolveInFlight) return;

    const now = performance.now();
    if (now - this.ikLastSolveMs < this.ikSolveIntervalMs) return;
    this.ikLastSolveMs = now;

    const targetWorld = this.ikTargetPosition;
    const targetModel = this.ikWorldToModel(targetWorld);
    const target = {
      x: targetModel.x,
      y: targetModel.y,
      z: targetModel.z,
    };
    if (this.ikTargetMarker) this.ikTargetMarker.position.copy(this.ikTargetPosition);

    this.ikSolveInFlight = true;
    try {
      const res = await fetch('http://localhost:8090/session/solve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: this.ikSessionId,
          objectiveIndex: 0,
          target: [target.x, target.y, target.z],
        }),
      });
      if (!res.ok) return;
      const data = await res.json();
      if (data?.ok) {
        this.applyIKSolution(data.solution || []);
      }
    } catch (e) {
      console.warn('IK solve error', e);
    } finally {
      this.ikSolveInFlight = false;
    }
  }

  onMouseMove(event) {
    if (!this.tree) return;

    this.coords.set(
      (event.clientX / this.renderer.domElement.clientWidth) * 2 - 1,
      -(event.clientY / this.renderer.domElement.clientHeight) * 2 + 1
    );

    this.raycaster.setFromCamera(this.coords, this.camera);

    if (this.ikDraggingTarget && this.ikTargetMarker?.visible) {
      if (this.raycaster.ray.intersectPlane(this.ikDragPlane, this.ikDragPoint)) {
        this.ikTargetPosition.copy(this.ikDragPoint);
        this.ikTargetMarker.position.copy(this.ikTargetPosition);
        this.updateIKTargetConnector();
      }
      return;
    }

    const intersections = this.raycaster.intersectObjects(this.robotGroup.children, true);

    // RESET NON HOVER
    this.robotGroup.traverse((o) => {
      if (o.isMesh) {
        if (o.userData.index !== this.selection) {
          o.material = o.userData.resetMaterial;
        }
      }
    });

    // HIGHLIGHT HOVER
    if (intersections.length > 0) {
      const selectedObject = intersections[0].object;
      selectedObject.traverse((o) => {
        if (o.isMesh) {
          if (o.userData.index !== this.selection) {
            o.material = o.userData.highlightMaterial;
          }
        }
      });
    }
  }

  onMouseDown(event) {
    if (!this.tree) return;

    this.coords.set(
      (event.clientX / this.renderer.domElement.clientWidth) * 2 - 1,
      -(event.clientY / this.renderer.domElement.clientHeight) * 2 + 1
    );

    this.raycaster.setFromCamera(this.coords, this.camera);

    if (this.ikDemoActive && this.ikTargetMarker?.visible) {
      const targetHit = this.raycaster.intersectObject(this.ikTargetMarker, false);
      if (targetHit.length > 0) {
        this.ikDraggingTarget = true;
        this.controls.enabled = false;
        const planeNormal = this.camera.getWorldDirection(new THREE.Vector3());
        this.ikDragPlane.setFromNormalAndCoplanarPoint(planeNormal, this.ikTargetMarker.position);
        return;
      }
    }

    const intersections = this.raycaster.intersectObjects(this.robotGroup.children, true);

    if (intersections.length === 0) {
      this.selection = -1;
      this.robotGroup.traverse((o) => {
        if (o.isMesh) o.material = o.userData.resetMaterial;
      });
      return;
    }

    intersections[0].object.traverse((o) => {
      if (o.isMesh) {
        this.selection = o.userData.index;
        o.material = o.userData.lowlightMaterial;
      }
    });
  }

  onMouseUp() {
    this.ikDraggingTarget = false;
    if (this.controls) this.controls.enabled = true;
  }

  onResize() {
    if (!this.camera || !this.renderer) return;

    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.render();
  }

  animate() {
    this.timer.update();
    this.controls.update();

    this.tickIKDemo();
    this.updateIKTargetConnector();

    this.directionalLight.position.set(this.camera.position.x, this.camera.position.y, this.camera.position.z);
    this.render();
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }
}
