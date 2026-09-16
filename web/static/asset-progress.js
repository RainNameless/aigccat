import {generationProgress} from './generation-indicator.js?v=1';
// Tick only the small progress elements: do not rebuild cards or lose selection/focus.
export function mountAssetProgress(host, entries) {
  const states=new Map(entries.map(([key,job])=>[key,{job,start:Date.now()}]));
  const draw=()=>{
    for(const card of host.querySelectorAll('[data-key]')){
      const record=states.get(card.dataset.key),job=record?.job;
      if(!job)continue;
      const active=generationProgress(job,Date.now(),record.start);
      const failed=['failed','waiting','unknown'].includes(job.status);
      if(!active&&!failed)continue;
      const button=card.querySelector('.open-asset');if(!button)continue;
      let panel=button.querySelector('.asset-progress');
      if(!panel){panel=document.createElement('span');panel.className='asset-progress';panel.innerHTML='<span class="asset-progress-ring"><svg viewBox="0 0 80 80" aria-hidden="true"><circle cx="40" cy="40" r="34"/><circle class="asset-progress-value" cx="40" cy="40" r="34" pathLength="100"/></svg><b></b></span><span class="asset-progress-phase"></span><span class="asset-progress-source"></span>';button.prepend(panel);}
      card.classList.add('has-progress');panel.classList.toggle('failed',failed);
      panel.querySelector('b').textContent=active?active.percent+'%':'!';
      panel.querySelector('.asset-progress-value').style.strokeDasharray=active?`${active.percent} 100`:'0 100';
      panel.querySelector('.asset-progress-phase').textContent=active?.phase||({failed:'生成失败',waiting:'等待查询原任务',unknown:'提交待确认'})[job.status];
      panel.querySelector('.asset-progress-source').textContent=active?(active.actual?'服务进度':'预估 · 约300秒'):'点击查看任务详情';
      panel.title=failed?job.error||'请查看任务记录':active.time;
      panel.setAttribute('role',active?'progressbar':'status');
      if(active){panel.setAttribute('aria-valuenow',active.percent);panel.setAttribute('aria-valuemin','0');panel.setAttribute('aria-valuemax','100');panel.setAttribute('aria-label',active.phase);}
      else {for(const attr of ['aria-valuenow','aria-valuemin','aria-valuemax'])panel.removeAttribute(attr);}
    }
  };
  draw();const timer=setInterval(draw,1000);return ()=>clearInterval(timer);
}
