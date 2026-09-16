// Render the actual downloaded mesh, never a reference image or a generated illustration.
const {chromium}=require('playwright');
async function preview(bytes){
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:512,height:512},deviceScaleFactor:1});
  const token=require('fs').readFileSync(require('path').join(require('os').homedir(),'.config/aigccat/auth/secrets/automation.token'),'utf8').trim();
  await page.route('http://127.0.0.1:8080/vendor/**',route=>route.continue({headers:{...route.request().headers(),Authorization:'Bearer '+token}}));
  await page.route('http://127.0.0.1:8080/studio-preview.glb',r=>r.fulfill({contentType:'model/gltf-binary',body:bytes}));
  await page.route('http://127.0.0.1:8080/studio-preview-render',r=>r.fulfill({contentType:'text/html',body:`<!doctype html><style>body{margin:0}</style><script type="importmap">{"imports":{"three":"/vendor/three-0.160.0/build/three.module.js","three/addons/":"/vendor/three-0.160.0/examples/jsm/"}}</script><script type="module">
import * as T from 'three';import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';import {RoomEnvironment} from 'three/addons/environments/RoomEnvironment.js';
try{const g=await new GLTFLoader().loadAsync('/studio-preview.glb');const r=new T.WebGLRenderer({antialias:true,preserveDrawingBuffer:true});r.setSize(512,512);r.toneMapping=T.ACESFilmicToneMapping;document.body.append(r.domElement);const s=new T.Scene();s.background=new T.Color('#25282c');s.add(g.scene);const pm=new T.PMREMGenerator(r),room=new RoomEnvironment();s.environment=pm.fromScene(room,.04).texture;const light=new T.DirectionalLight(0xffffff,2);light.position.set(2,4,3);s.add(light,new T.HemisphereLight(0xffffff,0x445566,1));g.scene.updateMatrixWorld(true);g.scene.traverse(o=>{if(o.isSkinnedMesh)o.skeleton.update()});const b=new T.Box3().setFromObject(g.scene,true),size=b.getSize(new T.Vector3()),center=b.getCenter(new T.Vector3());const span=Math.max(size.x,size.y,size.z);const c=new T.PerspectiveCamera(40,1,span*.001,span*100);c.position.copy(center).add(new T.Vector3(.18,.1,1).normalize().multiplyScalar(span*1.8));c.lookAt(center);r.render(s,c);window.rendered=true;}catch(e){window.renderError=e.message;}
</script>`}));
  await page.goto('http://127.0.0.1:8080/studio-preview-render');
  await page.waitForFunction(()=>window.rendered||window.renderError,{},{timeout:45000});
  const error=await page.evaluate(()=>window.renderError);if(error)throw Error(error);
  return await page.locator('canvas').screenshot();
 }finally{await browser.close();}
}
module.exports={preview};
