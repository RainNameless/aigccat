async function normalize(bytes){
 const {NodeIO}=await import('@gltf-transform/core');
 const {ALL_EXTENSIONS}=await import('@gltf-transform/extensions');
 const {MeshoptDecoder}=await import('meshoptimizer');
 const {dequantize}=await import('@gltf-transform/functions');
 await MeshoptDecoder.ready;
 const io=new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({'meshopt.decoder':MeshoptDecoder});
 const doc=await io.readBinary(new Uint8Array(bytes));
 for(const ext of doc.getRoot().listExtensionsUsed())if(ext.extensionName==='EXT_meshopt_compression')ext.dispose();
 await doc.transform(dequantize());
 return Buffer.from(await io.writeBinary(doc));
}
module.exports={normalize};
