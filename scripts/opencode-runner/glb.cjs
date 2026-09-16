// Read actual GLB metadata instead of treating an agent-written report as evidence.
function inspectGlb(bytes){
 if(bytes.length<20||bytes.toString('ascii',0,4)!=='glTF'||bytes.readUInt32LE(4)!==2||bytes.readUInt32LE(8)!==bytes.length||bytes.readUInt32LE(16)!==0x4e4f534a)throw Error('Invalid GLB');
 const length=bytes.readUInt32LE(12);if(length>bytes.length-20)throw Error('Invalid GLB JSON chunk');
 const g=JSON.parse(bytes.toString('utf8',20,20+length));
 const bones=new Set((g.skins||[]).flatMap(s=>s.joints||[]));
 const skinned=(g.nodes||[]).some(n=>Number.isInteger(n.skin)&&(g.meshes?.[n.mesh]?.primitives||[]).some(p=>p.attributes?.JOINTS_0!==undefined&&p.attributes?.WEIGHTS_0!==undefined));
 const clips=(g.animations||[]).map(a=>({name:a.name||'',skeletal:(a.channels||[]).some(c=>bones.has(c.target?.node)&&['translation','rotation','scale'].includes(c.target?.path))}));
 return {bones:bones.size,skinned,clips};
}
module.exports={inspectGlb};
