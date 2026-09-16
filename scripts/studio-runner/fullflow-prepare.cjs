const fs=require('node:fs/promises'),path=require('node:path');
const {ROOT}=require('./client.cjs');
const {normalize}=require('./normalize.cjs'),{preview}=require('./preview.cjs');
(async()=>{
 const [id,stage]=process.argv.slice(2);if(!/^case-\d\d$/.test(id))throw Error('Invalid case');
 const dir=path.join(ROOT,'outputs/fullflow-30',id),file=path.join(dir,stage+'.glb');
 let bytes=await fs.readFile(file);
 if(stage==='final'){
  const original=path.join(dir,'final-original.glb');
  await fs.writeFile(original,bytes,{flag:'wx'}).catch(e=>{if(e.code!=='EEXIST')throw e});
  bytes=await normalize(await fs.readFile(original));
  const {NodeIO}=await import('@gltf-transform/core'),io=new NodeIO(),doc=await io.readBinary(bytes);
  const fixes=[];
  for(const anim of doc.getRoot().listAnimations())for(const channel of anim.listChannels()){
   const node=channel.getTargetNode();
   if(node.getName()!=='Hip'||channel.getTargetPath()!=='translation')continue;
   // Studio biped Hip uses Z up locally. Remove constant horizontal clip offset,
   // retaining vertical bounce and all rotations. Never modify the source export.
   const sampler=channel.getSampler(),out=sampler.getOutput(),a=out.getArray().slice(),bind=node.getTranslation();
   const dx=a[0]-bind[0],dy=a[1]-bind[1];
   for(let i=0;i<a.length;i+=3){a[i]-=dx;a[i+1]-=dy;}
   sampler.setOutput(out.clone().setArray(a));fixes.push({clip:anim.getName(),offset:[dx,dy]});
  }
  bytes=Buffer.from(await io.writeBinary(doc));await fs.writeFile(file,bytes);
  await fs.writeFile(path.join(dir,'animation-centering.json'),JSON.stringify(fixes,null,2));
 }
 await fs.writeFile(path.join(dir,stage+'-preview.png'),await preview(bytes));
 console.log(id,stage,'actual mesh preview saved');
})().catch(e=>{console.error(e.message);process.exitCode=1});
