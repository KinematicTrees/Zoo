import * as THREE from 'three';
import { ColladaLoader } from "three/addons";
import { STLLoader } from "three/addons/loaders/STLLoader.js";
import { Object3D, Vector3 } from "three";

const loader = new ColladaLoader();
const stlLoader = new STLLoader();


function ensureVec3(arr, label = '') {
    if (!Array.isArray(arr) || arr.length !== 3) {
        if (label) console.warn(`Invalid vec3 for ${label} (len=${Array.isArray(arr) ? arr.length : 'n/a'}), defaulting to [0,0,0]`);
        return [0, 0, 0];
    }
    const v0 = Number(arr[0]);
    const v1 = Number(arr[1]);
    const v2 = Number(arr[2]);
    return [
        Number.isFinite(v0) ? v0 : 0,
        Number.isFinite(v1) ? v1 : 0,
        Number.isFinite(v2) ? v2 : 0,
    ];
}

class Joint {
    constructor(info) {

        this.name = info.name;
        this.type = info.type;
        this.parent = info.parent;
        this.child = info.child;
        this.ChildID = -1;
        this.ParentID = -1;

        this.lower = info.lower
        this.upper = info.upper
        this.range = this.upper - this.lower
        const axis = ensureVec3(info.axis, `${this.name}.axis`);
        this.axis = new Vector3(axis[0], axis[1], axis[2]);

        const xyz = ensureVec3(info.xyz, `${this.name}.xyz`);
        const rpy = ensureVec3(info.rpy, `${this.name}.rpy`);

        this.origin = new Object3D()
        this.origin.position.set(xyz[0], xyz[1], xyz[2]);
        this.origin.rotation.set(rpy[0], rpy[1], rpy[2]);

        this.pre = new Object3D()
        this.pre.add(this.origin)
        this.post = new Object3D()
        this.origin.add(this.post)
    }

    Set(angle) {
        if (this.type !== "revolute" && this.type !== "continuous") {
            return
        }
        this.post.setRotationFromAxisAngle(this.axis, angle);
    }

    SetByUnitScaling(unitScaled) {
        if (unitScaled < -1) this.Set(this.lower)
        else if (unitScaled > 1) this.Set(this.upper)
        else this.Set(this.lower + ((unitScaled + 1) * 0.5) * this.range)
    }
}

class Link {
    constructor(info, meshDir) {
        this.name = info.name;
        const v0 = (info.visual && info.visual[0]) ? info.visual[0] : { pos: [0,0,0], rot: [0,0,0], mesh: '__NoMeshFile__' };
        const pos = ensureVec3(v0.pos, `${this.name}.visual.pos`);
        const rot = ensureVec3(v0.rot, `${this.name}.visual.rot`);

        this.origin = new Object3D()
        this.origin.position.set(pos[0], pos[1], pos[2]);
        this.origin.rotation.set(rot[0], rot[1], rot[2]);
        this.Children = []
        this.ChildrenID = []
        this.ParentID = -1;
        this.hasMesh = v0.mesh !== "__NoMeshFile__" && v0.mesh !== "__cylinder__" && v0.mesh !== "__box__" && v0.mesh !== "__sphere__";
        if (this.hasMesh) {
            const relMesh = v0.mesh.includes('/') ? v0.mesh : `meshes/${v0.mesh}`;
            this.meshfile = meshDir + relMesh;
        }
    }
}

class Tree {
    constructor(json, meshDir) {

        this.Root = new Object3D().rotateX(-Math.PI / 2)
        this.Joints = [];
        this.Links = [];
        this.Tags = json.Tags || {};
        this.RootLinkID = -1
        this.RootJointIDs = []
        this.RootLink = "unidentified root"
        this.RootJoints = []

        for (let j = 0; j < json.Joints.length; j++) {
            this.Joints.push(new Joint(json.Joints[j]))
        }

        for (let l = 0; l < json.Links.length; l++) {
            this.Links.push(new Link(json.Links[l], meshDir))
        }

        // Initialise link parents / children
        for (let l = 0; l < this.Links.length; l++) {
            for (let j = 0; j < this.Joints.length; j++) {
                if (this.Links[l].name === this.Joints[j].child) {
                    this.Links[l].parent = this.Joints[j].name
                    this.Links[l].ParentID = j
                }
            }
            for (let j = 0; j < this.Joints.length; j++) {
                if (this.Links[l].name === this.Joints[j].parent) {
                    this.Links[l].Children.push(this.Joints[j].name)
                    this.Links[l].ChildrenID.push(j)
                }
            }
        }

        // Initialise joint parents / children
        for (let j = 0; j < this.Joints.length; j++) {
            for (let l = 0; l < this.Links.length; l++) {
                if (this.Joints[j].child === this.Links[l].name) {
                    this.Joints[j].ChildID = l;
                }
            }
            for (let l = 0; l < this.Links.length; l++) {
                if (this.Joints[j].parent === this.Links[l].name) {
                    this.Joints[j].ParentID = l
                }
            }
        }

        // Identify root
        let rootIdentified = false
        for (let l = 0; l < this.Links.length; l++) {
            if (this.Links[l].ParentID === -1) {
                if (rootIdentified) {
                    console.log("WARNING -- Multiple root links identified")
                } else {
                    this.RootLinkID = l
                    this.RootJointIDs = this.Links[l].ChildrenID
                    this.RootLink = this.Links[l].name
                    for (let k = 0; k < this.RootJointIDs.length; k++) {
                        this.RootJoints.push(this.Joints[this.RootJointIDs[k]].name)
                    }
                    rootIdentified = true
                }
            }
        }
        if (!rootIdentified) {
            console.log("No root found")
            return
        }

        this.Root.add(this.Links[this.RootLinkID].origin)
        for (let r = 0; r < this.RootJointIDs.length; r++) {
            this.Root.add(this.Joints[this.RootJointIDs[r]].pre)
            this.traverse(this.RootJointIDs[r])
        }
    }


