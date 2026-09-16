export function generationProgress(job, now, fallbackStart) {
  if (!job || !['running','queued'].includes(job.status)) return null;
  const raw = job.created_at;
  const start = typeof raw === 'number' ? (raw < 1e12 ? raw*1000 : raw) : Date.parse(raw);
  const elapsed = Math.max(0, Math.floor((now-(Number.isFinite(start)?start:fallbackStart))/1000));
  const reported = Number(job.progress?.percent);
  const actual = Number.isFinite(reported) && reported > 5;
  return {elapsed, actual, percent:actual ? Math.min(99,Math.max(0,Math.floor(reported))) : Math.min(95,Math.floor(elapsed/300*95)),
    phase:job.progress?.phase || (job.status==='queued'?'模型排队中':'正在生成模型'),
    time:elapsed >= 300 ? '已超过预估时间，仍在等待服务结果' : `预计还需约 ${300-elapsed} 秒`};
}

export function createGenerationIndicator(viewport) {
  const host=document.createElement('section');
  host.className='generation-indicator';host.hidden=true;
  host.innerHTML=`<div class="generation-card"><span class="generation-eyebrow">3D GENERATION</span>
    <div class="generation-orbit" role="progressbar" aria-label="模型生成进度" aria-valuemin="0" aria-valuemax="100">
      <svg viewBox="0 0 200 200" aria-hidden="true"><circle class="orbit-ticks" cx="100" cy="100" r="94"/><circle class="orbit-track" cx="100" cy="100" r="79"/><circle class="orbit-value" cx="100" cy="100" r="79" pathLength="100"/><circle class="orbit-scanner" cx="100" cy="100" r="65"/></svg>
      <div class="generation-number"><strong data-generation-percent>0</strong><span>%</span><small data-generation-source>预估进度</small></div>
    </div><h2 data-generation-phase></h2><p data-generation-time></p>
    <div class="generation-timing"><span>预估总时长 <b>300 秒</b></span><span>已用时 <b data-generation-elapsed>0 秒</b></span></div>
    <small class="generation-note">实际耗时取决于排队和模型复杂度</small></div>`;
  viewport.append(host);
  let job=null, identity='', fallbackStart=Date.now(), timer;
  function draw() {
    const state=generationProgress(job,Date.now(),fallbackStart);
    host.hidden=!state;viewport.classList.toggle('is-generating',!!state);
    if(!state)return;
    host.querySelector('[data-generation-percent]').textContent=state.percent;
    host.querySelector('[data-generation-source]').textContent=state.actual?'服务进度':'预估进度';
    host.querySelector('[role="progressbar"]').setAttribute('aria-valuenow',state.percent);
    host.querySelector('.orbit-value').style.strokeDasharray=`${state.percent} 100`;
    host.querySelector('[data-generation-phase]').textContent=state.phase;
    host.querySelector('[data-generation-time]').textContent=state.time;
    host.querySelector('[data-generation-elapsed]').textContent=`${state.elapsed} 秒`;
  }
  return {
    update(next, assetKey) {
      const key=next ? `${assetKey}/${next.job_id}` : '';
      if(key!==identity) {identity=key;fallbackStart=Date.now();}
      job=next;draw();clearInterval(timer);
      if(!host.hidden) timer=setInterval(draw,1000);
    },
    dispose(){clearInterval(timer);host.remove();viewport.classList.remove('is-generating');}
  };
}
