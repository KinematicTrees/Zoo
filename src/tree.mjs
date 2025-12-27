import * as THREE from 'three';
import {ColladaLoader} from "three/addons";
import {Object3D, Vector3} from "three";
const loader = new ColladaLoader()

class Joint{
    constructor(info) {

        this.name = info.name;
        this.type = info.type;
        this.parent = info.parent;
        this.child = info.child;
        this.ChildID = -1;
        this.ParentID = -1;

        this.lower = info.lower
        this.upper = info.upper
        this.range = this.upper-this.lower
        this.axis = new Vector3(info.axis[0],info.axis[1],info.axis[2]);

        this.origin = new Object3D()
        this.origin.position.set(info.xyz[0], info.xyz[1],info.xyz[2]);
        this.origin.rotation.set(info.rpy[0], info.rpy[1],info.rpy[2]);

        this.pre = new Object3D()
        this.pre.add(this.origin)
        this.post = new Object3D()
        this.origin.add(this.post)
    }

    Set(angle) {
        if (this.type !== "revolute"){
            console.log("Not a revolute joint.")
            return
        }
        this.post.setRotationFromAxisAngle(this.axis,angle);
    }

    SetByUnitScaling(unitScaled) {
        if (unitScaled < -1) this.Set(this.lower)
        else if (unitScaled > 1) this.Set(this.upper)
        else this.Set(this.lower + ((unitScaled + 1) * 0.5) * this.range)
    }
}

class Link{
    constructor(info,meshDir){
        this.name = info.name;
        this.origin = new Object3D()
        this.origin.position.set(info.visual[0].pos[0], info.visual[0].pos[1], info.visual[0].pos[2]);
        this.origin.rotation.set(info.visual[0].rot[0], info.visual[0].rot[1], info.visual[0].rot[2]);
        this.Children = []
        this.ChildrenID = []
        this.ParentID = -1;
        this.hasMesh = info.visual[0].mesh !== "__NoMeshFile__" && info.visual[0].mesh !== "__cylinder__" && info.visual[0].mesh !== "__box__";
        if(this.hasMesh){
            this.meshfile = meshDir+info.visual[0].mesh;
        }
    }
}

class Tree{
    constructor(json,meshDir){

        this.Root = new Object3D().rotateX(-Math.PI/2)
        this.Joints = [];
        this.Links = [];
        this.RootLinkID = -1
        this.RootJointIDs = []
        this.RootLink = "unidentified root"
        this.RootJoints = []

        for(let j=0; j<json.Joints.length;j++) {
            this.Joints.push(new Joint(json.Joints[j]))
        }

        for(let l=0; l<json.Links.length;l++) {
            this.Links.push(new Link(json.Links[l],meshDir))
        }

        // Initialise link parents / children
        for(let l=0; l<this.Links.length;l++) {
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
        for(let j= 0; j < this.Joints.length; j++) {
            for(let l = 0; l < this.Links.length; l++) {
                if (this.Joints[j].child === this.Links[l].name) {
                    this.Joints[j].ChildID = l;
                }
            }
            for(let l = 0; l < this.Links.length; l++) {
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
                    for (let k= 0; k < this.RootJointIDs.length; k++) {
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
        for (let r =0; r<this.RootJointIDs.length; r++) {
            this.Root.add(this.Joints[this.RootJointIDs[r]].pre)
            this.traverse(this.RootJointIDs[r])
        }
    }


    traverse(k){
        if(this.Joints[k].ChildID === -1) {
            return
        }
        this.Joints[k].post.add(this.Links[this.Joints[k].ChildID].origin)
        let childJoints = this.Links[this.Joints[k].ChildID].ChildrenID
        for (let l=0;l<childJoints.length;l++) {
            this.Joints[k].post.add(this.Joints[childJoints[l]].pre)
            this.traverse(this.Links[this.Joints[k].ChildID].ChildrenID[l])
        }
    }
}


export function loadRobot(url,meshDir,color) {
    return fetch(url).then((response) => {
        return response.json()
    }).then(treeInfo => {
        return new Tree(treeInfo,meshDir)
    }).then(tree => {
        const promises = []
        for (let i=0;i<tree.Links.length;i++) {
            if (tree.Links[i].hasMesh) {
                promises.push(
                    new Promise((resolve, reject) => {
                        return loader.load(tree.Links[i].meshfile, data => resolve(data), null, reject)
                    }).then((mesh) => {
                        formatMesh(mesh,color,i)
                        tree.Links[i].origin.add(mesh.scene);
                    })
                )
            }
        }
        return [tree,Promise.all(promises)]
    })
}

function formatMesh(mesh,color,id){
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
            o.userData.lowlightMaterial.color.setRGB(0.012,0.66,0.95)
            o.userData.index = id
            o.material = o.userData.resetMaterial;
            o.material = mat;
            o.geometry.computeVertexNormals();
        }
    });
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
