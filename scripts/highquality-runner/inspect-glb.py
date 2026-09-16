"""Read actual embedded GLB geometry and texture sizes without altering the model."""
import json,struct,sys,pathlib
p=pathlib.Path(sys.argv[1]);b=p.read_bytes()
assert b[:4]==b'glTF' and struct.unpack_from('<I',b,8)[0]==len(b)
n=struct.unpack_from('<I',b,12)[0];j=json.loads(b[20:20+n]);binary=b[28+n:]
def dimensions(data):
 if data[:8]==b'\x89PNG\r\n\x1a\n':return list(struct.unpack_from('>II',data,16))
 if data[:2]==b'\xff\xd8':
  i=2
  while i<len(data)-9:
   if data[i]!=255:i+=1;continue
   marker=data[i+1];i+=2
   if marker in [0xd8,0xd9]:continue
   size=int.from_bytes(data[i:i+2],'big')
   if marker in [0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf]:return [int.from_bytes(data[i+5:i+7],'big'),int.from_bytes(data[i+3:i+5],'big')]
   if size<2:break
   i+=size
 return None
images=[]
for image in j.get('images',[]):
 v=j['bufferViews'][image['bufferView']];start=v.get('byteOffset',0);images.append({'mime':image.get('mimeType'),'size':dimensions(binary[start:start+v['byteLength']])})
triangles=sum(j['accessors'][p['indices']]['count']//3 if 'indices'in p else j['accessors'][p['attributes']['POSITION']]['count']//3 for m in j.get('meshes',[])for p in m['primitives']if p.get('mode',4)==4)
r={'bytes':len(b),'triangles':triangles,'textures':images,'joints':sum(len(s['joints'])for s in j.get('skins',[])),'animations':len(j.get('animations',[]))}
p.with_suffix('.metrics.json').write_text(json.dumps(r,indent=2));print(json.dumps(r))
if '--require-8k'in sys.argv and not any(x['size']==[8192,8192]for x in images):raise SystemExit('Requested 8K missing: preserve output, do not claim success')
