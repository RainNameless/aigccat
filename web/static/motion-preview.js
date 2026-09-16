import * as THREE from 'three';
import { clone } from 'three/addons/utils/SkeletonUtils.js';

// Preview the same whole-object transforms as workbench_process.py, in glTF Y-up.
export function motionPose(kind, t) {
  const s = Math.sin(t * Math.PI * 2);
  let x = 0, y = 0, z = 0, rotation = 0;
  if (kind === 'turntable') rotation = t * Math.PI * 2;
  if (kind === 'bounce') y = Math.abs(s) * .08;
  if (kind === 'land') y = t < .3 ? .6*t/.3 : t < .8 ? .6*(1-(t-.3)/.5) : 0;
  if (kind === 'retreat') { z = -t*.5; y = Math.abs(Math.sin(t*Math.PI))*.05; }
  if (kind === 'hook') { rotation = s*.4; y = Math.max(0,s)*.04; }
  if (kind === 'combo') {
    if (t < .5) rotation = s*.4;
    else y = .4*Math.max(0,1-Math.abs((t-.5)*2-.5)*4);
  }
  if (kind === 'kick') { z = Math.sin(t*Math.PI)*.4; y = Math.sin(t*Math.PI)*.06; }
  if (kind === 'dance') { rotation = s*.3; y = Math.abs(Math.sin(t*Math.PI*4))*.05; x = Math.sin(t*Math.PI*6)*.05; }
  return {x,y,z,rotation};
}

export function mountMotionPreviews(host, viewer, fit, bounds, duration) {
  if (!viewer.obj) return () => {};
  const clips = viewer.clips.slice();
  let disposed = false;
  const renderer = new THREE.WebGLRenderer({antialias:true, preserveDrawingBuffer:true});
  renderer.setSize(192,192); renderer.setPixelRatio(1);
  renderer.toneMapping = viewer.renderer.toneMapping;
  renderer.toneMappingExposure = viewer.renderer.toneMappingExposure;
  const scene = new THREE.Scene(); scene.background = new THREE.Color('#25282c');
  scene.environment = viewer.scene.environment;
  scene.add(new THREE.HemisphereLight(0xffffff,0x334155,.5));
  const light = new THREE.DirectionalLight(0xffffff,1); light.position.set(2,4,3); scene.add(light);
  const root = new THREE.Group(), model = clone(viewer.obj); root.add(model); scene.add(root);
  const camera = new THREE.PerspectiveCamera(45,1,.01,100);
  const box = bounds(model); box.expandByScalar(.12);
  fit(camera,box,new THREE.Vector3(.5,.2,viewer.planFrontNegativeZ ? -1 : 1));
  const mixer = new THREE.AnimationMixer(model);
  let action, active, frame, last = 0, start = 0;
  const cards = [...host.querySelectorAll('[data-motion]')];
  function draw(card,t) {
    root.position.set(0,0,0); root.rotation.set(0,0,0);
    const kind = card.dataset.motion;
    if (kind.startsWith('clip:')) {
      if (action) { action.time = t * action.getClip().duration; mixer.update(0); }
    } else {
      const p = motionPose(kind,t); root.position.set(p.x,p.y,p.z); root.rotation.y=p.rotation;
    }
    renderer.render(scene,camera);
    card.querySelector('canvas').getContext('2d').drawImage(renderer.domElement,0,0,192,192);
  }
  function activate(card) {
    if (disposed) return;
    mixer.stopAllAction(); action = null;
    if(card.dataset.motion.startsWith('clip:')) action=mixer.clipAction(clips[Number(card.dataset.motion.slice(5))]).play();
    const motionBounds = box.clone();
    if(!card.dataset.motion.startsWith('clip:')) {
      for(let i=0;i<=24;i++) {
        const p=motionPose(card.dataset.motion,i/24);
        const matrix=new THREE.Matrix4().makeRotationY(p.rotation); matrix.setPosition(p.x,p.y,p.z);
        motionBounds.union(box.clone().applyMatrix4(matrix));
      }
    }
    fit(camera,motionBounds,new THREE.Vector3(.5,.2,viewer.planFrontNegativeZ ? -1 : 1));
    active=card; start=performance.now();
  }
  cards.forEach(card=>{
    const canvas=document.createElement('canvas'); canvas.width=canvas.height=192;
    canvas.setAttribute('aria-label','模型动画预览'); card.querySelector('.motion-image').append(canvas);
    activate(card); draw(card,0);
    card.onpointerenter=()=>activate(card); card.onfocus=()=>activate(card);
  });
  if(cards.length) activate(cards.find(c=>c.classList.contains('active')) || cards[0]);
  function tick(now) {
    if(active && host.isConnected && !document.hidden && now-last>100) {
      draw(active,((now-start)/1000/Math.max(.1,action?.getClip().duration || duration()))%1); last=now;
    }
    frame=requestAnimationFrame(tick);
  }
  frame=requestAnimationFrame(tick);
  return ()=>{disposed=true;cards.forEach(card=>{card.onpointerenter=null;card.onfocus=null;});cancelAnimationFrame(frame);mixer.stopAllAction();mixer.uncacheRoot(model);renderer.dispose();renderer.forceContextLoss();};
}
