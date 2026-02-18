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

    this.dragPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
    this.dragOffset = new THREE.Vector3();
    this.dragPoint = new THREE.Vector3();
    this.draggingCylinder = false;
    this.draggableCylinder = null;

    this.loadSeq = 0;

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

    this.addDraggableCylinder();

    // INPUT
    this.renderer.domElement.addEventListener('mousemove', this._onMouseMove);
    this.renderer.domElement.addEventListener('mousedown', this._onMouseDown);
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
      this.placeDraggableNearRobot(tree.Root);

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

  addDraggableCylinder() {
    const radius = 0.08;
    const height = 0.30;
    const geometry = new THREE.CylinderGeometry(radius, radius, height, 24);
    const material = new THREE.MeshStandardMaterial({
      color: 0xff4fd8,
      emissive: 0x4a0b36,
      emissiveIntensity: 0.85,
      roughness: 0.25,
      metalness: 0.15,
    });

    const cylinder = new THREE.Mesh(geometry, material);
    cylinder.name = 'draggable-cylinder';
    cylinder.position.set(0.35, 0, height * 0.5);
    cylinder.userData.dragHeight = height * 0.5;

    this.scene.add(cylinder);
    this.draggableCylinder = cylinder;
    this.renderer.domElement.style.cursor = 'grab';
  }

  placeDraggableNearRobot(object) {
    if (!this.draggableCylinder || !object) return;
    const box = new THREE.Box3().setFromObject(object);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    if (!Number.isFinite(size.x) || !Number.isFinite(size.y) || !Number.isFinite(size.z)) return;

    const zCandidate = Number.isFinite(box.min.z) ? box.min.z + 0.12 : center.z + 0.12;
    this.draggableCylinder.position.set(
      center.x + Math.max(0.55, size.x * 1.2),
      center.y + Math.max(0.18, size.y * 0.35),
      Number.isFinite(zCandidate) ? Math.max(0.18, center.z + size.z * 0.6) : 0.18
    );
  }

  getPointerNDC(event) {
    this.coords.set(
      (event.clientX / this.renderer.domElement.clientWidth) * 2 - 1,
      -(event.clientY / this.renderer.domElement.clientHeight) * 2 + 1
    );
  }

  onMouseMove(event) {
    this.getPointerNDC(event);
    this.raycaster.setFromCamera(this.coords, this.camera);

    if (this.draggingCylinder && this.draggableCylinder) {
      if (this.raycaster.ray.intersectPlane(this.dragPlane, this.dragPoint)) {
        this.draggableCylinder.position.x = this.dragPoint.x - this.dragOffset.x;
        this.draggableCylinder.position.y = this.dragPoint.y - this.dragOffset.y;
      }
      return;
    }

    if (!this.tree) return;
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
    this.getPointerNDC(event);
    this.raycaster.setFromCamera(this.coords, this.camera);

    if (this.draggableCylinder) {
      const hit = this.raycaster.intersectObject(this.draggableCylinder, false);
      if (hit.length > 0) {
        this.draggingCylinder = true;
        this.controls.enabled = false;
        this.renderer.domElement.style.cursor = 'grabbing';
        this.dragOffset.copy(hit[0].point).sub(this.draggableCylinder.position);
        return;
      }
    }

    if (!this.tree) return;

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
    if (this.draggingCylinder) {
      this.draggingCylinder = false;
      this.controls.enabled = true;
      this.renderer.domElement.style.cursor = 'grab';
    }
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

    this.directionalLight.position.set(this.camera.position.x, this.camera.position.y, this.camera.position.z);
    this.render();
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }
}