    traverse(k) {
        if (this.Joints[k].ChildID === -1) {
            return
        }
        this.Joints[k].post.add(this.Links[this.Joints[k].ChildID].origin)
        let childJoints = this.Links[this.Joints[k].ChildID].ChildrenID
        for (let l = 0; l < childJoints.length; l++) {
            this.Joints[k].post.add(this.Joints[childJoints[l]].pre)
            this.traverse(this.Links[this.Joints[k].ChildID].ChildrenID[l])
        }
    }
}

function resourceBasePath(url) {
    // ColladaLoader.parse wants a base path for resolving relative resources.
    // Use an absolute URL so it works regardless of Vite base path.
    try {
        const abs = new URL(url, window.location.href);
        return new URL('.', abs).href;
    } catch (_) {
        const i = url.lastIndexOf('/');
        return i >= 0 ? url.slice(0, i + 1) : '';
    }
}

function patchColladaText(text) {
    // Work around malformed COLLADA exported with empty unit meter value:
    //   <unit name="" meter=""></unit>
    // Three.js ColladaLoader may propagate NaNs in transforms when meter is empty.
    // Replace with a sane default.
    return text.replace(
        /<unit\s+name=""\s+meter=""\s*>\s*<\/unit>/gi,
        '<unit name="meter" meter="1"/>'
    );
}


function loadColladaPatched(url) {
    return fetch(url)
        .then((r) => {
            if (!r.ok) throw new Error(`Failed to fetch ${url}: ${r.status}`);
            return r.text();
        })
        .then((text) => {
            const patched = patchColladaText(text);
            return new Promise((resolve, reject) => {
                const base = resourceBasePath(url);

                // ColladaLoader.parse API differs across three.js versions:
                // - some return the parsed object synchronously
                // - some use onLoad/onError callbacks
                try {
                    const finalize = (data) => resolve(data);

                    const maybe = loader.parse(patched, base, (data) => finalize(data), (err) => reject(err));
                    if (maybe) finalize(maybe);
                } catch (e) {
                    reject(e);
                }
            });
        });
}

function loadSTLAsScene(url) {
    return fetch(url)
        .then((r) => {
            if (!r.ok) throw new Error(`Failed to fetch ${url}: ${r.status}`);
            return r.arrayBuffer();
        })
        .then((buf) => {
            const geometry = stlLoader.parse(buf);
            const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
            const group = new THREE.Group();
            group.add(mesh);
            // STL has no up-axis metadata; apply visual-only correction so STL aligns with DAE path.
            // Keep this lightweight and renderer-local (does not affect IK/model coordinate system).
            group.rotateX(Math.PI / 2);
            return { scene: group, __sourceFormat: 'stl' };
        });
}

function loadMeshAsset(url) {
    const clean = String(url || '').split('?')[0].toLowerCase();
    if (clean.endsWith('.stl')) return loadSTLAsScene(url);
    if (clean.endsWith('.dae')) return loadColladaPatched(url);
    return Promise.reject(new Error(`Unsupported mesh format for ${url}`));
}

export function loadRobot(url, meshDir, color) {
    return fetch(url).then((response) => {
        return response.json()
    }).then(treeInfo => {
        return new Tree(treeInfo, meshDir)
    }).then(tree => {
        const promises = []
        for (let i = 0; i < tree.Links.length; i++) {
            if (tree.Links[i].hasMesh) {
                promises.push(
                    loadMeshAsset(tree.Links[i].meshfile)
                        .then((mesh) => {
                            formatMesh(mesh, color, i, mesh.__sourceFormat)
                            tree.Links[i].origin.add(mesh.scene);
                        })
                )
            }
        }
        return [tree, Promise.all(promises)]
    })
}

function formatMesh(mesh, color, id, sourceFormat = 'dae') {
    let mat = new THREE.MeshStandardMaterial();
    mat.color.setRGB(color[0], color[1], color[2]);
    mat.emissiveIntensity = 0.5;
    mat.emissiveColor = color;
    mat.roughness = 0.8;
    mat.metalness = 0.1;
    mat.flatShading = true;
    mesh.scene.traverse((o) => {
        if (o.isMesh) {
            o.userData.resetMaterial = mat.clone();
            o.userData.highlightMaterial = mat.clone();
            o.userData.highlightMaterial.color.setRGB(0.96470588, 0.59215686, 0.12156863)
            o.userData.lowlightMaterial = mat.clone();
            o.userData.lowlightMaterial.color.setRGB(0.012, 0.66, 0.95)
            o.userData.index = id
            o.material = o.userData.resetMaterial;
            o.material = mat;
            o.geometry.computeVertexNormals();
        }
    });
    // Historical viewer alignment for DAE assets.
    // For STL we already applied an extra source correction above, then keep this common alignment.
    mesh.scene.rotateX(Math.PI/2);
}



/*
export function loadMesh(url, color) {
    return new Promise((resolve, reject) => {
        loader.load(url, data=> resolve(data), null, reject)
    }).then(data => {
        let mat = new THREE.MeshStandardMaterial();
        mat.color.setRGB(color[0], color[1], color[2]);
        mat.emissiveIntensity = 0.5;
        mat.emissiveColor = color;
        mat.roughness = 0.8;
        mat.metalness = 0.1;
        mat.flatShading = true;
        data.scene.traverse((o) => {
            if (o.isMesh) {
                o.material = mat;
                o.geometry.computeVertexNormals();
            }
        });
        data.scene.rotateX(Math.PI/2);
        return [data.scene,mat]
    })
}
*/
