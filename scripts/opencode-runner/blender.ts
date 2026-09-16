import { tool } from '@opencode-ai/plugin';
import path from 'node:path';
export default tool({
 description:'Execute a Python script in local Blender. All script input/output paths must be relative to the current task directory. The script may use bpy, numpy and mathutils. 600 second time limit. Read generated PNG files to inspect results.',
 args:{script:tool.schema.string().describe('Relative Python script filename'),args:tool.schema.array(tool.schema.string()).default([])},
 async execute(args,context){
  const id=path.basename(context.directory);
  const response=await fetch(process.env.RIG_HOST_URL+'/run',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+process.env.RIG_AGENT_TOKEN},body:JSON.stringify({id,...args}),signal:AbortSignal.timeout(610000)});
  const result=await response.json();if(!response.ok||!result.ok)throw Error(result.error||result.output||'Blender failed');return result.output;
 }
});
