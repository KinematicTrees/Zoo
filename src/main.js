import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {Timer} from "three";
import { GUI } from 'three/addons/libs/lil-gui.module.min.js';

import * as KT from './tree.mjs';


const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera( 75, window.innerWidth / window.innerHeight, 0.1, 1000 );
camera.position.z = 1;

let winWidthScale = 1.0;
const renderer = new THREE.WebGLRenderer();
renderer.setSize( window.innerWidth*winWidthScale, window.innerHeight );
renderer.setClearColor( 0x000000, 1 );
document.body.appendChild( renderer.domElement );
const controls = new OrbitControls( camera, renderer.domElement );
controls.enableDamping = true;


// BUILD THE SCENE
const light = new THREE.AmbientLight( 0xffffff,1 );
scene.add( light );

const directionalLight = new THREE.DirectionalLight( 0xffffff, 1 );
directionalLight.position.set(0,0,1);
directionalLight.target.position.set(0,0,0);
scene.add( directionalLight );


// LOAD THE MODEL
let treePath = "tree.json"
let meshPath = ""
const [tree,p] = await KT.loadRobot(treePath,meshPath,[0.5,0.5,0.5])
scene.add(tree.Root)


const jointMap = new Map();
for (let i = 0; i < tree.Joints.length; i++) {
    if (tree.Joints[i].type === "revolute"){
        console.log("yep addded",tree.Joints[i].name);
        jointMap.set(tree.Joints[i].name,i)
    }
}

let selection = -1

var gui = new GUI( { title: 'Joint Control', width: 300 } );
gui.domElement.id = 'gui';

const API = {
    angle: 0.0,
}

for (const [jointName, jointIndex] of jointMap.entries()) {
    console.log(jointName, jointIndex)
}


gui.add(API, 'angle', -1, 1, 0.02).name("Selected").onChange(function () {
    if (selection !==-1) {
        if ( tree.Links[selection].ParentID !== -1) {
            tree.Joints[tree.Links[selection].ParentID].SetByUnitScaling(API.angle)
        }
    }
    render();
});

for (const [jointName, jointIndex] of jointMap.entries()) {
    gui.add(API, 'angle', -1, 1, 0.02).name(jointName).onChange(function () {
        tree.Joints[jointIndex].SetByUnitScaling(API.angle)
        render();
    });
}


// RAY-CASTING
let selectedObject;
let coords = new THREE.Vector2();
const raycaster = new THREE.Raycaster();
renderer.domElement.addEventListener('mousemove', onMouseMove)
function onMouseMove(event){
    coords.set (
        (event.clientX / renderer.domElement.clientWidth) * 2 - 1,
        -(event.clientY / renderer.domElement.clientHeight) * 2 + 1
    )
    raycaster.setFromCamera(coords, camera)
    const intersections = raycaster.intersectObjects(scene.children, true)

    // RESET NON HOVER
    scene.traverse((s) => {
        s.traverse((o) => {
            if (o.isMesh) {
                //if (o.userData.index !== selection) {
                if (o.userData.index !== selection ) {
                    o.material = o.userData.resetMaterial
                }
            }
        });
    });

    // HIGHLIGHT HOVER
    if (intersections.length > 0) {
        selectedObject = intersections[0].object
        selectedObject.traverse((o) => {
            if (o.isMesh) {
                if (o.userData.index !== selection) {
                    o.material = o.userData.highlightMaterial;
                }
            }
        });
    }
}


renderer.domElement.addEventListener('mousedown', onMouseDown)
function onMouseDown(event) {
    coords.set(
        (event.clientX / renderer.domElement.clientWidth) * 2 - 1,
        -(event.clientY / renderer.domElement.clientHeight) * 2 + 1
    )
    raycaster.setFromCamera(coords, camera)
    const intersections = raycaster.intersectObjects(scene.children, true)
    if (intersections.length === 0) {
        selection = -1 //
        scene.traverse((s) => {
            s.traverse((o) => {
                if (o.isMesh) o.material = o.userData.resetMaterial
            });
        });
    } else {
        intersections[0].object.traverse((o) => {
            if (o.isMesh) {
                selection = o.userData.index;
                o.material = o.userData.lowlightMaterial;
            }
        });
    }
}



// ANIMATE LOOP
const timer = new Timer();
timer.connect( document );

function animate() {
    timer.update();
    controls.update();
    directionalLight.position.set(camera.position.x,camera.position.y,camera.position.z);
    render();
}

function render() {
    renderer.render(scene, camera);
}


renderer.setAnimationLoop(animate);
